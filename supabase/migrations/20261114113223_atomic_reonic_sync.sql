create table public.reonic_sync_state (
  singleton boolean primary key default true check (singleton),
  synced_at timestamptz not null,
  user_count integer not null check (user_count >= 0)
);
alter table public.reonic_sync_state enable row level security;
revoke all on public.reonic_sync_state from anon, authenticated;
grant select on public.reonic_sync_state to authenticated;
create policy "Admins read Reonic sync status" on public.reonic_sync_state for select to authenticated using ((select public.is_app_admin()));

create function public.apply_reonic_users(p_users jsonb, p_started timestamptz)
returns boolean language plpgsql security invoker set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(46105, 1);
  if exists (select 1 from public.reonic_sync_state where synced_at >= p_started) then
    return false;
  end if;
  insert into public.sales_partners (reonic_user_id,full_name,email,phone,reonic_present)
  select u.reonic_id,u.name,u.email,u.phone,true
  from jsonb_to_recordset(p_users) as u(reonic_id text,name text,email text,phone text)
  on conflict (reonic_user_id) do update set full_name=excluded.full_name,
      email=excluded.email,phone=excluded.phone,reonic_present=true;
  update public.sales_partners p set reonic_present=false
  where p.reonic_user_id is not null and p.reonic_present
    and not exists (select 1 from jsonb_array_elements(p_users) u where u->>'reonic_id'=p.reonic_user_id);
  insert into public.reonic_sync_state (synced_at,user_count)
  values (p_started,jsonb_array_length(p_users))
  on conflict (singleton) do update set synced_at=excluded.synced_at,user_count=excluded.user_count;
  return true;
end;
$$;
revoke execute on function public.apply_reonic_users(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.apply_reonic_users(jsonb,timestamptz) to service_role;
grant select,insert,update on public.reonic_sync_state,public.sales_partners to service_role;
