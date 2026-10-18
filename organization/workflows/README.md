# Workflows

A workflow is one user goal carried from plan to verified result. This page documents the
lifecycle; the behaviour itself lives in `backend/src/osmsea/planner.py` and `scheduler.py`.

## Lifecycle

```
goal ─► planning ─► awaiting_approval ─► running ─► completed
           │               │                │
           ▼               ▼                ├─► failed     (a task failed after its retries)
      plan_failed       rejected            └─► cancelled  (user cancelled)
```

1. **Planning.** The planner sees only a catalog of active agents (id, role, mission, capabilities and
   the tools they can effectively use) and asks the configured model for a structured plan:
   objective, acceptance criteria, tasks, agent assignments, dependencies and expected outputs.
2. **Validation.** Python code rejects plans with unknown or inactive agents, duplicate task keys,
   dangling or circular dependencies, or too many tasks. Required permissions and whether approval is
   needed are **computed by the backend** from agent specs and organization policy, not taken from
   the model.
3. **Approval.** If the organization requires plan approval (the default), or the plan needs a tool
   whose policy demands approval, the workflow waits in `awaiting_approval`. Approving pins each task
   to the agent specification version that was active at that moment.
4. **Scheduling.** A task becomes `queued` once every dependency is `completed`. Workers claim queued
   tasks atomically under a lease, within the organization's concurrency limit.
5. **Execution and verification.** See `policies/README.md` for what a task may do and how its
   output is checked. A task is `completed` only after verification passes.
6. **Failure.** Failed attempts are retried up to the limit, with backoff. A task that exhausts its
   attempts is `failed`; tasks depending on it become `blocked`, and the workflow ends `failed`.

## Task states

| State | Meaning |
|-------|---------|
| `awaiting_approval` | Plan not yet approved |
| `pending` | Approved, waiting for dependencies |
| `queued` | Dependencies satisfied, waiting for a worker slot |
| `running` | An agent is executing the task |
| `verifying` | Output is being checked against schema, evidence and acceptance criteria |
| `completed` | Verification passed |
| `failed` | All attempts failed (error, timeout, budget, or verification) |
| `blocked` | A dependency failed or was cancelled |
| `cancelled` | The user cancelled the workflow |

## Restarts

Running tasks hold a lease that is renewed while the worker is alive. After a restart, tasks whose
lease expired are re-queued from the beginning (a new attempt) if attempts remain, or marked failed
otherwise. In-flight model calls are not resumed mid-conversation; the event log records that the
attempt was abandoned.
