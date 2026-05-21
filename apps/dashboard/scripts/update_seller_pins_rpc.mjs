import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

const supabase = createClient(supabaseUrl, supabaseKey)

const sql = `
CREATE OR REPLACE FUNCTION public.get_command_map_seller_pins(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision,
  zoom_level integer DEFAULT 10,
  max_rows integer DEFAULT 15000
)
RETURNS SETOF public.v_command_map_seller_pin_feed
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  l_max_rows integer := least(greatest(coalesce(max_rows, 1000), 100), 25000);
  l_inventory_limit integer;
  l_priority_limit integer;
BEGIN
  IF coalesce(zoom_level, 10) < 9 THEN
    l_inventory_limit := floor(l_max_rows * 0.85)::integer;
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
`

async function run() {
  const { error } = await supabase.rpc('exec_sql', { sql: sql })
  if (error) {
    console.error('RPC exec_sql failed:', error)
  } else {
    console.log('Successfully updated get_command_map_seller_pins')
  }
}
run()
