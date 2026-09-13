-- EMD Receipt Authority — the first durable proof that earnest money actually
-- arrived, as opposed to having been promised in a signed agreement.
--
-- STATUS: APPLIED TO PRODUCTION 2026-09-13 (project real-estate-automation /
-- lcppdrmrdfblstpcbgpf). Created EMPTY with zero writers in this pass: the
-- authority is proven in code and tests only, and no deposit was recorded,
-- verified or moved. Verified after apply: 0 rows, 7 indexes, nothing existing
-- touched. `wire_events` remains untouched at 0 rows.
--
-- The PROPOSED_ prefix is RETAINED deliberately (same convention as the two
-- preceding buyer-side migrations): it keeps this file outside the
-- `supabase db push` path. Do NOT rename it.
--
-- ADDITIVE ONLY. One new table plus indexes. Nothing existing is altered or
-- dropped. Re-running is safe (IF NOT EXISTS throughout).
--
-- WHY NOT `wire_events`
-- `wire_events` exists, has real writers (lib/domain/wires/wire-ledger.js) and
-- is surfaced through Discord embeds and the daily briefing. It is NOT usable
-- as EMD receipt authority, for two independent reasons:
--
--   1. IDENTITY. Its `property_id`, `buyer_id`, `closing_id` and
--      `deal_revenue_id` are all `bigint` — Podio item ids — plus a
--      `created_by_discord_user_id`. Our canonical ids are text
--      (`property_id`, `buyer_id`) and uuid (`opportunity_id`). A deposit
--      recorded there cannot be bound to a canonical buyer offer or agreement
--      at all, and an unbindable deposit is exactly what must never satisfy a
--      requirement.
--   2. SEMANTICS. It models expected/received/cleared wire FORECASTING at the
--      deal-revenue level for a Discord command centre. Escrow receipt of a
--      buyer's earnest money against one committed agreement is a different
--      fact with different bindings and a different burden of proof.
--
-- It is left untouched and continues to do its own job.
--
-- WHAT THIS RECORDS
--   One row per deposit EVENT bound to one buyer's committed offer. Receipt and
--   verification are separate: `received_unverified` means someone says money
--   arrived; `verified` means a named human (or a provider with strong
--   evidence) confirmed it, with a reference that can be chased.
--
-- THERE IS NO AUTOMATED RECEIPT SOURCE IN THIS PRODUCT TODAY. No bank feed, no
-- escrow provider webhook. So this supports CONTROLLED MANUAL VERIFICATION
-- rather than fabricating automation: an operator checkbox with no verifier, no
-- amount, no destination and no evidence reference is not financial truth, and
-- the NOT NULL constraints below make that shape impossible to store.
--
-- DB-LEVEL INTEGRITY:
--   * one receipt per external reference per opportunity (replay safety)
--   * a verified receipt must carry its verifier, timestamp and evidence

CREATE TABLE IF NOT EXISTS public.emd_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  receipt_id text NOT NULL UNIQUE,

  -- Canonical bindings. A $5,000 deposit from Buyer A on Property A cannot
  -- satisfy Buyer B or Property B, so all of these are required together.
  opportunity_id uuid NOT NULL,
  closing_case_id text,
  property_id text NOT NULL,
  buyer_id text NOT NULL,
  buyer_offer_id text NOT NULL,
  buyer_agreement_id text,

  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'USD',

  -- Where the money landed. A deposit into an unknown account proves nothing.
  escrow_destination text NOT NULL,
  escrow_reference text,

  status text NOT NULL DEFAULT 'received_unverified'
    CHECK (status IN ('received_unverified','verified','failed','refunded','disputed')),

  received_at timestamptz NOT NULL,

  -- Verification provenance. `verified` is unreachable without all three.
  verified_at timestamptz,
  verified_by text,
  verification_method text
    CHECK (verification_method IS NULL OR verification_method IN ('manual_operator','title_provider','bank_feed','document_upload')),
  evidence_reference text,
  evidence_note text,

  -- Replay key from whatever reported the deposit.
  external_reference text,
  source text NOT NULL DEFAULT 'manual_operator',

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A verified receipt without provenance is the failure mode this table
  -- exists to prevent, so the database refuses to store one.
  CONSTRAINT emd_receipts_verified_requires_provenance CHECK (
    status <> 'verified' OR (
      verified_at IS NOT NULL AND verified_by IS NOT NULL
      AND verification_method IS NOT NULL AND evidence_reference IS NOT NULL
    )
  )
);

-- Replay safety: the same reported deposit cannot be counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_emd_receipts_external_ref
  ON public.emd_receipts (opportunity_id, external_reference)
  WHERE (external_reference IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_emd_receipts_opportunity ON public.emd_receipts (opportunity_id, status);
CREATE INDEX IF NOT EXISTS idx_emd_receipts_offer ON public.emd_receipts (buyer_offer_id);
CREATE INDEX IF NOT EXISTS idx_emd_receipts_buyer ON public.emd_receipts (buyer_id);
CREATE INDEX IF NOT EXISTS idx_emd_receipts_case ON public.emd_receipts (closing_case_id);

COMMENT ON TABLE public.emd_receipts IS
  'Durable proof that earnest money ARRIVED. Distinct from the EMD obligation on buyer_agreements: an amount in an agreement is terms, a row here is receipt, and status=verified additionally requires a named verifier, method and evidence reference. Not wire_events: that table carries Podio bigint ids and models Discord-driven revenue forecasting.';
