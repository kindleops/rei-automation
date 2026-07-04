-- description: Hydrate map seller phones from authoritative master_owners.best_phone_1.

BEGIN;

DROP VIEW IF EXISTS public.v_command_map_seller_pin_feed CASCADE;

CREATE OR REPLACE VIEW public.v_seller_work_items AS
SELECT
  p.property_id,
  p.master_owner_id,
  COALESCE(lt.thread_key, 'property:' || p.property_id) as thread_key,

  (lt.thread_key IS NOT NULL) as has_conversation,
  (lq.queue_id IS NOT NULL) as has_queue,
  (lm.message_id IS NOT NULL) as has_message_event,
  (lm.message_id IS NULL AND lq.queue_id IS NULL AND lt.thread_key IS NULL) as is_uncontacted,

  COALESCE(NULLIF(lt.status, ''), 'not_contacted') as status,
  COALESCE(NULLIF(lt.stage, ''), 'not_contacted') as stage,

  CASE
    WHEN COALESCE(lt.is_suppressed, false) OR COALESCE(lm.is_opt_out, false) THEN 'blocked'
    WHEN lq.failed_reason IS NOT NULL THEN 'issue'
    WHEN lt.latest_direction = 'inbound' AND COALESCE(lt.is_read, false) = false THEN 'new_reply'
    WHEN COALESCE(lt.is_hot_lead, false) OR COALESCE(lt.is_urgent, false) THEN 'hot'
    WHEN lt.last_intent IN ('seller_interested', 'positive_interest', 'interested', 'asking_price_provided') THEN 'positive_intent'
    WHEN lt.stage IN ('negotiating', 'underwriting', 'offer_sent', 'price_discovery', 'condition_details') THEN 'negotiating'
    WHEN lm.message_id IS NOT NULL OR lq.sent_at IS NOT NULL THEN 'contacted'
    ELSE 'not_contacted'
  END as seller_state,

  CASE
    WHEN lq.queue_status IN ('sending', 'processing') THEN 'active'
    WHEN lq.queue_status IN ('queued', 'pending', 'approved') AND COALESCE(lq.scheduled_for, now()) <= now() THEN 'ready'
    WHEN lq.queue_status IN ('queued', 'pending', 'approved') AND lq.scheduled_for > now() THEN 'scheduled'
    WHEN lq.queue_status = 'sent' THEN 'sent'
    WHEN lq.queue_status = 'delivered' THEN 'delivered'
    WHEN lq.queue_status IN ('failed', 'error', 'blocked', 'cancelled') THEN 'issue'
    ELSE 'none'
  END as execution_state,

  CASE
    WHEN lt.thread_key IS NULL AND lq.queue_id IS NULL THEN 'not_contacted'
    WHEN COALESCE(lt.is_hot_lead, false) THEN 'hot_leads'
    WHEN COALESCE(lt.is_suppressed, false) OR COALESCE(lm.is_opt_out, false) THEN 'dnc_opt_out'
    WHEN lt.automation_state = 'active' THEN 'automated'
    WHEN lt.latest_direction = 'inbound' AND (lt.stage = 'needs_response' OR NOT COALESCE(lt.is_read, false)) THEN 'new_inbound'
    WHEN lq.queue_status IN ('queued', 'pending', 'approved') THEN 'outbound_active'
    WHEN lt.latest_direction = 'outbound' AND lt.stage IN ('sent_waiting', 'waiting') THEN 'outbound_active'
    ELSE 'cold_no_response'
  END as inbox_category,

  lt.latest_message_at,
  lt.latest_direction,
  lt.latest_message_body,
  lt.last_inbound_at,
  lt.last_outbound_at,
  COALESCE(lt.pending_queue_count, 0) as pending_queue_count,
  lt.follow_up_at,
  lt.agent_id,
  lt.persona_id,
  COALESCE(lt.is_starred, false) as is_starred,
  COALESCE(lt.is_pinned, false) as is_pinned,
  COALESCE(lt.is_read, true) as is_read,
  COALESCE(lt.is_hot_lead, false) as is_hot_lead,
  COALESCE(lt.is_suppressed, false) as is_suppressed,

  p.property_address_full,
  p.property_type,
  p.estimated_value,
  p.cash_offer,
  p.final_acquisition_score,
  p.structured_motivation_score as priority_score,
  p.property_address_city as city,
  p.property_address_state as state,
  p.property_address_zip as zip,
  p.latitude,
  p.longitude,
  mo.display_name as owner_display_name,
  mo.priority_tier as owner_priority_tier,
  mo.portfolio_total_value,
  mo.property_count as owner_property_count,

  COALESCE(lt.prospect_id, bp.prospect_id) as prospect_id,
  COALESCE(bp.full_name, mo.display_name) as prospect_full_name,
  COALESCE(lt.canonical_e164, bp.best_phone, NULLIF(mo.best_phone_1, '')) as prospect_best_phone,
  COALESCE(bp.sms_eligible, false) as sms_eligible,

  COALESCE(
    NULLIF(lt.latest_message_body, ''),
    NULLIF(bp.full_name, ''),
    NULLIF(mo.display_name, ''),
    'Lead: ' || p.property_id
  ) as display_name,
  COALESCE(NULLIF(p.property_address_full, ''), 'Unknown Property') as display_address,
  COALESCE(
    NULLIF(lt.canonical_e164, ''),
    NULLIF(bp.best_phone, ''),
    NULLIF(mo.best_phone_1, ''),
    'No Phone'
  ) as display_phone,
  COALESCE(p.market, 'Unknown') as display_market

FROM public.properties p
LEFT JOIN LATERAL (
  SELECT
    ts.thread_key,
    ts.stage,
    ts.status,
    ts.priority,
    ts.is_read,
    ts.is_pinned,
    ts.is_starred,
    ts.is_urgent,
    ts.is_hot_lead,
    ts.is_suppressed,
    ts.last_intent,
    ts.next_action,
    ts.automation_state,
    ts.latest_message_body,
    ts.latest_message_at,
    ts.latest_direction,
    ts.last_inbound_at,
    ts.last_outbound_at,
    ts.pending_queue_count,
    ts.agent_id,
    ts.persona_id,
    ts.follow_up_at,
    ts.master_owner_id,
    ts.prospect_id,
    ts.canonical_e164
  FROM public.inbox_thread_state ts
  WHERE ts.property_id = p.property_id
  ORDER BY ts.latest_message_at DESC NULLS LAST, ts.updated_at DESC NULLS LAST
  LIMIT 1
) lt ON true
LEFT JOIN LATERAL (
  SELECT
    sq.id as queue_id,
    sq.queue_status,
    sq.scheduled_for,
    sq.sent_at,
    sq.delivered_at,
    sq.failed_reason
  FROM public.send_queue sq
  WHERE sq.property_id = p.property_id
  ORDER BY sq.created_at DESC
  LIMIT 1
) lq ON true
LEFT JOIN LATERAL (
  SELECT
    me.id as message_id,
    me.direction,
    me.message_body,
    me.delivery_status,
    me.event_timestamp,
    me.is_opt_out
  FROM public.message_events me
  WHERE me.property_id = p.property_id
  ORDER BY me.event_timestamp DESC NULLS LAST, me.created_at DESC NULLS LAST
  LIMIT 1
) lm ON true
LEFT JOIN public.master_owners mo ON mo.master_owner_id = p.master_owner_id
LEFT JOIN LATERAL (
  SELECT
    pr.prospect_id,
    pr.full_name,
    pr.first_name,
    pr.best_phone,
    pr.sms_eligible
  FROM public.prospects pr
  WHERE pr.master_owner_id = p.master_owner_id
  ORDER BY pr.contact_score_final DESC NULLS LAST, pr.created_at DESC
  LIMIT 1
) bp ON true;

GRANT SELECT ON public.v_seller_work_items TO anon;
GRANT SELECT ON public.v_seller_work_items TO authenticated;

CREATE VIEW public.v_command_map_seller_pin_feed AS
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
)
SELECT
  p.property_id::text AS property_id,
  coalesce(swi.master_owner_id::text, p.master_owner_id::text) AS master_owner_id,
  swi.prospect_id::text AS prospect_id,
  coalesce(nullif(swi.thread_key, ''), 'property:' || p.property_id::text) AS thread_key,
  coalesce(nullif(swi.prospect_best_phone, ''), nullif(mo.best_phone_1, '')) AS prospect_best_phone,
  coalesce(
    nullif(swi.display_phone, ''),
    nullif(mo.best_phone_1, ''),
    'No Phone'
  ) AS display_phone,
  coalesce(nullif(swi.prospect_best_phone, ''), nullif(mo.best_phone_1, '')) AS canonical_e164,
  coalesce(nullif(swi.prospect_best_phone, ''), nullif(mo.best_phone_1, '')) AS seller_phone,

  coalesce(
    nullif(swi.prospect_full_name, ''),
    nullif(swi.owner_display_name, ''),
    nullif(mo.display_name, ''),
    nullif(pr.full_name, ''),
    nullif(pr.first_name, '')
  ) AS seller_display_name,
  coalesce(
    nullif(swi.owner_display_name, ''),
    nullif(mo.display_name, '')
  ) AS owner_display_name,
  coalesce(
    nullif(p.owner_name, ''),
    nullif(mo.display_name, '')
  ) AS owner_name,
  coalesce(
    nullif(pr.full_name, ''),
    nullif(pr.first_name, '')
  ) AS owner_full_name,
  null::text AS entity_name,
  coalesce(
    nullif(swi.prospect_full_name, ''),
    nullif(pr.full_name, ''),
    nullif(pr.first_name, ''),
    nullif(mo.display_name, '')
  ) AS seller_name,

  coalesce(nullif(p.property_address, ''), nullif(p.property_address_full, '')) AS property_address,
  coalesce(
    nullif(swi.property_address_full, ''),
    nullif(p.property_address_full, ''),
    nullif(p.property_address, '')
  ) AS property_address_full,
  coalesce(nullif(p.property_address_city, ''), nullif(swi.city, '')) AS property_address_city,
  coalesce(nullif(p.property_address_state, ''), nullif(swi.state, '')) AS property_address_state,
  coalesce(nullif(p.property_address_zip, ''), nullif(swi.zip, '')) AS property_address_zip,

  coalesce(nullif(p.market, ''), nullif(swi.display_market, 'Unknown')) AS market,
  coalesce(nullif(p.market, ''), nullif(swi.display_market, 'Unknown')) AS filter_market,
  coalesce(nullif(p.property_type, ''), nullif(p.property_class, '')) AS property_type,
  coalesce(nullif(p.property_class, ''), nullif(p.property_type, '')) AS asset_class,

  p.total_bedrooms AS total_bedrooms,
  p.total_baths AS total_baths,
  p.building_square_feet AS building_square_feet,
  p.units_count AS units_count,
  p.year_built AS year_built,
  p.lot_square_feet AS lot_square_feet,
  p.lot_acreage AS lot_acreage,

  p.estimated_value AS estimated_value,
  p.equity_amount AS equity_amount,
  p.equity_percent AS equity_percent,
  p.estimated_repair_cost AS estimated_repair_cost,
  p.final_acquisition_score AS final_acquisition_score,
  coalesce(p.structured_motivation_score, swi.priority_score, mo.priority_score) AS motivation_score,
  coalesce(p.final_acquisition_score, p.structured_motivation_score, swi.priority_score, mo.priority_score) AS priority_score,

  coalesce(p.podio_tags, p.seller_tags_text, mo.seller_tags_text) AS podio_tags,
  coalesce(p.property_flags_text, p.seller_tags_text, mo.seller_tags_text) AS property_flags_text,
  coalesce(p.property_flags_json, p.seller_tags_json, mo.seller_tags_json) AS property_flags_json,
  coalesce(p.property_flags_text, p.seller_tags_text, mo.seller_tags_text) AS property_tags_text,
  coalesce(p.property_flags_json, p.seller_tags_json, mo.seller_tags_json) AS property_tags_json,

  coalesce(nullif(mo.owner_type_guess, ''), case when p.is_corporate_owner then 'Corporate' else 'Individual' end) AS owner_type,
  coalesce(nullif(swi.seller_state, ''), 'not_contacted') AS seller_state,
  coalesce(nullif(swi.status, ''), 'not_contacted') AS seller_status,
  coalesce(nullif(swi.execution_state, ''), 'none') AS execution_state,
  coalesce(nullif(swi.inbox_category, ''), 'not_contacted') AS inbox_category,

  swi.latest_message_at AS latest_message_at,
  swi.latest_direction AS latest_direction,
  coalesce(ms.inbound_count, 0) AS inbound_count,
  coalesce(ms.outbound_count, 0) AS outbound_count,
  coalesce(qs.queued_count, 0) AS queued_count,
  coalesce(qs.scheduled_count, 0) AS scheduled_count,
  coalesce(qs.ready_count, 0) AS ready_count,
  coalesce(qs.sent_count, 0) AS sent_count,
  coalesce(qs.delivered_count, 0) AS delivered_count,
  qs.next_scheduled_for,

  p.latitude AS latitude,
  p.longitude AS longitude,
  p.latitude AS lat,
  p.longitude AS lng,

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
    coalesce(p.final_acquisition_score, 0)::integer,
    coalesce(p.structured_motivation_score, swi.priority_score, 0)::integer,
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
FROM public.properties p
LEFT JOIN public.v_seller_work_items swi
  ON swi.property_id::text = p.property_id::text
LEFT JOIN public.master_owners mo
  ON mo.master_owner_id::text = coalesce(swi.master_owner_id::text, p.master_owner_id::text)
LEFT JOIN public.prospects pr
  ON pr.prospect_id::text = swi.prospect_id::text
LEFT JOIN queue_stats qs
  ON qs.property_id = p.property_id::text
LEFT JOIN message_stats ms
  ON ms.property_id = p.property_id::text
WHERE p.latitude IS NOT NULL
  AND p.longitude IS NOT NULL;

GRANT SELECT ON public.v_command_map_seller_pin_feed TO anon;
GRANT SELECT ON public.v_command_map_seller_pin_feed TO authenticated;

COMMIT;