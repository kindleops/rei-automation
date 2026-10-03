-- PROPOSED — NOT APPLIED. Map "Investor presence" overlay (Refinement 8.4 §6).
--
-- Why: the overlay shows two SEPARATE signals per map grid cell —
--   investor purchases  (mv_map_market_sales.is_investor, sales in a window)
--   entity ownership    (mv_map_market_sales.investor_inferred_current_owner, current state)
-- never blended into one score. Today the API reads them over its direct Postgres
-- connection (GET /api/cockpit/map/investor-presence, operator-gated route), which
-- works but heap-fetches: a Minneapolis metro box measured 4.8 s warm and 32 s cold
-- on 2026-10-03 (the existing mv_map_market_sales_geo index does not include the
-- two flags or property_id). This migration:
--   1. adds a covering index so the read is index-only;
--   2. adds an operator-gated SECURITY DEFINER RPC with the same contract, so the
--      API (or the dashboard) can read it through PostgREST under the
--      20261003130000 operator lockdown gate instead of a direct connection.
-- mv_map_market_sales stays server-only (no grants change on the MV itself).
--
-- Pretest (read-only, before apply): the function body equals the API's
-- PRESENCE_SQL (apps/api/src/lib/domain/map/investor-presence-service.js).
-- Rollback: PROPOSED_20261003191000_map_investor_presence_rollback.sql.

CREATE INDEX IF NOT EXISTS mv_map_market_sales_geo_presence
  ON public.mv_map_market_sales (lat, lng)
  INCLUDE (sold_on, is_investor, investor_inferred_current_owner, property_id);

CREATE OR REPLACE FUNCTION public.get_map_investor_presence(
  p_min_lat double precision, p_min_lng double precision,
  p_max_lat double precision, p_max_lng double precision,
  p_grid double precision, p_since date
) RETURNS TABLE (
  lat double precision, lng double precision,
  sales integer, investor_purchases integer, entity_owned integer, latest_sale_on date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  /* ops_operator_gate */ PERFORM public.assert_ops_read_allowed();
  -- Bounded: a metro-sized box, a sane grid, a window no longer than 5 years.
  IF p_max_lat - p_min_lat > 2.05 OR p_max_lng - p_min_lng > 2.05 OR p_grid < 0.002 OR p_since < current_date - 1830 THEN
    RAISE EXCEPTION 'investor presence: box, grid or window out of range' USING errcode = '22023';
  END IF;
  RETURN QUERY
  SELECT avg(m.lat)::double precision, avg(m.lng)::double precision,
         (count(*) FILTER (WHERE m.sold_on >= p_since))::integer,
         (count(*) FILTER (WHERE m.sold_on >= p_since AND m.is_investor))::integer,
         (count(DISTINCT m.property_id) FILTER (WHERE m.investor_inferred_current_owner))::integer,
         max(m.sold_on)
    FROM public.mv_map_market_sales m
   WHERE m.lat BETWEEN p_min_lat AND p_max_lat
     AND m.lng BETWEEN p_min_lng AND p_max_lng
   GROUP BY floor(m.lng / p_grid), floor(m.lat / p_grid);
END
$$;

REVOKE ALL ON FUNCTION public.get_map_investor_presence(double precision, double precision, double precision, double precision, double precision, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_map_investor_presence(double precision, double precision, double precision, double precision, double precision, date) TO authenticated, service_role;
