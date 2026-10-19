"""Spaces: people and agents in one conversation, persona library, agent collaboration, inline tool approvals,
delegation to verified workflows, and custom agents drafted from a use case."""

from conftest import ALICE, CAROL, auth, review, seed_org, tool_names, tool_results, wait_for
from test_runtime import RESEARCH_ONLY, research_result, seed_memory

from osmsea.chat import DENIED
from osmsea.llm import LLMResponse, tool_reply


def say(text: str) -> LLMResponse:
    return LLMResponse(text=text, input_tokens=50, output_tokens=20)


def speaker(messages) -> str:
    system = messages[0]["content"]
    return system.split("You are ", 1)[1].split(",", 1)[0] if system.startswith("You are ") else ""


async def library_space(client, db, org_id, *templates):
    ids = []
    for t in templates:
        r = await client.post(f"/orgs/{org_id}/agents/from-library", json={"template": t}, headers=auth(ALICE))
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    r = await client.post(f"/orgs/{org_id}/spaces", json={"name": "Family trip", "description": "Melbourne in December",
                                                          "agent_ids": ids, "primary_agent_id": ids[0]}, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    return r.json(), ids


async def top_level(db, space_id):
    rows = await db.select("space_messages", filters={"space_id": space_id, "thread_id": ("is", None)}, order="created_at.asc")
    return [(m["author_label"], m["kind"], m["status"], m["content"]) for m in rows]


async def agent_said(db, space_id, author, needle):
    rows = await db.select("space_messages", filters={"space_id": space_id, "author_label": author, "status": "done"})
    return next((m for m in rows if needle in m["content"]), None)


async def test_persona_library_agents_collaborate_in_a_space(db, client_factory):
    org = await seed_org(db)

    def route(messages, tools):
        if speaker(messages) == "Trip Planner":
            if not tool_results(messages):
                return tool_reply("consult_agent", {"agent": "budget-keeper", "request": "Do four seats at $180 fit the pot?"},
                                  text="Found two. Checking them against the holiday pot.")
            return say("Two options under $180 each, at 6:10am or 6:40pm. Budget Keeper says four seats still leave $220 in the pot.")
        if speaker(messages) == "Budget Keeper":
            return say("Four seats at $180 is $720. The pot is $940, so $220 remains.")
        raise AssertionError(f"unexpected call: {messages[0]['content'][:80]}")

    client = await client_factory(route)
    library = (await client.get("/library", headers=auth(ALICE))).json()
    assert len(library) == 8 and all(t["persona"]["tagline"] for t in library)
    space, (trip, budget) = await library_space(client, db, org["id"], "trip-planner", "budget-keeper")
    assert await db.select("departments", filters={"org_id": org["id"], "slug": "personal"})  # created on demand
    again = await client.post(f"/orgs/{org['id']}/agents/from-library", json={"template": "trip-planner"}, headers=auth(ALICE))
    assert again.status_code == 422

    r = await client.post(f"/orgs/{org['id']}/spaces/{space['id']}/messages",
                          json={"content": "On it. Trip Planner, find us something Friday after 5 and check it fits the holiday pot"},
                          headers=auth(ALICE))
    assert r.status_code == 201
    await wait_for(lambda: agent_said(db, space["id"], "Trip Planner", "$220"))
    timeline = await top_level(db, space["id"])
    assert [(a, k, s) for a, k, s, _ in timeline] == [
        (ALICE.email, "text", "done"), ("Trip Planner", "text", "done"), ("Trip Planner", "collaboration", "done"),
        ("Trip Planner", "text", "done")]
    assert timeline[1][3] == "Found two. Checking them against the holiday pot."
    collab = (await db.select("space_messages", filters={"space_id": space["id"], "kind": "collaboration"}))[0]
    assert collab["data"]["with_name"] == "Budget Keeper" and collab["data"]["with_color"] == "yellow"
    thread = await db.select("space_messages", filters={"thread_id": collab["id"]}, order="created_at.asc")
    assert [m["author_label"] for m in thread] == ["Trip Planner", "Budget Keeper"] and "$220" in thread[1]["content"]
    # Persona reaches the model: tagline and voice are part of the system prompt.
    first = client.provider.calls[0]["messages"][0]["content"]
    assert "Flights, stays and getting everyone there" in first and "Upbeat and practical" in first


async def test_mentions_route_messages_and_unaddressed_ones_go_to_the_primary_agent(db, client_factory):
    org = await seed_org(db)
    client = await client_factory(lambda messages, tools: say(f"{speaker(messages)} here."))
    space, _ = await library_space(client, db, org["id"], "trip-planner", "budget-keeper")
    url = f"/orgs/{org['id']}/spaces/{space['id']}/messages"
    await client.post(url, json={"content": "anyone around?"}, headers=auth(ALICE))
    await wait_for(lambda: agent_said(db, space["id"], "Trip Planner", "here"))
    await client.post(url, json={"content": "@budget-keeper what is left in the pot?"}, headers=auth(ALICE))
    await wait_for(lambda: agent_said(db, space["id"], "Budget Keeper", "here"))
    speakers = [a for a, k, s, _ in await top_level(db, space["id"]) if a != ALICE.email]
    assert speakers == ["Trip Planner", "Budget Keeper"]


async def test_tools_that_need_approval_pause_the_turn_until_an_admin_decides(db, client_factory):
    org = await seed_org(db, settings={"tool_policy": {"memory_search": {"requires_approval": True}}})
    await seed_memory(db, org["id"])
    await db.insert("organization_members", {"org_id": org["id"], "user_id": CAROL.id, "role": "member", "email": CAROL.email})

    def route(messages, tools):
        results = tool_results(messages)
        if not results:
            return tool_reply("memory_search", {"query": "httpx async"})
        return say(f"Done. {'Not allowed to search.' if DENIED in results[-1] else 'Found it in memory.'}")

    client = await client_factory(route)
    space, _ = await library_space(client, db, org["id"], "budget-keeper")
    url = f"/orgs/{org['id']}/spaces/{space['id']}/messages"

    await client.post(url, json={"content": "Budget Keeper, what did we decide about HTTP clients?"}, headers=auth(ALICE))
    card = await wait_for(lambda: _pending_card(db, space["id"]))
    assert card["content"] == "Budget Keeper wants to use memory search" and card["data"]["args"] == {"query": "httpx async"}
    assert not await db.select("space_messages", filters={"space_id": space["id"], "status": "thinking"})
    decision = f"/orgs/{org['id']}/space-messages/{card['id']}/decision"
    assert (await client.post(decision, json={"allow": True}, headers=auth(CAROL))).status_code == 403  # admins decide
    assert (await client.post(decision, json={"allow": True}, headers=auth(ALICE))).json()["status"] == "allowed"
    await wait_for(lambda: agent_said(db, space["id"], "Budget Keeper", "Found it in memory"))
    assert (await client.post(decision, json={"allow": False}, headers=auth(ALICE))).status_code == 409

    await client.post(url, json={"content": "Budget Keeper, check again please"}, headers=auth(ALICE))
    card = await wait_for(lambda: _pending_card(db, space["id"]))
    await client.post(f"/orgs/{org['id']}/space-messages/{card['id']}/decision", json={"allow": False}, headers=auth(ALICE))
    await wait_for(lambda: agent_said(db, space["id"], "Budget Keeper", "Not allowed"))
    actions = {a["action"] for a in await db.select("audit_events", filters={"org_id": org["id"]})}
    assert {"space.tool_allowed", "space.tool_denied"} <= actions


async def _pending_card(db, space_id):
    rows = await db.select("space_messages", filters={"space_id": space_id, "kind": "approval", "status": "pending"})
    return rows[0] if rows else None


async def test_agents_hand_bigger_work_to_verified_workflows_and_report_back(db, client_factory):
    org = await seed_org(db, settings={"require_plan_approval": False})
    ids = await seed_memory(db, org["id"])

    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", RESEARCH_ONLY)
        if "submit_review" in names:
            return review(messages)
        if "submit_result" in names:  # the research task inside the workflow
            return tool_reply("submit_result", research_result(ids)) if tool_results(messages) else tool_reply("memory_search", {"query": "httpx"})
        if not tool_results(messages):
            return tool_reply("start_workflow", {"goal": "Compare httpx and requests for async support, with sources"})
        return say("I've started a verified workflow for that; results will land here.")

    client = await client_factory(route)
    space, _ = await library_space(client, db, org["id"], "market-scout")
    await client.post(f"/orgs/{org['id']}/spaces/{space['id']}/messages",
                      json={"content": "Market Scout, research httpx vs requests properly"}, headers=auth(ALICE))
    report = await wait_for(lambda: _system_report(db, space["id"]))
    assert report["content"].startswith("Workflow completed and every task was verified.") and "httpx" in report["content"]
    wf = (await db.select("workflows", filters={"id": report["data"]["workflow_id"]}))[0]
    assert wf["space_id"] == space["id"] and wf["created_by"] == ALICE.id
    card = next(m for m in await db.select("space_messages", filters={"space_id": space["id"], "kind": "workflow"})
                if m["author_kind"] == "agent")
    assert card["data"]["status"] == "completed"


async def _system_report(db, space_id):
    rows = await db.select("space_messages", filters={"space_id": space_id, "author_kind": "system"})
    return rows[0] if rows else None


async def test_custom_agents_are_drafted_from_a_use_case(db, client_factory):
    org = await seed_org(db)
    draft = {
        "id": "gym-buddy", "name": "Gym Buddy", "department": "wellness", "role": "Fitness Coach",
        "mission": "Plan weekly workouts that fit the person's schedule and goals.",
        "responsibilities": ["Plan workouts"], "capabilities": ["fitness_planning"], "limitations": ["Not medical advice"],
        "allowed_tools": ["memory_search"], "inputs": ["Goals and schedule"], "outputs": ["A weekly plan"],
        "output_schema": "report_v1", "acceptance_criteria": ["The plan fits the schedule"],
        "escalation": {"max_attempts": 2, "on_failure": "Ask for the missing details."},
        "persona": {"tagline": "Shows up when you don't feel like it", "voice": "Encouraging and brief.", "color": "green"},
        "instructions": "1. Ask for goals.\n2. Call submit_result exactly once with output matching report_v1.",
    }
    client = await client_factory(lambda messages, tools: tool_reply("submit_agent", draft))
    r = await client.post(f"/orgs/{org['id']}/agents/draft", json={"description": "Someone to keep me going to the gym 3x a week"},
                          headers=auth(ALICE))
    assert r.status_code == 200 and r.json()["valid"] is True
    assert "tagline: Shows up when you don't feel like it" in r.json()["source_md"]
    r = await client.post(f"/orgs/{org['id']}/agents/quick", json={"source_md": r.json()["source_md"]}, headers=auth(ALICE))
    assert r.status_code == 201, r.text
    assert await db.select("departments", filters={"org_id": org["id"], "slug": "wellness"})


async def test_allow_for_this_reply_stops_repeat_approval_cards(db, client_factory):
    org = await seed_org(db, settings={"tool_policy": {"memory_search": {"requires_approval": True}}})
    await seed_memory(db, org["id"])

    def route(messages, tools):
        searches = len(tool_results(messages))
        return tool_reply("memory_search", {"query": f"httpx {searches}"}) if searches < 3 else say("Checked three times.")

    client = await client_factory(route)
    space, _ = await library_space(client, db, org["id"], "budget-keeper")
    await client.post(f"/orgs/{org['id']}/spaces/{space['id']}/messages", json={"content": "Budget Keeper, dig in"}, headers=auth(ALICE))
    card = await wait_for(lambda: _pending_card(db, space["id"]))
    r = await client.post(f"/orgs/{org['id']}/space-messages/{card['id']}/decision", json={"allow": True, "remember": True},
                          headers=auth(ALICE))
    assert r.json()["data"]["for_reply"] is True
    await wait_for(lambda: agent_said(db, space["id"], "Budget Keeper", "Checked three times"))
    cards = await db.select("space_messages", filters={"space_id": space["id"], "kind": "approval"})
    assert len(cards) == 1  # the next two searches in the same reply ran without asking again
