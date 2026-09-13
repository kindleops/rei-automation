// ─── seller-acceptance-authority.js ─────────────────────────────────────────
// THE one authority that decides whether a seller accepted identifiable
// presented terms. Nothing else may answer that question.
//
// WHAT S6 MEANS
//   The seller accepted identifiable acquisition terms that we actually
//   presented, and the system is authorized to begin the formal contract
//   process.
//
// WHAT S6 DOES NOT MEAN — each of these reached S6 in production:
//
//   * "we decided their ask is affordable".  All THREE opportunities sitting at
//     formal_contract carry basis `we_accepted_seller_ask` with
//     `offers_made: 0` and `latest_offer: null`. No offer was ever presented to
//     any of them. One of the three has accepted_price = 331 — a known corrupt
//     extraction — recorded as an agreed contract price.
//   * "the seller said something positive".  `flags.accept` was a substring
//     scan over ACCEPT_PHRASES with no presented-offer precondition, so
//     "sounds good, what would you offer?" contains "sounds good",
//     "deal with it" contains "deal", and "I accepted another offer" contains
//     "accepted" — all three resolved SELLER_ACCEPTS_OFFER.
//
// THE INVARIANTS
//   favorable economics != seller acceptance
//   asking price        != seller acceptance
//   contract request    != accepted contract terms
//   counter             != acceptance
//   lexical positivity  != acceptance
//
// FAIL-CLOSED. Acceptance is the highest-consequence transition in the system:
// it freezes a purchase price and authorizes contract preparation. Every
// ambiguity resolves to HOLD or NOT_ACCEPTANCE. A false negative costs one
// operator review; a false positive puts a fabricated number into a contract.
//
// THIS MODULE DOES NOT WRITE. It reads a message plus the durable presented
// offer and returns a verdict. Persistence stays with the existing authorities
// (`acceptActiveOffer` binds to the exact seller_offers row and is keyed on
// acceptance_event_id; `finalizeSellerAcceptance` converges the closing case).

import { CONTRACT_BEARING_TERMS } from "@/lib/domain/seller-flow/seller-offer-policy.js";

/**
 * Terms that only exist AFTER acceptance. `assertContractComplete` asks "is
 * this ACCEPTED offer ready to paper", so its list includes acceptance_event_id
 * and accepted_at. Asking it whether a PRESENTED offer is acceptable would
 * report those as missing on every offer, and nothing would ever be
 * acceptable — a different question needs a different subset of the same
 * canonical list, not a second list.
 */
const ACCEPTANCE_TIME_TERMS = new Set(["acceptance_event_id", "accepted_at"]);

/** The contract-bearing terms that must exist BEFORE the seller can accept. */
export const PRESENTED_OFFER_MATERIAL_TERMS = Object.freeze(
  CONTRACT_BEARING_TERMS.filter((term) => !ACCEPTANCE_TIME_TERMS.has(term)),
);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
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

export const ACCEPTANCE_VERDICTS = Object.freeze({
  /** Seller accepted the identifiable presented offer. Authorizes S6. */
  ACCEPTED: "accepted",
  /** Seller named different terms. Stays S5. */
  COUNTER: "counter",
  /** Seller wants paperwork but has not agreed terms. Stays S5. */
  CONTRACT_REQUEST_ONLY: "contract_request_only",
  /** Could be acceptance; cannot be attached unambiguously. Operator review. */
  AMBIGUOUS_HOLD: "ambiguous_hold",
  /** The presented offer is not contract-complete for its strategy. */
  INSUFFICIENT_TERMS: "insufficient_terms",
  /** Not an acceptance of anything. */
  NOT_ACCEPTANCE: "not_acceptance",
});

export const ACCEPTANCE_REASONS = Object.freeze({
  NO_PRESENTED_OFFER: "no_presented_offer",
  OFFER_NOT_CONTRACT_COMPLETE: "offer_not_contract_complete",
  OFFER_NOT_PRESENTED_TO_SELLER: "offer_not_presented_to_seller",
  ACCEPTANCE_PREDATES_OFFER: "acceptance_predates_offer",
  STALE_OFFER_REFERENCE: "stale_offer_reference",
  COUNTER_AMOUNT_PRESENT: "counter_amount_present",
  AMOUNT_DOES_NOT_MATCH_OFFER: "amount_does_not_match_offer",
  NEGATED_ACCEPTANCE: "negated_acceptance",
  INTERROGATIVE_ACCEPTANCE: "interrogative_acceptance",
  THIRD_PARTY_ACCEPTANCE: "third_party_acceptance",
  DEFERRED_ACCEPTANCE: "deferred_acceptance",
  CONTRACT_REQUEST_WITHOUT_TERMS: "contract_request_without_terms",
  NO_ACCEPTANCE_LANGUAGE: "no_acceptance_language",
  UNAMBIGUOUS_ACCEPTANCE: "unambiguous_acceptance",
});

/**
 * Acceptance language. Deliberately NOT the stage-5 ACCEPT_PHRASES list, which
 * is a bare substring scan tuned for routing rather than for authorizing money.
 * Anchored so "deal with it" and "no deal" cannot match "deal", and
 * "I accepted another offer" cannot match "accepted".
 */
const ACCEPTANCE_PATTERNS = Object.freeze([
  /\bi\s+accept\b(?!\w)/,
  /\bwe\s+accept\b/,
  /\b(i|we)\s+(will|'ll|ll)\s+take\s+(it|that|the\s+offer)\b/,
  /\baccept\s+(your|the)\s+offer\b/,
  /\b(it'?s\s+a\s+)?deal\b(?!\s+(with|breaker))/,
  /\b(that|this|it)\s+works\s*(for\s+me)?\b/,
  /\bworks\s+for\s+me\b/,
  // "62,300 works." — a bare `works` after a number. Negation and deferral are
  // filtered separately, so this does not have to defend against "won't work".
  /\b[\d,]{3,}\s+works\b/,
  /\blet'?s\s+(do\s+(it|this)|move\s+forward)\b/,
  /\b(i\s+)?agree(d)?\b/,
  /\bsounds\s+good\b/,
  // NOT `\bsold\b`. A 1,200-message production replay classified 10 messages
  // as acceptance and every one of them was a seller reporting the property
  // was ALREADY sold to someone else: "It's SOLD", "Sold", "It was...sold a few
  // weeks ago", "I sold 123 Main, but I own 456 Oak". An auctioneer's "sold"
  // does not appear in this channel; a seller announcing a completed sale to a
  // third party does, constantly.

  /\bacepto\b/,
  /\btrato\s+hecho\b/,
  /\bde\s+acuerdo\b/,
  /\bme\s+parece\s+bien\b/,
]);

/** Paperwork requests. A request is not an agreement. */
const CONTRACT_REQUEST_PATTERNS = Object.freeze([
  /\bsend\s+(me\s+)?(the\s+|a\s+|over\s+the\s+)?(contract|agreement|paperwork|documents?|docs)\b/,
  /\b(contract|agreement|paperwork)\s+(over|to\s+me)\b/,
  /\bemail\s+(me\s+)?(the\s+)?(contract|agreement|paperwork)\b/,
  /\blet\s+me\s+(see|review|look\s+at)\s+(the\s+)?(contract|agreement|paperwork)\b/,
  /\bmand[ae]\s+(el\s+)?contrato\b/,
]);

/**
 * Traps. Each of these contains acceptance vocabulary and is not acceptance.
 * Ordered by how they defeat the lexical layer.
 */
const NEGATION_PATTERNS = Object.freeze([
  /\b(no|not|don'?t|won'?t|can'?t|cannot|never)\b[^.?!]{0,24}\b(deal|accept|agree|works)\b/,
  /\b(deal|accept|agree|works)\b[^.?!]{0,16}\bnot\b/,
  /\bno\s+deal\b/,
  /\bdeal\s+breaker\b/,
]);

/** "sounds good, but what would you offer?" — a question is not an agreement. */
const INTERROGATIVE_PATTERNS = Object.freeze([
  /\?/,
  /\b(what|how much|how many|when|where|which|who|why)\b/,
  /\bhow\s+(would|will|do|does)\b/,
]);

/** "I accepted another offer" — an acceptance, but not of ours. */
const THIRD_PARTY_PATTERNS = Object.freeze([
  /\b(accepted|took|going\s+with|signed\s+with)\b[^.?!]{0,24}\b(another|someone\s+else|other\s+(offer|buyer)|different\s+(offer|buyer))\b/,
  /\b(another|someone\s+else'?s?|a\s+different)\s+(offer|buyer|company|investor)\b/,
  /\balready\s+(sold|under\s+contract|accepted)\b/,
  // Bare past-tense sale reports, which is how sellers actually phrase it.
  /\b(it'?s|its|it\s+was|we\s+sold|i\s+sold|has\s+been|was)\s+sold\b/,
  /^\s*sold\b/,
  /\bsold\s+(it|the\s+(house|property|place)|a\s+few|last|back\s+in)\b/,
  /\bbeing\s+sold\b/,
]);

/** "yes but", "I'd need to talk to my wife first" — conditional, not agreed. */
const DEFERRAL_PATTERNS = Object.freeze([
  /\b(yes|ok|okay|sure|sounds\s+good|agree[d]?)\b[^.?!]{0,10}\bbut\b/,
  /\bneed\s+to\s+(talk|speak|check|think|discuss|run\s+it)\b/,
  /\b(let\s+me|i'?ll)\s+think\b/,
  /\b(my|our)\s+(wife|husband|spouse|brother|sister|attorney|lawyer|partner|family)\b[^.?!]{0,24}\b(first|has\s+to|needs?\s+to|agree)\b/,
  /\bif\s+(you|we|the)\b[^.?!]{0,24}\b(can|could|will|would)\b/,
]);

/** Amounts the seller names in this message. */
const AMOUNT_PATTERN = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*k\b|\d{4,9})/gi;

function extractAmounts(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(AMOUNT_PATTERN)) {
    const raw = lower(match[1]);
    let value = null;
    if (raw.endsWith("k")) value = Number(raw.replace(/[^\d.]/g, "")) * 1000;
    else value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) out.push(value);
  }
  return out;
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Does this offer carry enough identifiable material terms for its strategy to
 * be a legally meaningful presented offer?
 *
 * Cash reuses `assertContractComplete` — the repository's existing definition
 * of contract-bearing terms — rather than inventing a second one. Creative and
 * novation additionally need their structure named, because a price alone does
 * not describe a seller-financed or novated transaction.
 */
export function resolveMaterialTerms(offer = {}) {
  const strategy = lower(offer.strategy) || "cash";
  const missing = [];
  for (const field of PRESENTED_OFFER_MATERIAL_TERMS) {
    const value = offer?.[field];
    if (value === null || value === undefined || value === "") {
      missing.push(field);
      continue;
    }
    if ((field === "purchase_price" || field === "emd_amount") && !(Number(value) > 0)) {
      missing.push(field);
    }
  }

  const isCreative = /seller_financ|owner_financ|subject_to|subject-to|creative|lease_option/.test(strategy);
  const isNovation = /novation/.test(strategy);

  if (isCreative) {
    const terms = offer.metadata?.creative_terms || offer.creative_terms || {};
    const hasStructure =
      money(terms.down_payment) !== null ||
      money(terms.monthly_payment) !== null ||
      money(terms.balance_financed) !== null ||
      money(offer.seller_finance_amount) !== null;
    if (!hasStructure) missing.push("creative_payment_structure");
  }

  if (isNovation) {
    const terms = offer.metadata?.novation_terms || offer.novation_terms || {};
    const hasStructure =
      money(terms.target_resale_price) !== null || money(terms.seller_net) !== null;
    if (!hasStructure) missing.push("novation_consideration");
  }

  return { ok: missing.length === 0, missing, strategy };
}

/**
 * THE acceptance decision.
 *
 * @param {object}  args
 * @param {object}  args.opportunity            canonical opportunity
 * @param {object}  args.message                { body, message_event_id, received_at }
 * @param {object}  args.activePresentedOffer   the current ACTIVE seller_offers row
 * @param {object} [args.conversationContext]   { counter_price, referenced_offer_id, referenced_offer_version }
 * @returns {{accepted, verdict, reason, contract_request, offer_id, offer_version,
 *            terms_hash, accepted_price, message_event_id, accepted_at, evidence}}
 */
export function resolveSellerAcceptance({
  opportunity = null,
  message = null,
  activePresentedOffer = null,
  conversationContext = {},
} = {}) {
  const text = lower(message?.body);
  const message_event_id = clean(message?.message_event_id) || null;
  const accepted_at = iso(message?.received_at) || null;

  const hasAcceptanceLanguage = matchesAny(text, ACCEPTANCE_PATTERNS);
  const contract_request = matchesAny(text, CONTRACT_REQUEST_PATTERNS);

  const verdict = (v, reason, evidence = {}) => ({
    accepted: v === ACCEPTANCE_VERDICTS.ACCEPTED,
    verdict: v,
    reason,
    contract_request,
    offer_id: activePresentedOffer?.offer_id ?? null,
    offer_version: activePresentedOffer?.offer_version ?? null,
    terms_hash: v === ACCEPTANCE_VERDICTS.ACCEPTED ? activePresentedOffer?.terms_hash ?? null : null,
    accepted_price: v === ACCEPTANCE_VERDICTS.ACCEPTED ? money(activePresentedOffer?.purchase_price) : null,
    message_event_id,
    accepted_at: v === ACCEPTANCE_VERDICTS.ACCEPTED ? accepted_at : null,
    opportunity_id: clean(opportunity?.id) || null,
    property_id: clean(opportunity?.primary_property_id) || null,
    evidence: { has_acceptance_language: hasAcceptanceLanguage, contract_request, ...evidence },
  });

  // ── 1. Nothing was presented, so there is nothing to accept ──────────────
  // This single gate is what all three production S6 rows failed. It comes
  // FIRST because no amount of seller enthusiasm creates presented terms.
  if (!activePresentedOffer) {
    if (contract_request) {
      return verdict(
        ACCEPTANCE_VERDICTS.CONTRACT_REQUEST_ONLY,
        ACCEPTANCE_REASONS.CONTRACT_REQUEST_WITHOUT_TERMS,
      );
    }
    return verdict(ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE, ACCEPTANCE_REASONS.NO_PRESENTED_OFFER);
  }

  // ── 2. The offer has to have reached the seller ──────────────────────────
  const presentedAt = iso(activePresentedOffer.sent_at);
  if (!presentedAt) {
    return verdict(
      ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE,
      ACCEPTANCE_REASONS.OFFER_NOT_PRESENTED_TO_SELLER,
      { offer_created_at: iso(activePresentedOffer.created_at) },
    );
  }
  if (accepted_at && accepted_at < presentedAt) {
    return verdict(ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE, ACCEPTANCE_REASONS.ACCEPTANCE_PREDATES_OFFER, {
      presented_at: presentedAt,
    });
  }

  // ── 3. A reference to a superseded offer is not acceptance of this one ───
  const referencedId = clean(conversationContext.referenced_offer_id);
  if (referencedId && referencedId !== clean(activePresentedOffer.offer_id)) {
    return verdict(ACCEPTANCE_VERDICTS.AMBIGUOUS_HOLD, ACCEPTANCE_REASONS.STALE_OFFER_REFERENCE, {
      referenced_offer_id: referencedId,
      active_offer_id: activePresentedOffer.offer_id,
    });
  }

  // ── 4. Material terms for this strategy ──────────────────────────────────
  const material = resolveMaterialTerms(activePresentedOffer);
  if (!material.ok) {
    return verdict(ACCEPTANCE_VERDICTS.INSUFFICIENT_TERMS, ACCEPTANCE_REASONS.OFFER_NOT_CONTRACT_COMPLETE, {
      strategy: material.strategy,
      missing_terms: material.missing,
    });
  }

  // ── 5. A number the seller names ─────────────────────────────────────────
  // An explicit counter beats acceptance language: "deal, but I need 80" is a
  // counter, not a deal.
  const offerPrice = money(activePresentedOffer.purchase_price);
  const contextCounter = money(conversationContext.counter_price);
  const amounts = extractAmounts(message?.body);
  const namedNonMatching = amounts.filter((amount) => offerPrice === null || amount !== offerPrice);

  if (contextCounter !== null && contextCounter !== offerPrice) {
    return verdict(ACCEPTANCE_VERDICTS.COUNTER, ACCEPTANCE_REASONS.COUNTER_AMOUNT_PRESENT, {
      counter_price: contextCounter,
      offer_price: offerPrice,
    });
  }
  if (namedNonMatching.length) {
    // A different number with acceptance words is ambiguous, not agreement.
    return verdict(
      hasAcceptanceLanguage ? ACCEPTANCE_VERDICTS.AMBIGUOUS_HOLD : ACCEPTANCE_VERDICTS.COUNTER,
      ACCEPTANCE_REASONS.AMOUNT_DOES_NOT_MATCH_OFFER,
      { named_amounts: namedNonMatching, offer_price: offerPrice },
    );
  }

  // ── 6. Context filters over the lexical layer ────────────────────────────
  const namesOfferPrice = offerPrice !== null && amounts.includes(offerPrice);

  if (matchesAny(text, THIRD_PARTY_PATTERNS)) {
    return verdict(ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE, ACCEPTANCE_REASONS.THIRD_PARTY_ACCEPTANCE);
  }
  if (matchesAny(text, NEGATION_PATTERNS)) {
    return verdict(ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE, ACCEPTANCE_REASONS.NEGATED_ACCEPTANCE);
  }
  if (matchesAny(text, DEFERRAL_PATTERNS)) {
    return verdict(ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE, ACCEPTANCE_REASONS.DEFERRED_ACCEPTANCE);
  }
  if (!hasAcceptanceLanguage) {
    if (contract_request) {
      // "Send the contract for the $62,300" names OUR presented number, which
      // is what separates papering agreed terms from "send me something to look
      // at". Only the exact presented price counts; any other number already
      // resolved as a counter above.
      if (namesOfferPrice) {
        return verdict(ACCEPTANCE_VERDICTS.ACCEPTED, ACCEPTANCE_REASONS.UNAMBIGUOUS_ACCEPTANCE, {
          presented_at: presentedAt,
          named_offer_price: true,
          via_contract_request: true,
          strategy: material.strategy,
        });
      }
      // "Send me the contract so I can look at it" — paperwork, not agreement.
      return verdict(
        ACCEPTANCE_VERDICTS.CONTRACT_REQUEST_ONLY,
        ACCEPTANCE_REASONS.CONTRACT_REQUEST_WITHOUT_TERMS,
      );
    }
    return verdict(ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE, ACCEPTANCE_REASONS.NO_ACCEPTANCE_LANGUAGE);
  }
  // A question mark or interrogative alongside acceptance words is the
  // "sounds good, what would you offer?" trap. Naming our exact price is the
  // one thing that disambiguates it ("send the contract for the $62,300?").
  if (matchesAny(text, INTERROGATIVE_PATTERNS) && !namesOfferPrice) {
    return verdict(ACCEPTANCE_VERDICTS.AMBIGUOUS_HOLD, ACCEPTANCE_REASONS.INTERROGATIVE_ACCEPTANCE);
  }

  // ── 7. Acceptance of identifiable presented terms ────────────────────────
  return verdict(ACCEPTANCE_VERDICTS.ACCEPTED, ACCEPTANCE_REASONS.UNAMBIGUOUS_ACCEPTANCE, {
    presented_at: presentedAt,
    named_offer_price: namesOfferPrice,
    strategy: material.strategy,
  });
}

/**
 * The S5 -> S6 gate. The ONLY thing that may authorize formal contract.
 *
 * Every clause is a separate production failure: stage floor (an opportunity
 * jumped S1 -> S6 on ownership confirmation), accepted-offer existence (all
 * three S6 rows had none), presentation (offers_made was 0), and context
 * binding (a multi-property owner must not accept property B's offer in
 * property A's thread).
 */
export function authorizeFormalContract({
  currentStageIndex = null,
  acceptance = null,
  acceptedOffer = null,
  opportunity = null,
} = {}) {
  const deny = (reason, evidence = {}) => ({ authorized: false, reason, evidence });

  if (!(Number(currentStageIndex) >= 4)) {
    return deny("stage_below_offer", { current_stage_index: currentStageIndex });
  }
  if (!acceptance?.accepted) {
    return deny("no_accepted_offer", { verdict: acceptance?.verdict ?? null, acceptance_reason: acceptance?.reason ?? null });
  }
  if (!acceptedOffer?.offer_id) return deny("accepted_offer_missing");
  if (clean(acceptedOffer.offer_id) !== clean(acceptance.offer_id)) {
    return deny("accepted_offer_mismatch", {
      acceptance_offer_id: acceptance.offer_id,
      accepted_offer_id: acceptedOffer.offer_id,
    });
  }
  if (!iso(acceptedOffer.sent_at)) return deny("accepted_offer_never_presented");
  if (!money(acceptedOffer.purchase_price)) return deny("accepted_offer_has_no_price");
  if (!clean(acceptedOffer.terms_hash)) return deny("accepted_offer_has_no_terms_hash");

  // Context binding. The offer, the acceptance and the opportunity must be the
  // same deal.
  const opportunityId = clean(opportunity?.id);
  if (opportunityId && clean(acceptedOffer.opportunity_id) !== opportunityId) {
    return deny("offer_belongs_to_other_opportunity", {
      offer_opportunity_id: acceptedOffer.opportunity_id,
      opportunity_id: opportunityId,
    });
  }
  const propertyId = clean(opportunity?.primary_property_id);
  if (propertyId && clean(acceptedOffer.property_id) && clean(acceptedOffer.property_id) !== propertyId) {
    return deny("offer_belongs_to_other_property", {
      offer_property_id: acceptedOffer.property_id,
      opportunity_property_id: propertyId,
    });
  }

  return {
    authorized: true,
    reason: "accepted_presented_terms",
    /** Everything S7 needs, so it never reinterprets seller messages. */
    contract: {
      accepted_offer_id: acceptedOffer.offer_id,
      accepted_offer_version: acceptedOffer.offer_version,
      accepted_terms_hash: acceptedOffer.terms_hash,
      accepted_price: money(acceptedOffer.purchase_price),
      accepted_at: iso(acceptedOffer.accepted_at) || acceptance.accepted_at,
      acceptance_event_id: acceptance.message_event_id,
      strategy: clean(acceptedOffer.strategy) || "cash",
      opportunity_id: clean(acceptedOffer.opportunity_id) || opportunityId || null,
      property_id: clean(acceptedOffer.property_id) || propertyId || null,
      thread_key: clean(acceptedOffer.thread_key) || null,
      master_owner_id: clean(acceptedOffer.master_owner_id) || null,
      closing_date: acceptedOffer.closing_date ?? null,
      emd_amount: money(acceptedOffer.emd_amount),
      emd_due_date: acceptedOffer.emd_due_date ?? null,
      // The repo-native persisted status. `createClosingCaseFromAcceptance`
      // writes `draft` on closing_cases, which is the existing contract
      // vocabulary -- there is no `contracts` table in production and the Podio
      // contract path is dead, so closing_cases IS the durable artifact.
      // Inventing a parallel status here would create the competing authority
      // this phase exists to prevent.
      contract_status: "draft",
      // The AUTHORIZATION state, which is not a persisted status: S6 is
      // reached, so contract preparation may begin. No document is produced,
      // sent or signed by this module.
      contract_authorization: "contract_preparation_required",
    },
  };
}

export default resolveSellerAcceptance;
