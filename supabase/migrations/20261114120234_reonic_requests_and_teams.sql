create table public.reonic_teams (
  id text primary key,
  name text not null,
  active boolean not null default true
);
alter table public.reonic_teams enable row level security;
revoke all on public.reonic_teams from public, anon, authenticated;
grant select on public.reonic_teams to authenticated;
grant select,insert,update on public.reonic_teams to service_role;
create policy "Admins read Reonic teams" on public.reonic_teams for select to authenticated using ((select public.is_app_admin()));
alter table public.sales_partners add column reonic_team_id text references public.reonic_teams(id);
create index sales_partners_reonic_team_idx on public.sales_partners(reonic_team_id);
grant update(reonic_team_id) on public.sales_partners to authenticated;
alter table public.leads add column reonic_project_id text unique;
alter table public.lead_assignments add column reonic_team_id text references public.reonic_teams(id);
alter table public.lead_assignments add column reonic_synced_at timestamptz;
grant update(reonic_synced_at) on public.lead_assignments to service_role;
grant select,insert on public.leads to service_role;
grant select,update on public.lead_assignments to service_role;

create function public.reserve_reonic_assignment(p_lead uuid,p_partner uuid,p_order uuid)
returns void language plpgsql security invoker set search_path=''
as $$
begin
  insert into public.lead_assignments(lead_id,partner_id,order_id)
  values(p_lead,p_partner,p_order);
end;
$$;
revoke execute on function public.reserve_reonic_assignment(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_reonic_assignment(uuid,uuid,uuid) to service_role;

create or replace function public.validate_lead_assignment()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare
  external_id text;
  team_id text;
begin
  select p.reonic_team_id into team_id from public.sales_partners p where p.id = new.partner_id for share;
  select reonic_project_id into external_id from public.leads where id=new.lead_id;
  if external_id is not null then
    if current_user <> 'service_role' then raise exception 'Diese Anfrage muss über Reonic zugewiesen werden.'; end if;
    if not exists(select 1 from public.reonic_teams where id=team_id and active) then
      raise exception 'Bitte zuerst ein Reonic-Team beim Berater auswählen.';
    end if;
    new.reonic_team_id := team_id;
  end if;
  if new.order_id is not null then
    perform 1 from public.lead_orders
    where id = new.order_id and partner_id = new.partner_id for share;
    if not found then raise exception 'Die Bestellung gehört nicht zum ausgewählten Verkäufer.'; end if;
  end if;
  select c.distance_km into new.distance_km
  from public.lead_candidates(new.lead_id) c where c.partner_id = new.partner_id;
  if not found then raise exception 'Dieser Verkäufer ist für den Lead nicht mehr verfügbar.'; end if;
  return new;
end;
$$;
