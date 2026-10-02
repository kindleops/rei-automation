-- ============================================================================
-- Seller portal — identity, access grants, sessions, shared documents, seller
-- messages, and seller-scheduled calls.
-- ============================================================================
-- The Prominent Cash Offer public site gives sellers an authenticated account
-- in which they follow their own property through REI Automation's canonical
-- records. This migration adds ONLY what does not exist anywhere yet:
--
--   * a seller identity (sellers have none — see the audit in
--     docs/integrations/seller-portal.md) and the grants that bind it to
--     canonical acquisition_opportunities rows;
--   * passwordless sign-in codes and server-side sessions;
--   * an explicit operator decision to share a document with a seller
--     (email_attachments has no "visible to seller" concept, and absence of a
--     share is absence of access);
--   * seller-portal messages (a seller-visible conversation that operations
--     see through the canonical inbox flags; the SMS ledger is NOT reused);
--   * throttling and an audit trail for seller sign-in.
--
-- Seller-scheduled calls are NOT stored here: they are appointments in the
-- shared scheduling core (20261003120000_scheduling_core.sql).
--
-- WHY NOT SUPABASE AUTH: in this project the `authenticated` role has blanket
-- read on acquisition_opportunities, message_events, send_queue and others.
-- A seller JWT would read every other seller's deal through PostgREST. Seller
-- identity therefore lives in service-role-only tables and sessions are opaque
-- server tokens. Nothing below is reachable by anon or authenticated.
--
-- No seller, property, opportunity, offer, or closing model is duplicated:
-- every portal read is a projection of the canonical tables.

BEGIN;

-- ---------------------------------------------------------------------------
-- Seller identity and access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_portal_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  display_name     text,
  phone_e164       text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at  timestamptz,
  CONSTRAINT seller_portal_identities_email_lower CHECK (email = lower(email)),
  CONSTRAINT seller_portal_identities_email_unique UNIQUE (email)
);

-- The only thing that makes an opportunity visible to a seller.
CREATE TABLE IF NOT EXISTS public.seller_portal_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id      uuid NOT NULL REFERENCES public.seller_portal_identities(id) ON DELETE CASCADE,
  opportunity_id   uuid NOT NULL REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE,
  granted_via      text NOT NULL CHECK (granted_via IN ('intake_email_match', 'operator')),
  source_submission_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  CONSTRAINT seller_portal_grants_unique UNIQUE (identity_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_grants_identity
  ON public.seller_portal_grants (identity_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.seller_portal_login_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   uuid NOT NULL REFERENCES public.seller_portal_identities(id) ON DELETE CASCADE,
  code_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_login_codes_identity
  ON public.seller_portal_login_codes (identity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.seller_portal_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   uuid NOT NULL REFERENCES public.seller_portal_identities(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_reason text,
  last_seen_at  timestamptz,
  ip_hash       text
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_sessions_identity
  ON public.seller_portal_sessions (identity_id, created_at DESC) WHERE revoked_at IS NULL;

-- Sliding-window throttle for sign-in, keyed by hashed IP or hashed address.
-- Rows older than a day are pruned by the scheduling/maintenance tick.
CREATE TABLE IF NOT EXISTS public.seller_portal_throttle (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL,
  key_hash    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_throttle_key
  ON public.seller_portal_throttle (bucket, key_hash, created_at DESC);

-- Security-relevant events only: no codes, tokens, or message bodies.
CREATE TABLE IF NOT EXISTS public.seller_portal_audit_events (
  id           bigserial PRIMARY KEY,
  identity_id  uuid REFERENCES public.seller_portal_identities(id) ON DELETE SET NULL,
  event        text NOT NULL,
  ip_hash      text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_audit_identity
  ON public.seller_portal_audit_events (identity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Documents an operator has chosen to share with the seller
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_portal_document_shares (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid NOT NULL REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE,
  attachment_id    uuid NOT NULL REFERENCES public.email_attachments(id) ON DELETE CASCADE,
  label            text NOT NULL,
  document_kind    text NOT NULL CHECK (document_kind IN ('offer', 'purchase_agreement', 'disclosure', 'title', 'closing_statement', 'other')),
  seller_status    text NOT NULL DEFAULT 'ready' CHECK (seller_status IN ('ready', 'needs_signature', 'signed', 'received', 'superseded')),
  shared_by        text NOT NULL,
  shared_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       text,
  CONSTRAINT seller_portal_document_shares_unique UNIQUE (opportunity_id, attachment_id)
);

-- ---------------------------------------------------------------------------
-- The conversation about this property
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_portal_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid NOT NULL REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE,
  author_kind      text NOT NULL CHECK (author_kind IN ('seller', 'operator', 'system')),
  author_identity_id uuid REFERENCES public.seller_portal_identities(id) ON DELETE SET NULL,
  author_operator  text,
  body             text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  operator_read_at timestamptz,
  seller_read_at   timestamptz,
  CONSTRAINT seller_portal_messages_idempotency UNIQUE (opportunity_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_messages_opportunity
  ON public.seller_portal_messages (opportunity_id, created_at);

-- ---------------------------------------------------------------------------
-- Seller notifications: one row per lifecycle event per seller, so a retried
-- or duplicated canonical write never emails the seller twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_portal_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key      text NOT NULL UNIQUE,
  opportunity_id  uuid NOT NULL REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE,
  identity_id     uuid REFERENCES public.seller_portal_identities(id) ON DELETE SET NULL,
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_seller_portal_notifications_opportunity
  ON public.seller_portal_notifications (opportunity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Service role only. No policies: RLS on with zero policies denies anon and
-- authenticated entirely; the grants are revoked as well for defence in depth.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'seller_portal_identities', 'seller_portal_grants',
    'seller_portal_login_codes', 'seller_portal_sessions',
    'seller_portal_throttle', 'seller_portal_audit_events',
    'seller_portal_document_shares', 'seller_portal_messages', 'seller_portal_notifications'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON SEQUENCE public.seller_portal_throttle_id_seq FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.seller_portal_audit_events_id_seq FROM anon, authenticated;

COMMIT;
