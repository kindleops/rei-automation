-- ENTITY GRAPH — UNIVERSE LENS AGGREGATION (applied to production 2026-09-20).
--
-- The Universe Lens asks "what does our whole property universe look like",
-- which is a GROUP BY over 169,802 properties. PostgREST cannot express that,
-- and shipping the rows to the browser to count them is the thing the lens
-- exists to avoid.
--
-- SOURCE: public.properties, NOT campaign_target_graph. The graph is an
-- SMS-REACHABLE PROJECTION answering "who can we text"; the universe is
-- "everything we have visibility into". They differ by 5 rows today and could
-- diverge arbitrarily.
--
-- GRAIN: one row per property_id (169,802 rows, 169,802 distinct ids).
--
-- COVERAGE, measured: state 100% (33), property_type 100% (9, mutually
-- exclusive), county ~100% (101), market 73% (493), owner type 24%. Partial
-- dimensions are still offered — an operator asking about ownership deserves
-- the 24% that exists — but every bucket set reports `covered_total` so the UI
-- can name its real denominator instead of implying a share of everything.
--
-- PERFORMANCE: the owner join is taken ONLY when a dimension needs it. An
-- unconditional LEFT JOIN to master_owners cost 14,322ms and 202,130 temp
-- reads for the market dimension; branching brought it to 275ms.

create or replace function public.entity_graph_lens_aggregate(
  p_dimension text,
  p_state text default null,
  p_market text default null,
  p_city text default null,
  p_county text default null,
  p_property_type text default null,
  p_owner_type text default null,
  p_limit integer default 40
)
returns table (
  bucket_key text,
  bucket_label text,
  bucket_count bigint,
  covered_total bigint,
  scope_total bigint
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 40), 200));
  v_needs_owner boolean := (p_dimension = 'owner_type' or p_owner_type is not null);
begin
  if v_needs_owner then
    return query
      with keyed as (
        select case when p_dimension = 'owner_type' then mo.owner_type_guess
                    when p_dimension = 'state' then p.property_address_state
                    when p_dimension = 'market' then p.market
                    when p_dimension = 'city' then p.property_address_city
                    when p_dimension = 'county' then p.property_address_county_name
                    when p_dimension = 'property_type' then p.property_type
                    else null end as k
        from public.properties p
        left join public.master_owners mo on mo.master_owner_id = p.master_owner_id
        where (p_state is null or p.property_address_state = p_state)
          and (p_market is null or p.market = p_market)
          and (p_city is null or p.property_address_city = p_city)
          and (p_county is null or p.property_address_county_name = p_county)
          and (p_property_type is null or p.property_type = p_property_type)
          and (p_owner_type is null or mo.owner_type_guess = p_owner_type)
      ),
      totals as (
        select count(*) as st, count(*) filter (where k is not null and k <> '') as ct from keyed
      ),
      grouped as (
        select k, count(*) as n from keyed where k is not null and k <> '' group by k
      )
      select g.k, g.k, g.n, t.ct, t.st
      from grouped g cross join totals t
      order by g.n desc limit v_limit;
  else
    return query
      with keyed as (
        select case p_dimension
                 when 'state' then p.property_address_state
                 when 'market' then p.market
                 when 'city' then p.property_address_city
                 when 'county' then p.property_address_county_name
                 when 'property_type' then p.property_type
                 else null end as k
        from public.properties p
        where (p_state is null or p.property_address_state = p_state)
          and (p_market is null or p.market = p_market)
          and (p_city is null or p.property_address_city = p_city)
          and (p_county is null or p.property_address_county_name = p_county)
          and (p_property_type is null or p.property_type = p_property_type)
      ),
      totals as (
        select count(*) as st, count(*) filter (where k is not null and k <> '') as ct from keyed
      ),
      grouped as (
        select k, count(*) as n from keyed where k is not null and k <> '' group by k
      )
      select g.k, g.k, g.n, t.ct, t.st
      from grouped g cross join totals t
      order by g.n desc limit v_limit;
  end if;
end;
$$;

grant execute on function public.entity_graph_lens_aggregate to authenticated, service_role, anon;
