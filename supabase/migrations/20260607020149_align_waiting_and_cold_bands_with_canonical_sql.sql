
-- Update canonical_inbox_threads to strictly follow the audit definitions for waiting and cold buckets.
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
    t.delivery_status,
    t.provider_delivery_status,
    t.latest_delivery_status,
    t.latest_provider_delivery_status,
    t.latest_delivered_at,
    t.latest_failed_at,
    t.latest_failure_reason,
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
    t.latest_message_event_data,
    t.created_at,
    t.updated_at,
    t.preview,
    t.inbox_category,
    t.display_status,
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
            
            -- Requirement 1: waiting = outbound sent within last 24 hours AND no inbound after last outbound
            WHEN ((t.last_outbound_at IS NOT NULL) AND (t.last_outbound_at >= (now() - '24:00:00'::interval)) AND ((t.last_inbound_at IS NULL) OR (t.last_inbound_at < t.last_outbound_at))) THEN 'waiting'::text
            
            -- Requirement 1: cold = outbound older than 24 hours AND no inbound after last outbound
            WHEN ((t.last_outbound_at IS NOT NULL) AND (t.last_outbound_at < (now() - '24:00:00'::interval)) AND ((t.last_inbound_at IS NULL) OR (t.last_inbound_at < t.last_outbound_at))) THEN 'cold'::text
            
            WHEN ((t.last_inbound_at IS NOT NULL) AND ((t.last_outbound_at IS NULL) OR (t.last_inbound_at >= t.last_outbound_at))) THEN 'follow_up'::text
            ELSE 'cold'::text
        END AS inbox_bucket
   FROM (v_inbox_threads_live_v2 t
     LEFT JOIN suppressed_phones sp ON ((sp.phone = t.canonical_e164)));

-- Update canonical_inbox_counts to use the (last_outbound_at OR latest_message_at) logic for cold bands.
CREATE OR REPLACE VIEW public.canonical_inbox_counts AS
 SELECT count(*) AS "all",
    count(*) AS all_messages,
    count(*) FILTER (WHERE (inbox_bucket = 'priority'::text)) AS priority,
    count(*) FILTER (WHERE (inbox_bucket = 'priority'::text)) AS hot_leads,
    count(*) FILTER (WHERE (inbox_bucket = 'new_replies'::text)) AS new_replies,
    count(*) FILTER (WHERE (inbox_bucket = 'new_replies'::text)) AS new_inbound,
    count(*) FILTER (WHERE (inbox_bucket = 'new_replies'::text)) AS needs_reply,
    count(*) FILTER (WHERE (inbox_bucket = 'needs_review'::text)) AS needs_review,
    count(*) FILTER (WHERE (inbox_bucket = 'needs_review'::text)) AS manual_review,
    count(*) FILTER (WHERE (inbox_bucket = 'needs_review'::text)) AS automated,
    count(*) FILTER (WHERE (inbox_bucket = 'follow_up'::text)) AS follow_up,
    count(*) FILTER (WHERE (inbox_bucket = 'follow_up'::text)) AS outbound_active,
    count(*) FILTER (WHERE (inbox_bucket = 'cold'::text)) AS cold,
    count(*) FILTER (WHERE (inbox_bucket = 'cold'::text)) AS cold_no_response,
    count(*) FILTER (WHERE (inbox_bucket = 'dead'::text)) AS dead,
    count(*) FILTER (WHERE (inbox_bucket = 'suppressed'::text)) AS suppressed,
    count(*) FILTER (WHERE (inbox_bucket = 'suppressed'::text)) AS dnc_opt_out,
    count(*) FILTER (WHERE (inbox_bucket = 'waiting'::text)) AS waiting,
    count(*) FILTER (WHERE (inbox_bucket = 'waiting'::text)) AS waiting_on_seller,
    count(*) FILTER (WHERE (inbox_bucket = ANY (ARRAY['priority'::text, 'new_replies'::text, 'needs_review'::text, 'follow_up'::text, 'waiting'::text]))) AS active,
    count(*) FILTER (WHERE (property_id IS NULL)) AS unlinked,
    -- Requirement B: Cold filters must work using last_outbound_at OR latest_message_at.
    count(*) FILTER (WHERE ((inbox_bucket = 'cold'::text) AND (last_outbound_at < (now() - '24:00:00'::interval) OR latest_message_at < (now() - '24:00:00'::interval)))) AS cold_24h,
    count(*) FILTER (WHERE ((inbox_bucket = 'cold'::text) AND (last_outbound_at < (now() - '3 days'::interval) OR latest_message_at < (now() - '3 days'::interval)))) AS cold_3d,
    count(*) FILTER (WHERE ((inbox_bucket = 'cold'::text) AND (last_outbound_at < (now() - '7 days'::interval) OR latest_message_at < (now() - '7 days'::interval)))) AS cold_7d,
    count(*) FILTER (WHERE ((inbox_bucket = 'cold'::text) AND (last_outbound_at < (now() - '14 days'::interval) OR latest_message_at < (now() - '14 days'::interval)))) AS cold_14d,
    count(*) FILTER (WHERE ((inbox_bucket = 'cold'::text) AND (last_outbound_at < (now() - '30 days'::interval) OR latest_message_at < (now() - '30 days'::interval)))) AS cold_30d
   FROM canonical_inbox_threads;
