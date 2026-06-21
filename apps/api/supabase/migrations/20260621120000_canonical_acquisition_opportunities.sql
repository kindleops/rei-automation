-- Canonical acquisition opportunity model for Pipeline command center.

CREATE TABLE IF NOT EXISTS public.acquisition_opportunities (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key                  text UNIQUE NOT NULL,
  master_owner_id             text,
  decision_maker_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
  primary_property_id         text,
  portfolio_group_id          text,
  portfolio_property_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
  primary_thread_key          text,
  related_thread_keys         jsonb NOT NULL DEFAULT '[]'::jsonb,
  campaign_ids                jsonb NOT NULL DEFAULT '[]'::jsonb,
  workflow_enrollment_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
  workflow_run_ids            jsonb NOT NULL DEFAULT '[]'::jsonb,
  acquisition_engine_run_id   text,
  acquisition_stage           text NOT NULL DEFAULT 'needs_review',
  opportunity_status          text NOT NULL DEFAULT 'active',
  conversation_state          text,
  queue_state                 text NOT NULL DEFAULT 'not_queued',
  workflow_state              text NOT NULL DEFAULT 'not_enrolled',
  priority                    text NOT NULL DEFAULT 'normal',
  temperature                 text,
  strategy                    text,
  aos                         numeric,
  confidence                  numeric,
  estimated_value             numeric,
  arv                         numeric,
  asking_price                numeric,
  recommended_offer           numeric,
  current_offer               numeric,
  seller_counter              numeric,
  offer_to_ask_gap            numeric,
  motivation_score            numeric,
  cooperation_score           numeric,
  assigned_operator           text,
  automation_state            text NOT NULL DEFAULT 'inactive',
  next_action                 text,
  next_action_due             timestamptz,
  blocker                     text,
  approval_state              text,
  latest_intent               text,
  latest_message_preview      text,
  asset_class                 text,
  market                      text,
  property_address_full       text,
  seller_display_name         text,
  portfolio_property_count    integer NOT NULL DEFAULT 0,
  stage_entered_at            timestamptz NOT NULL DEFAULT now(),
  last_activity_at            timestamptz,
  last_contact_at             timestamptz,
  last_updated_source         text NOT NULL DEFAULT 'system',
  last_updated_by             text,
  promotion_reason            text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_opportunities_stage_check CHECK (
    acquisition_stage IN (
      'needs_review', 'ownership_confirmation', 'interest_qualification',
      'price_discovery', 'underwriting', 'decision_and_offer', 'contract_to_close'
    )
  ),
  CONSTRAINT acquisition_opportunities_status_check CHECK (
    opportunity_status IN (
      'active', 'waiting', 'paused', 'nurture', 'won', 'lost', 'dead', 'suppressed', 'archived'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_stage
  ON public.acquisition_opportunities (acquisition_stage, opportunity_status);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_owner_property
  ON public.acquisition_opportunities (master_owner_id, primary_property_id);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_thread
  ON public.acquisition_opportunities (primary_thread_key);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_market
  ON public.acquisition_opportunities (market);

CREATE INDEX IF NOT EXISTS idx_acq_opportunities_next_action_due
  ON public.acquisition_opportunities (next_action_due)
  WHERE next_action_due IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.acquisition_opportunity_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  field_name        text,
  previous_value    text,
  new_value         text,
  reason            text,
  actor             text,
  source            text NOT NULL DEFAULT 'system',
  idempotency_key   text UNIQUE,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acq_opportunity_history_opp
  ON public.acquisition_opportunity_history (opportunity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pipeline_saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  view_key      text NOT NULL,
  label         text NOT NULL,
  description   text,
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  group_by      text NOT NULL DEFAULT 'acquisition_stage',
  is_default    boolean NOT NULL DEFAULT false,
  is_pinned     boolean NOT NULL DEFAULT false,
  is_shared     boolean NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_saved_views_key_unique UNIQUE (view_key)
);

INSERT INTO public.pipeline_saved_views (view_key, label, description, filters, group_by, is_default, is_pinned)
VALUES
  ('needs_reply', 'Needs Reply', 'Opportunities requiring operator reply', '{"conversation_state":"needs_reply"}', 'conversation_state', false, true),
  ('needs_human_review', 'Needs Human Review', 'Seller replies awaiting review', '{"conversation_state":"needs_review"}', 'acquisition_stage', false, true),
  ('high_aos', 'High AOS', 'Acquisition score above threshold', '{"aos_min":70}', 'acquisition_stage', false, true),
  ('offer_ready', 'Offer Ready', 'Underwriting complete, offer decision pending', '{"acquisition_stage":"decision_and_offer"}', 'acquisition_stage', false, true),
  ('follow_up_due', 'Follow-Up Due', 'Workflow follow-ups due now', '{"follow_up_due":true}', 'follow_up', false, true),
  ('automation_blocked', 'Automation Blocked', 'Workflow blocked or approval required', '{"workflow_state":["blocked","approval_required"]}', 'workflow_state', false, true),
  ('contract_to_close', 'Contract to Close', 'Active contract milestones', '{"acquisition_stage":"contract_to_close"}', 'acquisition_stage', false, false)
ON CONFLICT (view_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.backfill_acquisition_opportunities_from_threads()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count integer := 0;
BEGIN
  INSERT INTO public.acquisition_opportunities (
    dedupe_key,
    master_owner_id,
    primary_property_id,
    primary_thread_key,
    related_thread_keys,
    campaign_ids,
    acquisition_stage,
    opportunity_status,
    conversation_state,
    queue_state,
    priority,
    temperature,
    aos,
    confidence,
    estimated_value,
    asking_price,
    motivation_score,
    automation_state,
    next_action,
    next_action_due,
    latest_intent,
    latest_message_preview,
    asset_class,
    market,
    property_address_full,
    seller_display_name,
    stage_entered_at,
    last_activity_at,
    last_contact_at,
    promotion_reason,
    last_updated_source
  )
  SELECT
    COALESCE(
      CASE
        WHEN d.master_owner_id IS NOT NULL AND d.property_id IS NOT NULL
          THEN 'owner:' || d.master_owner_id || ':property:' || d.property_id
        ELSE 'thread:' || d.thread_key
      END
    ),
    d.master_owner_id,
    d.property_id,
    d.thread_key,
    jsonb_build_array(d.thread_key),
    CASE WHEN d.campaign_id IS NOT NULL THEN jsonb_build_array(d.campaign_id::text) ELSE '[]'::jsonb END,
    CASE
      WHEN d.universal_stage IN ('closing','contract_sent','contract_requested') THEN 'contract_to_close'
      WHEN d.universal_stage IN ('offer_sent','negotiation','offer_pending') THEN 'decision_and_offer'
      WHEN d.universal_stage IN ('underwriting_needed','underwriting','condition_details') THEN 'underwriting'
      WHEN d.universal_stage IN ('price_discovery','asking_price') THEN 'price_discovery'
      WHEN d.universal_stage IN ('interest_probe','seller_replied') OR d.last_inbound_at IS NOT NULL THEN 'interest_qualification'
      WHEN d.needs_review OR d.inbox_bucket = 'needs_review' THEN 'needs_review'
      ELSE 'ownership_confirmation'
    END,
    CASE
      WHEN d.universal_status = 'dead' OR d.inbox_bucket = 'dead' THEN 'dead'
      WHEN d.universal_status = 'suppressed' OR d.opt_out OR d.inbox_bucket = 'suppressed' THEN 'suppressed'
      WHEN d.universal_status IN ('awaiting_response','outbound_sent') AND d.last_inbound_at IS NULL THEN 'waiting'
      ELSE 'active'
    END,
    CASE
      WHEN d.needs_review THEN 'needs_review'
      WHEN d.last_inbound_at IS NOT NULL AND (d.last_outbound_at IS NULL OR d.last_inbound_at > d.last_outbound_at) THEN 'seller_replied'
      WHEN d.last_outbound_at IS NOT NULL AND (d.last_inbound_at IS NULL OR d.last_outbound_at > d.last_inbound_at) THEN 'awaiting_seller'
      ELSE 'no_recent_activity'
    END,
    COALESCE(NULLIF(lower(d.automation_status), ''), 'not_queued'),
    COALESCE(NULLIF(d.priority, ''), 'normal'),
    d.lead_temperature,
    d.final_acquisition_score,
    d.confidence_score,
    d.estimated_value,
    d.cash_offer,
    d.motivation_score,
    CASE
      WHEN d.not_interested OR d.opt_out OR d.wrong_number THEN 'cancelled'
      WHEN lower(d.automation_status) LIKE '%active%' OR lower(d.automation_status) LIKE '%auto%' THEN 'active'
      ELSE 'inactive'
    END,
    d.next_action,
    d.follow_up_due_at,
    d.reply_intent,
    d.latest_message_body,
    d.asset_class,
    d.market,
    d.property_address_full,
    COALESCE(d.owner_name, d.seller_first_name),
    COALESCE(d.updated_at, d.latest_message_at, now()),
    COALESCE(d.latest_message_at, d.updated_at),
    COALESCE(d.last_inbound_at, d.last_outbound_at, d.latest_message_at),
    'backfill_from_deal_thread_state',
    'system_reconciliation'
  FROM public.deal_thread_state d
  WHERE (
    d.last_inbound_at IS NOT NULL
    OR d.needs_review = true
    OR d.inbox_bucket IN ('new_replies', 'needs_review', 'priority', 'follow_up')
    OR d.universal_status IN (
      'seller_replied', 'needs_review', 'hot_lead', 'negotiating', 'underwriting',
      'offer_needed', 'offer_sent', 'contract_requested', 'contract_sent', 'closing'
    )
    OR d.universal_stage IN (
      'interest_probe', 'price_discovery', 'underwriting_needed', 'offer_pending',
      'offer_sent', 'negotiation', 'contract_requested', 'contract_sent', 'closing'
    )
    OR (d.final_acquisition_score IS NOT NULL AND d.final_acquisition_score >= 70)
  )
  AND NOT (
    d.universal_status IN ('new', 'not_contacted', 'queued', 'scheduled', 'outbound_sent', 'awaiting_response')
    AND d.last_inbound_at IS NULL
    AND COALESCE(d.needs_review, false) = false
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

SELECT public.backfill_acquisition_opportunities_from_threads();