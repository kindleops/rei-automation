-- ─── seller_automation_decision_ledger ──────────────────────────────────────
-- The canonical, append-only decision ledger (supersprint §3/§4).
--
-- ONE SELLER EVENT -> ONE CANONICAL DECISION -> ONE EXECUTION PLAN.
--
-- Every processed inbound seller event resolves to exactly one immutable
-- decision row here, keyed on the source event id. This is NOT the intelligence
-- audit (public.inbound_intelligence_audit is UPSERTed by source_event_id, so a
-- re-process overwrites it). This ledger is strictly append-only: a row is
-- written once and never updated or deleted. Later information does not rewrite
-- history to look cleaner — it is a new inbound event, and so a new row.
--
-- The ledger gives deterministic replay, explainability ("why did the system do
-- this on date X"), auditability, and the lineage backbone that incident
-- detection, reconciliation, shadow mode, and the autonomy scorecard read from:
--   event_id -> decision_id -> ade_snapshot_id -> offer_id/version -> queue_row_id
--   -> provider_message_id -> closing_case_id.
--
-- Forward-safe and additive: CREATE TABLE IF NOT EXISTS, no backfill, no change
-- to any existing table. Service-role only (RLS enabled, anon/authenticated
-- revoked), matching seller_offers / closing_cases.

CREATE TABLE IF NOT EXISTS public.seller_automation_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- deterministic id (decision:<event_id>) + the source inbound event
  decision_id        text UNIQUE NOT NULL,
  event_id           text NOT NULL,
  provider_message_sid text,

  -- identity chain
  conversation_id    text,             -- canonical thread key
  opportunity_id     uuid REFERENCES public.acquisition_opportunities(id) ON DELETE SET NULL,
  property_id        text,
  seller_id          text,             -- master_owner_id

  -- when the seller event was observed (NOT when it was processed)
  observed_at        timestamptz NOT NULL DEFAULT now(),

  -- what the system understood
  decision_version   text NOT NULL,
  input_signal       text,
  normalized_intent  text,
  confidence         numeric,

  -- lifecycle transition
  prior_stage        text,
  resulting_stage    text,

  -- the chosen action + why
  action             text NOT NULL,
  action_reason      text,

  -- economic authority + offer lineage (present only for monetary turns)
  monetary_authority jsonb NOT NULL DEFAULT '{}'::jsonb,
  offer_id           text,
  offer_version      integer,
  terms_hash         text,
  ade_snapshot_id    text,

  -- the policy versions in force when this decision was made
  policy_versions    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- what the decision expects to happen next
  required_next_event text,

  -- durable execution result + full id lineage
  execution_result   jsonb NOT NULL DEFAULT '{}'::jsonb,
  queue_row_id       text,
  provider_message_id text,
  closing_case_id    text,
  lineage            jsonb NOT NULL DEFAULT '{}'::jsonb,

  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- exactly one decision per inbound event
  CONSTRAINT seller_automation_decisions_event_unique UNIQUE (event_id),
  -- an E.164-ish conversation id or nothing (never a malformed key)
  CONSTRAINT seller_automation_decisions_conversation_check
    CHECK (conversation_id IS NULL OR conversation_id ~ '^\+[1-9]\d{6,14}$')
);

CREATE INDEX IF NOT EXISTS idx_seller_automation_decisions_opportunity
  ON public.seller_automation_decisions (opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_automation_decisions_conversation
  ON public.seller_automation_decisions (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_automation_decisions_created
  ON public.seller_automation_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_automation_decisions_offer
  ON public.seller_automation_decisions (offer_id)
  WHERE offer_id IS NOT NULL;

-- ── Append-only immutability (§4: never UPDATE historical decisions) ─────────
-- A committed decision row can never be updated or deleted. Any attempt raises,
-- so history cannot be silently rewritten. Later information creates a NEW
-- inbound event and a NEW row; it does not mutate the old one.
CREATE OR REPLACE FUNCTION public.reject_seller_automation_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'seller_automation_decisions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_seller_automation_decisions_immutable
  ON public.seller_automation_decisions;
CREATE TRIGGER trg_seller_automation_decisions_immutable
  BEFORE UPDATE OR DELETE ON public.seller_automation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_seller_automation_decision_mutation();

-- ── Service-role only ────────────────────────────────────────────────────────
ALTER TABLE public.seller_automation_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_automation_decisions FROM anon, authenticated;

COMMENT ON TABLE public.seller_automation_decisions IS
  'Append-only canonical decision ledger: one immutable row per processed inbound seller event (supersprint §3/§4). Never updated or deleted.';
