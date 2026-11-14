alter table public.lead_orders alter column quantity drop not null, add column postal_codes_only boolean not null default false;
alter table public.lead_orders drop constraint lead_orders_area_limit;
alter table public.lead_orders add constraint lead_orders_area_limit check (
 (postal_codes_only and quantity is null and radius_km is null and max_drive_minutes is null)
 or (not postal_codes_only and quantity is not null and ((radius_km is null) <> (max_drive_minutes is null)))
);