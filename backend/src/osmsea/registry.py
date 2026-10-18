"""Organization registry: the validated runtime view of an organization.

Built from Supabase rows (departments, agents, *active* agent versions, configured integrations).
Stored specs are re-validated on load, so a malformed row can never reach the planner or executor.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from .specs import AgentSpec, OrgSettings, SpecError, parse_settings
from .tools import TOOLS

log = logging.getLogger(__name__)


@dataclass
class RegisteredAgent:
    agent_id: str  # agents.id
    version_id: str  # agent_versions.id
    version: int
    status: str  # draft | active | disabled
    spec: AgentSpec


@dataclass
class OrgRegistry:
    org_id: str
    name: str
    settings: OrgSettings
    departments: dict[str, dict[str, Any]]  # slug -> row
    agents: dict[str, RegisteredAgent]  # slug -> agent
    providers: set[str]  # integration providers with a stored credential
    invalid: dict[str, list[str]] = field(default_factory=dict)  # slug -> validation errors

    def active_agents(self) -> list[RegisteredAgent]:
        return [a for a in self.agents.values() if a.status == "active"]

    def effective_tools(self, spec: AgentSpec, approved: set[str] | None = None) -> tuple[list[str], dict[str, str]]:
        """Tools an agent may actually use: spec request ∩ org policy ∩ integrations ∩ approved plan.

        Returns (allowed, unavailable) where unavailable maps tool -> human-readable reason.
        """
        allowed, unavailable = [], {}
        for name in spec.allowed_tools:
            tool = TOOLS.get(name)
            if tool is None:
                unavailable[name] = "unknown tool"
            elif not self.settings.policy_for(name).enabled:
                unavailable[name] = "disabled by organization policy"
            elif tool.integrations and not self.providers.intersection(tool.integrations):
                unavailable[name] = f"needs an integration: {' or '.join(tool.integrations)}"
            elif approved is not None and name not in approved:
                unavailable[name] = "not approved for this workflow"
            else:
                allowed.append(name)
        return allowed, unavailable

    def planner_catalog(self) -> list[dict[str, Any]]:
        """What the planner may know about agents: no instructions, no secrets."""
        catalog = []
        for a in self.active_agents():
            tools, _ = self.effective_tools(a.spec)
            dept = self.departments.get(a.spec.department, {})
            catalog.append({
                "agent_id": a.spec.id,
                "name": a.spec.name,
                "department": dept.get("name", a.spec.department),
                "role": a.spec.role,
                "mission": a.spec.mission,
                "capabilities": a.spec.capabilities,
                "limitations": a.spec.limitations,
                "tools": tools,
                "output": a.spec.output_schema,
            })
        return catalog


def spec_from_row(spec: dict[str, Any], source: str = "") -> AgentSpec:
    try:
        return AgentSpec.model_validate(spec)
    except ValidationError as e:
        raise SpecError([f"{source}{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()]) from e


async def load_registry(db: Any, org_id: str) -> OrgRegistry:
    orgs = await db.select("organizations", filters={"id": org_id})
    if not orgs:
        raise LookupError(f"organization {org_id} not found")
    org = orgs[0]
    departments = {d["slug"]: d for d in await db.select("departments", filters={"org_id": org_id})}
    agent_rows = await db.select("agents", filters={"org_id": org_id})
    version_ids = [a["active_version_id"] for a in agent_rows if a.get("active_version_id")]
    versions = {v["id"]: v for v in await db.select("agent_versions", filters={"id": ("in", version_ids)})} if version_ids else {}
    providers = {i["provider"] for i in await db.select("integrations", filters={"org_id": org_id, "status": "configured"})}

    agents, invalid = {}, {}
    for row in agent_rows:
        version = versions.get(row.get("active_version_id"))
        if version is None:
            invalid[row["slug"]] = ["no active version"]
            continue
        try:
            spec = spec_from_row(version["spec"])
        except SpecError as e:
            log.warning("agent %s has an invalid stored spec: %s", row["slug"], e)
            invalid[row["slug"]] = e.errors
            continue
        agents[row["slug"]] = RegisteredAgent(row["id"], version["id"], version["version"], row["status"], spec)

    return OrgRegistry(
        org_id=org_id,
        name=org["name"],
        settings=parse_settings(org.get("settings")),
        departments=departments,
        agents=agents,
        providers=providers,
        invalid=invalid,
    )
