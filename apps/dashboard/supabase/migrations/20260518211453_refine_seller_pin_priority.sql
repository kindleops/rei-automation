-- description: Refactor get_command_map_seller_pins to use balanced sampling of high-priority activity and not_contacted inventory at low zoom.

CREATE OR REPLACE FUNCTION public.get_command_map_seller_pins(
  min_lat double precision, 
  min_lng double precision, 
  max_lat double precision, 
  max_lng double precision, 
  zoom_level integer DEFAULT 10, 
  max_rows integer DEFAULT 1000
)
 RETURNS SETOF v_command_map_seller_pin_feed
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  l_max_rows integer := least(greatest(coalesce(max_rows, 1000), 100), 5000);
  l_inventory_limit integer;
  l_priority_limit integer;
BEGIN
  -- For zoom < 9, we reserve 40% for uncontacted inventory.
  -- For zoom >= 9, we can be more flexible, but sampling still helps performance.
  IF coalesce(zoom_level, 10) < 9 THEN
    l_inventory_limit := floor(l_max_rows * 0.4)::integer;
    l_priority_limit := l_max_rows - l_inventory_limit;
  ELSE
    l_priority_limit := l_max_rows;
    l_inventory_limit := l_max_rows; -- In practice, the final limit will cap it.
  END IF;

  RETURN QUERY
  WITH bounds_filtered AS (
    select *
    from public.v_command_map_seller_pin_feed p
    where p.latitude between least(min_lat, max_lat)::numeric and greatest(min_lat, max_lat)::numeric
      and p.longitude between least(min_lng, max_lng)::numeric and greatest(min_lng, max_lng)::numeric
  ),
  high_priority AS (
    select * from bounds_filtered
    where seller_state <> 'not_contacted' 
       or execution_state <> 'none' 
       or render_priority >= 45
    order by render_priority desc, coalesce(motivation_score, 0) desc, latest_message_at desc nulls last
    limit l_priority_limit
  ),
  inventory AS (
    select * from bounds_filtered
    where seller_state = 'not_contacted' 
      and execution_state = 'none' 
      and render_priority < 45
    order by coalesce(motivation_score, 0) desc
    limit l_inventory_limit
  ),
  combined AS (
    select * from high_priority
    union all
    select * from inventory
  )
  select * from combined
  order by render_priority desc, coalesce(motivation_score, 0) desc, latest_message_at desc nulls last
  limit l_max_rows;
END;
$function$;
