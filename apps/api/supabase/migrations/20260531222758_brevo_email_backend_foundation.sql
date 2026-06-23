-- Brevo email backend foundation
-- Manual-send only. No queue runner or bulk send behavior is created here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_email_foundation_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Sender identities for manual transactional email.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_key text UNIQUE,
  provider text NOT NULL DEFAULT 'brevo',
  sender_name text NOT NULL,
  sender_email text NOT NULL,
  reply_to_email text,
  brand_key text,
  domain text,
  is_active boolean NOT NULL DEFAULT true,
  domain_verified boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_senders_provider_sender_email_uq
  ON public.email_senders (provider, lower(sender_email));

CREATE INDEX IF NOT EXISTS email_senders_active_idx
  ON public.email_senders (is_active, provider);

DROP TRIGGER IF EXISTS trg_email_senders_updated_at ON public.email_senders;
CREATE TRIGGER trg_email_senders_updated_at
  BEFORE UPDATE ON public.email_senders
  FOR EACH ROW EXECUTE FUNCTION public.set_email_foundation_updated_at();

-- Legacy identity table used by older email queue code. Keep it available for
-- compatibility while the domain service reads email_senders first.
CREATE TABLE IF NOT EXISTS public.email_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text UNIQUE NOT NULL,
  sender_name text NOT NULL,
  sender_email text NOT NULL,
  reply_to_email text,
  domain text,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.email_identities
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DROP TRIGGER IF EXISTS trg_email_identities_updated_at ON public.email_identities;
CREATE TRIGGER trg_email_identities_updated_at
  BEFORE UPDATE ON public.email_identities
  FOR EACH ROW EXECUTE FUNCTION public.set_email_foundation_updated_at();

-- ---------------------------------------------------------------------------
-- Drafts and message records.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_key text UNIQUE,
  status text NOT NULL DEFAULT 'draft',
  email_address text NOT NULL,
  to_email text NOT NULL,
  from_email text,
  from_name text,
  reply_to_email text,
  subject text NOT NULL,
  html_body text,
  text_body text,
  prospect_id text,
  property_id text,
  master_owner_id text,
  template_id text,
  template_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_drafts_email_idx
  ON public.email_drafts (lower(email_address));

CREATE INDEX IF NOT EXISTS email_drafts_status_idx
  ON public.email_drafts (status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_email_drafts_updated_at ON public.email_drafts;
CREATE TRIGGER trg_email_drafts_updated_at
  BEFORE UPDATE ON public.email_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_email_foundation_updated_at();

CREATE TABLE IF NOT EXISTS public.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
  status text NOT NULL DEFAULT 'draft',
  provider text NOT NULL DEFAULT 'brevo',
  provider_message_id text,
  brevo_message_id text,
  email_address text NOT NULL,
  to_email text NOT NULL,
  from_email text,
  from_name text,
  reply_to_email text,
  subject text NOT NULL,
  html_body text,
  text_body text,
  prospect_id text,
  property_id text,
  master_owner_id text,
  template_id text,
  template_key text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  bounced_at timestamptz,
  unsubscribed_at timestamptz,
  blocked_at timestamptz,
  spam_at timestamptz,
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_messages_thread_idx
  ON public.email_messages (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_messages_email_idx
  ON public.email_messages (lower(email_address), created_at DESC);

CREATE INDEX IF NOT EXISTS email_messages_provider_message_idx
  ON public.email_messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_messages_status_idx
  ON public.email_messages (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_email_messages_updated_at ON public.email_messages;
CREATE TRIGGER trg_email_messages_updated_at
  BEFORE UPDATE ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_email_foundation_updated_at();

-- ---------------------------------------------------------------------------
-- Events, suppression, and template compatibility.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text UNIQUE,
  brevo_message_id text,
  email_address text,
  event_type text NOT NULL,
  subject text,
  template_key text,
  campaign_key text,
  raw_payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.email_events
  ADD COLUMN IF NOT EXISTS provider text DEFAULT 'brevo',
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS message_id uuid,
  ADD COLUMN IF NOT EXISTS event_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS email_events_event_key_uq
  ON public.email_events (event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_events_provider_message_idx
  ON public.email_events (provider, provider_message_id);

CREATE INDEX IF NOT EXISTS email_events_email_type_idx
  ON public.email_events (lower(email_address), event_type, created_at DESC);

DROP TRIGGER IF EXISTS trg_email_events_updated_at ON public.email_events;
CREATE TRIGGER trg_email_events_updated_at
  BEFORE UPDATE ON public.email_events
  FOR EACH ROW EXECUTE FUNCTION public.set_email_foundation_updated_at();

CREATE TABLE IF NOT EXISTS public.email_suppression (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address text UNIQUE NOT NULL,
  reason text NOT NULL,
  source text,
  raw_payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.email_suppression
  ADD COLUMN IF NOT EXISTS suppression_status text,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS email_suppression_email_active_idx
  ON public.email_suppression (lower(email_address), is_active);

DROP TRIGGER IF EXISTS trg_email_suppression_updated_at ON public.email_suppression;
CREATE TRIGGER trg_email_suppression_updated_at
  BEFORE UPDATE ON public.email_suppression
  FOR EACH ROW EXECUTE FUNCTION public.set_email_foundation_updated_at();

CREATE TABLE IF NOT EXISTS public.email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text UNIQUE NOT NULL,
  use_case text NOT NULL,
  stage_code text,
  stage_label text,
  language text DEFAULT 'English',
  subject text NOT NULL,
  html_body text NOT NULL,
  text_body text,
  variables jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- Existing outreach state is shared across channels; these additive columns
-- let email records read contactability without changing SMS send behavior.
ALTER TABLE IF EXISTS public.contact_outreach_state
  ADD COLUMN IF NOT EXISTS podio_master_owner_id text,
  ADD COLUMN IF NOT EXISTS podio_property_id text,
  ADD COLUMN IF NOT EXISTS to_email text,
  ADD COLUMN IF NOT EXISTS last_email_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS channel text;

CREATE INDEX IF NOT EXISTS contact_outreach_state_email_idx
  ON public.contact_outreach_state (lower(to_email), last_email_at DESC)
  WHERE to_email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Email records read model.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.v_email_records;

CREATE VIEW public.v_email_records
WITH (security_invoker = true)
AS
WITH latest_message AS (
  SELECT
    lower(email_address) AS email_address,
    max(COALESCE(sent_at, created_at)) FILTER (WHERE direction = 'outbound') AS last_email_sent_at,
    max(COALESCE(replied_at, sent_at, created_at)) FILTER (WHERE direction = 'inbound') AS last_email_reply_at
  FROM public.email_messages
  GROUP BY lower(email_address)
)
SELECT
  COALESCE(e.email_id::text, e.email_normalized, lower(e.email)) AS id,
  e.email_id,
  COALESCE(NULLIF(e.email_normalized, ''), lower(e.email)) AS email,
  COALESCE(NULLIF(e.email_normalized, ''), lower(e.email)) AS email_address,
  e.email_rank,
  e.email_score_final AS email_score,
  CASE
    WHEN COALESCE(e.email_score_final, 0) >= 80 OR COALESCE(e.email_rank, 99) = 1 THEN 'high'
    WHEN COALESCE(e.email_score_final, 0) >= 55 THEN 'medium'
    WHEN COALESCE(e.email_score_final, 0) > 0 THEN 'low'
    ELSE 'unknown'
  END AS email_match_confidence,
  CASE
    WHEN es.email_address IS NOT NULL AND COALESCE(es.is_active, true)
      AND lower(COALESCE(es.reason, es.suppression_status, '')) IN ('bounced', 'hard_bounce', 'invalid_email')
      THEN 'invalid'
    WHEN COALESCE(e.email_eligible, true) = false THEN 'risky'
    WHEN COALESCE(e.email_score_final, 0) >= 70 THEN 'verified'
    WHEN COALESCE(e.email_score_final, 0) >= 40 THEN 'unverified'
    ELSE 'risky'
  END AS verified_status,
  CASE
    WHEN es.email_address IS NULL OR COALESCE(es.is_active, true) = false THEN 'none'
    WHEN lower(COALESCE(es.reason, es.suppression_status, '')) LIKE '%unsubscribe%' THEN 'unsubscribed'
    WHEN lower(COALESCE(es.reason, es.suppression_status, '')) LIKE '%bounce%' THEN 'bounced'
    WHEN lower(COALESCE(es.reason, es.suppression_status, '')) IN ('spam', 'complaint') THEN 'complaint'
    WHEN lower(COALESCE(es.reason, es.suppression_status, '')) LIKE '%block%' THEN 'blocked'
    ELSE 'manual'
  END AS suppression_status,
  CASE
    WHEN es.email_address IS NULL OR COALESCE(es.is_active, true) = false THEN 'active'
    WHEN lower(COALESCE(es.reason, es.suppression_status, '')) LIKE '%unsubscribe%' THEN 'unsubscribed'
    WHEN lower(COALESCE(es.reason, es.suppression_status, '')) LIKE '%block%' THEN 'blocked'
    ELSE 'blacklisted'
  END AS brevo_contact_status,
  COALESCE(e.primary_prospect_id::text, pr.prospect_id::text) AS prospect_id,
  p.property_id::text AS property_id,
  COALESCE(e.master_owner_id::text, pr.master_owner_id::text, p.master_owner_id::text, mo.master_owner_id::text) AS master_owner_id,
  COALESCE(pr.full_name, e.owner_display_name, mo.display_name, p.owner_display_name, p.owner_name) AS prospect_name,
  COALESCE(mo.display_name, e.owner_display_name, pr.owner_display_name, p.owner_display_name, p.owner_name) AS owner_name,
  COALESCE(p.property_address_full, p.property_address) AS property_address,
  COALESCE(e.primary_market, pr.primary_market, p.market, mo.routing_market) AS market,
  COALESCE(pr.language_preference, mo.best_language, p.best_language, 'en') AS language,
  COALESCE(lm.last_email_sent_at, cos.last_email_at, cos.last_outbound_at) AS last_email_sent_at,
  COALESCE(lm.last_email_reply_at, cos.last_inbound_at) AS last_email_reply_at,
  jsonb_strip_nulls(
    jsonb_build_object(
      'email_eligible', e.email_eligible,
      'email_role', e.email_role,
      'is_best_email_for_slot', e.is_best_email_for_slot,
      'is_best_email_for_owner', e.is_best_email_for_owner,
      'outreach_channel', cos.channel,
      'outreach_suppression_reason', cos.suppression_reason,
      'suppression_source', es.source
    )
  ) AS metadata
FROM public.emails e
LEFT JOIN public.master_owners mo
  ON mo.master_owner_id::text = e.master_owner_id::text
LEFT JOIN LATERAL (
  SELECT pr.*
  FROM public.prospects pr
  WHERE (
    e.primary_prospect_id IS NOT NULL
    AND pr.prospect_id::text = e.primary_prospect_id::text
  ) OR (
    e.canonical_prospect_id IS NOT NULL
    AND pr.canonical_prospect_id::text = e.canonical_prospect_id::text
  ) OR (
    e.master_owner_id IS NOT NULL
    AND pr.master_owner_id::text = e.master_owner_id::text
  )
  ORDER BY
    CASE
      WHEN e.primary_prospect_id IS NOT NULL AND pr.prospect_id::text = e.primary_prospect_id::text THEN 1
      WHEN e.canonical_prospect_id IS NOT NULL AND pr.canonical_prospect_id::text = e.canonical_prospect_id::text THEN 2
      WHEN COALESCE(pr.is_primary_prospect, false) THEN 3
      ELSE 4
    END,
    pr.rank_position NULLS LAST,
    COALESCE(pr.updated_at, pr.created_at) DESC NULLS LAST
  LIMIT 1
) pr ON true
LEFT JOIN LATERAL (
  SELECT p.*
  FROM public.properties p
  WHERE (
    COALESCE(e.master_owner_id::text, pr.master_owner_id::text, mo.master_owner_id::text) IS NOT NULL
    AND p.master_owner_id::text = COALESCE(e.master_owner_id::text, pr.master_owner_id::text, mo.master_owner_id::text)
  )
  ORDER BY COALESCE(p.updated_at, p.created_at) DESC NULLS LAST
  LIMIT 1
) p ON true
LEFT JOIN LATERAL (
  SELECT cos.*
  FROM public.contact_outreach_state cos
  WHERE (
    cos.to_email IS NOT NULL
    AND lower(cos.to_email) = COALESCE(NULLIF(e.email_normalized, ''), lower(e.email))
  ) OR (
    cos.podio_master_owner_id IS NOT NULL
    AND cos.podio_master_owner_id::text = COALESCE(e.master_owner_id::text, pr.master_owner_id::text, mo.master_owner_id::text)
    AND lower(COALESCE(cos.channel, '')) = 'email'
  )
  ORDER BY COALESCE(cos.last_email_at, cos.last_outbound_at, cos.updated_at, cos.created_at) DESC NULLS LAST
  LIMIT 1
) cos ON true
LEFT JOIN public.email_suppression es
  ON lower(es.email_address) = COALESCE(NULLIF(e.email_normalized, ''), lower(e.email))
LEFT JOIN latest_message lm
  ON lm.email_address = COALESCE(NULLIF(e.email_normalized, ''), lower(e.email))
WHERE COALESCE(NULLIF(e.email_normalized, ''), lower(e.email)) IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS and service-role policies.
-- ---------------------------------------------------------------------------

ALTER TABLE public.email_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_senders_service_role_all ON public.email_senders;
CREATE POLICY email_senders_service_role_all
  ON public.email_senders FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_identities_service_role_all ON public.email_identities;
CREATE POLICY email_identities_service_role_all
  ON public.email_identities FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_drafts_service_role_all ON public.email_drafts;
CREATE POLICY email_drafts_service_role_all
  ON public.email_drafts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_messages_service_role_all ON public.email_messages;
CREATE POLICY email_messages_service_role_all
  ON public.email_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_events_service_role_all ON public.email_events;
CREATE POLICY email_events_service_role_all
  ON public.email_events FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_suppression_service_role_all ON public.email_suppression;
CREATE POLICY email_suppression_service_role_all
  ON public.email_suppression FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_templates_service_role_all ON public.email_templates;
CREATE POLICY email_templates_service_role_all
  ON public.email_templates FOR ALL TO service_role USING (true) WITH CHECK (true);
