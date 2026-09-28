-- ============================================================================
-- AREA MARKET DEMAND — what the market is actually doing near a subject, for
-- the SAME asset family. Read-only; independent of Buyer Match.
--
-- Source: public.mv_map_sold_comps (unified sold comps: MLS / public record
-- from v_recent_sold_comps + the investor-purchase feed recently_sold_properties).
--
-- Adds ONLY new objects:
--   public.deal_market_asset_family(text, numeric)   -> text  (immutable helper)
--   public.deal_market_demand(text, numeric, integer) -> jsonb (stable read model)
--   index mv_map_sold_comps_sold_on on the MV (cheap data_through lookup)
--
-- Sales vs priced sales:
--   Every same-family transfer in the radius/window is a SALE (it counts toward
--   volume and buyer mix). Only sales with a recorded price feed the price
--   statistics. Unpriced sales are common (~55% of the investor feed, ~30% of
--   public record) and are NOT outliers — they are reported as unpriced.
--
-- Pricing rules:
--   * Portfolio sales (portfolio_size >= 2: one buyer, one date, one recorded
--     price across several doors) use per_door, never the package price — a
--     $30M package must not poison an area median. Exception: when the recorded
--     price already sits within 0.5x-2x the comp's own estimated_value and
--     per_door is < 0.5x of it, the recorded price is per-property (two
--     same-price buys the same day), so the recorded price is kept.
--   * Priced outliers are excluded AND counted by reason: effective price
--     < $10k, > 20x or < 1/20 of the subject's estimated_value, $/sqft outside
--     [$8, $2,500]; then > 6x / < 1/6 of the area median price, or > 4x / < 1/4
--     of the area median $/sqft.
--
-- Radius: p_radius_miles, widened automatically through 3 -> 5 -> 10 miles until
-- at least 8 priced sales exist (5 for apartments); the radius actually used
-- is returned with the per-tier counts.
-- Apartments (5+ units) are compared inside a units band [max(5, 0.4N), 2.5N],
-- relaxed (reported) only if the band cannot reach the target even at 10 miles.
--
-- Investor vs retail (explicit, returned in the payload):
--   investor     = buyer_class in (llc_investor, institutional, hedge_fund,
--                  portfolio, builder) on any source, OR any non-bank /
--                  non-government sale from the investor-purchase feed
--                  (source = 'investor').
--   retail       = MLS sale whose buyer is not an entity (buyer_class unknown /
--                  individual / trust), OR a public-record sale to a named
--                  individual / trust — the owner-occupant proxy.
--   unclassified = public-record sale with no buyer on record.
--   non_market   = bank / government buyers (REO, agency) — in neither side.
--   non_investor = retail + unclassified (every arm's-length sale not
--                  attributed to an investor) — the comparator that is
--                  available far more often than MLS-only retail.
-- ============================================================================

create index if not exists mv_map_sold_comps_sold_on
  on public.mv_map_sold_comps using btree (sold_on);

create or replace function public.deal_market_asset_family(p_property_type text, p_units numeric)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when p_property_type is null or btrim(p_property_type) = '' then 'unknown'
    when p_property_type ~* '(land|lot\M)' then 'land'
    when p_property_type ~* '(mobile|manufactured)' then 'mobile_home'
    when p_property_type ~* 'condo' then 'condo'
    when p_property_type ~* '(apartment|multi|duplex|triplex|quadruplex|fourplex|5\+)' then
      case
        when p_units >= 5 then 'apartment'
        when p_units between 2 and 4 then 'multifamily'
        when p_property_type ~* '(apartment|5\+)' then 'apartment'
        else 'multifamily'
      end
    when p_property_type ~* '(single|sfr|townho|residential)' then
      case
        when p_units between 2 and 4 then 'multifamily'
        when p_units >= 5 then 'other'
        else 'residential_1'
      end
    when p_property_type ~* '(commercial|office|retail|industrial|warehouse|mixed)' then 'commercial'
    else 'other'
  end
$fn$;

comment on function public.deal_market_asset_family(text, numeric) is
  'Asset family for area market demand: residential_1 (single family + townhouse), condo, multifamily (2-4 units), apartment (5+), land, mobile_home, commercial, other.';

create or replace function public.deal_market_demand(
  p_property_id text,
  p_radius_miles numeric default 1.5,
  p_months integer default 12
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $fn$
with prm as (
  select
    p.property_id,
    p.latitude::double precision  as lat,
    p.longitude::double precision as lng,
    p.property_type,
    coalesce(p.units_count::numeric, p.multifamily_units) as units,
    public.deal_market_asset_family(p.property_type, coalesce(p.units_count::numeric, p.multifamily_units)) as family,
    nullif(p.building_square_feet, 0) as sqft,
    nullif(p.estimated_value, 0)      as est_value,
    left(p.property_address_zip, 5)   as zip,
    p.property_address_city  as city,
    p.property_address_state as state,
    least(greatest(coalesce(p_radius_miles, 1.5), 0.25), 10)::numeric as r0,
    least(greatest(coalesce(p_months, 12), 1), 60)::int               as months
  from properties p
  where p.property_id = p_property_id
  limit 1
),
cfg as (
  select
    prm.*,
    (current_date - make_interval(months => prm.months))::date as since,
    t.tiers,
    t.tiers[array_upper(t.tiers, 1)] as rmax,
    case when prm.family = 'apartment' then 5 else 8 end as min_sales,
    (prm.family = 'apartment' and coalesce(prm.units, 0) >= 5) as band_possible,
    case when prm.family = 'apartment' and prm.units >= 5 then greatest(5, floor(prm.units * 0.4)) end as band_lo,
    case when prm.family = 'apartment' and prm.units >= 5 then ceil(prm.units * 2.5) end            as band_hi
  from prm
  cross join lateral (
    select array(
      select distinct x from unnest(array[prm.r0, 3, 5, 10]::numeric[]) x
      where x >= prm.r0 order by x
    ) as tiers
  ) t
  where prm.lat is not null and prm.lng is not null
),
base as (
  select
    c.comp_id, c.source, c.sold_on, c.price, c.beds, c.sqft, c.units, c.year_built,
    c.buyer, c.buyer_class, c.portfolio_size, c.out_of_state_owner,
    -- the MV stores some zips as integers ("6051"): restore the leading zero
    case when c.zip ~ '^[0-9]{3,4}$' then lpad(c.zip, 5, '0') else left(c.zip, 5) end as zip,
    d.dist,
    e.eff_price,
    case when cfg.family <> 'land' and c.sqft >= 300 and e.eff_price > 0
         then e.eff_price / c.sqft end as eff_ppsf,
    case when cfg.family in ('multifamily', 'apartment') and c.units >= 2 and e.eff_price > 0
         then e.eff_price / c.units end as eff_ppu,
    (not cfg.band_possible or c.units between cfg.band_lo and cfg.band_hi) as in_band
  from cfg
  join mv_map_sold_comps c
    on c.lat between cfg.lat - cfg.rmax / 69.0 and cfg.lat + cfg.rmax / 69.0
   and c.lng between cfg.lng - cfg.rmax / (69.0 * cos(radians(cfg.lat)))
                 and cfg.lng + cfg.rmax / (69.0 * cos(radians(cfg.lat)))
   and c.sold_on >= cfg.since
   and c.sold_on <= current_date
   and c.property_id is distinct from cfg.property_id
  cross join lateral (
    select 3958.8 * 2 * asin(least(1.0, sqrt(
      power(sin(radians(c.lat - cfg.lat) / 2), 2)
      + cos(radians(cfg.lat)) * cos(radians(c.lat)) * power(sin(radians(c.lng - cfg.lng) / 2), 2)
    ))) as dist
  ) d
  cross join lateral (
    select case
      when c.portfolio_size >= 2 then
        case
          when c.estimated_value > 0
           and c.price between 0.5 * c.estimated_value and 2 * c.estimated_value
           and c.per_door < 0.5 * c.estimated_value
            then c.price
          else c.per_door
        end
      else c.price
    end as eff_price
  ) e
  where d.dist <= cfg.rmax
    and public.deal_market_asset_family(c.property_type, c.units) = cfg.family
),
flag1 as (
  select b.*,
    case
      when b.eff_price < 10000 then 'price_under_10k'
      when cfg.est_value is not null and b.eff_price > 20 * cfg.est_value then 'price_over_20x_subject_value'
      when cfg.est_value is not null and b.eff_price < cfg.est_value / 20 then 'price_under_5pct_subject_value'
      when b.eff_ppsf is not null and (b.eff_ppsf < 8 or b.eff_ppsf > 2500) then 'ppsf_out_of_range'
    end as abs_excl
  from base b cross join cfg
),
tier as (
  select t.r,
         count(*) filter (where f.dist <= t.r and f.abs_excl is null)                                              as sales,
         count(*) filter (where f.dist <= t.r and f.abs_excl is null and f.eff_price is not null)                  as priced,
         count(*) filter (where f.dist <= t.r and f.abs_excl is null and f.eff_price is not null and f.in_band)    as priced_in_band
  from cfg
  cross join unnest(cfg.tiers) t(r)
  left join flag1 f on true
  group by t.r
),
pick as (
  select
    coalesce(pb.r, pa.r, (select max(r) from tier)) as radius_used,
    coalesce((select band_possible from cfg), false) and (pb.r is not null or pa.r is null) as band_applied
  from (select min(r) as r from tier where priced_in_band >= (select min_sales from cfg)) pb
  cross join (select min(r) as r from tier where priced >= (select min_sales from cfg)) pa
),
sel as (
  select f.* from flag1 f cross join pick
  where f.dist <= pick.radius_used and (not pick.band_applied or f.in_band)
),
-- MATERIALIZED: inlined, the planner re-aggregates this per row of sel
-- (nested loop), which is O(n^2) — 3.2s at 2.5k sales vs ~0.1s materialized.
med0 as materialized (
  select percentile_cont(0.5) within group (order by eff_price) as mp,
         percentile_cont(0.5) within group (order by eff_ppsf)  as mpsf
  from sel where abs_excl is null
),
flag as (
  select s.*,
    coalesce(s.abs_excl, case
      when m.mp > 0 and (s.eff_price > 6 * m.mp or s.eff_price < m.mp / 6) then 'price_far_from_area_median'
      when m.mpsf > 0 and s.eff_ppsf is not null and (s.eff_ppsf > 4 * m.mpsf or s.eff_ppsf < m.mpsf / 4) then 'ppsf_far_from_area_median'
    end) as excl
  from sel s cross join med0 m
),
k as (
  select f.*,
    case f.buyer_class
      when 'llc_investor'  then 'company_llc'
      when 'institutional' then 'institutional'
      when 'hedge_fund'    then 'institutional'
      when 'portfolio'     then 'portfolio'
      when 'builder'       then 'builder'
      when 'individual'    then 'individual'
      when 'trust'         then 'individual'
      when 'bank'          then 'bank_government'
      when 'government'    then 'bank_government'
      else 'unknown'
    end as buyer_group,
    case
      when f.buyer_class in ('llc_investor', 'institutional', 'hedge_fund', 'portfolio', 'builder') then 'investor'
      when f.buyer_class in ('bank', 'government') then 'non_market'
      when f.source = 'investor' then 'investor'
      when f.source = 'mls' then 'retail'
      when f.source = 'public_record' and f.buyer_class in ('individual', 'trust') then 'retail'
      else 'unclassified'
    end as segment
  from flag f
  where f.excl is null
),
tot as (select count(*)::numeric as total, count(eff_price) as priced from k),
overall as (
  select jsonb_build_object(
    'priced_sales', count(eff_price),
    'median_price', round(percentile_cont(0.5) within group (order by eff_price)::numeric),
    'avg_price',    round(avg(eff_price)),
    'p25_price',    round(percentile_cont(0.25) within group (order by eff_price)::numeric),
    'p75_price',    round(percentile_cont(0.75) within group (order by eff_price)::numeric),
    'median_ppsf',  round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric),
    'ppsf_sample',  count(eff_ppsf),
    'median_ppu',   round(percentile_cont(0.5) within group (order by eff_ppu)::numeric),
    'ppu_sample',   count(eff_ppu),
    'median_beds',  percentile_cont(0.5) within group (order by beds),
    'median_sqft',  round(percentile_cont(0.5) within group (order by sqft)::numeric),
    'median_units', percentile_cont(0.5) within group (order by units),
    'median_year_built', round(percentile_cont(0.5) within group (order by year_built)::numeric),
    'median_distance_miles', round(percentile_cont(0.5) within group (order by dist)::numeric, 2),
    'buyer_known_share', case when count(*) > 0
      then round(count(*) filter (where buyer_group <> 'unknown')::numeric / count(*), 3) end,
    'portfolio_doors', count(*) filter (where portfolio_size >= 2),
    'portfolio_transactions', count(distinct (buyer, sold_on, price)) filter (where portfolio_size >= 2),
    'latest_sale_on',   max(sold_on),
    'earliest_sale_on', min(sold_on)
  ) as j
  from k
),
by_source as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', source, 'count', n, 'priced', np,
    'share', case when tot.total > 0 then round(n / tot.total, 3) end,
    'median_price', mp, 'median_ppsf', mpsf
  ) order by n desc, source), '[]'::jsonb) as j
  from (
    select source, count(*) as n, count(eff_price) as np,
      round(percentile_cont(0.5) within group (order by eff_price)::numeric) as mp,
      round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric)  as mpsf
    from k group by source
  ) s cross join tot
),
by_buyer as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'group', buyer_group, 'count', n, 'priced', np,
    'share', case when tot.total > 0 then round(n / tot.total, 3) end,
    'median_price', mp, 'median_ppsf', mpsf, 'out_of_state_share', oos
  ) order by n desc, buyer_group), '[]'::jsonb) as j
  from (
    select buyer_group, count(*) as n, count(eff_price) as np,
      round(percentile_cont(0.5) within group (order by eff_price)::numeric) as mp,
      round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric)  as mpsf,
      round(avg(case when out_of_state_owner then 1.0 else 0.0 end) filter (where out_of_state_owner is not null), 3) as oos
    from k group by buyer_group
  ) s cross join tot
),
seg as (
  select segment, count(*) as n, count(eff_price) as np,
    round(percentile_cont(0.5) within group (order by eff_price)::numeric) as mp,
    round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric)  as mpsf,
    round(percentile_cont(0.5) within group (order by eff_ppu)::numeric)   as mppu
  from k group by segment
),
noninv as (
  select count(*) as n, count(eff_price) as np,
    round(percentile_cont(0.5) within group (order by eff_price)::numeric) as mp,
    round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric)  as mpsf
  from k where segment in ('retail', 'unclassified')
),
ivr as (
  select jsonb_build_object(
    'investor', jsonb_build_object('count', coalesce(i.n, 0), 'priced', coalesce(i.np, 0),
                                   'median_price', i.mp, 'median_ppsf', i.mpsf, 'median_ppu', i.mppu),
    'retail',   jsonb_build_object('count', coalesce(r.n, 0), 'priced', coalesce(r.np, 0),
                                   'median_price', r.mp, 'median_ppsf', r.mpsf, 'median_ppu', r.mppu),
    'non_investor', jsonb_build_object('count', ni.n, 'priced', ni.np, 'median_price', ni.mp, 'median_ppsf', ni.mpsf),
    'unclassified_count', coalesce((select n from seg where segment = 'unclassified'), 0),
    'non_market_count',   coalesce((select n from seg where segment = 'non_market'), 0),
    'min_sample', 3,
    'discount_pct', case when i.np >= 3 and r.np >= 3 and r.mp > 0
      then round(100 * (1 - i.mp / r.mp), 1) end,
    'ppsf_discount_pct', case when i.np >= 3 and r.np >= 3 and r.mpsf > 0 and i.mpsf is not null
      then round(100 * (1 - i.mpsf / r.mpsf), 1) end,
    'discount_vs_non_investor_pct', case when i.np >= 3 and ni.np >= 3 and ni.mp > 0
      then round(100 * (1 - i.mp / ni.mp), 1) end,
    'definitions', jsonb_build_object(
      'investor', 'buyer_class in (llc_investor, institutional, hedge_fund, portfolio, builder) on any source, OR any non-bank/non-government sale from the investor-purchase feed (source=investor)',
      'retail', 'MLS sale to a non-entity buyer (buyer_class unknown/individual/trust), OR public-record sale to a named individual/trust — owner-occupant proxy',
      'unclassified', 'public-record sale with no buyer on record',
      'non_investor', 'retail + unclassified: every arm''s-length sale not attributed to an investor',
      'non_market', 'bank / government buyers (REO, agency) — excluded from both sides',
      'discount_pct', '(1 - investor median price / retail median price) x 100; null unless both sides have >= 3 priced sales'
    )
  ) as j
  from noninv ni
  left join seg i on i.segment = 'investor'
  left join seg r on r.segment = 'retail'
),
trend as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'quarter', to_char(q, 'YYYY') || '-Q' || to_char(q, 'Q'),
    'quarter_start', q::date,
    'count', n, 'priced', np, 'median_price', mp, 'median_ppsf', mpsf,
    'investor_count', inv
  ) order by q), '[]'::jsonb) as j
  from (
    select date_trunc('quarter', sold_on) as q, count(*) as n, count(eff_price) as np,
      round(percentile_cont(0.5) within group (order by eff_price)::numeric) as mp,
      round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric)  as mpsf,
      count(*) filter (where segment = 'investor') as inv
    from k group by 1
  ) s
),
zips as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'zip', zip, 'count', n, 'priced', np, 'median_price', mp, 'median_ppsf', mpsf,
    'is_subject_zip', zip is not distinct from (select zip from prm)
  ) order by n desc, zip), '[]'::jsonb) as j
  from (
    select zip, count(*) as n, count(eff_price) as np,
      round(percentile_cont(0.5) within group (order by eff_price)::numeric) as mp,
      round(percentile_cont(0.5) within group (order by eff_ppsf)::numeric)  as mpsf
    from k group by zip
    order by count(*) desc, zip
    limit 12
  ) s
),
excl as (
  select coalesce(sum(c), 0)::int as n,
    coalesce(jsonb_object_agg(excl, c), '{}'::jsonb) as by_reason
  from (select excl, count(*) as c from flag where excl is not null group by excl) s
)
select case
  when not exists (select 1 from prm) then
    jsonb_build_object('ok', false, 'error', 'subject_not_found', 'property_id', p_property_id)
  when not exists (select 1 from cfg) then
    jsonb_build_object('ok', false, 'error', 'subject_not_geocoded', 'property_id', p_property_id)
  else jsonb_build_object(
    'ok', true,
    'property_id', p_property_id,
    'subject', (select jsonb_build_object(
        'family', family, 'property_type', property_type, 'units', units, 'sqft', sqft,
        'estimated_value', est_value, 'zip', zip, 'city', city, 'state', state) from prm),
    'radius_requested', (select r0 from prm),
    'radius_used', (select radius_used from pick),
    'min_sales_target', (select min_sales from cfg),
    'radius_tiers', (select coalesce(jsonb_agg(jsonb_build_object(
        'radius', r, 'sales', sales, 'priced', priced, 'priced_in_band', priced_in_band) order by r), '[]'::jsonb) from tier),
    'units_band', (select jsonb_build_object('applied', pick.band_applied, 'min', cfg.band_lo, 'max', cfg.band_hi) from cfg, pick),
    'months', (select months from prm),
    'window', (select jsonb_build_object('since', since, 'until', current_date) from cfg),
    'data_through', (select max(sold_on) from mv_map_sold_comps),
    'total_sales', (select total from tot),
    'priced_sales', (select priced from tot),
    'excluded_outliers', (select n from excl),
    'excluded_by_reason', (select by_reason from excl),
    'overall', (select j from overall),
    'by_source', (select j from by_source),
    'by_buyer', (select j from by_buyer),
    'investor_vs_retail', (select j from ivr),
    'trend', (select j from trend),
    'zips', (select j from zips),
    'generated_at', now()
  )
end
$fn$;

comment on function public.deal_market_demand(text, numeric, integer) is
  'Area market demand for a subject property, same asset family: sales volume, medians ($, $/sqft, $/unit), by source, by buyer class, investor vs retail, quarterly trend, zip counts. Portfolio sales priced per door; outliers excluded and counted. Radius auto-widens 1.5->3->5->10 mi to reach 8 priced sales (5 for apartments).';

revoke all on function public.deal_market_asset_family(text, numeric) from public, anon, authenticated;
grant execute on function public.deal_market_asset_family(text, numeric) to service_role;

revoke all on function public.deal_market_demand(text, numeric, integer) from public, anon, authenticated;
grant execute on function public.deal_market_demand(text, numeric, integer) to service_role;
