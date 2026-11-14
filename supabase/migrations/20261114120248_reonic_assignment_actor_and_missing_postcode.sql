alter table public.leads alter column postal_code drop not null;
grant update (status) on public.leads to service_role;
grant select on public.lead_orders,public.de_postal_codes to service_role;
grant execute on function public.lead_candidates(uuid) to service_role;
create or replace function public.reserve_reonic_assignment(p_lead uuid,p_partner uuid,p_order uuid,p_actor uuid)
returns void language sql security invoker set search_path=''
as $$
  insert into public.lead_assignments(lead_id,partner_id,order_id,assigned_by)
  values(p_lead,p_partner,p_order,p_actor);
$$;
revoke execute on function public.reserve_reonic_assignment(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_reonic_assignment(uuid,uuid,uuid,uuid) to service_role;
revoke execute on function public.reserve_reonic_assignment(uuid,uuid,uuid) from service_role;