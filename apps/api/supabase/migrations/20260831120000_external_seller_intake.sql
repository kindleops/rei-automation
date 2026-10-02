-- ============================================================================
-- Authenticated external seller-acquisition intake
-- ============================================================================
-- This is a server-to-server ingress boundary, not a browser-facing table or
-- raw database API. It owns the immutable public-submission envelope and the
-- atomic handoff into the existing acquisition opportunity and inbox state.
-- Seller-entered property facts are deliberately kept separate from the
-- source-derived `properties` inventory. A property_id is only linked when
-- the application has already completed deterministic resolution.

BEGIN;

ALTER TABLE public.acquisition_opportunities
  ADD COLUMN IF NOT EXISTS source_application text,
  ADD COLUMN IF NOT EXISTS source_channel text,
  ADD COLUMN IF NOT EXISTS source_submission_id uuid,
  -- The later universal-pipeline migration normally owns this additive field;
  -- declare it here as well so the external-intake boundary is deployable
  -- against a compatible opportunity schema without applying unrelated work.
  ADD COLUMN IF NOT EXISTS property_type text;

ALTER TABLE public.inbox_thread_state
  ADD COLUMN IF NOT EXISTS seller_display_name text,
  ADD COLUMN IF NOT EXISTS source_application text,
  ADD COLUMN IF NOT EXISTS source_channel text,
  ADD COLUMN IF NOT EXISTS source_submission_id uuid,
  ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.external_seller_intake_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version        text NOT NULL,
  source_application    text NOT NULL,
  source_channel        text NOT NULL,
  idempotency_key       text NOT NULL,
  payload_hash          text NOT NULL,
  status                text NOT NULL DEFAULT 'accepted'
                          CHECK (status IN ('accepted', 'rejected', 'failed')),
  seller_display_name   text NOT NULL,
  seller_first_name     text,
  seller_last_name      text,
  seller_phone          text NOT NULL,
  seller_email          text,
  property_address      text NOT NULL,
  property_match_key    text NOT NULL,
  property_id           text,
  property_type         text,
  property_condition    text,
  seller_situation      text,
  selling_timeline      text,
  seller_note           text,
  attribution           jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent               jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched_existing      boolean NOT NULL DEFAULT false,
  lead_id               uuid,
  thread_key            text,
  response              jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_seller_intake_idempotency_unique
    UNIQUE (source_application, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_external_seller_intake_identity
  ON public.external_seller_intake_submissions
    (source_application, seller_phone, property_match_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_seller_intake_lead
  ON public.external_seller_intake_submissions (lead_id)
  WHERE lead_id IS NOT NULL;

COMMENT ON TABLE public.external_seller_intake_submissions IS
  'Immutable server-to-server seller acquisition submissions. Browser access is prohibited.';
COMMENT ON COLUMN public.external_seller_intake_submissions.property_match_key IS
  'Deterministic application-created identity key: resolved property id or normalized-address digest.';
COMMENT ON COLUMN public.external_seller_intake_submissions.response IS
  'Safe durable replay envelope containing identifiers only; never internal seller PII.';

ALTER TABLE public.external_seller_intake_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_seller_intake_submissions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.external_seller_intake_submissions TO service_role;

-- Keep this writer in one database transaction. The function is granted only to
-- service_role; PostgREST callers with anon/authenticated keys cannot execute it.
CREATE OR REPLACE FUNCTION public.ingest_external_seller_intake(
  p_schema_version text,
  p_source_application text,
  p_source_channel text,
  p_idempotency_key text,
  p_payload_hash text,
  p_seller_display_name text,
  p_seller_first_name text,
  p_seller_last_name text,
  p_seller_phone text,
  p_seller_email text,
  p_property_address text,
  p_property_match_key text,
  p_property_id text,
  p_property_type text,
  p_property_condition text,
  p_seller_situation text,
  p_selling_timeline text,
  p_seller_note text,
  p_attribution jsonb,
  p_consent jsonb,
  p_client_metadata jsonb,
  p_submitted_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission public.external_seller_intake_submissions%ROWTYPE;
  v_existing public.external_seller_intake_submissions%ROWTYPE;
  v_opportunity public.acquisition_opportunities%ROWTYPE;
  v_thread public.inbox_thread_state%ROWTYPE;
  v_inserted boolean := false;
  v_matched boolean := false;
  v_thread_created boolean := false;
  v_response jsonb;
  v_identity_lock bigint;
  v_matched_lead_id uuid;
  v_matched_thread_key text;
BEGIN
  -- Serialize idempotency-key ownership before identity matching. This also
  -- makes same-key requests with materially different payloads deterministic.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_source_application || ':idempotency:' || p_idempotency_key,
    0
  ));

  -- Serialize identity matching for this source/phone/property tuple. The
  -- advisory lock is transaction-scoped and is never exposed to callers.
  v_identity_lock := hashtextextended(
    p_source_application || ':' || p_seller_phone || ':' || p_property_match_key,
    0
  );
  PERFORM pg_advisory_xact_lock(v_identity_lock);

  SELECT * INTO v_existing
  FROM public.external_seller_intake_submissions
  WHERE source_application = p_source_application
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.payload_hash <> p_payload_hash THEN
      RETURN jsonb_build_object(
        'ok', false,
        'failure_code', 'idempotency_key_reused_with_different_payload',
        'submission_id', v_existing.id,
        'status', 409
      );
    END IF;
    RETURN COALESCE(v_existing.response, jsonb_build_object(
      'ok', true,
      'submission_id', v_existing.id,
      'lead_id', v_existing.lead_id,
      'matched_existing', v_existing.matched_existing,
      'idempotent_replay', true
    )) || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT * INTO v_existing
  FROM public.external_seller_intake_submissions
  WHERE source_application = p_source_application
    AND seller_phone = p_seller_phone
    AND property_match_key = p_property_match_key
    AND status = 'accepted'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    v_matched_lead_id := v_existing.lead_id;
    v_matched_thread_key := v_existing.thread_key;
  ELSIF p_property_id IS NOT NULL THEN
    -- A seller may already be represented by an imported or manually-created
    -- Lead Command opportunity. Cross-surface matching is intentionally limited
    -- to canonical phone + resolved property identity; name/email alone cannot
    -- assert that two people are the same seller.
    SELECT id, primary_thread_key INTO v_matched_lead_id, v_matched_thread_key
    FROM public.acquisition_opportunities
    WHERE primary_thread_key = p_seller_phone
      AND primary_property_id = p_property_id
      AND opportunity_status <> 'archived'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;
  END IF;

  v_matched := v_matched_lead_id IS NOT NULL;

  INSERT INTO public.external_seller_intake_submissions (
    schema_version, source_application, source_channel, idempotency_key,
    payload_hash, seller_display_name, seller_first_name, seller_last_name,
    seller_phone, seller_email, property_address, property_match_key,
    property_id, property_type, property_condition, seller_situation,
    selling_timeline, seller_note, attribution, consent, client_metadata,
    matched_existing, lead_id, thread_key, response, created_at, updated_at
  ) VALUES (
    p_schema_version, p_source_application, p_source_channel, p_idempotency_key,
    p_payload_hash, p_seller_display_name, p_seller_first_name, p_seller_last_name,
    p_seller_phone, p_seller_email, p_property_address, p_property_match_key,
    p_property_id, p_property_type, p_property_condition, p_seller_situation,
    p_selling_timeline, p_seller_note, COALESCE(p_attribution, '{}'::jsonb),
    COALESCE(p_consent, '{}'::jsonb), COALESCE(p_client_metadata, '{}'::jsonb),
    v_matched, NULL, NULL, '{}'::jsonb, COALESCE(p_submitted_at, now()), now()
  )
  RETURNING * INTO v_submission;

  IF v_matched THEN
    v_submission.lead_id := v_matched_lead_id;
    v_submission.thread_key := COALESCE(v_matched_thread_key, p_seller_phone);
  ELSE
    INSERT INTO public.acquisition_opportunities (
      dedupe_key, primary_property_id, primary_thread_key,
      acquisition_stage, opportunity_status, conversation_state, queue_state,
      workflow_state, priority, automation_state, property_address_full,
      property_type, seller_display_name, source_application, source_channel,
      source_submission_id, promotion_reason, last_updated_source,
      metadata, stage_entered_at, last_activity_at
    ) VALUES (
      'external:' || p_source_application || ':' || p_seller_phone || ':' || p_property_match_key,
      p_property_id, p_seller_phone, 'needs_review', 'active', 'new', 'not_queued',
      'not_enrolled', 'normal', 'inactive', p_property_address, p_property_type,
      p_seller_display_name, p_source_application, p_source_channel, v_submission.id,
      'external_seller_intake', p_source_application,
      jsonb_build_object(
        'external_intake_submission_id', v_submission.id,
        'seller_situation', p_seller_situation,
        'selling_timeline', p_selling_timeline,
        'property_condition', p_property_condition,
        'attribution', COALESCE(p_attribution, '{}'::jsonb),
        'consent', COALESCE(p_consent, '{}'::jsonb)
      ),
      COALESCE(p_submitted_at, now()), COALESCE(p_submitted_at, now())
    )
    RETURNING * INTO v_opportunity;

    INSERT INTO public.acquisition_opportunity_history (
      opportunity_id, event_type, reason, actor, source, idempotency_key, metadata
    ) VALUES (
      v_opportunity.id, 'external_seller_intake_received',
      'Prominent Cash Offer seller submission', 'external_seller_intake',
      p_source_application,
      'external-intake:' || v_submission.id,
      jsonb_build_object('submission_id', v_submission.id, 'automation', 'inactive')
    );

    v_submission.lead_id := v_opportunity.id;

    SELECT * INTO v_thread
    FROM public.inbox_thread_state
    WHERE thread_key = p_seller_phone
    FOR UPDATE;

    IF v_thread.id IS NULL THEN
      INSERT INTO public.inbox_thread_state (
        thread_key, canonical_e164, seller_phone, property_id,
        seller_display_name, source_application, source_channel,
        source_submission_id, source_metadata, stage, status,
        operational_status, lifecycle_stage, seller_stage, conversation_status,
        priority, automation_state, automation_status, inbox_bucket,
        manual_review, needs_review, manual_override, is_read, is_archived,
        is_suppressed, is_pinned, is_starred, unread_count,
        contactability_status, metadata
      ) VALUES (
        p_seller_phone, p_seller_phone, p_seller_phone, p_property_id,
        p_seller_display_name, p_source_application, p_source_channel,
        v_submission.id,
        jsonb_build_object(
          'external_intake_submission_id', v_submission.id,
          'attribution', COALESCE(p_attribution, '{}'::jsonb),
          'consent', COALESCE(p_consent, '{}'::jsonb)
        ),
        -- `stage` is a constrained legacy compatibility field. The canonical
        -- review state is carried by operational_status, inbox_bucket,
        -- seller_stage, conversation_status, and needs_review below.
        'needs_response', 'open', 'needs_review', 'ownership_confirmation',
        'needs_review', 'needs_review', 'normal', 'inactive', 'inactive',
        'needs_review', true, true, false, false, false, false, false, false,
        0, CASE WHEN COALESCE((p_consent->>'contact_requested')::boolean, false)
                THEN 'contactable' ELSE 'not_requested' END,
        jsonb_build_object(
          'external_intake_submission_id', v_submission.id,
          'seller_situation', p_seller_situation,
          'selling_timeline', p_selling_timeline,
          'property_condition', p_property_condition
        )
      )
      RETURNING * INTO v_thread;
      v_thread_created := true;
    END IF;
  END IF;

  UPDATE public.external_seller_intake_submissions
  SET lead_id = v_submission.lead_id,
      thread_key = COALESCE(v_submission.thread_key, p_seller_phone),
      matched_existing = v_matched,
      response = jsonb_build_object(
        'ok', true,
        'submission_id', v_submission.id,
        'lead_id', v_submission.lead_id,
        'matched_existing', v_matched,
        'thread_created', v_thread_created,
        'communication_queued', false,
        'message_sent', false
      ),
      updated_at = now()
  WHERE id = v_submission.id
  RETURNING * INTO v_submission;

  RETURN v_submission.response || jsonb_build_object('idempotent_replay', false);
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_external_seller_intake(
  text, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_external_seller_intake(
  text, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz
) TO service_role;

COMMIT;
