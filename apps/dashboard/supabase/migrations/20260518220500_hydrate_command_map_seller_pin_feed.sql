-- description: Hydrate command map seller pin feed with full seller/property fields and viewport-first sampling.

BEGIN;

CREATE OR REPLACE VIEW public.v_command_map_seller_pin_feed AS
WITH queue_stats AS (
  SELECT
    sq.property_id::text AS property_id,
    count(*) FILTER (WHERE sq.queue_status IN ('queued', 'pending', 'approved') AND coalesce(sq.scheduled_for, now()) <= now())::integer AS ready_count,
    count(*) FILTER (WHERE sq.queue_status IN ('queued', 'pending', 'approved') AND sq.scheduled_for > now())::integer AS scheduled_count,
    count(*) FILTER (WHERE sq.queue_status IN ('queued', 'pending', 'approved'))::integer AS queued_count,
    count(*) FILTER (WHERE sq.queue_status IN ('sending', 'processing', 'active'))::integer AS active_count,
    count(*) FILTER (WHERE sq.queue_status = 'sent')::integer AS sent_count,
    count(*) FILTER (WHERE sq.queue_status = 'delivered')::integer AS delivered_count,
    min(sq.scheduled_for) FILTER (WHERE sq.queue_status IN ('queued', 'pending', 'approved') AND sq.scheduled_for > now()) AS next_scheduled_for
  FROM public.send_queue sq
  WHERE sq.property_id IS NOT NULL
  GROUP BY sq.property_id
),
message_stats AS (
  SELECT
    me.property_id::text AS property_id,
    count(*) FILTER (WHERE me.direction = 'inbound')::integer AS inbound_count,
    count(*) FILTER (WHERE me.direction = 'outbound')::integer AS outbound_count
  FROM public.message_events me
  WHERE me.property_id IS NOT NULL
  GROUP BY me.property_id
),
latest_enriched AS (
  SELECT DISTINCT ON (ie.property_id)
    ie.*
  FROM public.v_inbox_enriched ie
  WHERE ie.property_id IS NOT NULL
  ORDER BY ie.property_id, ie.latest_message_at DESC NULLS LAST
)
SELECT
  swi.property_id::text AS property_id,
  swi.master_owner_id::text AS master_owner_id,
  swi.prospect_id::text AS prospect_id,
  coalesce(nullif(swi.thread_key, ''), 'property:' || swi.property_id::text) AS thread_key,

  coalesce(
    nullif(le.prospect_full_name, ''),
    nullif(le.owner_display_name, ''),
    nullif(le.event_seller_display_name, ''),
    nullif(swi.prospect_full_name, ''),
    nullif(swi.owner_display_name, ''),
    nullif(mo.display_name, ''),
    nullif(pr.full_name, ''),
    nullif(pr.first_name, '')
  ) AS seller_display_name,
  coalesce(
    nullif(le.owner_display_name, ''),
    nullif(swi.owner_display_name, ''),
    nullif(mo.display_name, '')
  ) AS owner_display_name,
  coalesce(
    nullif(p.owner_name, ''),
    nullif(mo.display_name, '')
  ) AS owner_name,
  coalesce(
    nullif(le.prospect_full_name, ''),
    nullif(pr.full_name, ''),
    nullif(pr.first_name, '')
  ) AS owner_full_name,
  null::text AS entity_name,
  coalesce(
    nullif(le.prospect_full_name, ''),
    nullif(le.event_seller_display_name, ''),
    nullif(swi.prospect_full_name, ''),
    nullif(pr.full_name, ''),
    nullif(pr.first_name, ''),
    nullif(mo.display_name, '')
  ) AS seller_name,

  coalesce(nullif(p.property_address, ''), nullif(p.property_address_full, '')) AS property_address,
  coalesce(
    nullif(le.property_address_full, ''),
    nullif(swi.property_address_full, ''),
    nullif(p.property_address_full, ''),
    nullif(p.property_address, '')
  ) AS property_address_full,
  coalesce(nullif(le.property_city, ''), nullif(p.property_address_city, ''), nullif(swi.city, '')) AS property_address_city,
  coalesce(nullif(le.property_state, ''), nullif(p.property_address_state, ''), nullif(swi.state, '')) AS property_address_state,
  coalesce(nullif(le.property_zip, ''), nullif(p.property_address_zip, ''), nullif(swi.zip, '')) AS property_address_zip,

  coalesce(nullif(le.market, ''), nullif(p.market, ''), nullif(swi.display_market, 'Unknown')) AS market,
  coalesce(nullif(le.filter_market, ''), nullif(le.market, ''), nullif(p.market, ''), nullif(swi.display_market, 'Unknown')) AS filter_market,
  coalesce(nullif(le.property_type, ''), nullif(p.property_type, ''), nullif(p.property_class, '')) AS property_type,
  coalesce(nullif(p.property_class, ''), nullif(le.property_class, ''), nullif(p.property_type, ''), nullif(le.property_type, '')) AS asset_class,

  coalesce(le.total_bedrooms, p.total_bedrooms) AS total_bedrooms,
  coalesce(le.total_baths, p.total_baths) AS total_baths,
  coalesce(le.building_square_feet, p.building_square_feet) AS building_square_feet,
  coalesce(le.units_count, p.units_count) AS units_count,
  coalesce(le.year_built, p.year_built) AS year_built,
  coalesce(le.lot_square_feet, p.lot_square_feet) AS lot_square_feet,
  coalesce(le.lot_acreage, p.lot_acreage) AS lot_acreage,

  coalesce(le.estimated_value, p.estimated_value) AS estimated_value,
  coalesce(le.equity_amount, p.equity_amount) AS equity_amount,
  coalesce(le.equity_percent, p.equity_percent) AS equity_percent,
  coalesce(le.estimated_repair_cost, p.estimated_repair_cost) AS estimated_repair_cost,
  coalesce(le.final_acquisition_score, p.final_acquisition_score) AS final_acquisition_score,
  coalesce(le.priority_score, p.structured_motivation_score, swi.priority_score, mo.priority_score) AS motivation_score,
  coalesce(le.final_acquisition_score, p.final_acquisition_score, le.priority_score, p.structured_motivation_score, swi.priority_score, mo.priority_score) AS priority_score,

  coalesce(le.podio_tags, p.podio_tags, p.seller_tags_text, mo.seller_tags_text) AS podio_tags,
  coalesce(le.property_flags_text, p.property_flags_text, p.seller_tags_text, mo.seller_tags_text) AS property_flags_text,
  coalesce(le.property_flags_json, p.property_flags_json, p.seller_tags_json, mo.seller_tags_json) AS property_flags_json,
  coalesce(le.property_flags_text, p.property_flags_text, p.seller_tags_text, mo.seller_tags_text) AS property_tags_text,
  coalesce(le.property_flags_json, p.property_flags_json, p.seller_tags_json, mo.seller_tags_json) AS property_tags_json,

  coalesce(nullif(le.owner_type_guess, ''), nullif(mo.owner_type_guess, ''), case when p.is_corporate_owner then 'Corporate' else 'Individual' end) AS owner_type,
  coalesce(nullif(swi.seller_state, ''), nullif(le.seller_state, ''), case when coalesce(le.status, '') = '' then 'not_contacted' else null end, 'not_contacted') AS seller_state,
  coalesce(nullif(le.seller_status, ''), nullif(le.status, ''), nullif(swi.status, ''), nullif(le.stage, ''), 'not_contacted') AS seller_status,
  coalesce(nullif(swi.execution_state, ''), nullif(le.execution_state, ''), 'none') AS execution_state,
  coalesce(nullif(swi.inbox_category, ''), nullif(le.inbox_category, ''), 'not_contacted') AS inbox_category,

  coalesce(swi.latest_message_at, le.latest_message_at) AS latest_message_at,
  coalesce(swi.latest_direction, le.latest_direction) AS latest_direction,
  coalesce(ms.inbound_count, le.inbound_count, 0) AS inbound_count,
  coalesce(ms.outbound_count, le.outbound_count, 0) AS outbound_count,
  coalesce(qs.queued_count, 0) AS queued_count,
  coalesce(qs.scheduled_count, 0) AS scheduled_count,
  coalesce(qs.ready_count, 0) AS ready_count,
  coalesce(qs.sent_count, 0) AS sent_count,
  coalesce(qs.delivered_count, 0) AS delivered_count,
  qs.next_scheduled_for,

  coalesce(le.latitude, p.latitude) AS latitude,
  coalesce(le.longitude, p.longitude) AS longitude,
  coalesce(le.latitude, p.latitude) AS lat,
  coalesce(le.longitude, p.longitude) AS lng,

  case
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') in ('blocked', 'issue') or coalesce(nullif(swi.execution_state, ''), 'none') = 'issue' then '#ff6b63'
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'hot' then '#f59e0b'
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'positive_intent' then '#30d5c8'
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'negotiating' then '#b188ff'
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'new_reply' then '#62d3ff'
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'contacted' then '#4d8fff'
    else '#94a3b8'
  end AS pin_color,
  'circle'::text AS pin_shape,
  case
    when coalesce(nullif(swi.seller_state, ''), 'not_contacted') in ('hot', 'positive_intent', 'new_reply') then 'pulse_soft'
    when coalesce(nullif(swi.execution_state, ''), 'none') in ('ready', 'active', 'scheduled') then 'pulse_warning'
    else 'none'
  end AS pulse_style,
  case
    when coalesce(nullif(swi.execution_state, ''), 'none') = 'queued' then '#4d8fff'
    when coalesce(nullif(swi.execution_state, ''), 'none') = 'scheduled' then '#38bdf8'
    when coalesce(nullif(swi.execution_state, ''), 'none') in ('ready', 'active') then '#22d3ee'
    when coalesce(nullif(swi.execution_state, ''), 'none') = 'sent' then '#4d8fff'
    when coalesce(nullif(swi.execution_state, ''), 'none') = 'delivered' then '#22c55e'
    when coalesce(nullif(swi.execution_state, ''), 'none') = 'issue' then '#ff6b63'
    else 'transparent'
  end AS execution_ring_color,
  greatest(
    coalesce(le.final_acquisition_score, p.final_acquisition_score, 0)::integer,
    coalesce(le.priority_score, p.structured_motivation_score, swi.priority_score, 0)::integer,
    case
      when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'new_reply' then 98
      when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'positive_intent' then 92
      when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'negotiating' then 88
      when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'hot' then 85
      when coalesce(nullif(swi.execution_state, ''), 'none') in ('ready', 'active') then 78
      when coalesce(nullif(swi.execution_state, ''), 'none') = 'scheduled' then 68
      when coalesce(nullif(swi.execution_state, ''), 'none') = 'queued' then 60
      when coalesce(nullif(swi.seller_state, ''), 'not_contacted') = 'contacted' then 52
      else 35
    end
  ) AS render_priority
FROM public.v_seller_work_items swi
LEFT JOIN public.properties p
  ON p.property_id::text = swi.property_id::text
LEFT JOIN public.master_owners mo
  ON mo.master_owner_id::text = swi.master_owner_id::text
LEFT JOIN public.prospects pr
  ON pr.prospect_id::text = swi.prospect_id::text
LEFT JOIN latest_enriched le
  ON le.property_id::text = swi.property_id::text
LEFT JOIN queue_stats qs
  ON qs.property_id = swi.property_id::text
LEFT JOIN message_stats ms
  ON ms.property_id = swi.property_id::text
WHERE coalesce(le.latitude, p.latitude) IS NOT NULL
  AND coalesce(le.longitude, p.longitude) IS NOT NULL;

GRANT SELECT ON public.v_command_map_seller_pin_feed TO anon;
GRANT SELECT ON public.v_command_map_seller_pin_feed TO authenticated;

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
  l_max_rows integer := least(greatest(coalesce(max_rows, 1000), 100), 5000);
  l_inventory_limit integer;
  l_priority_limit integer;
BEGIN
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

COMMIT;
