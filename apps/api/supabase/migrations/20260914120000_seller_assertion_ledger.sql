-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL-4: the seller assertion ledger, its processing state, and review.
--
-- WHY A NEW TABLE AT ALL.
--   The reconnaissance looked hard for somewhere existing to put this.
--   workflow_extracted_facts looks like an assertion ledger and is not one: it
--   is UNIQUE (enrollment_id, fact_key), so it OVERWRITES -- one row per fact
--   key, no history -- and it is scoped to workflow enrollments rather than to
--   the acquisition opportunity. Storing seller price history there would
--   destroy exactly what this phase exists to keep.
--
--   "225k, then 205k, then 190k if you close Friday" is three statements. All
--   three are historical truth. One of them is the current pricing assertion.
--   Nothing in this repository could hold that before now.
--
-- WHAT IS DELIBERATELY NOT HERE.
--   No intent enum: inbound-intent-ontology.js owns that vocabulary.
--   No stage column: the acquisition stage lives where it already lives, and
--   this ledger records evidence, not lifecycle.
--   No authority column: EMAIL-4 grants none, and a column would invite one.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the assertion ledger ─────────────────────────────────────────────────
--
-- APPEND-ONLY BY INTENT. Rows are never updated in place except to mark them
-- superseded. A seller's earlier statement remains readable forever, because
-- "what did they say before they said this?" is a question an operator asks in
-- every real negotiation.

CREATE TABLE IF NOT EXISTS public.seller_assertions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── provenance: which communication produced this ──────────────────────
  -- Channel-neutral by construction. An SMS and an email assertion differ here
  -- only in `source_channel`; nothing else about the row knows the difference.
  source_channel        text        NOT NULL,
  source_communication_id text,
  source_inbound_message_id uuid,
  source_event_key      text,

  -- ── the conversation this is about ─────────────────────────────────────
  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,
  property_id           text,
  contact_id            text,
  thread_key            text,

  -- ── the assertion itself ───────────────────────────────────────────────
  assertion_type        text        NOT NULL,
  fact_family           text        NOT NULL,
  basis                 text        NOT NULL,
  confidence            numeric     NOT NULL,
  -- Normalized value and what the seller actually typed, side by side. When a
  -- normalization is wrong -- and over enough sellers it will be -- raw_value
  -- is what lets somebody see that it was.
  value                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  raw_value             text,
  -- The exact words. An assertion that cannot be traced to them cannot be
  -- reviewed, disputed, or explained to an operator who asks where it says that.
  evidence_text         text        NOT NULL,
  evidence_offset       integer,
  -- Conditions travel WITH the assertion. "185 if you close before the 20th" is
  -- one fact, and a separate conditions table would let the number be read
  -- without them.
  conditions            jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- ── how it was produced, in enough detail to reproduce it ──────────────
  extractor             text        NOT NULL,
  extractor_version     text        NOT NULL,
  model_provider        text,
  model_name            text,
  prompt_version        text,
  schema_version        text,
  context_hash          text,

  -- ── what the policy decided ────────────────────────────────────────────
  reconciliation_outcome text,
  reconciliation_reason  text,
  reconciliation_policy_version text,
  canonical_target       text,

  -- ── lifecycle ──────────────────────────────────────────────────────────
  is_current            boolean     NOT NULL DEFAULT false,
  supersedes_assertion_id uuid REFERENCES public.seller_assertions(id) ON DELETE SET NULL,
  superseded_at         timestamptz,
  superseded_by_assertion_id uuid REFERENCES public.seller_assertions(id) ON DELETE SET NULL,

  needs_review          boolean     NOT NULL DEFAULT false,
  review_reason         text,
  refusal_reason        text,

  asserted_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_basis_valid') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_basis_valid
      CHECK (basis IN ('explicit', 'strongly_implied', 'inferred'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_family_valid') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_family_valid
      CHECK (fact_family IN ('temporal', 'mutable_state', 'preference', 'claim', 'historical', 'interpretive'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_confidence_range') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_confidence_range
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_outcome_valid') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_outcome_valid
      CHECK (reconciliation_outcome IS NULL
             OR reconciliation_outcome IN ('accept', 'soft', 'review', 'refuse'));
  END IF;

  -- Channel is an attribute of the communication, exactly as EMAIL-1 and
  -- EMAIL-3 established. Naming the allowed values here keeps a fifth channel
  -- from arriving silently as a typo.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_channel_valid') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_channel_valid
      CHECK (source_channel IN ('sms', 'email', 'voice', 'operator'));
  END IF;

  -- Only an ACCEPTED assertion may be current. A soft reading, a refusal or
  -- something awaiting review must never be mistaken for canonical truth.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_current_requires_accept') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_current_requires_accept
      CHECK (is_current = false OR reconciliation_outcome = 'accept');
  END IF;

  -- A superseded row cannot also be the current one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_superseded_not_current') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_superseded_not_current
      CHECK (superseded_at IS NULL OR is_current = false);
  END IF;

  -- An assertion with no anchor can never be resolved back to a conversation,
  -- and a row that can never be resolved is a bug that looks like data.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_assertions_has_anchor') THEN
    ALTER TABLE public.seller_assertions ADD CONSTRAINT seller_assertions_has_anchor
      CHECK (opportunity_id IS NOT NULL OR master_owner_id IS NOT NULL OR thread_key IS NOT NULL);
  END IF;
END $$;

-- AT MOST ONE CURRENT ASSERTION PER (conversation, type). This is the
-- structural half of the reconciliation policy: the policy decides what may
-- become current, and this index makes "two current prices" impossible even if
-- two workers decide simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS seller_assertions_current_by_opportunity_uq
  ON public.seller_assertions (opportunity_id, assertion_type)
  WHERE is_current AND opportunity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS seller_assertions_current_by_owner_property_uq
  ON public.seller_assertions (master_owner_id, property_id, assertion_type)
  WHERE is_current AND opportunity_id IS NULL AND master_owner_id IS NOT NULL;

-- The history read: "what did this seller say about price, in order?"
CREATE INDEX IF NOT EXISTS seller_assertions_history_idx
  ON public.seller_assertions (opportunity_id, assertion_type, asserted_at DESC);

CREATE INDEX IF NOT EXISTS seller_assertions_review_idx
  ON public.seller_assertions (created_at DESC) WHERE needs_review;

CREATE INDEX IF NOT EXISTS seller_assertions_source_idx
  ON public.seller_assertions (source_event_key) WHERE source_event_key IS NOT NULL;

-- Re-running one communication through a newer extractor must not duplicate its
-- assertions. Scoped by extractor_version so a DELIBERATE reprocess with new
-- intelligence produces a new row rather than being swallowed as a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS seller_assertions_dedupe_uq
  ON public.seller_assertions (source_event_key, assertion_type, evidence_text, extractor_version)
  WHERE source_event_key IS NOT NULL;

COMMENT ON TABLE public.seller_assertions IS
  'Layer B: structured statements extracted from seller communication. Append-only. An earlier statement is never destroyed -- "what did they say before this?" is a question asked in every real negotiation.';
COMMENT ON COLUMN public.seller_assertions.basis IS
  'explicit / strongly_implied / inferred. A confident inference and a confident quotation are not interchangeable, and an operator must never see an inference rendered as something the seller said.';
COMMENT ON COLUMN public.seller_assertions.conditions IS
  'Travels with the assertion because "185 if you close before the 20th" is ONE fact. A separate table would let the number be read without them.';
COMMENT ON COLUMN public.seller_assertions.source_channel IS
  'Provenance only. Channel is an attribute of a communication, never of the seller relationship.';

-- ── 2. processing state ─────────────────────────────────────────────────────
--
-- Modelled on inbound_processing_ledger, which already solved this for SMS:
-- idempotency key, attempt counting, terminal dispositions, and -- most
-- importantly -- its PII stance. It never stores raw seller text, only a digest
-- and a length, which is enough to correlate retries and detect a divergent
-- payload. That stance is adopted wholesale rather than re-litigated.

CREATE TABLE IF NOT EXISTS public.seller_intelligence_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable across retries. Two workers handed the same communication must not
  -- both extract from it.
  idempotency_key       text        NOT NULL,

  source_channel        text        NOT NULL,
  source_communication_id text,
  source_event_key      text,
  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,
  property_id           text,

  status                text        NOT NULL DEFAULT 'pending',
  attempt_count         integer     NOT NULL DEFAULT 0,
  -- Never the message text. A digest correlates retries and detects a payload
  -- that changed underneath us; the text itself lives in one place already.
  input_sha256          text,
  input_length          integer     NOT NULL DEFAULT 0,
  context_hash          text,

  extractor_version     text,
  model_provider        text,
  model_name            text,
  prompt_version        text,
  schema_version        text,

  assertions_created    integer     NOT NULL DEFAULT 0,
  assertions_accepted   integer     NOT NULL DEFAULT 0,
  assertions_review     integer     NOT NULL DEFAULT 0,
  assertions_refused    integer     NOT NULL DEFAULT 0,

  input_tokens          integer,
  output_tokens         integer,
  latency_ms            integer,

  failure_reason        text,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_intelligence_runs_status_valid') THEN
    ALTER TABLE public.seller_intelligence_runs ADD CONSTRAINT seller_intelligence_runs_status_valid
      CHECK (status IN ('pending', 'processing', 'processed', 'held', 'failed', 'needs_review'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_intelligence_runs_channel_valid') THEN
    ALTER TABLE public.seller_intelligence_runs ADD CONSTRAINT seller_intelligence_runs_channel_valid
      CHECK (source_channel IN ('sms', 'email', 'voice', 'operator'));
  END IF;

  -- A completed run that never says WHY is the silent drop this table exists to
  -- make impossible.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_intelligence_runs_failed_has_reason') THEN
    ALTER TABLE public.seller_intelligence_runs ADD CONSTRAINT seller_intelligence_runs_failed_has_reason
      CHECK (status <> 'failed' OR failure_reason IS NOT NULL);
  END IF;
END $$;

-- Idempotency is an INDEX, not a read-then-write two workers can interleave
-- between.
CREATE UNIQUE INDEX IF NOT EXISTS seller_intelligence_runs_idempotency_uq
  ON public.seller_intelligence_runs (idempotency_key);

CREATE INDEX IF NOT EXISTS seller_intelligence_runs_pending_idx
  ON public.seller_intelligence_runs (created_at)
  WHERE status IN ('pending', 'failed');

COMMENT ON COLUMN public.seller_intelligence_runs.input_sha256 IS
  'A digest, never the seller text. Enough to correlate retries and detect a divergent payload, following inbound_processing_ledger''s PII stance.';

-- ── 3. review ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.seller_intelligence_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid REFERENCES public.seller_intelligence_runs(id) ON DELETE SET NULL,
  assertion_id          uuid REFERENCES public.seller_assertions(id) ON DELETE CASCADE,

  opportunity_id        uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  master_owner_id       text,
  property_id           text,

  review_reason         text        NOT NULL,
  severity              text        NOT NULL DEFAULT 'normal',
  conflict              jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status                text        NOT NULL DEFAULT 'open',
  resolved_at           timestamptz,
  resolved_by           text,
  resolution            text,
  resolution_note       text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_intelligence_reviews_status_valid') THEN
    ALTER TABLE public.seller_intelligence_reviews ADD CONSTRAINT seller_intelligence_reviews_status_valid
      CHECK (status IN ('open', 'resolved', 'dismissed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_intelligence_reviews_severity_valid') THEN
    ALTER TABLE public.seller_intelligence_reviews ADD CONSTRAINT seller_intelligence_reviews_severity_valid
      CHECK (severity IN ('normal', 'material', 'legal'));
  END IF;

  -- A resolved review with no resolution is a review nobody actually made.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_intelligence_reviews_resolved_has_resolution') THEN
    ALTER TABLE public.seller_intelligence_reviews ADD CONSTRAINT seller_intelligence_reviews_resolved_has_resolution
      CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS seller_intelligence_reviews_open_idx
  ON public.seller_intelligence_reviews (created_at DESC) WHERE status = 'open';

-- One open review per assertion. A reprocess must not pile up duplicates in
-- front of the same operator.
CREATE UNIQUE INDEX IF NOT EXISTS seller_intelligence_reviews_open_assertion_uq
  ON public.seller_intelligence_reviews (assertion_id)
  WHERE status = 'open' AND assertion_id IS NOT NULL;

-- ── 4. security ─────────────────────────────────────────────────────────────
-- Seller communication content. RLS off would put every extracted seller
-- statement behind one publishable key via PostgREST.

ALTER TABLE public.seller_assertions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_intelligence_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_intelligence_reviews  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'seller_assertions', 'seller_intelligence_runs', 'seller_intelligence_reviews'
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
