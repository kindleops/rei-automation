// ─── buyer-commitment-authority.js ──────────────────────────────────────────
// THE S8 boundary: what turns a buyer into a COMMITTED buyer, and therefore
// what may set `under_contract`.
//
// WHAT S8 MEANS
//   This deal has one canonically committed buyer.
//
// WHAT S8 DOES NOT MEAN
//   seller contract executed (that is S7) · buyer matched · buyer interested ·
//   buyer opened the deal · buyer uploaded POF · buyer submitted an offer ·
//   buyer is the highest offer · operator viewed the buyer · buyer is the
//   "best fit".
//
// THE DISTINCTION THIS MODULE EXISTS FOR
//
//   SELECTED   we have chosen the buyer we intend to transact with.
//   COMMITTED  that buyer is durably bound to identifiable terms.
//
// They are NOT the same, and the system models them separately, because a
// selected buyer who can still walk away without consequence is not "under
// contract". Choosing someone is our decision; being bound is theirs. So
// selection stays at S7 with commitment_status `agreement_required`, and only
// durable buyer-side commitment evidence authorizes S8.
//
// ARCHAEOLOGY (2026-09-13). There is no buyer-side agreement system in this
// product yet: no assignment agreement, no buyer purchase agreement, no buyer
// DocuSign path (the envelope code is seller-contract only), and no EMD receipt
// tracking. `selected_buyer` exists solely as a Podio field id, and Podio is
// dead. `closing_cases` carries buyer_id / buyer_price / buyer_emd /
// assignment_id / assignment_fee / disposition_status — all NULL on every row,
// with zero writers anywhere in the codebase. Buyer identity is
// `buyer_entities_v2` (26,390 rows); `buyer_match_candidates` (350 rows) is
// read-only intelligence.
//
// So this module builds the authority SEAM and the state model, and
// deliberately cannot manufacture commitment: with no buyer-agreement
// infrastructure, `authorizeBuyerCommitment` denies every real deal today with
// `buyer_agreement_required`. That is the honest state of the product, and it
// is reported rather than papered over.
//
// THIS MODULE WRITES NOTHING AND SENDS NOTHING.

import crypto from "node:crypto";

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

export const BUYER_OFFER_STATUS = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  WITHDRAWN: "withdrawn",
  REJECTED: "rejected",
  SELECTED: "selected",
  SUPERSEDED: "superseded",
  COMMITTED: "committed",
  DEFAULTED: "defaulted",
  TERMINATED: "terminated",
});

export const BUYER_COMMITMENT_STATUS = Object.freeze({
  NONE: "none",
  AGREEMENT_REQUIRED: "agreement_required",
  AGREEMENT_SENT: "agreement_sent",
  COMMITTED: "committed",
  DEFAULTED: "defaulted",
  TERMINATED: "terminated",
  REPLACEMENT_REQUIRED: "replacement_required",
});

/**
 * EMD is terms until it is receipt. A number in `emd_amount` says what the
 * buyer agreed to send, not that anything arrived — the distinction S9 will
 * depend on entirely.
 */
export const EMD_STATUS = Object.freeze({
  NOT_REQUIRED: "not_required",
  REQUIRED: "required",
  PROMISED: "promised",
  DUE: "due",
  RECEIVED: "received",
  VERIFIED: "verified",
  FAILED: "failed",
  REFUNDED: "refunded",
});

export const BUYER_POF_STATUS = Object.freeze({
  NOT_PROVIDED: "not_provided",
  ATTACHED: "attached",
  REVIEW_PENDING: "review_pending",
  VERIFIED: "verified",
  INSUFFICIENT: "insufficient",
  EXPIRED: "expired",
  REJECTED: "rejected",
});

/** Buyer-side agreement types. Commitment evidence varies by structure. */
export const COMMITMENT_TYPES = Object.freeze({
  ASSIGNMENT_AGREEMENT: "assignment_agreement",
  PURCHASE_AGREEMENT: "purchase_agreement",
  NOVATION_AGREEMENT: "novation_agreement",
  OTHER: "other",
});

/**
 * Which agreement binds a buyer, per disposition structure. S8 must not assume
 * every deal is an assignment.
 */
const COMMITMENT_BY_STRATEGY = Object.freeze({
  assignment: COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT,
  double_close: COMMITMENT_TYPES.PURCHASE_AGREEMENT,
  novation: COMMITMENT_TYPES.NOVATION_AGREEMENT,
});

export const BUYER_DENIALS = Object.freeze({
  NO_BUYER_OFFER: "no_buyer_offer",
  OFFER_NOT_SUBMITTED: "buyer_offer_not_submitted",
  OFFER_WITHDRAWN: "buyer_offer_withdrawn",
  OFFER_REJECTED: "buyer_offer_rejected",
  OFFER_SUPERSEDED: "buyer_offer_superseded",
  OFFER_INCOMPLETE: "buyer_offer_missing_material_terms",
  BINDING_MISMATCH: "buyer_offer_binding_mismatch",
  DISPOSITION_NOT_ACTIVE: "disposition_not_active",
  NOT_SELECTED: "buyer_offer_not_selected",
  NO_COMMITMENT_EVIDENCE: "no_buyer_commitment_evidence",
  COMMITMENT_EVIDENCE_MISMATCH: "commitment_evidence_binds_other_offer",
  NO_SELECTION_ACTOR: "selection_requires_named_actor",
  SELLER_DEAL_INVALID: "seller_deal_invalid",
});

/** Deterministic, so a replayed submission converges on one logical offer. */
export function buildBuyerOfferId({ opportunity_id, buyer_id, offer_version = 1 } = {}) {
  const o = clean(opportunity_id);
  const b = clean(buyer_id);
  if (!o || !b) return null;
  return `buyer_offer:${o}:${b}:v${Number(offer_version) || 1}`;
}

/**
 * Immutable identity of the material buyer terms. Same contract as
 * `buildOfferTermsHash` on the seller side: material terms only, so an
 * identical proposal hashes identically and a changed one does not.
 */
export function buildBuyerTermsHash({
  opportunity_id = null,
  buyer_id = null,
  offer_price = null,
  assignment_price = null,
  strategy = null,
  emd_amount = null,
  closing_date = null,
  closing_window_days = null,
} = {}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        clean(opportunity_id),
        clean(buyer_id),
        money(offer_price),
        money(assignment_price),
        clean(strategy) || "assignment",
        money(emd_amount),
        clean(closing_date) || null,
        Number.isFinite(Number(closing_window_days)) ? Number(closing_window_days) : null,
      ])
    )
    .digest("hex");
}

/**
 * Does this buyer offer carry enough identifiable terms to be a real proposal?
 *
 * Price is never enough on its own: a number with no closing timing and no EMD
 * position is an indication of interest, not an offer we could act on.
 */
export function resolveBuyerOfferCompleteness(offer = {}) {
  const missing = [];
  if (!money(offer.offer_price)) missing.push("offer_price");
  if (!clean(offer.buyer_id)) missing.push("buyer_id");
  if (!clean(offer.opportunity_id)) missing.push("opportunity_id");
  if (!clean(offer.property_id)) missing.push("property_id");
  // `Number(null)` is 0, which is finite — so a null window would have passed a
  // bare Number.isFinite check and an offer with no closing timing at all would
  // have looked complete.
  const windowDays = offer.closing_window_days;
  const hasWindow = windowDays !== null && windowDays !== undefined && windowDays !== ""
    && Number.isFinite(Number(windowDays)) && Number(windowDays) > 0;
  if (!offer.closing_date && !hasWindow) missing.push("closing_timing");
  const emdStatus = clean(offer.emd_status) || EMD_STATUS.NOT_REQUIRED;
  if (emdStatus !== EMD_STATUS.NOT_REQUIRED && !money(offer.emd_amount)) missing.push("emd_amount");

  const strategy = clean(offer.strategy) || "assignment";
  if (strategy === "double_close" && !money(offer.assignment_price ?? offer.offer_price)) {
    missing.push("buyer_purchase_price");
  }
  return { ok: missing.length === 0, missing, strategy };
}

/**
 * Buyer POF. Attached is a document; verified is a finding by a named human.
 * Neither is commitment — POF is qualification evidence, not acceptance.
 */
export function resolveBuyerPof(offer = {}, now = new Date()) {
  const status = clean(offer.pof_status) || BUYER_POF_STATUS.NOT_PROVIDED;
  const expires = iso(offer.pof_expires_at);
  if (expires && iso(now) && expires < iso(now)) {
    return { status: BUYER_POF_STATUS.EXPIRED, qualified: false, buyer_committed: false };
  }
  const qualified = status === BUYER_POF_STATUS.VERIFIED
    && Boolean(clean(offer.pof_verified_by))
    && Boolean(iso(offer.pof_verified_at));
  return {
    status,
    qualified,
    // The invariant that matters: verification qualifies a buyer to be
    // considered. It never binds them to anything.
    buyer_committed: false,
  };
}

/**
 * EMD terms vs EMD receipt. `emd_amount` alone is a promise.
 */
export function resolveEmdPosition(offer = {}) {
  const status = clean(offer.emd_status) || EMD_STATUS.NOT_REQUIRED;
  const received = status === EMD_STATUS.RECEIVED || status === EMD_STATUS.VERIFIED;
  return {
    status,
    amount_terms: money(offer.emd_amount),
    received,
    received_at: received ? iso(offer.emd_received_at) : null,
    /** Money arriving is not a signed agreement either. */
    buyer_committed: false,
  };
}

function assertBinding(offer, { opportunity, dispositionCase }) {
  if (clean(offer.opportunity_id) !== clean(opportunity?.id)) return "opportunity";
  const propertyId = clean(opportunity?.primary_property_id);
  if (propertyId && clean(offer.property_id) !== propertyId) return "property";
  const caseId = clean(dispositionCase?.closing_case_id ?? dispositionCase?.disposition_case_id);
  if (caseId && clean(offer.disposition_case_id) && clean(offer.disposition_case_id) !== caseId) {
    return "disposition_case";
  }
  return null;
}

/**
 * SELECTION. We choose a buyer. This stays at S7.
 *
 * Selection requires a named actor. Ranking engines and AI may RECOMMEND — the
 * comparison below returns an ordering and nothing else — but no automation in
 * this product is authorized to award a deal, so an anonymous caller cannot
 * select one.
 *
 * @returns {{selected, reason, buyer_offer_id, stage, commitment_status, evidence}}
 */
export function selectBuyerOffer({
  dispositionAuthorization = null,
  buyerOffer = null,
  opportunity = null,
  dispositionCase = null,
  actor = null,
  reason = null,
  now = new Date(),
} = {}) {
  const deny = (denial, evidence = {}) => ({
    selected: false,
    reason: denial,
    buyer_offer_id: buyerOffer?.buyer_offer_id ?? null,
    /** Denied selection never moves the stage. */
    stage: "disposition",
    commitment_status: BUYER_COMMITMENT_STATUS.NONE,
    evidence,
  });

  // Disposition must be ACTIVE: a fully executed, unvoided seller contract.
  if (!dispositionAuthorization?.authorized || dispositionAuthorization.external_activity_permitted !== true) {
    return deny(BUYER_DENIALS.DISPOSITION_NOT_ACTIVE, {
      disposition_state: dispositionAuthorization?.disposition_state ?? null,
    });
  }

  if (!buyerOffer?.buyer_offer_id) return deny(BUYER_DENIALS.NO_BUYER_OFFER);

  const status = clean(buyerOffer.status);
  if (status === BUYER_OFFER_STATUS.WITHDRAWN) return deny(BUYER_DENIALS.OFFER_WITHDRAWN);
  if (status === BUYER_OFFER_STATUS.REJECTED) return deny(BUYER_DENIALS.OFFER_REJECTED);
  if (status === BUYER_OFFER_STATUS.SUPERSEDED) return deny(BUYER_DENIALS.OFFER_SUPERSEDED);
  if (status !== BUYER_OFFER_STATUS.SUBMITTED && status !== BUYER_OFFER_STATUS.SELECTED) {
    return deny(BUYER_DENIALS.OFFER_NOT_SUBMITTED, { status: status || null });
  }

  const completeness = resolveBuyerOfferCompleteness(buyerOffer);
  if (!completeness.ok) return deny(BUYER_DENIALS.OFFER_INCOMPLETE, { missing_terms: completeness.missing });

  const mismatch = assertBinding(buyerOffer, { opportunity, dispositionCase });
  if (mismatch) return deny(BUYER_DENIALS.BINDING_MISMATCH, { mismatched: mismatch });

  if (!clean(actor)) return deny(BUYER_DENIALS.NO_SELECTION_ACTOR);

  return {
    selected: true,
    reason: "buyer_offer_selected",
    buyer_offer_id: buyerOffer.buyer_offer_id,
    buyer_id: clean(buyerOffer.buyer_id),
    // SELECTION IS NOT COMMITMENT. The deal stays at S7 until the buyer is
    // durably bound; a buyer we have merely chosen can still walk away.
    stage: "disposition",
    commitment_status: BUYER_COMMITMENT_STATUS.AGREEMENT_REQUIRED,
    required_commitment_type: COMMITMENT_BY_STRATEGY[completeness.strategy] ?? COMMITMENT_TYPES.OTHER,
    selected_at: iso(now),
    selected_by: clean(actor),
    selection_reason: clean(reason) || null,
    /** Closing-case fields are written FROM this, never the other way around. */
    closing_case_projection: {
      buyer_id: clean(buyerOffer.buyer_id),
      buyer_price: money(buyerOffer.offer_price),
      buyer_emd: money(buyerOffer.emd_amount),
      disposition_status: "buyer_selected",
    },
    evidence: { terms_hash: buyerOffer.terms_hash ?? null, strategy: completeness.strategy },
  };
}

/**
 * Compare buyer offers. RECOMMENDATION ONLY.
 *
 * The highest dollar figure is not automatically the best buyer: an unverified
 * POF, no EMD and a long close can make a bigger number worse. This returns an
 * ordering and explicitly carries `selects: false` — a comparison engine may
 * never silently become a selection authority.
 */
export function compareBuyerOffers(offers = [], { now = new Date() } = {}) {
  const scored = (Array.isArray(offers) ? offers : [])
    .filter((o) => clean(o?.status) === BUYER_OFFER_STATUS.SUBMITTED)
    .map((offer) => {
      const pof = resolveBuyerPof(offer, now);
      const emd = resolveEmdPosition(offer);
      const price = money(offer.offer_price) ?? 0;
      const days = Number(offer.closing_window_days);
      return {
        buyer_offer_id: offer.buyer_offer_id,
        buyer_id: clean(offer.buyer_id),
        offer_price: price,
        pof_status: pof.status,
        pof_qualified: pof.qualified,
        emd_status: emd.status,
        closing_window_days: Number.isFinite(days) ? days : null,
      };
    })
    .sort((a, b) => {
      if (a.pof_qualified !== b.pof_qualified) return a.pof_qualified ? -1 : 1;
      if (b.offer_price !== a.offer_price) return b.offer_price - a.offer_price;
      const aDays = a.closing_window_days ?? Number.MAX_SAFE_INTEGER;
      const bDays = b.closing_window_days ?? Number.MAX_SAFE_INTEGER;
      return aDays - bDays;
    });

  return {
    ranked: scored,
    recommended_buyer_offer_id: scored[0]?.buyer_offer_id ?? null,
    /** A recommendation. Never a selection. */
    selects: false,
    requires_selection_authority: true,
  };
}

/**
 * Is this buyer DURABLY COMMITTED? The S8 boundary.
 *
 * Commitment requires a buyer-side agreement bound to this exact offer. None of
 * these is commitment, and each is pinned by test: matched · interested ·
 * submitted an offer · highest offer · POF attached · POF verified · selected ·
 * EMD promised · a buyer_id written onto a closing case.
 *
 * NOTE ON THE CURRENT PRODUCT. There is no buyer-agreement system yet — no
 * assignment agreement, no buyer purchase agreement, no buyer signature path.
 * So in production today this denies every deal with `no_buyer_commitment_
 * evidence`, and the correct state is `agreement_required` at S7. The seam is
 * built; commitment is not fabricated.
 */
export function authorizeBuyerCommitment({
  dispositionAuthorization = null,
  buyerOffer = null,
  opportunity = null,
  dispositionCase = null,
  commitmentEvidence = null,
} = {}) {
  const deny = (denial, evidence = {}) => ({
    committed: false,
    reason: denial,
    stage: "disposition",
    commitment_status: evidence.commitment_status ?? BUYER_COMMITMENT_STATUS.AGREEMENT_REQUIRED,
    buyer_offer_id: buyerOffer?.buyer_offer_id ?? null,
    evidence,
  });

  if (!dispositionAuthorization?.authorized || dispositionAuthorization.external_activity_permitted !== true) {
    return deny(BUYER_DENIALS.DISPOSITION_NOT_ACTIVE, {
      disposition_state: dispositionAuthorization?.disposition_state ?? null,
      commitment_status: BUYER_COMMITMENT_STATUS.NONE,
    });
  }

  if (!buyerOffer?.buyer_offer_id) {
    return deny(BUYER_DENIALS.NO_BUYER_OFFER, { commitment_status: BUYER_COMMITMENT_STATUS.NONE });
  }

  // Commitment only ever applies to the buyer we actually chose.
  const status = clean(buyerOffer.status);
  if (status !== BUYER_OFFER_STATUS.SELECTED && status !== BUYER_OFFER_STATUS.COMMITTED) {
    return deny(BUYER_DENIALS.NOT_SELECTED, { status: status || null });
  }

  const mismatch = assertBinding(buyerOffer, { opportunity, dispositionCase });
  if (mismatch) return deny(BUYER_DENIALS.BINDING_MISMATCH, { mismatched: mismatch });

  const completeness = resolveBuyerOfferCompleteness(buyerOffer);
  if (!completeness.ok) return deny(BUYER_DENIALS.OFFER_INCOMPLETE, { missing_terms: completeness.missing });

  // THE EVIDENCE. A durable buyer-side agreement, executed, bound to this offer.
  const evidence = commitmentEvidence || (buyerOffer.commitment_evidence ?? null);
  const eventId = clean(evidence?.commitment_event_id) || clean(buyerOffer.commitment_event_id);
  const executedAt = iso(evidence?.executed_at) || iso(buyerOffer.committed_at);
  const agreementId = clean(evidence?.agreement_id);
  const type = clean(evidence?.commitment_type) || clean(buyerOffer.commitment_type);

  if (!eventId || !executedAt || !agreementId || !type) {
    return deny(BUYER_DENIALS.NO_COMMITMENT_EVIDENCE, {
      commitment_status: BUYER_COMMITMENT_STATUS.AGREEMENT_REQUIRED,
      required_commitment_type: COMMITMENT_BY_STRATEGY[completeness.strategy] ?? COMMITMENT_TYPES.OTHER,
      has_event_id: Boolean(eventId),
      has_executed_at: Boolean(executedAt),
      has_agreement_id: Boolean(agreementId),
    });
  }

  // The agreement must bind THIS offer's terms, not an earlier version's.
  const boundOfferId = clean(evidence?.buyer_offer_id);
  const boundHash = clean(evidence?.terms_hash);
  if (boundOfferId && boundOfferId !== clean(buyerOffer.buyer_offer_id)) {
    return deny(BUYER_DENIALS.COMMITMENT_EVIDENCE_MISMATCH, { bound_offer_id: boundOfferId });
  }
  if (boundHash && clean(buyerOffer.terms_hash) && boundHash !== clean(buyerOffer.terms_hash)) {
    return deny(BUYER_DENIALS.COMMITMENT_EVIDENCE_MISMATCH, { bound_terms_hash: boundHash });
  }

  return {
    committed: true,
    reason: "buyer_commitment_executed",
    /** The ONE thing that may set S8. */
    stage: "under_contract",
    commitment_status: BUYER_COMMITMENT_STATUS.COMMITTED,
    buyer_offer_id: buyerOffer.buyer_offer_id,
    buyer_id: clean(buyerOffer.buyer_id),
    commitment_event_id: eventId,
    evidence: {
      commitment_type: type,
      agreement_id: agreementId,
      executed_at: executedAt,
      terms_hash: clean(buyerOffer.terms_hash) || null,
    },
  };
}

/**
 * A selected buyer failing BEFORE commitment releases the selection and the
 * deal stays at S7 — S8 was never reached, so there is nothing to regress.
 * Failing AFTER commitment does not casually rewind the stage; it is recorded
 * as a commitment status for the replacement workflow to act on.
 */
export function resolveBuyerFailure({ buyerOffer = null, failure = null } = {}) {
  const status = clean(buyerOffer?.status);
  const kind = clean(failure) || "withdrawn";
  if (status === BUYER_OFFER_STATUS.COMMITTED) {
    return {
      stage: "under_contract",
      stage_regressed: false,
      offer_status: kind === "terminated" ? BUYER_OFFER_STATUS.TERMINATED : BUYER_OFFER_STATUS.DEFAULTED,
      commitment_status: BUYER_COMMITMENT_STATUS.REPLACEMENT_REQUIRED,
      /** No replacement workflow exists yet; this is the seam, not the fix. */
      replacement_workflow_implemented: false,
    };
  }
  return {
    stage: "disposition",
    stage_regressed: false,
    offer_status: kind === "rejected" ? BUYER_OFFER_STATUS.REJECTED : BUYER_OFFER_STATUS.WITHDRAWN,
    commitment_status: BUYER_COMMITMENT_STATUS.NONE,
    selection_released: true,
  };
}

/**
 * Deterministic disposition economics. Never derived from
 * recommended_cash_offer, investor_ceiling or the seller's ask — those are
 * acquisition-side numbers and are not what a buyer pays.
 */
export function resolveDispositionEconomics({ acceptedSellerPrice = null, buyerOffer = null } = {}) {
  const seller = money(acceptedSellerPrice);
  const buyer = money(buyerOffer?.offer_price);
  const strategy = clean(buyerOffer?.strategy) || "assignment";
  const spread = seller !== null && buyer !== null ? buyer - seller : null;
  return {
    strategy,
    seller_acquisition_price: seller,
    buyer_price: buyer,
    gross_spread: spread,
    /** Costs are unknown, so net proceeds are NOT fabricated. */
    net_proceeds: null,
    net_proceeds_reason: "closing_costs_unknown",
  };
}

/**
 * Everything S9 consumes. Available only once the buyer is committed.
 */
export function buildBuyerCommitmentHandoff({
  dispositionHandoff = null,
  buyerOffer = null,
  commitment = null,
} = {}) {
  if (!commitment?.committed) {
    return { ok: false, reason: commitment?.reason ?? BUYER_DENIALS.NO_COMMITMENT_EVIDENCE };
  }
  if (!dispositionHandoff?.ok) return { ok: false, reason: "disposition_handoff_unavailable" };

  const pof = resolveBuyerPof(buyerOffer);
  const emd = resolveEmdPosition(buyerOffer);

  return {
    ok: true,
    disposition_case_id: dispositionHandoff.disposition_case_id,
    acquisition_opportunity_id: dispositionHandoff.acquisition_opportunity_id,
    property_id: dispositionHandoff.property_id,
    seller: {
      accepted_offer_id: dispositionHandoff.acquisition_basis.accepted_offer_id,
      accepted_terms_hash: dispositionHandoff.acquisition_basis.accepted_terms_hash,
      accepted_price: dispositionHandoff.acquisition_basis.accepted_price,
      seller_contract_status: dispositionHandoff.seller_contract_status,
      seller_contract_execution: dispositionHandoff.seller_contract_execution,
    },
    buyer: {
      selected_buyer_id: commitment.buyer_id,
      selected_buyer_offer_id: commitment.buyer_offer_id,
      buyer_terms_hash: buyerOffer.terms_hash ?? null,
      buyer_price: money(buyerOffer.offer_price),
      buyer_commitment_status: BUYER_COMMITMENT_STATUS.COMMITTED,
      buyer_commitment_event: commitment.commitment_event_id,
      buyer_commitment_evidence: commitment.evidence,
      pof_status: pof.status,
      pof_qualified: pof.qualified,
      emd_terms: emd.amount_terms,
      emd_status: emd.status,
      emd_received: emd.received,
      emd_received_at: emd.received_at,
    },
    economics: resolveDispositionEconomics({
      acceptedSellerPrice: dispositionHandoff.acquisition_basis.accepted_price,
      buyerOffer,
    }),
    contract: {
      buyer_agreement_status: BUYER_COMMITMENT_STATUS.COMMITTED,
      commitment_type: commitment.evidence.commitment_type,
      agreement_id: commitment.evidence.agreement_id,
    },
    stage: "under_contract",
  };
}

export default authorizeBuyerCommitment;
