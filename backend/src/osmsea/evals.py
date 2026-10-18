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
from collections import defaultdict
from typing import Any

from .executor import BudgetExceeded, ExecutionContext, Outcome, execute
from .integrations import ProviderNotConfigured
from .llm import LLMError, LLMResponse
from .registry import OrgRegistry, load_registry
from .specs import AgentSpec, OrgSettings, SpecError, parse_agent_markdown
from .store import StoreError, now_iso, record_audit
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


async def _run_case(db: Any, run: dict[str, Any], case: dict[str, Any], spec: AgentSpec, reg: OrgRegistry,
                    agent: dict[str, Any], provider: Any, secrets: dict[str, str], http: Any) -> dict[str, Any]:
    settings = reg.settings
    task = {"id": case["id"], "org_id": run["org_id"], "workflow_id": None, "agent_id": agent["id"],
            "agent_slug": agent["slug"], "attempt": 1, "error": None, **(case["task"] or {})}
    ctx = ExecutionContext(
        db=db, provider=provider, registry=reg,
        workflow={"id": None, "goal": task.get("objective") or task["title"], "objective": task.get("objective")},
        task=task, execution_id="", agent_version={"version": "candidate"}, spec=spec,
        approved_tools=set(spec.allowed_tools), tool_context=ToolContext(run["org_id"], db, http, secrets),
        prerequisites=case.get("prerequisites") or [], persist=False,
        replay={r["sig"]: r for r in case.get("recordings") or []},
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
    row = {
        "org_id": run["org_id"], "eval_run_id": run["id"], "eval_case_id": case["id"], "agent_id": agent["id"],
        "passed": outcome.succeeded, "verification": outcome.verification, "error": outcome.error,
        "cost_usd": totals["cost"], "tokens": totals["tokens"], "model": totals["model"] or provider.model,
        "steps": outcome.steps, "duration_ms": int((time.monotonic() - started) * 1000),
        "replayed": sum(1 for s in outcome.steps if s.get("replayed")),
        "live_calls": sum(1 for s in outcome.steps if s.get("type") == "tool" and not s.get("replayed")),
    }
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
                            columns="agent_id,model,cost_usd,input_tokens,output_tokens,verification")
    evals = await db.select("eval_results", filters=filters, order="created_at.desc", limit=2000,
                            columns="agent_id,model,cost_usd,tokens,passed")
    acc: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {"runs": 0, "passed": 0, "cost": 0.0, "costed": 0,
                                                                       "tokens": 0, "live": 0, "eval": 0})
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
