create table public.activity_log (
  id bigint generated always as identity primary key,
  entity text not null,
  record_id uuid not null,
  action text not null,
  old_status text,
  new_status text,
  actor uuid default auth.uid(),
  changed_at timestamptz not null default now()
);
create index activity_record_idx on public.activity_log(entity, record_id, changed_at desc);
alter table public.activity_log enable row level security;
revoke all on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;
create policy "Admins read activity" on public.activity_log for select to authenticated using ((select public.is_app_admin()));

create schema if not exists gb_internal;
revoke all on schema gb_internal from public, anon, authenticated;
create function gb_internal.log_activity()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;
  insert into public.activity_log(entity,record_id,action,old_status,new_status)
  values (tg_table_name, new.id, lower(tg_op),
    case when tg_op='UPDATE' then to_jsonb(old)->>'status' end, to_jsonb(new)->>'status');
  return new;
end;
$$;
revoke execute on function gb_internal.log_activity() from public, anon, authenticated;
create trigger log_leads after insert or update on public.leads for each row execute function gb_internal.log_activity();
create trigger log_orders after insert or update on public.lead_orders for each row execute function gb_internal.log_activity();

revoke insert, update, delete on public.sales_partners from authenticated;
grant update (postal_code,radius_km,active,priority) on public.sales_partners to authenticated;
revoke delete on public.lead_orders,public.lead_suppliers from authenticated;

create function public.validate_order_partner()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
  if new.partner_id is distinct from old.partner_id and exists (
    select 1 from public.lead_assignments where order_id = old.id
  ) then
    raise exception 'Für diese Bestellung bestehen bereits Lead-Zuweisungen.';
  end if;
  return new;
end;
$$;
revoke execute on function public.validate_order_partner() from public, anon, authenticated;
create trigger validate_order_partner before update of partner_id on public.lead_orders
for each row execute function public.validate_order_partner();
