"""Self-improvement loop: eval cases recorded from real runs, replayed evaluations, the activation gate,
failure analysis, policy-checked revision proposals and cost-aware model routing."""

from conftest import ALICE, auth, review, seed_org, tool_names, tool_results, wait_for
from test_runtime import RESEARCH_ONLY, research_result, seed_memory, submit, workflow

from osmsea.evals import choose_model
from osmsea.llm import tool_reply
from osmsea.registry import load_registry


def make_router(ids, state):
    """Scripted model whose reviewer verdict and proposal can be changed mid-test via `state`."""
    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", RESEARCH_ONLY)
        if "submit_review" in names:
            return review(messages, state.get("verdict", "pass"))
        if "submit_spec_revision" in names:
            return tool_reply("submit_spec_revision", state["revision"])
        if not tool_results(messages):
            return tool_reply("memory_search", {"query": "httpx requests async"})
        return tool_reply("submit_result", research_result(ids))
    return route


async def researcher(db):
    agent = (await db.select("agents", filters={"slug": "researcher"}))[0]
    version = (await db.select("agent_versions", filters={"id": agent["active_version_id"]}))[0]
    return agent, version


async def run_workflow(client, db, org_id, status="completed"):
    wf_id = await submit(client, org_id)
    await wait_for(lambda: workflow(db, wf_id, status))
    return wf_id


async def eval_run(client, db, org_id, agent_id, **body):
    r = await client.post(f"/orgs/{org_id}/agents/{agent_id}/evals", json=body, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    run_id = r.json()[0]["id"]
    return await wait_for(lambda: _finished(db, run_id))


async def _finished(db, run_id):
    rows = await db.select("eval_runs", filters={"id": run_id})
    return rows[0] if rows[0]["status"] in ("completed", "failed") else None


async def test_verified_runs_become_replayable_cases_and_gate_activation(db, client_factory):
    org = await seed_org(db, settings={"require_plan_approval": False})
    ids = await seed_memory(db, org["id"])
    state = {"verdict": "pass"}
    client = await client_factory(make_router(ids, state))
    wf_id = await run_workflow(client, db, org["id"])

    execution = (await db.select("agent_executions", filters={"workflow_id": wf_id}))[0]
    assert [r["tool"] for r in execution["tool_recordings"]] == ["memory_search"]
    assert execution["routing"]["reason"] == "organization default model"
    agent, version = await researcher(db)
    cases = await db.select("eval_cases", filters={"agent_id": agent["id"]})
    assert len(cases) == 1 and cases[0]["baseline"]["passed"] is True
    assert cases[0]["source_execution_id"] == execution["id"]

    # With the gate on, an edited spec cannot go live until it has been evaluated.
    await db.update("organizations", {"settings": {"require_plan_approval": False, "require_eval_for_activation": True}},
                    filters={"id": org["id"]})
    edited = version["source_md"] + "\n7. Prefer primary sources over blog posts.\n"
    put = lambda: client.put(f"/orgs/{org['id']}/agents/{agent['id']}", json={"source_md": edited}, headers=auth(ALICE))  # noqa: E731
    r = await put()
    assert r.status_code == 422 and "requires a completed evaluation" in r.json()["errors"][0]

    # The evaluation answers tool calls from the recording: with shared memory now empty, a live
    # memory_search would find nothing and the citation check would fail.
    await db.delete("memory_items", filters={"org_id": org["id"]})
    run = await eval_run(client, db, org["id"], agent["id"], source_md=edited)
    assert run["status"] == "completed", run.get("error")
    assert run["summary"]["passed"] == 1 and run["summary"]["replayed_calls"] == 1 and run["summary"]["live_calls"] == 0
    assert len(await db.select("agent_executions", filters={"agent_id": agent["id"]})) == 1  # evals touch no real runs

    r = await put()
    assert r.status_code == 200, r.text
    audit = (await db.select("audit_events", filters={"action": "agent.update"}))[-1]
    assert audit["details"]["eval_gate"]["eval_run_id"] == run["id"]

    # A spec that regresses below the recorded baseline is blocked.
    state["verdict"] = "fail"
    worse = edited + "\n8. Keep answers short.\n"
    run = await eval_run(client, db, org["id"], agent["id"], source_md=worse)
    assert run["summary"]["passed"] == 0 and run["summary"]["baseline_passed"] == 1
    r = await client.put(f"/orgs/{org['id']}/agents/{agent['id']}", json={"source_md": worse}, headers=auth(ALICE))
    assert r.status_code == 422 and "activation blocked" in r.json()["errors"][0]


async def test_failures_drive_a_policy_checked_proposal_that_is_evaluated_and_accepted(db, client_factory):
    org = await seed_org(db, settings={"require_plan_approval": False})
    ids = await seed_memory(db, org["id"])
    state = {"verdict": "fail"}
    client = await client_factory(make_router(ids, state))
    await run_workflow(client, db, org["id"], status="failed")
    agent, version = await researcher(db)
    base = f"/orgs/{org['id']}"

    r = await client.get(f"{base}/agents/{agent['id']}/insights", headers=auth(ALICE))
    insights = r.json()
    assert insights["failures"]["failed"] == 2 and insights["failures"]["failed_checks"] == {"independent_review": 2}
    assert insights["failures"]["unmet_criteria"] and insights["eval_cases"] == 2

    # Proposals may never widen permissions or switch verification off.
    escalated = version["source_md"].replace("- memory_search\n", "- memory_search\n- mcp__deepwiki__ask_question\n") \
        .replace("independent_review: true", "independent_review: false")
    state["revision"] = {"rationale": "Reviewer keeps rejecting; loosen things.", "changes": ["more tools"], "source_md": escalated}
    r = await client.post(f"{base}/agents/{agent['id']}/proposals", headers=auth(ALICE))
    assert r.status_code == 422
    errors = " ".join(r.json()["errors"])
    assert "independent_review must stay enabled" in errors and "cannot add tools" in errors
    assert await db.select("agent_proposals") == []

    improved = version["source_md"] + "\n7. Answer the exact question first, then list supporting findings.\n"
    state["revision"] = {"rationale": "Reviewer flagged that the summary did not answer the question.",
                         "changes": ["Add an explicit answer-first step"], "source_md": improved}
    state["verdict"] = "pass"
    r = await client.post(f"{base}/agents/{agent['id']}/proposals", headers=auth(ALICE))
    assert r.status_code == 201, r.text
    proposal = r.json()
    assert proposal["status"] == "proposed" and proposal["failure_report"]["failed"] == 2
    run = await wait_for(lambda: _finished(db, proposal["eval_run_id"]))
    assert run["kind"] == "proposal" and run["summary"]["passed"] == 2 and run["summary"]["baseline_passed"] == 0

    r = await client.post(f"{base}/proposals/{proposal['id']}/accept", headers=auth(ALICE))
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    agent_after, version_after = await researcher(db)
    assert version_after["version"] == version["version"] + 1 and version_after["source_md"] == improved
    assert version_after["note"].startswith("Accepted improvement proposal")
    r = await client.post(f"{base}/proposals/{proposal['id']}/reject", headers=auth(ALICE))
    assert r.status_code == 409


async def test_routing_picks_the_cheapest_model_that_meets_the_quality_bar(db):
    org = await seed_org(db, settings={"model_routing": "auto", "routing_models": ["big", "small", "tiny"],
                                       "routing_min_runs": 2, "routing_target_pass_rate": 0.5})
    agent, _ = await researcher(db)
    reg = await load_registry(db, org["id"])
    spec = reg.agents["researcher"].spec

    model, reason = await choose_model(db, reg, spec, agent["id"])
    assert model is None and "no candidate model" in reason

    def results(model, passed, cost, n=2):
        return [{"org_id": org["id"], "eval_run_id": "r", "agent_id": agent["id"], "model": model, "passed": passed,
                 "cost_usd": cost, "tokens": 100} for _ in range(n)]
    await db.insert("eval_results", results("big", True, 0.02) + results("small", True, 0.01) + results("tiny", False, 0.0001)
                    + results("unlisted", True, 0.000001))
    model, reason = await choose_model(db, reg, spec, agent["id"])
    assert model == "small" and "$0.0100 per verified task" in reason  # tiny fails the bar; unlisted is not a candidate

    pinned = spec.model_copy(update={"model": "big"})
    assert await choose_model(db, reg, pinned, agent["id"]) == ("big", "pinned in the agent spec")
