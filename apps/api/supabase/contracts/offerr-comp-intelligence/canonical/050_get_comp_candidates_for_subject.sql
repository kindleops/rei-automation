-- =====================================================================
-- OFFERR COMP-INTELLIGENCE CANONICAL CONTRACT — public.get_comp_candidates_for_subject (comp retrieval RPC)
-- =====================================================================
-- PARITY CLASS : EXACT PRODUCTION DEFINITION (verbatim pg_get_functiondef)
-- PROVENANCE   : pg_get_functiondef(oid) on production public.get_comp_candidates_for_subject (oid 880417)
-- RECOVERED    : 2026-07-30 (read-only pg_catalog inspection, project lcppdrmrdfblstpcbgpf)
-- SCHEMA VERSION: offerr-comp-intelligence/1.0.0
--
-- RECOVERED SIGNATURE
--   p_subject_property_id text, p_radius_miles numeric DEFAULT 1.0, p_months_back integer DEFAULT 6, p_limit integer DEFAULT 25
-- RETURNS SETOF 32 columns (see body).
--   LANGUAGE sql / STABLE / SECURITY INVOKER / search_path <unset — inherits caller>
--
-- Reproduced verbatim from production. Behavioural facts this pins down, all of
-- which the previous behavioural stand-in got wrong:
--   * candidate source is v_recent_sold_comps, NOT buyer_comp_raw_v2
--   * comp_id is uuid, not text; there is no separate `id` output column
--   * the subject is excluded by property_id, not by id
--   * recency is measured on sale_date, not recording_date
--   * validity gating is delegated entirely to v_recent_sold_comps.is_usable_comp
--   * distance is spherical law of cosines with R=3958.8, clamped to [-1,1],
--     rounded to 2dp -- NOT haversine
--   * similarity is 100 minus capped sqft/beds/baths/year-built penalties minus
--     a 20-point asset-class mismatch, floored at 0 and rounded to 2dp
--   * the hard row cap is least(greatest(p_limit,1),100)
--   * production defaults are (1.0 mi, 6 months, 25 rows); the Offerr caller
--     always passes explicit values from compCandidateLoader.eligibilityWindow
--
-- KNOWN PRODUCTION DEFECT — DO NOT SILENTLY PATCH HERE:
--   ORDER BY similarity_score DESC NULLS LAST, sale_date DESC NULLS LAST,
--            distance_miles ASC
--   has no final unique tiebreaker, so two candidates identical on all three
--   keys have an implementation-defined relative order. See README.md
--   "Open production-parity risks".
--
-- This file is applied by apps/api/scripts/offerr/offerr-staging-bootstrap.sql
-- via \ir. It is NOT part of the ordinary supabase/migrations chain: these
-- objects already exist in production and must never be re-created there.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_comp_candidates_for_subject(p_subject_property_id text, p_radius_miles numeric DEFAULT 1.0, p_months_back integer DEFAULT 6, p_limit integer DEFAULT 25)
 RETURNS TABLE(comp_id uuid, property_id text, address text, city text, state text, zip text, latitude numeric, longitude numeric, sale_price numeric, sale_date date, mls_sold_price numeric, mls_sold_date date, estimated_value numeric, price_off_value numeric, percent_off numeric, ppsf numeric, ppu numeric, ppbd numeric, asset_class text, property_type text, building_condition text, construction_type text, beds numeric, baths numeric, sqft numeric, units_count numeric, year_built numeric, distance_miles numeric, similarity_score numeric, comp_confidence_score numeric, deal_grade text, streetview_image text)
 LANGUAGE sql
 STABLE
AS $function$
with subject as (
  -- Try to find in sold comps first (might have more specific comp data)
  select
    property_id,
    latitude,
    longitude,
    normalized_asset_class,
    property_type,
    total_bedrooms,
    total_baths,
    building_square_feet,
    year_built,
    units_count
  from public.v_recent_sold_comps
  where property_id = p_subject_property_id
  
  union all
  
  -- Fallback to properties table
  select
    property_id,
    latitude,
    longitude,
    case 
      when property_type in ('Single Family', 'Residential') then 'single_family'
      when property_type in ('Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex') then 'multifamily'
      else 'single_family' 
    end as normalized_asset_class,
    property_type,
    total_bedrooms,
    total_baths,
    building_square_feet,
    year_built::numeric,
    units_count::numeric
  from public.properties
  where property_id = p_subject_property_id
    and not exists (select 1 from public.v_recent_sold_comps where property_id = p_subject_property_id)
  
  limit 1
),
candidates as (
  select
    c.*,
    (
      3958.8 * acos(
        least(1, greatest(-1,
          cos(radians(s.latitude)) * cos(radians(c.latitude)) *
          cos(radians(c.longitude) - radians(s.longitude)) +
          sin(radians(s.latitude)) * sin(radians(c.latitude))
        ))
      )
    ) as distance_miles,

    (
      100::numeric
      - least(35::numeric, abs(coalesce(c.building_square_feet, 0) - coalesce(s.building_square_feet, 0)) / greatest(coalesce(s.building_square_feet, 1), 1) * 35)
      - least(15::numeric, abs(coalesce(c.total_bedrooms, 0) - coalesce(s.total_bedrooms, 0)) * 5)
      - least(15::numeric, abs(coalesce(c.total_baths, 0) - coalesce(s.total_baths, 0)) * 5)
      - least(20::numeric, abs(coalesce(c.year_built, 0) - coalesce(s.year_built, 0)) / 5)
      - case when c.normalized_asset_class = s.normalized_asset_class then 0::numeric else 20::numeric end
    ) as similarity_score
  from public.v_recent_sold_comps c
  cross join subject s
  where c.is_usable_comp = true
    and c.property_id is distinct from s.property_id
    and c.sale_date >= current_date - make_interval(months => p_months_back)
    and c.latitude is not null
    and c.longitude is not null
)
select
  id as comp_id,
  property_id,
  property_address_full as address,
  property_address_city as city,
  property_address_state as state,
  property_address_zip as zip,
  latitude,
  longitude,
  sale_price,
  sale_date,
  mls_sold_price,
  mls_sold_date,
  estimated_value,
  price_off_value,
  percent_off,
  computed_ppsf as ppsf,
  ppu,
  ppbd,
  normalized_asset_class as asset_class,
  property_type,
  building_condition,
  construction_type,
  total_bedrooms as beds,
  total_baths as baths,
  building_square_feet as sqft,
  units_count,
  year_built,
  round(distance_miles::numeric, 2) as distance_miles,
  greatest(0::numeric, round(similarity_score::numeric, 2)) as similarity_score,
  comp_confidence_score,
  deal_grade,
  streetview_image
from candidates
where distance_miles <= p_radius_miles
order by
  similarity_score desc nulls last,
  sale_date desc nulls last,
  distance_miles asc
limit least(greatest(p_limit, 1), 100);
$function$;

-- Production grants EXECUTE to PUBLIC (and therefore anon/authenticated).
-- See README.md "Production posture findings" — reproduced for parity, not
-- endorsed.
GRANT EXECUTE ON FUNCTION public.get_comp_candidates_for_subject(text, numeric, integer, integer)
  TO PUBLIC;
