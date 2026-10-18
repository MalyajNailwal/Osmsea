-- Knowledge base (organization documents, chunked and full-text indexed) and actions (side effects such as
-- opening a GitHub pull request, proposed from verified output and run only after an admin approves). Additive only.

create table public.documents (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 300),
  source     text not null check (source in ('upload', 'url')),
  source_url text,
  filename   text,
  mime       text,
  bytes      int not null default 0,
  sha256     text not null,
  pages      int,
  chunks     int not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, sha256)
);
create index documents_org_idx on public.documents (org_id, created_at desc);

create table public.document_chunks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  ordinal     int not null,
  page        int,
  heading     text,
  content     text not null,
  fts         tsvector generated always as (to_tsvector('english'::regconfig, coalesce(heading, '') || ' ' || content)) stored,
  unique (document_id, ordinal)
);
create index document_chunks_fts_idx on public.document_chunks using gin (fts);
create index document_chunks_org_idx on public.document_chunks (org_id);

create or replace function public.search_documents(p_org uuid, p_query text, p_limit int default 5)
returns table (chunk_id uuid, document_id uuid, title text, ordinal int, page int, heading text, content text, rank real)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.document_id, d.title, c.ordinal, c.page, c.heading, c.content,
         ts_rank(c.fts, websearch_to_tsquery('english'::regconfig, p_query))
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where c.org_id = p_org and c.fts @@ websearch_to_tsquery('english'::regconfig, p_query)
  order by 8 desc, c.ordinal
  limit least(greatest(p_limit, 1), 20);
$$;
revoke all on function public.search_documents(uuid, text, int) from public, anon;
grant execute on function public.search_documents(uuid, text, int) to authenticated, service_role;

-- An action is proposed by trusted code after a task passes verification. Its content is the task's verified
-- output (never model-supplied arguments), and it runs only after an admin approves it.
create table public.actions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  task_id     uuid not null references public.tasks (id) on delete cascade,
  kind        text not null check (kind in ('github_pull_request')),
  status      text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'rejected')),
  summary     text not null,
  payload     jsonb not null default '{}'::jsonb,  -- preview shown to the approver
  result      jsonb,                               -- e.g. pull request url and number
  error       text,
  decided_by  uuid references auth.users (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  completed_at timestamptz,
  unique (task_id, kind)
);
create index actions_org_idx on public.actions (org_id, status, created_at desc);

alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.actions enable row level security;
create policy "members read documents" on public.documents for select to authenticated using (public.is_org_member(org_id));
create policy "members read document chunks" on public.document_chunks for select to authenticated using (public.is_org_member(org_id));
create policy "members read actions" on public.actions for select to authenticated using (public.is_org_member(org_id));
revoke insert, update, delete, truncate on public.documents, public.document_chunks, public.actions from anon, authenticated;

alter publication supabase_realtime add table public.documents, public.actions;
