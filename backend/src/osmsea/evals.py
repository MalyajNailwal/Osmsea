"""Evaluation suite ("CI for agents") and cost-aware model routing.

* Every task attempt that produced a schema-valid output becomes an eval case, with the task, the
  verified inputs it received and the full results of the tool calls it made.
* An eval run replays those cases against a candidate spec (or model). Recorded tool calls are
  answered from the recording, so runs are comparable and cheap; unrecorded read-only built-in
  tools run live; MCP tools never run live. Nothing touches real tasks, executions or events.
* Activation gate: when enabled, a new agent version can be activated only if an eval of that exact
  spec passed at least as many cases as the recorded baseline (and the org's minimum pass rate).
* Routing: per agent and model, pass rate and cost per verified task come from real executions and
  eval results; auto-routing picks the cheapest model that meets the org's quality bar.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import math
from collections import defaultdict
from typing import Any

from .executor import BudgetExceeded, ExecutionContext, Outcome, execute
from .integrations import ProviderNotConfigured
from .llm import LLMError, LLMResponse
from .registry import OrgRegistry, load_registry
from .sandbox import SandboxUnavailable
from .schemas import Plan
from .specs import AgentSpec, OrgSettings, SpecError, parse_agent_markdown
from .store import StoreError, now_iso, parse_ts, record_audit
from .tools import ToolContext

log = logging.getLogger(__name__)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# --- cases ---------------------------------------------------------------------------------------


async def record_case(db: Any, *, task: dict[str, Any], execution_id: str, agent_version_id: str | None,
                      outcome: Outcome, totals: dict[str, Any], objective: str | None,
                      prerequisites: list[dict[str, Any]]) -> None:
    """Freeze an attempt as a regression case. Only attempts that reached verification qualify."""
    if outcome.verification is None or not task.get("agent_id"):
        return
    try:
        await db.insert("eval_cases", {
            "org_id": task["org_id"], "agent_id": task["agent_id"], "source_task_id": task["id"],
            "source_execution_id": execution_id, "title": task["title"][:300], "status": "active",
            "task": {**{k: task.get(k) for k in ("key", "title", "description", "expected_output", "acceptance_criteria")},
                     "objective": objective},
            "prerequisites": [{"key": p["key"], "agent_slug": p["agent_slug"], "output": p.get("output")} for p in prerequisites],
            "recordings": outcome.recordings,
            "baseline": {"passed": bool(outcome.verification["passed"]), "agent_version_id": agent_version_id,
                         "failed_checks": [c["name"] for c in outcome.verification["checks"] if not c["passed"]],
                         "model": totals.get("model"), "cost_usd": totals.get("cost_usd"),
                         "tokens": totals.get("input_tokens", 0) + totals.get("output_tokens", 0)},
        })
    except StoreError as e:
        if e.code != "23505":  # already recorded (retried bookkeeping)
            raise


# --- runs ----------------------------------------------------------------------------------------


async def create_eval_run(db: Any, org_id: str, agent_id: str, actor_id: str, actor_label: str, *,
                          source_md: str | None = None, model: str | None = None, kind: str = "manual",
                          proposal_id: str | None = None) -> dict[str, Any]:
    agents = await db.select("agents", filters={"id": agent_id, "org_id": org_id})
    if not agents:
        raise SpecError(["agent not found"])
    agent = agents[0]
    if source_md is None:
        version = await db.select("agent_versions", filters={"id": agent.get("active_version_id") or ""}) \
            if agent.get("active_version_id") else []
        if not version:
            raise SpecError(["agent has no active version"])
        source_md = version[0]["source_md"]
    spec = parse_agent_markdown(source_md)
    if spec.id != agent["slug"]:
        raise SpecError([f"id: expected '{agent['slug']}'"])
    if not await db.select("eval_cases", filters={"agent_id": agent_id, "status": "active"}, limit=1):
        raise SpecError(["no evaluation cases yet: they are recorded automatically each time this agent's output is verified"])
    row = (await db.insert("eval_runs", {
        "org_id": org_id, "agent_id": agent_id, "kind": kind, "source_md": source_md, "source_sha256": sha256(source_md),
        "model": model, "status": "queued", "proposal_id": proposal_id, "created_by": actor_id,
    }))[0]
    await record_audit(db, org_id, "eval.start", "agent", actor_id=actor_id, actor_label=actor_label, resource_id=agent_id,
                       resource_name=agent["name"], details={"eval_run_id": row["id"], "kind": kind, "model": model})
    return row


def summarize(results: list[dict[str, Any]], cases: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(results)
    passed = sum(1 for r in results if r["passed"])
    baseline = sum(1 for c in cases if (c.get("baseline") or {}).get("passed"))
    costs = [float(r["cost_usd"]) for r in results if r.get("cost_usd") is not None]
    total_cost = sum(costs) if costs else None
    return {
        "cases": n, "passed": passed, "pass_rate": passed / n if n else 0.0,
        "baseline_passed": baseline, "baseline_pass_rate": baseline / n if n else 0.0,
        "total_cost_usd": total_cost, "cost_per_pass": (total_cost / passed) if passed and total_cost is not None else None,
        "avg_tokens": (sum(r["tokens"] for r in results) / n) if n else 0,
        "replayed_calls": sum(r["replayed"] for r in results), "live_calls": sum(r["live_calls"] for r in results),
    }


async def _attempt(db: Any, *, task_id: str, org_id: str, agent: dict[str, Any], task_fields: dict[str, Any],
                   prerequisites: list[dict[str, Any]], recordings: list[dict[str, Any]], spec: AgentSpec, reg: OrgRegistry,
                   provider: Any, secrets: dict[str, str], http: Any) -> dict[str, Any]:
    """One sandboxed attempt (evaluation case or replay): no task, execution, event or audit writes; recorded
    tool calls are answered from `recordings`. Returns the result fields shared by eval_results and replays."""
    settings = reg.settings
    task = {"id": task_id, "org_id": org_id, "workflow_id": None, "agent_id": agent["id"],
            "agent_slug": agent["slug"], "attempt": 1, "error": None, **task_fields}
    ctx = ExecutionContext(
        db=db, provider=provider, registry=reg,
        workflow={"id": None, "goal": task.get("objective") or task["title"], "objective": task.get("objective")},
        task=task, execution_id="", agent_version={"version": "candidate"}, spec=spec,
        approved_tools=set(spec.allowed_tools), tool_context=ToolContext(org_id, db, http, secrets),
        prerequisites=prerequisites, persist=False, replay={r["sig"]: r for r in recordings or []},
    )
    totals = {"tokens": 0, "cost": None, "model": None}

    async def on_usage(resp: LLMResponse) -> None:
        totals["tokens"] += resp.tokens
        totals["model"] = resp.model or totals["model"]
        if resp.cost_usd is not None:
            totals["cost"] = (totals["cost"] or 0.0) + resp.cost_usd
        if totals["tokens"] > settings.workflow_token_budget:
            raise BudgetExceeded("evaluation case exceeded the workflow token budget")

    started = time.monotonic()
    try:
        outcome = await asyncio.wait_for(execute(ctx, on_usage), min(spec.limits.timeout_seconds, settings.task_timeout_seconds))
    except TimeoutError:
        outcome = Outcome(False, error="timed out")
    except BudgetExceeded as e:
        outcome = Outcome(False, error=str(e))
    except LLMError as e:
        outcome = Outcome(False, error=f"model error: {e}")
    except SandboxUnavailable as e:
        outcome = Outcome(False, error=f"sandbox unavailable: {e}")
    return {
        "passed": outcome.succeeded, "verification": outcome.verification, "error": outcome.error,
        "output": outcome.output.model_dump() if outcome.output else None,
        "cost_usd": totals["cost"], "tokens": totals["tokens"], "model": totals["model"] or provider.model,
        "steps": outcome.steps, "duration_ms": int((time.monotonic() - started) * 1000),
        "replayed": sum(1 for s in outcome.steps if s.get("replayed")),
        "live_calls": sum(1 for s in outcome.steps if s.get("type") == "tool" and not s.get("replayed")),
    }


async def _run_case(db: Any, run: dict[str, Any], case: dict[str, Any], spec: AgentSpec, reg: OrgRegistry,
                    agent: dict[str, Any], provider: Any, secrets: dict[str, str], http: Any) -> dict[str, Any]:
    result = await _attempt(db, task_id=case["id"], org_id=run["org_id"], agent=agent, task_fields=case["task"] or {},
                            prerequisites=case.get("prerequisites") or [], recordings=case.get("recordings") or [],
                            spec=spec, reg=reg, provider=provider, secrets=secrets, http=http)
    result.pop("output")
    row = {"org_id": run["org_id"], "eval_run_id": run["id"], "eval_case_id": case["id"], "agent_id": agent["id"], **result}
    await db.insert("eval_results", row)
    return row


async def run_eval(db: Any, run_id: str, provider_factory: Any, secrets_factory: Any, http: Any) -> None:
    """Background job. Never raises; failures are stored on the run."""
    if not await db.update("eval_runs", {"status": "running", "started_at": now_iso()},
                           filters={"id": run_id, "status": "queued"}):
        return
    run = (await db.select("eval_runs", filters={"id": run_id}))[0]
    try:
        spec = parse_agent_markdown(run["source_md"])
        reg = await load_registry(db, run["org_id"])
        agent = (await db.select("agents", filters={"id": run["agent_id"]}))[0]
        cases = await db.select("eval_cases", filters={"agent_id": run["agent_id"], "status": "active"},
                                order="created_at.desc", limit=reg.settings.eval_max_cases)
        provider = await provider_factory(run["org_id"], model=run.get("model") or spec.model,
                                          org_default_model=reg.settings.default_model)
        secrets = await secrets_factory(run["org_id"])
        # ponytail: cases run sequentially; bound them with a semaphore if eval latency matters.
        results = [await _run_case(db, run, c, spec, reg, agent, provider, secrets, http) for c in cases]
        await db.update("eval_runs", {"status": "completed", "summary": summarize(results, cases), "completed_at": now_iso()},
                        filters={"id": run_id})
    except (SpecError, ProviderNotConfigured, LLMError) as e:
        await db.update("eval_runs", {"status": "failed", "error": str(e)[:1000], "completed_at": now_iso()}, filters={"id": run_id})
    except Exception as e:
        log.exception("eval run %s crashed", run_id)
        await db.update("eval_runs", {"status": "failed", "error": f"internal error: {type(e).__name__}",
                                      "completed_at": now_iso()}, filters={"id": run_id})


# --- activation gate -----------------------------------------------------------------------------


async def check_activation_gate(db: Any, settings: OrgSettings, agent_id: str, source_md: str) -> dict[str, Any] | None:
    """Block activating a spec that has not been evaluated, or that regressed. Returns gate evidence."""
    if not settings.require_eval_for_activation:
        return None
    if not await db.select("eval_cases", filters={"agent_id": agent_id, "status": "active"}, limit=1):
        return {"skipped": "no evaluation cases yet"}
    runs = await db.select("eval_runs", filters={"agent_id": agent_id, "source_sha256": sha256(source_md), "status": "completed"},
                           order="completed_at.desc", limit=1)
    if not runs:
        raise SpecError(["activation requires a completed evaluation of this exact specification; run one first"])
    s = runs[0]["summary"]
    required = max(settings.eval_min_pass_rate, s.get("baseline_pass_rate", 0.0))
    if s.get("pass_rate", 0.0) + 1e-9 < required:
        raise SpecError([f"activation blocked: evaluation passed {s['passed']}/{s['cases']} ({s['pass_rate']:.0%}), "
                         f"below the required {required:.0%} (recorded baseline {s.get('baseline_pass_rate', 0):.0%})"])
    return {"eval_run_id": runs[0]["id"], "pass_rate": s["pass_rate"], "required": required}


# --- model statistics & routing ------------------------------------------------------------------


async def model_stats(db: Any, org_id: str, agent_id: str | None = None) -> list[dict[str, Any]]:
    """Per (agent, model): verified runs, pass rate and cost per verified task, from live runs and evals."""
    filters: dict[str, Any] = {"org_id": org_id}
    if agent_id:
        filters["agent_id"] = agent_id
    execs = await db.select("agent_executions", filters=filters, order="started_at.desc", limit=2000,
                            columns="agent_id,model,cost_usd,input_tokens,output_tokens,verification,started_at,finished_at")
    evals = await db.select("eval_results", filters=filters, order="created_at.desc", limit=2000,
                            columns="agent_id,model,cost_usd,tokens,passed")
    acc: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {"runs": 0, "passed": 0, "cost": 0.0, "costed": 0,
                                                                       "tokens": 0, "live": 0, "eval": 0, "secs": 0.0, "timed": 0})
    for e in execs:
        if not e.get("verification") or not e.get("model"):
            continue  # infrastructure failures say nothing about model quality
        a = acc[(e["agent_id"], e["model"])]
        a["runs"] += 1
        a["live"] += 1
        a["passed"] += 1 if e["verification"].get("passed") else 0
        a["tokens"] += (e.get("input_tokens") or 0) + (e.get("output_tokens") or 0)
        if e.get("cost_usd") is not None:
            a["cost"] += float(e["cost_usd"])
            a["costed"] += 1
        if e.get("started_at") and e.get("finished_at"):
            a["secs"] += (parse_ts(e["finished_at"]) - parse_ts(e["started_at"])).total_seconds()
            a["timed"] += 1
    for r in evals:
        if not r.get("model"):
            continue
        a = acc[(r["agent_id"], r["model"])]
        a["runs"] += 1
        a["eval"] += 1
        a["passed"] += 1 if r.get("passed") else 0
        a["tokens"] += r.get("tokens") or 0
        if r.get("cost_usd") is not None:
            a["cost"] += float(r["cost_usd"])
            a["costed"] += 1
    out = []
    for (agent, model), a in acc.items():
        out.append({"agent_id": agent, "model": model, "runs": a["runs"], "passed": a["passed"],
                    "pass_rate": a["passed"] / a["runs"], "live_runs": a["live"], "eval_runs": a["eval"],
                    "avg_tokens": a["tokens"] / a["runs"],
                    "total_cost_usd": a["cost"] if a["costed"] else None,
                    "avg_cost_usd": a["cost"] / a["costed"] if a["costed"] else None,
                    "avg_duration_s": a["secs"] / a["timed"] if a["timed"] else None,  # live runs only
                    "cost_per_pass": (a["cost"] / a["passed"]) if a["costed"] and a["passed"] else None})
    return sorted(out, key=lambda r: (r["agent_id"], -r["pass_rate"]))


async def choose_model(db: Any, reg: OrgRegistry, spec: AgentSpec, agent_id: str | None) -> tuple[str | None, str]:
    """Pick the model for a task. Returns (model or None for the org default, human-readable reason)."""
    if spec.model:
        return spec.model, "pinned in the agent spec"
    s = reg.settings
    if s.model_routing != "auto" or not s.routing_models or not agent_id:
        return None, "organization default model"
    stats = {r["model"]: r for r in await model_stats(db, reg.org_id, agent_id)}
    eligible = []
    for model in s.routing_models:
        st = stats.get(model)
        if st and st["runs"] >= s.routing_min_runs and st["pass_rate"] >= s.routing_target_pass_rate:
            cost = st["cost_per_pass"] if st["cost_per_pass"] is not None else float("inf")
            eligible.append((cost, model))
    if not eligible:
        return None, (f"auto-routing: no candidate model has {s.routing_min_runs}+ verified runs at "
                      f"{s.routing_target_pass_rate:.0%}+ yet; using the default")
    cost, model = min(eligible)
    st = stats[model]
    price = "unknown cost" if cost == float("inf") else f"${cost:.4f} per verified task"
    return model, f"auto-routing: cheapest model meeting the bar ({st['pass_rate']:.0%} verified over {st['runs']} runs, {price})"


# --- forecasts -----------------------------------------------------------------------------------


async def forecast_plan(db: Any, reg: OrgRegistry, plan: Plan, default_model: str | None) -> dict[str, Any]:
    """Expected success, cost and duration of a plan from this organization's verified history (live runs and
    evaluations) for each agent on the model it would use. No history means no number: unknown stays unknown."""
    stats = {(s["agent_id"], s["model"]): s for s in await model_stats(db, reg.org_id)}
    rows: dict[str, dict[str, Any]] = {}
    for t in plan.tasks:
        agent = reg.agents[t.agent_id]
        model = (await choose_model(db, reg, agent.spec, agent.agent_id))[0] or default_model
        s = stats.get((agent.agent_id, model))
        n = min(agent.spec.escalation.max_attempts, reg.settings.max_attempts)
        row: dict[str, Any] = {"key": t.key, "agent": t.agent_id, "model": model, "runs": s["runs"] if s else 0,
                               "max_attempts": n, "pass_rate": None, "success": None, "cost_usd": None, "duration_s": None}
        if s:
            fail = 1 - s["pass_rate"]
            attempts = sum(fail ** k for k in range(n))  # expected attempts with retries on failure
            row |= {"pass_rate": s["pass_rate"], "success": 1 - fail ** n, "expected_attempts": attempts,
                    "cost_usd": s["avg_cost_usd"] * attempts if s["avg_cost_usd"] is not None else None,
                    "duration_s": s["avg_duration_s"] * attempts if s["avg_duration_s"] is not None else None}
        rows[t.key] = row

    def known(field: str) -> bool:
        return all(r[field] is not None for r in rows.values())

    deps = {t.key: t.depends_on for t in plan.tasks}
    finish: dict[str, float] = {}

    def end(key: str) -> float:  # longest path through the DAG (plans are validated to be acyclic)
        if key not in finish:
            finish[key] = max((end(d) for d in deps[key]), default=0.0) + rows[key]["duration_s"]
        return finish[key]

    if known("duration_s"):
        for key in rows:
            end(key)
    return {
        "tasks": list(rows.values()),
        "success": math.prod(r["success"] for r in rows.values()) if known("success") else None,
        "cost_usd": sum(r["cost_usd"] for r in rows.values()) if known("cost_usd") else None,
        "duration_s": max(finish.values()) if finish else None,
        "known_tasks": sum(1 for r in rows.values() if r["success"] is not None), "total_tasks": len(rows),
        "computed_at": now_iso(),
    }


# --- replays -------------------------------------------------------------------------------------


async def create_replay(db: Any, org_id: str, execution_id: str, actor_id: str, actor_label: str, *,
                        source_md: str | None = None, model: str | None = None) -> dict[str, Any]:
    execs = await db.select("agent_executions", filters={"id": execution_id, "org_id": org_id})
    if not execs or not execs[0].get("agent_id"):
        raise SpecError(["execution not found"])
    ex = execs[0]
    agent = (await db.select("agents", filters={"id": ex["agent_id"]}))[0]
    if source_md is None:
        version = await db.select("agent_versions", filters={"id": ex.get("agent_version_id") or ""}) if ex.get("agent_version_id") else []
        if not version:
            raise SpecError(["the execution has no pinned spec version; provide source_md"])
        source_md = version[0]["source_md"]
    spec = parse_agent_markdown(source_md)
    if spec.id != agent["slug"]:
        raise SpecError([f"id: a replay must keep the agent id '{agent['slug']}'"])
    row = (await db.insert("replays", {"org_id": org_id, "execution_id": execution_id, "agent_id": agent["id"],
                                       "source_md": source_md, "model": model, "status": "queued", "created_by": actor_id}))[0]
    await record_audit(db, org_id, "execution.replay", "execution", actor_id=actor_id, actor_label=actor_label,
                       resource_id=execution_id, resource_name=agent["name"], details={"replay_id": row["id"], "model": model})
    return row


async def run_replay(db: Any, replay_id: str, provider_factory: Any, secrets_factory: Any, http: Any) -> None:
    """Background job: re-run a past attempt against its recorded tool results. Never raises."""
    if not await db.update("replays", {"status": "running"}, filters={"id": replay_id, "status": "queued"}):
        return
    rp = (await db.select("replays", filters={"id": replay_id}))[0]
    try:
        ex = (await db.select("agent_executions", filters={"id": rp["execution_id"]}))[0]
        task = (await db.select("tasks", filters={"id": ex["task_id"]}))[0]
        wf = (await db.select("workflows", filters={"id": ex["workflow_id"]}))[0]
        agent = (await db.select("agents", filters={"id": rp["agent_id"]}))[0]
        spec = parse_agent_markdown(rp["source_md"])
        reg = await load_registry(db, rp["org_id"])
        case = await db.select("eval_cases", filters={"source_execution_id": ex["id"]})
        if case:  # prerequisite outputs exactly as the original attempt saw them
            prerequisites = case[0]["prerequisites"]
        else:
            deps = await db.select("tasks", filters={"id": ("in", task["depends_on"])}) if task["depends_on"] else []
            prerequisites = [{"key": d["key"], "agent_slug": d["agent_slug"], "output": d.get("output")} for d in deps
                             if d["status"] == "completed"]
        provider = await provider_factory(rp["org_id"], model=rp.get("model") or spec.model,
                                          org_default_model=reg.settings.default_model)
        fields = {k: task.get(k) for k in ("key", "title", "description", "expected_output", "acceptance_criteria")}
        result = await _attempt(db, task_id=task["id"], org_id=rp["org_id"], agent=agent,
                                task_fields={**fields, "objective": wf.get("objective")}, prerequisites=prerequisites,
                                recordings=ex.get("tool_recordings") or [], spec=spec, reg=reg, provider=provider,
                                secrets=await secrets_factory(rp["org_id"]), http=http)
        await db.update("replays", {**result, "status": "completed", "completed_at": now_iso()}, filters={"id": replay_id})
    except (SpecError, ProviderNotConfigured, LLMError) as e:
        await db.update("replays", {"status": "failed", "error": str(e)[:1000], "completed_at": now_iso()}, filters={"id": replay_id})
    except Exception as e:
        log.exception("replay %s crashed", replay_id)
        await db.update("replays", {"status": "failed", "error": f"internal error: {type(e).__name__}",
                                    "completed_at": now_iso()}, filters={"id": replay_id})
