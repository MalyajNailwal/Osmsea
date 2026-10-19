-- Spaces: shared conversations between people and agents, with agent-to-agent collaboration threads and
-- inline approvals for tools that need them. Additive only.

create table public.spaces (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  description      text not null default '' check (char_length(description) <= 300),
  primary_agent_id uuid references public.agents (id) on delete set null,  -- answers messages that mention nobody
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now()
);
create index spaces_org_idx on public.spaces (org_id, last_message_at desc);

create table public.space_agents (
  space_id uuid not null references public.spaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  org_id   uuid not null references public.organizations (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (space_id, agent_id)
);

create table public.space_messages (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  space_id     uuid not null references public.spaces (id) on delete cascade,
  author_kind  text not null check (author_kind in ('user', 'agent', 'system')),
  author_id    uuid,  -- user id or agent id
  author_label text not null,
  kind         text not null default 'text' check (kind in ('text', 'collaboration', 'approval', 'workflow')),
  content      text not null default '',
  thread_id    uuid references public.space_messages (id) on delete cascade,  -- messages inside a collaboration thread
  status       text not null default 'done' check (status in ('done', 'thinking', 'waiting', 'running', 'pending',
                                                                'allowed', 'denied', 'failed')),
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index space_messages_space_idx on public.space_messages (space_id, created_at);

create table public.space_reads (
  space_id     uuid not null references public.spaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

alter table public.workflows add column if not exists space_id uuid references public.spaces (id) on delete set null;

alter table public.spaces enable row level security;
alter table public.space_agents enable row level security;
alter table public.space_messages enable row level security;
alter table public.space_reads enable row level security;
create policy "members read spaces" on public.spaces for select to authenticated using (public.is_org_member(org_id));
create policy "members read space agents" on public.space_agents for select to authenticated using (public.is_org_member(org_id));
create policy "members read space messages" on public.space_messages for select to authenticated using (public.is_org_member(org_id));
create policy "users read own space reads" on public.space_reads for select to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(org_id));
revoke insert, update, delete, truncate on public.spaces, public.space_agents, public.space_messages, public.space_reads
  from anon, authenticated;

alter publication supabase_realtime add table public.spaces, public.space_agents, public.space_messages;
