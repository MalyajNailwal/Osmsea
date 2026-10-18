-- OSMSEA initial schema.
--
-- Security model:
--   * Every table has RLS. Organization members may SELECT their organization's rows.
--   * Client roles (anon, authenticated) have no INSERT/UPDATE/DELETE privileges at all:
--     every write goes through the FastAPI backend, which authorizes the member's role and
--     writes with the service role.
--   * Integration credentials live in Supabase Vault; the RPCs that touch them are executable
--     only by service_role.
--   * Configuration (organizations, departments, agents, agent_versions, integrations) is kept
--     separate from execution state (workflows, tasks, agent_executions, events, artifacts).

-- ---------------------------------------------------------------- helpers

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- configuration

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  readme_md   text not null default '',
  settings    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.organization_members (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  email      text not null default '',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  slug        text not null check (slug ~ '^[a-z][a-z0-9-]{1,47}$'),
  name        text not null check (char_length(name) between 1 and 80),
  description text not null default '',
  readme_md   text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, slug)
);

create table public.agents (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  department_id     uuid not null references public.departments (id) on delete restrict,
  slug              text not null check (slug ~ '^[a-z][a-z0-9-]{1,47}$'),
  name              text not null,
  role              text not null default '',
  status            text not null default 'active' check (status in ('draft', 'active', 'disabled')),
  active_version_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, slug)
);
create index agents_department_idx on public.agents (department_id);

-- Immutable, validated specification versions. Editing an agent appends a version.
create table public.agent_versions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  agent_id   uuid not null references public.agents (id) on delete cascade,
  version    int  not null check (version > 0),
  source_md  text not null,
  spec       jsonb not null,
  note       text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);
create index agent_versions_org_idx on public.agent_versions (org_id);

alter table public.agents
  add constraint agents_active_version_fk
  foreign key (active_version_id) references public.agent_versions (id) on delete set null;

create table public.integrations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  provider          text not null check (provider in ('openrouter', 'openai_compatible', 'tavily', 'brave_search')),
  status            text not null default 'configured' check (status in ('configured', 'error')),
  config            jsonb not null default '{}'::jsonb,   -- non-secret settings only (base_url, model)
  secret_hint       text not null default '',              -- last 4 characters, for display
  last_tested_at    timestamptz,
  last_test_ok      boolean,
  last_test_message text,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, provider)
);

-- Maps an integration to its Vault secret. RLS enabled with no policies: service_role only.
create table public.integration_secrets (
  integration_id uuid primary key references public.integrations (id) on delete cascade,
  secret_id      uuid not null
);

-- ---------------------------------------------------------------- execution state

create table public.workflows (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  goal                 text not null check (char_length(goal) between 3 and 4000),
  status               text not null default 'planning' check (status in (
                         'planning', 'plan_failed', 'awaiting_approval', 'running',
                         'completed', 'failed', 'cancelled', 'rejected')),
  objective            text,
  acceptance_criteria  jsonb not null default '[]'::jsonb,
  plan                 jsonb,
  plan_errors          jsonb not null default '[]'::jsonb,
  required_permissions jsonb not null default '[]'::jsonb,
  requires_approval    boolean not null default true,
  token_budget         int not null default 300000,
  tokens_used          int not null default 0,
  cost_usd             numeric(12, 6) not null default 0,
  error                text,
  created_by           uuid references auth.users (id) on delete set null,
  approved_by          uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  approved_at          timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz
);
create index workflows_org_idx on public.workflows (org_id, created_at desc);
create index workflows_status_idx on public.workflows (status);

create table public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  workflow_id         uuid not null references public.workflows (id) on delete cascade,
  key                 text not null,
  title               text not null,
  description         text not null default '',
  agent_id            uuid references public.agents (id) on delete set null,
  agent_slug          text not null,
  agent_version_id    uuid references public.agent_versions (id) on delete set null,
  depends_on          uuid[] not null default '{}',
  expected_output     text not null default '',
  acceptance_criteria jsonb not null default '[]'::jsonb,
  status              text not null default 'awaiting_approval' check (status in (
                        'awaiting_approval', 'pending', 'queued', 'running', 'verifying',
                        'completed', 'failed', 'blocked', 'cancelled')),
  attempt             int not null default 0,
  max_attempts        int not null default 2 check (max_attempts between 1 and 5),
  next_attempt_at     timestamptz,
  lease_owner         text,
  lease_expires_at    timestamptz,
  output              jsonb,
  verification        jsonb,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  unique (workflow_id, key)
);
create index tasks_org_status_idx on public.tasks (org_id, status);
create index tasks_workflow_idx on public.tasks (workflow_id);
create index tasks_status_idx on public.tasks (status) where status in ('pending', 'queued', 'running', 'verifying');

create table public.agent_executions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  workflow_id      uuid not null references public.workflows (id) on delete cascade,
  task_id          uuid not null references public.tasks (id) on delete cascade,
  agent_id         uuid references public.agents (id) on delete set null,
  agent_version_id uuid references public.agent_versions (id) on delete set null,
  attempt          int not null,
  status           text not null default 'running' check (status in (
                     'running', 'verifying', 'succeeded', 'failed', 'cancelled', 'abandoned', 'timed_out')),
  provider         text,
  model            text,
  input_tokens     int not null default 0,
  output_tokens    int not null default 0,
  cost_usd         numeric(12, 6),
  steps            jsonb not null default '[]'::jsonb,   -- tool calls: name, args, ok, preview, ms
  output           jsonb,
  verification     jsonb,
  error            text,
  worker_id        text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  unique (task_id, attempt)
);
create index agent_executions_org_idx on public.agent_executions (org_id, started_at desc);
create index agent_executions_agent_idx on public.agent_executions (agent_id, started_at desc);

create table public.execution_events (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  workflow_id  uuid references public.workflows (id) on delete cascade,
  task_id      uuid references public.tasks (id) on delete cascade,
  execution_id uuid references public.agent_executions (id) on delete cascade,
  agent_id     uuid references public.agents (id) on delete set null,
  type         text not null,
  level        text not null default 'info' check (level in ('info', 'warning', 'error')),
  message      text not null,
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index execution_events_org_idx on public.execution_events (org_id, created_at desc);
create index execution_events_workflow_idx on public.execution_events (workflow_id, id);

create table public.approvals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  kind        text not null default 'plan' check (kind in ('plan')),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  summary     text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  decided_by  uuid references auth.users (id) on delete set null,
  comment     text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create unique index approvals_one_pending_idx on public.approvals (workflow_id) where status = 'pending';
create index approvals_org_idx on public.approvals (org_id, status);

create table public.artifacts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  workflow_id  uuid not null references public.workflows (id) on delete cascade,
  task_id      uuid not null references public.tasks (id) on delete cascade,
  execution_id uuid not null references public.agent_executions (id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('markdown', 'code', 'json', 'text')),
  content      text not null,
  sha256       text not null,
  size_bytes   int not null,
  created_at   timestamptz not null default now()
);
create index artifacts_org_idx on public.artifacts (org_id);
create index artifacts_task_idx on public.artifacts (task_id);

create table public.memory_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  kind        text not null check (kind in ('finding', 'decision', 'evidence', 'summary', 'note')),
  title       text not null check (char_length(title) between 1 and 300),
  content     text not null check (char_length(content) between 1 and 20000),
  source      jsonb not null default '{}'::jsonb,   -- {url, title, agent, task_key, verified}
  tags        text[] not null default '{}',
  workflow_id uuid references public.workflows (id) on delete set null,
  task_id     uuid references public.tasks (id) on delete set null,
  agent_id    uuid references public.agents (id) on delete set null,
  created_by  uuid references auth.users (id) on delete set null,
  fts         tsvector generated always as (
                to_tsvector('english'::regconfig, title || ' ' || content)) stored,
  created_at  timestamptz not null default now()
);
create index memory_items_org_idx on public.memory_items (org_id, created_at desc);
create index memory_items_fts_idx on public.memory_items using gin (fts);

create table public.audit_events (
  id            bigint generated always as identity primary key,
  org_id        uuid references public.organizations (id) on delete cascade,
  actor_type    text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id      uuid,
  actor_label   text not null default '',
  action        text not null,
  resource_type text not null,
  resource_id   text,
  resource_name text,
  outcome       text not null default 'success' check (outcome in ('success', 'failure', 'denied')),
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_events_org_idx on public.audit_events (org_id, created_at desc);

-- ---------------------------------------------------------------- updated_at triggers

create trigger organizations_updated_at before update on public.organizations for each row execute function public.set_updated_at();
create trigger departments_updated_at   before update on public.departments   for each row execute function public.set_updated_at();
create trigger agents_updated_at        before update on public.agents        for each row execute function public.set_updated_at();
create trigger integrations_updated_at  before update on public.integrations  for each row execute function public.set_updated_at();
create trigger workflows_updated_at     before update on public.workflows     for each row execute function public.set_updated_at();
create trigger tasks_updated_at         before update on public.tasks         for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- RLS

create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = p_org and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;

alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.departments          enable row level security;
alter table public.agents               enable row level security;
alter table public.agent_versions       enable row level security;
alter table public.integrations         enable row level security;
alter table public.integration_secrets  enable row level security;
alter table public.workflows            enable row level security;
alter table public.tasks                enable row level security;
alter table public.agent_executions     enable row level security;
alter table public.execution_events     enable row level security;
alter table public.approvals            enable row level security;
alter table public.artifacts            enable row level security;
alter table public.memory_items         enable row level security;
alter table public.audit_events         enable row level security;

create policy "members read organization" on public.organizations
  for select to authenticated using (public.is_org_member(id));
create policy "members read members" on public.organization_members
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read departments" on public.departments
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read agents" on public.agents
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read agent versions" on public.agent_versions
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read integrations" on public.integrations
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read workflows" on public.workflows
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read tasks" on public.tasks
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read executions" on public.agent_executions
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read events" on public.execution_events
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read approvals" on public.approvals
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read artifacts" on public.artifacts
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read memory" on public.memory_items
  for select to authenticated using (public.is_org_member(org_id));
create policy "members read audit" on public.audit_events
  for select to authenticated using (public.is_org_member(org_id));
-- integration_secrets: intentionally no policies.

-- Defense in depth: client roles cannot write even if a permissive policy is added by mistake.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on public.integration_secrets from anon, authenticated;

-- ---------------------------------------------------------------- RPCs

-- Full-text memory search. SECURITY INVOKER: RLS applies when called with a user JWT.
create or replace function public.search_memory(p_org uuid, p_query text, p_limit int default 10)
returns setof public.memory_items
language sql stable security invoker set search_path = '' as $$
  select m.*
  from public.memory_items m
  where m.org_id = p_org
    and (coalesce(p_query, '') = '' or m.fts @@ websearch_to_tsquery('english'::regconfig, p_query))
  order by
    case when coalesce(p_query, '') = '' then 0
         else ts_rank(m.fts, websearch_to_tsquery('english'::regconfig, p_query)) end desc,
    m.created_at desc
  limit least(greatest(p_limit, 1), 50);
$$;
revoke all on function public.search_memory(uuid, text, int) from public, anon;
grant execute on function public.search_memory(uuid, text, int) to authenticated, service_role;

create or replace function public.set_integration_secret(p_integration uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  select secret_id into v_secret from public.integration_secrets where integration_id = p_integration;
  if v_secret is null then
    v_secret := vault.create_secret(p_secret, 'osmsea-integration-' || p_integration::text, 'OSMSEA integration credential');
    insert into public.integration_secrets (integration_id, secret_id) values (p_integration, v_secret);
  else
    perform vault.update_secret(v_secret, p_secret);
  end if;
end $$;

create or replace function public.get_integration_secret(p_integration uuid) returns text
language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret
  from public.integration_secrets s
  join vault.decrypted_secrets d on d.id = s.secret_id
  where s.integration_id = p_integration;
$$;

-- Remove the Vault secret when its mapping goes away (including integration deletes via cascade).
create or replace function public.delete_vault_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end $$;
create trigger integration_secrets_cleanup after delete on public.integration_secrets
  for each row execute function public.delete_vault_secret();

revoke all on function public.set_integration_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.get_integration_secret(uuid) from public, anon, authenticated;
revoke all on function public.delete_vault_secret() from public, anon, authenticated;
grant execute on function public.set_integration_secret(uuid, text) to service_role;
grant execute on function public.get_integration_secret(uuid) to service_role;

-- ---------------------------------------------------------------- Realtime

alter publication supabase_realtime add table
  public.workflows, public.tasks, public.agent_executions, public.execution_events,
  public.approvals, public.agents, public.memory_items;
