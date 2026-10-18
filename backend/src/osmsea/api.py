"""HTTP API. Reads go straight from the browser to Supabase (RLS-protected); every write and every
model call goes through here, where the caller's organization role is checked.

Run: ``uv run uvicorn osmsea.api:create_app --factory --app-dir src --env-file .env --port 8000``
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.routing import Route
from pydantic import BaseModel, Field

from . import actions, automation, improve, knowledge, mcp_server, members, orgs, sandbox
from .auth import Authenticator, User, member_role, role_allows
from .builder import propose_organization
from .config import Config
from .evals import choose_model, create_eval_run, create_replay, model_stats
from .integrations import ProviderNotConfigured, catalog, llm_provider_for_org, tool_secrets
from .llm import LLMError
from .orgs import Actor, NotFound
from .planner import Conflict, approve_workflow, reject_workflow
from .registry import load_registry
from .scheduler import Worker
from .schemas import OUTPUT_SCHEMAS
from .specs import SpecError, load_organization_dir, parse_agent_markdown, parse_settings, render_agent_markdown
from .store import SupabaseStore, now_iso, record_audit
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


class DocumentUrlIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    title: str | None = Field(None, max_length=300)


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: Literal["viewer", "member", "admin"] = "member"


class InviteTokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


class RoleIn(BaseModel):
    role: Literal["viewer", "member", "admin"]


class ReplayIn(BaseModel):
    source_md: str | None = Field(None, min_length=1, max_length=64 * 1024)  # default: the spec version the attempt used
    model: str | None = Field(None, min_length=1, max_length=120)


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class TriggerIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["schedule", "webhook"]
    goal: str = Field(min_length=3, max_length=4000)
    interval_minutes: int | None = Field(None, ge=15, le=525_600)
    start_at: datetime | None = None
    require_approval: bool = True


class TriggerUpdateIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    goal: str | None = Field(None, min_length=3, max_length=4000)
    enabled: bool | None = None
    require_approval: bool | None = None


class EvalIn(BaseModel):
    source_md: str | None = Field(None, min_length=1, max_length=64 * 1024)  # default: the active version
    models: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(default_factory=list, max_length=4)


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
        app.state.mcp = mcp_server.build(store, app.state.worker, config.web_url)
        mcp_ready = asyncio.Event()

        async def serve_mcp() -> None:  # own task: the session manager's task group must open and close in one task
            async with app.state.mcp.session_manager.run():
                mcp_ready.set()
                await asyncio.Future()

        mcp_task = asyncio.create_task(serve_mcp(), name="osmsea-mcp")
        await mcp_ready.wait()
        if config.worker_enabled:
            await app.state.worker.start()
        try:
            yield
        finally:
            mcp_task.cancel()
            await asyncio.gather(mcp_task, return_exceptions=True)
            await app.state.worker.stop()
            await http.aclose()
            if db is None:
                await store.close()

    app = FastAPI(title="OSMSEA", version="0.1.0", lifespan=lifespan)
    app.router.routes.append(Route("/mcp", endpoint=mcp_server.endpoint(app)))  # OSMSEA's own MCP server
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
                "invalid_agents": reg.invalid, "providers": sorted(reg.providers), "sandbox": await sandbox.status()}

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

    # --- self-improvement: insights, evaluations, proposals ----------------------------------------

    @app.get("/orgs/{org_id}/agents/{agent_id}/insights")
    async def agent_insights(org_id: UUID, agent_id: UUID, request: Request, _: Viewer) -> dict[str, Any]:
        db, oid, aid = state(request).db, str(org_id), str(agent_id)
        reg = await load_registry(db, oid)
        agent = next((a for a in reg.agents.values() if a.agent_id == aid), None)
        if agent is None:
            raise NotFound("agent not found")
        model, reason = await choose_model(db, reg, agent.spec, aid)
        return {"failures": await improve.failure_report(db, oid, aid), "models": await model_stats(db, oid, aid),
                "routing": {"model": model or reg.settings.default_model, "reason": reason},
                "eval_cases": len(await db.select("eval_cases", filters={"agent_id": aid, "status": "active"}, columns="id"))}

    @app.post("/orgs/{org_id}/agents/{agent_id}/evals", status_code=201)
    async def start_evals(org_id: UUID, agent_id: UUID, body: EvalIn, request: Request, actor: Admin) -> list[dict[str, Any]]:
        s = state(request)
        runs = [await create_eval_run(s.db, str(org_id), str(agent_id), actor.id, actor.email, source_md=body.source_md,
                                      model=m, kind="model_compare" if body.models else "manual")
                for m in (body.models or [None])]
        for r in runs:
            s.worker.submit_eval(r["id"])
        return runs

    @app.post("/orgs/{org_id}/agents/{agent_id}/proposals", status_code=201)
    async def propose_revision(org_id: UUID, agent_id: UUID, request: Request, actor: Admin) -> dict[str, Any]:
        s = state(request)
        row = await improve.propose_revision(s.db, s.provider_factory, str(org_id), str(agent_id), actor)
        if row.get("eval_run_id"):
            s.worker.submit_eval(row["eval_run_id"])
        return row

    @app.post("/orgs/{org_id}/proposals/{proposal_id}/{decision}")
    async def decide_proposal(org_id: UUID, proposal_id: UUID, decision: Literal["accept", "reject"], request: Request,
                              actor: Admin) -> dict[str, Any]:
        return await improve.decide_proposal(state(request).db, str(org_id), str(proposal_id), actor, decision == "accept")

    # --- knowledge base ----------------------------------------------------------------------------

    @app.post("/orgs/{org_id}/documents", status_code=201)
    async def upload_document(org_id: UUID, request: Request, actor: Member, file: Annotated[UploadFile, File()],
                              title: Annotated[str | None, Form(max_length=300)] = None) -> dict[str, Any]:
        data = await file.read(knowledge.MAX_BYTES + 1)
        return await knowledge.add_upload(state(request).db, str(org_id), actor, filename=file.filename or "upload.txt",
                                          data=data, mime=file.content_type, title=title)

    @app.post("/orgs/{org_id}/documents/url", status_code=201)
    async def add_document_url(org_id: UUID, body: DocumentUrlIn, request: Request, actor: Member) -> dict[str, Any]:
        return await knowledge.add_url(state(request).db, str(org_id), actor, body.url, body.title)

    @app.delete("/orgs/{org_id}/documents/{document_id}", status_code=204)
    async def delete_document(org_id: UUID, document_id: UUID, request: Request, actor: Admin) -> None:
        await knowledge.delete(state(request).db, str(org_id), str(document_id), actor)

    @app.get("/orgs/{org_id}/documents/search")
    async def search_documents(org_id: UUID, q: str, request: Request, _: Viewer, limit: int = 8) -> list[dict[str, Any]]:
        if not 1 <= len(q) <= 300:
            raise HTTPException(422, "q must be 1-300 characters")
        return await knowledge.search(state(request).db, str(org_id), q, max(1, min(limit, 20)))

    # --- actions (approval-gated deliveries) --------------------------------------------------------

    @app.post("/orgs/{org_id}/actions/{action_id}/{decision}")
    async def decide_action(org_id: UUID, action_id: UUID, decision: Literal["approve", "reject"], request: Request,
                            actor: Admin) -> dict[str, Any]:
        s = state(request)
        return await actions.decide(s.db, s.http, str(org_id), str(action_id), actor, approve=decision == "approve",
                                    web_url=config.web_url)

    # --- members & invitations ---------------------------------------------------------------------

    @app.post("/orgs/{org_id}/invitations", status_code=201)
    async def invite(org_id: UUID, body: InviteIn, request: Request, actor: Admin) -> dict[str, Any]:
        row, token = await members.create_invitation(state(request).db, str(org_id), actor, body.email, body.role)
        return {**{k: v for k, v in row.items() if k != "token_hash"}, "url": f"{config.web_url}/invite/{token}"}

    @app.delete("/orgs/{org_id}/invitations/{invitation_id}", status_code=204)
    async def revoke_invitation(org_id: UUID, invitation_id: UUID, request: Request, actor: Admin) -> None:
        await members.revoke_invitation(state(request).db, str(org_id), str(invitation_id), actor)

    @app.post("/invitations/preview")
    async def preview_invitation(body: InviteTokenIn, request: Request, _: AnyUser) -> dict[str, Any]:
        return await members.preview_invitation(state(request).db, body.token)

    @app.post("/invitations/accept")
    async def accept_invitation(body: InviteTokenIn, request: Request, user: AnyUser) -> dict[str, Any]:
        return await members.accept_invitation(state(request).db, body.token, user)

    @app.patch("/orgs/{org_id}/members/{user_id}")
    async def set_member_role(org_id: UUID, user_id: UUID, body: RoleIn, request: Request, actor: Admin) -> dict[str, Any]:
        return await members.set_role(state(request).db, str(org_id), actor, str(user_id), body.role)

    @app.delete("/orgs/{org_id}/members/{user_id}", status_code=204)
    async def remove_member(org_id: UUID, user_id: UUID, request: Request, actor: Viewer) -> None:
        db = state(request).db
        role = await member_role(db, actor.id, str(org_id)) or "viewer"
        await members.remove_member(db, str(org_id), actor, role, str(user_id))

    # --- replays (re-run a past attempt with an edited spec or another model) ------------------------

    @app.post("/orgs/{org_id}/executions/{execution_id}/replays", status_code=201)
    async def replay_execution(org_id: UUID, execution_id: UUID, body: ReplayIn, request: Request, actor: Member) -> dict[str, Any]:
        s = state(request)
        row = await create_replay(s.db, str(org_id), str(execution_id), actor.id, actor.email,
                                  source_md=body.source_md, model=body.model)
        s.worker.submit_replay(row["id"])
        return row

    # --- automation: API tokens, triggers, webhooks -------------------------------------------------

    @app.post("/orgs/{org_id}/api-tokens", status_code=201)
    async def create_token(org_id: UUID, body: TokenIn, request: Request, actor: Admin) -> dict[str, Any]:
        row, token = await automation.create_token(state(request).db, str(org_id), actor, body.name)
        return {**{k: v for k, v in row.items() if k != "token_hash"}, "token": token}

    @app.delete("/orgs/{org_id}/api-tokens/{token_id}", status_code=204)
    async def revoke_token(org_id: UUID, token_id: UUID, request: Request, actor: Admin) -> None:
        await automation.revoke_token(state(request).db, str(org_id), str(token_id), actor)

    @app.post("/orgs/{org_id}/triggers", status_code=201)
    async def create_trigger(org_id: UUID, body: TriggerIn, request: Request, actor: Admin) -> dict[str, Any]:
        row, secret = await automation.create_trigger(
            state(request).db, str(org_id), actor, name=body.name, kind=body.kind, goal=body.goal,
            interval_minutes=body.interval_minutes, start_at=body.start_at, require_approval=body.require_approval)
        return {**{k: v for k, v in row.items() if k != "secret_hash"}, "secret": secret}

    @app.patch("/orgs/{org_id}/triggers/{trigger_id}")
    async def update_trigger(org_id: UUID, trigger_id: UUID, body: TriggerUpdateIn, request: Request,
                             actor: Admin) -> dict[str, Any]:
        row = await automation.update_trigger(state(request).db, str(org_id), str(trigger_id), actor, body.model_dump())
        return {k: v for k, v in row.items() if k != "secret_hash"}

    @app.delete("/orgs/{org_id}/triggers/{trigger_id}", status_code=204)
    async def delete_trigger(org_id: UUID, trigger_id: UUID, request: Request, actor: Admin) -> None:
        await automation.delete_trigger(state(request).db, str(org_id), str(trigger_id), actor)

    @app.post("/orgs/{org_id}/triggers/{trigger_id}/run")
    async def run_trigger(org_id: UUID, trigger_id: UUID, request: Request, actor: Member) -> dict[str, Any]:
        s = state(request)
        rows = await s.db.select("triggers", filters={"id": str(trigger_id), "org_id": str(org_id)})
        if not rows:
            raise NotFound("trigger not found")
        return await automation.fire(s.db, s.worker, rows[0], actor_label=f"{actor.email} (run now: {rows[0]['name']})",
                                     context={"source": "manual", "by": actor.email} if rows[0]["kind"] == "webhook" else None)

    @app.post("/hooks/{trigger_id}", status_code=202)
    async def webhook(trigger_id: UUID, request: Request, token: str | None = None,
                      authorization: Annotated[str | None, Header()] = None) -> dict[str, Any]:
        """Public endpoint for webhook triggers. Secret: `Authorization: Bearer whk_...` or `?token=whk_...`."""
        s = state(request)
        secret = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else token
        trigger = await automation.verify_webhook(s.db, str(trigger_id), secret)
        raw = await request.body()
        if len(raw) > 64 * 1024:
            raise HTTPException(413, "payload larger than 64 KB")
        try:
            payload: Any = json.loads(raw) if raw else None
        except ValueError:
            payload = raw.decode(errors="replace")
        wf = await automation.fire(s.db, s.worker, trigger, context={
            "source": "webhook", "trigger": trigger["name"], "received_at": now_iso(),
            "content_type": request.headers.get("content-type"), "payload": payload})
        return {"workflow_id": wf["id"], "status": wf["status"]}

    # --- workflows ---------------------------------------------------------------------------------

    @app.post("/orgs/{org_id}/workflows", status_code=201)
    async def create_workflow(org_id: UUID, body: GoalIn, request: Request, actor: Member) -> dict[str, Any]:
        return await state(request).worker.start_workflow(str(org_id), body.goal, actor_id=actor.id, actor_label=actor.email)

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
