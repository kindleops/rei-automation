-- ============================================================================
-- CANONICAL INBOX SOURCE OF TRUTH  (P0 — launch-stabilization-20260606)
-- ============================================================================
-- Establishes ONE inbox bucket resolver and ONE counts source.
--
-- Background (see audit): the inbox had three divergent bucket engines
--   1. JS read-time   resolveCanonicalBucket          (negative -> follow_up)
--   2. JS write-time  resolveInboxBucketFromClassification (negative -> dead, orphaned)
--   3. SQL count view v_inbox_thread_counts_live_v2   (negative -> dead)
-- plus a silent thread-source fallback ladder, because the "primary" view
-- inbox_threads_hydrated has no inbox_bucket column.
--
-- This migration replaces all of that with a single canonical view that
-- computes inbox_bucket ONCE, and a counts view that aggregates the SAME view
-- so counts can never disagree with rows.
--
-- Key correctness fixes baked into the ONE resolver:
--   * Resolver keys off RAW signals (detected_intent + explicit flags), NOT the
--     pre-baked universal_status / inbox_category / show_in_priority_inbox fields
--     which carry the OLD (wrong) taxonomy.
--   * NEW_REPLIES is recency-gated (inbound within 14 days) -> no stale threads.
--   * negative / not_interested -> follow_up (per product decision f043e82),
--     NOT dead.  DEAD is reserved for wrong_number / hostile / deceased.
--   * SUPPRESSED is unified with sms_suppression_list (the same source the
--     send-time compliance guard checks), so the UI "Suppressed" bucket and the
--     sender agree.
--
-- Base: v_inbox_threads_live_v2 (exactly one row per thread, already carries the
-- full deal-intelligence projection: property / owner / phones / equity /
-- estimated_value / property_type / market).
-- ============================================================================

DROP VIEW IF EXISTS public.canonical_inbox_counts;
DROP VIEW IF EXISTS public.canonical_inbox_threads;

CREATE VIEW public.canonical_inbox_threads AS
WITH suppressed_phones AS (
  -- Deduped active suppression set, joined ONCE (hash join) instead of a
  -- per-row correlated EXISTS. The correlated form produced an 8s+ plan via the
  -- PostgREST service_role path; this form is plan-stable and fast.
  SELECT DISTINCT phone FROM (
    SELECT phone_e164  AS phone FROM public.sms_suppression_list WHERE is_active = true AND phone_e164  IS NOT NULL
    UNION
    SELECT phone_number AS phone FROM public.sms_suppression_list WHERE is_active = true AND phone_number IS NOT NULL
  ) s
)
SELECT
  t.canonical_thread_key,
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
  -- ───────────────────────── THE ONE BUCKET RESOLVER ─────────────────────────
  CASE
    -- 1. DEAD (terminal, invalid contact) — checked before SUPPRESSED because
    --    "wrong number" replies frequently also carry an opt_out flag, but the
    --    operator's Dead tab is for invalid contacts. Send enforcement is handled
    --    independently by the suppression list + compliance guard.
    WHEN COALESCE(t.wrong_number, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('wrong_number','wrong_person','deceased','hostile','hostile_or_legal','legal_threat')
      THEN 'dead'
    -- 2. SUPPRESSED (terminal, do-not-contact) — unified with sms_suppression_list
    WHEN COALESCE(t.opt_out, false)
         OR COALESCE(t.is_suppressed, false)
         OR lower(COALESCE(t.suppression_status, '')) = 'suppressed'
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) = 'opt_out'
         OR sp.phone IS NOT NULL
      THEN 'suppressed'
    -- 3. PRIORITY (positive interest / actionable)
    WHEN COALESCE(t.is_hot_lead, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('seller_interested','qualified_lead','asking_price_provided','asks_offer',
             'wants_offer','offer_requested','contract_ready','price_anchor',
             'ownership_confirmed','needs_call','callback_requested','latent_interest',
             'need_more_money','send_offer_first')
      THEN 'priority'
    -- 4. NEEDS REVIEW (ambiguous, requires a human)
    WHEN lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('unclear','property_correction','who_is_this','is_tenant','is_realtor','reaction_only')
      THEN 'needs_review'
    -- 5. NEW REPLIES (recent inbound only — recency-gated, no stale threads)
    WHEN lower(COALESCE(t.latest_message_direction, '')) LIKE 'in%'
         AND t.latest_message_at >= now() - interval '14 days'
      THEN 'new_replies'
    -- 6. FOLLOW UP (soft negative, or any thread that has ever replied)
    WHEN COALESCE(t.not_interested, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('not_interested','negative','not_for_sale','need_time')
         OR t.last_inbound_at IS NOT NULL
      THEN 'follow_up'
    -- 7. COLD (outbound only, never replied)
    ELSE 'cold'
  END AS inbox_bucket
FROM public.v_inbox_threads_live_v2 t
LEFT JOIN suppressed_phones sp ON sp.phone = t.canonical_e164;

COMMENT ON VIEW public.canonical_inbox_threads IS
  'P0 single source of truth for the inbox. Computes inbox_bucket once from raw '
  'signals; recency-gated new_replies; suppression unified with sms_suppression_list. '
  'Both the thread list and canonical_inbox_counts read this view.';

-- ============================================================================
-- COUNTS — aggregated over the SAME view, so counts always equal rows.
-- One row, all canonical keys + UI aliases.
-- ============================================================================
CREATE VIEW public.canonical_inbox_counts AS
SELECT
  count(*)                                                              AS "all",
  count(*)                                                              AS all_messages,
  count(*) FILTER (WHERE inbox_bucket = 'priority')                     AS priority,
  count(*) FILTER (WHERE inbox_bucket = 'priority')                     AS hot_leads,
  count(*) FILTER (WHERE inbox_bucket = 'new_replies')                  AS new_replies,
  count(*) FILTER (WHERE inbox_bucket = 'new_replies')                  AS new_inbound,
  count(*) FILTER (WHERE inbox_bucket = 'new_replies')                  AS needs_reply,
  count(*) FILTER (WHERE inbox_bucket = 'needs_review')                 AS needs_review,
  count(*) FILTER (WHERE inbox_bucket = 'needs_review')                 AS manual_review,
  count(*) FILTER (WHERE inbox_bucket = 'needs_review')                 AS automated,
  count(*) FILTER (WHERE inbox_bucket = 'follow_up')                    AS follow_up,
  count(*) FILTER (WHERE inbox_bucket = 'follow_up')                    AS outbound_active,
  count(*) FILTER (WHERE inbox_bucket = 'cold')                         AS cold,
  count(*) FILTER (WHERE inbox_bucket = 'cold')                         AS cold_no_response,
  count(*) FILTER (WHERE inbox_bucket = 'dead')                         AS dead,
  count(*) FILTER (WHERE inbox_bucket = 'suppressed')                   AS suppressed,
  count(*) FILTER (WHERE inbox_bucket = 'suppressed')                   AS dnc_opt_out,
  count(*) FILTER (WHERE inbox_bucket IN ('priority','new_replies','needs_review','follow_up')) AS active,
  count(*) FILTER (WHERE lower(COALESCE(latest_message_direction,'')) LIKE 'out%'
                     AND inbox_bucket NOT IN ('dead','suppressed'))     AS waiting,
  count(*) FILTER (WHERE lower(COALESCE(latest_message_direction,'')) LIKE 'out%'
                     AND inbox_bucket NOT IN ('dead','suppressed'))     AS waiting_on_seller,
  count(*) FILTER (WHERE property_id IS NULL)                           AS unlinked
FROM public.canonical_inbox_threads;

COMMENT ON VIEW public.canonical_inbox_counts IS
  'P0 single counts source. Aggregates canonical_inbox_threads so badge counts '
  'always equal the rows in each bucket. No approximate/degraded/preserved counts.';
