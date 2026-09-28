-- COMPS INTELLIGENCE — MARKET EVIDENCE READ MODEL.
--
-- The acquisition engine prices from the engine pool (v_recent_sold_comps /
-- buyer_comp_raw_v2, ~40K usable sales). The canonical transaction corpus in
-- comp_private (~330K recorded transactions; ~41.6K recent, priced and
-- geocoded) carried transaction-quality evidence the engine pool lacks —
-- arm's-length, cash vs financed, deed type, resolved buyer entities — but no
-- comp surface could read it spatially.
--
-- This read model flattens each canonical transaction with its property
-- attributes and (privacy-safe) buyer context into one indexed relation, so a
-- comp search is a bounded spatial range scan whatever the corpus size. When
-- the ~500K national corpus lands in comp_private it flows in on refresh; the
-- query shape does not change.
--
-- Privacy (W8C serving rule): company buyer/seller names are carried; a person
-- is never named — only its kind, and for resolved buyers the opaque public
-- buyer_id already served by Entity Graph (eg_buyer_index).
--
-- Service-role only. Nothing here is exposed to browsers directly.

create materialized view if not exists comp_private.mv_comp_market_evidence as
with txn as (
  select
    t.id as txn_id,
    t.primary_property_id as property_id,
    t.event_date,
    t.price::numeric as price,
    t.price_code,
    t.doc_type,
    t.is_arms_length,
    t.is_cash_purchase,
    t.financing_kind,
    t.concurrent_loan_amount,
    t.corpus_membership,
    t.buyer_1_name,
    t.seller_1_name
  from comp_private.comp_canonical_transactions t
  where t.price > 0 and t.event_date is not null
),
geo as (
  select
    x.*,
    coalesce(cp.latitude, p.latitude)::double precision as lat,
    coalesce(cp.longitude, p.longitude)::double precision as lng,
    coalesce(cp.address_full, p.property_address_full) as address,
    coalesce(cp.city, p.property_address_city) as city,
    coalesce(cp.state::text, p.property_address_state) as state,
    coalesce(cp.zip5::text, p.property_address_zip) as zip,
    coalesce(cp.property_type, p.property_type) as property_type,
    coalesce(cp.units_count::numeric, p.units_count::numeric) as units,
    coalesce(cp.bedrooms::numeric, p.total_bedrooms::numeric) as beds,
    coalesce(cp.baths, p.total_baths::numeric) as baths,
    coalesce(cp.building_sqft::numeric, p.building_square_feet::numeric) as sqft,
    coalesce(cp.lot_sqft::numeric, p.lot_square_feet::numeric) as lot_sqft,
    coalesce(cp.year_built::numeric, p.year_built::numeric) as year_built,
    cp.estimated_value::numeric as corpus_value,
    case when cp.property_id is not null then 'comp_corpus' else 'seller_corpus' end as corpus
  from txn x
  left join comp_private.comp_properties cp on cp.property_id = x.property_id
  left join public.properties p on p.property_id = x.property_id and cp.property_id is null
),
buyer as (
  select distinct on (l.canonical_transaction_id)
    l.canonical_transaction_id,
    b.buyer_id,
    b.entity_type,
    case when b.entity_type = 'company' then b.display_name end as company_name,
    b.acquisition_count,
    b.activity_status,
    b.archetype
  from comp_private.w8c_transaction_buyer_links l
  join public.eg_buyer_index b on b.entity_key = l.buyer_entity_id
  order by l.canonical_transaction_id, l.confidence desc nulls last
)
select
  g.txn_id,
  g.property_id,
  g.lat,
  g.lng,
  g.event_date,
  g.price,
  g.price_code,
  g.doc_type,
  g.is_arms_length,
  g.is_cash_purchase,
  g.financing_kind,
  (g.concurrent_loan_amount is not null and g.concurrent_loan_amount > 0) as has_concurrent_loan,
  g.corpus,
  g.address,
  g.city,
  g.state,
  case when length(g.zip) = 4 then '0' || g.zip else g.zip end as zip,
  g.property_type,
  case
    when g.property_type ~* '(apartment)' and coalesce(g.units, 0) >= 5 then 'apartment'
    when g.property_type ~* '(multi|duplex|triplex|quad|plex)' or coalesce(g.units, 0) >= 2 then 'multifamily'
    when g.property_type ~* '(condo)' then 'condo'
    when g.property_type ~* '(land|lot)' then 'land'
    when g.property_type ~* '(commercial|office|retail|industrial)' then 'commercial'
    when g.property_type ~* '(mobile|manufactured)' then 'mobile_home'
    else 'single_family'
  end as family,
  g.units,
  g.beds,
  g.baths,
  g.sqft,
  g.lot_sqft,
  g.year_built,
  g.corpus_value,
  case when g.sqft > 0 then round(g.price / g.sqft, 2) end as ppsf,
  case when coalesce(g.units, 0) >= 2 then round(g.price / g.units, 0) end as ppu,
  -- A $1–$10K transfer or a price far below the corpus value is not a market sale.
  (g.price < 10000 or (g.corpus_value > 0 and g.price < g.corpus_value * 0.25)) as nominal_price,
  g.doc_type ~* '(quit\s*claim|trustee|sheriff|foreclos|tax deed|executor|personal representative|affidavit|gift|interfamily)' as distress_or_transfer_deed,
  bu.buyer_id,
  coalesce(bu.entity_type,
    case
      when g.buyer_1_name ~* '\m(llc|l\.l\.c|inc|corp|co|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\M' then 'company'
      when g.buyer_1_name is not null then 'person'
    end) as buyer_kind,
  coalesce(bu.company_name,
    case when g.buyer_1_name ~* '\m(llc|l\.l\.c|inc|corp|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\M' then g.buyer_1_name end) as buyer_company,
  bu.acquisition_count as buyer_acquisitions,
  bu.activity_status as buyer_activity,
  bu.archetype as buyer_archetype,
  case
    when g.seller_1_name ~* '\m(llc|l\.l\.c|inc|corp|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\M' then 'company'
    when g.seller_1_name is not null then 'person'
  end as seller_kind,
  case when g.seller_1_name ~* '\m(llc|l\.l\.c|inc|corp|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\M' then g.seller_1_name end as seller_company
from geo g
left join buyer bu on bu.canonical_transaction_id = g.txn_id
where g.lat is not null and g.lng is not null;

create unique index if not exists mv_comp_market_evidence_txn on comp_private.mv_comp_market_evidence (txn_id);
create index if not exists mv_comp_market_evidence_latlng on comp_private.mv_comp_market_evidence (lat, lng);
create index if not exists mv_comp_market_evidence_date on comp_private.mv_comp_market_evidence (event_date);
create index if not exists mv_comp_market_evidence_property on comp_private.mv_comp_market_evidence (property_id);

revoke all on comp_private.mv_comp_market_evidence from public, anon, authenticated;
grant select on comp_private.mv_comp_market_evidence to service_role;

-- Bounded spatial read. Returns at most p_limit transactions (≤ 400), nearest
-- same-family first, plus the exact count inside the radius/window so the UI
-- can say "showing 400 of 1,212" rather than pretending the set is complete.
create or replace function public.comps_market_evidence(
  p_lat double precision,
  p_lng double precision,
  p_radius_miles numeric default 1.5,
  p_months integer default 24,
  p_family text default null,
  p_limit integer default 250
) returns jsonb
language sql
stable
as $function$
with box as (
  select
    p_lat - (p_radius_miles / 68.5) as lat0, p_lat + (p_radius_miles / 68.5) as lat1,
    p_lng - (p_radius_miles / (68.5 * greatest(cos(radians(p_lat)), 0.05))) as lng0,
    p_lng + (p_radius_miles / (68.5 * greatest(cos(radians(p_lat)), 0.05))) as lng1
),
hits as (
  select e.*,
    3958.8 * acos(least(1, greatest(-1,
      cos(radians(p_lat)) * cos(radians(e.lat)) * cos(radians(e.lng) - radians(p_lng)) +
      sin(radians(p_lat)) * sin(radians(e.lat))))) as distance_miles
  from comp_private.mv_comp_market_evidence e, box b
  where e.lat between b.lat0 and b.lat1
    and e.lng between b.lng0 and b.lng1
    and e.event_date >= current_date - make_interval(months => p_months)
),
inside as (
  select * from hits where distance_miles <= p_radius_miles
),
ranked as (
  select * from inside
  order by (case when p_family is null or family = p_family then 0 else 1 end), distance_miles, event_date desc
  limit least(greatest(p_limit, 1), 400)
)
select jsonb_build_object(
  'total_in_radius', (select count(*) from inside),
  'total_same_family', (select count(*) from inside where p_family is null or family = p_family),
  'returned', (select count(*) from ranked),
  'rows', coalesce((select jsonb_agg(to_jsonb(r) - 'lat' - 'lng' || jsonb_build_object('lat', r.lat, 'lng', r.lng, 'distance_miles', round(r.distance_miles::numeric, 2))) from ranked r), '[]'::jsonb)
);
$function$;

revoke all on function public.comps_market_evidence(double precision, double precision, numeric, integer, text, integer) from public, anon, authenticated;
grant execute on function public.comps_market_evidence(double precision, double precision, numeric, integer, text, integer) to service_role;

create or replace function comp_private.refresh_comp_market_evidence() returns void
language sql as $$ refresh materialized view concurrently comp_private.mv_comp_market_evidence $$;
revoke all on function comp_private.refresh_comp_market_evidence() from public, anon, authenticated;

-- Daily refresh, after the Entity Graph buyer read model (09:17 UTC) it joins.
select cron.schedule('refresh_comp_market_evidence', '47 9 * * *', $$select comp_private.refresh_comp_market_evidence()$$);

-- Precomputed ZIP × asset-family market context (comp_market_cells), service-role only.
create or replace function public.comps_market_cell(p_zip text, p_asset_family text, p_window_days integer default 365)
returns jsonb language sql stable as $function$
  select to_jsonb(c) - 'id' - 'built_by' - 'created_at' - 'evidence_coverage'
  from comp_private.comp_market_cells c
  where c.geo_level = 'zip5' and c.geo_key = lpad(p_zip, 5, '0') and c.grain = 'use'
    and c.asset_family = p_asset_family and c.window_days = p_window_days
  order by c.as_of desc
  limit 1
$function$;
revoke all on function public.comps_market_cell(text, text, integer) from public, anon, authenticated;
grant execute on function public.comps_market_cell(text, text, integer) to service_role;

-- Same serving pattern as the Entity Graph RPCs: definer rights over
-- comp_private, pinned search_path, execute for service_role only.
alter function public.comps_market_evidence(double precision, double precision, numeric, integer, text, integer) security definer set search_path = public, comp_private, pg_temp;
alter function public.comps_market_cell(text, text, integer) security definer set search_path = public, comp_private, pg_temp;
