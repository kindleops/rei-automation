-- Pipeline universal state recovery: align acquisition_opportunities with deal_thread_state truth.

ALTER TABLE public.acquisition_opportunities
  ADD COLUMN IF NOT EXISTS universal_status text,
  ADD COLUMN IF NOT EXISTS property_state text,
  ADD COLUMN IF NOT EXISTS property_type text;

ALTER TABLE public.acquisition_opportunities
  DROP CONSTRAINT IF EXISTS acquisition_opportunities_stage_check;

ALTER TABLE public.acquisition_opportunities
  ADD CONSTRAINT acquisition_opportunities_stage_check CHECK (
    acquisition_stage IN (
      'ownership_confirmation',
      'offer_interest',
      'asking_price',
      'property_condition',
      'offer',
      'formal_contract',
      'under_contract',
      'disposition',
      'prepared_to_close',
      'closed',
      -- legacy aliases retained during transition
      'needs_review',
      'interest_qualification',
      'price_discovery',
      'underwriting',
      'decision_and_offer',
      'contract_to_close'
    )
  );

CREATE OR REPLACE FUNCTION public.normalize_pipeline_stage_code(raw_stage text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(trim(COALESCE(raw_stage, '')))
    WHEN '' THEN 'ownership_confirmation'
    WHEN 'ownership_confirmation' THEN 'ownership_confirmation'
    WHEN 'ownership_check' THEN 'ownership_confirmation'
    WHEN 'ownership' THEN 'ownership_confirmation'
    WHEN 'needs_review' THEN 'ownership_confirmation'
    WHEN 'new' THEN 'ownership_confirmation'
    WHEN 'identity_question' THEN 'ownership_confirmation'
    WHEN 'offer_interest' THEN 'offer_interest'
    WHEN 'offer_interest_confirmation' THEN 'offer_interest'
    WHEN 'interest_qualification' THEN 'offer_interest'
    WHEN 'interest_probe' THEN 'offer_interest'
    WHEN 'consider_selling' THEN 'offer_interest'
    WHEN 'seller_replied' THEN 'offer_interest'
    WHEN 'asking_price' THEN 'asking_price'
    WHEN 'price_discovery' THEN 'asking_price'
    WHEN 'seller_price_discovery' THEN 'asking_price'
    WHEN 'property_condition' THEN 'property_condition'
    WHEN 'condition_details' THEN 'property_condition'
    WHEN 'condition_collection' THEN 'property_condition'
    WHEN 'condition_timeline_discovery' THEN 'property_condition'
    WHEN 'underwriting' THEN 'property_condition'
    WHEN 'underwriting_needed' THEN 'property_condition'
    WHEN 'offer' THEN 'offer'
    WHEN 'decision_and_offer' THEN 'offer'
    WHEN 'offer_pending' THEN 'offer'
    WHEN 'offer_sent' THEN 'offer'
    WHEN 'negotiation' THEN 'offer'
    WHEN 'offer_positioning' THEN 'offer'
    WHEN 'formal_contract' THEN 'formal_contract'
    WHEN 'contract_to_close' THEN 'formal_contract'
    WHEN 'contract_requested' THEN 'formal_contract'
    WHEN 'contract_sent' THEN 'formal_contract'
    WHEN 'contract_out' THEN 'formal_contract'
    WHEN 'verbal_acceptance_lock' THEN 'formal_contract'
    WHEN 'under_contract' THEN 'under_contract'
    WHEN 'signed_closing' THEN 'under_contract'
    WHEN 'disposition' THEN 'disposition'
    WHEN 'prepared_to_close' THEN 'prepared_to_close'
    WHEN 'closing' THEN 'prepared_to_close'
    WHEN 'title_closing' THEN 'prepared_to_close'
    WHEN 'closed' THEN 'closed'
    WHEN 'dead' THEN 'closed'
    WHEN 'suppressed' THEN 'closed'
    WHEN 'wrong_number' THEN 'closed'
    WHEN 'not_interested' THEN 'closed'
    ELSE 'ownership_confirmation'
  END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_pipeline_status_code(
  raw_bucket text,
  raw_universal_status text,
  needs_review boolean DEFAULT false
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(needs_review, false) THEN 'needs_review'
    WHEN lower(trim(COALESCE(raw_bucket, ''))) IN ('priority', 'new_replies', 'hot_lead') THEN 'priority'
    WHEN lower(trim(COALESCE(raw_bucket, ''))) IN ('waiting', 'waiting_on_seller') THEN 'waiting'
    WHEN lower(trim(COALESCE(raw_bucket, ''))) IN ('cold', 'dead', 'suppressed') THEN 'cold'
    WHEN lower(trim(COALESCE(raw_bucket, ''))) = 'follow_up' THEN 'follow_up'
    WHEN lower(trim(COALESCE(raw_bucket, ''))) = 'needs_review' THEN 'needs_review'
    WHEN lower(trim(COALESCE(raw_universal_status, ''))) IN ('priority', 'active', 'active_conversation', 'seller_replied') THEN 'priority'
    WHEN lower(trim(COALESCE(raw_universal_status, ''))) IN ('waiting', 'awaiting_response', 'outbound_sent') THEN 'waiting'
    WHEN lower(trim(COALESCE(raw_universal_status, ''))) IN ('cold', 'dead', 'suppressed') THEN 'cold'
    WHEN lower(trim(COALESCE(raw_universal_status, ''))) IN ('follow_up', 'follow_up_due') THEN 'follow_up'
    WHEN lower(trim(COALESCE(raw_universal_status, ''))) = 'needs_review' THEN 'needs_review'
    ELSE 'unknown'
  END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_pipeline_temperature_code(raw_temperature text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(trim(COALESCE(raw_temperature, '')))
    WHEN '' THEN 'unknown'
    WHEN 'cold' THEN 'cold'
    WHEN 'warming' THEN 'warming'
    WHEN 'warm' THEN 'warming'
    WHEN 'engaged' THEN 'engaged'
    WHEN 'hot' THEN 'hot'
    WHEN 'dead' THEN 'dead'
    ELSE 'unknown'
  END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_acquisition_opportunities_from_canonical_truth()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer := 0;
BEGIN
  UPDATE public.acquisition_opportunities ao
  SET
    acquisition_stage = public.normalize_pipeline_stage_code(
      COALESCE(d.universal_stage, d.conversation_stage, ao.acquisition_stage)
    ),
    universal_status = public.normalize_pipeline_status_code(
      d.inbox_bucket,
      d.universal_status,
      d.needs_review
    ),
    opportunity_status = CASE
      WHEN d.wrong_number OR d.not_interested OR lower(COALESCE(d.universal_status, '')) = 'dead' THEN 'dead'
      WHEN d.opt_out OR lower(COALESCE(d.universal_status, '')) = 'suppressed' OR d.inbox_bucket = 'suppressed' THEN 'suppressed'
      WHEN public.normalize_pipeline_status_code(d.inbox_bucket, d.universal_status, d.needs_review) IN ('waiting', 'cold') THEN 'waiting'
      WHEN public.normalize_pipeline_status_code(d.inbox_bucket, d.universal_status, d.needs_review) = 'follow_up' THEN 'nurture'
      ELSE 'active'
    END,
    conversation_state = CASE
      WHEN d.needs_review THEN 'needs_review'
      WHEN lower(COALESCE(d.latest_message_direction, d.direction, '')) = 'inbound' THEN 'seller_replied'
      WHEN lower(COALESCE(d.latest_message_direction, d.direction, '')) = 'outbound' THEN 'awaiting_seller'
      WHEN COALESCE(d.unread_count, 0) > 0 THEN 'needs_reply'
      ELSE COALESCE(ao.conversation_state, 'no_recent_activity')
    END,
    temperature = NULLIF(
      public.normalize_pipeline_temperature_code(d.lead_temperature),
      'unknown'
    ),
    aos = CASE
      WHEN ao.acquisition_engine_run_id IS NULL THEN NULL
      ELSE ao.aos
    END,
    market = COALESCE(d.market, ao.market),
    property_address_full = COALESCE(d.property_address, ao.property_address_full),
    seller_display_name = COALESCE(d.owner_name, ao.seller_display_name),
    latest_intent = COALESCE(d.reply_intent, ao.latest_intent),
    latest_message_preview = COALESCE(d.latest_message_body, d.last_message_body, ao.latest_message_preview),
    last_activity_at = COALESCE(d.latest_message_at, d.last_message_at, d.updated_at, ao.last_activity_at),
    last_contact_at = COALESCE(d.latest_message_at, d.last_message_at, ao.last_contact_at),
    last_updated_source = 'canonical_truth_reconciliation',
    updated_at = now(),
    version = COALESCE(ao.version, 1) + 1
  FROM public.v_universal_inbox_threads d
  WHERE ao.primary_thread_key = d.thread_key;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  -- Normalize legacy stage codes on rows without thread joins.
  UPDATE public.acquisition_opportunities ao
  SET
    acquisition_stage = public.normalize_pipeline_stage_code(ao.acquisition_stage),
    aos = CASE WHEN ao.acquisition_engine_run_id IS NULL THEN NULL ELSE ao.aos END,
    last_updated_source = 'canonical_truth_reconciliation',
    updated_at = now(),
    version = COALESCE(ao.version, 1) + 1
  WHERE ao.primary_thread_key IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.v_universal_inbox_threads d
       WHERE d.thread_key = ao.primary_thread_key
     );

  RETURN updated_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.pipeline_reconciliation_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total', COUNT(*),
    'by_stage', COALESCE(
      (SELECT jsonb_object_agg(acquisition_stage, cnt) FROM (
        SELECT acquisition_stage, COUNT(*)::integer AS cnt
        FROM public.acquisition_opportunities
        GROUP BY acquisition_stage
      ) stage_rows),
      '{}'::jsonb
    ),
    'by_universal_status', COALESCE(
      (SELECT jsonb_object_agg(status_key, cnt) FROM (
        SELECT COALESCE(universal_status, 'unknown') AS status_key, COUNT(*)::integer AS cnt
        FROM public.acquisition_opportunities
        GROUP BY COALESCE(universal_status, 'unknown')
      ) status_rows),
      '{}'::jsonb
    ),
    'by_temperature', COALESCE(
      (SELECT jsonb_object_agg(temp_key, cnt) FROM (
        SELECT COALESCE(temperature, 'unknown') AS temp_key, COUNT(*)::integer AS cnt
        FROM public.acquisition_opportunities
        GROUP BY COALESCE(temperature, 'unknown')
      ) temp_rows),
      '{}'::jsonb
    ),
    'aos_without_engine_run', COUNT(*) FILTER (WHERE acquisition_engine_run_id IS NULL AND aos IS NOT NULL),
    'missing_universal_status', COUNT(*) FILTER (WHERE universal_status IS NULL)
  )
  FROM public.acquisition_opportunities;
$$;

CREATE OR REPLACE FUNCTION public.report_pipeline_reconciliation_counts()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  before_counts jsonb;
  after_counts jsonb;
  aos_nullified integer;
  reconciled integer;
BEGIN
  before_counts := public.pipeline_reconciliation_snapshot();

  SELECT COUNT(*)::integer
  INTO aos_nullified
  FROM public.acquisition_opportunities
  WHERE acquisition_engine_run_id IS NULL AND aos IS NOT NULL;

  reconciled := public.reconcile_acquisition_opportunities_from_canonical_truth();
  after_counts := public.pipeline_reconciliation_snapshot();

  RETURN jsonb_build_object(
    'before', before_counts,
    'after', after_counts,
    'rows_reconciled_from_threads', reconciled,
    'aos_nullified_without_engine_run', aos_nullified,
    'reconciled_at', now()
  );
END;
$$;

-- Idempotent recovery pass (no deletes).
SELECT public.reconcile_acquisition_opportunities_from_canonical_truth();