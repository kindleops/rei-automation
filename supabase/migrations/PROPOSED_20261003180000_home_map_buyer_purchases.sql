-- PROPOSED — NOT APPLIED. Home Map widget, "Buyer demand" lens.
--
-- Why: the Home Map used to read the whole analytics_performance bundle to draw one
-- layer; in production that RPC hits PostgREST's authenticator statement_timeout (8s)
-- and the widget shows "Couldn't load". Home now reads /api/cockpit/home/map-activity,
-- which counts every other lens from indexed public tables. Buyer purchases live in
-- comp_private.mv_comp_market_evidence, which PostgREST does not expose, so this lens
-- needs one narrow, read-only, service_role-only RPC. Until it is applied the lens
-- says "not readable on Home yet" — it never draws a zero.
--
-- Counting rule = analytics_performance `buys` CTE (identified buyer, arm's-length:
-- nominal-price and distress/transfer deeds excluded; ZIP → canonical market through
-- market_zip_membership). Half-open date window [p_start, p_end).
--
-- Cost: mv_comp_market_evidence_date already serves the range (warm ~0.1s for a month;
-- cold ~2.1s on 2026-10-03 because of heap fetches). The partial covering index below
-- makes the read index-only. Size: identified-buyer rows only.

CREATE INDEX IF NOT EXISTS mv_comp_market_evidence_buyer_date
  ON comp_private.mv_comp_market_evidence (event_date)
  INCLUDE (zip, lat, lng, nominal_price, distress_or_transfer_deed)
  WHERE buyer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.home_map_buyer_purchases(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'comp_private', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'data_through', (select max(event_date) from comp_private.mv_comp_market_evidence where buyer_id is not null),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('zip', g.zip, 'market', g.market, 'lat', g.lat, 'lng', g.lng, 'n', g.n) order by g.n desc)
      from (
        select mv.zip, max(zm.canonical_market_id) as market, avg(mv.lat) as lat, avg(mv.lng) as lng, count(*) as n
        from comp_private.mv_comp_market_evidence mv
        left join market_zip_membership zm on zm.zip5 = mv.zip
        where mv.buyer_id is not null
          and mv.event_date >= p_start and mv.event_date < p_end
          and not coalesce(mv.nominal_price, false)
          and not coalesce(mv.distress_or_transfer_deed, false)
        group by mv.zip
      ) g
    ), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.home_map_buyer_purchases(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.home_map_buyer_purchases(date, date) TO service_role;

-- Pretest (inside a transaction, then ROLLBACK):
--   select jsonb_array_length(public.home_map_buyer_purchases('2026-06-01', '2026-07-01') -> 'rows');
--   -- expect ~828 ZIP rows, data_through = 2026-07-28 (as of 2026-10-03)
