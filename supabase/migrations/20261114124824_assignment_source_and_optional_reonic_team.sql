alter table public.sales_partners add column reonic_team_optional boolean not null default false;
alter table public.lead_assignments add column supplier_id uuid references public.lead_suppliers(id);
grant insert(supplier_id) on public.lead_assignments to authenticated;
CREATE OR REPLACE FUNCTION public.validate_lead_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  external_id text;
  team_id text;
  eligible boolean;
  optional_team boolean;
  order_supplier uuid;
begin
  select p.reonic_team_id, p.active and p.reonic_present  , p.reonic_team_optional into team_id, eligible, optional_team from public.sales_partners p where p.id = new.partner_id for share;
  select reonic_project_id into external_id from public.leads where id=new.lead_id;
  if external_id is not null then
    if current_user <> 'service_role' then raise exception 'Diese Anfrage muss über Reonic zugewiesen werden.'; end if;
    if (team_id is not null or not optional_team) and not exists(select 1 from public.reonic_teams where id=team_id and active and cardinality(leader_ids)>0) then
      raise exception 'Bitte zuerst ein Reonic-Team beim Berater auswählen.';
    end if;
    new.reonic_team_id := team_id;
  end if;
  if new.order_id is not null then
    select supplier_id into order_supplier from public.lead_orders
    where id = new.order_id and partner_id = new.partner_id for share;
    if not found then raise exception 'Die Bestellung gehört nicht zum ausgewählten Verkäufer.'; end if;
  end if;
  if not coalesce(eligible,false) then
    raise exception 'Dieser Verkäufer ist nicht freigeschaltet oder nicht mehr verfügbar.';
  end if;
  if new.manual then
    select 12742 * asin(sqrt(least(1.0,
      power(sin(radians(b.latitude-a.latitude)/2),2) +
      cos(radians(a.latitude))*cos(radians(b.latitude))*power(sin(radians(b.longitude-a.longitude)/2),2)
    ))) into new.distance_km
    from public.leads l join public.de_postal_codes a on a.postal_code=l.postal_code
    join public.sales_partners p on p.id=new.partner_id
    join public.de_postal_codes b on b.postal_code=coalesce(p.postal_code,p.reonic_postal_code)
    where l.id=new.lead_id;
    return new;
  end if;
  select c.distance_km into new.distance_km
  from public.lead_candidates(new.lead_id) c where c.partner_id = new.partner_id;
  if not found then raise exception 'Dieser Verkäufer ist für den Lead nicht mehr verfügbar.'; end if;
  return new;
end;
$function$
;
create function public.reserve_reonic_assignment(p_lead uuid,p_partner uuid,p_order uuid,p_actor uuid,p_manual boolean,p_supplier uuid)
returns void language sql security invoker set search_path=''
as $$
 insert into public.lead_assignments(lead_id,partner_id,order_id,assigned_by,manual,supplier_id)
 values(p_lead,p_partner,p_order,p_actor,p_manual,p_supplier);
$$;
revoke execute on function public.reserve_reonic_assignment(uuid,uuid,uuid,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.reserve_reonic_assignment(uuid,uuid,uuid,uuid,boolean,uuid) to service_role;
