# OSMSEA features

Everything that works today, in detail. The [README](../README.md) has the short version; [ARCHITECTURE.md](ARCHITECTURE.md) explains how it fits together.

- Agent specs in Markdown with strict validation: unknown tools, unknown output schemas, duplicate ids,
  mismatched departments, path escapes and typos in field names are all rejected.
- Organizations from the template or from a natural-language goal (Builder), with editing of departments
  and agents. Each agent edit creates a new validated, versioned spec; running tasks keep their pinned version.
- Goal → structured plan (objective, criteria, tasks, agents, dependencies). Python validates the plan:
  cycles, unknown agents and dangling dependencies are rejected. The backend computes permissions and the
  approval requirement.
- Approval gate. Scheduler: dependency-aware, per-org concurrency, lease-based claims, bounded retries with
  feedback, timeouts, token budgets, cancellation, restart recovery.
- Agent execution with an allow-listed tool set: `fetch_url` (SSRF-guarded, DNS-pinned), `web_search`
  (Tavily or Brave key required), `memory_search`. Unauthorized tool calls are denied and audited.
- **MCP server integration.** Register remote MCP servers (Streamable HTTP, optional credential kept in Vault).
  OSMSEA discovers their tools, and an admin approves individual tools, which agents request as
  `mcp__<server>__<tool>`. Arguments are validated against the tool's schema, output is treated as
  untrusted, every call is audited, and plans using MCP tools need approval by default.
- Verification: schema validation; cited sources must have been retrieved during the same execution;
  minimum sources; Python/JSON/TOML/YAML parse checks; an independent reviewer model judges the
  acceptance criteria. Artifacts and verified findings are stored with provenance.
- **Self-improving agents** (agent → Improve tab):
  - **Evaluation cases ("CI for agents").** Every attempt that reaches verification is frozen as a
    regression case, together with the full results of its tool calls.
  - **Replayed evaluations.** An evaluation replays those cases against a spec or model. Recorded tool
    calls are answered from the recording, MCP tools never run live, and real tasks are never touched.
    Results are compared with the recorded baseline.
  - **Activation gate (optional).** A new agent version goes live only after an evaluation of that exact
    spec passes at least as many cases as before.
  - **Improvement proposals.** A model drafts a revised spec from the agent's failure patterns: failed
    checks and the criteria the reviewer marked unmet. The backend rejects any proposal that adds tools,
    disables a verification check or changes the agent's identity. Each proposal is evaluated, then an
    admin accepts or rejects it.
  - **Cost-aware model routing (optional).** For each agent, OSMSEA tracks pass rate and cost per
    verified task for each model, from real runs and evaluations. Auto-routing picks the cheapest model
    that meets the org's quality bar. A model pinned in a spec always wins, and every execution records
    why its model was chosen.
- **Tests that actually run.** Agents with `verification.run_tests` (the template developer) must ship pytest
  tests and a `test_command`. Verification runs them in a locked-down Docker container: no network, read-only
  root filesystem, unprivileged user, no capabilities, and memory, CPU, process and time limits. Files go in
  as a tar stream and nothing from the host is mounted. A failing test fails the task, and its output becomes
  the feedback for the next attempt. The reviewer sees the trusted exit code.
- **OSMSEA as an MCP server.** Claude Code, Cursor, Claude Desktop or any MCP client can connect to `/mcp`
  with an organization API token. It exposes `list_agents`, `submit_goal`, `get_workflow` (with waiting)
  and `search_memory`. Clients cannot approve plans: plans that need approval wait for a human in the UI.
  Tokens are stored hashed, shown once, revocable and audited.
- **Automations.** Goals can run on a schedule (every 15 minutes to every year) or from a webhook, with the
  secret in a Bearer header or `?token=`. Webhook payloads reach the planner only as untrusted data. Plans
  from automations need approval by default, and a run is skipped while the previous one is still active.
- **Forecasts before approval.** Every plan comes with an expected chance of success, cost (retries
  included) and duration (critical path). Each task's figures come from that agent's verified history on
  the model it will use. Tasks with no history stay unknown rather than guessed. After the run, the
  forecast is shown next to the actual results.
- **Replay & fork.** Any past attempt can be re-run with an edited spec or another model. Recorded tool
  results answer the same calls, verification runs exactly as in production, and nothing real is touched.
  Original and replay are compared side by side: checks, output, steps and spec diff.
- **Members.** Admins create invite links that are single-use, expire after 7 days and work only for the
  invited, confirmed email. Admins can also change roles and remove members, and anyone can leave. The
  owner's membership is protected.
- **Spaces: chat with your agents.** Group conversations where people and agents work together:
  - **Personas.** Each agent has its own face colour, tagline and speaking voice.
  - **Persona library.** Eight ready-made agents: Trip Planner, Budget Keeper, Content Writer, Market Scout,
    Support Agent, Meeting Scribe, Code Reviewer and Data Analyst.
  - **Your own agents.** Describe your use case and get a drafted agent to review, or start from a library
    persona.
  - **Conversation.** Agents answer when mentioned ("Trip Planner, …" or `@trip-planner`) and consult each
    other in visible collaboration threads.
  - **Approvals.** A tool that needs approval pauses the turn behind an inline Allow/Deny card, and the
    turn resumes once an admin decides.
  - **Verified work.** Bigger jobs are handed to verified workflows, which post their results back into
    the space.
- **Knowledge base.** Upload PDFs, Markdown, text, HTML, CSV or code, or save a web page. OSMSEA splits
  each document into passages and indexes them for full-text search (PDF passages keep their page
  numbers). Agents find passages with `knowledge_search` and cite them as `doc:<document>/<passage>`.
  The citation check accepts only passages the agent actually retrieved in that run.
- **Deliveries with approval (GitHub pull requests).** When a developer task passes verification
  (including its sandboxed tests), OSMSEA proposes a draft pull request built from the verified files.
  It is built by OSMSEA itself, not from model-chosen arguments. Nothing touches GitHub until an admin
  approves, and the PR body lists the verification results. Changes under `.github/` (CI workflows) are
  never delivered. Uses a fine-grained token limited to one repository.
- Live UI over real data through Supabase Realtime. Audit log of configuration changes, approvals and
  security denials.
