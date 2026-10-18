-- Self-improving organizations: evaluation suite, improvement proposals, cost-aware routing. Additive only.

alter table public.agent_executions
  add column if not exists tool_recordings jsonb not null default '[]'::jsonb,  -- full tool results, for replay
  add column if not exists routing jsonb;                                       -- which model was chosen and why

-- A verified (or verification-failed) task attempt, frozen as a regression case with its tool outputs.
create table public.eval_cases (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  agent_id            uuid not null references public.agents (id) on delete cascade,
  source_task_id      uuid references public.tasks (id) on delete set null,
  source_execution_id uuid unique references public.agent_executions (id) on delete set null,
  title               text not null,
  task                jsonb not null,
  prerequisites       jsonb not null default '[]'::jsonb,
  recordings          jsonb not null default '[]'::jsonb,
  baseline            jsonb not null default '{}'::jsonb,
  status              text not null default 'active' check (status in ('active', 'archived')),
  created_at          timestamptz not null default now()
);
create index eval_cases_agent_idx on public.eval_cases (agent_id, created_at desc);

create table public.eval_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  agent_id      uuid not null references public.agents (id) on delete cascade,
  kind          text not null default 'manual' check (kind in ('manual', 'proposal', 'model_compare')),
  source_md     text not null,
  source_sha256 text not null,
  model         text,
  status        text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  summary       jsonb not null default '{}'::jsonb,
  error         text,
  proposal_id   uuid,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz
);
create index eval_runs_agent_idx on public.eval_runs (agent_id, created_at desc);
create index eval_runs_sha_idx on public.eval_runs (agent_id, source_sha256);

create table public.eval_results (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  eval_run_id  uuid not null references public.eval_runs (id) on delete cascade,
  eval_case_id uuid references public.eval_cases (id) on delete set null,
  agent_id     uuid references public.agents (id) on delete cascade,
  passed       boolean not null,
  verification jsonb,
  error        text,
  cost_usd     numeric(12, 6),
  tokens       int not null default 0,
  model        text,
  steps        jsonb not null default '[]'::jsonb,
  duration_ms  int,
  replayed     int not null default 0,
  live_calls   int not null default 0,
  created_at   timestamptz not null default now()
);
create index eval_results_run_idx on public.eval_results (eval_run_id);
create index eval_results_agent_idx on public.eval_results (agent_id, model);

create table public.agent_proposals (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  agent_id        uuid not null references public.agents (id) on delete cascade,
  base_version_id uuid references public.agent_versions (id) on delete set null,
  source_md       text not null,
  rationale       text not null,
  changes         jsonb not null default '[]'::jsonb,
  failure_report  jsonb not null default '{}'::jsonb,
  status          text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected', 'superseded')),
  eval_run_id     uuid references public.eval_runs (id) on delete set null,
  model           text,
  created_by      uuid references auth.users (id) on delete set null,
  decided_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create index agent_proposals_agent_idx on public.agent_proposals (agent_id, created_at desc);

alter table public.eval_cases enable row level security;
alter table public.eval_runs enable row level security;
alter table public.eval_results enable row level security;
alter table public.agent_proposals enable row level security;
create policy "members read eval cases" on public.eval_cases for select to authenticated using (public.is_org_member(org_id));
create policy "members read eval runs" on public.eval_runs for select to authenticated using (public.is_org_member(org_id));
create policy "members read eval results" on public.eval_results for select to authenticated using (public.is_org_member(org_id));
create policy "members read proposals" on public.agent_proposals for select to authenticated using (public.is_org_member(org_id));
revoke insert, update, delete, truncate on public.eval_cases, public.eval_runs, public.eval_results, public.agent_proposals
  from anon, authenticated;

alter publication supabase_realtime add table public.eval_runs, public.eval_results, public.agent_proposals;
