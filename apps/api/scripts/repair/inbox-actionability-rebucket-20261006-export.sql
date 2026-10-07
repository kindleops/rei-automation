set statement_timeout='30s';
set default_transaction_read_only=on;
select json_agg(x) from (
 select b.thread_key, b.id, b.latest_message_event_id, b.latest_message_body, b.last_intent, b.inbox_bucket, b.disposition,
   b.is_suppressed, b.is_archived, b.snoozed_until, b.next_scheduled_for, b.manual_override, b.confidence, b.metadata,
   b.latest_direction, b.latest_delivery_status, b.latest_message_at, b.last_inbound_at, b.last_outbound_at,
   b.lead_temperature, b.temperature, b.is_hot_lead, b.manual_temperature_lock, b.temperature_source,
   b.in_new_replies, b.in_priority, b.in_follow_up, b.property_id,
   (select json_build_object('estimated_value', p.estimated_value, 'arv_estimate', p.arv_estimate) from properties p where p.property_id = b.property_id limit 1) as property_valuation,
   (select coalesce(json_agg(m.message_body order by m.created_at desc), '[]'::json) from (select message_body, created_at from message_events me where me.thread_key=b.thread_key and me.direction='inbound' and me.id::text <> coalesce(b.latest_message_event_id::text,'') order by created_at desc limit 10) m) as recent_seller_messages,
   (select me2.message_body from message_events me2 where me2.thread_key=b.thread_key and me2.direction='outbound' order by me2.created_at desc limit 1) as last_outbound_body
 from v_inbox_thread_state_buckets b
 where not b.f_archived and (b.in_new_replies or b.in_priority
   or (b.f_bucket='follow_up' and b.f_direction='inbound' and b.f_last_intent not in ('','unclear','not_interested','need_time'))
   or b.is_hot_lead or lower(coalesce(b.lead_temperature,b.temperature,'')) in ('hot','warm'))
) x;
