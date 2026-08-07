-- ─────────────────────────────────────────────────────────────────────────────
-- Durable agreement terms snapshots (spine gap G9).
--
-- Today the terms a seller agreed to exist only in Podio (contracts app) and
-- transiently inside acquisition_opportunities.metadata.negotiation_state.
-- This table is the durable, append-only local record of the economics at the
-- moment of acceptance and at the moment of contract creation:
--   * what price was accepted,
--   * what the seller was asking at that moment,
--   * what our last offer was,
--   * what ceiling authority allowed,
--   * the exact terms object used for the downstream contract write.
--
-- Idempotency (spine §10): natural key + upsert-no-op on replay.
--   terms_hash is a deterministic sha256 over the canonical identity+economics
--   +source payload (computed in lib/domain/agreements/record-terms-snapshot.js).
--   UNIQUE (opportunity_id, terms_hash) makes replays no-ops; because Postgres
--   treats NULLs as distinct in unique constraints, a partial unique index on
--   terms_hash WHERE opportunity_id IS NULL closes the replay hole for
--   snapshots recorded from the Podio-only contract path (no local opportunity).
--
-- This migration is written, NOT applied (build rule §11). The writer degrades
-- to a logged no-op while the table is absent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agreement_terms_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity spine: any of these may be absent depending on which path
  -- recorded the snapshot (acceptance path has opportunity/thread; the
  -- cron contract path may only have Podio ids).
  opportunity_id uuid,
  thread_key text,
  property_id text,
  master_owner_id text,
  -- Economics at the moment the snapshot was taken.
  accepted_price numeric,
  accepted_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  seller_ask_at_acceptance numeric,
  our_last_offer numeric,
  authorized_ceiling_at_acceptance numeric,
  negotiation_state_version text,
  -- Deterministic content hash (identity + economics + source), computed by
  -- recordTermsSnapshot(); the idempotency backbone of this table.
  terms_hash text NOT NULL,
  source text NOT NULL CHECK (
    source IN ('negotiation_acceptance', 'contract_creation', 'operator')
  ),
  podio_contract_item_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_terms_snapshots_opportunity_terms_unique
    UNIQUE (opportunity_id, terms_hash)
);

-- NULL opportunity_id rows (Podio-only contract path) still replay as no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS agreement_terms_snapshots_orphan_terms_unique
  ON public.agreement_terms_snapshots (terms_hash)
  WHERE opportunity_id IS NULL;

CREATE INDEX IF NOT EXISTS agreement_terms_snapshots_opportunity_idx
  ON public.agreement_terms_snapshots (opportunity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agreement_terms_snapshots_thread_idx
  ON public.agreement_terms_snapshots (thread_key, created_at DESC);

CREATE INDEX IF NOT EXISTS agreement_terms_snapshots_podio_contract_idx
  ON public.agreement_terms_snapshots (podio_contract_item_id);

COMMENT ON TABLE public.agreement_terms_snapshots IS
  'Durable local record of agreed terms (spine gap G9). One append-only row per (identity, terms, source); replays deduplicate on terms_hash. Sources: negotiation_acceptance (seller-flow acceptance lock), contract_creation (terms used for the Podio contract write), operator (manual). Podio remains system-of-record for agreement entities; this table is the local durable snapshot of the economics.';

COMMENT ON COLUMN public.agreement_terms_snapshots.terms_hash IS
  'sha256 hex over the canonical JSON of identity + economics + source, computed deterministically in record-terms-snapshot.js. Equal terms replayed for the same identity+source are no-ops.';

COMMENT ON COLUMN public.agreement_terms_snapshots.accepted_terms IS
  'The exact terms object captured at snapshot time (price, basis, closing preference, contract type, EMD, closing target, creative terms, ...). Shape depends on source; always JSON-serializable and canonicalized before hashing.';

ALTER TABLE public.agreement_terms_snapshots ENABLE ROW LEVEL SECURITY;
