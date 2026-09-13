// ─── disposition-authority.js ───────────────────────────────────────────────
// THE S7 gate: when may an accepted seller deal enter disposition, and what may
// buyer-side activity do to the acquisition stage (nothing).
//
// WHAT S7 MEANS
//   The seller-side acquisition is contract-authorized, so the deal may enter
//   disposition: buyer marketing, buyer qualification, buyer offers.
//
// WHAT S7 DOES NOT MEAN
//   buyer selected · buyer accepted · assignment signed · buyer EMD received ·
//   title opened · closing scheduled · sold · closed. All downstream.
//
//   disposition_activity != buyer_commitment
//   buyer_interest       != selected_buyer
//   selected_buyer       != closed_transaction
//
// ARCHAEOLOGY (what already exists, 2026-09-13):
//   * `closing_cases` IS the durable disposition/closing object. It already
//     carries buyer_id, assignment_id, buyer_price, assignment_fee, buyer_emd,
//     disposition_status, and `universal_stage` whose CHECK constraint already
//     permits 'disposition'. It is unique per opportunity
//     (uq_closing_cases_opportunity) with a deterministic closing_case_id. No
//     new table is created here.
//   * There is NO buyer-offer ledger in Supabase: no deal_offers, no
//     transactions, no assignment table, no POF table. The buyer-blast /
//     buyer-match / offer machinery in lib/domain/buyers is Podio-native, and
//     Podio is dead in production.
//   * `disposition_status` has ZERO writers anywhere in the codebase.
//   * Two writers mapped a fully executed SELLER contract to
//     `universal_stage = under_contract` (advance-closing-workflow.js and
//     reconcile-closing-case-from-envelope.js). Under the canonical V2 model
//     `under_contract` is S8 — under contract with a SELECTED BUYER. A seller
//     signature is not a buyer commitment, and that mapping skipped disposition
//     entirely. Both now write `disposition`. Production carried ZERO
//     `under_contract` rows anywhere (opportunities, closing cases, thread
//     states, lead-state events, opportunity history), so the correction
//     reinterprets no data.
//   * Production: 0 opportunities at S7-S9, 0 closing cases at disposition, 0
//     with a buyer, 0 with a disposition_status. 350 buyer_match_candidates
//     across 23 runs — intelligence only, carrying no commitment.
//
// TWO LEVELS, NOT ONE BOOLEAN
//   Seller ACCEPTANCE authorizes contract preparation and internal work.
//   Seller contract FULLY EXECUTED authorizes ACTIVE, buyer-facing disposition.
//   Nothing external — no buyer SMS, email, publication or campaign — may
//   happen in between. A verbal yes is not a signed contract, and marketing a
//   deal we have not actually secured is the failure this separation prevents.
//
// This module decides entry and pins the buyer ladder; it writes nothing and
// sends nothing.

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

/** Canonical stage rank; S7 needs only the S6 floor. */
const STAGE_ORDER = Object.freeze([
  "ownership_confirmation", "offer_interest", "asking_price", "property_condition",
  "offer", "formal_contract", "disposition", "under_contract", "prepared_to_close", "closed",
]);
const STAGE_RANK = new Map(STAGE_ORDER.map((s, i) => [s, i]));
const FORMAL_CONTRACT_RANK = STAGE_RANK.get("formal_contract");

/**
 * Seller contract states, in the order the DocuSign reconciler produces them.
 * `reconcile-closing-case-from-envelope.js` is the canonical source: the
 * envelope id is the resolution key and the ladder is rank-gated so a status
 * can never regress.
 */
export const SELLER_CONTRACT_STATES = Object.freeze({
  TERMS_ACCEPTED: "terms_accepted",     // S6. No contract object yet.
  DRAFT: "draft",                        // closing case created
  SENT_FOR_SIGNATURE: "sent_for_signature",
  VIEWED: "viewed",
  SELLER_SIGNED: "seller_signed",        // ONE signer. Not executed.
  BUYER_SIGNED: "buyer_signed",
  FULLY_EXECUTED: "fully_executed",      // envelope Completed
  DECLINED: "declined",
  CANCELLED: "cancelled",
});

/** Only this state authorizes ACTIVE disposition. */
const EXECUTED_CONTRACT_STATES = new Set([SELLER_CONTRACT_STATES.FULLY_EXECUTED]);

/**
 * Holds. Built from vocabulary that already exists on these rows rather than a
 * new hold table: a paused/terminal opportunity, an approval that has not been
 * granted, or a terminal contract state.
 */
export const DISPOSITION_HOLDS = Object.freeze({
  OPPORTUNITY_PAUSED: "opportunity_paused",
  OPPORTUNITY_TERMINAL: "opportunity_terminal",
  APPROVAL_PENDING: "approval_pending",
  CONTRACT_TERMINAL: "contract_terminal",
  OPERATOR_HOLD: "operator_hold",
});

export const DISPOSITION_STATES = Object.freeze({
  /** S6. Internal work only — no buyer may learn this deal exists. */
  PREPARATION: "preparation",
  /** Executed and clear. S7, buyer-facing activity permitted. */
  ACTIVE: "active",
  /** Executed but blocked. S7-ready, nothing external. */
  HELD: "held",
  /** Seller deal invalidated. No new buyer activity. */
  CANCELLED: "cancelled",
  /** Not authorized at all. */
  NOT_AUTHORIZED: "not_authorized",
});

export const DISPOSITION_DENIALS = Object.freeze({
  SELLER_CONTRACT_NOT_EXECUTED: "seller_contract_not_fully_executed",
  NO_CLOSING_CASE: "no_closing_case",
  NO_EXECUTION_EVIDENCE: "no_contract_execution_evidence",
  NO_OPPORTUNITY: "no_opportunity",
  STAGE_BELOW_FORMAL_CONTRACT: "canonical_stage_below_formal_contract",
  NO_ACCEPTED_OFFER: "no_accepted_seller_offer",
  ACCEPTED_OFFER_NOT_PRESENTED: "accepted_offer_never_presented",
  ACCEPTED_OFFER_INCOMPLETE: "accepted_offer_missing_terms_identity",
  OFFER_BELONGS_ELSEWHERE: "accepted_offer_belongs_to_other_deal",
  SELLER_DEAL_VOIDED: "seller_deal_voided_or_cancelled",
  OPPORTUNITY_TERMINAL: "opportunity_status_terminal",
});

/**
 * Seller-side states that invalidate disposition authority. A voided offer or a
 * cancelled contract does not delete history; it withdraws permission to keep
 * marketing the deal to buyers.
 */
const VOIDING_CONTRACT_STATUSES = new Set(["cancelled", "void", "voided", "terminated", "rescinded"]);
const TERMINAL_OPPORTUNITY_STATUSES = new Set(["lost", "dead", "suppressed", "archived", "cancelled"]);

/**
 * THE S7 ENTRY GATE.
 *
 * Reads the CANONICAL acquisition stage and the accepted seller-offer
 * authority. It deliberately accepts no thread-projection input at all:
 * `inbox_thread_state.lifecycle_stage` is a mirror that has already been proven
 * able to outrun canonical (thread +19549807015 sat at formal_contract for two
 * days after canonical was corrected back to asking_price), so it cannot be a
 * parameter here — not even an advisory one.
 *
 * @param {object} args
 * @param {object} args.opportunity    acquisition_opportunities row
 * @param {object} args.acceptedOffer  seller_offers row with status 'accepted'
 * @param {object} [args.closingCase]  existing closing_cases row, if any
 * @returns {{authorized, reason, evidence, disposition_case_id}}
 */
export function authorizeDispositionPreparation({
  opportunity = null,
  acceptedOffer = null,
  closingCase = null,
} = {}) {
  const deny = (reason, evidence = {}) => ({
    authorized: false,
    reason,
    evidence,
    disposition_case_id: null,
  });

  if (!opportunity?.id) return deny(DISPOSITION_DENIALS.NO_OPPORTUNITY);

  const stage = clean(opportunity.acquisition_stage);
  const rank = STAGE_RANK.get(stage);
  if (!Number.isInteger(rank) || rank < FORMAL_CONTRACT_RANK) {
    return deny(DISPOSITION_DENIALS.STAGE_BELOW_FORMAL_CONTRACT, { canonical_stage: stage || null });
  }

  if (TERMINAL_OPPORTUNITY_STATUSES.has(clean(opportunity.opportunity_status).toLowerCase())) {
    return deny(DISPOSITION_DENIALS.OPPORTUNITY_TERMINAL, { opportunity_status: opportunity.opportunity_status });
  }

  // The seller-side basis. S6 proved acceptance; S7 re-reads the durable row
  // rather than trusting that the stage alone still implies it — the three
  // repaired legacy rows all carried stage formal_contract with no offer at all.
  if (!acceptedOffer?.offer_id || clean(acceptedOffer.status).toLowerCase() !== "accepted") {
    return deny(DISPOSITION_DENIALS.NO_ACCEPTED_OFFER, { offer_status: acceptedOffer?.status ?? null });
  }
  if (!iso(acceptedOffer.sent_at)) {
    return deny(DISPOSITION_DENIALS.ACCEPTED_OFFER_NOT_PRESENTED);
  }
  const missing = [];
  if (!clean(acceptedOffer.terms_hash)) missing.push("terms_hash");
  if (!money(acceptedOffer.accepted_price ?? acceptedOffer.purchase_price)) missing.push("accepted_price");
  if (!iso(acceptedOffer.accepted_at)) missing.push("accepted_at");
  if (!clean(acceptedOffer.acceptance_event_id)) missing.push("acceptance_event_id");
  if (missing.length) {
    return deny(DISPOSITION_DENIALS.ACCEPTED_OFFER_INCOMPLETE, { missing_terms: missing });
  }

  // Context binding: the offer, the opportunity and the property are one deal.
  if (clean(acceptedOffer.opportunity_id) !== clean(opportunity.id)) {
    return deny(DISPOSITION_DENIALS.OFFER_BELONGS_ELSEWHERE, {
      offer_opportunity_id: acceptedOffer.opportunity_id,
      opportunity_id: opportunity.id,
    });
  }
  const propertyId = clean(opportunity.primary_property_id);
  if (propertyId && clean(acceptedOffer.property_id) && clean(acceptedOffer.property_id) !== propertyId) {
    return deny(DISPOSITION_DENIALS.OFFER_BELONGS_ELSEWHERE, {
      offer_property_id: acceptedOffer.property_id,
      opportunity_property_id: propertyId,
    });
  }

  // A voided offer or a cancelled contract withdraws permission. The $4,100
  // rent-as-price deal is exactly this shape: offer voided, closing case
  // contract_status 'cancelled', history intact.
  if (acceptedOffer.metadata?.voided === true) {
    return deny(DISPOSITION_DENIALS.SELLER_DEAL_VOIDED, { voided_at: acceptedOffer.metadata?.voided_at ?? null });
  }
  if (closingCase && VOIDING_CONTRACT_STATUSES.has(clean(closingCase.contract_status).toLowerCase())) {
    return deny(DISPOSITION_DENIALS.SELLER_DEAL_VOIDED, { contract_status: closingCase.contract_status });
  }
  if (closingCase && closingCase.provenance?.voided === true) {
    return deny(DISPOSITION_DENIALS.SELLER_DEAL_VOIDED, { closing_case_voided: true });
  }

  return {
    authorized: true,
    reason: "seller_deal_contract_authorized",
    /** Internal work only. Externally silent until the contract executes. */
    disposition_state: DISPOSITION_STATES.PREPARATION,
    external_activity_permitted: false,
    evidence: {
      canonical_stage: stage,
      accepted_offer_id: acceptedOffer.offer_id,
      accepted_terms_hash: acceptedOffer.terms_hash,
      accepted_at: iso(acceptedOffer.accepted_at),
    },
    // Deterministic and already unique per opportunity in the database, so a
    // repeated activation converges on the same row instead of a second one.
    disposition_case_id: resolveDispositionCaseId(opportunity.id),
  };
}

/**
 * Holds that block ACTIVE disposition without invalidating the deal.
 *
 * Built from vocabulary already on these rows. A hold is not a failure state:
 * the deal is S7-ready and simply stays internally silent until it clears.
 */
export function resolveDispositionHolds({ opportunity = null, closingCase = null } = {}) {
  const holds = [];
  const status = clean(opportunity?.opportunity_status).toLowerCase();
  if (status === "paused") holds.push(DISPOSITION_HOLDS.OPPORTUNITY_PAUSED);
  if (TERMINAL_OPPORTUNITY_STATUSES.has(status)) holds.push(DISPOSITION_HOLDS.OPPORTUNITY_TERMINAL);

  const approval = clean(opportunity?.approval_state).toLowerCase();
  if (approval && !["approved", "auto_approved", "not_required"].includes(approval)) {
    holds.push(DISPOSITION_HOLDS.APPROVAL_PENDING);
  }
  if (opportunity?.operator_hold === true || opportunity?.legal_hold === true) {
    holds.push(DISPOSITION_HOLDS.OPERATOR_HOLD);
  }

  const contractStatus = clean(closingCase?.contract_status).toLowerCase();
  if (contractStatus === "declined" || VOIDING_CONTRACT_STATUSES.has(contractStatus)) {
    holds.push(DISPOSITION_HOLDS.CONTRACT_TERMINAL);
  }
  return holds;
}

/**
 * Is the SELLER contract fully executed, on evidence rather than a flag?
 *
 * A UI toggle is not enough, and none of these is execution: contract sent,
 * one signer signed, the seller asked for a contract, the seller accepted
 * terms, a closing case exists. The canonical source is the DocuSign envelope
 * reconciled by reconcile-closing-case-from-envelope.js — the envelope id is
 * the resolution key and `Completed` is the only status that produces
 * `fully_executed`, on a rank ladder that cannot regress.
 */
export function resolveSellerContractExecution({ closingCase = null, executionEvidence = null } = {}) {
  if (!closingCase) {
    return { executed: false, reason: DISPOSITION_DENIALS.NO_CLOSING_CASE, evidence: null };
  }
  const status = clean(closingCase.contract_status).toLowerCase();
  if (!EXECUTED_CONTRACT_STATES.has(status)) {
    return {
      executed: false,
      reason: DISPOSITION_DENIALS.SELLER_CONTRACT_NOT_EXECUTED,
      evidence: { contract_status: status || null },
    };
  }

  // `fully_executed` must be traceable to the event that produced it.
  const envelopeId = clean(closingCase.docusign_envelope_id) || clean(executionEvidence?.envelope_id);
  const signedAt = iso(closingCase.contract_signed_date) || iso(executionEvidence?.completed_at);
  const milestone = clean(executionEvidence?.milestone_type);
  if (!envelopeId && !signedAt && milestone !== "contract_fully_executed") {
    return {
      executed: false,
      reason: DISPOSITION_DENIALS.NO_EXECUTION_EVIDENCE,
      evidence: { contract_status: status },
    };
  }

  return {
    executed: true,
    reason: "seller_contract_fully_executed",
    evidence: {
      contract_status: status,
      docusign_envelope_id: envelopeId || null,
      contract_signed_date: signedAt,
      execution_milestone: milestone || null,
    },
  };
}

/**
 * ACTIVE disposition: buyer-facing activity is permitted.
 *
 * Requires everything preparation requires, PLUS a fully executed seller
 * contract, PLUS no hold. Activation is automatic once those hold — a normal
 * valid deal does not wait on an operator click — but a hold keeps it
 * internally silent rather than letting it out.
 */
export function authorizeActiveDisposition({
  opportunity = null,
  acceptedOffer = null,
  closingCase = null,
  executionEvidence = null,
} = {}) {
  const preparation = authorizeDispositionPreparation({ opportunity, acceptedOffer, closingCase });
  if (!preparation.authorized) {
    return { ...preparation, disposition_state: DISPOSITION_STATES.NOT_AUTHORIZED, external_activity_permitted: false };
  }

  const execution = resolveSellerContractExecution({ closingCase, executionEvidence });
  if (!execution.executed) {
    return {
      authorized: false,
      reason: execution.reason,
      disposition_state: DISPOSITION_STATES.PREPARATION,
      external_activity_permitted: false,
      evidence: { ...preparation.evidence, ...(execution.evidence || {}) },
      disposition_case_id: preparation.disposition_case_id,
    };
  }

  const holds = resolveDispositionHolds({ opportunity, closingCase });
  if (holds.length) {
    return {
      authorized: false,
      reason: "disposition_held",
      disposition_state: DISPOSITION_STATES.HELD,
      external_activity_permitted: false,
      holds,
      evidence: { ...preparation.evidence, ...execution.evidence },
      disposition_case_id: preparation.disposition_case_id,
    };
  }

  return {
    authorized: true,
    reason: "seller_contract_fully_executed",
    disposition_state: DISPOSITION_STATES.ACTIVE,
    external_activity_permitted: true,
    holds: [],
    /** S7. Never `under_contract`, which is S8 buyer-side commitment. */
    canonical_stage: "disposition",
    evidence: { ...preparation.evidence, ...execution.evidence },
    disposition_case_id: preparation.disposition_case_id,
  };
}

/** Reuses the existing closing-case identity. One per opportunity, DB-unique. */
export function resolveDispositionCaseId(opportunityId) {
  const id = clean(opportunityId);
  return id ? `closing:${id}` : null;
}

// ─── Buyer ladder ───────────────────────────────────────────────────────────
//
// Six distinct things that are routinely conflated. Only the last may move the
// acquisition stage, and it belongs to S8, which is not implemented here.

export const BUYER_ENGAGEMENT = Object.freeze({
  ELIGIBLE: "eligible",        // fits the buy box
  MATCHED: "matched",          // a match run surfaced them
  INTERESTED: "interested",    // asked for details
  OFFER_SUBMITTED: "offer_submitted",
  SELECTED: "selected",        // canonical selection authority chose them (S8)
  CONTRACTED: "contracted",    // assignment executed (S8+)
});

const ENGAGEMENT_RANK = new Map([
  [BUYER_ENGAGEMENT.ELIGIBLE, 0],
  [BUYER_ENGAGEMENT.MATCHED, 1],
  [BUYER_ENGAGEMENT.INTERESTED, 2],
  [BUYER_ENGAGEMENT.OFFER_SUBMITTED, 3],
  [BUYER_ENGAGEMENT.SELECTED, 4],
  [BUYER_ENGAGEMENT.CONTRACTED, 5],
]);

/**
 * What acquisition stage does this buyer engagement justify?
 *
 * Everything up to and including a submitted offer is disposition ACTIVITY and
 * keeps the deal at S7. A buyer offer is a proposal to us; it is not our
 * decision. Only canonical selection authority — which is S8's job, not this
 * module's — converts it into a commitment.
 */
export function resolveBuyerEngagementStage(level) {
  const key = clean(level).toLowerCase();
  const rank = ENGAGEMENT_RANK.get(key);
  if (!Number.isInteger(rank)) {
    return { stage: "disposition", advances_beyond_s7: false, reason: "unknown_buyer_engagement" };
  }
  if (rank <= ENGAGEMENT_RANK.get(BUYER_ENGAGEMENT.OFFER_SUBMITTED)) {
    return { stage: "disposition", advances_beyond_s7: false, reason: "disposition_activity_is_not_buyer_commitment" };
  }
  return {
    stage: "under_contract",
    advances_beyond_s7: true,
    reason: "requires_canonical_buyer_selection_authority",
    /** S8 owns this. S7 may never perform it. */
    requires_s8_authority: true,
  };
}

// ─── Proof of funds ─────────────────────────────────────────────────────────
//
// Truthful labels. `attached` is a file a buyer uploaded; it is not a finding
// about that buyer. There is no POF table and no verification pipeline in this
// system today, so `VERIFIED` exists in the vocabulary but is not reachable
// automatically — and saying so is the point.

export const POF_STATES = Object.freeze({
  ABSENT: "absent",
  ATTACHED: "attached",
  REVIEWED: "reviewed",
  VERIFIED: "verified",
  INSUFFICIENT: "insufficient",
  EXPIRED: "expired",
});

export function resolvePofStatus({
  document_present = false,
  reviewed_by = null,
  verified_by = null,
  verified_at = null,
  expires_at = null,
  amount = null,
  required_amount = null,
  now = new Date(),
} = {}) {
  if (!document_present) return { status: POF_STATES.ABSENT, buyer_verified: false, reason: "no_document" };

  const expiry = iso(expires_at);
  if (expiry && iso(now) && expiry < iso(now)) {
    return { status: POF_STATES.EXPIRED, buyer_verified: false, reason: "document_expired" };
  }

  const need = money(required_amount);
  const have = money(amount);
  if (need !== null && have !== null && have < need) {
    return { status: POF_STATES.INSUFFICIENT, buyer_verified: false, reason: "amount_below_requirement" };
  }

  if (clean(verified_by) && iso(verified_at)) {
    return { status: POF_STATES.VERIFIED, buyer_verified: true, reason: "human_verified" };
  }
  if (clean(reviewed_by)) {
    return { status: POF_STATES.REVIEWED, buyer_verified: false, reason: "reviewed_not_verified" };
  }
  // The important negative: a file on the record verifies nothing.
  return { status: POF_STATES.ATTACHED, buyer_verified: false, reason: "attached_not_verified" };
}

// ─── Buyer-facing privacy ───────────────────────────────────────────────────

/**
 * Deny-by-default projection of a deal for buyer-facing surfaces.
 *
 * There is no redaction helper in this codebase today, and the only
 * buyer-facing package builder is Podio-native and dead — so the safe primitive
 * is an allowlist, not a blocklist. Seller identity, seller contact details,
 * conversation history and our internal acquisition reasoning are never
 * projected: a buyer needs the asset and the price, not how motivated the
 * seller is or what we were willing to pay.
 */
const BUYER_FACING_ALLOWLIST = Object.freeze([
  "property_id", "property_address_full", "property_address_city", "property_address_state",
  "property_address_zip", "property_type", "units_count", "building_square_feet",
  "total_bedrooms", "total_baths", "year_built", "lot_square_feet",
  "buyer_price", "earnest_money_required", "closing_date", "occupancy_status",
  "estimated_repairs", "disposition_status",
]);

export const BUYER_FORBIDDEN_FIELDS = Object.freeze([
  "seller_phone", "seller_email", "seller_name", "seller_display_name", "owner_name",
  "master_owner_id", "prospect_id", "thread_key", "canonical_e164",
  "messages", "conversation", "negotiation_state", "seller_facts", "motivation_score",
  "accepted_price", "recommended_offer", "authorized_offer_ceiling", "investor_ceiling_mid",
  "expected_assignment_fee", "assignment_fee", "ade_snapshot", "evidence",
]);

export function projectBuyerFacingDeal(source = {}) {
  const out = {};
  for (const field of BUYER_FACING_ALLOWLIST) {
    if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  }
  return out;
}

// ─── S8 handoff ─────────────────────────────────────────────────────────────

/**
 * Everything S8 consumes. Structured, so buyer selection never has to reread a
 * seller conversation to learn the acquisition basis.
 */
export function buildDispositionHandoff({
  opportunity = null,
  acceptedOffer = null,
  closingCase = null,
  executionEvidence = null,
  buyerOffers = [],
  economics = null,
} = {}) {
  const authorization = authorizeActiveDisposition({ opportunity, acceptedOffer, closingCase, executionEvidence });
  if (!authorization.authorized) {
    return {
      ok: false,
      reason: authorization.reason,
      disposition_state: authorization.disposition_state,
      holds: authorization.holds ?? [],
      evidence: authorization.evidence,
    };
  }

  const offers = (Array.isArray(buyerOffers) ? buyerOffers : []).map((offer) => ({
    buyer_offer_id: clean(offer.id ?? offer.buyer_offer_id) || null,
    buyer_id: clean(offer.buyer_id) || null,
    buyer_name: clean(offer.buyer_name) || null,
    price: money(offer.price ?? offer.purchase_price),
    earnest_money: money(offer.earnest_money),
    terms: offer.terms ?? null,
    submitted_at: iso(offer.submitted_at ?? offer.created_at),
    pof: resolvePofStatus(offer.pof || {}),
    // Every buyer offer enters the handoff as a PROPOSAL. Nothing in this
    // structure can mark one selected — that is S8's decision to make.
    engagement: BUYER_ENGAGEMENT.OFFER_SUBMITTED,
  }));

  return {
    ok: true,
    disposition_case_id: authorization.disposition_case_id,
    acquisition_opportunity_id: clean(opportunity.id),
    property_id: clean(opportunity.primary_property_id) || clean(acceptedOffer.property_id) || null,
    /** Seller-side acquisition basis, from S6 — never re-derived from messages. */
    acquisition_basis: {
      accepted_offer_id: acceptedOffer.offer_id,
      accepted_offer_version: acceptedOffer.offer_version ?? null,
      accepted_terms_hash: acceptedOffer.terms_hash,
      accepted_price: money(acceptedOffer.accepted_price ?? acceptedOffer.purchase_price),
      accepted_at: iso(acceptedOffer.accepted_at),
      acceptance_event_id: acceptedOffer.acceptance_event_id,
      strategy: clean(acceptedOffer.strategy) || "cash",
      closing_date: acceptedOffer.closing_date ?? null,
      emd_amount: money(acceptedOffer.emd_amount),
    },
    contract_state: {
      closing_case_id: closingCase?.closing_case_id ?? authorization.disposition_case_id,
      contract_status: closingCase?.contract_status ?? null,
      universal_stage: closingCase?.universal_stage ?? null,
    },
    /** Current economics from the Decision Engine. Never properties.cash_offer. */
    economics: economics
      ? {
        source: "property_acquisition_scores",
        valuation_mid: money(economics.valuation_mid),
        estimated_repairs: money(economics.estimated_repairs),
        expected_assignment_fee: money(economics.expected_assignment_fee),
        investor_ceiling_mid: money(economics.investor_ceiling_mid),
      }
      : { source: "decision_engine_not_run", valuation_mid: null },
    buyer_offers: offers,
    buyer_offer_count: offers.length,
    /** No buyer is selected in S7, by construction. */
    selected_buyer_id: null,
    seller_contract_status: SELLER_CONTRACT_STATES.FULLY_EXECUTED,
    seller_contract_execution: authorization.evidence,
    disposition_status: DISPOSITION_STATES.ACTIVE,
    disposition_state: DISPOSITION_STATES.ACTIVE,
  };
}

export default authorizeDispositionPreparation;
