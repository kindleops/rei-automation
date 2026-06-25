-- ════════════════════════════════════════════════════════════════════════
-- PROPOSED — Closing Desk shadow projection schema (Stages 6–10).
--
-- ⚠ NOT APPLIED. Filename is intentionally prefixed `PROPOSED_` so it is NOT
--   picked up by `supabase db push` / the normal migration runner. Rename to a
--   real timestamp (and review) only when Composer 2.5 is ready to wire the
--   Podio → Supabase projection. This is ADDITIVE: it never alters or drops
--   acquisition_opportunities, deal_thread_state, or any existing table.
--
-- Design notes:
-- * Mirrors the immutable-event pattern already used by
--   public.acquisition_opportunity_history (UNIQUE idempotency_key, append-only).
-- * closing_cases is a projection keyed to a canonical opportunity; it does not
--   replace Podio as the system of record — it is the queryable shadow that the
--   Closing Desk reads instead of fanning out to Podio per request.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.closing_cases (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_case_id           text UNIQUE NOT NULL,
  opportunity_id            uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  property_id               text,
  master_owner_id           text,
  prospect_id               text,
  offer_id                  text,
  contract_id               text,
  buyer_id                  text,
  assignment_id             text,
  title_company_id          text,
  escrow_file_number        text,

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

CREATE INDEX IF NOT EXISTS idx_closing_cases_stage ON public.closing_cases (universal_stage, closing_status);
CREATE INDEX IF NOT EXISTS idx_closing_cases_opportunity ON public.closing_cases (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_closing_cases_scheduled ON public.closing_cases (scheduled_closing_date)
  WHERE scheduled_closing_date IS NOT NULL;

-- ── Immutable milestones (append-only; idempotency_key prevents re-sync forks) ──
CREATE TABLE IF NOT EXISTS public.closing_milestones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_case_id   text NOT NULL,
  milestone_type    text NOT NULL,
  source_system     text NOT NULL,
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

-- ── Issues / curative ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.closing_issues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id            text UNIQUE NOT NULL,
  closing_case_id     text NOT NULL,
  category            text NOT NULL,
  title               text NOT NULL,
  severity            text NOT NULL DEFAULT 'medium',
  status              text NOT NULL DEFAULT 'open',
  owner               text,
  opened_at           timestamptz,
  due_at              timestamptz,
  sla_hours           integer,
  resolution_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependencies        jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_at         timestamptz,
  resolution_note     text,
  source              text NOT NULL DEFAULT 'podio_mirror',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closing_issues_severity_check CHECK (severity IN ('blocker','high','medium','low')),
  CONSTRAINT closing_issues_status_check CHECK (status IN ('open','in_progress','waiting','resolved','waived'))
);
CREATE INDEX IF NOT EXISTS idx_closing_issues_case ON public.closing_issues (closing_case_id, severity, status);

-- ── Parties / tasks / documents ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.closing_case_parties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_case_id   text NOT NULL,
  role              text NOT NULL,
  name              text,
  authority_type    text,
  verified          boolean,
  source            text NOT NULL DEFAULT 'podio_mirror',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_parties_case ON public.closing_case_parties (closing_case_id);

CREATE TABLE IF NOT EXISTS public.closing_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           text UNIQUE NOT NULL,
  closing_case_id   text NOT NULL,
  label             text NOT NULL,
  owner             text,
  due_at            timestamptz,
  sla_hours         integer,
  status            text NOT NULL DEFAULT 'open',
  blocked_by_issue_id text,
  source            text NOT NULL DEFAULT 'podio_mirror',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_tasks_case ON public.closing_tasks (closing_case_id, status);

CREATE TABLE IF NOT EXISTS public.closing_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       text UNIQUE NOT NULL,
  closing_case_id   text NOT NULL,
  label             text,
  kind              text,
  received_at       timestamptz,
  approved          boolean,
  source            text NOT NULL DEFAULT 'podio_mirror',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_documents_case ON public.closing_documents (closing_case_id);

-- ── Closing activity / audit events (append-only) ─────────────────────────────────
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

-- Intentionally NO data backfill / projection function here. The Podio → Supabase
-- projection job is an explicit, reviewed Composer 2.5 deliverable (see AUDIT.md
-- "Integration contract"), gated behind approval — never an automatic side effect.
