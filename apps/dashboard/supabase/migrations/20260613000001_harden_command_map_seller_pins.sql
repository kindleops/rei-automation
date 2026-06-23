-- Harden get_command_map_seller_pins: add statement_timeout, lower max_rows cap,
-- and add spatial index on properties(latitude, longitude) so the bounds filter
-- can use an index scan instead of a full table scan through the view.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_lat_lng
  ON public.properties (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_command_map_seller_pins(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision,
  zoom_level integer DEFAULT 10,
  max_rows integer DEFAULT 1000
)
RETURNS SETOF public.v_command_map_seller_pin_feed
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  l_max_rows integer := least(greatest(coalesce(max_rows, 1000), 100), 2000);
  l_inventory_limit integer;
  l_priority_limit integer;
BEGIN
  -- Fail fast if the view scan is slow rather than letting Supabase kill it externally.
  SET LOCAL statement_timeout = '10000';

  IF coalesce(zoom_level, 10) < 9 THEN
    l_inventory_limit := floor(l_max_rows * 0.4)::integer;
    l_priority_limit := l_max_rows - l_inventory_limit;
  ELSE
    l_priority_limit := l_max_rows;
    l_inventory_limit := l_max_rows;
  END IF;

  RETURN QUERY
  WITH bounds_filtered AS (
    SELECT *
    FROM public.v_command_map_seller_pin_feed p
    WHERE p.latitude BETWEEN least(min_lat, max_lat)::numeric AND greatest(min_lat, max_lat)::numeric
      AND p.longitude BETWEEN least(min_lng, max_lng)::numeric AND greatest(min_lng, max_lng)::numeric
  ),
  high_priority AS (
    SELECT *
    FROM bounds_filtered
    WHERE coalesce(seller_state, 'not_contacted') <> 'not_contacted'
       OR coalesce(execution_state, 'none') <> 'none'
       OR coalesce(render_priority, 0) >= 45
    ORDER BY render_priority DESC, coalesce(priority_score, motivation_score, 0) DESC, latest_message_at DESC NULLS LAST
    LIMIT l_priority_limit
  ),
  inventory AS (
    SELECT *
    FROM bounds_filtered
    WHERE coalesce(seller_state, 'not_contacted') = 'not_contacted'
      AND coalesce(execution_state, 'none') = 'none'
      AND coalesce(render_priority, 0) < 45
    ORDER BY coalesce(priority_score, motivation_score, 0) DESC, estimated_value DESC NULLS LAST
    LIMIT l_inventory_limit
  ),
  combined AS (
    SELECT * FROM high_priority
    UNION ALL
    SELECT * FROM inventory
  )
  SELECT *
  FROM combined
  ORDER BY render_priority DESC, coalesce(priority_score, motivation_score, 0) DESC, latest_message_at DESC NULLS LAST
  LIMIT l_max_rows;
END;
$function$;
