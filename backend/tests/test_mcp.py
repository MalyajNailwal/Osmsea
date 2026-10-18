"""MCP integration tests against a real MCP server (Streamable HTTP) running in-process.

The server requires a bearer token, so credential injection is exercised end to end.
"""

import asyncio
import socket

import pytest
import uvicorn
from conftest import ALICE, auth, review, seed_org, tool_names, tool_results, wait_for
from mcp.server.mcpserver import MCPServer

from osmsea.llm import tool_reply
from osmsea.mcp_client import approvable, auth_headers, parse_tool_name, tool_name
from osmsea.orgs import Actor, create_agent
from osmsea.registry import load_registry

TOKEN = "test-mcp-token-123"
SERVER = "fixtures"
LOOKUP = tool_name(SERVER, "lookup_release")
DANGER = tool_name(SERVER, "delete_everything")


def build_mcp_app():
    mcp = MCPServer("osmsea-fixtures")

    @mcp.tool()
    def lookup_release(package: str) -> str:
        """Return the latest release of a Python package (fixture data)."""
        return f"{package} 1.2.3 was released on 2026-10-01."

    @mcp.tool()
    def delete_everything(confirm: bool) -> str:
        """A dangerous tool that must never run unless approved."""
        raise AssertionError("delete_everything must not be called")

    inner = mcp.streamable_http_app()

    async def require_token(scope, receive, send):
        if scope["type"] == "http" and dict(scope["headers"]).get(b"authorization") != f"Bearer {TOKEN}".encode():
            await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"unauthorized"})
            return
        await inner(scope, receive, send)

    return require_token


@pytest.fixture
async def mcp_url():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(build_mcp_app(), host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    yield f"http://127.0.0.1:{port}/mcp"
    server.should_exit = True
    await task


AGENT_MD = f"""---
id: release-checker
name: Release Checker
department: research
role: Release Analyst
mission: Report the latest release of a package using the approved release tool.
responsibilities:
  - Look up releases with the approved MCP tool
capabilities:
  - release_lookup
allowed_tools:
  - {LOOKUP}
  - {DANGER}
inputs:
  - A package name
outputs:
  - A short report
output_schema: report_v1
acceptance_criteria:
  - The report states the release version
verification:
  require_cited_evidence: true
  min_sources: 1
  independent_review: false
escalation:
  max_attempts: 1
  on_failure: Say which lookup failed.
---

Use the release lookup tool and submit a report citing it.
"""

PLAN = {"objective": "Find the latest httpx release", "acceptance_criteria": ["Version is reported"],
        "tasks": [{"key": "lookup", "title": "Look up the httpx release", "description": "Use the release tool.",
                   "agent_id": "release-checker", "depends_on": [], "expected_output": "Report",
                   "acceptance_criteria": ["States the version"]}]}


async def register(client, org_id, url, secret=TOKEN):
    body = {"name": "Fixture releases", "slug": SERVER, "url": url}
    if secret:
        body["secret"] = secret
    r = await client.post(f"/orgs/{org_id}/mcp-servers", json=body, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    return r.json()


def test_tool_name_helpers():
    assert parse_tool_name(LOOKUP) == (SERVER, "lookup_release")
    assert parse_tool_name("mcp__Bad__x") is None and parse_tool_name("web_search") is None
    assert not approvable(SERVER, "has.dot") and not approvable(SERVER, "x" * 60)
    assert auth_headers("Authorization", "abc") == {"Authorization": "Bearer abc"}
    assert auth_headers("X-Api-Key", "abc") == {"X-Api-Key": "abc"}
    assert auth_headers("Authorization", None) == {}


async def test_discovery_needs_the_credential_which_is_never_returned(db, client_factory, mcp_url):
    org = await seed_org(db)
    client = await client_factory([])

    server = await register(client, org["id"], mcp_url, secret=None)
    assert server["status"] == "error" and "401" in server["last_error"]

    r = await client.patch(f"/orgs/{org['id']}/mcp-servers/{server['id']}", json={"secret": TOKEN}, headers=auth(ALICE))
    assert r.status_code == 200 and TOKEN not in r.text and r.json()["secret_hint"] == TOKEN[-4:]
    r = await client.post(f"/orgs/{org['id']}/mcp-servers/{server['id']}/refresh", headers=auth(ALICE))
    body = r.json()
    assert body["status"] == "connected" and body["last_error"] is None
    assert {t["name"] for t in body["tool_catalog"]} == {"lookup_release", "delete_everything"}
    assert body["server_info"]["name"] == "osmsea-fixtures"
    assert TOKEN in db.secrets.values()
    assert TOKEN not in str(await db.select("audit_events", filters={"org_id": org["id"]}))


async def test_only_approved_tools_of_connected_servers_are_usable(db, client_factory, mcp_url):
    org = await seed_org(db)
    client = await client_factory([])
    server = await register(client, org["id"], mcp_url)
    url = f"/orgs/{org['id']}/mcp-servers/{server['id']}"

    r = await client.post(f"/orgs/{org['id']}/agents/validate", json={"source_md": AGENT_MD}, headers=auth(ALICE))
    assert r.json()["valid"] and r.json()["effective_tools"]["allowed"] == []  # nothing approved yet

    assert (await client.patch(url, json={"approved_tools": ["not_a_tool"]}, headers=auth(ALICE))).status_code == 422
    assert (await client.patch(url, json={"approved_tools": ["lookup_release"]}, headers=auth(ALICE))).status_code == 200
    r = await client.post(f"/orgs/{org['id']}/agents/validate", json={"source_md": AGENT_MD}, headers=auth(ALICE))
    tools = r.json()["effective_tools"]
    assert tools["allowed"] == [LOOKUP] and "not approved" in tools["unavailable"][DANGER]
    listed = (await client.get(f"/orgs/{org['id']}/tools", headers=auth(ALICE))).json()["mcp"]
    assert [t["name"] for t in listed] == [LOOKUP]

    await client.patch(url, json={"enabled": False}, headers=auth(ALICE))
    assert (await load_registry(db, org["id"])).mcp_tools == {}  # disabled server: no tools
    await client.patch(url, json={"enabled": True}, headers=auth(ALICE))
    assert LOOKUP in (await load_registry(db, org["id"])).mcp_tools
    assert (await client.delete(url, headers=auth(ALICE))).status_code == 204
    assert (await load_registry(db, org["id"])).mcp_tools == {}


async def test_workflow_calls_approved_mcp_tool_and_denies_the_rest(db, client_factory, mcp_url):
    org = await seed_org(db, settings={"require_plan_approval": False})
    await create_agent(db, org["id"], Actor(ALICE.id, ALICE.email), AGENT_MD)

    def route(messages, tools):
        if "submit_plan" in tool_names(tools):
            return tool_reply("submit_plan", PLAN)
        if "submit_review" in tool_names(tools):
            return review(messages)
        assert DANGER not in tool_names(tools)  # unapproved MCP tools are never exposed
        step = len(tool_results(messages))
        return [tool_reply(DANGER, {"confirm": True}),  # hallucinated call to an unapproved tool
                tool_reply(LOOKUP, {"pkg": 7}),  # wrong arguments: rejected before reaching the server
                tool_reply(LOOKUP, {"package": "httpx"}),
                tool_reply("submit_result", {
                    "title": "httpx release", "summary": "The latest httpx release is 1.2.3, released on 2026-10-01.",
                    "sections": [{"heading": "Release", "body": "httpx 1.2.3 (2026-10-01)."}], "key_points": ["1.2.3"],
                    "sources": [{"url": f"mcp:{SERVER}/lookup_release", "title": "Fixture releases"}]})][step]

    client = await client_factory(route)
    server = await register(client, org["id"], mcp_url)
    await client.patch(f"/orgs/{org['id']}/mcp-servers/{server['id']}", json={"approved_tools": ["lookup_release"]},
                       headers=auth(ALICE))

    r = await client.post(f"/orgs/{org['id']}/workflows", json={"goal": "Latest httpx release?"}, headers=auth(ALICE))
    wf_id = r.json()["id"]

    async def status(*want):
        rows = await db.select("workflows", filters={"id": wf_id})
        return rows[0] if rows[0]["status"] in want else None

    wf = await wait_for(lambda: status("awaiting_approval"), timeout=10)
    # The org turned off plan approval, but MCP tools require it by default.
    assert wf["requires_approval"] and wf["required_permissions"] == [{"tool": LOOKUP, "agents": ["release-checker"],
                                                                        "requires_approval": True}]
    await client.post(f"/orgs/{org['id']}/workflows/{wf_id}/approve", json={}, headers=auth(ALICE))
    wf = await wait_for(lambda: status("completed", "failed"), timeout=15)
    assert wf["status"] == "completed", wf["error"]

    steps = (await db.select("agent_executions", filters={"workflow_id": wf_id}))[0]["steps"]
    assert [(s["type"], s.get("tool"), s["ok"]) for s in steps] == [
        ("denied", DANGER, False), ("tool", LOOKUP, False), ("tool", LOOKUP, True), ("submit", None, True)]
    assert "1.2.3" in steps[2]["preview"] and "package" in steps[1]["preview"]
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    assert {c["name"]: c["passed"] for c in task["verification"]["checks"]}["cited_evidence"] is True
    audits = {(a["action"], a["outcome"]) for a in await db.select("audit_events", filters={"org_id": org["id"]})}
    assert ("mcp.call", "success") in audits and ("tool.denied", "denied") in audits


@pytest.mark.skipif(not __import__("os").environ.get("OSMSEA_LIVE_MCP"), reason="set OSMSEA_LIVE_MCP=1 to call the public DeepWiki MCP server")
async def test_live_public_mcp_server_discovery_approval_and_call(db):
    """Real public MCP server (https://mcp.deepwiki.com/mcp) under production URL rules (https, public only)."""
    org = await seed_org(db)
    from osmsea import orgs as orgs_module
    from osmsea.config import Config
    strict = Config(supabase_url="http://x", supabase_secret_key="x", supabase_publishable_key="x")  # private URLs not allowed
    row = await orgs_module.create_mcp_server(db, strict, org["id"], Actor(ALICE.id, ALICE.email), name="DeepWiki",
                                              slug="deepwiki", url="https://mcp.deepwiki.com/mcp", require_approval=False)
    assert row["status"] == "connected", row["last_error"]
    assert "read_wiki_structure" in {t["name"] for t in row["tool_catalog"]}
    await orgs_module.update_mcp_server(db, org["id"], row["id"], Actor(ALICE.id, ALICE.email), approved_tools=["read_wiki_structure"])
    reg = await load_registry(db, org["id"])
    from osmsea.mcp_client import call_tool
    ref = reg.mcp_tools["mcp__deepwiki__read_wiki_structure"]
    text = await call_tool(ref.url, {}, ref.tool, {"repoName": "encode/httpx"})
    assert "httpx" in text.lower()
