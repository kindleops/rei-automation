create or replace function public.normalize_buyer_entity_text(value text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(
      regexp_replace(
        lower(coalesce(value, '')),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

create or replace function public.normalize_buyer_entity_name(value text)
returns text
language sql
immutable
as $$
  with cleaned as (
    select regexp_replace(lower(coalesce(value, '')), '[^a-z0-9\s]+', ' ', 'g') as normalized
  )
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(normalized, '\m(limited liability company)\M', ' ', 'g'),
                  '\m(llc)\M',
                  ' ',
                  'g'
                ),
                '\m(incorporated)\M|\m(inc)\M',
                ' ',
                'g'
              ),
              '\m(corporation)\M|\m(corp)\M',
              ' ',
              'g'
            ),
            '\m(company)\M|\m(co)\M',
            ' ',
            'g'
          ),
          '\m(limited)\M|\m(ltd)\M',
          ' ',
          'g'
        ),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  )
  from cleaned;
$$;

create or replace view public.v_buyer_entity_purchases
with (security_invoker = true)
as
with source_rows as (
  select
    b.id as comp_id,
    b.property_id,
    coalesce(
      nullif(trim(b.owner_name), ''),
      nullif(trim(b.owner_1_name), ''),
      nullif(trim(b.owner_2_name), '')
    ) as raw_buyer_name,
    nullif(trim(b.owner_name), '') as owner_name,
    nullif(trim(b.owner_1_name), '') as owner_1_name,
    nullif(trim(b.owner_2_name), '') as owner_2_name,
    nullif(trim(b.owner_address_full), '') as owner_address_full,
    nullif(trim(b.owner_address_city), '') as owner_address_city,
    nullif(trim(b.owner_address_state), '') as owner_address_state,
    nullif(trim(b.owner_address_zip), '') as owner_address_zip,
    coalesce(b.is_corporate_owner, false) as is_corporate_buyer,
    b.sale_date,
    coalesce(b.sale_price, b.mls_sold_price) as sale_price,
    b.mls_sold_date,
    b.mls_sold_price,
    nullif(trim(b.property_address_full), '') as property_address_full,
    nullif(trim(b.property_address_city), '') as property_address_city,
    nullif(trim(b.property_address_state), '') as property_address_state,
    nullif(trim(b.property_address_zip), '') as property_address_zip,
    coalesce(
      nullif(trim(p.market), ''),
      nullif(trim(concat_ws(', ', b.property_address_city, b.property_address_state)), ''),
      nullif(trim(concat_ws(', ', p.property_address_city, p.property_address_state)), '')
    ) as market,
    nullif(trim(b.normalized_asset_class), '') as normalized_asset_class,
    nullif(trim(b.property_type), '') as property_type,
    b.building_square_feet,
    b.total_bedrooms,
    b.total_baths,
    b.year_built,
    b.latitude,
    b.longitude
  from public.buyer_comp_raw_v2 b
  left join public.properties p
    on p.property_id::text = b.property_id
  where b.sale_date is not null
    and coalesce(b.sale_price, b.mls_sold_price) is not null
    and coalesce(b.sale_price, b.mls_sold_price) > 0
),
normalized_rows as (
  select
    comp_id,
    property_id,
    raw_buyer_name,
    owner_name,
    owner_1_name,
    owner_2_name,
    owner_address_full,
    owner_address_city,
    owner_address_state,
    owner_address_zip,
    is_corporate_buyer,
    sale_date,
    sale_price,
    property_address_full,
    property_address_city,
    property_address_state,
    property_address_zip,
    market,
    normalized_asset_class,
    property_type,
    building_square_feet,
    total_bedrooms,
    total_baths,
    year_built,
    latitude,
    longitude,
    public.normalize_buyer_entity_name(raw_buyer_name) as normalized_buyer_name,
    public.normalize_buyer_entity_text(owner_address_full) as normalized_owner_address,
    (coalesce(mls_sold_price, 0) > 0 or mls_sold_date is not null) as is_mls_purchase
  from source_rows
)
select
  comp_id,
  property_id,
  coalesce(
    normalized_buyer_name,
    concat(
      'unknown buyer ',
      coalesce(normalized_owner_address, property_id, comp_id::text)
    )
  ) as buyer_entity_key,
  coalesce(raw_buyer_name, owner_1_name, owner_2_name, 'Unknown Buyer') as buyer_display_name,
  is_corporate_buyer,
  owner_name,
  owner_1_name,
  owner_2_name,
  owner_address_full,
  owner_address_city,
  owner_address_state,
  owner_address_zip,
  sale_date,
  sale_price,
  property_address_full,
  property_address_city,
  property_address_state,
  property_address_zip,
  market,
  normalized_asset_class,
  property_type,
  building_square_feet,
  total_bedrooms,
  total_baths,
  year_built,
  latitude,
  longitude,
  is_mls_purchase,
  (not is_mls_purchase) as is_off_market_purchase
from normalized_rows;

create or replace view public.v_buyer_entities_from_comps
with (security_invoker = true)
as
with purchase_base as (
  select *
  from public.v_buyer_entity_purchases
),
dominant_attributes as (
  select distinct on (buyer_entity_key)
    buyer_entity_key,
    buyer_display_name,
    owner_address_full,
    owner_address_city,
    owner_address_state,
    owner_address_zip
  from purchase_base
  order by
    buyer_entity_key,
    (buyer_display_name <> 'Unknown Buyer') desc,
    (owner_address_full is not null) desc,
    sale_date desc,
    length(buyer_display_name) desc
),
zip_activity as (
  select
    buyer_entity_key,
    max(zip_purchase_count) as max_zip_purchase_count
  from (
    select
      buyer_entity_key,
      property_address_zip,
      count(*) as zip_purchase_count
    from purchase_base
    where property_address_zip is not null
    group by buyer_entity_key, property_address_zip
  ) ranked
  group by buyer_entity_key
),
rollup as (
  select
    p.buyer_entity_key,
    d.buyer_display_name,
    bool_or(p.is_corporate_buyer) as is_corporate_buyer,
    d.owner_address_full,
    d.owner_address_city,
    d.owner_address_state,
    d.owner_address_zip,
    count(*) filter (
      where p.sale_date >= current_date - interval '6 months'
    ) as purchase_count_6mo,
    count(*) filter (
      where p.sale_date >= current_date - interval '12 months'
    ) as purchase_count_12mo,
    coalesce(sum(p.sale_price) filter (
      where p.sale_date >= current_date - interval '6 months'
    ), 0)::numeric as total_purchase_volume_6mo,
    percentile_cont(0.5) within group (order by p.sale_price)::numeric as median_purchase_price,
    avg(p.sale_price)::numeric as avg_purchase_price,
    min(p.sale_price)::numeric as min_purchase_price,
    max(p.sale_price)::numeric as max_purchase_price,
    max(p.sale_date) as last_purchase_date,
    min(p.sale_date) as first_purchase_date,
    count(distinct p.market) filter (where p.market is not null) as markets_active_count,
    count(distinct p.property_address_zip) filter (where p.property_address_zip is not null) as zips_active_count,
    count(distinct p.property_address_state) filter (where p.property_address_state is not null) as states_active_count,
    coalesce(
      array_agg(distinct p.normalized_asset_class order by p.normalized_asset_class)
      filter (where p.normalized_asset_class is not null),
      '{}'::text[]
    ) as asset_classes_bought,
    coalesce(
      array_agg(distinct p.property_type order by p.property_type)
      filter (where p.property_type is not null),
      '{}'::text[]
    ) as property_types_bought,
    avg(p.building_square_feet)::numeric as avg_sqft,
    avg(p.total_bedrooms)::numeric as avg_beds,
    avg(p.total_baths)::numeric as avg_baths,
    avg(p.year_built)::numeric as avg_year_built,
    count(*) filter (where p.is_mls_purchase) as mls_purchase_count,
    count(*) filter (where p.is_off_market_purchase) as off_market_purchase_count,
    max(case when p.buyer_display_name <> 'Unknown Buyer' then 1 else 0 end) = 1 as has_buyer_name,
    max(case when p.owner_address_full is not null then 1 else 0 end) = 1 as has_owner_address
  from purchase_base p
  join dominant_attributes d
    on d.buyer_entity_key = p.buyer_entity_key
  group by
    p.buyer_entity_key,
    d.buyer_display_name,
    d.owner_address_full,
    d.owner_address_city,
    d.owner_address_state,
    d.owner_address_zip
),
scored as (
  select
    r.*,
    coalesce(z.max_zip_purchase_count, 0) as max_zip_purchase_count,
    greatest(
      0,
      least(
        100,
        round(
          10
          + least(28, r.purchase_count_12mo * 8)
          + least(12, r.purchase_count_6mo * 4)
          + case when r.is_corporate_buyer then 8 else 0 end
          + case
              when r.last_purchase_date >= current_date - interval '45 days' then 12
              when r.last_purchase_date >= current_date - interval '90 days' then 8
              when r.last_purchase_date >= current_date - interval '180 days' then 4
              else 0
            end
          + least(10, coalesce(z.max_zip_purchase_count, 0) * 2)
          + least(8, r.off_market_purchase_count * 2)
          + case
              when r.total_purchase_volume_6mo >= 2000000 then 10
              when r.total_purchase_volume_6mo >= 1000000 then 8
              when r.total_purchase_volume_6mo >= 500000 then 5
              when r.total_purchase_volume_6mo >= 250000 then 3
              else 0
            end
          - case when r.purchase_count_12mo = 1 and not r.is_corporate_buyer then 18 else 0 end
          - case when not r.has_buyer_name then 15 else 0 end
          - case when not r.has_owner_address then 8 else 0 end
        )::numeric
      )
    )::integer as buyer_confidence_score
  from rollup r
  left join zip_activity z
    on z.buyer_entity_key = r.buyer_entity_key
)
select
  s.buyer_entity_key,
  s.buyer_display_name,
  s.is_corporate_buyer,
  s.owner_address_full,
  s.owner_address_city,
  s.owner_address_state,
  s.owner_address_zip,
  s.purchase_count_6mo,
  s.purchase_count_12mo,
  s.total_purchase_volume_6mo,
  s.median_purchase_price,
  s.avg_purchase_price,
  s.min_purchase_price,
  s.max_purchase_price,
  s.last_purchase_date,
  s.first_purchase_date,
  s.markets_active_count,
  s.zips_active_count,
  s.states_active_count,
  s.asset_classes_bought,
  s.property_types_bought,
  s.avg_sqft,
  s.avg_beds,
  s.avg_baths,
  s.avg_year_built,
  s.mls_purchase_count,
  s.off_market_purchase_count,
  s.buyer_confidence_score,
  case
    when s.buyer_confidence_score >= 90 and s.purchase_count_12mo >= 4 then 'A+'
    when s.buyer_confidence_score >= 75 and s.purchase_count_12mo >= 2 then 'A'
    when s.buyer_confidence_score >= 55 then 'B'
    when s.buyer_confidence_score >= 35 then 'Watchlist'
    else 'Noise'
  end as buyer_grade,
  concat_ws(
    ' • ',
    case
      when s.purchase_count_6mo > 0 then s.purchase_count_6mo::text || ' buys in 6mo'
      else s.purchase_count_12mo::text || ' buys in 12mo'
    end,
    case
      when s.off_market_purchase_count > 0 then s.off_market_purchase_count::text || ' off-market'
      else s.mls_purchase_count::text || ' MLS'
    end,
    case
      when s.markets_active_count > 1 then s.markets_active_count::text || ' active markets'
      when s.zips_active_count > 1 then s.zips_active_count::text || ' active ZIPs'
      else 'Focused buy box'
    end,
    case when s.is_corporate_buyer then 'Corporate buyer' else 'Individual buyer' end,
    case
      when s.last_purchase_date is not null then 'Last buy ' || (current_date - s.last_purchase_date)::text || 'd ago'
      else null
    end
  ) as buyer_signal_summary
from scored s;

create or replace view public.v_buyer_entity_leaderboard
with (security_invoker = true)
as
with market_counts as (
  select
    p.buyer_entity_key,
    p.market,
    count(*) as purchase_count
  from public.v_buyer_entity_purchases p
  where p.market is not null
  group by p.buyer_entity_key, p.market
),
market_ranked as (
  select
    m.*,
    row_number() over (
      partition by m.buyer_entity_key
      order by m.purchase_count desc, m.market
    ) as market_rank
  from market_counts m
),
market_summary as (
  select
    buyer_entity_key,
    array_agg(market order by purchase_count desc, market) filter (where market_rank <= 5) as top_markets
  from market_ranked
  group by buyer_entity_key
),
zip_counts as (
  select
    p.buyer_entity_key,
    p.property_address_zip as zip_code,
    count(*) as purchase_count
  from public.v_buyer_entity_purchases p
  where p.property_address_zip is not null
  group by p.buyer_entity_key, p.property_address_zip
),
zip_ranked as (
  select
    z.*,
    row_number() over (
      partition by z.buyer_entity_key
      order by z.purchase_count desc, z.zip_code
    ) as zip_rank
  from zip_counts z
),
zip_summary as (
  select
    buyer_entity_key,
    array_agg(zip_code order by purchase_count desc, zip_code) filter (where zip_rank <= 5) as top_zips
  from zip_ranked
  group by buyer_entity_key
),
state_counts as (
  select
    p.buyer_entity_key,
    p.property_address_state,
    count(*) as purchase_count
  from public.v_buyer_entity_purchases p
  where p.property_address_state is not null
  group by p.buyer_entity_key, p.property_address_state
),
state_ranked as (
  select
    s.*,
    row_number() over (
      partition by s.buyer_entity_key
      order by s.purchase_count desc, s.property_address_state
    ) as state_rank
  from state_counts s
),
state_summary as (
  select
    buyer_entity_key,
    array_agg(property_address_state order by purchase_count desc, property_address_state) filter (where state_rank <= 5) as top_states
  from state_ranked
  group by buyer_entity_key
)
select
  e.*,
  coalesce(ms.top_markets, '{}'::text[]) as top_markets,
  coalesce(zs.top_zips, '{}'::text[]) as top_zips,
  coalesce(ss.top_states, '{}'::text[]) as top_states,
  (e.purchase_count_12mo >= 2) as is_repeat_buyer,
  (e.buyer_grade in ('A+', 'A', 'B')) as is_real_buyer,
  (e.off_market_purchase_count > 0) as is_off_market_buyer,
  (
    e.owner_address_state is not null
    and exists (
      select 1
      from state_ranked s
      where s.buyer_entity_key = e.buyer_entity_key
        and s.state_rank = 1
        and s.property_address_state = e.owner_address_state
    )
  ) as is_local_buyer,
  (e.buyer_grade in ('Noise', 'Watchlist')) as is_retail_or_noise
from public.v_buyer_entities_from_comps e
left join market_summary ms
  on ms.buyer_entity_key = e.buyer_entity_key
left join zip_summary zs
  on zs.buyer_entity_key = e.buyer_entity_key
left join state_summary ss
  on ss.buyer_entity_key = e.buyer_entity_key;

create or replace function public.get_buyers_for_property(
  p_property_id text,
  p_limit integer default 25
)
returns table (
  buyer_entity_key text,
  buyer_display_name text,
  buyer_grade text,
  buyer_confidence_score integer,
  match_score integer,
  purchase_count_6mo bigint,
  purchase_count_12mo bigint,
  avg_purchase_price numeric,
  median_purchase_price numeric,
  top_markets text[],
  top_zips text[],
  asset_classes_bought text[],
  last_purchase_date date,
  buyer_signal_summary text,
  reason_matched text
)
language sql
stable
as $$
  with subject as (
    select
      p.property_id::text as property_id,
      coalesce(nullif(trim(p.market), ''), nullif(trim(concat_ws(', ', p.property_address_city, p.property_address_state)), '')) as market,
      nullif(trim(p.property_address_state), '') as property_state,
      nullif(trim(p.property_address_zip), '') as property_zip,
      nullif(trim(p.property_type), '') as property_type,
      p.building_square_feet::numeric as building_square_feet,
      p.total_bedrooms::numeric as total_bedrooms,
      p.total_baths::numeric as total_baths,
      p.year_built::numeric as year_built,
      p.estimated_value::numeric as target_price,
      case
        when lower(coalesce(p.property_type, '')) like '%single%' then 'single_family'
        when lower(coalesce(p.property_type, '')) like any (array['%duplex%', '%triplex%', '%quad%', '%multi%']) then 'multifamily'
        when lower(coalesce(p.property_type, '')) like any (array['%condo%', '%townhome%', '%townhouse%']) then 'attached_residential'
        when lower(coalesce(p.property_type, '')) like '%mobile%' then 'manufactured'
        else null
      end as normalized_asset_class
    from public.properties p
    where p.property_id::text = p_property_id
    limit 1
  ),
  candidate_stats as (
    select
      l.buyer_entity_key,
      l.buyer_display_name,
      l.buyer_grade,
      l.buyer_confidence_score,
      l.purchase_count_6mo,
      l.purchase_count_12mo,
      l.avg_purchase_price,
      l.median_purchase_price,
      l.avg_sqft,
      l.avg_beds,
      l.avg_baths,
      l.top_markets,
      l.top_zips,
      l.asset_classes_bought,
      l.last_purchase_date,
      l.buyer_signal_summary,
      l.off_market_purchase_count,
      count(*) filter (where p.market = s.market and s.market is not null) as same_market_purchase_count,
      count(*) filter (where p.property_address_state = s.property_state and s.property_state is not null) as same_state_purchase_count,
      count(*) filter (where p.property_address_zip = s.property_zip and s.property_zip is not null) as same_zip_purchase_count,
      count(*) filter (where p.normalized_asset_class = s.normalized_asset_class and s.normalized_asset_class is not null) as same_asset_class_count,
      count(*) filter (where p.property_type = s.property_type and s.property_type is not null) as same_property_type_count
    from public.v_buyer_entity_leaderboard l
    cross join subject s
    join public.v_buyer_entity_purchases p
      on p.buyer_entity_key = l.buyer_entity_key
    where l.buyer_grade <> 'Noise'
    group by
      l.buyer_entity_key,
      l.buyer_display_name,
      l.buyer_grade,
      l.buyer_confidence_score,
      l.purchase_count_6mo,
      l.purchase_count_12mo,
      l.avg_purchase_price,
      l.median_purchase_price,
      l.avg_sqft,
      l.avg_beds,
      l.avg_baths,
      l.top_markets,
      l.top_zips,
      l.asset_classes_bought,
      l.last_purchase_date,
      l.buyer_signal_summary,
      l.off_market_purchase_count
  ),
  scored as (
    select
      c.*,
      s.market,
      s.property_state,
      s.property_zip,
      s.property_type,
      s.target_price,
      s.building_square_feet,
      s.total_bedrooms,
      s.total_baths,
      greatest(
        0,
        least(
          100,
          round(
            case
              when c.same_zip_purchase_count > 0 then 26
              when c.same_market_purchase_count > 0 then 20
              when c.same_state_purchase_count > 0 then 12
              else 0
            end
            + case when c.same_asset_class_count > 0 then 14 else 0 end
            + case when c.same_property_type_count > 0 then 10 else 0 end
            + case
                when s.target_price is null or c.median_purchase_price is null or c.median_purchase_price = 0 then 6
                else greatest(0, 16 - (abs(s.target_price - c.median_purchase_price) / c.median_purchase_price) * 20)
              end
            + case
                when s.building_square_feet is null or c.avg_sqft is null then 4
                when c.avg_sqft is not null and c.avg_sqft > 0 then
                  greatest(
                    0,
                    12 - (
                      abs(s.building_square_feet - c.avg_sqft) / greatest(s.building_square_feet, 1)
                    ) * 14
                  )
                else 4
              end
            + case
                when s.total_bedrooms is null then 3
                else greatest(
                  0,
                  6 - abs(s.total_bedrooms - coalesce(c.avg_beds, s.total_bedrooms)) * 3
                )
              end
            + case
                when s.total_baths is null then 3
                else greatest(
                  0,
                  6 - abs(s.total_baths - coalesce(c.avg_baths, s.total_baths)) * 3
                )
              end
            + least(8, c.purchase_count_6mo * 2)
            + least(12, c.buyer_confidence_score * 0.12)
            + case c.buyer_grade
                when 'A+' then 8
                when 'A' then 6
                when 'B' then 3
                else 0
              end
            + case when c.off_market_purchase_count > 0 then 4 else 0 end
          )::numeric
        )
      )::integer as match_score
    from candidate_stats c
    cross join subject s
  )
  select
    buyer_entity_key,
    buyer_display_name,
    buyer_grade,
    buyer_confidence_score,
    match_score,
    purchase_count_6mo,
    purchase_count_12mo,
    avg_purchase_price,
    median_purchase_price,
    top_markets,
    top_zips,
    asset_classes_bought,
    last_purchase_date,
    buyer_signal_summary,
    concat_ws(
      ' • ',
      case
        when same_zip_purchase_count > 0 then 'Repeat buyer in subject ZIP'
        when same_market_purchase_count > 0 then 'Active in subject market'
        when same_state_purchase_count > 0 then 'Active in subject state'
        else null
      end,
      case when same_asset_class_count > 0 then 'Asset class match' else null end,
      case when same_property_type_count > 0 then 'Property type match' else null end,
      case
        when target_price is not null and median_purchase_price is not null
          then 'Median buy ' || to_char(median_purchase_price, 'FM$999,999,999')
        else null
      end,
      case when purchase_count_6mo > 0 then purchase_count_6mo::text || ' buys in 6mo' else null end,
      case when off_market_purchase_count > 0 then off_market_purchase_count::text || ' off-market purchases' else null end
    ) as reason_matched
  from scored
  order by
    match_score desc,
    buyer_confidence_score desc,
    purchase_count_6mo desc,
    purchase_count_12mo desc,
    last_purchase_date desc nulls last
  limit greatest(coalesce(p_limit, 25), 1);
$$;
