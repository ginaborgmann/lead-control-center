alter table public.lead_orders alter column radius_km drop not null,
  add column max_drive_minutes integer check (max_drive_minutes > 0),
  add constraint lead_orders_area_limit check ((radius_km is null) <> (max_drive_minutes is null));
CREATE OR REPLACE FUNCTION public.lead_candidates(p_lead_id uuid)
 RETURNS TABLE(partner_id uuid, full_name text, priority integer, distance_km double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
  order by d.km asc, p.priority desc, p.id asc;
$function$
;