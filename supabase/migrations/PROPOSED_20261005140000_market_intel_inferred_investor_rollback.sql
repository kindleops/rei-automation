-- ROLLBACK for PROPOSED_20261005140000_market_intel_inferred_investor.sql. GENERATED; do not edit by hand.
-- Restores the applied summary functions and view byte for byte (from 20261004150000_market_intel_geo_rollup.sql)
-- and drops every inferred object. The core summary tables and their builds are untouched.
-- A build started under the extension still lists 'i:' units: mark it failed first so the next
-- tick starts a clean core build:
update public.mi_rollup_builds set status = 'failed', last_error = 'inferred extension rolled back', finished_at = now(), updated_at = now()
 where status = 'building' and units @> array['i:clusters'];
update public.mi_rollup_builds set cursor = cardinality(units)
 where status = 'ready' and cursor < cardinality(units) and units @> array['i:clusters'];
update public.mi_rollup_builds set notes = notes - 'inferred_investor' - 'inferred_errors' where notes ?| array['inferred_investor', 'inferred_errors'];

create or replace function public.mi_rollup_run_unit(p_build bigint, p_unit text, p_as_of date)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := split_part(p_unit, ':', 1);
  v_level text := split_part(p_unit, ':', 2);
  v_period text := split_part(p_unit, ':', 3);
  v_days integer;
  v_key text;
  v_rows bigint := 0;
  v_n bigint;
  -- asset-filter rule shared by period and month units: per-class rows for the operator
  -- filters, the 'mf' roll-up, and 'all'.
  v_having text := '((grouping(x.asset) = 0 and x.asset in (''sfr'', ''mf_2_4'', ''mf_5_plus'', ''land'', ''commercial''))
                     or (grouping(x.asset) = 1 and grouping(x.is_mf) = 0 and x.is_mf)
                     or (grouping(x.asset) = 1 and grouping(x.is_mf) = 1))';
  v_asset text := 'case when grouping(x.asset) = 0 then x.asset when grouping(x.is_mf) = 0 then ''mf'' else ''all'' end';
begin
  perform set_config('work_mem', '128MB', true);
  if v_kind = 'prepare' then
    -- ZIP → state / city (sale majority), county (census cell, else parcel majority), market.
    insert into public.mi_zip_geo (build_id, zip, state, city_key, county_key, county_name, county_via, market_key, sales_n, min_lat, max_lat, min_lng, max_lng)
    with zs as (
      -- ONE pass over sales: (zip, state, city) groups with counts and bounds.
      select zip, state, city_key, count(*) as n, min(lat) as min_lat, max(lat) as max_lat, min(lng) as min_lng, max(lng) as max_lng
        from public.mi_rollup_sales_v where zip is not null group by 1, 2, 3
    ), st as (
      select distinct on (zip) zip, state from (select zip, state, sum(n) as n from zs group by 1, 2) z order by zip, n desc, state
    ), ct as (
      select distinct on (zip) zip, city_key from (select zip, city_key, sum(n) as n from zs where city_key is not null group by 1, 2) z order by zip, n desc, city_key
    ), agg as (
      select zip, sum(n)::int as n, min(min_lat) as min_lat, max(max_lat) as max_lat, min(min_lng) as min_lng, max(max_lng) as max_lng from zs group by zip
    ), census as (
      select substr(c.geo_id, 6) as zip, replace(c.county_geo_id, 'county:', '') as county_key, c.county_name
        from public.exchange_market_fundamentals_cells c where c.geo_level = 'zip5' and c.county_geo_id is not null
    ), parcel_raw as (
      -- group the 600K parcels first (a plain hash aggregate); normalise the ~2K groups after
      select cp.zip5::text as zip, cp.state::text as st, cp.county_name as cn, count(*) as n
        from comp_private.comp_properties cp
       where cp.zip5 is not null and cp.county_name is not null and btrim(cp.county_name) <> ''
       group by 1, 2, 3
    ), parcel as (
      select distinct on (zip) zip, county_key, county_name from (
        select zip,
               upper(st) || ':' || regexp_replace(regexp_replace(lower(btrim(cn)), '\s+(county|parish|borough)$', ''), '\s+', ' ', 'g') as county_key,
               initcap(regexp_replace(lower(btrim(cn)), '\s+(county|parish|borough)$', '')) as county_name,
               sum(n) as n
          from parcel_raw group by 1, 2, 3) p
       order by zip, n desc, county_key
    ), mk as (
      select z.zip5 as zip, z.canonical_market_id as market_key
        from public.market_zip_membership z join public.canonical_markets cm on cm.id = z.canonical_market_id and cm.is_active
       where z.status = 'resolved'
    ), zips as (
      select zip from agg union select zip from census union select zip from parcel union select zip from mk
    )
    select p_build, z.zip, st.state, ct.city_key,
           coalesce(c.county_key, p.county_key), coalesce(c.county_name, p.county_name),
           case when c.county_key is not null then 'census' when p.county_key is not null then 'parcel_majority' end,
           mk.market_key, coalesce(agg.n, 0), agg.min_lat, agg.max_lat, agg.min_lng, agg.max_lng
      from zips z
      left join st using (zip) left join ct using (zip) left join agg using (zip)
      left join census c using (zip) left join parcel p using (zip) left join mk using (zip)
     where z.zip ~ '^[0-9]{5}$';
    get diagnostics v_n = row_count; v_rows := v_rows + v_n;

    update public.mi_rollup_builds set notes = notes || jsonb_build_object('unmapped_types',
      coalesce((select jsonb_agg(distinct m.property_type) from public.mv_map_market_sales m
                 where m.property_type is not null and not exists (select 1 from public.mi_asset_type_map t where t.raw_type = m.property_type)), '[]'::jsonb))
     where build_id = p_build;
    return v_rows;
  end if;

  if v_kind = 'buyers' then
    -- the ~12.7K sales with a named company buyer (the MV's partial buyer index)
    insert into public.mi_buyer_activity (build_id, comp_id, sold_on, zip, state, city_key, property_type, units, price, qualified, is_investor, buyer)
    select p_build, s.comp_id, s.sold_on, s.zip, s.state, s.city_key, s.property_type, s.units::float8,
           case when s.price > 0 then s.price::float8 end, s.q, s.is_investor, s.buyer
      from public.mi_rollup_sales_v s where s.buyer is not null;
    get diagnostics v_rows = row_count;

    return v_rows;
  end if;

  v_key := public.mi_rollup_level_key(v_level);
  if v_key is null then raise exception 'mi_rollup: unknown level in unit %', p_unit; end if;

  if v_kind = 'p' then
    v_days := case v_period when '30d' then 30 when '90d' then 90 when '6m' then 182 when '1y' then 365 when '3y' then 1095 when 'all' then null
              else -1 end;
    if v_days = -1 then raise exception 'mi_rollup: unknown period in unit %', p_unit; end if;
    execute format($q$
      insert into public.mi_geo_period_rollup (build_id, geo_level, geo_key, period, asset,
        sale_count, priced_sale_count, qualified_sale_count, mls_count, mf_sale_count, investor_count, buyer_known_count,
        cash_known_count, cash_count, entity_owned_count, latest_sale,
        median_price, median_ppsf, ppsf_n, median_ppu, ppu_n, median_inv_price, inv_price_n, price_deciles,
        n_sfr, n_mf_2_4, n_mf_5_plus, n_mf_unknown, n_land, n_commercial, n_other_res, n_unknown,
        u_2, u_3, u_4, u_5_9, u_10_19, u_20_49, u_50p, u_unrec, s_lt2k, s_2_4k, s_4_8k, s_8_20k, s_20kp, s_unrec)
      select $1, $2, x.k, $3, %2$s,
        count(*) filter (where x.w), count(*) filter (where x.w and x.priced), count(*) filter (where x.w and x.q),
        count(*) filter (where x.w and x.is_mls), count(*) filter (where x.w and x.is_mf), count(*) filter (where x.w and x.is_investor),
        count(*) filter (where x.w and x.buyer_known), count(*) filter (where x.w and x.is_cash_purchase is not null),
        count(*) filter (where x.w and x.is_cash_purchase), count(*) filter (where x.entity), max(x.sold_on) filter (where x.w),
        percentile_cont(0.5) within group (order by x.price) filter (where x.w and x.q),
        percentile_cont(0.5) within group (order by x.ppsf) filter (where x.w and x.q and x.ppsf > 0),
        count(*) filter (where x.w and x.q and x.ppsf > 0),
        percentile_cont(0.5) within group (order by x.price / x.units) filter (where x.w and x.ppu),
        count(*) filter (where x.w and x.ppu),
        percentile_cont(0.5) within group (order by x.price) filter (where x.w and x.q and x.is_investor),
        count(*) filter (where x.w and x.q and x.is_investor),
        percentile_disc(array[0.1, 0.25, 0.5, 0.75, 0.9]) within group (order by x.price) filter (where x.w and x.q),
        count(*) filter (where x.w and x.asset = 'sfr'), count(*) filter (where x.w and x.asset = 'mf_2_4'),
        count(*) filter (where x.w and x.asset = 'mf_5_plus'), count(*) filter (where x.w and x.asset = 'mf_unknown'),
        count(*) filter (where x.w and x.asset = 'land'), count(*) filter (where x.w and x.asset = 'commercial'),
        count(*) filter (where x.w and x.asset = 'other_res'), count(*) filter (where x.w and x.asset = 'unknown'),
        count(*) filter (where x.w and x.is_mf and x.ur = 2), count(*) filter (where x.w and x.is_mf and x.ur = 3),
        count(*) filter (where x.w and x.is_mf and x.ur = 4), count(*) filter (where x.w and x.is_mf and x.ur between 5 and 9),
        count(*) filter (where x.w and x.is_mf and x.ur between 10 and 19), count(*) filter (where x.w and x.is_mf and x.ur between 20 and 49),
        count(*) filter (where x.w and x.is_mf and x.ur >= 50), count(*) filter (where x.w and x.is_mf and (x.ur is null or x.ur < 2)),
        count(*) filter (where x.w and x.is_mf and x.sqft > 0 and x.sqft < 2000), count(*) filter (where x.w and x.is_mf and x.sqft >= 2000 and x.sqft < 4000),
        count(*) filter (where x.w and x.is_mf and x.sqft >= 4000 and x.sqft < 8000), count(*) filter (where x.w and x.is_mf and x.sqft >= 8000 and x.sqft < 20000),
        count(*) filter (where x.w and x.is_mf and x.sqft >= 20000), count(*) filter (where x.w and x.is_mf and (x.sqft is null or x.sqft <= 0))
      from (
        select %1$s as k, s.*, ($5::int is null or s.sold_on > $4::date - $5::int) as w,
               case when s.units > 1 then round(s.units)::int end as ur,
               (s.q and s.asset in ('mf_2_4', 'mf_5_plus') and s.units > 0 and (s.sqft is null or s.sqft <= 0 or s.sqft / s.units >= 350)) as ppu
          from public.mi_rollup_sales_v s
          left join public.mi_zip_geo g on g.build_id = $1 and g.zip = s.zip
      ) x
      where x.k is not null
      group by grouping sets ((x.k, x.asset), (x.k), (x.k, x.is_mf))
      having %3$s and (count(*) filter (where x.w) > 0 or count(*) filter (where x.entity) > 0)
    $q$, v_key, v_asset, v_having) using p_build, v_level, v_period, p_as_of, v_days;
    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  if v_kind = 'm' then
    execute format($q$
      insert into public.mi_geo_month_rollup (build_id, geo_level, geo_key, asset, month, sales, investor, buyer_known, cash, cash_known,
        price_n, median_price, ppsf_n, median_ppsf)
      select $1, $2, x.k, %2$s, x.mo,
        count(*), count(*) filter (where x.is_investor), count(*) filter (where x.buyer_known),
        count(*) filter (where x.is_cash_purchase), count(*) filter (where x.is_cash_purchase is not null),
        count(*) filter (where x.q), percentile_cont(0.5) within group (order by x.price) filter (where x.q),
        count(*) filter (where x.q and x.ppsf > 0), percentile_cont(0.5) within group (order by x.ppsf) filter (where x.q and x.ppsf > 0)
      from (
        select %1$s as k, date_trunc('month', s.sold_on)::date as mo, s.*
          from public.mi_rollup_sales_v s
          left join public.mi_zip_geo g on g.build_id = $1 and g.zip = s.zip
      ) x
      where x.k is not null
      group by grouping sets ((x.k, x.mo, x.asset), (x.k, x.mo), (x.k, x.mo, x.is_mf))
      having %3$s
    $q$, v_key, v_asset, v_having) using p_build, v_level;
    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  raise exception 'mi_rollup: unknown unit %', p_unit;
end
$$;

create or replace function public.mi_rollup_fingerprint()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'rows', s.n, 'as_of', s.last, 'first', s.first, 'price_sum', s.psum::text,
    'membership', (select jsonb_build_array(count(*), max(computed_at)) from public.market_zip_membership),
    'census', (select jsonb_build_array(count(*), max(vintage)) from public.exchange_market_fundamentals_cells))
  from (select count(*) as n, max(sold_on) as last, min(sold_on) as first, coalesce(sum(price), 0) as psum
          from public.mi_rollup_sales_v) s
$$;

create or replace function public.mi_rollup_units()
returns text[] language sql immutable as $$
  select array['prepare', 'buyers']
    || (select array_agg(format('p:%s:%s', l, p) order by pi, li)
          from unnest(array['1y', '90d', '30d', '6m', '3y', 'all']) with ordinality as pp(p, pi),
               unnest(array['nation', 'state', 'market', 'county', 'city', 'zip']) with ordinality as ll(l, li))
    || array['m:nation', 'm:state', 'm:market', 'm:county', 'm:city', 'm:zip', 'finalize', 'c:period', 'c:month', 'c:aux']
$$;

drop function if exists public.mi_infer_run_unit(bigint, text, date);
drop function if exists public.mi_owner_tier(boolean, boolean, boolean, integer, boolean);
drop table if exists public.mi_owner_stack_activity;
drop table if exists public.mi_owner_stack;
drop table if exists public.mi_geo_period_inferred;
drop table if exists public.mi_sale_owner_link;
drop table if exists comp_private.mi_owner_mail_cluster;
-- property_id cannot be removed by create or replace view: drop and re-create the original.
drop view if exists public.mi_rollup_sales_v;
create or replace view public.mi_rollup_sales_v as
select m.comp_id, m.sold_on, m.price, m.ppsf, m.units, m.sqft, m.property_type, m.lat, m.lng, m.buyer,
       upper(btrim(m.state)) as state,
       case when m.zip ~ '^[0-9]{5}$' and m.zip <> '00000' then m.zip end as zip,
       case when nullif(lower(btrim(m.city)), '') is not null then upper(btrim(m.state)) || ':' || lower(btrim(m.city)) end as city_key,
       coalesce(m.is_investor, false) as is_investor,
       m.buyer_kind is not null as buyer_known,
       m.is_cash_purchase,
       coalesce(m.investor_inferred_current_owner, false) as entity,
       (m.source = 'mls') as is_mls,
       coalesce(m.price > 0, false) as priced,
       coalesce(m.price > 0 and coalesce(m.portfolio_size, 1) < 2 and m.is_arms_length is distinct from false
         and coalesce(m.doc_type, '') !~* 'quit ?claim|gift|transfer on death|correction|re-recorded|public action', false) as q,
       a.asset,
       a.asset in ('mf_2_4', 'mf_5_plus', 'mf_unknown') as is_mf
  from public.mv_map_market_sales m
  left join public.mi_asset_type_map t on t.raw_type = m.property_type
  cross join lateral (select case
      -- unit count governs the residential lanes (assetTaxonomy unit_count_governs_residential_lane)
      when coalesce(t.base_class, 'unknown') in ('sfr', 'mf_generic', 'mf_5_plus', 'unknown') and m.units > 1
        then case when m.units >= 5 then 'mf_5_plus' else 'mf_2_4' end
      when t.base_class = 'mf_generic' then 'mf_unknown'
      else coalesce(t.base_class, 'unknown') end as asset) a
 where m.sold_on is not null and upper(btrim(m.state)) ~ '^[A-Z]{2}$';
revoke all on public.mi_rollup_sales_v from public, anon, authenticated;
grant select on public.mi_rollup_sales_v to service_role;
do $fn_grants$
declare f text;
begin
  foreach f in array array['mi_rollup_units()', 'mi_rollup_fingerprint()', 'mi_rollup_run_unit(bigint, text, date)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$fn_grants$;
