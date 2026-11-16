CREATE OR REPLACE FUNCTION public.nearby_lead_partners(p_lead_id uuid)
 RETURNS TABLE(partner_id uuid, full_name text, priority integer, distance_km double precision, outside_radius boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select p.id, p.full_name, p.priority, d.km, not coalesce(d.km <= p.radius_km,false)
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
    and p.reonic_present and (l.reonic_project_id is null or p.reonic_user_id is not null)
  order by d.km asc, p.priority desc, p.id asc;
$function$
;