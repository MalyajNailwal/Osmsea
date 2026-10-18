"""OSMSEA as an MCP server (Streamable HTTP at /mcp).

AI clients such as Claude Code, Cursor or Claude Desktop hand goals to an organization and read verified
results. Every request needs an organization API token (``Authorization: Bearer osm_...``). Clients can
submit goals and read results; they cannot approve plans, change agents or see credentials. Plans that
need approval wait for an admin in the OSMSEA UI.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Annotated, Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from .automation import ACTIVE_WORKFLOW, Principal, resolve_token
from .registry import load_registry
from .tools import clip, or_query

MAX_ACTIVE_WORKFLOWS = 10  # ponytail: one per-org cap for token-started work; make it a setting if orgs need more
SETTLED = ("awaiting_approval", "completed", "failed", "cancelled", "rejected", "plan_failed")

INSTRUCTIONS = """OSMSEA runs an organization of specialized AI agents. Use list_agents to see what the organization can do,
submit_goal to hand it a goal, and get_workflow (with wait_seconds) to follow progress and read the verified results.
Results are marked complete only after verification (schema, evidence, tests, independent review). Some plans must be
approved by a human admin in the OSMSEA UI before they run; get_workflow reports that state and a link."""


def build(db: Any, worker: Any, web_url: str) -> MCPServer:
    mcp = MCPServer("osmsea", instructions=INSTRUCTIONS)

    def principal(ctx: Context) -> Principal:
        request = ctx.request_context.request
        p = getattr(getattr(request, "state", None), "osmsea", None)
        if not isinstance(p, Principal):
            raise ToolError("not authenticated")
        return p

    @mcp.tool()
    async def list_agents(ctx: Context) -> dict[str, Any]:
        """List the organization's active agents: role, mission, capabilities, limitations, tools and output type."""
        reg = await load_registry(db, principal(ctx).org_id)
        return {"organization": reg.name, "agents": reg.planner_catalog()}

    @mcp.tool()
    async def submit_goal(goal: Annotated[str, Field(min_length=3, max_length=4000)], ctx: Context) -> dict[str, Any]:
        """Hand a goal to the organization. OSMSEA plans it, an admin may have to approve the plan, agents execute
        it and every output is verified. Returns the workflow id; follow it with get_workflow."""
        p = principal(ctx)
        active = await db.select("workflows", filters={"org_id": p.org_id, "status": ("in", list(ACTIVE_WORKFLOW))}, columns="id")
        if len(active) >= MAX_ACTIVE_WORKFLOWS:
            raise ToolError(f"the organization already has {len(active)} active workflows; wait for some to finish")
        wf = await worker.start_workflow(p.org_id, goal, actor_id=p.actor.id, actor_label=p.actor.email)
        return {"workflow_id": wf["id"], "status": wf["status"], "url": f"{web_url}/tasks/{wf['id']}",
                "next": "Call get_workflow with this id and wait_seconds (up to 50) to follow progress."}

    @mcp.tool()
    async def get_workflow(workflow_id: str, ctx: Context,
                           wait_seconds: Annotated[int, Field(ge=0, le=50)] = 0) -> dict[str, Any]:
        """Status, plan and verified results of a workflow. With wait_seconds, waits until the workflow finishes,
        needs approval, or the time is up."""
        p = principal(ctx)
        try:
            uuid.UUID(workflow_id)
        except ValueError as e:
            raise ToolError("workflow_id must be a UUID returned by submit_goal") from e
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_seconds
        while True:
            rows = await db.select("workflows", filters={"id": workflow_id, "org_id": p.org_id})
            if not rows:
                raise ToolError("workflow not found in this organization")
            wf = rows[0]
            if wf["status"] in SETTLED or loop.time() >= deadline:
                break
            await asyncio.sleep(1)
        tasks = await db.select("tasks", filters={"workflow_id": workflow_id}, order="created_at.asc")
        return {
            "workflow_id": wf["id"], "status": wf["status"], "goal": wf["goal"], "objective": wf.get("objective"),
            "url": f"{web_url}/tasks/{wf['id']}", "error": wf.get("error"),
            "approval": "Waiting for an admin to approve the plan in OSMSEA (open the url)."
                        if wf["status"] == "awaiting_approval" else None,
            "tasks": [_task(t) for t in tasks],
            "tokens_used": wf.get("tokens_used"), "cost_usd": float(wf["cost_usd"]) if wf.get("cost_usd") is not None else None,
        }

    @mcp.tool()
    async def search_memory(query: Annotated[str, Field(min_length=2, max_length=300)], ctx: Context,
                            limit: Annotated[int, Field(ge=1, le=10)] = 5) -> dict[str, Any]:
        """Search the organization's shared memory: verified findings and decisions, with their sources."""
        rows = await db.rpc("search_memory", {"p_org": principal(ctx).org_id, "p_query": or_query(query), "p_limit": limit})
        return {"results": [{"id": r["id"], "kind": r["kind"], "title": r["title"], "content": clip(r["content"], 1500),
                             "source": (r.get("source") or {}).get("url"), "created_at": r.get("created_at")}
                            for r in rows or []]}

    # Stateless JSON responses suit request/response tools. DNS-rebinding protection guards servers that trust
    # ambient browser credentials; every request here carries a bearer token, so Host checks add nothing.
    mcp.streamable_http_app(stateless_http=True, json_response=True,
                            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))
    return mcp


def _task(t: dict[str, Any]) -> dict[str, Any]:
    out = t.get("output") if t["status"] == "completed" else None
    if out is not None and len(json.dumps(out, default=str)) > 20_000:
        out = clip(json.dumps(out, default=str), 20_000)
    return {"key": t["key"], "title": t["title"], "agent": t["agent_slug"], "status": t["status"],
            "attempt": t.get("attempt"), "verified": (t.get("verification") or {}).get("passed"),
            "error": t.get("error") if t["status"] in ("failed", "blocked") else None, "output": out}


class endpoint:  # noqa: N801 - a class, not a function, so Starlette routes every HTTP method to it as raw ASGI
    """ASGI endpoint for /mcp: authenticate the token, then hand the request to the MCP session manager."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        state = self.app.state
        auth = dict(scope.get("headers") or []).get(b"authorization", b"").decode(errors="replace")
        p = await resolve_token(state.db, auth[7:].strip()) if auth[:7].lower() == "bearer " else None
        if p is None:
            body = json.dumps({"error": "invalid_token",
                               "error_description": "Create an organization API token in OSMSEA → Integrations."}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b'Bearer realm="osmsea"')]})
            await send({"type": "http.response.body", "body": body})
            return
        await state.mcp.session_manager.handle_request({**scope, "state": {**(scope.get("state") or {}), "osmsea": p}},
                                                       receive, send)
