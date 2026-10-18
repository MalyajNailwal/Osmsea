-- Plan forecasts, replays (re-run a past attempt against its recorded tool results with an edited spec or
-- another model) and member invitations. Additive only.

alter table public.workflows add column if not exists forecast jsonb;  -- expected cost / success / duration, computed at planning

create table public.replays (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  execution_id uuid not null references public.agent_executions (id) on delete cascade,
  agent_id     uuid references public.agents (id) on delete cascade,
  source_md    text not null,
  model        text,
  status       text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  passed       boolean,
  output       jsonb,
  verification jsonb,
  steps        jsonb not null default '[]'::jsonb,
  error        text,
  cost_usd     numeric(12, 6),
  tokens       int not null default 0,
  duration_ms  int,
  replayed     int not null default 0,
  live_calls   int not null default 0,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index replays_execution_idx on public.replays (execution_id, created_at desc);

-- Invitation links carry a random token (shown once, stored as SHA-256) and work only for the invited email.
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  email       text not null check (email = lower(email) and position('@' in email) > 1),
  role        text not null check (role in ('viewer', 'member', 'admin')),
  token_hash  text not null unique,
  invited_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz
);
create index invitations_org_idx on public.invitations (org_id, created_at desc);

alter table public.replays enable row level security;
alter table public.invitations enable row level security;
create policy "members read replays" on public.replays for select to authenticated using (public.is_org_member(org_id));
create policy "members read invitations" on public.invitations for select to authenticated using (public.is_org_member(org_id));
revoke insert, update, delete, truncate on public.replays, public.invitations from anon, authenticated;

alter publication supabase_realtime add table public.replays, public.invitations, public.organization_members;
