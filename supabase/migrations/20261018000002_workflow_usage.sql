-- Atomic token/cost accounting for workflow budgets (PostgREST cannot express `x = x + n`).
create or replace function public.add_workflow_usage(p_workflow uuid, p_tokens int, p_cost numeric default 0)
returns int
language sql security definer set search_path = '' as $$
  update public.workflows
     set tokens_used = tokens_used + greatest(p_tokens, 0),
         cost_usd    = cost_usd + greatest(coalesce(p_cost, 0), 0)
   where id = p_workflow
  returning tokens_used;
$$;
revoke all on function public.add_workflow_usage(uuid, int, numeric) from public, anon, authenticated;
grant execute on function public.add_workflow_usage(uuid, int, numeric) to service_role;
