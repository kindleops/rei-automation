-- PROPOSED (NOT AUTO-EXECUTABLE): inbound intelligence shadow audit schema
-- Requires explicit schema approval before rename/remove of PROPOSED_ prefix.

CREATE TABLE IF NOT EXISTS public.inbound_intelligence_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id text NOT NULL,
  provider_message_sid text,
  source_thread_key text,
  property_id text,
  canonical_intent text NOT NULL,
  universal_stage text,
  granular_stage text,
  safety_status text NOT NULL DEFAULT 'review',
  identity_class text,
  relationship_outcome text,
  relationship_claim text,
  suppression_scope text NOT NULL DEFAULT 'none',
  suppression_property_id text,
  invalidate_phone_globally boolean NOT NULL DEFAULT false,
  invalidate_person_globally boolean NOT NULL DEFAULT false,
  execution_blocked_reason text,
  human_review_status text,
  human_review_required boolean NOT NULL DEFAULT false,
  referral_detected boolean NOT NULL DEFAULT false,
  automatic_send_allowed boolean NOT NULL DEFAULT false,
  decision_version text NOT NULL,
  canonical_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_decision jsonb,
  shadow_stage_engine jsonb,
  follow_up_recommendation jsonb,
  selected_template jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_intelligence_audit_source_event_unique UNIQUE (source_event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_intelligence_audit_provider_sid
  ON public.inbound_intelligence_audit (provider_message_sid)
  WHERE provider_message_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_intelligence_audit_thread
  ON public.inbound_intelligence_audit (source_thread_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_intelligence_audit_property
  ON public.inbound_intelligence_audit (property_id, created_at DESC)
  WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.seller_contact_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id text NOT NULL,
  source_thread_key text NOT NULL,
  source_contact_phone text NOT NULL,
  property_id text NOT NULL,
  master_owner_id text,
  referred_name text,
  referred_phone_e164 text,
  relationship_claim text,
  confidence numeric(4,3),
  extraction_method text NOT NULL,
  dedupe_status text NOT NULL DEFAULT 'pending_review',
  proposed_prospect_id text,
  proposed_phone_id text,
  review_status text NOT NULL DEFAULT 'pending_review',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CONSTRAINT seller_contact_referrals_review_status_check
    CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'applied'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_contact_referrals_event_phone_property
  ON public.seller_contact_referrals (source_event_id, referred_phone_e164, property_id)
  WHERE referred_phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_contact_referrals_property
  ON public.seller_contact_referrals (property_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_contact_referrals_review_status
  ON public.seller_contact_referrals (review_status, created_at DESC);

-- Read-only projection. Not an identity source of truth.
CREATE OR REPLACE VIEW public.property_participant_graph AS
SELECT
  md5(
    concat_ws(
      ':',
      me.property_id,
      COALESCE(ph.canonical_e164, me.from_phone_number, me.thread_key),
      COALESCE(me.master_owner_id, ''),
      COALESCE(me.prospect_id, '')
    )
  ) AS participant_id,
  me.property_id,
  me.master_owner_id,
  me.prospect_id,
  ph.id::text AS phone_id,
  COALESCE(ph.canonical_e164, me.from_phone_number, me.thread_key) AS canonical_e164,
  COALESCE(
    scr.referred_name,
    mo.display_name,
    mo.owner_name,
    ph.display_name
  ) AS display_name,
  CASE
    WHEN scr.id IS NOT NULL THEN 'referred_possible_owner'
    WHEN me.metadata->>'identity_class' = 'referral_source' THEN 'referral_source'
    WHEN me.metadata->>'identity_class' = 'respondent_non_owner' THEN 'respondent_non_owner'
    WHEN me.metadata->>'identity_class' = 'confirmed_owner' THEN 'master_owner'
    WHEN me.metadata->>'identity_class' = 'probable_owner' THEN 'probable_owner'
    WHEN me.metadata->>'identity_class' = 'wrong_number'
      AND COALESCE(me.metadata->>'suppression_scope', 'none') IN ('phone', 'global')
      THEN 'wrong_number'
    ELSE COALESCE(me.metadata->>'identity_class', 'respondent')
  END AS relationship_to_property,
  COALESCE(me.metadata->>'identity_class', 'unknown') AS identity_class,
  CASE
    WHEN me.metadata->>'identity_class' = 'confirmed_owner' THEN 0.95
    WHEN me.metadata->>'identity_class' = 'probable_owner' THEN 0.75
    ELSE NULL
  END AS ownership_confidence,
  COALESCE(me.metadata->>'contact_source', 'inbound_sms') AS contact_source,
  scr.source_event_id AS referral_source_event_id,
  scr.source_thread_key AS referral_source_thread_key,
  COALESCE(ph.phone_contact_status, 'active') AS contact_status,
  CASE
    WHEN COALESCE(me.metadata->>'suppression_scope', 'none') = 'property' THEN 'property_suppressed'
    WHEN COALESCE(me.metadata->>'suppression_scope', 'none') IN ('phone', 'global') THEN 'suppressed'
    WHEN ph.phone_contact_status IN ('wrong_number', 'opt_out') THEN 'suppressed'
    ELSE 'active'
  END AS suppression_status,
  COALESCE(me.metadata->>'suppression_scope', 'none') AS suppression_scope,
  COALESCE(me.metadata->>'suppression_property_id', me.property_id) AS suppression_property_id,
  COALESCE(me.metadata->'inbound_intelligence'->>'universal_stage', me.metadata->>'conversation_stage') AS universal_stage,
  COALESCE(me.metadata->'inbound_intelligence'->>'granular_stage', me.metadata->>'seller_stage') AS granular_stage,
  me.received_at AS last_message_at,
  0::integer AS unread_count,
  CASE
    WHEN COALESCE(me.metadata->>'suppression_scope', 'none') = 'property' THEN true
    WHEN COALESCE(me.metadata->>'suppression_scope', 'none') IN ('phone', 'global') THEN false
    WHEN ph.phone_contact_status IN ('wrong_number', 'opt_out') THEN false
    ELSE true
  END AS safe_to_contact,
  CASE
    WHEN me.metadata->>'execution_blocked_reason' IS NOT NULL THEN me.metadata->>'execution_blocked_reason'
    WHEN COALESCE(me.metadata->>'suppression_scope', 'none') = 'property'
      THEN 'property_scoped_non_owner'
    WHEN COALESCE(me.metadata->>'suppression_scope', 'none') IN ('phone', 'global')
      THEN 'globally_suppressed'
    ELSE NULL
  END AS safe_to_contact_reason,
  false AS is_current_participant,
  (me.metadata->>'identity_class' = 'confirmed_owner') AS is_primary_owner_record,
  (scr.id IS NOT NULL) AS is_referred_contact
FROM public.message_events me
LEFT JOIN public.phones ph
  ON ph.canonical_e164 = COALESCE(me.from_phone_number, me.thread_key)
LEFT JOIN public.master_owners mo
  ON mo.id::text = me.master_owner_id
LEFT JOIN public.seller_contact_referrals scr
  ON scr.referred_phone_e164 = COALESCE(ph.canonical_e164, me.from_phone_number, me.thread_key)
 AND scr.property_id = me.property_id
 AND scr.review_status = 'pending_review'
LEFT JOIN public.prospects p
  ON p.id::text = me.prospect_id
WHERE me.direction = 'inbound'
  AND me.property_id IS NOT NULL;

COMMENT ON VIEW public.property_participant_graph IS
  'Read-only participant projection for inbox UI. Projects message_events + reviewed referrals; not an identity source of truth.';

ALTER TABLE public.inbound_intelligence_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_contact_referrals ENABLE ROW LEVEL SECURITY;

-- Service-role only until user-facing policies are defined.
CREATE POLICY "service_role_all_inbound_intelligence_audit"
  ON public.inbound_intelligence_audit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_all_seller_contact_referrals"
  ON public.seller_contact_referrals
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);