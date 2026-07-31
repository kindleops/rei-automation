-- Offerr Evaluation Spine — intake requests, versioned immutable evaluations,
-- and an append-only lifecycle ledger for the private direct-to-seller channel.
--
-- STATUS: APPLIED TO PRODUCTION 2026-07-31 under explicit operator
-- authorization (project real-estate-automation / lcppdrmrdfblstpcbgpf,
-- PostgreSQL 17.6), in a single transaction, with the feature flag left
-- 'false'. Verified 36/36 production schema checks; all three Offerr tables
-- contain zero rows. See docs/offerr/offerr-staging-verification-report.md §14.
--
-- The PROPOSED_ prefix is RETAINED deliberately: it keeps this file outside the
-- `supabase db push` path (same convention as PROPOSED_20260626000000_
-- closing_desk_foundation.sql), and production's migration history has no row
-- for it — operator-applied files are not tracked there. Do NOT rename it;
-- renaming would make `db push` attempt to re-apply an already-applied
-- migration. ADDITIVE ONLY: no existing table, view, RPC, or policy is altered
-- or dropped. Re-running is safe (IF NOT EXISTS / ON CONFLICT throughout).
--
-- Grain and ownership:
--   * offerr_evaluation_requests  — one row per Offerr intake submission.
--     UNIQUE(idempotency_key) is the idempotency authority (same pattern as
--     acquisition_opportunity_history.idempotency_key).
--   * offerr_evaluations          — one immutable snapshot per evaluation
--     version of a request. Never UPDATEd; re-evaluation inserts version+1.
--     This is intentionally separate from property_acquisition_scores, which
--     is UNIQUE(property_id) engine output with no history, and from
--     property_cash_offer_snapshots, which is a Podio-owned single-number
--     offer mirror. Offerr ranges are preliminary and non-binding.
--   * offerr_evaluation_events    — append-only audit ledger (same family as
--     acquisition_events); dedupe_key is unique when present.
--
-- Activation prerequisites (all deferred beyond this migration):
--   1. Tables applied by an operator.
--   2. system_control['offerr_evaluation_enabled'] flipped to 'true'
--      (seeded 'false' below; the API route fails closed to 423 without it).
--
-- Access: service-role only. The dashboard must never read these tables with
-- the anon key; seller-facing surfaces receive only the seller_projection
-- payload via the internal API.
--
-- ROLLBACK (repository has no down-migration convention; documented here and
-- in docs/offerr/offerr-evaluation-spine.md). Safe while the feature flag is
-- false and no other subsystem references these tables — order matters
-- because of the FKs:
--   1. UPDATE public.system_control SET value = 'false'
--      WHERE key = 'offerr_evaluation_enabled';
--   2. DROP TABLE IF EXISTS public.offerr_evaluation_events;
--   3. DROP TABLE IF EXISTS public.offerr_evaluations;
--   4. DROP TABLE IF EXISTS public.offerr_evaluation_requests;
--   5. DROP FUNCTION IF EXISTS public.offerr_touch_updated_at();
--   6. (optional) DELETE FROM public.system_control
--      WHERE key = 'offerr_evaluation_enabled';
-- No other object in this migration touches pre-existing schema, so rollback
-- restores the exact prior state.

CREATE OR REPLACE FUNCTION public.offerr_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── Intake requests ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.offerr_evaluation_requests (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key              text        NOT NULL,
  raw_submitted_address        text        NOT NULL,
  normalized_submitted_address text        NOT NULL,
  seller_facts                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source                       text        NOT NULL DEFAULT 'internal',
  spine_version                text        NOT NULL,
  resolution_status            text        NOT NULL,
  property_id                  text,
  acquisition_opportunity_id   uuid,
  thread_key                   text,
  master_owner_id              text,
  metadata                     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offerr_eval_requests_idempotency_unique
    UNIQUE (idempotency_key),
  CONSTRAINT offerr_eval_requests_resolution_check
    CHECK (resolution_status IN ('RESOLVED', 'AMBIGUOUS', 'NOT_FOUND', 'INVALID_INPUT', 'UNSUPPORTED'))
);

CREATE INDEX IF NOT EXISTS idx_offerr_eval_requests_property
  ON public.offerr_evaluation_requests (property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offerr_eval_requests_created
  ON public.offerr_evaluation_requests (created_at DESC);

COMMENT ON TABLE public.offerr_evaluation_requests IS
  'Offerr direct-to-seller intake sessions. One row per submitted evaluation request; idempotency_key is the dedupe authority. Seller facts are unverified claims (overlay), never merged into canonical property data.';
COMMENT ON COLUMN public.offerr_evaluation_requests.seller_facts IS
  'Seller-claimed overlay envelopes {value, source: seller_claimed, verified: false, received_at}. Claims until verified; canonical properties rows are never mutated from this column.';
COMMENT ON COLUMN public.offerr_evaluation_requests.property_id IS
  'Canonical properties.property_id when resolution_status = RESOLVED. Text by convention (Podio-sourced ids); no FK because properties is an externally-synced table.';
COMMENT ON COLUMN public.offerr_evaluation_requests.acquisition_opportunity_id IS
  'Future LeadCommand/pipeline handoff linkage (acquisition_opportunities.id). Not populated by the evaluation spine.';

-- ── Versioned immutable evaluation snapshots ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.offerr_evaluations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         uuid        NOT NULL REFERENCES public.offerr_evaluation_requests (id),
  evaluation_version integer     NOT NULL DEFAULT 1,
  property_id        text,
  outcome            text        NOT NULL,
  confidence_label   text,
  preliminary_range  jsonb,
  seller_projection  jsonb       NOT NULL,
  internal_result    jsonb       NOT NULL,
  provenance         jsonb       NOT NULL,
  engine_version     text,
  spine_version      text        NOT NULL,
  computed_at        timestamptz NOT NULL,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offerr_evaluations_request_version_unique
    UNIQUE (request_id, evaluation_version),
  CONSTRAINT offerr_evaluations_version_check
    CHECK (evaluation_version > 0),
  CONSTRAINT offerr_evaluations_outcome_check
    CHECK (outcome IN ('INSTANT_RANGE_ELIGIBLE', 'CONDITIONAL_RANGE', 'REVIEW_REQUIRED', 'UNSUPPORTED')),
  CONSTRAINT offerr_evaluations_confidence_check
    CHECK (confidence_label IS NULL OR confidence_label IN ('HIGH', 'MEDIUM', 'LOW'))
);

CREATE INDEX IF NOT EXISTS idx_offerr_evaluations_request
  ON public.offerr_evaluations (request_id, evaluation_version DESC);

CREATE INDEX IF NOT EXISTS idx_offerr_evaluations_property
  ON public.offerr_evaluations (property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offerr_evaluations_outcome_created
  ON public.offerr_evaluations (outcome, created_at DESC);

COMMENT ON TABLE public.offerr_evaluations IS
  'Immutable versioned Offerr evaluation snapshots. Rows are never updated; a re-evaluation inserts the next evaluation_version. provenance reproduces why a range was generated (engine/formula versions, comp_set_hash, gates, reason codes, timings). No row here is a binding offer.';
COMMENT ON COLUMN public.offerr_evaluations.seller_projection IS
  'The sanitized seller-safe payload exactly as returned to the caller (allowlisted fields only; no MAO math, assignment fees, buyer identities, comp rows, or private identifiers).';
COMMENT ON COLUMN public.offerr_evaluations.internal_result IS
  'Full internal underwriting result including the canonical engine decision block. Service-role only; never exposed through seller-facing surfaces.';
COMMENT ON COLUMN public.offerr_evaluations.provenance IS
  'Reproducibility record: subject source/version, comp_set_hash, engine_version/formula_version, active feature flags, seller-fact overlay, gate checks, reason codes, computed_at, expires_at, stage timings.';

-- ── Append-only lifecycle/audit ledger ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.offerr_evaluation_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid        REFERENCES public.offerr_evaluation_requests (id),
  evaluation_id uuid        REFERENCES public.offerr_evaluations (id),
  event_type    text        NOT NULL,
  dedupe_key    text,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_offerr_eval_events_dedupe_key
  ON public.offerr_evaluation_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offerr_eval_events_request
  ON public.offerr_evaluation_events (request_id, created_at DESC);

COMMENT ON TABLE public.offerr_evaluation_events IS
  'Append-only Offerr evaluation lifecycle ledger (same family as acquisition_events). Payloads carry outcome, reason codes, and stage timings — never seller contact PII.';

-- ── updated_at trigger (requests only; evaluations/events are immutable) ───

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_offerr_eval_requests_touch'
  ) THEN
    CREATE TRIGGER trg_offerr_eval_requests_touch
      BEFORE UPDATE ON public.offerr_evaluation_requests
      FOR EACH ROW EXECUTE FUNCTION public.offerr_touch_updated_at();
  END IF;
END $$;

-- ── RLS: service-role only (Pattern 1 — matches acquisition_contacts) ──────

ALTER TABLE public.offerr_evaluation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offerr_evaluations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offerr_evaluation_events   ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'offerr_evaluation_requests'
      AND policyname = 'offerr_eval_requests_service_role_all'
  ) THEN
    CREATE POLICY offerr_eval_requests_service_role_all
      ON public.offerr_evaluation_requests
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'offerr_evaluations'
      AND policyname = 'offerr_evaluations_service_role_all'
  ) THEN
    CREATE POLICY offerr_evaluations_service_role_all
      ON public.offerr_evaluations
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'offerr_evaluation_events'
      AND policyname = 'offerr_eval_events_service_role_all'
  ) THEN
    CREATE POLICY offerr_eval_events_service_role_all
      ON public.offerr_evaluation_events
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.offerr_evaluation_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.offerr_evaluations         FROM anon, authenticated;
REVOKE ALL ON TABLE public.offerr_evaluation_events   FROM anon, authenticated;

-- Supabase seeds `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON
-- TABLES TO postgres, anon, authenticated, service_role`, so a new public
-- table arrives with service_role already holding arwd. The narrower GRANTs
-- below are additive and do NOT take that surplus away: without these REVOKEs
-- the "immutable snapshot" and "append-only ledger" guarantees are
-- convention-only, and the service-role key the Offerr API uses could UPDATE
-- or DELETE a persisted evaluation. Revoke first, then grant the exact set.
-- (Verified on PostgreSQL 17 with the Supabase default ACL reproduced — see
-- apps/api/scripts/offerr/offerr-schema-verify.sql section 7.)
REVOKE ALL ON TABLE public.offerr_evaluations         FROM service_role, PUBLIC;
REVOKE ALL ON TABLE public.offerr_evaluation_events   FROM service_role, PUBLIC;
REVOKE ALL ON TABLE public.offerr_evaluation_requests FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.offerr_evaluation_requests TO service_role;
GRANT SELECT, INSERT               ON TABLE public.offerr_evaluations         TO service_role;
GRANT SELECT, INSERT               ON TABLE public.offerr_evaluation_events   TO service_role;

-- offerr_touch_updated_at() is a trigger function. Nothing seller-facing should
-- be able to reach any offerr_* routine, and TWO independent mechanisms hand
-- out EXECUTE here — both must be revoked:
--
--   1. PostgreSQL itself grants EXECUTE to PUBLIC on every new function.
--   2. Hosted Supabase additionally seeds
--        ALTER DEFAULT PRIVILEGES IN SCHEMA public
--          GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--      which materialises as EXPLICIT per-role grants in the function's ACL.
--
-- REVOKE ... FROM PUBLIC removes (1) but is powerless against (2): an explicit
-- role grant is not the PUBLIC grant. Verified on the hosted preview branch —
-- with only the PUBLIC revoke the resulting ACL was
--   {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- i.e. anon and authenticated still held EXECUTE. This was invisible on a local
-- PostgreSQL container until offerr-supabase-prereqs.sql was taught to
-- reproduce Supabase's ON FUNCTIONS default privilege as well.
--
-- Revoking from service_role is safe: PostgreSQL checks EXECUTE on a trigger
-- function at CREATE TRIGGER time (already done above), not on each firing.
REVOKE ALL ON FUNCTION public.offerr_touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.offerr_touch_updated_at() FROM anon, authenticated, service_role;

-- ── Feature flag seed: explicitly disabled ─────────────────────────────────

INSERT INTO public.system_control (key, value)
VALUES ('offerr_evaluation_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
