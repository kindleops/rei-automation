-- ============================================================
-- RPC: get_property_coordinates
-- Returns latitude/longitude for a set of property_ids.
-- SECURITY DEFINER bypasses RLS so the anon key can access coords.
-- ============================================================

drop function if exists public.get_property_coordinates(text[]);

create or replace function public.get_property_coordinates(p_property_ids text[])
returns table (
  property_id text,
  latitude numeric,
  longitude numeric
)
language sql
security definer
set search_path = public
as $$
  select
    p.property_id::text,
    p.latitude,
    p.longitude
  from public.properties p
  where p.property_id::text = any(p_property_ids)
    and p.latitude is not null
    and p.longitude is not null
    and p.latitude != 0
    and p.longitude != 0;
$$;

-- Grant execute to anon and authenticated roles
grant execute on function public.get_property_coordinates(text[]) to anon, authenticated;
