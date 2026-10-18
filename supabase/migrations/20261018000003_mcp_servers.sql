-- MCP server integrations. Additive only.
--
-- An organization registers remote MCP servers (Streamable HTTP). The backend discovers their tools;
-- an admin approves individual tools, which agents may then request as mcp__<slug>__<tool>.
-- Credentials live in Vault behind service-role-only RPCs, exactly like integration secrets.

create table public.mcp_servers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  slug             text not null check (slug ~ '^[a-z][a-z0-9-]{1,23}$'),
  name             text not null check (char_length(name) between 1 and 80),
  url              text not null check (url ~ '^https?://'),
  auth_header      text not null default 'Authorization' check (auth_header ~ '^[A-Za-z0-9-]{1,64}$'),
  status           text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disabled')),
  require_approval boolean not null default true,
  tool_catalog     jsonb not null default '[]'::jsonb,   -- discovered tools: name, description, input_schema
  approved_tools   text[] not null default '{}',
  server_info      jsonb not null default '{}'::jsonb,   -- name, version, protocol
  secret_hint      text not null default '',
  last_checked_at  timestamptz,
  last_error       text,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, slug)
);
create index mcp_servers_org_idx on public.mcp_servers (org_id);
create trigger mcp_servers_updated_at before update on public.mcp_servers for each row execute function public.set_updated_at();

-- Vault references; RLS enabled with no policies: service_role only.
create table public.mcp_server_secrets (
  server_id uuid primary key references public.mcp_servers (id) on delete cascade,
  secret_id uuid not null
);
create trigger mcp_server_secrets_cleanup after delete on public.mcp_server_secrets
  for each row execute function public.delete_vault_secret();

alter table public.mcp_servers enable row level security;
alter table public.mcp_server_secrets enable row level security;
create policy "members read mcp servers" on public.mcp_servers
  for select to authenticated using (public.is_org_member(org_id));
revoke insert, update, delete, truncate on public.mcp_servers from anon, authenticated;
revoke all on public.mcp_server_secrets from anon, authenticated;

create or replace function public.set_mcp_secret(p_server uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  select secret_id into v_secret from public.mcp_server_secrets where server_id = p_server;
  if v_secret is null then
    v_secret := vault.create_secret(p_secret, 'osmsea-mcp-' || p_server::text, 'OSMSEA MCP server credential');
    insert into public.mcp_server_secrets (server_id, secret_id) values (p_server, v_secret);
  else
    perform vault.update_secret(v_secret, p_secret);
  end if;
end $$;

create or replace function public.get_mcp_secret(p_server uuid) returns text
language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret
  from public.mcp_server_secrets s
  join vault.decrypted_secrets d on d.id = s.secret_id
  where s.server_id = p_server;
$$;

revoke all on function public.set_mcp_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.get_mcp_secret(uuid) from public, anon, authenticated;
grant execute on function public.set_mcp_secret(uuid, text) to service_role;
grant execute on function public.get_mcp_secret(uuid) to service_role;

alter publication supabase_realtime add table public.mcp_servers;
