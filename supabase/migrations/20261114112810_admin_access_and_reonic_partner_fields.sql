create policy "Admins read their own membership"
on public.app_admins for select to authenticated
using (user_id = (select auth.uid()));

revoke all on public.app_admins from anon, authenticated;
grant select (user_id) on public.app_admins to authenticated;

create or replace function public.is_app_admin()
returns boolean language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from public.app_admins where user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_app_admin() from public, anon;
grant execute on function public.is_app_admin() to authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

alter table public.sales_partners
  alter column active set default false,
  add column email text,
  add column phone text,
  add column reonic_postal_code text,
  add column reonic_present boolean not null default true,
  add column radius_km numeric check (radius_km > 0 and radius_km <= 2000),
  add column priority integer not null default 0;

grant select, update on public.sales_partners to authenticated;
grant select, insert, update on public.lead_orders, public.lead_suppliers to authenticated;
