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
--   * calendar_manual_events, which Calendar Nexus already reads and whose
--     migration (20260621130000_calendar_nexus.sql) was never applied. A
--     seller-scheduled call is an event_type 'manual_call' row on it.
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
-- Calendar (canonical definition from 20260621130000_calendar_nexus.sql,
-- applied here because production never received it).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.calendar_manual_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        text NOT NULL DEFAULT 'manual_task',
  title             text NOT NULL,
  description       text,
  start_at          timestamptz NOT NULL,
  end_at            timestamptz,
  all_day           boolean NOT NULL DEFAULT false,
  timezone          text NOT NULL DEFAULT 'UTC',
  status            text NOT NULL DEFAULT 'scheduled',
  priority          text NOT NULL DEFAULT 'normal',
  master_owner_id   text,
  property_id       text,
  opportunity_id    text,
  thread_key        text,
  recurrence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  reminder_minutes  integer,
  assigned_operator text,
  created_by        text,
  updated_by        text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_manual_events_status_check CHECK (
    status IN ('scheduled', 'completed', 'cancelled')
  )
);
CREATE INDEX IF NOT EXISTS idx_calendar_manual_events_start
  ON public.calendar_manual_events (start_at, status);
CREATE INDEX IF NOT EXISTS idx_calendar_manual_events_opportunity
  ON public.calendar_manual_events (opportunity_id, start_at)
  WHERE opportunity_id IS NOT NULL;

-- A seller-booked call carries its reason and source. Additive, nullable.
ALTER TABLE public.calendar_manual_events
  ADD COLUMN IF NOT EXISTS call_reason   text,
  ADD COLUMN IF NOT EXISTS created_source text,
  ADD COLUMN IF NOT EXISTS contact        jsonb NOT NULL DEFAULT '{}'::jsonb;

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
  last_seen_at  timestamptz
);

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
-- Service role only. No policies: RLS on with zero policies denies anon and
-- authenticated entirely; the grants are revoked as well for defence in depth.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'calendar_manual_events', 'seller_portal_identities', 'seller_portal_grants',
    'seller_portal_login_codes', 'seller_portal_sessions',
    'seller_portal_document_shares', 'seller_portal_messages'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

COMMIT;
