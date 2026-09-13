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
//   * `advance-closing-workflow.js` goes formal_contract -> under_contract ->
//     prepared_to_close -> closed and never produces 'disposition' at all. Its
//     `under_contract` means "the SELLER contract is fully executed", which is
//     NOT the canonical S8 meaning ("under contract / buyer selection"). That
//     collision is reported, not silently redefined here.
//   * Production: 0 opportunities at S7-S9, 0 closing cases at disposition, 0
//     with a buyer, 0 with a disposition_status. 350 buyer_match_candidates
//     across 23 runs — intelligence only, carrying no commitment.
//
// So S7 is an authority question, not a subsystem to build. This module decides
// entry and pins the buyer ladder; it writes nothing and sends nothing.

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

export const DISPOSITION_DENIALS = Object.freeze({
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
export function authorizeDisposition({
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
  buyerOffers = [],
  economics = null,
} = {}) {
  const authorization = authorizeDisposition({ opportunity, acceptedOffer, closingCase });
  if (!authorization.authorized) return { ok: false, reason: authorization.reason, evidence: authorization.evidence };

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
    disposition_state: "active",
  };
}

export default authorizeDisposition;
