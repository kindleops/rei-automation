-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL-3: inbound replies and canonical cross-channel threading.
--
-- THE CONVERSATION ALREADY EXISTS, AND IT IS NOT NEW HERE.
--   acquisition_opportunities is the canonical seller relationship: 751 rows,
--   keyed on (master_owner_id, primary_property_id, primary_thread_key), and it
--   already carries related_thread_keys precisely so more than one thread can
--   belong to one relationship. seller_logical_communications already has an
--   opportunity_id FK into it.
--
--   So EMAIL-3 does NOT invent a conversation model. Channel is an attribute of
--   a COMMUNICATION (EMAIL-1 made it part of communication identity, correctly);
--   the OPPORTUNITY is the seller relationship, and it stays channel-neutral. A
--   seller who starts on SMS and continues by email has one relationship and two
--   channels, not two relationships.
--
-- WHAT THIS MIGRATION ADDS
--   1. email_reply_aliases     the opaque address a seller replies to
--   2. email_inbound_events    the durable provider receipt, before any domain
--                              mutation
--   3. email_inbound_messages  the canonical inbound communication
--   4. email_inbound_attachments
--
-- WHY INBOUND IS A SEPARATE LEDGER FROM email_events
--   email_events is the OUTBOUND provider event ledger: it answers "what
--   happened to a message we sent". An inbound parse callback is a different
--   thing with a different shape -- it carries a body, headers, attachments and
--   an envelope, and it creates a message rather than describing one. Forcing
--   both through one table would make every column nullable and every query
--   ambiguous about which kind of row it was reading.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. reply aliases ────────────────────────────────────────────────────────
--
-- ONE ALIAS PER CONVERSATION, not per message. That is what makes thread
-- fragmentation impossible by construction: a retry, a template rotation, a
-- second touch and a follow-up weeks later all carry the same Reply-To.
--
-- The token is 128 bits of randomness and carries NO information. It is a bearer
-- credential -- presenting it attributes a message to a conversation -- so it
-- must be unguessable, but it authenticates nothing about who sent the mail.

CREATE TABLE IF NOT EXISTS public.email_reply_aliases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `r1.<32 hex>`. The version prefix lets a future format resolve alongside
  -- this one, so a format change never strands mail already in seller inboxes.
  token                 text        NOT NULL,
  token_version         text        NOT NULL DEFAULT 'r1',
  reply_domain          text        NOT NULL,

  -- The canonical conversation. opportunity_id is the strong link; the owner and
  -- property are carried alongside it because an alias may legitimately be
  -- minted before an opportunity exists, and losing the anchors would make it
  -- unresolvable later.
  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,
  property_id           text,
  prospect_id           text,
  thread_key            text,
  -- The address we expect to hear back from. Evidence, never a gate: sellers
  -- reply from phones, aliases and assistants' mailboxes all the time.
  expected_from_email   text,

  -- Lifecycle, so revocation is a first-class fact rather than a deletion.
  is_active             boolean     NOT NULL DEFAULT true,
  revoked_at            timestamptz,
  revoked_reason        text,
  last_inbound_at       timestamptz,
  inbound_count         integer     NOT NULL DEFAULT 0,
  outbound_count        integer     NOT NULL DEFAULT 0,

  policy_version        text        NOT NULL DEFAULT 'reply_alias_v1',
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_reply_aliases_token_shape') THEN
    ALTER TABLE public.email_reply_aliases
      ADD CONSTRAINT email_reply_aliases_token_shape
      CHECK (token ~ '^r[0-9]+\.[0-9a-f]{32}$');
  END IF;

  -- An alias that points at no conversation at all can never be resolved, and a
  -- row that can never be resolved is a bug that looks like data.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_reply_aliases_has_an_anchor') THEN
    ALTER TABLE public.email_reply_aliases
      ADD CONSTRAINT email_reply_aliases_has_an_anchor
      CHECK (opportunity_id IS NOT NULL OR master_owner_id IS NOT NULL OR thread_key IS NOT NULL);
  END IF;
END $$;

-- Total, unconditional. Two conversations sharing a token would make inbound
-- attribution a coin flip.
CREATE UNIQUE INDEX IF NOT EXISTS email_reply_aliases_token_uq
  ON public.email_reply_aliases (token);

-- The reuse lookup: "does this conversation already have an alias?" Partial on
-- is_active so a revoked alias never gets handed out again, while its history
-- stays queryable.
CREATE UNIQUE INDEX IF NOT EXISTS email_reply_aliases_opportunity_active_uq
  ON public.email_reply_aliases (opportunity_id)
  WHERE is_active AND opportunity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS email_reply_aliases_owner_property_active_uq
  ON public.email_reply_aliases (master_owner_id, property_id)
  WHERE is_active AND opportunity_id IS NULL AND master_owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_reply_aliases_thread_idx
  ON public.email_reply_aliases (thread_key) WHERE thread_key IS NOT NULL;

COMMENT ON TABLE public.email_reply_aliases IS
  'Opaque reply addresses. One ACTIVE alias per conversation, so every outbound message in a conversation -- including retries and later touches -- carries the same Reply-To and a seller reply cannot fragment the thread.';
COMMENT ON COLUMN public.email_reply_aliases.token IS
  'A bearer credential: presenting it attributes a message to a conversation. It carries no information and authenticates nothing about who sent the mail.';

-- ── 2. the durable inbound event ────────────────────────────────────────────
--
-- Written BEFORE any domain mutation. Everything an operator might ask later --
-- did Brevo call us, was it authentic, was it a duplicate, which conversation
-- did it resolve to, why did resolution fail -- is answerable from this row.

CREATE TABLE IF NOT EXISTS public.email_inbound_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The idempotency spine. Prefers a provider id; falls back to a deterministic
  -- digest of stable message properties. NEVER a random value: a random key
  -- makes every redelivery look new, which is the one thing this column exists
  -- to prevent.
  event_key             text        NOT NULL,
  provider              text        NOT NULL DEFAULT 'brevo',
  provider_event_id     text,
  -- RFC 5322 Message-ID of the inbound message itself.
  provider_message_id   text,
  rfc_message_id        text,
  in_reply_to           text,
  references_header     text,

  trust_class           text        NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,

  envelope_from         text,
  envelope_to           text,
  from_email            text,
  from_name             text,
  subject               text,

  -- Which alias the seller replied to, and its fingerprint for log correlation.
  reply_token           text,
  reply_token_source    text,
  reply_alias_id        uuid REFERENCES public.email_reply_aliases(id) ON DELETE SET NULL,

  -- Resolution outcome.
  resolution_status     text        NOT NULL DEFAULT 'pending',
  resolution_tier       text,
  resolution_reason     text,
  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,
  property_id           text,
  thread_key            text,
  inbound_message_id    uuid,

  -- Transport-level classification only. NOT seller intent.
  message_class         text        NOT NULL DEFAULT 'human_reply',
  auto_reply_reason     text,

  attachment_count      integer     NOT NULL DEFAULT 0,
  processing_status     text        NOT NULL DEFAULT 'received',
  processing_reason     text,
  -- The provider payload, kept whole. Reprocessing a stored event must not
  -- depend on the provider still being willing to send it again.
  raw_payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_events_resolution_valid') THEN
    ALTER TABLE public.email_inbound_events
      ADD CONSTRAINT email_inbound_events_resolution_valid
      CHECK (resolution_status IN (
        'pending',       -- received, not yet resolved
        'resolved',      -- attached to exactly one conversation
        'unmatched',     -- authentic, but nothing to attach it to
        'ambiguous',     -- more than one legitimate candidate; refused on purpose
        'rejected'       -- refused before resolution (untrusted, malformed)
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_events_processing_valid') THEN
    ALTER TABLE public.email_inbound_events
      ADD CONSTRAINT email_inbound_events_processing_valid
      CHECK (processing_status IN (
        'received',      -- stored, nothing done yet
        'processed',     -- a canonical message exists
        'duplicate',     -- a prior event already carried this key
        'held',          -- ingestion is paused; the event is KEPT, not dropped
        'quarantined',   -- suspicious or malformed; kept for review
        'rejected'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_events_class_valid') THEN
    ALTER TABLE public.email_inbound_events
      ADD CONSTRAINT email_inbound_events_class_valid
      CHECK (message_class IN (
        'human_reply',        -- looks like a person wrote it
        'auto_reply',         -- out-of-office / vacation responder
        'delivery_status',    -- DSN / mailer-daemon
        'system_or_list',     -- list mail, no-reply, automated notification
        'malformed'
      ));
  END IF;
END $$;

-- The idempotency guarantee. A repeated provider callback collides here rather
-- than being caught by a read-then-write two workers can interleave.
CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_events_event_key_uq
  ON public.email_inbound_events (event_key);

CREATE INDEX IF NOT EXISTS email_inbound_events_opportunity_idx
  ON public.email_inbound_events (opportunity_id, received_at DESC)
  WHERE opportunity_id IS NOT NULL;

-- "What arrived that we could not attach?" must be one query. These are the rows
-- an operator reviews, and the early warning that resolution has broken.
CREATE INDEX IF NOT EXISTS email_inbound_events_needs_review_idx
  ON public.email_inbound_events (received_at DESC)
  WHERE resolution_status IN ('unmatched', 'ambiguous');

CREATE INDEX IF NOT EXISTS email_inbound_events_rfc_message_idx
  ON public.email_inbound_events (rfc_message_id) WHERE rfc_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_inbound_events_from_idx
  ON public.email_inbound_events (from_email, received_at DESC);

COMMENT ON TABLE public.email_inbound_events IS
  'Durable receipt for every inbound provider callback, written before any domain mutation. An event is a CLAIM to be recorded, not an instruction to execute.';

-- ── 3. the canonical inbound message ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_inbound_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_event_id      uuid        NOT NULL REFERENCES public.email_inbound_events(id) ON DELETE RESTRICT,

  direction             text        NOT NULL DEFAULT 'inbound',
  channel               text        NOT NULL DEFAULT 'email',
  provider              text        NOT NULL DEFAULT 'brevo',

  -- The canonical conversation this belongs to.
  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,
  property_id           text,
  prospect_id           text,
  thread_key            text,
  reply_alias_id        uuid REFERENCES public.email_reply_aliases(id) ON DELETE SET NULL,
  -- The outbound communication this is a reply to, when we can say.
  in_reply_to_communication_id uuid REFERENCES public.seller_logical_communications(id) ON DELETE SET NULL,

  from_email            text        NOT NULL,
  from_name             text,
  to_email              text,
  subject               text,
  rfc_message_id        text,
  in_reply_to           text,
  references_header     text,

  -- Three views of the body, kept separately. See body-normalization.js: the
  -- newest reply is what a human wrote THIS time, the normalized body is the
  -- whole readable message, and the raw is what actually arrived. Discarding any
  -- of them to save space would throw away evidence a later phase may need.
  body_text_raw         text,
  body_text_normalized  text,
  body_newest_reply     text,
  body_html_raw         text,
  body_html_sanitized   text,
  -- Seller-controlled markup is untrusted until proven otherwise, and the flag
  -- travels with the row so a renderer cannot forget.
  html_is_sanitized     boolean     NOT NULL DEFAULT false,

  message_class         text        NOT NULL DEFAULT 'human_reply',
  received_at           timestamptz NOT NULL,
  attachment_count      integer     NOT NULL DEFAULT 0,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_messages_direction_valid') THEN
    ALTER TABLE public.email_inbound_messages
      ADD CONSTRAINT email_inbound_messages_direction_valid
      CHECK (direction = 'inbound' AND channel = 'email');
  END IF;
END $$;

-- ONE canonical message per provider event. This is where "a provider retry must
-- not create a second seller message" is actually enforced; the event key stops
-- most duplicates, and this stops the rest.
CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_messages_event_uq
  ON public.email_inbound_messages (inbound_event_id);

CREATE INDEX IF NOT EXISTS email_inbound_messages_opportunity_idx
  ON public.email_inbound_messages (opportunity_id, received_at DESC)
  WHERE opportunity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_inbound_messages_thread_idx
  ON public.email_inbound_messages (thread_key, received_at DESC)
  WHERE thread_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_inbound_messages_rfc_idx
  ON public.email_inbound_messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;

COMMENT ON COLUMN public.email_inbound_messages.body_html_raw IS
  'Untrusted seller-controlled markup. NEVER render this. body_html_sanitized is the only form that may reach a browser, and html_is_sanitized says whether that has happened.';

-- ── 4. attachments ──────────────────────────────────────────────────────────
--
-- Seller attachments will eventually include probate documents, payoff
-- statements and condition photos. They are ingested server-side, digested, and
-- QUARANTINED by default: this repository has no malware scanning, and pretending
-- otherwise would be the most expensive possible lie to tell about a file.

CREATE TABLE IF NOT EXISTS public.email_inbound_attachments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_message_id    uuid        NOT NULL REFERENCES public.email_inbound_messages(id) ON DELETE CASCADE,
  inbound_event_id      uuid        NOT NULL REFERENCES public.email_inbound_events(id) ON DELETE RESTRICT,

  -- SHA-256 of the bytes. The idempotency key for re-ingestion, and the only
  -- durable identity a file has: a provider url expires and a filename lies.
  content_sha256        text        NOT NULL,
  byte_size             bigint      NOT NULL,
  -- What the provider claimed, and what we are willing to call it. They differ
  -- more often than is comfortable.
  provider_content_type text,
  content_type          text        NOT NULL,
  provider_filename     text,
  filename              text        NOT NULL,

  storage_provider      text,
  storage_key           text,
  storage_status        text        NOT NULL DEFAULT 'pending',
  scan_status           text        NOT NULL DEFAULT 'unscanned',
  quarantine_reason     text,

  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_attachments_digest_shape') THEN
    ALTER TABLE public.email_inbound_attachments
      ADD CONSTRAINT email_inbound_attachments_digest_shape
      CHECK (content_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_attachments_scan_valid') THEN
    ALTER TABLE public.email_inbound_attachments
      ADD CONSTRAINT email_inbound_attachments_scan_valid
      CHECK (scan_status IN ('unscanned', 'quarantined', 'clean', 'infected', 'skipped'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inbound_attachments_storage_valid') THEN
    ALTER TABLE public.email_inbound_attachments
      ADD CONSTRAINT email_inbound_attachments_storage_valid
      CHECK (storage_status IN ('pending', 'stored', 'failed', 'skipped', 'expired'));
  END IF;
END $$;

-- The same file arriving twice on one message is one attachment. Re-delivery of
-- the whole callback must not duplicate its files.
CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_attachments_message_digest_uq
  ON public.email_inbound_attachments (inbound_message_id, content_sha256);

CREATE INDEX IF NOT EXISTS email_inbound_attachments_digest_idx
  ON public.email_inbound_attachments (content_sha256);

CREATE INDEX IF NOT EXISTS email_inbound_attachments_quarantined_idx
  ON public.email_inbound_attachments (created_at DESC)
  WHERE scan_status IN ('unscanned', 'quarantined', 'infected');

COMMENT ON COLUMN public.email_inbound_attachments.scan_status IS
  'No malware scanning exists in this repository. Files land unscanned and are treated as quarantined: never auto-rendered, never executed, never served inline.';

-- ── 5. RLS: service_role only, like every other seller-communication table ───

ALTER TABLE public.email_reply_aliases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_inbound_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_inbound_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_inbound_attachments  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'email_reply_aliases', 'email_inbound_events',
    'email_inbound_messages', 'email_inbound_attachments'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_service_role_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        t || '_service_role_all', t
      );
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

COMMIT;
