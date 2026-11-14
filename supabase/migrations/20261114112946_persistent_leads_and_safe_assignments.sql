create table public.de_postal_codes (
  postal_code text primary key check (postal_code ~ '^[0-9]{5}$'),
  latitude double precision not null check (latitude between 47 and 56),
  longitude double precision not null check (longitude between 5 and 16)
);
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null check (length(trim(customer_name)) between 1 and 250),
  postal_code text not null check (postal_code ~ '^[0-9]{5}$'),
  email text, phone text, source text, notes text,
  status text not null default 'new' check (status in ('new','assigned','in_progress','completed')),
  created_at timestamptz not null default now()
);
create table public.lead_assignments (
  lead_id uuid primary key references public.leads(id),
  partner_id uuid not null references public.sales_partners(id),
  order_id uuid references public.lead_orders(id),
  assigned_by uuid default auth.uid(),
  assigned_at timestamptz not null default now(),
  distance_km double precision not null check (distance_km >= 0)
);
create index lead_assignments_partner_idx on public.lead_assignments (partner_id);
create index lead_assignments_order_idx on public.lead_assignments (order_id) where order_id is not null;
create index leads_created_idx on public.leads (created_at desc, id);
alter table public.de_postal_codes enable row level security;
alter table public.leads enable row level security;
alter table public.lead_assignments enable row level security;
revoke all on public.de_postal_codes, public.leads, public.lead_assignments from anon, authenticated;
grant select on public.de_postal_codes, public.leads, public.lead_assignments to authenticated;
grant insert (id,customer_name,postal_code,email,phone,source,notes) on public.leads to authenticated;
grant update (status) on public.leads to authenticated;
grant insert (lead_id,partner_id,order_id,distance_km) on public.lead_assignments to authenticated;
create policy "Admins read postal codes" on public.de_postal_codes for select to authenticated using ((select public.is_app_admin()));
create policy "Admins read leads" on public.leads for select to authenticated using ((select public.is_app_admin()));
create policy "Admins enter leads" on public.leads for insert to authenticated with check ((select public.is_app_admin()));
create policy "Admins maintain assigned lead status" on public.leads for update to authenticated
using ((select public.is_app_admin()) and exists (select 1 from public.lead_assignments a where a.lead_id = leads.id))
with check ((select public.is_app_admin()) and status <> 'new');
create policy "Admins read assignments" on public.lead_assignments for select to authenticated using ((select public.is_app_admin()));
create policy "Admins assign leads" on public.lead_assignments for insert to authenticated with check ((select public.is_app_admin()));

create function public.lead_candidates(p_lead_id uuid)
returns table (partner_id uuid, full_name text, priority integer, distance_km double precision)
language sql stable security invoker set search_path = ''
as $$
  select p.id, p.full_name, p.priority, d.km
  from public.leads l
  join public.de_postal_codes origin on origin.postal_code = l.postal_code
  cross join public.sales_partners p
  join public.de_postal_codes target on target.postal_code = coalesce(p.postal_code,p.reonic_postal_code)
  cross join lateral (
    select 12742 * asin(sqrt(least(1.0,
      power(sin(radians(target.latitude-origin.latitude)/2),2) +
      cos(radians(origin.latitude))*cos(radians(target.latitude))*
      power(sin(radians(target.longitude-origin.longitude)/2),2)
    ))) as km
  ) d
  where l.id = p_lead_id and l.status = 'new'
    and p.active and p.reonic_present and d.km <= p.radius_km
  order by d.km asc, p.priority desc, p.id asc
  limit 10;
$$;
revoke execute on function public.lead_candidates(uuid) from public, anon;
grant execute on function public.lead_candidates(uuid) to authenticated;

create function public.validate_lead_assignment()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  perform 1 from public.sales_partners where id = new.partner_id for share;
  if new.order_id is not null then
    perform 1 from public.lead_orders
    where id = new.order_id and partner_id = new.partner_id for share;
    if not found then
      raise exception 'Die Bestellung gehört nicht zum ausgewählten Verkäufer.';
    end if;
  end if;
  select c.distance_km into new.distance_km
  from public.lead_candidates(new.lead_id) c where c.partner_id = new.partner_id;
  if not found then
    raise exception 'Dieser Verkäufer ist für den Lead nicht mehr verfügbar.';
  end if;
  return new;
end;
$$;
create trigger validate_lead_assignment before insert on public.lead_assignments
for each row execute function public.validate_lead_assignment();

create function public.mark_lead_assigned()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  update public.leads set status = 'assigned' where id = new.lead_id;
  if not found then raise exception 'Lead-Status konnte nicht gespeichert werden.'; end if;
  return new;
end;
$$;
create trigger mark_lead_assigned after insert on public.lead_assignments
for each row execute function public.mark_lead_assigned();

revoke execute on function public.validate_lead_assignment(),public.mark_lead_assigned() from public, anon, authenticated;
