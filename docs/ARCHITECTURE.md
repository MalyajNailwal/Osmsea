# OSMSEA architecture

```
Browser (Next.js)                         FastAPI process (backend/src/osmsea)             Supabase
─────────────────                         ────────────────────────────────────             ────────
reads ── supabase-js + user JWT ──────────────────────────────────────────────────────►  Postgres (RLS)
live  ◄─ Realtime postgres_changes (RLS-filtered) ◄─────────────────────────────────────  Realtime
writes ─ fetch + Bearer JWT ─► api.py ── role check ── orgs.py / planner.py ── service ►  PostgREST
                                         │                                     role
                                         └─► scheduler.Worker (asyncio loop)
                                               ├─ planner.plan_workflow ─► LLM provider (OpenRouter / OpenAI-compatible)
                                               ├─ executor.execute ──────► tools.py (fetch_url / web_search / memory_search)
                                               └─ verify.verify_output ──► reviewer model call
```

**Reads** go straight from the browser to Supabase and are limited by row-level security to the
member's organizations. **Writes and model calls** go through FastAPI, which validates the Supabase
session, checks the member's role (viewer < member < admin < owner) and writes with the service role.
Client roles have no INSERT/UPDATE/DELETE privileges at all.

## Backend modules

| Module | Responsibility |
|--------|----------------|
| `specs.py` | `AgentSpec`, `DepartmentSpec`, `OrgSettings`; Markdown/YAML parsing; safe directory loader |
| `schemas.py` | Trusted output schemas (`research_result_v1`, `code_change_v1`, `report_v1`), `Plan`, `Review` |
| `tools.py` | Tool registry and adapters; SSRF-safe fetch with DNS pinning; evidence reporting |
| `mcp_client.py` | MCP client (Streamable HTTP): discovery, tool calls, argument validation, credential headers, error mapping |
| `registry.py` | Per-org runtime view: active spec versions (re-validated), settings, configured providers, effective tools |
| `llm.py` | Provider protocol, OpenAI-compatible adapter, transient-error retry, scripted provider for tests |
| `integrations.py` | Provider catalog, credential tests, Vault-backed resolution of model and tool credentials |
| `planner.py` | Plan generation (forced tool call), validation (DAG, agents, limits), requirements, approve/reject |
| `executor.py` | One task attempt: prompt assembly, bounded tool loop, permission enforcement, output validation |
| `verify.py` | Deterministic checks and independent review |
| `scheduler.py` | Worker loop: promote/claim/run/finish, retries, cancellation, recovery, artifacts and memory |
| `orgs.py` | Organization, department, agent-version, settings, integration and memory configuration, with audit |
| `auth.py` / `api.py` | Session validation, role checks, HTTP routes |
| `store.py` | `SupabaseStore` (PostgREST) and `MemoryStore` (tests) behind one small table API |

## Data model

Configuration: `organizations` (settings JSON validated as `OrgSettings`), `organization_members`,
`departments`, `agents`, `agent_versions` (immutable source Markdown plus parsed spec), `integrations`,
`integration_secrets` (Vault references, service role only), `mcp_servers` (URL, discovered tool
catalog, approved tools, approval policy) and `mcp_server_secrets` (Vault references, service role only).

Execution state: `workflows` (goal, plan, permissions, budget, usage, cost), `tasks` (dependencies as
task ids, pinned `agent_version_id`, lease, attempt, output, verification), `agent_executions` (one per
attempt, unique on `(task_id, attempt)`, with step log, tokens, cost), `execution_events`, `approvals`,
`artifacts`, `memory_items` (full-text indexed), `audit_events`.

## A workflow, end to end

1. `POST /orgs/{org}/workflows` inserts a `planning` workflow and starts a planning job.
2. The planner sees only an agent catalog (role, mission, capabilities, limitations, effective tools),
   never instructions or secrets. It must answer through the `submit_plan` tool. Invalid plans get one
   retry with the errors, then the workflow is marked `plan_failed`.
3. The backend computes required permissions and whether approval is needed, inserts tasks, and creates
   an approval when required.
4. On approval, each task is pinned to the agent version that is active at that moment.
5. The worker queues tasks whose dependencies completed, emits `handoff` events, and claims tasks with a
   compare-and-swap on `(status, attempt)` plus a 60-second lease that is renewed while running.
6. The executor builds a prompt: platform rules, the agent's own instructions, the task, verified
   prerequisite outputs and relevant memory, all marked as untrusted data. It exposes only the effective
   tools plus `submit_result`, which carries the trusted schema.
7. `verify.py` runs the checks. Pass: the task completes, and artifacts and memory are written by trusted
   code. Fail: the task is retried with the failure as feedback, or marked failed with dependents blocked.
8. Every state change reaches the UI through Realtime.

## Security boundaries

- Tool permission = spec request ∩ org tool policy ∩ configured integrations ∩ approved plan,
  re-checked on every call. Calls outside that set are denied, logged as `tool_denied`, and audited.
- MCP tools: a spec may request `mcp__<server>__<tool>`, but the tool is usable only if an admin
  approved it on a connected, enabled server. Arguments are validated against the discovered JSON
  Schema before any call. The credential is injected server-side. Output is clipped and fenced as
  untrusted, and every call is written to the audit log. Plans using MCP tools require approval
  unless the server opts out. Server URLs must be public https endpoints.
- `fetch_url`: http(s) only; ports 80, 443, 8080 and 8443 only; no URL credentials. Every resolved
  address must be public, and the connection is pinned to the checked IP, so DNS rebinding cannot
  redirect it. Redirects are re-checked. Size and time are capped. Only text content types are read.
- Credentials: Vault only. RPCs are executable by `service_role` only. Values never appear in API
  responses, prompts or logs; the UI shows the last four characters.
- Prompt injection: tool output, prerequisites and memory are wrapped as untrusted data and closing tags
  are neutralized. Memory is written only by trusted code after verification, or by members (labelled
  human-added).
- Stored: tool calls (arguments, a short result preview, latency), validated outputs, verification
  results and summaries. Model reasoning is not requested or stored.

## Known ceilings (deliberate simplifications)

| Simplification | Upgrade path |
|----------------|--------------|
| Scheduler polls PostgREST every second inside the API process | Same `Worker` code in its own process; wake it with Postgres `LISTEN/NOTIFY` |
| Auth validation calls Supabase Auth per token (60 s cache) | Verify JWTs locally against the project JWKS |
| Org creation is several PostgREST calls with a compensating delete | A single SQL function, if partial failures become a concern |
| An interrupted attempt restarts the task from the beginning | Persist conversation state for mid-task resume, only if tools become side-effecting |
| Admin-supplied LLM base URLs are checked at call time, not pinned | Pin DNS the way `fetch_url` does |
| MCP: one session per tool call; URLs checked at registration/refresh, not pinned | Pool sessions per execution; pin DNS through a custom `httpx2` transport |
| MCP: remote Streamable HTTP servers with static credentials only | Add OAuth flows and sandboxed stdio servers |
