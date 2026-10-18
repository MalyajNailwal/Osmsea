-- OSMSEA as an MCP server (organization API tokens) and automation triggers (schedule / webhook). Additive only.

-- Tokens are shown once; only their SHA-256 is stored. A token acts with the member role of its organization.
create table public.api_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  token_hash   text not null unique,
  prefix       text not null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_tokens_org_idx on public.api_tokens (org_id, created_at desc);

create table public.triggers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  kind             text not null check (kind in ('schedule', 'webhook')),
  goal             text not null check (char_length(goal) between 3 and 4000),
  enabled          boolean not null default true,
  require_approval boolean not null default true,  -- plans from this trigger always wait for an admin
  interval_minutes int check (interval_minutes between 15 and 525600),
  next_run_at      timestamptz,
  secret_hash      text,  -- webhook secret (SHA-256); the secret itself is shown once
  secret_prefix    text,
  last_run_at      timestamptz,
  last_workflow_id uuid references public.workflows (id) on delete set null,
  last_error       text,
  runs             int not null default 0,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  check ((kind = 'schedule' and interval_minutes is not null and next_run_at is not null)
      or (kind = 'webhook' and secret_hash is not null))
);
create index triggers_due_idx on public.triggers (next_run_at) where enabled and kind = 'schedule';

alter table public.workflows
  add column if not exists trigger_id uuid references public.triggers (id) on delete set null,
  add column if not exists force_approval boolean not null default false,
  add column if not exists context jsonb;  -- untrusted event payload, shown to the planner as data

alter table public.api_tokens enable row level security;
alter table public.triggers enable row level security;
create policy "members read api tokens" on public.api_tokens for select to authenticated using (public.is_org_member(org_id));
create policy "members read triggers" on public.triggers for select to authenticated using (public.is_org_member(org_id));
revoke insert, update, delete, truncate on public.api_tokens, public.triggers from anon, authenticated;

alter publication supabase_realtime add table public.api_tokens, public.triggers;
