# Policies

Governance rules for every organization, and where each rule is enforced. Markdown describes the
rules; **enforcement is always in backend code or database policy.**

| Rule | Enforced in |
|------|-------------|
| Members can only read their own organization's data | Postgres RLS (`is_org_member`) on every table |
| All writes go through the backend, which checks the member's role | FastAPI dependencies in `api.py`; no write policies exist for client roles |
| Credentials are never readable by clients | Supabase Vault; secret RPCs are executable only by `service_role` |
| Agents only call tools they are permitted to use | `registry.effective_tools` + executor checks on every call |
| MCP tools are usable only when approved per tool on a connected server; calls are schema-checked and audited | `orgs.update_mcp_server`, `registry.load_registry`, `executor._call_mcp` |
| Tool permissions = spec request ∩ org policy ∩ configured integrations ∩ approved plan | `registry.py`, `executor.py` |
| Plans need approval when configured | `planner.compute_requirements`, `api.approve_workflow` |
| No shell access, no filesystem access, no private-network fetches | Tool registry has no such tools; `fetch_url` blocks non-public addresses and pins DNS |
| Tool output is untrusted | Executor wraps tool output as data; memory only stores verified results |
| A task completes only after verification | `verify.py`: schema, deterministic checks, independent review |
| Concurrency, timeouts, attempts and token budgets | `OrgSettings` (validated) + `scheduler.py` |
| Every configuration change and security denial is audited | `audit_events` table, written by the backend |
| Agent code runs only in the offline, unprivileged, resource-limited sandbox, and only during verification | `sandbox.py`, `verify.run_tests` |
| External AI clients act through revocable org tokens and cannot approve plans | `automation.resolve_token`, `mcp_server.py` (no approval tool) |
| Invitations work once, expire, and only for the invited confirmed email; the owner cannot be demoted or removed | `members.py` |
| Webhook payloads are untrusted data; automated plans need approval by default | `planner.generate_plan` (`<event>` block), `triggers.require_approval`, `planner.save_plan` |

## Roles

| Role | Can |
|------|-----|
| `viewer` | Read everything in the organization |
| `member` | + submit goals, run automations now, replay past attempts |
| `admin` | + approve or reject plans, cancel runs, edit agents, settings, integrations, API tokens, automations; invite, re-role and remove members |
| `owner` | + everything an admin can do; is the organization's creator |

## Sensitive tools

Each tool can be disabled per organization, or marked *requires approval*. A plan that needs an
approval-gated tool always waits for explicit approval, even if the organization has turned off
general plan approval. Plans that use MCP tools need approval by default; an admin can turn this off per server.
Mid-task approval of individual tool calls is **not implemented yet**.

## What is stored

Execution records keep tool calls (name, arguments, outcome, a short preview of the result), the
validated output, verification results and concise decision summaries. Private model reasoning is
not requested or stored.
