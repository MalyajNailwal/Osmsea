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
                                               ├─ executor.execute ──────► tools.py (fetch_url / web_search / memory_search) + MCP tools
                                               ├─ verify.verify_output ──► sandbox.py (docker, offline) ─► reviewer model call
                                               └─ automation.fire_due ───► scheduled triggers
AI clients ── MCP + API token ─► /mcp (mcp_server.py)        webhooks ─► /hooks/{id} (automation.py)
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
| `scheduler.py` | Worker loop: promote/claim/run/finish, retries, cancellation, recovery, artifacts and memory; background evaluation jobs |
| `evals.py` | Evaluation cases from verified attempts, replayed evaluation runs, activation gate, per-model stats and routing |
| `improve.py` | Failure analysis, policy-checked spec revision proposals, accept/reject |
| `sandbox.py` | Runs an output's tests in a locked-down Docker container (tar over stdin, no mounts, no network) |
| `mcp_server.py` | OSMSEA's own MCP server at `/mcp`: token auth, `list_agents`, `submit_goal`, `get_workflow`, `search_memory` |
| `automation.py` | Organization API tokens; schedule and webhook triggers; firing with pile-up protection |
| `members.py` | Invitation links (single-use, expiring, bound to a confirmed email), role changes, leaving |
| `chat.py` | Spaces: mention routing, persona-driven agent turns, consult threads, approval pause/resume, delegation, persona library |
| `knowledge.py` | Document upload and URL import, text extraction (pypdf for PDFs), page-aware passage chunking, search |
| `actions.py` / `github.py` | Approval-gated deliveries built from verified output; draft pull requests through the GitHub REST API |
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
`artifacts`, `memory_items` (full-text indexed), `audit_events`. Each execution also stores its full
tool results (`tool_recordings`) and its model-routing decision (`routing`).

Automation: `api_tokens` (SHA-256 of the token, prefix, creator, last use, revocation) and `triggers`
(schedule interval and next run, or a hashed webhook secret; approval policy; last run). Workflows record
the `trigger_id`, a `force_approval` flag and the untrusted event `context`.

Spaces: `spaces` (name, description, primary agent), `space_agents`, `space_messages` (author, kind
`text|collaboration|approval|workflow`, status, `thread_id` for collaboration threads, `data`) and
`space_reads` (per-user read markers for unread badges). `workflows.space_id` links delegated work back.
Agent personas (`tagline`, `voice`, `color`) live in the spec frontmatter.

Knowledge and deliveries: `documents` (title, source, hash for deduplication, page and passage counts),
`document_chunks` (page, heading, passage text, generated `tsvector`, GIN index, searched by the
`search_documents` RPC) and `actions` (one per task and kind: a preview payload for the approver, status,
result such as the pull request URL, and the admin decision).

Collaboration and debugging: `workflows.forecast` (computed at planning by `evals.forecast_plan`),
`replays` (an edited spec and/or model re-run against an execution's recorded tool results, with its
output, verification, steps and cost) and `invitations` (hashed token, email, role, expiry, acceptance).

Self-improvement: `eval_cases` (one per verified attempt: task, prerequisite outputs, tool recordings,
baseline result), `eval_runs` (a spec, identified by SHA-256, optionally with a model, replayed against
cases), `eval_results` (one per case and run) and `agent_proposals` (a proposed spec, its rationale and
failure report, its evaluation run and the admin decision). Client roles can only read these tables.

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

## Forecasts

When a plan is saved, `forecast_plan` estimates each task from that agent's verified runs and evaluations
on the model `choose_model` would pick. The pass rate per attempt p and max attempts n give a success
chance of 1 − (1 − p)ⁿ and an expected Σ (1 − p)ᵏ attempts. Expected cost and time scale the per-attempt
averages by that. The workflow total is the product of the task success chances, the sum of the task
costs, and the longest path through the DAG for duration. Any task without history makes the
corresponding total `null`: the UI shows "unknown", never an invented number.

## Self-improvement loop

1. **Record.** When an attempt reaches verification (pass or fail), the scheduler freezes it as an
   `eval_case`, before the task is marked finished.
2. **Evaluate.** `POST /orgs/{org}/agents/{id}/evals` queues one run per spec or model, and the worker
   replays the cases. The executor runs with `persist=False`, so it writes no task, execution, event or
   audit rows. Its `replay` map answers recorded calls by `(tool, canonical JSON arguments)`.
   Unrecorded built-in read-only tools run live. Unrecorded MCP calls return an error, because MCP tools
   may have side effects. Verification, including the independent reviewer, runs exactly as in
   production, and citation checks use the replayed evidence.
3. **Gate.** With `require_eval_for_activation`, `orgs.update_agent` (used by manual edits, restores and
   accepted proposals) requires a completed run of the exact spec hash. Its pass rate must be at least
   `max(eval_min_pass_rate, recorded baseline)`.
4. **Propose.** `improve.failure_report` aggregates the last 20 executions: failed checks, unmet
   criteria and infrastructure errors (counted separately). The revision model must answer through
   `submit_spec_revision`, and its output is treated as an untrusted draft. `policy_violations` rejects
   proposals that change id, department or output schema, add tools, or disable
   `independent_review`, `require_cited_evidence` or `syntax_check`.
5. **Decide.** Accepting a proposal creates a normal new version, and the activation gate applies.
   A proposal whose base version is no longer active is marked `superseded`.
6. **Route.** `evals.choose_model` decides the model for each task:
   - A model pinned in the spec always wins.
   - Otherwise, with `model_routing: auto`, it takes the cheapest candidate in `routing_models` that has
     at least `routing_min_runs` verified runs and at least `routing_target_pass_rate`.
   - Otherwise it uses the org default model.

   The decision and its reason are stored on the execution. Infrastructure failures are ignored when
   computing model quality.

## Security boundaries

- Sandbox: each test run is a fresh container (`--network none --read-only --cap-drop ALL
  --security-opt no-new-privileges --user 65534`, tmpfs work dirs, 512 MB, 1 CPU, 128 processes, 60 s).
  The image is never pulled at run time. Output is clipped and treated as untrusted; only the exit code is
  trusted. If Docker is unavailable, the task fails without a retry and says why.
- OSMSEA MCP server and tokens: a token is a 256-bit random value stored as SHA-256, scoped to one
  organization and acting as its creator with member rights. It stops working when revoked or when the
  creator leaves the org. Clients can submit and read but cannot approve, edit or read credentials.
  At most 10 active workflows per org can be started this way.
- Spaces: an agent turn uses the same effective tools as workflows. A tool that requires approval posts
  an Allow/Deny card instead of running. The paused transcript is stored on the card, and only an admin's
  decision resumes the turn. Consulted agents run with read-only tools, without approvals, and cannot
  consult again. Other agents' replies and tool output reach the model fenced as untrusted data.
  Delegated workflows keep their own planning, approval and verification.
- Deliveries: an action is created by trusted code only after verification passes. At approval it
  re-reads the task's verified output rather than any model-supplied arguments, runs once (pending→running
  compare-and-swap), refuses `.github/` paths, and opens a *draft* pull request on a new branch. The token
  stays in Vault and is never shown to agents. Every outcome is audited.
- Documents: uploads are capped at 10 MB and URL imports use the agents' SSRF-safe fetcher. Only the
  extracted text is stored. Passages reach agents fenced as untrusted tool output, like web pages.
- Invitations: a 256-bit token stored as SHA-256 that expires after 7 days and can be accepted once,
  only by a signed-in user whose confirmed email matches the invite. The owner cannot be demoted or
  removed, and admins cannot change their own role. Removing a member also disables their API tokens.
- Replays use the evaluation sandbox. `persist=False` means no task, execution, event or audit writes.
  Recorded calls are answered from the recording, unrecorded MCP calls are refused, and the agent id
  cannot change.
- Webhooks: unknown trigger and wrong secret give the same 404, and secrets are compared in constant
  time. Payloads are capped at 64 KB and reach the planner fenced as untrusted data. Webhook and
  schedule runs require plan approval unless an admin turns that off per trigger.

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
| Evaluation cases run sequentially, at most `eval_max_cases` per run | Bound parallelism with a semaphore |
| Model stats aggregate the latest 2,000 executions and eval results in Python | A SQL view or materialized rollup |
| Unrecorded built-in tools run live during evaluations, so their results can drift | Fail closed on unrecorded calls, if reproducibility matters more than coverage |
| Sandbox containers share the host kernel | Run the same command through gVisor (`--runtime runsc`) or a microVM provider for multi-tenant hosting |
| Schedules are fixed intervals | Cron expressions, if calendar rules are needed |
| MCP server auth is static tokens | OAuth 2.1 for clients that require it (e.g. hosted connectors) |
| Webhook secrets can travel in the query string for senders that cannot set headers | HMAC signature verification per provider |
| Forecasts treat attempts as independent and use small samples as-is | Bayesian smoothing with a prior per agent, and confidence intervals |
| Replays restart an attempt from the beginning (with recorded tools) rather than resuming at step N | Persist full model transcripts per step, if mid-run resume is needed |
| Invitation links rely on Supabase email confirmation being on to prove email ownership | Keep "Confirm email" enabled in Supabase Auth (required for production) |
| Spaces are visible to every member of the organization | Private spaces with per-space membership |
| Agents answer only when mentioned (or as the primary agent), not when they decide a message concerns them | A cheap relevance check per message, if wanted |
| Document search is lexical (Postgres full-text), not semantic | Add pgvector embeddings next to the `tsvector`, and hybrid ranking |
| Scanned PDFs have no text layer and are rejected | OCR (e.g. Tesseract) before chunking |
| GitHub delivery targets github.com and one configured repository per org | Per-agent or per-goal repositories; GitHub Enterprise base URL; GitHub App auth instead of a token |
