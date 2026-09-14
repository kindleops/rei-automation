/**
 * reconciliation-policy.js
 *
 * THE ONE PLACE THAT DECIDES WHAT A SELLER STATEMENT IS ALLOWED TO CHANGE.
 *
 * Layer B (an assertion) does not become layer C (canonical state) by being
 * newer. It becomes canonical by passing a policy that is allowed to say no.
 * This is that policy, and it is centralized on purpose: a confidence check
 * scattered through a handler is a rule nobody can find, audit, or change, and
 * the same fact ends up governed differently depending on which code path
 * happened to reach it.
 *
 * ── WHY "LATEST ROW WINS" IS WRONG ────────────────────────────────────────
 *
 * It is the obvious implementation and it is wrong in every direction at once:
 *
 *   It lets an INFERENCE overwrite something the seller stated. We decide they
 *   sound motivated; that quietly replaces "I need 200".
 *
 *   It lets an AMBIGUOUS reading displace a clear one. A garbled message
 *   outranks the plain one before it purely by arriving second.
 *
 *   It lets a seller's CLAIM overwrite verified title. "I own it" is evidence
 *   about a person's belief, not a property record.
 *
 *   It overwrites HISTORY as though it were state. "My mother died and I
 *   inherited it" does not stop being true when the next message is about
 *   tenants.
 *
 * ── FOUR OUTCOMES, NOT TWO ────────────────────────────────────────────────
 *
 *   ACCEPT   becomes canonical state now.
 *   SOFT     stored as intelligence, visible, but not canonical. The honest
 *            answer for most inferences: useful, not authoritative.
 *   REVIEW   a human decides. Reserved for material conflict and for anything
 *            touching legal authority.
 *   REFUSE   not recorded as a fact at all -- malformed, or a number so
 *            implausible that recording it would corrupt what it touches.
 *
 * A two-outcome policy (accept/reject) forces every uncertain-but-useful
 * reading into one of two wrong answers. SOFT is what lets the system know
 * something without acting on it, which is the entire posture of EMAIL-4.
 */

import { asObject } from "@/lib/hostile-input.js";
import {
  ASSERTION_BASIS,
  FACT_FAMILY,
  basisRank,
  familyOf,
  AUTHORITY_CLAIM_TYPES,
  MONETARY_ASSERTION_TYPES,
} from "@/lib/domain/seller-intelligence/assertion-contract.js";

export const RECONCILIATION_POLICY_VERSION = "seller_reconciliation_v1";

export const RECONCILIATION = Object.freeze({
  ACCEPT: "accept",
  SOFT: "soft",
  REVIEW: "review",
  REFUSE: "refuse",
});

/**
 * Plausibility bounds for money. Not a business rule about what we will pay --
 * a bound on what can be a residential asking price at all.
 *
 * A seller typing 1 or 99999999 is a typo, a unit confusion, or an injection
 * attempt. Recording it silently corrupts every comparison it touches, and
 * "correcting" it invents a number the seller never said. So it is refused and
 * surfaced.
 */
export const MONEY_PLAUSIBILITY = Object.freeze({
  MIN_USD: 1_000,
  MAX_USD: 50_000_000,
});

/** Below this, an explicit-looking reading is not trustworthy enough to bind. */
export const MIN_CONFIDENCE_FOR_CANONICAL = 0.7;

function clean(value) {
  return String(value ?? "").trim();
}

function decision(outcome, reason, extra = {}) {
  return { outcome, reason, policy_version: RECONCILIATION_POLICY_VERSION, ...extra };
}

/**
 * Decide what one assertion may do, given what we already believe.
 *
 * @param {object} input
 * @param {object} input.assertion  a built assertion (see assertion-contract)
 * @param {object|null} input.current  the current canonical assertion of this
 *        type, if any
 * @param {object} [input.context]  { has_verified_owner, legal_conflict }
 * @returns {{outcome, reason, policy_version, supersedes?:string|null}}
 */
export function reconcileAssertion(raw_input) {
  const input = asObject(raw_input);
  const assertion = asObject(input.assertion);
  const current = input.current ? asObject(input.current) : null;
  const context = asObject(input.context);

  const type = clean(assertion.type);
  const family = familyOf(type);
  if (!family) return decision(RECONCILIATION.REFUSE, "unknown_assertion_type");

  const basis = clean(assertion.basis);
  if (!Object.values(ASSERTION_BASIS).includes(basis)) {
    return decision(RECONCILIATION.REFUSE, "invalid_basis");
  }

  const confidence = typeof assertion.confidence === "number" ? assertion.confidence : null;
  if (confidence === null) return decision(RECONCILIATION.REFUSE, "missing_confidence");

  // ── implausible money is refused, never silently corrected ──────────────
  if (MONETARY_ASSERTION_TYPES.has(type)) {
    const amount = Number(asObject(assertion.value).amount);
    if (!Number.isFinite(amount)) return decision(RECONCILIATION.REFUSE, "money_without_amount");
    if (amount < MONEY_PLAUSIBILITY.MIN_USD || amount > MONEY_PLAUSIBILITY.MAX_USD) {
      // Surfaced rather than clamped: a clamped number is a number we invented.
      return decision(RECONCILIATION.REVIEW, "money_implausible", { amount });
    }
  }

  // ── legal conflict outranks everything ──────────────────────────────────
  // "My brother says he owns half and we're in court" cannot be reconciled by
  // any confidence value. Somebody has to look.
  if (context.legal_conflict === true) {
    return decision(RECONCILIATION.REVIEW, "legal_conflict_present");
  }

  // ── authority claims never rewrite a verified record ─────────────────────
  if (AUTHORITY_CLAIM_TYPES.has(type)) {
    if (context.has_verified_owner === true) {
      // Recorded as a claim, visible beside the record, never replacing it.
      return decision(RECONCILIATION.SOFT, "authority_claim_beside_verified_record");
    }
    // With nothing verified, a clear ownership statement is still only a claim,
    // but it is the best evidence available and an operator should see it.
    return basis === ASSERTION_BASIS.EXPLICIT && confidence >= MIN_CONFIDENCE_FOR_CANONICAL
      ? decision(RECONCILIATION.SOFT, "authority_claim_recorded")
      : decision(RECONCILIATION.SOFT, "authority_claim_low_confidence");
  }

  // ── an inference never becomes canonical on its own ──────────────────────
  if (basis === ASSERTION_BASIS.INFERRED) {
    return decision(RECONCILIATION.SOFT, "inferred_basis_is_not_canonical");
  }

  // ── interpretive families are soft by nature ─────────────────────────────
  // Motivation, urgency and objections are our reading of the seller. Useful
  // for prioritisation, never a fact about the property or the deal.
  if (family === FACT_FAMILY.INTERPRETIVE) {
    return decision(RECONCILIATION.SOFT, "interpretive_family");
  }

  // ── history is appended, never overwritten ───────────────────────────────
  if (family === FACT_FAMILY.HISTORICAL) {
    // "My mother died and I inherited it" does not stop being true when the
    // next message is about tenants. Each such statement stands on its own.
    return confidence >= MIN_CONFIDENCE_FOR_CANONICAL
      ? decision(RECONCILIATION.ACCEPT, "historical_fact_appended", { supersedes: null })
      : decision(RECONCILIATION.SOFT, "historical_fact_low_confidence");
  }

  if (confidence < MIN_CONFIDENCE_FOR_CANONICAL) {
    return decision(RECONCILIATION.SOFT, "below_canonical_confidence", { confidence });
  }

  // ── nothing to conflict with ─────────────────────────────────────────────
  if (!current) {
    return decision(RECONCILIATION.ACCEPT, "no_current_value", { supersedes: null });
  }

  // ── conflict, resolved per family ────────────────────────────────────────
  const current_basis = clean(current.basis);
  const current_id = clean(current.id) || null;

  // A weaker basis never displaces a stronger one, in any family. An inference
  // must not overwrite something the seller said, and an implication must not
  // overwrite a quotation.
  if (basisRank(basis) > basisRank(current_basis)) {
    return decision(RECONCILIATION.SOFT, "weaker_basis_than_current", {
      current_basis, incoming_basis: basis,
    });
  }

  switch (family) {
    case FACT_FAMILY.TEMPORAL:
      // The seller is allowed to change their mind, and the newest explicit
      // statement is what they currently want. This is the ONE family where
      // recency is genuinely the right rule -- and only at equal-or-stronger
      // basis, which the check above already guarantees.
      return decision(RECONCILIATION.ACCEPT, "newer_statement_supersedes", { supersedes: current_id });

    case FACT_FAMILY.MUTABLE_STATE:
      // The world changes underneath the seller: a property genuinely becomes
      // vacant. Same rule, different reason -- and worth distinguishing,
      // because a contradiction here may mean the world moved rather than that
      // anybody was wrong.
      return decision(RECONCILIATION.ACCEPT, "state_changed", { supersedes: current_id });

    case FACT_FAMILY.PREFERENCE:
      // "Don't text me, email is fine" is an instruction about us. The most
      // recent instruction is the operative one, and getting this wrong keeps
      // contacting someone the way they asked us not to.
      return decision(RECONCILIATION.ACCEPT, "preference_updated", { supersedes: current_id });

    case FACT_FAMILY.CLAIM:
      return decision(RECONCILIATION.SOFT, "claim_recorded_not_canonical", { supersedes: null });

    default:
      // A family with no rule must not fall through to "accept". An unhandled
      // case is a gap in this policy, and the safe reading of a gap is that
      // nobody decided yet.
      return decision(RECONCILIATION.REVIEW, "no_policy_for_family", { family });
  }
}

/**
 * An explicit CORRECTION from the seller.
 *
 * "Sorry, I meant 190, not 290" is different from a new statement: the seller
 * is telling us the earlier value was never what they meant. It supersedes at
 * equal basis, and it does so even when the corrected value is older-sounding,
 * because the correction is the newer act.
 */
export function reconcileCorrection(raw_input) {
  const input = asObject(raw_input);
  const base = reconcileAssertion(input);
  if (base.outcome !== RECONCILIATION.ACCEPT && base.outcome !== RECONCILIATION.SOFT) return base;

  const current = input.current ? asObject(input.current) : null;
  const family = familyOf(clean(asObject(input.assertion).type));

  // A correction to an interpretive or claim family is still not canonical --
  // correcting a guess does not promote it.
  if (family === FACT_FAMILY.INTERPRETIVE || family === FACT_FAMILY.CLAIM) {
    return decision(RECONCILIATION.SOFT, "correction_to_non_canonical_family");
  }

  return decision(RECONCILIATION.ACCEPT, "explicit_correction_supersedes", {
    supersedes: current ? clean(current.id) || null : null,
    corrected: true,
  });
}

/** Does this outcome write canonical state? The one question callers ask. */
export function touchesCanonicalState(outcome) {
  return clean(outcome) === RECONCILIATION.ACCEPT;
}

/** Does this outcome require a human before anything else happens? */
export function requiresReview(outcome) {
  return clean(outcome) === RECONCILIATION.REVIEW;
}

export default reconcileAssertion;
