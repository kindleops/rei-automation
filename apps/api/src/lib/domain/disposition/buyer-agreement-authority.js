// ─── buyer-agreement-authority.js ───────────────────────────────────────────
// The path that makes S8 reachable: a selected buyer offer becomes a correctly
// bound agreement, that agreement is signed by every required party, and its
// full execution normalizes into the domain evidence S8 already demands.
//
// THE AUTHORITY CHAIN
//   buyer_offer -> buyer_agreement -> buyer commitment -> S8 under_contract
//
// A provider webhook NEVER writes S8. It reconciles an agreement; the agreement
// emits one commitment event; S8's existing `authorizeBuyerCommitment` verifies
// that evidence against the offer. Three hops, each with its own refusal.
//
// WHAT IS REUSED RATHER THAN REBUILT (archaeology, 2026-09-13)
//   providers/docusign.js       createEnvelope / sendEnvelope / getEnvelope,
//                               JWT auth, config — provider-agnostic transport
//   security/docusign-hmac.js   webhook signature verification
//   handle-docusign-webhook.js  extractWebhookPayload / normalizeDocusignStatus
// Those layers are generic. Only the DOMAIN layer was seller-hardcoded:
// `create-docusign-envelope-from-closing-case.js` builds a single recipient with
// `role: "seller"` from `seller_contract_price`, and
// `reconcile-closing-case-from-envelope.js` resolves envelopes against
// `closing_cases.docusign_envelope_id` and writes the SELLER contract status.
// So a buyer envelope must never be written to that column — this module keeps
// buyer envelope ids on `buyer_agreements` precisely so a completed buyer
// agreement can never be mistaken for seller contract execution.
//
// THERE IS NO SECOND SIGNING STACK.
//
// THIS MODULE WRITES NOTHING AND SENDS NOTHING. It resolves gates, builds
// payloads, and normalizes provider status into domain state. Persistence and
// transport belong to callers, behind the existing containment boundary.

import crypto from "node:crypto";

import {
  BUYER_OFFER_STATUS,
  COMMITMENT_TYPES,
  resolveBuyerOfferCompleteness,
} from "@/lib/domain/disposition/buyer-commitment-authority.js";

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Strategy -> the agreement that actually binds a buyer in that structure.
 *
 * A strategy with no approved document path is NOT silently given the nearest
 * template: substituting an assignment agreement into a novation would produce
 * a signed document that does not describe the transaction.
 */
export const STRATEGY_AGREEMENT_MAP = Object.freeze({
  assignment: COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT,
  double_close: COMMITMENT_TYPES.PURCHASE_AGREEMENT,
  novation: COMMITMENT_TYPES.NOVATION_AGREEMENT,
});

export const AGREEMENT_STATUS = Object.freeze({
  DRAFT: "draft",
  READY: "ready",
  SENT: "sent",
  VIEWED: "viewed",
  BUYER_SIGNED: "buyer_signed",
  COUNTERPARTY_SIGNED: "counterparty_signed",
  FULLY_EXECUTED: "fully_executed",
  DECLINED: "declined",
  VOIDED: "voided",
  EXPIRED: "expired",
  SUPERSEDED: "superseded",
});

/** Statuses that still own the buyer offer — only one may exist at a time. */
const ACTIVE_AGREEMENT_STATUSES = new Set([
  AGREEMENT_STATUS.DRAFT, AGREEMENT_STATUS.READY, AGREEMENT_STATUS.SENT,
  AGREEMENT_STATUS.VIEWED, AGREEMENT_STATUS.BUYER_SIGNED,
  AGREEMENT_STATUS.COUNTERPARTY_SIGNED, AGREEMENT_STATUS.FULLY_EXECUTED,
]);

const TERMINAL_AGREEMENT_STATUSES = new Set([
  AGREEMENT_STATUS.DECLINED, AGREEMENT_STATUS.VOIDED,
  AGREEMENT_STATUS.EXPIRED, AGREEMENT_STATUS.SUPERSEDED,
]);

/** Monotonic rank. A late "sent" can never regress an executed agreement. */
const STATUS_RANK = Object.freeze({
  [AGREEMENT_STATUS.DRAFT]: 1,
  [AGREEMENT_STATUS.READY]: 2,
  [AGREEMENT_STATUS.SENT]: 3,
  [AGREEMENT_STATUS.VIEWED]: 4,
  [AGREEMENT_STATUS.BUYER_SIGNED]: 5,
  [AGREEMENT_STATUS.COUNTERPARTY_SIGNED]: 6,
  [AGREEMENT_STATUS.FULLY_EXECUTED]: 7,
});

/** DocuSign normalized status -> agreement status. Same vocabulary the seller
 *  reconciler already consumes, so provider semantics live in one place. */
const PROVIDER_STATUS_MAP = Object.freeze({
  Created: AGREEMENT_STATUS.DRAFT,
  Sent: AGREEMENT_STATUS.SENT,
  Delivered: AGREEMENT_STATUS.VIEWED,
  "Seller Signed": AGREEMENT_STATUS.COUNTERPARTY_SIGNED,
  "Buyer Signed": AGREEMENT_STATUS.BUYER_SIGNED,
  Completed: AGREEMENT_STATUS.FULLY_EXECUTED,
  Declined: AGREEMENT_STATUS.DECLINED,
  Voided: AGREEMENT_STATUS.VOIDED,
});

export const AGREEMENT_DENIALS = Object.freeze({
  DISPOSITION_NOT_ACTIVE: "disposition_not_active",
  OFFER_NOT_SELECTED: "buyer_offer_not_selected",
  OFFER_INCOMPLETE: "buyer_offer_missing_material_terms",
  BINDING_MISMATCH: "buyer_offer_binding_mismatch",
  UNSUPPORTED_STRATEGY: "buyer_agreement_unsupported",
  MISSING_TEMPLATE: "missing_agreement_template",
  ACTIVE_AGREEMENT_EXISTS: "active_buyer_agreement_exists",
  TERMS_DRIFTED: "buyer_terms_changed_since_agreement",
  NOT_FULLY_EXECUTED: "agreement_not_fully_executed",
  SIGNERS_INCOMPLETE: "required_signers_incomplete",
  AGREEMENT_TERMINAL: "agreement_terminal",
  AGREEMENT_SUPERSEDED: "agreement_superseded",
  SELLER_CONTRACT_INVALIDATED: "seller_contract_invalidated",
  ENVELOPE_MISMATCH: "envelope_belongs_to_other_agreement",
});

/** Deterministic, so a replayed generation converges on one agreement. */
export function buildBuyerAgreementId({ buyer_offer_id, agreement_version = 1 } = {}) {
  const offer = clean(buyer_offer_id);
  return offer ? `buyer_agreement:${offer}:v${Number(agreement_version) || 1}` : null;
}

export function resolveRequiredAgreementType(strategy) {
  const key = clean(strategy).toLowerCase() || "assignment";
  return STRATEGY_AGREEMENT_MAP[key] ?? null;
}

/**
 * The buyer-facing document payload. ALLOWLIST, deny by default.
 *
 * An agreement legitimately needs the property, the buyer, the price and the
 * timing. It does not need — and must never carry — the seller's conversation,
 * our acquisition ceiling, the Decision Engine's reasoning, our ranking of this
 * buyer, or any other buyer's offer. `seller_acquisition_price` is included
 * only for structures whose document requires the underlying basis (a novation
 * or double close references it); an assignment agreement does not, and does
 * not receive it.
 */
export const AGREEMENT_PAYLOAD_ALLOWLIST = Object.freeze([
  "property_address_full", "property_id",
  "buyer_id", "buyer_name", "buyer_entity_name", "buyer_email",
  "buyer_price", "assignment_consideration", "emd_terms",
  "closing_date", "closing_window_days", "strategy", "agreement_type",
]);

export const AGREEMENT_PAYLOAD_FORBIDDEN = Object.freeze([
  "seller_phone", "seller_email", "seller_name", "thread_key", "canonical_e164",
  "messages", "conversation", "negotiation_state", "seller_facts",
  "motivation_score", "recommended_offer", "authorized_offer_ceiling",
  "investor_ceiling_mid", "expected_assignment_fee", "ade_snapshot", "evidence",
  "competing_offers", "buyer_ranking", "gross_spread",
]);

/** Structures whose document legally references the underlying acquisition. */
const STRATEGIES_REQUIRING_SELLER_BASIS = new Set(["double_close", "novation"]);

export function buildAgreementPayload({
  buyerOffer = null,
  property = null,
  buyer = null,
  agreementType = null,
  sellerAcquisitionPrice = null,
} = {}) {
  const strategy = clean(buyerOffer?.strategy).toLowerCase() || "assignment";
  const source = {
    property_address_full: clean(property?.property_address_full) || null,
    property_id: clean(buyerOffer?.property_id) || null,
    buyer_id: clean(buyerOffer?.buyer_id) || null,
    buyer_name: clean(buyer?.buyer_name) || null,
    buyer_entity_name: clean(buyer?.entity_name) || null,
    buyer_email: clean(buyer?.email) || null,
    buyer_price: money(buyerOffer?.offer_price),
    assignment_consideration: money(buyerOffer?.assignment_price),
    // The obligation the agreement creates. NEVER a receipt.
    emd_terms: money(buyerOffer?.emd_amount),
    closing_date: buyerOffer?.closing_date ?? null,
    closing_window_days: buyerOffer?.closing_window_days ?? null,
    strategy,
    agreement_type: agreementType,
  };
  if (STRATEGIES_REQUIRING_SELLER_BASIS.has(strategy)) {
    source.seller_acquisition_price = money(sellerAcquisitionPrice);
  }

  const allowed = STRATEGIES_REQUIRING_SELLER_BASIS.has(strategy)
    ? [...AGREEMENT_PAYLOAD_ALLOWLIST, "seller_acquisition_price"]
    : AGREEMENT_PAYLOAD_ALLOWLIST;

  const payload = {};
  for (const field of allowed) {
    if (source[field] !== undefined && source[field] !== null) payload[field] = source[field];
  }
  return payload;
}

/**
 * May this selected buyer offer generate an agreement?
 *
 * Generating an agreement does NOT advance the stage: it is the act that makes
 * commitment possible, so the deal stays at S7 with the buyer's signature still
 * outstanding.
 */
export function authorizeBuyerAgreementGeneration({
  dispositionAuthorization = null,
  buyerOffer = null,
  opportunity = null,
  dispositionCase = null,
  existingAgreement = null,
  templateId = null,
  templateVersion = null,
  now = new Date(),
} = {}) {
  const deny = (reason, evidence = {}) => ({
    authorized: false, reason, evidence, stage: "disposition", agreement: null,
  });

  if (!dispositionAuthorization?.authorized || dispositionAuthorization.external_activity_permitted !== true) {
    return deny(AGREEMENT_DENIALS.DISPOSITION_NOT_ACTIVE, {
      disposition_state: dispositionAuthorization?.disposition_state ?? null,
    });
  }

  // Only the buyer we actually selected gets a binding document.
  if (clean(buyerOffer?.status) !== BUYER_OFFER_STATUS.SELECTED) {
    return deny(AGREEMENT_DENIALS.OFFER_NOT_SELECTED, { status: clean(buyerOffer?.status) || null });
  }

  const completeness = resolveBuyerOfferCompleteness(buyerOffer || {});
  if (!completeness.ok) return deny(AGREEMENT_DENIALS.OFFER_INCOMPLETE, { missing_terms: completeness.missing });

  if (clean(buyerOffer.opportunity_id) !== clean(opportunity?.id)) {
    return deny(AGREEMENT_DENIALS.BINDING_MISMATCH, { mismatched: "opportunity" });
  }
  const propertyId = clean(opportunity?.primary_property_id);
  if (propertyId && clean(buyerOffer.property_id) !== propertyId) {
    return deny(AGREEMENT_DENIALS.BINDING_MISMATCH, { mismatched: "property" });
  }

  const agreementType = resolveRequiredAgreementType(buyerOffer.strategy);
  if (!agreementType) {
    return deny(AGREEMENT_DENIALS.UNSUPPORTED_STRATEGY, { strategy: clean(buyerOffer.strategy) || null });
  }
  if (!clean(templateId)) {
    return deny(AGREEMENT_DENIALS.MISSING_TEMPLATE, { agreement_type: agreementType });
  }

  // One live agreement per offer. A regeneration must supersede the prior one
  // first, so two envelopes can never race to commit the same deal.
  if (existingAgreement && ACTIVE_AGREEMENT_STATUSES.has(clean(existingAgreement.status))) {
    return deny(AGREEMENT_DENIALS.ACTIVE_AGREEMENT_EXISTS, {
      agreement_id: existingAgreement.agreement_id,
      status: existingAgreement.status,
    });
  }

  // A terminal prior agreement means this is a NEW version, never an edit.
  const version = existingAgreement ? Number(existingAgreement.agreement_version || 1) + 1 : 1;

  return {
    authorized: true,
    reason: "buyer_agreement_authorized",
    /** Generating a document does not advance the stage. */
    stage: "disposition",
    agreement: {
      agreement_id: buildBuyerAgreementId({ buyer_offer_id: buyerOffer.buyer_offer_id, agreement_version: version }),
      agreement_version: version,
      agreement_type: agreementType,
      opportunity_id: clean(buyerOffer.opportunity_id),
      disposition_case_id: clean(dispositionCase?.closing_case_id ?? dispositionAuthorization.disposition_case_id) || null,
      property_id: clean(buyerOffer.property_id),
      buyer_id: clean(buyerOffer.buyer_id),
      buyer_offer_id: clean(buyerOffer.buyer_offer_id),
      buyer_offer_version: Number(buyerOffer.offer_version || 1),
      // Copied at generation: a later material change to the offer cannot be
      // committed by a document the buyer signed against different terms.
      buyer_terms_hash: clean(buyerOffer.terms_hash),
      buyer_price: money(buyerOffer.offer_price),
      strategy: clean(buyerOffer.strategy) || "assignment",
      emd_terms: money(buyerOffer.emd_amount),
      template_id: clean(templateId),
      template_version: clean(templateVersion) || null,
      provider: "docusign",
      status: AGREEMENT_STATUS.DRAFT,
      required_signers: resolveRequiredSigners({ agreementType, buyerOffer }),
      completed_signers: [],
      created_at: iso(now),
    },
  };
}

/**
 * Who must sign, per agreement type.
 *
 * One buyer email is not "all signatures required": every one of these
 * structures needs our entity as a counterparty, and an assignment needs the
 * assignee. The agreement is executed only when EVERY required role completes.
 */
export function resolveRequiredSigners({ agreementType = null, buyerOffer = null } = {}) {
  const buyerRole = { role: "buyer", buyer_id: clean(buyerOffer?.buyer_id) || null, required: true };
  const usRole = { role: "assignor", required: true };
  switch (agreementType) {
    case COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT:
      return [usRole, { ...buyerRole, role: "assignee" }];
    case COMMITMENT_TYPES.PURCHASE_AGREEMENT:
      return [{ role: "seller_of_record", required: true }, buyerRole];
    case COMMITMENT_TYPES.NOVATION_AGREEMENT:
      return [usRole, buyerRole, { role: "original_seller", required: true }];
    default:
      return [buyerRole];
  }
}

/**
 * Normalize a provider envelope event into an agreement status transition.
 * Pure — no DB, no provider call. Monotonic, so a replayed or late lower-signal
 * event is a no-op rather than a regression.
 */
export function resolveAgreementStatusTransition({
  normalized_status = null,
  current_status = null,
} = {}) {
  const target = PROVIDER_STATUS_MAP[clean(normalized_status)];
  if (!target) return { ok: false, reason: "unmapped_provider_status" };

  const current = clean(current_status);
  if (TERMINAL_AGREEMENT_STATUSES.has(current)) {
    return { ok: true, apply: false, reason: AGREEMENT_DENIALS.AGREEMENT_TERMINAL, target };
  }
  if (TERMINAL_AGREEMENT_STATUSES.has(target)) return { ok: true, apply: true, target };

  const currentRank = STATUS_RANK[current] ?? 0;
  const targetRank = STATUS_RANK[target] ?? 0;
  if (targetRank <= currentRank) return { ok: true, apply: false, reason: "status_not_advancing", target };
  return { ok: true, apply: true, target };
}

/**
 * Is this agreement FULLY EXECUTED, on evidence?
 *
 * Requires the provider to report completion AND every required signer to have
 * completed. A buyer signing while our counterparty has not is `buyer_signed`,
 * which is not execution and cannot commit anyone.
 */
export function resolveAgreementExecution({ agreement = null, envelope = null } = {}) {
  if (!agreement?.agreement_id) {
    return { executed: false, reason: AGREEMENT_DENIALS.NOT_FULLY_EXECUTED };
  }
  const status = clean(agreement.status);
  if (TERMINAL_AGREEMENT_STATUSES.has(status)) {
    return { executed: false, reason: status === AGREEMENT_STATUS.SUPERSEDED
      ? AGREEMENT_DENIALS.AGREEMENT_SUPERSEDED
      : AGREEMENT_DENIALS.AGREEMENT_TERMINAL };
  }

  // The envelope must be THIS agreement's envelope.
  const envelopeId = clean(envelope?.envelope_id);
  if (envelopeId && clean(agreement.provider_envelope_id) && envelopeId !== clean(agreement.provider_envelope_id)) {
    return { executed: false, reason: AGREEMENT_DENIALS.ENVELOPE_MISMATCH };
  }

  const providerComplete = clean(envelope?.normalized_status) === "Completed"
    || status === AGREEMENT_STATUS.FULLY_EXECUTED;
  if (!providerComplete) {
    return { executed: false, reason: AGREEMENT_DENIALS.NOT_FULLY_EXECUTED, status };
  }

  const required = (Array.isArray(agreement.required_signers) ? agreement.required_signers : [])
    .filter((s) => s?.required !== false)
    .map((s) => clean(s.role));
  const completed = new Set(
    (Array.isArray(envelope?.completed_signers) ? envelope.completed_signers
      : Array.isArray(agreement.completed_signers) ? agreement.completed_signers : [])
      .map((s) => clean(typeof s === "string" ? s : s?.role)),
  );
  const outstanding = required.filter((role) => !completed.has(role));
  if (outstanding.length) {
    return { executed: false, reason: AGREEMENT_DENIALS.SIGNERS_INCOMPLETE, outstanding_signers: outstanding };
  }

  return {
    executed: true,
    reason: "buyer_agreement_fully_executed",
    executed_at: iso(envelope?.completed_at) || iso(agreement.executed_at) || null,
    provider_envelope_id: envelopeId || clean(agreement.provider_envelope_id) || null,
  };
}

/**
 * Normalize an executed agreement into the DOMAIN evidence S8 requires.
 *
 * S8 never inspects DocuSign. This is the seam: provider truth in, domain
 * evidence out, with a deterministic commitment_event_id so a duplicate webhook
 * produces the same event rather than a second one.
 */
export function buildBuyerCommitmentEvent({ agreement = null, execution = null, buyerOffer = null } = {}) {
  if (!execution?.executed) {
    return { ok: false, reason: execution?.reason ?? AGREEMENT_DENIALS.NOT_FULLY_EXECUTED };
  }

  // Terms drift: the offer must still be the one the buyer signed against.
  if (buyerOffer && clean(buyerOffer.terms_hash) && clean(agreement.buyer_terms_hash) !== clean(buyerOffer.terms_hash)) {
    return { ok: false, reason: AGREEMENT_DENIALS.TERMS_DRIFTED };
  }
  if (buyerOffer && clean(buyerOffer.buyer_offer_id) !== clean(agreement.buyer_offer_id)) {
    return { ok: false, reason: AGREEMENT_DENIALS.BINDING_MISMATCH };
  }

  const eventId = clean(agreement.commitment_event_id) || deterministicCommitmentEventId(agreement);
  return {
    ok: true,
    commitment_event_id: eventId,
    agreement_id: agreement.agreement_id,
    buyer_offer_id: agreement.buyer_offer_id,
    buyer_id: agreement.buyer_id,
    property_id: agreement.property_id,
    opportunity_id: agreement.opportunity_id,
    terms_hash: agreement.buyer_terms_hash,
    commitment_type: agreement.agreement_type,
    executed_at: execution.executed_at,
    provider_execution_evidence: {
      provider: agreement.provider || "docusign",
      provider_envelope_id: execution.provider_envelope_id,
      template_id: agreement.template_id ?? null,
      template_version: agreement.template_version ?? null,
    },
    /** The agreement creates the EMD OBLIGATION. Receipt is S9's to prove. */
    emd_terms: money(agreement.emd_terms),
    emd_received: false,
  };
}

function deterministicCommitmentEventId(agreement) {
  return `buyer_commitment:${crypto
    .createHash("sha256")
    .update(JSON.stringify([
      clean(agreement.agreement_id),
      clean(agreement.buyer_offer_id),
      clean(agreement.buyer_terms_hash),
    ]))
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Seller-side validity is re-checked at execution, not only at generation.
 *
 * A buyer envelope can complete days after it was sent. If the seller contract
 * was cancelled in between, the deal is gone and a late completion must not
 * resurrect it.
 */
export function assertSellerSideStillValid({ dispositionAuthorization = null } = {}) {
  if (!dispositionAuthorization?.authorized || dispositionAuthorization.external_activity_permitted !== true) {
    return { valid: false, reason: AGREEMENT_DENIALS.SELLER_CONTRACT_INVALIDATED };
  }
  return { valid: true, reason: "seller_deal_valid" };
}

/** Projection onto the closing case. Derivative — never the authority. */
export function buildClosingCaseProjection({ agreement = null, buyerOffer = null } = {}) {
  return {
    buyer_id: clean(agreement?.buyer_id) || null,
    buyer_price: money(agreement?.buyer_price),
    buyer_emd: money(agreement?.emd_terms),
    assignment_id: clean(agreement?.agreement_id) || null,
    disposition_status: "buyer_committed",
    // Deliberately absent: emd received/verified. An agreement creates the
    // obligation; only S9 may record that money arrived.
  };
}

export default authorizeBuyerAgreementGeneration;
