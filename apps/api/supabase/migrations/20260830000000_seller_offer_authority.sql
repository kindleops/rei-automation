-- ════════════════════════════════════════════════════════════════════════
-- Canonical Seller Offer Term Authority.
--
-- ROOT CAUSE THIS FIXES
-- The money was computed and SENT but never became durable state:
--   1. ORDERING — the SMS is enqueued in executeInboundAutomationDecision
--      (apply-inbound-automation-decision.js insertSupabaseSendQueueRow) which
--      runs at process-seller-inbound-message.js:1476, ~300 lines BEFORE
--      persistSellerTransitionArtifacts at :1768. The seller could receive $X
--      with nothing durable recording that $X was the active offer.
--   2. NON-ATOMIC + SWALLOWED — the only write of the amount
--      (persist-seller-transition.js:531 columnPatch.current_offer) sits in a
--      try/catch that merely warns on failure.
--   3. POST-HOC DERIVATION — the amount is re-derived from `authorized_amount`
--      plus `execution.queued`, not read back from the row actually queued.
--   4. NO OFFER ENTITY — `acquisition_opportunities.current_offer` is a
--      denormalized scalar. No offer id, version, status, sent timestamp,
--      terms hash, closing term or EMD term. History lived only in an
--      unversioned `metadata.negotiation_state.offers_made[]` JSON array.
--
-- WHY A NORMALIZED TABLE RATHER THAN active_negotiations / negotiation_events
-- Both were inspected and are NOT reusable for this:
--   * both key identity as `thread_id uuid NOT NULL` (negotiation_events also
--     `seller_id uuid`), while the live seller path keys on `thread_key` TEXT
--     (a phone number). Writing to them would require either mangling a phone
--     into a uuid or altering NOT NULL uuid columns owned by another model.
--   * they belong to the DEAD conversationMemoryService / queueAutoReply
--     subsystem (referenced only by intentMap.js and itself, never by the live
--     inbound path), which is why both tables are EMPTY in production.
--   * negotiation_events has no columns for price/version/status — everything
--     would be unconstrained jsonb, so monotonic versioning and "exactly one
--     active offer" could not be enforced by the database.
-- The LIVE negotiation authority in production is
-- `acquisition_opportunities` + `metadata.negotiation_state` (what
-- applyNegotiationTurn / persist-seller-transition actually read and write).
-- This table is the NORMALIZATION of the `offers_made[]` array that authority
-- already maintains in JSON — not a fourth competing authority. The opportunity
-- keeps pointing at the active/accepted offer, so it stays the entity of record.
--
-- CLOSING TERM AND EMD ARE NULLABLE ON PURPOSE.
-- No canonical closing-date policy and no canonical EMD policy exist in this
-- system (audited: the only trace is the Podio Contract-Templates field id
-- `default-closing-timeline-days`, whose VALUE lived in Podio and is not
-- recoverable). The columns exist so a centrally defined fixed, market-specific
-- or offer-specific policy can populate them later; nothing is defaulted here,
-- and an offer without them simply cannot complete a contract.
--
-- ADDITIVE ONLY. Rollback = DROP TABLE seller_offers + the two pointer columns.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.seller_offers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id                text UNIQUE NOT NULL,

  -- identity
  opportunity_id          uuid REFERENCES public.acquisition_opportunities(id) ON DELETE CASCADE,
  property_id             text,
  thread_key              text NOT NULL,
  master_owner_id         text,

  -- monotonic version within an opportunity
  offer_version           integer NOT NULL,
  offer_type              text NOT NULL,
  direction               text NOT NULL DEFAULT 'outbound',

  -- contractual terms
  purchase_price          numeric NOT NULL,
  closing_date            date,
  closing_term            text,
  emd_amount              numeric,
  emd_term                text,

  -- valuation / recommendation lineage (NOT the accepted price)
  ade_snapshot_id         text,
  recommended_offer       numeric,
  authorized_ceiling      numeric,
  valuation_mid           numeric,
  strategy                text,

  -- lifecycle
  status                  text NOT NULL DEFAULT 'active',
  created_at              timestamptz NOT NULL DEFAULT now(),
  sent_at                 timestamptz,
  superseded_at           timestamptz,
  superseded_by_offer_id  text,

  -- acceptance binding
  accepted_at             timestamptz,
  acceptance_event_id     text,
  accepted_price          numeric,

  -- send binding: ties the queued SMS to this exact offer id/version
  send_queue_row_id       text,
  source_message_event_id text,

  terms_hash              text NOT NULL,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT seller_offers_status_check CHECK (
    status IN ('active','superseded','accepted','withdrawn','expired')
  ),
  CONSTRAINT seller_offers_direction_check CHECK (direction IN ('outbound','inbound')),
  CONSTRAINT seller_offers_price_positive CHECK (purchase_price > 0)
);

-- Monotonic versioning: one row per (opportunity, version). History is never
-- overwritten; a new proposal is a NEW version.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_version
  ON public.seller_offers (opportunity_id, offer_version)
  WHERE opportunity_id IS NOT NULL;

-- Exactly ONE active offer per opportunity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_one_active
  ON public.seller_offers (opportunity_id)
  WHERE status = 'active' AND opportunity_id IS NOT NULL;

-- Exactly ONE accepted offer per opportunity: a replayed acceptance cannot
-- create a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_one_accepted
  ON public.seller_offers (opportunity_id)
  WHERE status = 'accepted' AND opportunity_id IS NOT NULL;

-- A given inbound acceptance message can only ever accept once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_offers_acceptance_event
  ON public.seller_offers (acceptance_event_id)
  WHERE acceptance_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seller_offers_thread ON public.seller_offers (thread_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_offers_status ON public.seller_offers (status);
CREATE INDEX IF NOT EXISTS idx_seller_offers_queue_row ON public.seller_offers (send_queue_row_id);

DROP TRIGGER IF EXISTS trg_seller_offers_updated_at ON public.seller_offers;
CREATE TRIGGER trg_seller_offers_updated_at
  BEFORE UPDATE ON public.seller_offers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The opportunity remains the entity of record and points at its offers.
ALTER TABLE public.acquisition_opportunities ADD COLUMN IF NOT EXISTS active_offer_id   text;
ALTER TABLE public.acquisition_opportunities ADD COLUMN IF NOT EXISTS accepted_offer_id text;

-- Service-role only, matching closing_cases / title tables.
ALTER TABLE public.seller_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_offers FROM anon, authenticated;
