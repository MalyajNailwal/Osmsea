"""Plan forecasts from verified history, replays of past attempts, and member invitations."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import ALICE, BOB, CAROL, auth, seed_org, wait_for
from test_runtime import PLAN, RESEARCH_ONLY, router, seed_memory, submit, workflow

from osmsea.auth import member_role


async def researcher_id(db, org_id):
    return (await db.select("agents", filters={"org_id": org_id, "slug": "researcher"}))[0]["id"]


async def test_forecast_uses_verified_history_and_leaves_unknowns_unknown(db, client_factory):
    org = await seed_org(db)
    agent_id = await researcher_id(db, org["id"])
    start = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    await db.insert("agent_executions", [{  # history: researcher on the model it will use, 3 of 4 verified, $0.01, 60 s each
        "org_id": org["id"], "agent_id": agent_id, "task_id": f"history-{i}", "attempt": 1, "model": "scripted-model",
        "cost_usd": 0.01, "input_tokens": 900,
        "output_tokens": 100, "verification": {"passed": i < 3, "checks": []}, "started_at": start.isoformat(),
        "finished_at": (start + timedelta(seconds=60)).isoformat(), "status": "succeeded" if i < 3 else "failed",
    } for i in range(4)])
    client = await client_factory(router(await seed_memory(db, org["id"]), plan=PLAN))
    wf_id = await submit(client, org["id"])
    wf = await wait_for(lambda: workflow(db, wf_id, "awaiting_approval"))

    fc = wf["forecast"]
    research = next(t for t in fc["tasks"] if t["key"] == "research")
    assert research["model"] == "scripted-model" and research["runs"] == 4 and research["pass_rate"] == 0.75
    assert research["success"] == pytest.approx(1 - 0.25 ** 2)  # two attempts
    assert research["cost_usd"] == pytest.approx(0.01 * 1.25) and research["duration_s"] == pytest.approx(75)
    build = next(t for t in fc["tasks"] if t["key"] == "build")
    assert build["runs"] == 0 and build["success"] is None and build["cost_usd"] is None  # no history: no number
    assert fc["success"] is None and fc["cost_usd"] is None and fc["known_tasks"] == 1 and fc["total_tasks"] == 2


async def test_replay_reruns_an_attempt_with_an_edited_spec_against_recorded_tools(db, client_factory):
    org = await seed_org(db, settings={"require_plan_approval": False})
    ids = await seed_memory(db, org["id"])
    client = await client_factory(router(ids, plan=RESEARCH_ONLY))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "completed"))
    execution = (await db.select("agent_executions", filters={"workflow_id": wf_id}))[0]
    version = (await db.select("agent_versions", filters={"id": execution["agent_version_id"]}))[0]

    await db.delete("memory_items", filters={"org_id": org["id"]})  # a live memory_search would now find nothing
    edited = version["source_md"] + "\n7. Lead with a one-sentence answer.\n"
    r = await client.post(f"/orgs/{org['id']}/executions/{execution['id']}/replays", json={"source_md": edited, "model": "other-model"},
                          headers=auth(ALICE))
    assert r.status_code == 201, r.text
    replay = await wait_for(lambda: _done(db, r.json()["id"]))
    assert replay["status"] == "completed" and replay["passed"] is True
    assert replay["replayed"] == 1 and replay["live_calls"] == 0 and "httpx" in replay["output"]["summary"]
    assert len(await db.select("agent_executions", filters={"workflow_id": wf_id})) == 1  # no real execution created

    bad = version["source_md"].replace("id: researcher", "id: impostor")
    r = await client.post(f"/orgs/{org['id']}/executions/{execution['id']}/replays", json={"source_md": bad}, headers=auth(ALICE))
    assert r.status_code == 422
    r = await client.post(f"/orgs/{org['id']}/executions/{execution['id']}/replays", json={}, headers=auth(BOB))
    assert r.status_code == 404  # another tenant cannot even see the organization


async def _done(db, replay_id):
    rows = await db.select("replays", filters={"id": replay_id})
    return rows[0] if rows[0]["status"] in ("completed", "failed") else None


async def test_invitations_work_once_for_the_invited_confirmed_email(db, client_factory):
    org = await seed_org(db)
    client = await client_factory([])
    base = f"/orgs/{org['id']}"

    r = await client.post(f"{base}/invitations", json={"email": " Carol@Example.com ", "role": "member"}, headers=auth(ALICE))
    assert r.status_code == 201 and r.json()["email"] == "carol@example.com" and "token_hash" not in r.json()
    token = r.json()["url"].rsplit("/", 1)[1]
    assert (await client.post(f"{base}/invitations", json={"email": "alice@example.com"}, headers=auth(ALICE))).status_code == 409

    preview = await client.post("/invitations/preview", json={"token": token}, headers=auth(BOB))
    assert preview.json() == {**preview.json(), "organization": "Acme", "role": "member", "status": "pending"}
    r = await client.post("/invitations/accept", json={"token": token}, headers=auth(BOB))
    assert r.status_code == 409 and "carol@example.com" in r.json()["detail"]  # the link is bound to the invited email
    r = await client.post("/invitations/accept", json={"token": token}, headers={"Authorization": "Bearer token-carol-unconfirmed"})
    assert r.status_code == 409 and "confirm your email" in r.json()["detail"]
    r = await client.post("/invitations/accept", json={"token": token}, headers=auth(CAROL))
    assert r.status_code == 200 and r.json()["role"] == "member"
    assert await member_role(db, CAROL.id, org["id"]) == "member"
    assert (await client.post("/invitations/accept", json={"token": token}, headers=auth(CAROL))).status_code == 409  # single use

    # Roles: the owner is untouchable, nobody edits their own role, members cannot manage others.
    assert (await client.patch(f"{base}/members/{CAROL.id}", json={"role": "admin"}, headers=auth(ALICE))).status_code == 200
    assert (await client.patch(f"{base}/members/{ALICE.id}", json={"role": "viewer"}, headers=auth(CAROL))).status_code == 409
    assert (await client.patch(f"{base}/members/{CAROL.id}", json={"role": "viewer"}, headers=auth(CAROL))).status_code == 409
    assert (await client.delete(f"{base}/members/{ALICE.id}", headers=auth(CAROL))).status_code == 409
    assert (await client.patch(f"{base}/members/{CAROL.id}", json={"role": "member"}, headers=auth(ALICE))).status_code == 200
    r = await client.post(f"{base}/invitations", json={"email": "dave@example.com", "role": "viewer"}, headers=auth(CAROL))
    assert r.status_code == 403  # inviting needs admin

    # Revoked and expired links stop working; members can leave.
    r = await client.post(f"{base}/invitations", json={"email": "bob@example.com", "role": "viewer"}, headers=auth(ALICE))
    bob_token, bob_invite = r.json()["url"].rsplit("/", 1)[1], r.json()["id"]
    await db.update("invitations", {"expires_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat()}, filters={"id": bob_invite})
    r = await client.post("/invitations/accept", json={"token": bob_token}, headers=auth(BOB))
    assert r.status_code == 409 and "expired" in r.json()["detail"]
    assert (await client.delete(f"{base}/members/{CAROL.id}", headers=auth(CAROL))).status_code == 204
    assert await member_role(db, CAROL.id, org["id"]) is None
    actions = {a["action"] for a in await db.select("audit_events", filters={"org_id": org["id"]})}
    assert {"member.invite", "member.join", "member.role", "member.leave"} <= actions
