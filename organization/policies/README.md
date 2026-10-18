# Policies

Governance rules for every organization, and where each rule is enforced. Markdown describes the
rules; **enforcement is always in backend code or database policy.**

| Rule | Enforced in |
|------|-------------|
| Members can only read their own organization's data | Postgres RLS (`is_org_member`) on every table |
| All writes go through the backend, which checks the member's role | FastAPI dependencies in `api.py`; no write policies exist for client roles |
| Credentials are never readable by clients | Supabase Vault; secret RPCs are executable only by `service_role` |
| Agents only call tools they are permitted to use | `registry.effective_tools` + executor checks on every call |
| Tool permissions = spec request ∩ org policy ∩ configured integrations ∩ approved plan | `registry.py`, `executor.py` |
| Plans need approval when configured | `planner.compute_requirements`, `api.approve_workflow` |
| No shell access, no filesystem access, no private-network fetches | Tool registry has no such tools; `fetch_url` blocks non-public addresses and pins DNS |
| Tool output is untrusted | Executor wraps tool output as data; memory only stores verified results |
| A task completes only after verification | `verify.py`: schema, deterministic checks, independent review |
| Concurrency, timeouts, attempts and token budgets | `OrgSettings` (validated) + `scheduler.py` |
| Every configuration change and security denial is audited | `audit_events` table, written by the backend |

## Roles

| Role | Can |
|------|-----|
| `viewer` | Read everything in the organization |
| `member` | + submit goals |
| `admin` | + approve or reject plans, cancel runs, edit agents, settings and integrations |
| `owner` | + everything an admin can do; is the organization's creator |

## Sensitive tools

Each tool can be disabled per organization, or marked *requires approval*. A plan that needs an
approval-gated tool always waits for explicit approval, even if the organization has turned off
general plan approval. Mid-task approval of individual tool calls is **not implemented yet**.

## What is stored

Execution records keep tool calls (name, arguments, outcome, a short preview of the result), the
validated output, verification results and concise decision summaries. Private model reasoning is
not requested or stored.
