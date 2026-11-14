alter table public.lead_suppliers add column reonic_source_id text unique;
grant select,insert,update on public.lead_suppliers to service_role;
create function public.sync_reonic_lead_sources(p_sources jsonb)
returns integer language plpgsql security invoker set search_path=''
as $$
declare
  source_count integer;
begin
  perform pg_advisory_xact_lock(46105,2);
  with imported as (
    insert into public.lead_suppliers(reonic_source_id,name,active)
    select id,name,true from jsonb_to_recordset(p_sources) as source(id text,name text)
    on conflict(reonic_source_id) do update set name=excluded.name, active=true
    where (lead_suppliers.name,lead_suppliers.active) is distinct from (excluded.name,excluded.active)
    returning 1
  )
  select jsonb_array_length(p_sources) into source_count;
  update public.lead_suppliers s set active=false
  where s.active and s.reonic_source_id is not null
    and not exists(select 1 from jsonb_array_elements(p_sources) item where item->>'id'=s.reonic_source_id);
  return source_count;
end;
$$;
revoke execute on function public.sync_reonic_lead_sources(jsonb) from public,anon,authenticated;
grant execute on function public.sync_reonic_lead_sources(jsonb) to service_role;