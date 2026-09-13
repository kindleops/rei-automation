-- Buyer Offer Authority — the durable buyer-side proposal ledger for S8.
--
-- STATUS: APPLIED TO PRODUCTION 2026-09-13 (project real-estate-automation /
-- lcppdrmrdfblstpcbgpf). The table is created EMPTY and has zero writers in
-- this pass: S8 authority is proven in code and tests only. Verified after
-- apply: 0 rows, 10 indexes, and no existing row anywhere was read or written.
--
-- The PROPOSED_ prefix is RETAINED deliberately, matching
-- PROPOSED_20260729120000_offerr_evaluation_spine.sql: it keeps this file
-- outside the `supabase db push` path, and production's migration history has
-- no row for operator-applied files. Do NOT rename it.
--
-- ADDITIVE ONLY. One new table plus its indexes. No existing table, view, RPC
-- or policy is altered or dropped. Re-running is safe (IF NOT EXISTS
-- throughout).
--
-- WHY THIS EXISTS
-- S7 archaeology found no Supabase-native buyer-side ledger at all: no
-- buyer-offer table, no selection table, no POF table, no assignment table.
-- `selected_buyer` exists only as a Podio field id, and Podio is dead in
-- production. `closing_cases` carries buyer_id / buyer_price / buyer_emd /
-- assignment_id / assignment_fee / disposition_status, all of them NULL on
-- every row and with zero writers anywhere in the codebase.
--
-- Those closing_cases columns stay where they are and become PROJECTIONS of
-- this table for the selected buyer. They must never be the authority: a
-- buyer_id appearing on a closing case cannot mean a buyer was selected, for
-- the same reason a lifecycle_stage on a thread cannot mean a stage advanced.
--
-- THE GRAIN
--   One row per buyer proposal VERSION for one opportunity. A materially
--   different set of terms is a new version, never an edit of an old row —
--   the same rule seller_offers already follows.
--
-- THE THREE STATES THAT MATTER
--   submitted   a buyer proposed terms. Ours to consider. S7.
--   selected    we chose this buyer. Still S7: choosing a buyer does not bind
--               them, and a buyer who can walk away is not "under contract".
--   committed   the buyer is durably bound by a buyer-side agreement. ONLY
--               this may authorize S8 under_contract.
--
-- DB-LEVEL INTEGRITY (not application checks — this is high-consequence state):
--   * at most ONE selected offer per opportunity
--   * at most ONE committed offer per opportunity
--   * one commitment event may bind only once (replay safety)
--   * offer versions are unique per (opportunity, buyer)

CREATE TABLE IF NOT EXISTS public.buyer_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Durable identity. `buyer_offer_id` is deterministic:
  -- buyer_offer:<opportunity_id>:<buyer_id>:v<version>
  buyer_offer_id text NOT NULL UNIQUE,
  offer_version integer NOT NULL DEFAULT 1,

  -- Deal binding. All four are required together so a buyer offer can never be
  -- evaluated against the wrong property or opportunity.
  opportunity_id uuid NOT NULL,
  disposition_case_id text,
  property_id text NOT NULL,
  buyer_id text NOT NULL,

  -- Economics. `offer_price` is what the buyer pays us. `assignment_price` is
  -- recorded separately for structures where it differs from the price the
  -- buyer pays at closing (double close), so the two are never conflated.
  offer_price numeric NOT NULL CHECK (offer_price > 0),
  assignment_price numeric,
  strategy text NOT NULL DEFAULT 'assignment'
    CHECK (strategy IN ('assignment', 'double_close', 'novation', 'other')),

  -- Terms.
  emd_amount numeric,
  emd_status text NOT NULL DEFAULT 'not_required'
    CHECK (emd_status IN ('not_required','required','promised','due','received','verified','failed','refunded')),
  emd_due_date date,
  emd_received_at timestamptz,
  closing_date date,
  closing_window_days integer,
  material_terms jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Proof of funds. A document is not a finding: `attached` and `verified` are
  -- deliberately different states and only a named human produces the latter.
  pof_status text NOT NULL DEFAULT 'not_provided'
    CHECK (pof_status IN ('not_provided','attached','review_pending','verified','insufficient','expired','rejected')),
  pof_reference text,
  pof_verified_by text,
  pof_verified_at timestamptz,
  pof_expires_at timestamptz,

  -- Immutable identity of the material terms, same contract as
  -- seller_offers.terms_hash.
  terms_hash text NOT NULL,

  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft','submitted','withdrawn','rejected','selected','superseded','committed','defaulted','terminated')),

  submitted_at timestamptz,
  withdrawn_at timestamptz,
  rejected_at timestamptz,
  rejected_reason text,

  -- Selection. `selected_by` is required by the application authority: an
  -- operator or an explicitly authorized actor, never an anonymous automation.
  selected_at timestamptz,
  selected_by text,
  selection_reason text,

  -- Commitment. THE S8 boundary. `commitment_event_id` is the idempotency key:
  -- one event binds one offer, once, ever.
  committed_at timestamptz,
  commitment_event_id text,
  commitment_type text
    CHECK (commitment_type IS NULL OR commitment_type IN ('assignment_agreement','purchase_agreement','novation_agreement','other')),
  commitment_evidence jsonb,
  commitment_status text NOT NULL DEFAULT 'none'
    CHECK (commitment_status IN ('none','agreement_required','agreement_sent','committed','defaulted','terminated','replacement_required')),

  superseded_at timestamptz,
  superseded_by_offer_id text,

  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one SELECTED buyer per opportunity. History is never overwritten;
-- a prior selection is released to 'superseded' or 'rejected' first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_offers_one_selected
  ON public.buyer_offers (opportunity_id)
  WHERE (status = 'selected');

-- At most one COMMITTED buyer per opportunity. This is the S8 uniqueness
-- guarantee, enforced by the database rather than by a code path.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_offers_one_committed
  ON public.buyer_offers (opportunity_id)
  WHERE (status = 'committed');

-- Replay safety: the same commitment event can never bind twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_offers_commitment_event
  ON public.buyer_offers (commitment_event_id)
  WHERE (commitment_event_id IS NOT NULL);

-- Version identity per buyer per deal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_offers_version
  ON public.buyer_offers (opportunity_id, buyer_id, offer_version);

CREATE INDEX IF NOT EXISTS idx_buyer_offers_opportunity ON public.buyer_offers (opportunity_id, status);
CREATE INDEX IF NOT EXISTS idx_buyer_offers_property ON public.buyer_offers (property_id);
CREATE INDEX IF NOT EXISTS idx_buyer_offers_buyer ON public.buyer_offers (buyer_id);
CREATE INDEX IF NOT EXISTS idx_buyer_offers_disposition_case ON public.buyer_offers (disposition_case_id);

COMMENT ON TABLE public.buyer_offers IS
  'Canonical buyer-side proposal ledger. submitted != selected != committed; only status=committed may authorize S8 under_contract. closing_cases buyer columns are PROJECTIONS of the selected row here and are never the authority.';
