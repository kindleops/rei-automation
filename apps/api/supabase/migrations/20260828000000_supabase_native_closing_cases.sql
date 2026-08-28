-- ════════════════════════════════════════════════════════════════════════
-- Supabase-native closing substrate (Slice 1).
--
-- Supersedes the intent of PROPOSED_20260626000000_closing_desk_foundation.sql,
-- which designed `closing_cases` as a READ-ONLY SHADOW of Podio
-- ("does not replace Podio as the system of record"). Podio is not in service
-- (no production credentials; podio_sync_enabled defaults false, so
-- podio_business_writes_enabled is permanently false in production), and the
-- production database has NO contract/closing/title/escrow substrate at all.
-- This migration promotes the same reviewed design to the SYSTEM OF RECORD for
-- the closing leg and adds the fields the DocuSign continuity path requires.
--
-- Review performed against the live production schema:
--   * FK target public.acquisition_opportunities(id) EXISTS and is uuid — match.
--   * universal_stage CHECK values match current LIFECYCLE_STAGE_CODES S6..S10
--     (formal_contract, under_contract, disposition, prepared_to_close, closed).
--   * ADDITIVE ONLY: creates new tables/indexes/trigger. No existing object is
--     altered or dropped. Rollback = DROP the objects created here.
--   * RLS: comparable modern tables (active_negotiations, deal_thread_state)
--     run RLS ENABLED with ZERO policies = service-role only. This table holds
--     signer PII + contract prices, so it adopts that strictest posture and
--     additionally REVOKEs anon/authenticated.
--   * updated_at is maintained by the existing public.set_updated_at() trigger
--     (the proposed schema had only DEFAULT now(), so updated_at never advanced).
--
-- Idempotency contract (why the unique indexes exist):
--   * closing_case_id is deterministic per opportunity, so replaying the same
--     acceptance cannot create a second case.
--   * ONE closing case per opportunity (unique partial index) — a replay or a
--     wrong-opportunity bind cannot fork a seller's closing.
--   * ONE envelope per closing case (unique partial index on
--     docusign_envelope_id) — the DocuSign webhook resolves the case by
--     envelope id, and a replayed envelope cannot bind to two cases.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.closing_cases (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_case_id           text UNIQUE NOT NULL,

  -- canonical identity (sourced from existing Supabase authorities)
  opportunity_id            uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  property_id               text,
  property_address          text,
  master_owner_id           text,
  prospect_id               text,
  thread_key                text,
  offer_id                  text,
  negotiation_id            text,
  contract_id               text,
  buyer_id                  text,
  assignment_id             text,
  title_company_id          text,
  escrow_file_number        text,

  -- lifecycle
  universal_stage           text NOT NULL DEFAULT 'formal_contract',
  closing_status            text NOT NULL DEFAULT 'not_scheduled',
  closing_substage          text,
  contract_status           text,
  disposition_status        text,
  title_status              text,
  escrow_status             text,
  funding_status            text,
  revenue_status            text,
  health_band               text,
  risk_level                text,

  -- acceptance + terms provenance
  accepted_at               timestamptz,
  terms_hash                text,

  -- e-signature (DocuSign)
  docusign_envelope_id      text,
  docusign_status           text,
  envelope_sent_at          timestamptz,
  signer_email              text,
  signer_name               text,

  -- key dates
  contract_signed_date      timestamptz,
  effective_date            timestamptz,
  emd_due_date              timestamptz,
  inspection_deadline       timestamptz,
  title_opened_date         timestamptz,
  title_commitment_date     timestamptz,
  cure_deadline             timestamptz,
  scheduled_closing_date    timestamptz,
  signing_date              timestamptz,
  funding_date              timestamptz,
  recording_date            timestamptz,
  revenue_confirmed_date    timestamptz,

  -- financials
  seller_contract_price     numeric,
  earnest_money             numeric,
  buyer_price               numeric,
  assignment_fee            numeric,
  double_close_spread       numeric,
  buyer_emd                 numeric,
  seller_credits            numeric,
  closing_costs             numeric,
  title_fees                numeric,
  expected_gross_revenue    numeric,
  confirmed_gross_revenue   numeric,
  net_revenue               numeric,
  funding_source            text,

  -- readiness checklist (tri-state: true / false / NULL = unknown)
  readiness                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- health snapshot (score + factors), computed deterministically off-row
  health_score              integer,
  health_factors            jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_completeness_score   integer,

  provenance                jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activity_at          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT closing_cases_universal_stage_check CHECK (
    universal_stage IN ('formal_contract','under_contract','disposition','prepared_to_close','closed')
  )
);

-- Lookup + idempotency indexes.
CREATE INDEX IF NOT EXISTS idx_closing_cases_stage ON public.closing_cases (universal_stage, closing_status);
CREATE INDEX IF NOT EXISTS idx_closing_cases_contract_status ON public.closing_cases (contract_status);
CREATE INDEX IF NOT EXISTS idx_closing_cases_owner ON public.closing_cases (master_owner_id);
CREATE INDEX IF NOT EXISTS idx_closing_cases_thread ON public.closing_cases (thread_key);
CREATE INDEX IF NOT EXISTS idx_closing_cases_scheduled ON public.closing_cases (scheduled_closing_date)
  WHERE scheduled_closing_date IS NOT NULL;

-- Exactly ONE closing case per opportunity (replay / wrong-bind protection).
CREATE UNIQUE INDEX IF NOT EXISTS uq_closing_cases_opportunity ON public.closing_cases (opportunity_id)
  WHERE opportunity_id IS NOT NULL;

-- Webhook resolution key: exactly ONE case per DocuSign envelope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_closing_cases_envelope ON public.closing_cases (docusign_envelope_id)
  WHERE docusign_envelope_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_closing_cases_updated_at ON public.closing_cases;
CREATE TRIGGER trg_closing_cases_updated_at
  BEFORE UPDATE ON public.closing_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Immutable milestones (append-only; idempotency_key prevents re-sync forks) ──
CREATE TABLE IF NOT EXISTS public.closing_milestones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_case_id   text NOT NULL,
  milestone_type    text NOT NULL,
  source_system     text NOT NULL DEFAULT 'system',
  source_entity_id  text,
  occurred_at       timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  actor             text,
  prior_state       text,
  resulting_state   text,
  snapshot          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   text UNIQUE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_closing_milestones_case ON public.closing_milestones (closing_case_id, occurred_at);

-- ── Closing activity / audit events (append-only) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.closing_activity_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_case_id   text NOT NULL,
  event_type        text NOT NULL,
  actor             text,
  source            text NOT NULL DEFAULT 'system',
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_activity_case ON public.closing_activity_events (closing_case_id, created_at DESC);

-- ── Access posture: service-role only (matches active_negotiations / deal_thread_state) ──
ALTER TABLE public.closing_cases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closing_milestones       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closing_activity_events  ENABLE ROW LEVEL SECURITY;

-- No policies are created: with RLS enabled and zero policies, anon/authenticated
-- get nothing and service_role (which bypasses RLS) retains full access.
REVOKE ALL ON public.closing_cases           FROM anon, authenticated;
REVOKE ALL ON public.closing_milestones      FROM anon, authenticated;
REVOKE ALL ON public.closing_activity_events FROM anon, authenticated;

-- NOTE: no data backfill. There is nothing to project from (Podio is not in
-- service and no prior closing substrate exists), so this migration creates an
-- empty, inert substrate. Contract creation is performed only by the canonical
-- Supabase contract creator, behind the existing contract-send controls.
