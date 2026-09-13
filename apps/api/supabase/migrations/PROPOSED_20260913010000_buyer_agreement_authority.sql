-- Buyer Agreement Authority — the durable buyer-side agreement record whose
-- full execution is the only thing that can produce a buyer commitment.
--
-- STATUS: APPLIED TO PRODUCTION 2026-09-13 (project real-estate-automation /
-- lcppdrmrdfblstpcbgpf). Created EMPTY with zero writers in this pass: the
-- authority is proven in code and tests only, and no envelope was created or
-- sent. Verified after apply: 0 rows, 9 indexes, nothing existing touched.
--
-- The PROPOSED_ prefix is RETAINED deliberately (same convention as
-- PROPOSED_20260913000000_buyer_offer_authority.sql): it keeps this file
-- outside the `supabase db push` path. Do NOT rename it.
--
-- ADDITIVE ONLY. One new table plus indexes. Nothing existing is altered or
-- dropped. Re-running is safe (IF NOT EXISTS throughout).
--
-- WHY THIS EXISTS
-- S8.5 archaeology found no durable agreement record anywhere: no document,
-- envelope, agreement, signer or template table in Supabase. The only envelope
-- storage in the product is `closing_cases.docusign_envelope_id`, which belongs
-- to the SELLER contract. `closing_cases.assignment_id` is a bare text column
-- with no writers and cannot be the agreement authority — an id appearing there
-- would otherwise mean "a buyer is committed", which is exactly the class of
-- fabrication this program keeps closing.
--
-- WHAT IS REUSED RATHER THAN REBUILT
--   providers/docusign.js        createEnvelope / sendEnvelope / getEnvelope
--   security/docusign-hmac.js    webhook signature verification
--   handle-docusign-webhook.js   extractWebhookPayload / normalizeDocusignStatus
-- Only the DOMAIN object is new. There is no second signing stack.
--
-- THE AUTHORITY CHAIN
--   buyer_offer -> buyer_agreement -> buyer commitment -> S8 under_contract
-- A provider webhook never writes S8. It reconciles an agreement; the agreement
-- produces domain evidence; S8's existing authority verifies that evidence.
--
-- DB-LEVEL INTEGRITY:
--   * one ACTIVE agreement per buyer offer (a regeneration supersedes first)
--   * one provider envelope maps to exactly one agreement
--   * one commitment event may be emitted once, ever
--   * agreement versions are unique per buyer offer

CREATE TABLE IF NOT EXISTS public.buyer_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deterministic: buyer_agreement:<buyer_offer_id>:v<version>
  agreement_id text NOT NULL UNIQUE,
  agreement_version integer NOT NULL DEFAULT 1,

  agreement_type text NOT NULL
    CHECK (agreement_type IN ('assignment_agreement','purchase_agreement','novation_agreement')),

  -- Exact-offer binding. buyer_terms_hash is copied at generation so a later
  -- material change to the offer cannot be silently committed by an agreement
  -- the buyer signed against different terms.
  opportunity_id uuid NOT NULL,
  disposition_case_id text,
  property_id text NOT NULL,
  buyer_id text NOT NULL,
  buyer_offer_id text NOT NULL,
  buyer_offer_version integer NOT NULL DEFAULT 1,
  buyer_terms_hash text NOT NULL,
  buyer_price numeric NOT NULL CHECK (buyer_price > 0),
  strategy text NOT NULL,

  -- EMD is an OBLIGATION created by the agreement. Receipt is S9's to prove and
  -- has deliberately no column here.
  emd_terms numeric,

  -- Template provenance. Answers "what document terms did this buyer sign?"
  -- after the template is later edited.
  template_id text,
  template_version text,
  document_payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  provider text NOT NULL DEFAULT 'docusign',
  provider_envelope_id text,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','sent','viewed','buyer_signed','counterparty_signed','fully_executed','declined','voided','expired','superseded')),

  required_signers jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_signers jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- The one commitment event this agreement may ever emit.
  commitment_event_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  sent_at timestamptz,
  executed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  expired_at timestamptz,
  superseded_at timestamptz,
  superseded_by_agreement_id text,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE agreement per buyer offer. A regeneration must supersede/void the
-- prior one first, so two live envelopes can never race to commit a deal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_agreements_one_active
  ON public.buyer_agreements (buyer_offer_id)
  WHERE (status IN ('draft','ready','sent','viewed','buyer_signed','counterparty_signed','fully_executed'));

-- A provider envelope belongs to exactly one agreement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_agreements_envelope
  ON public.buyer_agreements (provider, provider_envelope_id)
  WHERE (provider_envelope_id IS NOT NULL);

-- Replay safety: one commitment event, once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_agreements_commitment_event
  ON public.buyer_agreements (commitment_event_id)
  WHERE (commitment_event_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_agreements_version
  ON public.buyer_agreements (buyer_offer_id, agreement_version);

CREATE INDEX IF NOT EXISTS idx_buyer_agreements_opportunity ON public.buyer_agreements (opportunity_id, status);
CREATE INDEX IF NOT EXISTS idx_buyer_agreements_buyer ON public.buyer_agreements (buyer_id);
CREATE INDEX IF NOT EXISTS idx_buyer_agreements_case ON public.buyer_agreements (disposition_case_id);

COMMENT ON TABLE public.buyer_agreements IS
  'Durable buyer-side agreement record. Full execution of a correctly bound agreement is the ONLY source of buyer commitment evidence for S8. Reuses the DocuSign provider/HMAC/status normalization; no second signing stack. EMD here is an obligation, never receipt.';
