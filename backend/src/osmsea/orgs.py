"""Organization configuration service: organizations, departments, agents (versioned), settings,
integrations and manual memory. Every change is validated before it is stored and is audited."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Config
from .integrations import PROVIDERS, check_base_url, test_credential
from .mcp_client import SLUG_RE, McpError, approvable, auth_headers, check_url
from .mcp_client import list_tools as mcp_list_tools
from .specs import (
    AgentSpec,
    DepartmentSpec,
    OrganizationSpec,
    SpecError,
    organization_errors,
    parse_agent_markdown,
    parse_settings,
    render_agent_markdown,
)
from .store import StoreError, now_iso, record_audit
from .tools import ToolError


@dataclass(frozen=True)
class Actor:
    id: str
    email: str


class NotFound(Exception):
    pass


async def _one(db: Any, table: str, **filters: Any) -> dict[str, Any]:
    rows = await db.select(table, filters=filters)
    if not rows:
        raise NotFound(f"{table.rstrip('s')} not found")
    return rows[0]


# --- organizations -------------------------------------------------------------------------------


def organization_from_payload(payload: dict[str, Any]) -> tuple[OrganizationSpec, dict[str, str]]:
    """Validate a builder/template payload. Agents arrive as Markdown sources (the canonical format)."""
    errors, agents, sources = [], [], {}
    for i, agent in enumerate(payload.get("agents") or []):
        try:
            spec = parse_agent_markdown(agent.get("source_md", ""))
            agents.append(spec)
            sources[spec.id] = agent["source_md"]
        except SpecError as e:
            errors += [f"agents[{i}]: {m}" for m in e.errors]
    departments = []
    for i, dept in enumerate(payload.get("departments") or []):
        try:
            departments.append(DepartmentSpec(**{k: dept.get(k, "") for k in ("id", "name", "description", "readme")}))
        except ValueError as e:
            errors.append(f"departments[{i}]: {e}")
    if errors:
        raise SpecError(errors)
    try:
        org = OrganizationSpec(name=payload.get("name", ""), description=payload.get("description", ""),
                               readme=payload.get("readme", ""), departments=departments, agents=agents)
    except ValueError as e:
        raise SpecError([str(e)]) from e
    if cross := organization_errors(org):
        raise SpecError(cross)
    return org, sources


async def create_organization(db: Any, actor: Actor, org: OrganizationSpec, sources: dict[str, str] | None = None,
                              settings: dict[str, Any] | None = None) -> dict[str, Any]:
    if cross := organization_errors(org):
        raise SpecError(cross)
    parsed_settings = parse_settings(settings)
    row = (await db.insert("organizations", {
        "name": org.name, "description": org.description, "readme_md": org.readme,
        "settings": parsed_settings.model_dump(), "created_by": actor.id,
    }))[0]
    try:  # PostgREST has no multi-statement transactions; compensate on failure (FKs cascade)
        await db.insert("organization_members", {"org_id": row["id"], "user_id": actor.id, "role": "owner", "email": actor.email})
        depts = await db.insert("departments", [
            {"org_id": row["id"], "slug": d.id, "name": d.name, "description": d.description, "readme_md": d.readme}
            for d in org.departments])
        dept_ids = {d["slug"]: d["id"] for d in depts}
        for spec in org.agents:
            source = (sources or {}).get(spec.id) or render_agent_markdown(spec)
            await _insert_agent(db, row["id"], dept_ids[spec.department], spec, source, actor, "initial version")
    except Exception:
        await db.delete("organizations", filters={"id": row["id"]})
        raise
    await record_audit(db, row["id"], "organization.create", "organization", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=org.name,
                       details={"departments": len(org.departments), "agents": len(org.agents)})
    return row


async def update_organization(db: Any, org_id: str, actor: Actor, name: str | None, description: str | None) -> dict:
    values = {k: v for k, v in {"name": name, "description": description}.items() if v is not None}
    if name is not None and not 1 <= len(name.strip()) <= 120:
        raise SpecError(["name must be 1-120 characters"])
    rows = await db.update("organizations", values, filters={"id": org_id})
    await record_audit(db, org_id, "organization.update", "organization", actor_id=actor.id, actor_label=actor.email,
                       resource_id=org_id, resource_name=rows[0]["name"], details={"fields": sorted(values)})
    return rows[0]


async def update_settings(db: Any, org_id: str, actor: Actor, raw: dict[str, Any]) -> dict[str, Any]:
    settings = parse_settings(raw)
    org = await _one(db, "organizations", id=org_id)
    before = org.get("settings") or {}
    after = settings.model_dump()
    changed = sorted(k for k in after if before.get(k) != after[k])
    await db.update("organizations", {"settings": after}, filters={"id": org_id})
    await record_audit(db, org_id, "settings.update", "organization", actor_id=actor.id, actor_label=actor.email,
                       resource_id=org_id, resource_name=org["name"], details={"changed": changed})
    return after


# --- departments ---------------------------------------------------------------------------------


async def create_department(db: Any, org_id: str, actor: Actor, slug: str, name: str, description: str) -> dict:
    try:
        dept = DepartmentSpec(id=slug, name=name, description=description)
    except ValueError as e:
        raise SpecError([str(e)]) from e
    try:
        row = (await db.insert("departments", {"org_id": org_id, "slug": dept.id, "name": dept.name,
                                               "description": dept.description}))[0]
    except StoreError as e:
        if e.code == "23505":
            raise SpecError([f"department '{slug}' already exists"]) from e
        raise
    await record_audit(db, org_id, "department.create", "department", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=name)
    return row


async def update_department(db: Any, org_id: str, dept_id: str, actor: Actor, name: str, description: str) -> dict:
    current = await _one(db, "departments", id=dept_id, org_id=org_id)
    try:
        DepartmentSpec(id=current["slug"], name=name, description=description)
    except ValueError as e:
        raise SpecError([str(e)]) from e
    row = (await db.update("departments", {"name": name, "description": description},
                           filters={"id": dept_id, "org_id": org_id}))[0]
    await record_audit(db, org_id, "department.update", "department", actor_id=actor.id, actor_label=actor.email,
                       resource_id=dept_id, resource_name=name)
    return row


# --- agents --------------------------------------------------------------------------------------


async def _insert_agent(db: Any, org_id: str, dept_id: str, spec: AgentSpec, source_md: str, actor: Actor,
                        note: str) -> dict[str, Any]:
    agent = (await db.insert("agents", {"org_id": org_id, "department_id": dept_id, "slug": spec.id,
                                        "name": spec.name, "role": spec.role, "status": "active"}))[0]
    version = (await db.insert("agent_versions", {
        "org_id": org_id, "agent_id": agent["id"], "version": 1, "source_md": source_md,
        "spec": spec.model_dump(mode="json"), "note": note, "created_by": actor.id,
    }))[0]
    await db.update("agents", {"active_version_id": version["id"]}, filters={"id": agent["id"]})
    return {**agent, "active_version_id": version["id"]}


async def _department_for(db: Any, org_id: str, spec: AgentSpec) -> dict[str, Any]:
    rows = await db.select("departments", filters={"org_id": org_id, "slug": spec.department})
    if not rows:
        raise SpecError([f"department: unknown department '{spec.department}' in this organization"])
    return rows[0]


async def create_agent(db: Any, org_id: str, actor: Actor, source_md: str, note: str = "") -> dict[str, Any]:
    spec = parse_agent_markdown(source_md)
    dept = await _department_for(db, org_id, spec)
    if await db.select("agents", filters={"org_id": org_id, "slug": spec.id}):
        raise SpecError([f"id: agent id '{spec.id}' already exists in this organization"])
    agent = await _insert_agent(db, org_id, dept["id"], spec, source_md, actor, note or "initial version")
    await record_audit(db, org_id, "agent.create", "agent", actor_id=actor.id, actor_label=actor.email,
                       resource_id=agent["id"], resource_name=spec.name, details={"version": 1})
    return agent


async def update_agent(db: Any, org_id: str, agent_id: str, actor: Actor, source_md: str, note: str = "") -> dict[str, Any]:
    """Validate and activate a new spec version. Running tasks keep the version they were pinned to."""
    agent = await _one(db, "agents", id=agent_id, org_id=org_id)
    spec = parse_agent_markdown(source_md)
    if spec.id != agent["slug"]:
        raise SpecError([f"id: agent ids are stable; expected '{agent['slug']}', got '{spec.id}'"])
    dept = await _department_for(db, org_id, spec)
    latest = await db.select("agent_versions", filters={"agent_id": agent_id}, order="version.desc", limit=1)
    version_no = (latest[0]["version"] if latest else 0) + 1
    try:
        version = (await db.insert("agent_versions", {
            "org_id": org_id, "agent_id": agent_id, "version": version_no, "source_md": source_md,
            "spec": spec.model_dump(mode="json"), "note": note, "created_by": actor.id,
        }))[0]
    except StoreError as e:
        if e.code == "23505":
            raise SpecError(["another edit was saved at the same time; reload and try again"]) from e
        raise
    row = (await db.update("agents", {"active_version_id": version["id"], "name": spec.name, "role": spec.role,
                                      "department_id": dept["id"]}, filters={"id": agent_id}))[0]
    await record_audit(db, org_id, "agent.update", "agent", actor_id=actor.id, actor_label=actor.email,
                       resource_id=agent_id, resource_name=spec.name, details={"version": version_no, "note": note})
    return {**row, "version": version_no}


async def set_agent_status(db: Any, org_id: str, agent_id: str, actor: Actor, status: str) -> dict[str, Any]:
    if status not in ("active", "disabled"):
        raise SpecError(["status must be active or disabled"])
    rows = await db.update("agents", {"status": status}, filters={"id": agent_id, "org_id": org_id})
    if not rows:
        raise NotFound("agent not found")
    await record_audit(db, org_id, f"agent.{'enable' if status == 'active' else 'disable'}", "agent",
                       actor_id=actor.id, actor_label=actor.email, resource_id=agent_id, resource_name=rows[0]["name"])
    return rows[0]


# --- integrations --------------------------------------------------------------------------------


async def upsert_integration(db: Any, config: Config, org_id: str, actor: Actor, provider: str, secret: str | None,
                             cfg: dict[str, Any]) -> dict[str, Any]:
    info = PROVIDERS.get(provider)
    if info is None:
        raise SpecError([f"unknown provider '{provider}'"])
    unknown = sorted(set(cfg) - set(info.config_fields))
    if unknown:
        raise SpecError([f"unknown config fields {unknown}"])
    clean = {k: str(v).strip()[:300] for k, v in cfg.items() if str(v).strip()}
    if provider == "openai_compatible":
        if not clean.get("base_url"):
            raise SpecError(["base_url is required"])
        try:
            await check_base_url(clean["base_url"], config)
        except ToolError as e:
            raise SpecError([str(e)]) from e
    if secret is not None and not 8 <= len(secret.strip()) <= 500:
        raise SpecError(["credential looks invalid (expected 8-500 characters)"])

    existing = await db.select("integrations", filters={"org_id": org_id, "provider": provider})
    if not existing and not secret:
        raise SpecError(["a credential is required"])
    values: dict[str, Any] = {"config": clean, "status": "configured"}
    if secret:
        values["secret_hint"] = secret.strip()[-4:]
    if existing:
        row = (await db.update("integrations", values, filters={"id": existing[0]["id"]}))[0]
    else:
        row = (await db.insert("integrations", {"org_id": org_id, "provider": provider, "created_by": actor.id, **values}))[0]
    if secret:
        await db.rpc("set_integration_secret", {"p_integration": row["id"], "p_secret": secret.strip()})
    await record_audit(db, org_id, "integration.configure", "integration", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=info.name,
                       details={"provider": provider, "config_fields": sorted(clean), "credential_updated": bool(secret)})
    return row


async def delete_integration(db: Any, org_id: str, actor: Actor, provider: str) -> None:
    rows = await db.delete("integrations", filters={"org_id": org_id, "provider": provider})
    if not rows:
        raise NotFound("integration not found")
    await record_audit(db, org_id, "integration.remove", "integration", actor_id=actor.id, actor_label=actor.email,
                       resource_id=rows[0]["id"], resource_name=PROVIDERS[provider].name)


async def test_integration(db: Any, config: Config, http: httpx.AsyncClient, org_id: str, actor: Actor,
                           provider: str) -> dict[str, Any]:
    row = await _one(db, "integrations", org_id=org_id, provider=provider)
    secret = await db.rpc("get_integration_secret", {"p_integration": row["id"]})
    ok, message = (False, "no stored credential") if not secret else \
        await test_credential(provider, secret, row.get("config") or {}, http, config)
    updated = (await db.update("integrations", {"last_tested_at": now_iso(), "last_test_ok": ok,
                                                "last_test_message": message[:300]}, filters={"id": row["id"]}))[0]
    await record_audit(db, org_id, "integration.test", "integration", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=PROVIDERS[provider].name,
                       outcome="success" if ok else "failure", details={"message": message[:300]})
    return updated


# --- MCP servers ---------------------------------------------------------------------------------


async def create_mcp_server(db: Any, config: Config, org_id: str, actor: Actor, *, name: str, slug: str, url: str,
                            auth_header: str = "Authorization", secret: str | None = None,
                            require_approval: bool = True) -> dict[str, Any]:
    """Register an MCP server, store its credential in Vault, then discover its tools."""
    name, slug, url, auth_header = name.strip(), slug.strip(), url.strip(), auth_header.strip()
    errors = []
    if not SLUG_RE.match(slug):
        errors.append("slug: 2-24 characters: lowercase letters, digits and hyphens, starting with a letter")
    if not 1 <= len(name) <= 80:
        errors.append("name: 1-80 characters")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", auth_header):
        errors.append("auth_header: letters, digits and hyphens only")
    if secret is not None and not 1 <= len(secret.strip()) <= 2000:
        errors.append("credential: 1-2000 characters")
    if errors:
        raise SpecError(errors)
    try:
        await check_url(url, config.allow_private_mcp_urls)
    except McpError as e:
        raise SpecError([f"url: {e}"]) from e
    try:
        row = (await db.insert("mcp_servers", {
            "org_id": org_id, "slug": slug, "name": name, "url": url, "auth_header": auth_header,
            "require_approval": require_approval, "status": "pending", "created_by": actor.id,
            "secret_hint": secret.strip()[-4:] if secret else "",
        }))[0]
    except StoreError as e:
        if e.code == "23505":
            raise SpecError([f"slug: an MCP server named '{slug}' already exists"]) from e
        raise
    if secret:
        await db.rpc("set_mcp_secret", {"p_server": row["id"], "p_secret": secret.strip()})
    await record_audit(db, org_id, "mcp.register", "mcp_server", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=name,
                       details={"slug": slug, "url": url, "credential": bool(secret), "require_approval": require_approval})
    return await refresh_mcp_server(db, config, org_id, row["id"], actor)


async def refresh_mcp_server(db: Any, config: Config, org_id: str, server_id: str, actor: Actor) -> dict[str, Any]:
    """Re-discover tools. Approved tools that disappeared from the server are dropped."""
    server = await _one(db, "mcp_servers", id=server_id, org_id=org_id)
    secret = await db.rpc("get_mcp_secret", {"p_server": server_id})
    try:
        await check_url(server["url"], config.allow_private_mcp_urls)
        info, tools = await mcp_list_tools(server["url"], auth_headers(server["auth_header"], secret))
    except McpError as e:
        status = "disabled" if server["status"] == "disabled" else "error"
        row = (await db.update("mcp_servers", {"status": status, "last_error": str(e), "last_checked_at": now_iso()},
                               filters={"id": server_id}))[0]
        await record_audit(db, org_id, "mcp.refresh", "mcp_server", actor_id=actor.id, actor_label=actor.email,
                           resource_id=server_id, resource_name=server["name"], outcome="failure", details={"error": str(e)})
        return row
    catalog = [{"name": t.name, "description": t.description, "input_schema": t.input_schema,
                "approvable": approvable(server["slug"], t.name)} for t in tools[:200]]
    names = {t["name"] for t in catalog}
    row = (await db.update("mcp_servers", {
        "status": "disabled" if server["status"] == "disabled" else "connected", "tool_catalog": catalog,
        "approved_tools": [t for t in server.get("approved_tools") or [] if t in names], "server_info": info,
        "last_error": None, "last_checked_at": now_iso(),
    }, filters={"id": server_id}))[0]
    await record_audit(db, org_id, "mcp.refresh", "mcp_server", actor_id=actor.id, actor_label=actor.email,
                       resource_id=server_id, resource_name=server["name"], details={"tools": len(catalog), "server": info})
    return row


async def update_mcp_server(db: Any, org_id: str, server_id: str, actor: Actor, *, approved_tools: list[str] | None = None,
                            require_approval: bool | None = None, enabled: bool | None = None,
                            secret: str | None = None, clear_secret: bool = False) -> dict[str, Any]:
    server = await _one(db, "mcp_servers", id=server_id, org_id=org_id)
    values: dict[str, Any] = {}
    if approved_tools is not None:
        discovered = {t["name"] for t in server.get("tool_catalog") or []}
        bad = [t for t in approved_tools if t not in discovered or not approvable(server["slug"], t)]
        if bad:
            raise SpecError([f"approved_tools: not discovered on this server, or not approvable: {bad[:5]}"])
        values["approved_tools"] = sorted(set(approved_tools))
    if require_approval is not None:
        values["require_approval"] = require_approval
    if enabled is not None:
        values["status"] = ("connected" if server.get("tool_catalog") and not server.get("last_error") else "pending") \
            if enabled else "disabled"
    if secret:
        if not 1 <= len(secret.strip()) <= 2000:
            raise SpecError(["credential: 1-2000 characters"])
        await db.rpc("set_mcp_secret", {"p_server": server_id, "p_secret": secret.strip()})
        values["secret_hint"] = secret.strip()[-4:]
    elif clear_secret:
        await db.delete("mcp_server_secrets", filters={"server_id": server_id})
        values["secret_hint"] = ""
    row = (await db.update("mcp_servers", values, filters={"id": server_id}))[0] if values else server
    await record_audit(db, org_id, "mcp.update", "mcp_server", actor_id=actor.id, actor_label=actor.email,
                       resource_id=server_id, resource_name=server["name"],
                       details={"approved_tools": values.get("approved_tools"), "require_approval": require_approval,
                                "enabled": enabled, "credential_updated": bool(secret), "credential_cleared": clear_secret})
    return row


async def delete_mcp_server(db: Any, org_id: str, server_id: str, actor: Actor) -> None:
    rows = await db.delete("mcp_servers", filters={"id": server_id, "org_id": org_id})
    if not rows:
        raise NotFound("MCP server not found")
    await record_audit(db, org_id, "mcp.remove", "mcp_server", actor_id=actor.id, actor_label=actor.email,
                       resource_id=server_id, resource_name=rows[0]["name"])


# --- memory --------------------------------------------------------------------------------------


async def add_memory(db: Any, org_id: str, actor: Actor, kind: str, title: str, content: str,
                     tags: list[str]) -> dict[str, Any]:
    if kind not in ("note", "decision"):
        raise SpecError(["kind must be note or decision"])
    if not 1 <= len(title.strip()) <= 300 or not 1 <= len(content.strip()) <= 20_000:
        raise SpecError(["title (1-300) and content (1-20000 characters) are required"])
    clean_tags = [t.strip().lower()[:40] for t in tags if t.strip()][:10]
    row = (await db.insert("memory_items", {"org_id": org_id, "kind": kind, "title": title.strip(), "content": content.strip(),
                                            "tags": clean_tags, "created_by": actor.id,
                                            "source": {"added_by": actor.email, "verified": "human"}}))[0]
    await record_audit(db, org_id, "memory.create", "memory", actor_id=actor.id, actor_label=actor.email,
                       resource_id=row["id"], resource_name=title[:120])
    return row


async def delete_memory(db: Any, org_id: str, actor: Actor, memory_id: str) -> None:
    rows = await db.delete("memory_items", filters={"id": memory_id, "org_id": org_id})
    if not rows:
        raise NotFound("memory item not found")
    await record_audit(db, org_id, "memory.delete", "memory", actor_id=actor.id, actor_label=actor.email,
                       resource_id=memory_id, resource_name=rows[0]["title"][:120])
