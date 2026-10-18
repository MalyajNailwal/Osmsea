"""Live tests against the real Supabase project: persistence, RPCs, Vault and RLS tenant isolation.

Runs only when explicitly enabled:  OSMSEA_LIVE=1 uv run pytest tests/test_live_supabase.py
Reads backend/.env. Creates two throwaway users and organizations and deletes them afterwards.
The model is scripted (no LLM key needed); everything else is real.
"""

import os
import secrets
from pathlib import Path

import httpx
import pytest
from conftest import review, tool_names, tool_results, wait_for

from osmsea.api import create_app
from osmsea.config import Config
from osmsea.llm import ScriptedProvider, tool_reply
from osmsea.store import SupabaseStore

pytestmark = pytest.mark.skipif(os.environ.get("OSMSEA_LIVE") != "1", reason="set OSMSEA_LIVE=1 to run live Supabase tests")

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def _env() -> dict[str, str]:
    out = {}
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


PLAN = {
    "objective": "Summarize what the team knows about HTTP clients",
    "acceptance_criteria": ["Summary cites shared memory"],
    "tasks": [{"key": "research", "title": "Summarize HTTP client knowledge",
               "description": "Use shared memory to compare httpx and requests.", "agent_id": "researcher",
               "depends_on": [], "expected_output": "Cited summary", "acceptance_criteria": ["Cites two sources"]}],
}


@pytest.fixture
async def live():
    env = _env()
    url, secret, publishable = env["SUPABASE_URL"], env["SUPABASE_SECRET_KEY"], env["SUPABASE_PUBLISHABLE_KEY"]
    admin = httpx.AsyncClient(base_url=url, headers={"apikey": secret}, timeout=30)
    users = []
    for name in ("alice", "bob"):
        email, password = f"osmsea-test-{name}-{secrets.token_hex(4)}@example.com", secrets.token_urlsafe(18)
        r = await admin.post("/auth/v1/admin/users", json={"email": email, "password": password, "email_confirm": True})
        assert r.status_code == 200, r.text
        uid = r.json()["id"]
        r = await admin.post("/auth/v1/token?grant_type=password", headers={"apikey": publishable},
                             json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        users.append({"id": uid, "email": email, "token": r.json()["access_token"]})
    store = SupabaseStore(url, secret)
    try:
        yield {"url": url, "publishable": publishable, "store": store, "alice": users[0], "bob": users[1], "env": env}
    finally:
        for u in users:
            for org in await store.select("organizations", filters={"created_by": u["id"]}):
                await store.delete("organizations", filters={"id": org["id"]})
            await admin.delete(f"/auth/v1/admin/users/{u['id']}")
        await store.close()
        await admin.aclose()


def as_user(live, user) -> httpx.AsyncClient:
    """PostgREST client acting as the user (RLS applies)."""
    return httpx.AsyncClient(base_url=f"{live['url']}/rest/v1", timeout=20,
                             headers={"apikey": live["publishable"], "Authorization": f"Bearer {user['token']}"})


async def test_live_end_to_end_persistence_and_tenant_isolation(live):
    store, alice, bob = live["store"], live["alice"], live["bob"]
    memory_ids: list[str] = []

    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", PLAN)
        if "submit_review" in names:
            return review(messages)
        if not tool_results(messages):
            return tool_reply("memory_search", {"query": "httpx requests"})
        return tool_reply("submit_result", {
            "summary": "httpx supports async and sync usage; requests is synchronous only, per shared memory.",
            "findings": [{"claim": "httpx supports async", "source_urls": [f"memory:{memory_ids[0]}"]},
                         {"claim": "requests is synchronous", "source_urls": [f"memory:{memory_ids[1]}"]}],
            "sources": [{"url": f"memory:{memory_ids[0]}", "title": "httpx"}, {"url": f"memory:{memory_ids[1]}", "title": "requests"}],
            "confidence": "medium", "evidence_notes": "Both notes agree; no conflicts.", "open_questions": []})

    provider = ScriptedProvider(route)

    async def provider_factory(org_id, model=None, org_default_model=None):
        return provider

    async def no_secrets(org_id):
        return {}

    env = live["env"]
    config = Config(supabase_url=env["SUPABASE_URL"], supabase_secret_key=env["SUPABASE_SECRET_KEY"],
                    supabase_publishable_key=env["SUPABASE_PUBLISHABLE_KEY"], poll_interval=0.3)
    app = create_app(config, provider_factory=provider_factory, secrets_factory=no_secrets)
    async with app.router.lifespan_context(app):
        app.state.worker.retry_base_seconds = 0.1
        api = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=30)
        h_alice = {"Authorization": f"Bearer {alice['token']}"}
        h_bob = {"Authorization": f"Bearer {bob['token']}"}

        # Real Supabase Auth validates the sessions; orgs are created through the API.
        r = await api.post("/orgs", json={"template": "default", "name": "Live Alice Org"}, headers=h_alice)
        assert r.status_code == 201, r.text
        org_a = r.json()["id"]
        r = await api.post("/orgs", json={"template": "default", "name": "Live Bob Org"}, headers=h_bob)
        org_b = r.json()["id"]
        assert (await api.get("/catalog", headers={"Authorization": "Bearer not-a-token"})).status_code == 401

        for title, content in (("httpx supports async", "httpx offers sync and async clients."),
                               ("requests is synchronous", "requests has no native async support.")):
            r = await api.post(f"/orgs/{org_a}/memory", json={"kind": "note", "title": title, "content": content}, headers=h_alice)
            assert r.status_code == 201, r.text
            memory_ids.append(r.json()["id"])

        # Full workflow against real tables, RPCs (add_workflow_usage, search_memory) and the scheduler.
        r = await api.post(f"/orgs/{org_a}/workflows", json={"goal": "Summarize what we know about HTTP clients"}, headers=h_alice)
        wf_id = r.json()["id"]

        async def wf_status(*statuses):
            rows = await store.select("workflows", filters={"id": wf_id})
            return rows[0] if rows[0]["status"] in statuses else None

        await wait_for(lambda: wf_status("awaiting_approval"), timeout=30, interval=0.3)
        assert (await api.post(f"/orgs/{org_a}/workflows/{wf_id}/approve", json={}, headers=h_bob)).status_code == 404
        assert (await api.post(f"/orgs/{org_a}/workflows/{wf_id}/approve", json={}, headers=h_alice)).status_code == 200
        wf = await wait_for(lambda: wf_status("completed", "failed"), timeout=60, interval=0.3)
        assert wf["status"] == "completed", wf["error"]
        assert wf["tokens_used"] > 0
        task = (await store.select("tasks", filters={"workflow_id": wf_id}))[0]
        assert task["verification"]["passed"] and task["output"]["confidence"] == "medium"
        assert (await store.select("agent_executions", filters={"task_id": task["id"]}))[0]["status"] == "succeeded"
        assert await store.select("artifacts", filters={"task_id": task["id"]})

        # Vault: credential stored server-side, never visible to members.
        r = await api.put(f"/orgs/{org_a}/integrations/tavily", json={"secret": "tvly-live-test-secret-0000"}, headers=h_alice)
        assert r.status_code == 200 and "tvly-live-test-secret" not in r.text
        integration_id = r.json()["id"]
        assert await store.rpc("get_integration_secret", {"p_integration": integration_id}) == "tvly-live-test-secret-0000"

        async with as_user(live, alice) as a, as_user(live, bob) as b:
            # Members read their own org's rows through RLS ...
            assert len((await a.get("/workflows", params={"id": f"eq.{wf_id}"})).json()) == 1
            assert len((await a.get("/tasks", params={"workflow_id": f"eq.{wf_id}"})).json()) == 1
            assert (await a.get("/integration_secrets")).status_code in (401, 403)
            r = await a.post("/rpc/get_integration_secret", json={"p_integration": integration_id})
            assert r.status_code in (401, 403)
            # ... but never another tenant's rows.
            assert (await b.get("/workflows", params={"id": f"eq.{wf_id}"})).json() == []
            assert (await b.get("/execution_events", params={"workflow_id": f"eq.{wf_id}"})).json() == []
            assert [o["id"] for o in (await b.get("/organizations")).json()] == [org_b]
            assert (await b.post("/rpc/search_memory", json={"p_org": org_a, "p_query": ""})).json() == []
            assert len((await a.post("/rpc/search_memory", json={"p_org": org_a, "p_query": "httpx"})).json()) >= 1
            # Clients cannot write directly, even to their own organization.
            r = await a.patch("/tasks", params={"id": f"eq.{task['id']}"}, json={"status": "completed"})
            assert r.status_code in (401, 403)
            r = await a.post("/organization_members", json={"org_id": org_b, "user_id": alice["id"], "role": "owner"})
            assert r.status_code in (401, 403)

        assert (await api.delete(f"/orgs/{org_a}/integrations/tavily", headers=h_alice)).status_code == 204
        await api.aclose()
