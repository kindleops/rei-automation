-- Settlement Record Authority — the immutable proof that a transaction leg
-- ACTUALLY settled, and the only place actual (as opposed to estimated)
-- economics may live.
--
-- STATUS: APPLIED TO PRODUCTION 2026-09-13 (project real-estate-automation /
-- lcppdrmrdfblstpcbgpf). Created EMPTY with zero writers in this pass: the
-- authority is proven in code and tests only, and no closing, wire, recording
-- or stage mutation occurred. Verified after apply: 0 rows, 9 indexes. Both
-- CHECK constraints were probed in a rolled-back transaction — a `settled` row
-- with no evidence and a `recorded` row with no instrument were each rejected,
-- and the table still holds 0 rows. The 476 legacy `closed` opportunities were
-- not touched or evaluated.
--
-- The PROPOSED_ prefix is RETAINED deliberately (same convention as the three
-- preceding buyer/EMD migrations): it keeps this file outside the
-- `supabase db push` path. Do NOT rename it.
--
-- ADDITIVE ONLY. One new table plus indexes. Nothing existing is altered or
-- dropped. Re-running is safe (IF NOT EXISTS throughout).
--
-- WHY THIS EXISTS
-- There is no settlement, funding, recording, disbursement, transaction or
-- revenue table anywhere in Supabase. The revenue modules
-- (create-deal-revenue-from-closed-closing.js, update-deal-revenue.js) and
-- maybe-mark-closed.js are all Podio-native, and Podio is dead in production.
-- `closing_cases` carries expected_gross_revenue, confirmed_gross_revenue,
-- net_revenue, funding_date and recording_date — with ZERO writers between
-- them. And nothing in the codebase advances
-- `acquisition_opportunities.acquisition_stage` to 'closed' at all: the 476
-- rows sitting there came from one 2026-06-21 backfill.
--
-- `wire_events` is rejected here for the same two reasons S9 rejected it for
-- EMD: its property_id/buyer_id/closing_id/deal_revenue_id are `bigint` Podio
-- item ids (our canonical ids are text and uuid, so a settlement recorded there
-- cannot bind to a V2 transaction), and it models Discord-driven revenue
-- FORECASTING rather than completed settlement. Left legacy, untouched.
--
-- THE GRAIN: ONE ROW PER CLOSING LEG.
--   An assignment settles once ('single'). A double close settles TWICE
--   ('a_to_b' and 'b_to_c') and is not closed until both legs are. Modelling
--   the leg explicitly is what stops a deal closing on half a transaction.
--
-- ESTIMATED vs ACTUAL. Every `actual_*` column here is settlement truth, and
-- the estimated figures the pipeline produced along the way stay where they
-- are. Neither overwrites the other, and a missing actual stays NULL rather
-- than being backfilled from an estimate.
--
-- DB-LEVEL INTEGRITY:
--   * one settlement per leg per opportunity
--   * one external reference per opportunity (replay safety)
--   * `settled` is unreachable without closed_at, provider, verifier,
--     timestamp, method and a chaseable evidence reference
--   * `recorded` is unreachable without an instrument id and recorded_at

CREATE TABLE IF NOT EXISTS public.settlement_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  settlement_id text NOT NULL UNIQUE,

  -- Canonical bindings. Closing evidence for the wrong property or the wrong
  -- buyer must never close this deal.
  opportunity_id uuid NOT NULL,
  closing_case_id text,
  property_id text NOT NULL,
  buyer_id text,
  buyer_offer_id text,
  buyer_agreement_id text,

  strategy text NOT NULL
    CHECK (strategy IN ('assignment','double_close','novation')),

  -- 'single' for an assignment or novation; a double close needs both legs.
  leg text NOT NULL DEFAULT 'single'
    CHECK (leg IN ('single','a_to_b','b_to_c')),

  settlement_status text NOT NULL DEFAULT 'pending'
    CHECK (settlement_status IN ('pending','settled','failed','reversed')),

  -- Funding is a ladder, not a boolean. An initiated wire is not funded and a
  -- received wire is not disbursed.
  funding_status text NOT NULL DEFAULT 'expected'
    CHECK (funding_status IN ('expected','initiated','received','verified','cleared','disbursed','failed','reversed')),
  funded_amount numeric CHECK (funded_amount IS NULL OR funded_amount >= 0),
  disbursed_amount numeric CHECK (disbursed_amount IS NULL OR disbursed_amount >= 0),
  funded_at timestamptz,
  disbursed_at timestamptz,

  -- Recording applies to some structures and not others; `not_applicable` is a
  -- deliberate answer, never an absence.
  recording_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (recording_status IN ('not_applicable','pending','submitted','recorded','rejected')),
  recording_instrument_id text,
  recorded_at timestamptz,
  recording_jurisdiction text,
  recording_evidence_reference text,

  -- The final statement that makes actual economics knowable.
  settlement_statement_type text
    CHECK (settlement_statement_type IS NULL OR settlement_statement_type IN ('alta','hud1','closing_statement','other')),
  settlement_statement_reference text,

  -- ACTUAL economics. Nothing here is ever derived from an estimate.
  actual_seller_amount numeric,
  actual_buyer_amount numeric,
  actual_assignment_fee numeric,
  actual_closing_costs numeric,
  actual_other_costs numeric,
  actual_net_proceeds numeric,

  -- The canonical closed date comes from verified completion evidence, never
  -- from a target, contract or scheduled date.
  closed_at timestamptz,
  closing_provider text,

  verified_by text,
  verified_at timestamptz,
  verification_method text
    CHECK (verification_method IS NULL OR verification_method IN ('manual_operator','title_provider','escrow_provider','bank_feed','document_upload')),
  evidence_reference text,
  evidence_note text,

  -- Post-close corrections are recorded, never used to erase the close.
  post_close_exception text,
  post_close_exception_at timestamptz,
  post_close_exception_note text,

  external_reference text,
  source text NOT NULL DEFAULT 'manual_operator',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A naked `closed = true` is exactly what this table exists to make
  -- unstorable.
  CONSTRAINT settlement_records_settled_requires_evidence CHECK (
    settlement_status <> 'settled' OR (
      closed_at IS NOT NULL AND closing_provider IS NOT NULL
      AND verified_by IS NOT NULL AND verified_at IS NOT NULL
      AND verification_method IS NOT NULL AND evidence_reference IS NOT NULL
    )
  ),

  -- Recording cannot be asserted without the instrument that proves it.
  CONSTRAINT settlement_records_recorded_requires_instrument CHECK (
    recording_status <> 'recorded' OR (
      recording_instrument_id IS NOT NULL AND recorded_at IS NOT NULL
    )
  )
);

-- One settlement per leg. A double close therefore needs two distinct rows and
-- cannot be closed twice on the same one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_records_leg
  ON public.settlement_records (opportunity_id, leg);

-- Replay safety: the same reported settlement cannot be counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_records_external_ref
  ON public.settlement_records (opportunity_id, external_reference)
  WHERE (external_reference IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_records_instrument
  ON public.settlement_records (recording_jurisdiction, recording_instrument_id)
  WHERE (recording_instrument_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_settlement_records_opportunity ON public.settlement_records (opportunity_id, settlement_status);
CREATE INDEX IF NOT EXISTS idx_settlement_records_property ON public.settlement_records (property_id);
CREATE INDEX IF NOT EXISTS idx_settlement_records_case ON public.settlement_records (closing_case_id);
CREATE INDEX IF NOT EXISTS idx_settlement_records_buyer ON public.settlement_records (buyer_id);

COMMENT ON TABLE public.settlement_records IS
  'Immutable proof that a transaction LEG actually settled, and the only home for actual (never estimated) economics. One row per leg: a double close needs a_to_b AND b_to_c. settlement_status=settled requires closed_at, provider, verifier, timestamp, method and evidence reference; recording_status=recorded requires an instrument id. Not wire_events (Podio bigint ids, revenue forecasting) and not closing_cases revenue columns (mutable, zero writers).';
