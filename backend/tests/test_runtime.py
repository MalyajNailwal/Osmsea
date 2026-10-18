"""Orchestration runtime tests: planning, approval, execution, verification, failure handling,
recovery and authorization. Model responses are scripted; storage is the in-memory store."""

import asyncio

import pytest
from conftest import ALICE, BOB, auth, review, seed_org, tool_names, tool_results, wait_for

from osmsea import scheduler
from osmsea.integrations import ProviderNotConfigured
from osmsea.llm import tool_reply
from osmsea.planner import compute_requirements, validate_plan
from osmsea.registry import load_registry
from osmsea.schemas import Plan
from osmsea.scheduler import Worker
from osmsea.store import StoreError

PLAN = {
    "objective": "Recommend a Python HTTP client and provide a starter module",
    "acceptance_criteria": ["Recommendation is backed by sources", "Starter module is valid Python"],
    "tasks": [
        {"key": "research", "title": "Compare Python HTTP clients", "description": "Compare httpx and requests for async support.",
         "agent_id": "researcher", "depends_on": [], "expected_output": "Cited comparison",
         "acceptance_criteria": ["Cites at least two sources"]},
        {"key": "build", "title": "Write a starter HTTP module", "description": "Write a small module using the recommended client.",
         "agent_id": "developer", "depends_on": ["research"], "expected_output": "One Python file",
         "acceptance_criteria": ["Module parses"]},
    ],
}
RESEARCH_ONLY = {**PLAN, "tasks": [PLAN["tasks"][0]]}

CODE = {"summary": "Adds a minimal async HTTP helper built on httpx.",
        "files": [{"path": "client.py", "language": "python", "action": "create",
                   "content": "import httpx\n\n\nasync def get_json(url: str) -> dict:\n    async with httpx.AsyncClient() as c:\n"
                              "        r = await c.get(url)\n        r.raise_for_status()\n        return r.json()\n"},
                  {"path": "test_client.py", "language": "python", "action": "create",
                   "content": "from client import get_json\n\n\ndef test_importable():\n    assert callable(get_json)\n"}],
        "test_plan": ["Call get_json against a mock server", "Assert HTTP errors raise"], "risks": [],
        "test_command": "python -m pytest -q"}


async def seed_memory(db, org_id):
    rows = await db.insert("memory_items", [
        {"org_id": org_id, "kind": "evidence", "title": "httpx supports async",
         "content": "httpx offers both sync and async clients.", "source": {"url": "https://www.python-httpx.org/async/"}, "tags": []},
        {"org_id": org_id, "kind": "evidence", "title": "requests is synchronous",
         "content": "requests does not support async natively.", "source": {"url": "https://requests.readthedocs.io/"}, "tags": []},
    ])
    return [r["id"] for r in rows]


def research_result(ids, extra_source=None):
    sources = [{"url": f"memory:{ids[0]}", "title": "httpx async"}, {"url": f"memory:{ids[1]}", "title": "requests"}]
    findings = [{"claim": "httpx supports async", "source_urls": [f"memory:{ids[0]}"]},
                {"claim": "requests is synchronous only", "source_urls": [f"memory:{ids[1]}"]}]
    if extra_source:
        sources.append({"url": extra_source, "title": "unretrieved"})
        findings.append({"claim": "an unsupported claim", "source_urls": [extra_source]})
    return {"summary": "httpx supports both sync and async usage, while requests is synchronous only.",
            "findings": findings, "sources": sources, "confidence": "medium",
            "evidence_notes": "Sources agree; no conflicting evidence.", "open_questions": []}


def router(ids, *, plan=PLAN, research=None, verdict="pass"):
    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", plan)
        if "submit_review" in names:
            return review(messages, verdict)
        system = messages[0]["content"]
        if "**Research Agent**" in system:
            if not tool_results(messages):
                return tool_reply("memory_search", {"query": "httpx requests async"})
            return tool_reply("submit_result", research or research_result(ids))
        if "**Software Developer**" in system:
            return tool_reply("submit_result", CODE)
        raise AssertionError("unexpected model call")
    return route


async def workflow(db, wf_id, *statuses):
    rows = await db.select("workflows", filters={"id": wf_id})
    return rows[0] if rows and rows[0]["status"] in statuses else None


async def submit(client, org_id, goal="Pick an HTTP client and write a starter module", user=ALICE):
    r = await client.post(f"/orgs/{org_id}/workflows", json={"goal": goal}, headers=auth(user))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def approve(client, org_id, wf_id, user=ALICE):
    return await client.post(f"/orgs/{org_id}/workflows/{wf_id}/approve", json={}, headers=auth(user))


# --- planning ------------------------------------------------------------------------------------


def _task(key, deps=(), agent="researcher"):
    return {"key": key, "title": key, "description": "d", "agent_id": agent, "depends_on": list(deps),
            "expected_output": "e", "acceptance_criteria": ["c"]}


def _plan(tasks):
    return Plan.model_validate({"objective": "o", "acceptance_criteria": ["c"], "tasks": tasks})


async def test_plan_validation_rejects_cycles_unknown_agents_and_bad_dependencies(db):
    org = await seed_org(db)
    reg = await load_registry(db, org["id"])
    assert validate_plan(_plan([_task("a"), _task("b", ["a"], "developer")]), reg) == []
    assert validate_plan(_plan([_task("a", ["b"]), _task("b", ["c"]), _task("c", ["a"])]), reg)[0].startswith("circular dependency")
    assert validate_plan(_plan([_task("a", ["a"])]), reg) == ["task 'a' depends on itself"]
    errors = validate_plan(_plan([_task("a", ["zzz"]), _task("a"), _task("b", agent="ghost")]), reg)
    assert "task 'a' depends on unknown task 'zzz'" in errors
    assert "duplicate task key 'a'" in errors
    assert "task 'b' is assigned to unknown or inactive agent 'ghost'" in errors
    assert "the limit is 8" in validate_plan(_plan([_task(f"t{i}") for i in range(9)]), reg)[0]

    await db.update("agents", {"status": "disabled"}, filters={"slug": "developer"})
    reg = await load_registry(db, org["id"])
    assert "inactive agent 'developer'" in validate_plan(_plan([_task("a", agent="developer")]), reg)[0]


async def test_approval_requirement_is_computed_from_policy_not_the_model(db):
    org = await seed_org(db, settings={"require_plan_approval": False})
    plan = Plan.model_validate(PLAN)
    permissions, requires = compute_requirements(plan, await load_registry(db, org["id"]))
    assert requires is False
    assert [p["tool"] for p in permissions] == ["fetch_url", "memory_search"]  # web_search: no integration

    await db.update("organizations", {"settings": {"require_plan_approval": False,
                                                   "tool_policy": {"fetch_url": {"requires_approval": True}}}},
                    filters={"id": org["id"]})
    permissions, requires = compute_requirements(plan, await load_registry(db, org["id"]))
    assert requires is True
    assert next(p for p in permissions if p["tool"] == "fetch_url")["requires_approval"] is True


async def test_invalid_plan_is_retried_with_feedback_then_rejected(db, client_factory):
    org = await seed_org(db)
    cyclic = {**PLAN, "tasks": [{**PLAN["tasks"][0], "depends_on": ["build"]}, PLAN["tasks"][1]]}
    client = await client_factory([tool_reply("submit_plan", cyclic), tool_reply("submit_plan", cyclic)])
    wf_id = await submit(client, org["id"])
    wf = await wait_for(lambda: workflow(db, wf_id, "plan_failed"))
    assert wf["plan_errors"][0].startswith("circular dependency")
    assert "The plan is invalid" in client.provider.calls[1]["messages"][-1]["content"]
    assert await db.select("tasks", filters={"workflow_id": wf_id}) == []


async def test_missing_llm_provider_is_reported_not_faked(db, client_factory):
    org = await seed_org(db)
    client = await client_factory([])

    async def no_provider(org_id, model=None, org_default_model=None):
        raise ProviderNotConfigured("No LLM provider is configured.")

    client.app.state.worker.provider_factory = no_provider
    wf_id = await submit(client, org["id"])
    wf = await wait_for(lambda: workflow(db, wf_id, "plan_failed"))
    assert wf["error"] == "No LLM provider is configured."


# --- end to end ----------------------------------------------------------------------------------


async def test_end_to_end_goal_plan_approve_execute_verify(db, client_factory):
    org = await seed_org(db)
    ids = await seed_memory(db, org["id"])
    client = await client_factory(router(ids))
    wf_id = await submit(client, org["id"])

    wf = await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    assert wf["objective"] == PLAN["objective"] and wf["requires_approval"] is True
    assert {p["tool"] for p in wf["required_permissions"]} == {"fetch_url", "memory_search"}
    assert {t["status"] for t in await db.select("tasks", filters={"workflow_id": wf_id})} == {"awaiting_approval"}
    assert (await db.select("approvals", filters={"workflow_id": wf_id}))[0]["status"] == "pending"
    await asyncio.sleep(0.1)
    assert await db.select("agent_executions", filters={"workflow_id": wf_id}) == []  # nothing runs unapproved

    assert (await approve(client, org["id"], wf_id)).status_code == 200
    wf = await wait_for(lambda: workflow(db, wf_id, "completed", "failed"))
    assert wf["status"] == "completed", wf["error"]

    tasks = {t["key"]: t for t in await db.select("tasks", filters={"workflow_id": wf_id})}
    assert all(t["status"] == "completed" and t["agent_version_id"] for t in tasks.values())
    research_checks = {c["name"]: c["passed"] for c in tasks["research"]["verification"]["checks"]}
    assert research_checks == {"schema": True, "cited_evidence": True, "min_sources": True, "independent_review": True}
    assert {c["name"] for c in tasks["build"]["verification"]["checks"]} == {"schema", "syntax", "tests", "independent_review"}
    assert (await db.select("approvals", filters={"workflow_id": wf_id}))[0]["status"] == "approved"

    calls = client.provider.calls
    research_call = next(c for c in calls if "**Research Agent**" in c["messages"][0]["content"])
    assert tool_names(research_call["tools"]) == {"fetch_url", "memory_search", "submit_result"}
    dev_call = next(c for c in calls if "**Software Developer**" in c["messages"][0]["content"])
    assert '<prerequisite task="research"' in dev_call["messages"][1]["content"]

    types = [e["type"] for e in await db.select("execution_events", filters={"workflow_id": wf_id})]
    for expected in ("plan_proposed", "workflow_approved", "task_started", "tool_call", "handoff", "task_completed",
                     "workflow_completed"):
        assert expected in types
    artifacts = {a["name"] for a in await db.select("artifacts", filters={"workflow_id": wf_id})}
    assert {"research-summary.md", "change-summary.md", "client.py"} <= artifacts
    memory = await db.select("memory_items", filters={"workflow_id": wf_id})
    assert {"summary", "finding", "decision"} <= {m["kind"] for m in memory}
    executions = await db.select("agent_executions", filters={"workflow_id": wf_id})
    assert len(executions) == 2 and all(e["status"] == "succeeded" for e in executions)
    assert wf["tokens_used"] > 0


async def test_auto_approved_plan_runs_immediately(db, client_factory):
    org = await seed_org(db, settings={"require_plan_approval": False})
    ids = await seed_memory(db, org["id"])
    client = await client_factory(router(ids, plan=RESEARCH_ONLY))
    wf_id = await submit(client, org["id"])
    wf = await wait_for(lambda: workflow(db, wf_id, "completed"))
    assert wf["requires_approval"] is False
    assert await db.select("approvals", filters={"workflow_id": wf_id}) == []


# --- enforcement ---------------------------------------------------------------------------------


async def test_unauthorized_tool_calls_are_denied_and_audited(db, client_factory):
    org = await seed_org(db)
    ids = await seed_memory(db, org["id"])

    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", RESEARCH_ONLY)
        if "submit_review" in names:
            return review(messages)
        step = len(tool_results(messages))
        return [tool_reply("shell_exec", {"cmd": "cat /etc/passwd"}),  # not a tool at all
                tool_reply("web_search", {"query": "x"}),  # in the spec, but no integration is configured
                tool_reply("memory_search", {"query": "httpx"}),
                tool_reply("submit_result", research_result(ids))][step]

    client = await client_factory(route)
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await wait_for(lambda: workflow(db, wf_id, "completed"))

    denied = [e for e in await db.select("execution_events", filters={"workflow_id": wf_id}) if e["type"] == "tool_denied"]
    assert {e["data"]["tool"] for e in denied} == {"shell_exec", "web_search"}
    audits = await db.select("audit_events", filters={"action": "tool.denied"})
    assert len(audits) == 2 and {a["outcome"] for a in audits} == {"denied"}
    steps = (await db.select("agent_executions", filters={"workflow_id": wf_id}))[0]["steps"]
    assert [s["type"] for s in steps] == ["denied", "denied", "tool", "submit"]


async def test_schema_invalid_output_is_returned_to_the_agent_for_correction(db, client_factory):
    org = await seed_org(db)
    ids = await seed_memory(db, org["id"])
    bad = research_result(ids)
    bad["findings"][0]["source_urls"] = ["https://not-in-sources.example/"]

    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", RESEARCH_ONLY)
        if "submit_review" in names:
            return review(messages)
        step = len(tool_results(messages))
        return [tool_reply("memory_search", {"query": "httpx"}), tool_reply("submit_result", bad),
                tool_reply("submit_result", research_result(ids))][step]

    client = await client_factory(route)
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await wait_for(lambda: workflow(db, wf_id, "completed"))
    steps = (await db.select("agent_executions", filters={"workflow_id": wf_id}))[0]["steps"]
    assert [(s["type"], s["ok"]) for s in steps] == [("tool", True), ("submit", False), ("submit", True)]
    assert "missing from sources" in steps[1]["preview"]


async def test_unverifiable_citations_fail_after_retries_and_block_dependents(db, client_factory):
    org = await seed_org(db)
    ids = await seed_memory(db, org["id"])
    client = await client_factory(router(ids, research=research_result(ids, extra_source="https://never-fetched.example/x")))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    wf = await wait_for(lambda: workflow(db, wf_id, "failed"))

    tasks = {t["key"]: t for t in await db.select("tasks", filters={"workflow_id": wf_id})}
    research = tasks["research"]
    assert research["status"] == "failed" and research["attempt"] == 2
    failed_check = next(c for c in research["verification"]["checks"] if not c["passed"])
    assert failed_check["name"] == "cited_evidence" and "never-fetched.example" in failed_check["detail"]
    assert tasks["build"]["status"] == "blocked" and tasks["build"]["error"] == "dependency 'research' failed"
    assert "research: failed" in wf["error"]

    executions = sorted(await db.select("agent_executions", filters={"task_id": research["id"]}), key=lambda e: e["attempt"])
    assert [(e["attempt"], e["status"]) for e in executions] == [(1, "failed"), (2, "failed")]
    second_attempt = [c for c in client.provider.calls if "**Research Agent**" in c["messages"][0]["content"]][-1]
    assert "Feedback from the previous attempt" in second_attempt["messages"][1]["content"]
    events = await db.select("execution_events", filters={"workflow_id": wf_id})
    failed_event = next(e for e in events if e["type"] == "task_failed")
    assert failed_event["data"]["escalation"].startswith("Report which claims")
    assert any(e["type"] == "task_retry_scheduled" for e in events)
    assert not any(c["name"] == "independent_review" for c in research["verification"]["checks"])  # skipped on failure


async def test_reviewer_rejection_prevents_completion(db, client_factory):
    org = await seed_org(db, settings={"max_attempts": 1})
    ids = await seed_memory(db, org["id"])
    client = await client_factory(router(ids, plan=RESEARCH_ONLY, verdict="fail"))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await wait_for(lambda: workflow(db, wf_id, "failed"))
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    review_check = next(c for c in task["verification"]["checks"] if c["name"] == "independent_review")
    assert review_check["passed"] is False and task["status"] == "failed"


async def test_task_timeout_is_retried_then_failed(db, client_factory, monkeypatch):
    real = scheduler.parse_settings
    monkeypatch.setattr(scheduler, "parse_settings",
                        lambda raw: real(raw).model_copy(update={"task_timeout_seconds": 0.2}))
    org = await seed_org(db)

    async def route(messages, tools):
        if "submit_plan" in tool_names(tools):
            return tool_reply("submit_plan", RESEARCH_ONLY)
        await asyncio.sleep(10)

    client = await client_factory(route)
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await wait_for(lambda: workflow(db, wf_id, "failed"))
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    assert task["error"] == "timed out after 0.2s" and task["attempt"] == 2
    statuses = {e["status"] for e in await db.select("agent_executions", filters={"task_id": task["id"]})}
    assert statuses == {"timed_out"}


async def test_cancellation_stops_a_running_task(db, client_factory):
    org = await seed_org(db)
    started = asyncio.Event()

    async def route(messages, tools):
        if "submit_plan" in tool_names(tools):
            return tool_reply("submit_plan", PLAN)
        started.set()
        await asyncio.sleep(30)

    client = await client_factory(route)
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await asyncio.wait_for(started.wait(), 5)

    r = await client.post(f"/orgs/{org['id']}/workflows/{wf_id}/cancel", headers=auth(ALICE))
    assert r.status_code == 200
    await wait_for(lambda: workflow(db, wf_id, "cancelled"))

    async def execution_cancelled():
        rows = await db.select("agent_executions", filters={"workflow_id": wf_id})
        return rows and rows[0]["status"] == "cancelled"

    await wait_for(execution_cancelled)
    assert {t["status"] for t in await db.select("tasks", filters={"workflow_id": wf_id})} == {"cancelled"}
    assert client.app.state.worker.running == {}
    assert (await client.post(f"/orgs/{org['id']}/workflows/{wf_id}/cancel", headers=auth(ALICE))).status_code == 409


async def test_token_budget_is_enforced(db, client_factory):
    org = await seed_org(db, settings={"workflow_token_budget": 1000})

    def route(messages, tools):
        if "submit_plan" in tool_names(tools):
            return tool_reply("submit_plan", RESEARCH_ONLY)
        return tool_reply("memory_search", {"query": "x"}, tokens=2000)

    client = await client_factory(route)
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await wait_for(lambda: workflow(db, wf_id, "failed"))
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    assert "token budget exceeded" in task["error"] and task["attempt"] == 1  # not retried


async def test_result_bookkeeping_survives_a_transient_store_failure(db, client_factory, monkeypatch):
    org = await seed_org(db)
    ids = await seed_memory(db, org["id"])
    real, calls = scheduler.persist_results, {"n": 0}

    async def flaky_persist(*args, **kwargs):
        calls["n"] += 1
        await real(*args, **kwargs)  # writes artifacts and memory...
        if calls["n"] == 1:
            raise StoreError("connection reset")  # ...then the network drops

    monkeypatch.setattr(scheduler, "persist_results", flaky_persist)
    client = await client_factory(router(ids, plan=RESEARCH_ONLY))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    await approve(client, org["id"], wf_id)
    await wait_for(lambda: workflow(db, wf_id, "completed"), timeout=10)

    async def retried():
        execs = await db.select("agent_executions", filters={"workflow_id": wf_id})
        return calls["n"] == 2 and execs and execs[0]["status"] == "succeeded"

    await wait_for(retried, timeout=10)  # the bookkeeping retry waits ~2s
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    assert task["status"] == "completed"
    assert [e["status"] for e in await db.select("agent_executions", filters={"task_id": task["id"]})] == ["succeeded"]
    assert [a["name"] for a in await db.select("artifacts", filters={"task_id": task["id"]})] == ["research-summary.md"]
    assert len(await db.select("memory_items", filters={"task_id": task["id"]})) == 3  # summary + 2 findings, no duplicates


# --- recovery & duplicate prevention -------------------------------------------------------------


async def _running_task(db, org, key, attempt, **extra):
    return (await db.insert("tasks", {
        "org_id": org["id"], "workflow_id": extra.pop("workflow_id"), "key": key, "title": key, "description": "",
        "agent_slug": "researcher", "depends_on": [], "expected_output": "", "acceptance_criteria": [],
        "attempt": attempt, "max_attempts": 2, **extra}))[0]


async def test_restart_recovery_requeues_or_fails_expired_tasks(db):
    org = await seed_org(db)
    wf = (await db.insert("workflows", {"org_id": org["id"], "goal": "recover", "status": "running",
                                        "token_budget": 1000, "tokens_used": 0, "required_permissions": []}))[0]
    expired = {"status": "running", "lease_owner": "dead-worker", "lease_expires_at": "2000-01-01T00:00:00+00:00",
               "workflow_id": wf["id"]}
    a = await _running_task(db, org, "a", 1, **expired)
    b = await _running_task(db, org, "b", 2, **expired)
    for t in (a, b):
        await db.insert("agent_executions", {"org_id": org["id"], "workflow_id": wf["id"], "task_id": t["id"],
                                             "attempt": t["attempt"], "status": "running"})
    stale = (await db.insert("workflows", {"org_id": org["id"], "goal": "stale plan", "status": "planning",
                                           "updated_at": "2000-01-01T00:00:00+00:00"}))[0]

    worker = Worker(db, provider_factory=None, secrets_factory=None, http=None)
    assert await worker.recover(startup=True) == 2
    a, b = [(await db.select("tasks", filters={"id": t["id"]}))[0] for t in (a, b)]
    assert a["status"] == "queued" and "restarting the task from the beginning" in a["error"]
    assert b["status"] == "failed" and "no attempts left" in b["error"]
    assert {e["status"] for e in await db.select("agent_executions", filters={"workflow_id": wf["id"]})} == {"abandoned"}
    assert (await db.select("workflows", filters={"id": stale["id"]}))[0]["status"] == "plan_failed"
    assert await worker.recover() == 0  # idempotent


async def test_concurrent_workers_claim_a_task_exactly_once(db):
    org = await seed_org(db)
    version = (await db.select("agent_versions", filters={}))[0]
    wf = (await db.insert("workflows", {"org_id": org["id"], "goal": "race", "status": "running", "token_budget": 1000,
                                        "tokens_used": 0, "required_permissions": []}))[0]
    await _running_task(db, org, "a", 0, status="queued", workflow_id=wf["id"], agent_version_id=version["id"])
    hang = asyncio.Event()

    async def blocking_provider(*args, **kwargs):
        await hang.wait()

    workers = [Worker(db, provider_factory=blocking_provider, secrets_factory=None, http=None, worker_id=f"w{i}")
               for i in range(3)]
    await asyncio.gather(*(w.tick() for w in workers))
    assert sum(len(w.running) for w in workers) == 1
    await asyncio.sleep(0.05)
    assert len(await db.select("agent_executions", filters={"workflow_id": wf["id"]})) == 1
    for w in workers:
        await w.stop()


# --- API authorization & configuration -----------------------------------------------------------


async def test_tenant_isolation_and_roles(db, client_factory):
    org_a = await seed_org(db, ALICE, "A")
    org_b = await seed_org(db, BOB, "B")
    client = await client_factory(lambda m, t: tool_reply("submit_plan", PLAN))

    # Another tenant gets 404, so it cannot even learn that the organization exists.
    assert (await client.post(f"/orgs/{org_a['id']}/workflows", json={"goal": "steal data"}, headers=auth(BOB))).status_code == 404
    assert (await client.put(f"/orgs/{org_a['id']}/integrations/tavily", json={"secret": "tvly-12345678"},
                             headers=auth(BOB))).status_code == 404
    assert (await client.post(f"/orgs/{org_a['id']}/workflows", json={"goal": "no token"})).status_code == 401

    wf_id = await submit(client, org_a["id"])
    await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))
    # Org A's workflow id under org B's path cannot be approved by org B's owner.
    assert (await approve(client, org_b["id"], wf_id, user=BOB)).status_code == 409
    assert await workflow(db, wf_id, "awaiting_approval")

    await db.insert("organization_members", {"org_id": org_a["id"], "user_id": BOB.id, "role": "viewer", "email": BOB.email})
    assert (await approve(client, org_a["id"], wf_id, user=BOB)).status_code == 403
    denied = await db.select("audit_events", filters={"action": "authorization.denied"})
    assert denied and denied[0]["actor_label"] == BOB.email
    assert (await approve(client, org_a["id"], wf_id)).status_code == 200


async def test_agent_validation_and_versioning(db, client_factory):
    org = await seed_org(db)
    client = await client_factory([])
    agent = (await db.select("agents", filters={"slug": "researcher"}))[0]
    source = (await db.select("agent_versions", filters={"agent_id": agent["id"]}))[0]["source_md"]
    url = f"/orgs/{org['id']}/agents"

    bad = source.replace("- memory_search\n", "- shell_exec\n")
    r = await client.post(f"{url}/validate", json={"source_md": bad}, headers=auth(ALICE))
    assert r.json()["valid"] is False and "unknown tools ['shell_exec']" in r.json()["errors"][0]
    r = await client.put(f"{url}/{agent['id']}", json={"source_md": bad}, headers=auth(ALICE))
    assert r.status_code == 422 and "unknown tools" in r.json()["errors"][0]

    good = source.replace("max_steps: 12", "max_steps: 8")
    r = await client.post(f"{url}/validate", json={"source_md": good}, headers=auth(ALICE))
    body = r.json()
    assert body["valid"] and body["effective_tools"]["allowed"] == ["fetch_url", "memory_search"]
    assert "integration" in body["effective_tools"]["unavailable"]["web_search"]

    r = await client.put(f"{url}/{agent['id']}", json={"source_md": good, "note": "tighter limits"}, headers=auth(ALICE))
    assert r.status_code == 200 and r.json()["version"] == 2
    versions = await db.select("agent_versions", filters={"agent_id": agent["id"]})
    assert sorted(v["version"] for v in versions) == [1, 2]
    reg = await load_registry(db, org["id"])
    assert reg.agents["researcher"].version == 2 and reg.agents["researcher"].spec.limits.max_steps == 8

    r = await client.put(f"{url}/{agent['id']}", json={"source_md": good.replace("id: researcher", "id: researcher-2")},
                         headers=auth(ALICE))
    assert r.status_code == 422 and "stable" in r.json()["errors"][0]
    assert any(a["action"] == "agent.update" for a in await db.select("audit_events", filters={"org_id": org["id"]}))


async def test_integration_credentials_are_stored_but_never_returned(db, client_factory):
    org = await seed_org(db)
    client = await client_factory([])
    secret = "tvly-super-secret-123"
    r = await client.put(f"/orgs/{org['id']}/integrations/tavily", json={"secret": secret}, headers=auth(ALICE))
    assert r.status_code == 200 and secret not in r.text and r.json()["secret_hint"] == "-123"
    assert secret in db.secrets.values()
    assert secret not in str(await db.select("audit_events", filters={"org_id": org["id"]}))
    reg = await load_registry(db, org["id"])
    assert "web_search" in reg.effective_tools(reg.agents["researcher"].spec)[0]

    assert (await client.put(f"/orgs/{org['id']}/integrations/slack", json={"secret": "x" * 10},
                             headers=auth(ALICE))).status_code == 422
    assert (await client.put(f"/orgs/{org['id']}/integrations/tavily", json={"config": {"evil": "1"}},
                             headers=auth(ALICE))).status_code == 422
    assert (await client.delete(f"/orgs/{org['id']}/integrations/tavily", headers=auth(ALICE))).status_code == 204
    assert await db.select("integrations", filters={"org_id": org["id"]}) == []


@pytest.mark.parametrize("template", ["default"])
async def test_create_organization_from_template_via_api(db, client_factory, template):
    client = await client_factory([])
    r = await client.post("/orgs", json={"template": template, "name": "My Org"}, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    org_id = r.json()["id"]
    members = await db.select("organization_members", filters={"org_id": org_id})
    assert members[0]["role"] == "owner" and members[0]["email"] == ALICE.email
    reg = await load_registry(db, org_id)
    assert set(reg.agents) == {"researcher", "developer"} and reg.invalid == {}
