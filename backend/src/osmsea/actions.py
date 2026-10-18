"""Actions: side effects outside OSMSEA, proposed by trusted code after a task passes verification and executed
only after an admin approves.

The content of an action is the task's verified output, read again at execution time, never arguments chosen
by a model. The first action is delivering a code change as a draft GitHub pull request.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel

from . import github
from .integrations import _secret
from .orgs import Actor, NotFound
from .planner import Conflict
from .schemas import CodeChange
from .specs import AgentSpec
from .store import StoreError, now_iso, record_audit, record_event

log = logging.getLogger(__name__)

BLOCKED_PREFIXES = (".github/",)  # CI workflows run with repository secrets once merged: never delivered automatically


async def _github(db: Any, org_id: str) -> dict[str, Any] | None:
    rows = await db.select("integrations", filters={"org_id": org_id, "provider": "github", "status": "configured"})
    return rows[0] if rows and (rows[0].get("config") or {}).get("repo") else None


async def propose_for_task(db: Any, task: dict[str, Any], spec: AgentSpec, output: BaseModel,
                           verification: dict[str, Any]) -> dict[str, Any] | None:
    """Called when a task completes. Proposes the actions its spec allows, if the integration is set up."""
    if "github_pull_request" not in spec.actions or not isinstance(output, CodeChange):
        return None
    integration = await _github(db, task["org_id"])
    if integration is None:
        return None
    cfg = integration["config"]
    tests = next((c for c in verification.get("checks", []) if c["name"] == "tests"), None)
    payload = {
        "repo": cfg["repo"], "base": cfg.get("base_branch") or None, "branch": f"osmsea/{task['key']}-{task['id'][:8]}",
        "title": task["title"][:200], "files": [{"path": f.path, "action": f.action, "bytes": len(f.content.encode())} for f in output.files],
        "tests": tests["detail"] if tests else None,
        "blocked_paths": [f.path for f in output.files if f.path.startswith(BLOCKED_PREFIXES)],
    }
    try:
        row = (await db.insert("actions", {
            "org_id": task["org_id"], "workflow_id": task["workflow_id"], "task_id": task["id"], "kind": "github_pull_request",
            "status": "pending", "summary": f"Open a draft pull request in {cfg['repo']} with {len(output.files)} file(s)",
            "payload": payload,
        }))[0]
    except StoreError as e:
        if e.code == "23505":  # already proposed (retried bookkeeping)
            return None
        raise
    await record_event(db, task["org_id"], "action_proposed", f"Awaiting approval: {row['summary']}", level="warning",
                       workflow_id=task["workflow_id"], task_id=task["id"], agent_id=task.get("agent_id"),
                       data={"action_id": row["id"], "kind": row["kind"]})
    return row


def _pr_body(task: dict[str, Any], output: CodeChange, verification: dict[str, Any], web_url: str) -> str:
    checks = ", ".join(f"{'✓' if c['passed'] else '✕'} {c['name'].replace('_', ' ')}" for c in verification.get("checks", []))
    review = (verification.get("review") or {}).get("summary")
    lines = [output.summary, "", "### Test plan", *[f"- {s}" for s in output.test_plan]]
    if output.risks:
        lines += ["", "### Risks", *[f"- {s}" for s in output.risks]]
    lines += ["", "### Verification by OSMSEA", checks]
    if review:
        lines.append(f"Independent review: {review}")
    lines += ["", f"Workflow: {web_url}/tasks/{task['workflow_id']}", "",
              "_Opened by OSMSEA after an admin approved this delivery. Review before merging._"]
    return "\n".join(lines)


async def decide(db: Any, http: Any, org_id: str, action_id: str, actor: Actor, *, approve: bool, web_url: str) -> dict[str, Any]:
    rows = await db.select("actions", filters={"id": action_id, "org_id": org_id})
    if not rows:
        raise NotFound("action not found")
    action = rows[0]
    if not approve:
        if not await db.update("actions", {"status": "rejected", "decided_by": actor.id, "decided_at": now_iso()},
                               filters={"id": action_id, "status": "pending"}):
            raise Conflict(f"action is already {action['status']}")
        await record_audit(db, org_id, "action.reject", "action", actor_id=actor.id, actor_label=actor.email,
                           resource_id=action_id, resource_name=action["summary"])
        return (await db.select("actions", filters={"id": action_id}))[0]

    if not await db.update("actions", {"status": "running", "decided_by": actor.id, "decided_at": now_iso()},
                           filters={"id": action_id, "status": "pending"}):
        raise Conflict(f"action is already {action['status']}")  # also stops double execution
    values: dict[str, Any]
    try:
        task = (await db.select("tasks", filters={"id": action["task_id"]}))[0]
        if task["status"] != "completed" or not task.get("output"):
            raise github.GitHubError("the task no longer has a verified output")
        output = CodeChange.model_validate(task["output"])
        if blocked := [f.path for f in output.files if f.path.startswith(BLOCKED_PREFIXES)]:
            raise github.GitHubError(f"changes under .github/ are never delivered automatically: {', '.join(blocked)}")
        integration = await _github(db, org_id)
        token = await _secret(db, integration["id"]) if integration else None
        if not token:
            raise github.GitHubError("the GitHub integration is not configured")
        p = action["payload"]
        result = await github.open_pull_request(
            http, token, repo=p["repo"], base=p.get("base"), branch=p["branch"], title=p["title"],
            body=_pr_body(task, output, task.get("verification") or {}, web_url), files=[(f.path, f.content) for f in output.files])
        values = {"status": "succeeded", "result": result, "error": None}
        outcome, message = "success", f"Pull request #{result['number']} opened: {result['url']}"
    except github.GitHubError as e:
        values = {"status": "failed", "error": str(e)[:1000]}
        outcome, message = "failure", f"Delivery failed: {e}"
    row = (await db.update("actions", {**values, "completed_at": now_iso()}, filters={"id": action_id}))[0]
    await record_audit(db, org_id, "action.github_pull_request", "action", actor_id=actor.id, actor_label=actor.email,
                       resource_id=action_id, resource_name=action["summary"], outcome=outcome,
                       details={"repo": action["payload"].get("repo"), **({"result": row["result"]} if row.get("result") else {"error": row.get("error")})})
    await record_event(db, org_id, "action_completed" if outcome == "success" else "action_failed", message,
                       level="info" if outcome == "success" else "error", workflow_id=action["workflow_id"],
                       task_id=action["task_id"], data={"action_id": action_id})
    return row
