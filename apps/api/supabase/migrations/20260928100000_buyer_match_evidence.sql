-- BUYER MATCH — observed-behaviour evidence around a subject.
--
-- One bounded, index-driven read for the mobile Buyer Match workspace:
--   near    — W8C-resolved buyers with recorded purchases inside the radius and
--             window (bbox on mv_comp_market_evidence (lat,lng) + haversine),
--             aggregated per buyer, plus their three most relevant purchases;
--   county  — buyers active in the subject's county in the last 24 months
--             with no purchase inside the radius (exploratory evidence);
--   profile — the Entity Graph buyer index row (same public buyer_id space as
--             Entity Graph), identity method, county purchase count from the
--             behaviour profile, and the buyer's foreclosure-deed share (a
--             lender/servicer/agency taking title at foreclosure is not a
--             disposition buyer — the service decides, this only measures).
--
-- Privacy: names are returned for company entities only; person buyers stay
-- opaque (buyer_id is the index's md5 id, entity_key never leaves the DB).
-- Tiering, exclusions and ordering are decided in
-- lib/domain/buyer-match/buyer-match-workspace-service.js (tested), not here.

create or replace function public.buyer_match_evidence(
  p_lat double precision,
  p_lng double precision,
  p_family text,
  p_county_key text default null,
  p_zip text default null,
  p_radius_miles numeric default 5,
  p_months integer default 36,
  p_limit integer default 120
) returns jsonb
language sql
stable
security definer
set search_path = public, comp_private, pg_temp
as $$
with params as (
  select greatest(0.5, least(coalesce(p_radius_miles, 5), 25))::float8 as r,
         greatest(6, least(coalesce(p_months, 36), 60)) as m,
         greatest(10, least(coalesce(p_limit, 120), 200)) as lim
),
near_tx as (
  select m.buyer_id, m.txn_id, m.property_id, m.address, m.city, m.zip, m.event_date, m.price, m.family,
         m.beds, m.baths, m.sqft, m.year_built, m.is_cash_purchase, m.doc_type, m.nominal_price, m.distress_or_transfer_deed,
         3958.8 * 2 * asin(sqrt(power(sin(radians(m.lat - p_lat) / 2), 2)
           + cos(radians(p_lat)) * cos(radians(m.lat)) * power(sin(radians(m.lng - p_lng) / 2), 2))) as d
  from comp_private.mv_comp_market_evidence m, params
  where p_lat is not null and p_lng is not null and m.buyer_id is not null
    and m.lat between p_lat - params.r / 68.5 and p_lat + params.r / 68.5
    and m.lng between p_lng - params.r / (68.5 * greatest(cos(radians(p_lat)), 0.05))
                  and p_lng + params.r / (68.5 * greatest(cos(radians(p_lat)), 0.05))
    and m.event_date >= (current_date - make_interval(months => params.m))
),
near_in as (
  select near_tx.* from near_tx, params where near_tx.d <= params.r
),
near_agg as (
  select buyer_id,
         count(*) as n,
         count(*) filter (where family = p_family) as same_family,
         count(*) filter (where d <= 1) as n_1mi,
         count(*) filter (where p_zip is not null and zip = p_zip) as same_zip,
         min(d) as nearest,
         max(event_date) as last_date,
         percentile_cont(0.5) within group (order by price) filter (where not coalesce(nominal_price, false)) as median_price,
         avg(case when is_cash_purchase then 1.0 when is_cash_purchase = false then 0.0 end) as cash_share
  from near_in
  group by buyer_id
),
near_top as (
  select near_agg.* from near_agg, params
  order by same_family desc, n desc, last_date desc
  limit (select lim from params)
),
county_pool as (
  select b.buyer_id
  from eg_buyer_index b
  where p_county_key is not null
    and b.counties @> array[p_county_key]
    and b.last_acquisition >= current_date - interval '24 months'
    and not exists (select 1 from near_agg a where a.buyer_id = b.buyer_id)
  order by b.trailing_365d desc nulls last, b.acquisition_count desc
  limit 60
),
cands as (
  select buyer_id, true as is_near from near_top
  union all
  select buyer_id, false from county_pool
),
keyed as (
  select c.buyer_id, c.is_near, b.entity_key
  from cands c join eg_buyer_index b on b.buyer_id = c.buyer_id
),
fc as (
  select k.buyer_id,
         count(*) as total,
         count(*) filter (where t.doc_type ~* '(trustee|sheriff|foreclos|deed in lieu|commissioner|public action)') as fc
  from keyed k
  join comp_private.w8c_transaction_buyer_links l on l.buyer_entity_id = k.entity_key
  join comp_private.comp_canonical_transactions t on t.id = l.canonical_transaction_id
  group by k.buyer_id
),
rows as (
  select jsonb_build_object(
    'buyer_id', b.buyer_id,
    'kind', b.entity_type,
    'name', case when b.entity_type = 'company' then b.display_name end,
    'identity_grade', b.entity_grade,
    'identity_method', e.strongest_method,
    'identity_confidence', b.confidence,
    'registry', (b.company_number is not null),
    'jurisdiction', b.jurisdiction_code,
    'aliases', b.alias_count,
    'acquisitions', b.acquisition_count,
    'dispositions', b.disposition_count,
    'first_acquisition', b.first_acquisition,
    'last_acquisition', b.last_acquisition,
    'days_since_last', b.days_since_last,
    't90', b.trailing_90d,
    't180', b.trailing_180d,
    't365', b.trailing_365d,
    'per_year', b.acquisitions_per_year,
    'activity_status', b.activity_status,
    'archetype', b.archetype,
    'hold_flip', b.hold_flip,
    'dominant_family', b.dominant_family,
    'families', to_jsonb(b.asset_families),
    'top_state', b.top_state,
    'primary_market', b.primary_market,
    'counties', to_jsonb(b.counties[1:4]),
    'price_p25', b.price_p25,
    'price_p50', b.price_p50,
    'price_p75', b.price_p75,
    'cash_share', b.cash_share,
    'has_buybox', b.has_buybox,
    'portfolio', b.portfolio_count,
    'owned', b.owned_count,
    'sold', b.sold_count,
    'crossover', b.is_crossover,
    'sqft_p25', nullif(bp.characteristic_profile -> 'building_sqft' ->> 'p25', '')::numeric,
    'sqft_p75', nullif(bp.characteristic_profile -> 'building_sqft' ->> 'p75', '')::numeric,
    'beds_p50', nullif(bp.characteristic_profile -> 'bedrooms' ->> 'median', '')::numeric,
    'units_p50', nullif(bp.characteristic_profile -> 'units' ->> 'median', '')::numeric,
    'county_purchases', (
      select (x ->> 1)::int
      from jsonb_array_elements(coalesce(bp.geography_profile -> 'counties', '[]'::jsonb)) x
      where x ->> 0 = p_county_key
      limit 1),
    'foreclosure_deeds', coalesce(fc.fc, 0),
    'linked_transactions', coalesce(fc.total, 0),
    'near', case when k.is_near then (
      select jsonb_build_object(
        'n', a.n, 'same_family', a.same_family, 'n_1mi', a.n_1mi, 'same_zip', a.same_zip,
        'nearest_miles', round(a.nearest::numeric, 2), 'last_date', a.last_date,
        'median_price', round(a.median_price::numeric), 'cash_share', round(a.cash_share, 3))
      from near_agg a where a.buyer_id = k.buyer_id) end,
    'recent', case when k.is_near then (
      select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) from (
        select row_number() over (order by (x.family = p_family) desc, x.event_date desc) as rank,
               x.txn_id, x.property_id, x.address, x.city, x.zip, x.event_date as date, x.price, x.family,
               x.beds, x.baths, x.sqft, x.year_built, x.is_cash_purchase as cash, x.doc_type,
               round(x.d::numeric, 2) as miles
        from near_in x where x.buyer_id = k.buyer_id
        order by (x.family = p_family) desc, x.event_date desc
        limit 3) r) end
  ) as j
  from keyed k
  join eg_buyer_index b on b.buyer_id = k.buyer_id
  left join comp_private.w8c_buyer_entities e on e.buyer_entity_id = k.entity_key
  left join comp_private.w8c_buyer_behavior_profiles bp on bp.buyer_entity_id = k.entity_key
  left join fc on fc.buyer_id = k.buyer_id
)
select jsonb_build_object(
  'radius_miles', (select r from params),
  'months', (select m from params),
  'transactions_in_radius', (select count(*) from near_in),
  'same_family_transactions_in_radius', (select count(*) from near_in where family = p_family),
  'buyers_in_radius', (select count(*) from near_agg),
  'county_buyers_active_24m', case when p_county_key is null then null else (
    select count(*) from eg_buyer_index b
    where b.counties @> array[p_county_key] and b.last_acquisition >= current_date - interval '24 months') end,
  'buyers', coalesce((select jsonb_agg(j) from rows), '[]'::jsonb)
);
$$;

revoke all on function public.buyer_match_evidence(double precision, double precision, text, text, text, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.buyer_match_evidence(double precision, double precision, text, text, text, numeric, integer, integer) to service_role;
