alter table public.leads add column reonic_queue_open boolean not null default true;
grant update(reonic_queue_open) on public.leads to service_role;
create function public.reconcile_reonic_queue(p_ids text[])
returns void language sql security invoker set search_path=''
as $$
  update public.leads set reonic_queue_open = (reonic_project_id = any(p_ids))
  where reonic_project_id is not null
    and reonic_queue_open is distinct from (reonic_project_id = any(p_ids));
$$;
revoke execute on function public.reconcile_reonic_queue(text[]) from public,anon,authenticated;
grant execute on function public.reconcile_reonic_queue(text[]) to service_role;