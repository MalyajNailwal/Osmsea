"""Dependency-aware scheduler and worker.

Runs inside the API process as an asyncio loop. All state lives in Supabase, so the loop can stop and
restart at any time:

* ``pending`` tasks become ``queued`` when every dependency is ``completed``, or ``blocked`` when a
  dependency failed or was cancelled. A workflow finishes when all its tasks are terminal.
* Queued tasks are claimed with a compare-and-swap on (status, attempt) and a lease; the
  ``agent_executions (task_id, attempt)`` unique key is a second guard against duplicate execution.
* Running tasks renew their lease. Tasks whose lease expired (worker crash or restart) are re-queued
  as a new attempt or failed when out of attempts; their old execution is marked ``abandoned``.
* Concurrency is bounded per worker and per organization; time and token budgets per task/workflow.

ponytail: one in-process worker polling PostgREST; move to a dedicated worker process (same code)
when API latency or throughput requires it.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel

from .evals import choose_model, record_case, run_eval
from .executor import BudgetExceeded, ExecutionContext, Outcome, execute, guarded_usage
from .integrations import ProviderNotConfigured
from .llm import LLMError
from .planner import PLAN_TIMEOUT_SECONDS, Conflict, ProviderFactory, plan_workflow
from .registry import load_registry, spec_from_row
from .schemas import CodeChange, Report, ResearchResult
from .specs import AgentSpec, SpecError, parse_settings
from .store import now_iso, parse_ts, record_audit, record_event
from .tools import ToolContext

log = logging.getLogger(__name__)

ACTIVE = ("running", "verifying")
TERMINAL = ("completed", "failed", "blocked", "cancelled")
RECOVERY_INTERVAL_SECONDS = 30

SecretsFactory = Callable[[str], Awaitable[dict[str, str]]]


def _later(seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()


class Worker:
    def __init__(self, db: Any, *, provider_factory: ProviderFactory, secrets_factory: SecretsFactory, http: Any,
                 concurrency: int = 4, poll_interval: float = 1.0, lease_seconds: int = 60,
                 worker_id: str | None = None, retry_base_seconds: float = 5.0):
        self.db = db
        self.provider_factory = provider_factory
        self.secrets_factory = secrets_factory
        self.http = http
        self.concurrency = concurrency
        self.poll_interval = poll_interval
        self.lease_seconds = lease_seconds
        self.retry_base_seconds = retry_base_seconds
        self.id = worker_id or f"worker-{uuid.uuid4().hex[:8]}"
        self.running: dict[str, asyncio.Task] = {}  # task_id -> execution job
        self.running_workflow: dict[str, str] = {}  # task_id -> workflow_id
        self.planning: dict[str, asyncio.Task] = {}  # workflow_id -> planning job
        self.evals: dict[str, asyncio.Task] = {}  # eval_run_id -> evaluation job
        self.wake = asyncio.Event()
        self.last_tick: str | None = None
        self._loop_task: asyncio.Task | None = None
        self._shutting_down = False
        self._last_recovery = 0.0

    # --- lifecycle -------------------------------------------------------------------------------

    async def start(self) -> None:
        await self.recover(startup=True)
        self._loop_task = asyncio.create_task(self._loop(), name="osmsea-scheduler")

    async def stop(self) -> None:
        self._shutting_down = True
        if self._loop_task:
            self._loop_task.cancel()
        jobs = [*self.running.values(), *self.planning.values(), *self.evals.values()]
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)

    def notify(self) -> None:
        self.wake.set()

    async def _loop(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                await self.tick()
                if loop.time() - self._last_recovery > RECOVERY_INTERVAL_SECONDS:
                    await self.recover()
            except Exception:
                log.exception("scheduler tick failed")
            try:
                await asyncio.wait_for(self.wake.wait(), self.poll_interval)
            except TimeoutError:
                pass
            self.wake.clear()

    # --- planning --------------------------------------------------------------------------------

    def submit_planning(self, workflow_id: str) -> None:
        async def job() -> None:
            try:
                await plan_workflow(self.db, workflow_id, self.provider_factory)
            except Exception:
                log.exception("planning crashed for %s", workflow_id)
                await self.db.update("workflows", {"status": "plan_failed", "error": "internal planning error",
                                                   "plan_errors": ["internal planning error"]},
                                     filters={"id": workflow_id, "status": "planning"})
            finally:
                self.planning.pop(workflow_id, None)
                self.notify()

        self.planning[workflow_id] = asyncio.create_task(job(), name=f"plan-{workflow_id}")

    def submit_eval(self, run_id: str) -> None:
        async def job() -> None:
            try:
                await run_eval(self.db, run_id, self.provider_factory, self.secrets_factory, self.http)
            finally:
                self.evals.pop(run_id, None)

        self.evals[run_id] = asyncio.create_task(job(), name=f"eval-{run_id}")

    # --- scheduling ------------------------------------------------------------------------------

    async def tick(self) -> None:
        self.last_tick = now_iso()
        workflows = await self.db.select("workflows", filters={"status": "running"})
        if not workflows:
            return
        wf_by_id = {w["id"]: w for w in workflows}
        tasks = await self.db.select("tasks", filters={"workflow_id": ("in", list(wf_by_id))}, order="created_at.asc")
        org_ids = list({w["org_id"] for w in workflows})
        settings = {o["id"]: parse_settings(o.get("settings"))
                    for o in await self.db.select("organizations", filters={"id": ("in", org_ids)})}
        by_wf: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for t in tasks:
            by_wf[t["workflow_id"]].append(t)
        for wf in workflows:
            await self._advance(wf, by_wf[wf["id"]])

        active_per_org = Counter(t["org_id"] for t in tasks if t["status"] in ACTIVE)
        now = datetime.now(UTC)
        for t in tasks:
            if t["status"] != "queued" or len(self.running) >= self.concurrency:
                continue
            if t.get("next_attempt_at") and parse_ts(t["next_attempt_at"]) > now:
                continue
            org_settings = settings.get(t["org_id"])
            if org_settings is None or active_per_org[t["org_id"]] >= org_settings.max_concurrent_tasks:
                continue
            claimed = await self.db.update("tasks", {
                "status": "running", "attempt": t["attempt"] + 1, "lease_owner": self.id,
                "lease_expires_at": _later(self.lease_seconds), "started_at": now_iso(), "next_attempt_at": None,
            }, filters={"id": t["id"], "status": "queued", "attempt": t["attempt"]})
            if not claimed:
                continue  # another worker won the race
            active_per_org[t["org_id"]] += 1
            self._spawn(claimed[0], wf_by_id[t["workflow_id"]], org_settings.task_timeout_seconds)

    async def _advance(self, wf: dict[str, Any], wf_tasks: list[dict[str, Any]]) -> None:
        by_id = {t["id"]: t for t in wf_tasks}
        for t in wf_tasks:
            if t["status"] != "pending":
                continue
            deps = [by_id.get(d) for d in t["depends_on"]]
            bad = next((d for d in deps if d is not None and d["status"] in ("failed", "blocked", "cancelled")), None)
            if bad is not None or None in deps:
                reason = f"dependency '{bad['key']}' {bad['status']}" if bad else "a dependency is missing"
                if await self.db.update("tasks", {"status": "blocked", "error": reason, "completed_at": now_iso()},
                                        filters={"id": t["id"], "status": "pending"}):
                    t["status"] = "blocked"
                    await record_event(self.db, t["org_id"], "task_blocked", f"'{t['title']}' blocked: {reason}",
                                       level="warning", workflow_id=wf["id"], task_id=t["id"], agent_id=t.get("agent_id"))
            elif all(d["status"] == "completed" for d in deps):
                if await self.db.update("tasks", {"status": "queued"}, filters={"id": t["id"], "status": "pending"}):
                    t["status"] = "queued"
                    if deps:
                        await record_event(
                            self.db, t["org_id"], "handoff",
                            f"{', '.join(sorted({d['agent_slug'] for d in deps}))} → {t['agent_slug']}: '{t['title']}'",
                            workflow_id=wf["id"], task_id=t["id"], agent_id=t.get("agent_id"),
                            data={"from_tasks": [d["id"] for d in deps], "from_agents": [d.get("agent_id") for d in deps],
                                  "to_agent": t.get("agent_id")})
                    await record_event(self.db, t["org_id"], "task_queued", f"'{t['title']}' queued for {t['agent_slug']}",
                                       workflow_id=wf["id"], task_id=t["id"], agent_id=t.get("agent_id"))

        if wf_tasks and all(t["status"] in TERMINAL for t in wf_tasks):
            done = all(t["status"] == "completed" for t in wf_tasks)
            failed = [t for t in wf_tasks if t["status"] != "completed"]
            error = None if done else "; ".join(f"{t['key']}: {t['status']}" + (f" ({t['error'][:120]})" if t.get("error") else "")
                                                for t in failed)[:2000]
            if await self.db.update("workflows", {"status": "completed" if done else "failed", "completed_at": now_iso(),
                                                  "error": error}, filters={"id": wf["id"], "status": "running"}):
                await record_event(self.db, wf["org_id"], "workflow_completed" if done else "workflow_failed",
                                   "Workflow completed: all tasks verified" if done else f"Workflow failed: {error}",
                                   level="info" if done else "error", workflow_id=wf["id"])

    def _spawn(self, task: dict[str, Any], wf: dict[str, Any], org_timeout: int) -> None:
        job = asyncio.create_task(self._run(task, wf, org_timeout), name=f"task-{task['id']}")
        self.running[task["id"]] = job
        self.running_workflow[task["id"]] = wf["id"]

        def done(_: asyncio.Task) -> None:
            self.running.pop(task["id"], None)
            self.running_workflow.pop(task["id"], None)
            self.notify()

        job.add_done_callback(done)

    # --- execution -------------------------------------------------------------------------------

    async def _run(self, task: dict[str, Any], wf: dict[str, Any], org_timeout: int) -> None:
        db = self.db
        execution = (await db.insert("agent_executions", {
            "org_id": task["org_id"], "workflow_id": task["workflow_id"], "task_id": task["id"],
            "agent_id": task.get("agent_id"), "agent_version_id": task.get("agent_version_id"),
            "attempt": task["attempt"], "status": "running", "worker_id": self.id,
        }))[0]
        await record_event(db, task["org_id"], "task_started",
                           f"{task['agent_slug']} started '{task['title']}' (attempt {task['attempt']}/{task['max_attempts']})",
                           workflow_id=task["workflow_id"], task_id=task["id"], execution_id=execution["id"],
                           agent_id=task.get("agent_id"))
        totals: dict[str, Any] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": None, "model": None}
        heartbeat = asyncio.create_task(self._heartbeat(task["id"], asyncio.current_task()))
        exec_status, spec, outcome, prerequisites = "failed", None, None, []
        try:
            versions = await db.select("agent_versions", filters={"id": task.get("agent_version_id") or ""}) \
                if task.get("agent_version_id") else []
            if not versions:
                raise SpecError(["task has no pinned agent version"])
            spec = spec_from_row(versions[0]["spec"])
            registry = await load_registry(db, task["org_id"])
            model, reason = await choose_model(db, registry, spec, task.get("agent_id"))
            provider = await self.provider_factory(task["org_id"], model=model,
                                                   org_default_model=registry.settings.default_model)
            await db.update("agent_executions", {"provider": provider.name, "model": provider.model,
                                                 "routing": {"model": provider.model, "reason": reason}},
                            filters={"id": execution["id"]})
            prerequisites = await db.select("tasks", filters={"id": ("in", task["depends_on"])}) if task["depends_on"] else []
            prerequisites = [p for p in prerequisites if p["status"] == "completed"]
            ctx = ExecutionContext(
                db=db, provider=provider, registry=registry, workflow=wf, task=task, execution_id=execution["id"],
                agent_version=versions[0], spec=spec,
                approved_tools={p["tool"] for p in wf.get("required_permissions") or []},
                tool_context=ToolContext(org_id=task["org_id"], db=db, http=self.http,
                                         secrets=await self.secrets_factory(task["org_id"])),
                prerequisites=prerequisites,
            )
            timeout = min(spec.limits.timeout_seconds, org_timeout)
            try:
                async with asyncio.timeout(timeout):
                    outcome = await execute(ctx, guarded_usage(db, wf, execution["id"], totals))
            except TimeoutError:
                exec_status, outcome = "timed_out", Outcome(False, error=f"timed out after {timeout}s")
        except BudgetExceeded as e:
            outcome = Outcome(False, error=str(e), retryable=False)
        except (ProviderNotConfigured, SpecError) as e:
            outcome = Outcome(False, error=str(e), retryable=False)
        except LLMError as e:
            outcome = Outcome(False, error=f"model error: {e}", retryable=e.retryable)
        except asyncio.CancelledError:
            await asyncio.shield(self._on_cancelled(task, execution))
            raise
        except Exception as e:  # unexpected bug: record it rather than leaving the task running
            log.exception("task %s crashed", task["id"])
            outcome = Outcome(False, error=f"internal error: {type(e).__name__}: {e}")
        finally:
            heartbeat.cancel()
        try:  # evaluation cases are a by-product; never let them affect the task
            await record_case(db, task=task, execution_id=execution["id"], outcome=outcome, totals=totals,
                              agent_version_id=task.get("agent_version_id"), objective=wf.get("objective"),
                              prerequisites=prerequisites)
        except Exception:
            log.exception("recording an evaluation case for task %s failed", task["id"])
        for attempt in range(3):  # bookkeeping must survive a network blip, or a finished attempt is lost
            try:
                await self._finish(task, execution, outcome, totals, spec, exec_status)
                return
            except Exception:
                log.exception("recording the result of task %s failed (try %d/3)", task["id"], attempt + 1)
                await asyncio.sleep(2 * (attempt + 1))
        # Still failing: the task keeps its lease until it expires, then recover() re-queues or fails it.

    async def _heartbeat(self, task_id: str, job: asyncio.Task | None) -> None:
        while True:
            await asyncio.sleep(max(self.lease_seconds / 3, 0.05))
            try:
                renewed = await self.db.update("tasks", {"lease_expires_at": _later(self.lease_seconds)},
                                               filters={"id": task_id, "lease_owner": self.id, "status": ("in", list(ACTIVE))})
            except Exception:
                log.exception("lease renewal failed for %s", task_id)
                continue
            if not renewed and job is not None:  # cancelled by a user, or the lease was taken over
                job.cancel()
                return

    async def _on_cancelled(self, task: dict[str, Any], execution: dict[str, Any]) -> None:
        current = await self.db.select("tasks", filters={"id": task["id"]})
        status = current[0]["status"] if current else "cancelled"
        if self._shutting_down and status in ACTIVE:
            await self._fail_or_retry(task, "worker shut down mid-execution; restarting from the beginning",
                                      retryable=True, verification=None, owner_check=True)
            exec_status = "abandoned"
        else:
            exec_status = "cancelled" if status == "cancelled" else "abandoned"
        await self.db.update("agent_executions", {"status": exec_status, "finished_at": now_iso(),
                                                  "error": "cancelled" if exec_status == "cancelled" else "execution stopped"},
                             filters={"id": execution["id"]})
        await record_event(self.db, task["org_id"], "task_cancelled" if exec_status == "cancelled" else "task_abandoned",
                           f"Execution of '{task['title']}' stopped ({exec_status})", level="warning",
                           workflow_id=task["workflow_id"], task_id=task["id"], execution_id=execution["id"],
                           agent_id=task.get("agent_id"))

    async def _finish(self, task: dict[str, Any], execution: dict[str, Any], outcome: Outcome,
                      totals: dict[str, Any], spec: AgentSpec | None, exec_status: str) -> None:
        db = self.db
        output = outcome.output.model_dump() if outcome.output else None
        common = {"finished_at": now_iso(), "output": output, "verification": outcome.verification,
                  "tool_recordings": outcome.recordings}
        if outcome.succeeded:
            updated = await db.update("tasks", {
                "status": "completed", "output": output, "verification": outcome.verification, "error": None,
                "completed_at": now_iso(), "lease_owner": None, "lease_expires_at": None,
            }, filters={"id": task["id"], "status": ("in", list(ACTIVE)), "lease_owner": self.id})
            if not updated:
                # A retried _finish: only this attempt's lease holder can complete the task at this attempt
                # number, so a completed row with our attempt means the first try got that far.
                updated = await db.select("tasks", filters={"id": task["id"], "status": "completed",
                                                            "attempt": task["attempt"]})
            await db.update("agent_executions", {**common, "status": "succeeded" if updated else "cancelled"},
                            filters={"id": execution["id"]})
            if updated and spec is not None:
                await persist_results(db, updated[0], execution["id"], spec, outcome.output)
                await record_event(db, task["org_id"], "task_completed",
                                   f"'{task['title']}' completed and verified by {len(outcome.verification['checks'])} check(s)",
                                   workflow_id=task["workflow_id"], task_id=task["id"], execution_id=execution["id"],
                                   agent_id=task.get("agent_id"))
        else:
            await db.update("agent_executions", {**common, "status": exec_status, "error": outcome.error},
                            filters={"id": execution["id"]})
            await self._fail_or_retry(task, outcome.error or "failed", retryable=outcome.retryable,
                                      verification=outcome.verification, owner_check=True, spec=spec)
        self.notify()

    async def _fail_or_retry(self, task: dict[str, Any], error: str, *, retryable: bool, verification: dict | None,
                             owner_check: bool, spec: AgentSpec | None = None) -> None:
        filters: dict[str, Any] = {"id": task["id"], "status": ("in", list(ACTIVE))}
        if owner_check:
            filters["lease_owner"] = self.id
        if retryable and task["attempt"] < task["max_attempts"]:
            delay = min(self.retry_base_seconds * 2 ** (task["attempt"] - 1), 60)
            if await self.db.update("tasks", {"status": "queued", "error": error[:2000], "verification": verification,
                                              "next_attempt_at": _later(delay), "lease_owner": None,
                                              "lease_expires_at": None}, filters=filters):
                await record_event(self.db, task["org_id"], "task_retry_scheduled",
                                   f"'{task['title']}' attempt {task['attempt']} failed; retrying in {delay:.0f}s: {error[:300]}",
                                   level="warning", workflow_id=task["workflow_id"], task_id=task["id"],
                                   agent_id=task.get("agent_id"), data={"error": error[:1000]})
            return
        if await self.db.update("tasks", {"status": "failed", "error": error[:2000], "verification": verification,
                                          "completed_at": now_iso(), "lease_owner": None, "lease_expires_at": None},
                                filters=filters):
            escalation = spec.escalation.on_failure if spec else None
            await record_event(self.db, task["org_id"], "task_failed",
                               f"'{task['title']}' failed after {task['attempt']} attempt(s): {error[:300]}",
                               level="error", workflow_id=task["workflow_id"], task_id=task["id"],
                               agent_id=task.get("agent_id"), data={"error": error[:1000], "escalation": escalation})

    # --- cancellation & recovery -----------------------------------------------------------------

    async def cancel_workflow(self, org_id: str, workflow_id: str, user_id: str, user_label: str) -> None:
        updated = await self.db.update("workflows", {"status": "cancelled", "completed_at": now_iso(),
                                                     "error": f"cancelled by {user_label}"},
                                       filters={"id": workflow_id, "org_id": org_id,
                                                "status": ("in", ["planning", "awaiting_approval", "running"])})
        if not updated:
            raise Conflict("workflow is not active")
        await self.db.update("tasks", {"status": "cancelled", "completed_at": now_iso(), "lease_owner": None},
                             filters={"workflow_id": workflow_id,
                                      "status": ("in", ["awaiting_approval", "pending", "queued", *ACTIVE])})
        await self.db.update("approvals", {"status": "cancelled", "decided_by": user_id, "decided_at": now_iso()},
                             filters={"workflow_id": workflow_id, "status": "pending"})
        for task_id, wid in list(self.running_workflow.items()):
            if wid == workflow_id and task_id in self.running:
                self.running[task_id].cancel()
        if job := self.planning.get(workflow_id):
            job.cancel()
        await record_event(self.db, org_id, "workflow_cancelled", f"Workflow cancelled by {user_label}",
                           level="warning", workflow_id=workflow_id)
        await record_audit(self.db, org_id, "workflow.cancel", "workflow", actor_id=user_id, actor_label=user_label,
                           resource_id=workflow_id, resource_name=updated[0]["goal"][:120])

    async def recover(self, startup: bool = False) -> int:
        """Re-queue or fail tasks whose worker disappeared; fail plans interrupted by a restart."""
        self._last_recovery = asyncio.get_running_loop().time()
        recovered = 0
        expired = await self.db.select("tasks", filters={"status": ("in", list(ACTIVE)), "lease_expires_at": ("lt", now_iso())})
        for t in expired:
            if t["id"] in self.running:
                continue
            retry = t["attempt"] < t["max_attempts"]
            note = "worker stopped responding (lease expired); " + ("restarting the task from the beginning" if retry
                                                                    else "no attempts left")
            values = {"status": "queued" if retry else "failed", "error": note, "lease_owner": None, "lease_expires_at": None,
                      **({"next_attempt_at": now_iso()} if retry else {"completed_at": now_iso()})}
            if await self.db.update("tasks", values, filters={"id": t["id"], "status": t["status"],
                                                              "lease_expires_at": t["lease_expires_at"]}):
                recovered += 1
                await self.db.update("agent_executions", {"status": "abandoned", "finished_at": now_iso(), "error": note},
                                     filters={"task_id": t["id"], "attempt": t["attempt"], "status": ("in", list(ACTIVE))})
                await record_event(self.db, t["org_id"], "task_recovered", f"'{t['title']}': {note}", level="warning",
                                   workflow_id=t["workflow_id"], task_id=t["id"], agent_id=t.get("agent_id"))

        cutoff = (datetime.now(UTC) - timedelta(seconds=PLAN_TIMEOUT_SECONDS + 60)).isoformat()
        for w in await self.db.select("workflows", filters={"status": "planning", "updated_at": ("lt", cutoff)}):
            if w["id"] in self.planning:
                continue
            msg = "planning was interrupted (server restart or crash); submit the goal again"
            if await self.db.update("workflows", {"status": "plan_failed", "error": msg, "plan_errors": [msg],
                                                  "completed_at": now_iso()}, filters={"id": w["id"], "status": "planning"}):
                await record_event(self.db, w["org_id"], "planning_failed", msg, level="error", workflow_id=w["id"])
        for r in await self.db.select("eval_runs", filters={"status": ("in", ["queued", "running"]), "created_at": ("lt", cutoff)}):
            if r["id"] not in self.evals:
                await self.db.update("eval_runs", {"status": "failed", "completed_at": now_iso(),
                                                   "error": "evaluation was interrupted (server restart); run it again"},
                                     filters={"id": r["id"], "status": r["status"]})
        if recovered:
            self.notify()
        return recovered


# --- results ---------------------------------------------------------------------------------------


def _md_sources(sources: list[Any]) -> str:
    return "\n".join(f"{i}. [{s.title or s.url}]({s.url})" for i, s in enumerate(sources, 1))


def result_artifacts(task: dict[str, Any], output: BaseModel) -> list[dict[str, str]]:
    if isinstance(output, ResearchResult):
        index = {s.url: i for i, s in enumerate(output.sources, 1)}
        findings = "\n".join(f"{n}. {f.claim} " + " ".join(f"[{index[u]}]" for u in f.source_urls)
                             for n, f in enumerate(output.findings, 1))
        questions = "\n".join(f"- {q}" for q in output.open_questions) or "- none"
        md = (f"# {task['title']}\n\n{output.summary}\n\n**Confidence:** {output.confidence}\n\n"
              f"**Evidence:** {output.evidence_notes}\n\n## Findings\n{findings}\n\n"
              f"## Sources\n{_md_sources(output.sources)}\n\n## Open questions\n{questions}\n")
        return [{"name": "research-summary.md", "kind": "markdown", "content": md}]
    if isinstance(output, Report):
        body = "\n\n".join(f"## {s.heading}\n{s.body}" for s in output.sections)
        points = "\n".join(f"- {p}" for p in output.key_points)
        md = f"# {output.title}\n\n{output.summary}\n\n{body}\n" + (f"\n## Key points\n{points}\n" if points else "") + \
             (f"\n## Sources\n{_md_sources(output.sources)}\n" if output.sources else "")
        return [{"name": "report.md", "kind": "markdown", "content": md}]
    if isinstance(output, CodeChange):
        files = [{"name": f.path, "kind": "code", "content": f.content} for f in output.files]
        md = (f"# {task['title']}\n\n{output.summary}\n\n## Files\n" + "\n".join(f"- `{f.path}` ({f.action})" for f in output.files)
              + "\n\n## Test plan\n" + "\n".join(f"- {t}" for t in output.test_plan)
              + ("\n\n## Risks\n" + "\n".join(f"- {r}" for r in output.risks) if output.risks else "") + "\n")
        return [{"name": "change-summary.md", "kind": "markdown", "content": md}, *files]
    return [{"name": "output.json", "kind": "json", "content": output.model_dump_json(indent=2)}]


def result_memories(task: dict[str, Any], spec: AgentSpec, output: BaseModel) -> list[dict[str, Any]]:
    base = {"agent": spec.id, "task_key": task["key"], "verified": True}
    tags = [spec.id, spec.department]
    items = [{"kind": "summary", "title": task["title"][:300], "content": getattr(output, "summary", ""),
              "source": base, "tags": tags}]
    if isinstance(output, ResearchResult):
        titles = {s.url: s.title for s in output.sources}
        for f in output.findings[:10]:
            items.append({"kind": "finding", "title": f.claim[:300], "content": f.claim + "\n\nSources: " + ", ".join(f.source_urls),
                          "source": {**base, "url": f.source_urls[0], "title": titles.get(f.source_urls[0], "")}, "tags": tags})
    elif isinstance(output, CodeChange):
        items.append({"kind": "decision", "title": f"Proposed change: {task['title']}"[:300],
                      "content": output.summary + "\n\nFiles: " + ", ".join(f.path for f in output.files)
                      + ("\nRisks: " + "; ".join(output.risks) if output.risks else ""), "source": base, "tags": tags})
    return items


async def persist_results(db: Any, task: dict[str, Any], execution_id: str, spec: AgentSpec, output: BaseModel) -> None:
    """Store artifacts and verified memory. Only trusted code writes memory, and only after verification.

    Idempotent: a retried completion replaces what an interrupted first try may have written.
    """
    await db.delete("artifacts", filters={"execution_id": execution_id})
    await db.delete("memory_items", filters={"task_id": task["id"]})
    rows = []
    for a in result_artifacts(task, output):
        data = a["content"].encode()
        rows.append({"org_id": task["org_id"], "workflow_id": task["workflow_id"], "task_id": task["id"],
                     "execution_id": execution_id, "name": a["name"], "kind": a["kind"], "content": a["content"],
                     "sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)})
    if rows:
        await db.insert("artifacts", rows)
    memories = [{**m, "org_id": task["org_id"], "workflow_id": task["workflow_id"], "task_id": task["id"],
                 "agent_id": task.get("agent_id")} for m in result_memories(task, spec, output) if m["content"]]
    if memories:
        await db.insert("memory_items", memories)
