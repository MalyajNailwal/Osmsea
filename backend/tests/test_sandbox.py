"""Sandbox-executed tests as a verification check: retries with test output as feedback, infrastructure
failures that are not the agent's fault, policy protection, and the real Docker sandbox."""

import asyncio

import pytest
from conftest import review, seed_org, tool_names, wait_for
from test_runtime import CODE, PLAN, submit, workflow

from osmsea import sandbox
from osmsea.improve import policy_violations
from osmsea.llm import tool_reply
from osmsea.registry import load_registry
from osmsea.schemas import CodeChange
from osmsea.verify import run_tests

BUILD_ONLY = {**PLAN, "tasks": [{**PLAN["tasks"][1], "depends_on": []}]}


def build_router(calls):
    def route(messages, tools):
        names = tool_names(tools)
        if "submit_plan" in names:
            return tool_reply("submit_plan", BUILD_ONLY)
        if "submit_review" in names:
            calls.append(messages[-1]["content"])
            return review(messages)
        return tool_reply("submit_result", CODE)
    return route


async def developer_spec(db):
    org = await seed_org(db, settings={"require_plan_approval": False})
    return org, (await load_registry(db, org["id"])).agents["developer"].spec


async def test_failing_tests_fail_verification_and_their_output_feeds_the_retry(db, client_factory, fake_sandbox):
    org, _ = await developer_spec(db)
    fake_sandbox.result = [sandbox.SandboxResult(1, "FAILED test_client.py::test_importable - AssertionError: boom\n1 failed", 900),
                           sandbox.SandboxResult(0, "1 passed in 0.02s", 800)]
    reviews = []
    client = await client_factory(build_router(reviews))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "completed"))

    executions = sorted(await db.select("agent_executions", filters={"workflow_id": wf_id}), key=lambda e: e["attempt"])
    first = next(c for c in executions[0]["verification"]["checks"] if c["name"] == "tests")
    assert first["passed"] is False and first["exit_code"] == 1 and "boom" in first["detail"]
    assert next(c for c in executions[1]["verification"]["checks"] if c["name"] == "tests")["passed"]
    files, command = fake_sandbox.calls[0]
    assert command == "python -m pytest -q" and {p for p, _ in files} == {"client.py", "test_client.py"}

    retry_prompt = [c for c in client.provider.calls if "**Software Developer**" in c["messages"][0]["content"]][-1]
    assert "boom" in retry_prompt["messages"][1]["content"]  # the failing test output is the feedback
    assert len(reviews) == 1 and "exit code 0 (passed)" in reviews[0]  # no review is spent on failing code


async def test_unavailable_sandbox_fails_the_task_without_retrying(db, client_factory, fake_sandbox):
    org, _ = await developer_spec(db)
    fake_sandbox.result = sandbox.SandboxUnavailable("could not start the sandbox. Build the image with: docker build ...")
    client = await client_factory(build_router([]))
    wf_id = await submit(client, org["id"])
    await wait_for(lambda: workflow(db, wf_id, "failed"))
    task = (await db.select("tasks", filters={"workflow_id": wf_id}))[0]
    assert task["attempt"] == 1 and "docker build" in task["error"]


async def test_missing_test_command_fails_and_proposals_cannot_disable_tests(db):
    _, spec = await developer_spec(db)
    check = await run_tests(spec, CodeChange.model_validate({**CODE, "test_command": None}))
    assert check["passed"] is False and "no test_command" in check["detail"]

    weaker = spec.model_copy(update={"verification": spec.verification.model_copy(update={"run_tests": False})})
    assert "verification.run_tests must stay enabled" in policy_violations(spec, weaker)


def _docker_ready() -> bool:
    return bool(asyncio.run(sandbox.status())["available"])


@pytest.mark.real_sandbox
@pytest.mark.skipif(not _docker_ready(), reason="Docker or the osmsea-sandbox image is unavailable")
async def test_real_sandbox_runs_the_agents_tests_offline(db):
    _, spec = await developer_spec(db)
    module = {"path": "calc.py", "language": "python", "action": "create", "content": "def add(a, b):\n    return a + b\n"}
    good = {"path": "test_calc.py", "language": "python", "action": "create",
            "content": "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"}
    leaky = {"path": "test_net.py", "language": "python", "action": "create",
             "content": "import httpx\n\n\ndef test_network():\n    httpx.get('https://example.com', timeout=3)\n"}

    passed = await run_tests(spec, CodeChange.model_validate({**CODE, "files": [module, good]}))
    assert passed["passed"] and passed["exit_code"] == 0 and "1 passed" in passed["detail"]

    failed = await run_tests(spec, CodeChange.model_validate({**CODE, "files": [module, good, leaky]}))
    assert not failed["passed"] and failed["exit_code"] == 1 and "ConnectError" in failed["output"]  # no network
