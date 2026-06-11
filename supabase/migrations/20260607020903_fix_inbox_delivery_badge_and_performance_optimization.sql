
-- Update canonical_inbox_threads to join latest outbound delivery status for real accuracy and performance.
CREATE OR REPLACE VIEW public.canonical_inbox_threads AS
 WITH suppressed_phones AS (
         SELECT DISTINCT s.phone
           FROM ( SELECT sms_suppression_list.phone_e164 AS phone
                   FROM sms_suppression_list
                  WHERE ((sms_suppression_list.is_active = true) AND (sms_suppression_list.phone_e164 IS NOT NULL))
                UNION
                 SELECT sms_suppression_list.phone_number AS phone
                   FROM sms_suppression_list
                  WHERE ((sms_suppression_list.is_active = true) AND (sms_suppression_list.phone_number IS NOT NULL))) s
        ),
      latest_outbound AS (
         SELECT DISTINCT ON (thread_key) 
            thread_key,
            delivery_status,
            provider_delivery_status,
            failed_at,
            failure_reason,
            delivered_at
         FROM message_events
         WHERE direction = 'outbound'
         ORDER BY thread_key, created_at DESC
      )
 SELECT t.canonical_thread_key,
    t.thread_key,
    t.id,
    t.thread_row_number,
    t.latest_message_source,
    t.latest_message_event_id,
    t.property_id,
    t.master_owner_id,
    t.prospect_id,
    t.selected_property_id,
    t.thread_property_id,
    t.thread_master_owner_id,
    t.thread_prospect_id,
    t.canonical_e164,
    t.seller_phone,
    t.best_phone,
    t.phone,
    t.display_phone,
    t.our_number,
    t.latest_message_at,
    t.latest_activity_at,
    t.last_message_at,
    t.latest_message_body,
    t.latest_message_direction,
    t.direction,
    COALESCE(lo.delivery_status, t.delivery_status) AS delivery_status,
    COALESCE(lo.provider_delivery_status, t.provider_delivery_status) AS provider_delivery_status,
    COALESCE(lo.delivery_status, t.latest_delivery_status) AS latest_delivery_status,
    COALESCE(lo.provider_delivery_status, t.latest_provider_delivery_status) AS latest_provider_delivery_status,
    COALESCE(lo.delivered_at, t.latest_delivered_at) AS latest_delivered_at,
    COALESCE(lo.failed_at, t.latest_failed_at) AS latest_failed_at,
    COALESCE(lo.failure_reason, t.latest_failure_reason) AS latest_failure_reason,
    t.last_outbound_at,
    t.last_inbound_at,
    t.auto_reply_status,
    t.current_stage,
    t.detected_intent,
    t.universal_status,
    t.universal_stage,
    t.conversation_stage,
    t.owner_name,
    t.seller_first_name,
    t.seller_display_name,
    t.property_address_full,
    t.property_address_city,
    t.property_state,
    t.property_zip,
    t.property_county_name,
    t.market,
    t.latitude,
    t.longitude,
    t.property_type,
    t.property_class,
    t.estimated_value,
    t.estimated_arv,
    t.equity_percent,
    t.cash_offer,
    t.final_acquisition_score,
    t.priority_score,
    t.lead_temperature,
    t.reply_intent,
    t.message_count,
    t.inbound_count,
    t.outbound_count,
    t.unread_count,
    t.opt_out,
    t.wrong_number,
    t.not_interested,
    t.needs_review,
    t.queue_status,
    t.suppression_status,
    t.suppression_type,
    t.suppression_until,
    t.touch_count,
    t.last_touch_at,
    t.selected_property_reason,
    t.duplicate_property_count,
    t.enrichment_match_strategy,
    t.property_data,
    t.master_owner_data,
    t.prospect_data,
    t.phone_data,
    t.email_data,
    t.thread_state_data,
    t.campaign_data,
    t.queue_data,
    t.suppression_data,
    t.valuation_data,
    t.buyer_match_data,
    jsonb_strip_nulls(jsonb_build_object(
        'thread_key', t.thread_key, 
        'latest_message_at', t.latest_message_at, 
        'latest_direction', t.latest_message_direction, 
        'latest_message_body', COALESCE(t.latest_message_body, t.preview), 
        'detected_intent', COALESCE(NULLIF(t.detected_intent, ''::text), NULLIF(t.ui_intent, ''::text)), 
        'latest_delivery_status', lo.delivery_status, 
        'latest_provider_delivery_status', lo.provider_delivery_status, 
        'latest_delivered_at', lo.delivered_at, 
        'latest_failed_at', lo.failed_at, 
        'latest_failure_reason', lo.failure_reason
    )) AS latest_message_event_data,
    COALESCE(t.latest_message_at, t.last_inbound_at, t.last_outbound_at) AS created_at,
    COALESCE(t.latest_message_at, t.last_inbound_at, t.last_outbound_at) AS updated_at,
    t.preview,
    t.inbox_category,
    t.status AS display_status,
    t.stage,
    t.show_in_priority_inbox,
    t.is_suppressed,
    t.is_read,
    t.is_starred,
    t.is_pinned,
    t.is_archived,
    t.is_hot_lead,
    t.event_seller_display_name,
    t.owner_display_name,
    t.display_name,
    t.display_address,
    t.display_market,
    t.filter_property_type,
    t.follow_up_at,
    t.pending_queue_count,
        CASE
            WHEN (COALESCE(t.wrong_number, false) OR (lower(COALESCE(t.detected_intent, t.reply_intent, ''::text)) = ANY (ARRAY['wrong_number'::text, 'wrong_person'::text, 'deceased'::text, 'hostile'::text, 'hostile_or_legal'::text, 'legal_threat'::text]))) THEN 'dead'::text
            WHEN (COALESCE(t.opt_out, false) OR COALESCE(t.is_suppressed, false) OR (lower(COALESCE(t.suppression_status, ''::text)) = 'suppressed'::text) OR (lower(COALESCE(t.detected_intent, t.reply_intent, ''::text)) = 'opt_out'::text) OR (sp.phone IS NOT NULL)) THEN 'suppressed'::text
            WHEN (COALESCE(t.is_hot_lead, false) OR (lower(COALESCE(t.detected_intent, t.reply_intent, ''::text)) = ANY (ARRAY['seller_interested'::text, 'qualified_lead'::text, 'asking_price_provided'::text, 'asks_offer'::text, 'wants_offer'::text, 'offer_requested'::text, 'contract_ready'::text, 'price_anchor'::text, 'ownership_confirmed'::text, 'needs_call'::text, 'callback_requested'::text, 'latent_interest'::text, 'need_more_money'::text, 'send_offer_first'::text]))) THEN 'priority'::text
            WHEN (lower(COALESCE(t.detected_intent, t.reply_intent, ''::text)) = ANY (ARRAY['unclear'::text, 'property_correction'::text, 'who_is_this'::text, 'is_tenant'::text, 'is_realtor'::text, 'reaction_only'::text])) THEN 'needs_review'::text
            WHEN ((lower(COALESCE(t.latest_message_direction, ''::text)) ~~ 'in%'::text) AND (t.latest_message_at >= (now() - '14 days'::interval))) THEN 'new_replies'::text
            WHEN (COALESCE(t.not_interested, false) OR (lower(COALESCE(t.detected_intent, t.reply_intent, ''::text)) = ANY (ARRAY['not_interested'::text, 'negative'::text, 'not_for_sale'::text, 'need_time'::text]))) THEN 'follow_up'::text
            WHEN ((t.last_outbound_at IS NOT NULL) AND (t.last_outbound_at >= (now() - '24:00:00'::interval)) AND ((t.last_inbound_at IS NULL) OR (t.last_inbound_at < t.last_outbound_at))) THEN 'waiting'::text
            WHEN ((t.last_outbound_at IS NOT NULL) AND (t.last_outbound_at < (now() - '24:00:00'::interval)) AND ((t.last_inbound_at IS NULL) OR (t.last_inbound_at < t.last_outbound_at))) THEN 'cold'::text
            WHEN ((t.last_inbound_at IS NOT NULL) AND ((t.last_outbound_at IS NULL) OR (t.last_inbound_at >= t.last_outbound_at))) THEN 'follow_up'::text
            ELSE 'cold'::text
        END AS inbox_bucket
   FROM ((v_inbox_threads_live_v2 t
     LEFT JOIN suppressed_phones sp ON ((sp.phone = t.canonical_e164)))
     LEFT JOIN latest_outbound lo ON ((lo.thread_key = t.thread_key)));
