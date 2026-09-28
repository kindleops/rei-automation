-- COMP CANDIDATES: SAME ASSET FAMILY + UNIT BAND FIRST.
--
-- get_comp_candidates_for_subject ranked the 100-row pool by similarity, where
-- a different asset class only cost 20 points. In single-family-dense areas
-- the pool for a multifamily subject filled with single-family sales that the
-- acquisition engine then rejects (asset_type_mismatch), starving it of real
-- multifamily comps. Measured 2026-09-27: a 7-unit subject (25224144) got 100
-- candidates of which 9 were in its family and unit band; 2136762817 (2 units)
-- had 99/100 rejected and was valued off the single survivor — a $332.5M
-- portfolio sale.
--
-- Change: rank candidates by asset-family match FIRST, then similarity, date,
-- distance. Family = single_family vs multifamily/apartment; unit band mirrors
-- the engine's eligibility (comp_units / subject_units within 0.35–2.75 for
-- multifamily; single-unit for single family). Signature, columns and filters
-- are unchanged; only which 100 rows are returned (and their order) changes.
-- The subject fallback also now classifies 5+ unit 'Apartment' as apartment.
create or replace function public.get_comp_candidates_for_subject(
  p_subject_property_id text,
  p_radius_miles numeric default 1.0,
  p_months_back integer default 6,
  p_limit integer default 25
)
returns table(comp_id uuid, property_id text, address text, city text, state text, zip text, latitude numeric, longitude numeric, sale_price numeric, sale_date date, mls_sold_price numeric, mls_sold_date date, estimated_value numeric, price_off_value numeric, percent_off numeric, ppsf numeric, ppu numeric, ppbd numeric, asset_class text, property_type text, building_condition text, construction_type text, beds numeric, baths numeric, sqft numeric, units_count numeric, year_built numeric, distance_miles numeric, similarity_score numeric, comp_confidence_score numeric, deal_grade text, streetview_image text)
language sql
stable
as $function$
with subject as (
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

  select
    property_id,
    latitude,
    longitude,
    case
      when property_type = 'Apartment' and coalesce(units_count, 0) >= 5 then 'apartment'
      when property_type in ('Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex') then 'multifamily'
      when coalesce(units_count, 0) >= 2 then 'multifamily'
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
subject_family as (
  select
    s.*,
    case when s.normalized_asset_class in ('multifamily', 'apartment') then 'multi' else 'single' end as family,
    greatest(coalesce(nullif(s.units_count, 0), 1), 1)::numeric as family_units
  from subject s
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
    ) as similarity_score,

    case
      when (case when c.normalized_asset_class in ('multifamily', 'apartment') then 'multi' else 'single' end) <> s.family then 2
      when s.family = 'single' and coalesce(nullif(c.units_count, 0), 1) <= 1 then 0
      when s.family = 'multi'
        and greatest(coalesce(nullif(c.units_count, 0), 1), 1) / s.family_units between 0.35 and 2.75 then 0
      else 1
    end as asset_rank
  from public.v_recent_sold_comps c
  cross join subject_family s
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
  asset_rank asc,
  similarity_score desc nulls last,
  sale_date desc nulls last,
  distance_miles asc
limit least(greatest(p_limit, 1), 100);
$function$;
