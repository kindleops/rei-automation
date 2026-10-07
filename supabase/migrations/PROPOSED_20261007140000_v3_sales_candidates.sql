-- =============================================================================
-- PROPOSED — NOT APPLIED. FAST-SHIP: one fresh comp corpus for the comp DISPLAY
-- readers (Comp Intelligence, Deal Intelligence; Buyer Match already reads
-- mv_comp_market_evidence, current to 2026-09-10) and the merged V3 engine.
--
-- Today the display readers use get_comp_candidates_for_subject ->
-- public.v_recent_sold_comps, newest sale 2026-05-08. This adds
-- comp_private.mv_v3_sales_candidates over public.mv_map_market_sales
-- (= comp_private.comp_canonical_transactions + MLS; newest 2026-09-10) and the
-- RPCs get_v3_sales_candidates / get_v3_subject_geography.
-- Consumer code: apps/api/src/lib/domain/comp-intelligence/canonical-corpus-reads.js
-- (flag COMPS_CANONICAL_CORPUS_READS, default ON; missing RPC -> today's source).
--
-- Order:  1) PROPOSED_20261007140000_v3_sales_candidates_pretest.sql (read-only)
--         2) PART A below (one transaction)
--         3) PART B (populate, outside a transaction)
--         4) PART C (indexes CONCURRENTLY — must NOT run inside a transaction)
--         5) PROPOSED_20261007140000_v3_sales_candidates_verify.sql
-- Rollback: PROPOSED_20261007140000_v3_sales_candidates_rollback.sql. Apply via the MCP channel (history is drifted),
-- outside 05:00–08:59 / 09:15–11:59 UTC.
-- Size estimate: the MV ~0.3–0.4 GB (source MV is 283 MB for 665K rows) + ~0.2 GB indexes.
-- =============================================================================

-- ── PART A (transaction) ─────────────────────────────────────────────────────
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create materialized view comp_private.mv_v3_sales_candidates as
with base as (
  select
    m.comp_id, m.txn_id, m.source, m.sold_on, m.price::float8 as price, m.lat, m.lng, m.property_id, m.address,
    m.city, m.state, m.zip, m.property_type, m.beds::float8 as beds, m.baths::float8 as baths, m.sqft::float8 as sqft,
    m.year_built, m.units::float8 as units, m.estimated_value::float8 as estimated_value, m.portfolio_size,
    m.buyer, m.buyer_class, m.is_investor, m.buyer_kind, m.doc_type, m.is_cash_purchase, m.is_arms_length, m.price_source
  from public.mv_map_market_sales m
  where m.price > 0 and m.lat is not null and m.lng is not null
),
-- Multi-parcel consideration counts (same date + same price), the same keys the
-- v3.1 bulkIndex uses: 2+ parcels in a zip, or 3+ in a city, is a package deed.
bulk_zip as (
  select sold_on, price, left(zip, 5) as zip5, count(distinct property_id)::int as parcels
  from base group by 1, 2, 3 having count(distinct property_id) > 1
),
bulk_city as (
  select sold_on, price, lower(city) as city_l, upper(state) as state_u, count(distinct property_id)::int as parcels
  from base group by 1, 2, 3, 4 having count(distinct property_id) > 1
),
latest as (
  select property_id, max(sold_on) as last_sold_on from base group by 1
)
select
  b.*,
  cp.subdivision_name, cp.census_tract, cp.fips, cp.lot_sqft::float8 as lot_sqft,
  cp.estimated_repair_cost::float8 as estimated_repair_cost, cp.condition_code,
  cp.is_corporate_owner as owner_corporate, cp.is_trust as owner_trust, cp.out_of_state_owner as owner_out_of_state,
  cp.last_observed_at, cp.owner_mailing_identity_key_v1,
  -- mi_owner_link@1: the owner of record is the buyer of THIS sale only when no
  -- buyer was recorded, there is no later sale > 45 days after, and the owner
  -- snapshot was observed >= 30 days after the sale.
  (b.buyer is null and b.buyer_kind is null
    and l.last_sold_on <= b.sold_on + 45
    and cp.last_observed_at::date >= b.sold_on + 30) as owner_linked,
  coalesce(bz.parcels, 1) as bulk_parcels_zip,
  coalesce(bc.parcels, 1) as bulk_parcels_city,
  (b.sold_on = l.last_sold_on) as is_latest_sale,
  case when b.property_type in ('Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex') or b.units >= 2 then 'mf'
       when coalesce(b.property_type, 'Single Family') in ('Single Family', 'SFR', 'Townhouse') then 'sfr'
       else 'other' end as lane_class,
  public.st_setsrid(public.st_makepoint(b.lng, b.lat), 4326)::public.geography as geog
from base b
left join comp_private.comp_properties cp on cp.property_id = b.property_id
left join latest l on l.property_id = b.property_id
left join bulk_zip bz on bz.sold_on = b.sold_on and bz.price = b.price and bz.zip5 = left(b.zip, 5)
left join bulk_city bc on bc.sold_on = b.sold_on and bc.price = b.price and bc.city_l = lower(b.city) and bc.state_u = upper(b.state)
with no data;

-- Candidates for one subject: geo (ST_DWithin on the GIST index) + date window
-- (strictly before p_as_of: the as-of contract that makes backtests leak-free)
-- + lane. Newest first, capped at 9000 (the merged lane readCap).
create or replace function public.get_v3_sales_candidates(
  p_lat float8, p_lng float8, p_radius_miles float8, p_since date, p_as_of date, p_lane text, p_limit int default 9000)
returns table (
  comp_id text, source text, sold_on text, price float8, lat float8, lng float8, property_id text, address text, city text,
  state text, zip text, property_type text, beds float8, baths float8, sqft float8, year_built int, units float8,
  portfolio_size int, buyer text, buyer_class text, is_investor boolean, buyer_kind text, doc_type text, is_cash_purchase boolean,
  is_arms_length boolean, price_source text, estimated_value float8, subdivision_name text, census_tract text, fips text,
  estimated_repair_cost float8, condition_code int, lot_sqft float8, owner_linked boolean, owner_corporate boolean,
  owner_trust boolean, owner_out_of_state boolean, owner_mail_stack int, bulk_parcels_zip int, bulk_parcels_city int)
language sql stable security definer
set search_path = ''
set statement_timeout = '15s'
as $$
  select c.comp_id::text, c.source::text, c.sold_on::text, c.price, c.lat::float8, c.lng::float8, c.property_id::text, c.address::text,
    c.city::text, c.state::text, c.zip::text, c.property_type::text, c.beds, c.baths, c.sqft, c.year_built::int, c.units,
    c.portfolio_size::int, c.buyer::text, c.buyer_class::text, c.is_investor, c.buyer_kind::text, c.doc_type::text, c.is_cash_purchase,
    c.is_arms_length, c.price_source::text, c.estimated_value, c.subdivision_name::text, c.census_tract::text, c.fips::text,
    c.estimated_repair_cost, c.condition_code::int, c.lot_sqft, c.owner_linked, c.owner_corporate, c.owner_trust, c.owner_out_of_state,
    case when c.owner_mailing_identity_key_v1 is null or c.owner_corporate is true then null
         else (select count(*) from (select 1 from comp_private.comp_properties c2
                where c2.owner_mailing_identity_key_v1 = c.owner_mailing_identity_key_v1 limit 5) s)::int end,
    c.bulk_parcels_zip, c.bulk_parcels_city
  from comp_private.mv_v3_sales_candidates c
  -- search_path is '': PostGIS (schema public) is schema-qualified.
  where public.st_dwithin(c.geog, public.st_setsrid(public.st_makepoint(p_lng, p_lat), 4326)::public.geography, least(greatest(p_radius_miles, 0.1), 15) * 1609.344)
    and c.sold_on >= p_since and c.sold_on < p_as_of
    and c.lane_class = case when p_lane = 'sfr' then 'sfr' else 'mf' end
  order by c.sold_on desc
  limit least(greatest(coalesce(p_limit, 9000), 1), 9000)
$$;

-- Subject geography for the barrier / subdivision rules: the subject's own record
-- (is_subject = true; tract left-padded to 6 digits by the caller) + the 7 nearest
-- owner-snapshot parcels (public.properties ids are not comp_properties ids).
create or replace function public.get_v3_subject_geography(p_property_id text, p_lat float8, p_lng float8)
returns table (is_subject boolean, fips text, county_name text, census_tract text, subdivision_name text,
  lot_sqft float8, units float8, property_type text, miles float8)
language sql stable security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select true, null::text, coalesce(p.property_address_county_name, p.property_county_name)::text, p.situs_census_tract::text,
    p.subdivision_name::text, p.lot_square_feet::float8, p.units_count::float8, p.property_type::text, 0::float8
  from public.properties p where p.property_id = p_property_id
  union all
  select * from (
    select false, cp.fips::text, cp.county_name::text, cp.census_tract::text, cp.subdivision_name::text, null::float8, null::float8, null::text,
      (3958.8 * 2 * asin(sqrt(sin(radians(cp.latitude - p_lat) / 2) ^ 2 + cos(radians(p_lat)) * cos(radians(cp.latitude))
        * sin(radians(cp.longitude - p_lng) / 2) ^ 2)))::float8 as miles
    from comp_private.comp_properties cp
    where cp.latitude between p_lat - 0.003 and p_lat + 0.003 and cp.longitude between p_lng - 0.0036 and p_lng + 0.0036
    order by miles asc limit 7
  ) n
$$;

revoke all on function public.get_v3_sales_candidates(float8, float8, float8, date, date, text, int) from public, anon, authenticated;
revoke all on function public.get_v3_subject_geography(text, float8, float8) from public, anon, authenticated;
grant execute on function public.get_v3_sales_candidates(float8, float8, float8, date, date, text, int) to service_role;
grant execute on function public.get_v3_subject_geography(text, float8, float8) to service_role;
revoke all on comp_private.mv_v3_sales_candidates from public, anon, authenticated;
commit;

-- ── PART B (populate; no readers yet, so a plain refresh) ───────────────────
set statement_timeout = '0';
refresh materialized view comp_private.mv_v3_sales_candidates;

-- ── PART C (indexes; CONCURRENTLY, one statement at a time, NOT in a transaction) ──
create unique index concurrently if not exists mv_v3_sales_candidates_comp_id_uq on comp_private.mv_v3_sales_candidates (comp_id);
create index concurrently if not exists mv_v3_sales_candidates_geog_gist on comp_private.mv_v3_sales_candidates using gist (geog);
create index concurrently if not exists mv_v3_sales_candidates_lane_sold on comp_private.mv_v3_sales_candidates (lane_class, sold_on desc);
create index concurrently if not exists mv_v3_sales_candidates_property on comp_private.mv_v3_sales_candidates (property_id, sold_on);
analyze comp_private.mv_v3_sales_candidates;

-- Daily refresh (after public.mv_map_market_sales' refresh, inside the existing job):
--   refresh materialized view concurrently comp_private.mv_v3_sales_candidates;
