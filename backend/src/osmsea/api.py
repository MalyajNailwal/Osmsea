"""HTTP API. Reads go straight from the browser to Supabase (RLS-protected); every write and every
model call goes through here, where the caller's organization role is checked.

Run: ``uv run uvicorn osmsea.api:create_app --factory --app-dir src --env-file .env --port 8000``
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import orgs
from .auth import Authenticator, User, member_role, role_allows
from .builder import propose_organization
from .config import Config
from .integrations import ProviderNotConfigured, catalog, llm_provider_for_org, tool_secrets
from .llm import LLMError
from .orgs import Actor, NotFound
from .planner import Conflict, approve_workflow, reject_workflow
from .registry import load_registry
from .scheduler import Worker
from .schemas import OUTPUT_SCHEMAS
from .specs import SpecError, load_organization_dir, parse_agent_markdown, parse_settings, render_agent_markdown
from .store import SupabaseStore, record_audit, record_event
from .tools import TOOLS

log = logging.getLogger("osmsea")


# --- request models --------------------------------------------------------------------------------


class GoalIn(BaseModel):
    goal: str = Field(min_length=3, max_length=4000)


class ProposeIn(GoalIn):
    org_id: UUID | None = None


class DecisionIn(BaseModel):
    comment: str | None = Field(None, max_length=1000)


class AgentSourceIn(BaseModel):
    source_md: str = Field(min_length=1, max_length=64 * 1024)
    note: str = Field("", max_length=300)


class AgentStatusIn(BaseModel):
    status: Literal["active", "disabled"]


class DepartmentIn(BaseModel):
    slug: str = Field(max_length=48)
    name: str = Field(max_length=80)
    description: str = Field(max_length=500)


class DepartmentUpdateIn(BaseModel):
    name: str = Field(max_length=80)
    description: str = Field(max_length=500)


class AgentSourceRef(BaseModel):
    source_md: str = Field(max_length=64 * 1024)


class OrgCreateIn(BaseModel):
    template: Literal["default"] | None = None
    name: str | None = Field(None, max_length=120)
    description: str | None = Field(None, max_length=2000)
    departments: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    agents: list[AgentSourceRef] = Field(default_factory=list, max_length=50)
    settings: dict[str, Any] | None = None


class OrgUpdateIn(BaseModel):
    name: str | None = Field(None, max_length=120)
    description: str | None = Field(None, max_length=2000)


class SettingsIn(BaseModel):
    settings: dict[str, Any]


class IntegrationIn(BaseModel):
    secret: str | None = Field(None, max_length=500)
    config: dict[str, str] = Field(default_factory=dict)


class McpServerIn(BaseModel):
    name: str = Field(max_length=80)
    slug: str = Field(max_length=24)
    url: str = Field(max_length=500)
    auth_header: str = Field("Authorization", max_length=64)
    secret: str | None = Field(None, max_length=2000)
    require_approval: bool = True


class McpServerUpdateIn(BaseModel):
    approved_tools: list[str] | None = Field(None, max_length=200)
    require_approval: bool | None = None
    enabled: bool | None = None
    secret: str | None = Field(None, max_length=2000)
    clear_secret: bool = False


class MemoryIn(BaseModel):
    kind: Literal["note", "decision"] = "note"
    title: str = Field(max_length=300)
    content: str = Field(max_length=20_000)
    tags: list[str] = Field(default_factory=list, max_length=10)


# --- app -------------------------------------------------------------------------------------------


def create_app(config: Config | None = None, *, db: Any = None, provider_factory: Any = None,
               secrets_factory: Any = None, authenticator: Any = None) -> FastAPI:
    if config is None:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
        logging.getLogger("httpx").setLevel(logging.WARNING)  # the scheduler polls; per-request logs are noise
        config = Config.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        http = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
        store = db or SupabaseStore(config.supabase_url, config.supabase_secret_key)

        async def default_provider(org_id: str | None, model: str | None = None, org_default_model: str | None = None):
            return await llm_provider_for_org(store, config, org_id, model=model, org_default_model=org_default_model, http=http)

        async def default_secrets(org_id: str) -> dict[str, str]:
            return await tool_secrets(store, org_id)

        app.state.config = config
        app.state.db = store
        app.state.http = http
        app.state.provider_factory = provider_factory or default_provider
        app.state.auth = authenticator or Authenticator(config.supabase_url, config.supabase_publishable_key, http)
        app.state.worker = Worker(store, provider_factory=app.state.provider_factory,
                                  secrets_factory=secrets_factory or default_secrets, http=http,
                                  concurrency=config.worker_concurrency, poll_interval=config.poll_interval,
                                  lease_seconds=config.lease_seconds)
        if config.worker_enabled:
            await app.state.worker.start()
        try:
            yield
        finally:
            await app.state.worker.stop()
            await http.aclose()
            if db is None:
                await store.close()

    app = FastAPI(title="OSMSEA", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins, allow_methods=["*"],
                       allow_headers=["Authorization", "Content-Type"])

    @app.exception_handler(SpecError)
    async def _spec_error(_: Request, e: SpecError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": "validation failed", "errors": e.errors})

    @app.exception_handler(NotFound)
    async def _not_found(_: Request, e: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(e)})

    @app.exception_handler(Conflict)
    async def _conflict(_: Request, e: Conflict) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(e)})

    @app.exception_handler(ProviderNotConfigured)
    async def _no_provider(_: Request, e: ProviderNotConfigured) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    @app.exception_handler(LLMError)
    async def _llm_error(_: Request, e: LLMError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"detail": str(e)})

    # --- dependencies ------------------------------------------------------------------------------

    async def current_user(request: Request, authorization: Annotated[str | None, Header()] = None) -> User:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "missing bearer token")
        user = await request.app.state.auth.user(authorization[7:].strip())
        if user is None:
            raise HTTPException(401, "invalid or expired session")
        return user

    def require(minimum: str):
        async def dep(org_id: UUID, request: Request, user: Annotated[User, Depends(current_user)]) -> Actor:
            role = await member_role(request.app.state.db, user.id, str(org_id))
            if role is None:
                raise HTTPException(404, "organization not found")  # do not reveal other tenants' orgs
            if not role_allows(role, minimum):
                await record_audit(request.app.state.db, str(org_id), "authorization.denied", "endpoint",
                                   actor_id=user.id, actor_label=user.email, resource_name=request.url.path,
                                   outcome="denied", details={"role": role, "required": minimum})
                raise HTTPException(403, f"requires the {minimum} role")
            return Actor(user.id, user.email)
        return dep

    Viewer = Annotated[Actor, Depends(require("viewer"))]
    Member = Annotated[Actor, Depends(require("member"))]
    Admin = Annotated[Actor, Depends(require("admin"))]
    AnyUser = Annotated[User, Depends(current_user)]

    def state(request: Request) -> Any:
        return request.app.state

    # --- public ------------------------------------------------------------------------------------

    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        worker: Worker = request.app.state.worker
        return {"status": "ok", "worker": {"id": worker.id, "enabled": config.worker_enabled, "last_tick": worker.last_tick,
                                           "running_tasks": len(worker.running), "planning": len(worker.planning)}}

    @app.get("/catalog")
    async def get_catalog(_: AnyUser) -> dict[str, Any]:
        return {
            "tools": [{"name": t.name, "description": t.description, "integrations": list(t.integrations)} for t in TOOLS.values()],
            "output_schemas": [{"name": n, "description": s.description, "has_sources": s.has_sources, "has_files": s.has_files}
                               for n, s in OUTPUT_SCHEMAS.items()],
            "providers": catalog(),
            "default_settings": parse_settings(None).model_dump(),
        }

    @app.get("/templates/default")
    async def default_template(_: AnyUser) -> dict[str, Any]:
        org = load_organization_dir(config.template_dir)
        return {"name": org.name, "description": org.description,
                "departments": [d.model_dump(exclude={"readme"}) for d in org.departments],
                "agents": [{"id": a.id, "source_md": render_agent_markdown(a), "valid": True, "errors": []} for a in org.agents]}

    @app.post("/agents/validate")
    async def validate_draft(body: AgentSourceIn, _: AnyUser) -> dict[str, Any]:
        """Validate a draft spec that does not belong to an organization yet (Builder drafts)."""
        try:
            spec = parse_agent_markdown(body.source_md)
        except SpecError as e:
            return {"valid": False, "errors": e.errors}
        return {"valid": True, "errors": [], "spec": spec.model_dump(mode="json")}

    # --- organizations -----------------------------------------------------------------------------

    @app.post("/orgs/propose")
    async def propose(body: ProposeIn, request: Request, user: AnyUser) -> dict[str, Any]:
        org_id = str(body.org_id) if body.org_id else None
        if org_id and not role_allows(await member_role(state(request).db, user.id, org_id), "admin"):
            raise HTTPException(404, "organization not found")
        provider = await state(request).provider_factory(org_id)
        try:
            return await propose_organization(provider, body.goal)
        except ValueError as e:
            raise HTTPException(502, f"proposal failed: {e}") from e

    @app.post("/orgs", status_code=201)
    async def create_org(body: OrgCreateIn, request: Request, user: AnyUser) -> dict[str, Any]:
        actor = Actor(user.id, user.email)
        if body.template == "default":
            spec = load_organization_dir(config.template_dir)
            if body.name:
                spec = spec.model_copy(update={"name": body.name})
            return await orgs.create_organization(state(request).db, actor, spec, settings=body.settings)
        spec, sources = orgs.organization_from_payload({
            "name": body.name or "", "description": body.description or "",
            "departments": body.departments, "agents": [a.model_dump() for a in body.agents]})
        return await orgs.create_organization(state(request).db, actor, spec, sources, settings=body.settings)

    @app.patch("/orgs/{org_id}")
    async def update_org(org_id: UUID, body: OrgUpdateIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.update_organization(state(request).db, str(org_id), actor, body.name, body.description)

    @app.put("/orgs/{org_id}/settings")
    async def put_settings(org_id: UUID, body: SettingsIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.update_settings(state(request).db, str(org_id), actor, body.settings)

    @app.get("/orgs/{org_id}/status")
    async def org_status(org_id: UUID, request: Request, _: Viewer) -> dict[str, Any]:
        s = state(request)
        reg = await load_registry(s.db, str(org_id))
        try:
            provider = await s.provider_factory(str(org_id), org_default_model=reg.settings.default_model)
            llm = {"configured": True, "provider": provider.name, "model": provider.model}
        except ProviderNotConfigured as e:
            llm = {"configured": False, "message": str(e)}
        return {"llm": llm, "worker": {"enabled": config.worker_enabled, "last_tick": s.worker.last_tick,
                                       "running_tasks": len(s.worker.running)},
                "invalid_agents": reg.invalid, "providers": sorted(reg.providers)}

    # --- departments & agents ----------------------------------------------------------------------

    @app.post("/orgs/{org_id}/departments", status_code=201)
    async def create_department(org_id: UUID, body: DepartmentIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.create_department(state(request).db, str(org_id), actor, body.slug, body.name, body.description)

    @app.patch("/orgs/{org_id}/departments/{dept_id}")
    async def update_department(org_id: UUID, dept_id: UUID, body: DepartmentUpdateIn, request: Request,
                                actor: Admin) -> dict[str, Any]:
        return await orgs.update_department(state(request).db, str(org_id), str(dept_id), actor, body.name, body.description)

    @app.post("/orgs/{org_id}/agents/validate")
    async def validate_agent(org_id: UUID, body: AgentSourceIn, request: Request, _: Viewer) -> dict[str, Any]:
        """Dry run: parse + validate a spec and show which tools it would effectively get."""
        try:
            spec = parse_agent_markdown(body.source_md)
        except SpecError as e:
            return {"valid": False, "errors": e.errors}
        reg = await load_registry(state(request).db, str(org_id))
        errors = [] if spec.department in reg.departments else [f"department: unknown department '{spec.department}'"]
        allowed, unavailable = reg.effective_tools(spec)
        return {"valid": not errors, "errors": errors, "spec": spec.model_dump(mode="json"),
                "effective_tools": {"allowed": allowed, "unavailable": unavailable}}

    @app.post("/orgs/{org_id}/agents", status_code=201)
    async def create_agent(org_id: UUID, body: AgentSourceIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.create_agent(state(request).db, str(org_id), actor, body.source_md, body.note)

    @app.put("/orgs/{org_id}/agents/{agent_id}")
    async def update_agent(org_id: UUID, agent_id: UUID, body: AgentSourceIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.update_agent(state(request).db, str(org_id), str(agent_id), actor, body.source_md, body.note)

    @app.post("/orgs/{org_id}/agents/{agent_id}/status")
    async def agent_status(org_id: UUID, agent_id: UUID, body: AgentStatusIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.set_agent_status(state(request).db, str(org_id), str(agent_id), actor, body.status)

    # --- workflows ---------------------------------------------------------------------------------

    @app.post("/orgs/{org_id}/workflows", status_code=201)
    async def create_workflow(org_id: UUID, body: GoalIn, request: Request, actor: Member) -> dict[str, Any]:
        s = state(request)
        org = (await s.db.select("organizations", filters={"id": str(org_id)}))[0]
        settings = parse_settings(org.get("settings"))
        wf = (await s.db.insert("workflows", {"org_id": str(org_id), "goal": body.goal.strip(), "status": "planning",
                                              "created_by": actor.id, "token_budget": settings.workflow_token_budget}))[0]
        await record_event(s.db, str(org_id), "workflow_created", f"Goal submitted by {actor.email}", workflow_id=wf["id"])
        await record_audit(s.db, str(org_id), "workflow.create", "workflow", actor_id=actor.id, actor_label=actor.email,
                           resource_id=wf["id"], resource_name=body.goal[:120])
        s.worker.submit_planning(wf["id"])
        return wf

    @app.post("/orgs/{org_id}/workflows/{workflow_id}/approve")
    async def approve(org_id: UUID, workflow_id: UUID, body: DecisionIn, request: Request, actor: Admin) -> dict[str, str]:
        await approve_workflow(state(request).db, str(org_id), str(workflow_id), actor.id, actor.email, body.comment)
        state(request).worker.notify()
        return {"status": "running"}

    @app.post("/orgs/{org_id}/workflows/{workflow_id}/reject")
    async def reject(org_id: UUID, workflow_id: UUID, body: DecisionIn, request: Request, actor: Admin) -> dict[str, str]:
        await reject_workflow(state(request).db, str(org_id), str(workflow_id), actor.id, actor.email, body.comment)
        return {"status": "rejected"}

    @app.post("/orgs/{org_id}/workflows/{workflow_id}/cancel")
    async def cancel(org_id: UUID, workflow_id: UUID, request: Request, actor: Admin) -> dict[str, str]:
        await state(request).worker.cancel_workflow(str(org_id), str(workflow_id), actor.id, actor.email)
        return {"status": "cancelled"}

    # --- integrations ------------------------------------------------------------------------------

    @app.put("/orgs/{org_id}/integrations/{provider}")
    async def put_integration(org_id: UUID, provider: str, body: IntegrationIn, request: Request, actor: Admin) -> dict[str, Any]:
        row = await orgs.upsert_integration(state(request).db, config, str(org_id), actor, provider, body.secret, body.config)
        return {k: v for k, v in row.items() if k != "secret_id"}

    @app.post("/orgs/{org_id}/integrations/{provider}/test")
    async def test_integration(org_id: UUID, provider: str, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.test_integration(state(request).db, config, state(request).http, str(org_id), actor, provider)

    @app.delete("/orgs/{org_id}/integrations/{provider}", status_code=204)
    async def delete_integration(org_id: UUID, provider: str, request: Request, actor: Admin) -> None:
        await orgs.delete_integration(state(request).db, str(org_id), actor, provider)

    # --- tools & MCP servers -----------------------------------------------------------------------

    @app.get("/orgs/{org_id}/tools")
    async def org_tools(org_id: UUID, request: Request, _: Viewer) -> dict[str, Any]:
        """Every tool an agent in this org could request: built-ins plus approved MCP tools."""
        reg = await load_registry(state(request).db, str(org_id))
        return {
            "builtin": [{"name": t.name, "description": t.description, "integrations": list(t.integrations),
                         "enabled": reg.settings.policy_for(t.name).enabled,
                         "available": not t.integrations or bool(reg.providers.intersection(t.integrations))}
                        for t in TOOLS.values()],
            "mcp": [{"name": r.name, "server": r.slug, "server_name": r.server_name, "tool": r.tool,
                     "description": r.description, "require_approval": r.require_approval}
                    for r in reg.mcp_tools.values()],
        }

    @app.post("/orgs/{org_id}/mcp-servers", status_code=201)
    async def create_mcp_server(org_id: UUID, body: McpServerIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.create_mcp_server(state(request).db, config, str(org_id), actor, name=body.name, slug=body.slug,
                                            url=body.url, auth_header=body.auth_header, secret=body.secret,
                                            require_approval=body.require_approval)

    @app.post("/orgs/{org_id}/mcp-servers/{server_id}/refresh")
    async def refresh_mcp_server(org_id: UUID, server_id: UUID, request: Request, actor: Admin) -> dict[str, Any]:
        return await orgs.refresh_mcp_server(state(request).db, config, str(org_id), str(server_id), actor)

    @app.patch("/orgs/{org_id}/mcp-servers/{server_id}")
    async def update_mcp_server(org_id: UUID, server_id: UUID, body: McpServerUpdateIn, request: Request,
                                actor: Admin) -> dict[str, Any]:
        return await orgs.update_mcp_server(state(request).db, str(org_id), str(server_id), actor,
                                            approved_tools=body.approved_tools, require_approval=body.require_approval,
                                            enabled=body.enabled, secret=body.secret, clear_secret=body.clear_secret)

    @app.delete("/orgs/{org_id}/mcp-servers/{server_id}", status_code=204)
    async def delete_mcp_server(org_id: UUID, server_id: UUID, request: Request, actor: Admin) -> None:
        await orgs.delete_mcp_server(state(request).db, str(org_id), str(server_id), actor)

    # --- memory ------------------------------------------------------------------------------------

    @app.post("/orgs/{org_id}/memory", status_code=201)
    async def add_memory(org_id: UUID, body: MemoryIn, request: Request, actor: Member) -> dict[str, Any]:
        return await orgs.add_memory(state(request).db, str(org_id), actor, body.kind, body.title, body.content, body.tags)

    @app.delete("/orgs/{org_id}/memory/{memory_id}", status_code=204)
    async def delete_memory(org_id: UUID, memory_id: UUID, request: Request, actor: Admin) -> None:
        await orgs.delete_memory(state(request).db, str(org_id), actor, str(memory_id))

    return app
