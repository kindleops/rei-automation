/**
 * callback-trust-policy.js
 *
 * WHETHER A RECEIPT IS TRUSTWORTHY ENOUGH TO CHANGE WHAT WE BELIEVE.
 *
 * Slice 2 classified receipt trust and wrote it to every ledger row. Slice 3
 * then established, by static analysis, that NOTHING read it: `resolveBinding`
 * never received it and no conditional consulted it. Trust was evidence we
 * collected and then ignored.
 *
 * That is not a duplicate-send risk -- no callback path allocates an attempt,
 * invokes a provider, or grants retry authority, and the Slice 3 state search
 * proves that exhaustively. It is a TRUTH-INTEGRITY risk: an unauthenticated
 * POST could make the system believe a message was delivered, or failed, on
 * evidence nobody verified.
 *
 * THE DISTINCTION THIS MODULE ENFORCES
 *
 *   recording   always. Evidence is never discarded, whatever its trust.
 *   advancing   only when the receipt meets the configured trust threshold.
 *
 * Untrusted receipts are kept, labelled, and left inert. They are a work-list,
 * not a fact.
 */

export const CALLBACK_TRUST_POLICY_VERSION = 'callback_trust_v1';

/**
 * Receipt-time trust vocabulary. Defined HERE rather than in the reconciler,
 * because the module that decides what trust MEANS should own the vocabulary --
 * and because the reverse created an import cycle.
 */
export const TRUST_CLASS = Object.freeze({
  AUTHENTICATED: 'authenticated_provider_callback',
  UNAUTHENTICATED: 'network_received_unauthenticated',
  INTERNAL_REPLAY: 'internal_replay',
  TEST_FIXTURE: 'test_fixture',
});

/**
 * Trust ranking. Higher is stronger evidence about WHO sent the callback.
 *
 * Note what is NOT here: any notion of trust increasing over time or through
 * replay. Trust is a property of the receipt, fixed when it arrived.
 */
const TRUST_RANK = Object.freeze({
  [TRUST_CLASS.AUTHENTICATED]: 3,
  [TRUST_CLASS.INTERNAL_REPLAY]: 2,
  [TRUST_CLASS.UNAUTHENTICATED]: 1,
  [TRUST_CLASS.TEST_FIXTURE]: 0,
});

/**
 * The threshold required to ADVANCE canonical provider truth.
 *
 * Deliberately a constant rather than an env var. A truth-integrity boundary
 * that can be lowered by setting an environment variable is a boundary that
 * will eventually be lowered by accident, and the failure is silent.
 */
export const CANONICAL_ADVANCE_MIN_TRUST = TRUST_CLASS.AUTHENTICATED;

/**
 * ORPHAN ADOPTION REQUIRES THE SAME THRESHOLD, and for a stronger reason.
 *
 * Known-SID reconciliation at least proves the caller knew a SID we issued.
 * Orphan adoption proves nothing: it attaches a stranger's claim to one of our
 * unresolved attempts on the strength of a phone number and a time window.
 * Anything below full authentication must never adopt.
 */
export const ORPHAN_ADOPT_MIN_TRUST = TRUST_CLASS.AUTHENTICATED;

function rank(trust_class) {
  return TRUST_RANK[trust_class] ?? -1;
}

/** May a receipt of this trust class advance canonical provider truth? */
export function mayAdvanceCanonicalTruthWithTrust(trust_class, threshold = CANONICAL_ADVANCE_MIN_TRUST) {
  return rank(trust_class) >= rank(threshold);
}

/** May a receipt of this trust class adopt an orphan attempt? */
export function mayAdoptOrphanWithTrust(trust_class, threshold = ORPHAN_ADOPT_MIN_TRUST) {
  return rank(trust_class) >= rank(threshold);
}

/**
 * Why a receipt was refused, in a form safe to store as adoption_reason.
 *
 * The vocabulary deliberately reuses the EXISTING adoption_status CHECK values
 * so no migration is required: an untrusted receipt has genuinely not been
 * adopted, so it remains 'unprocessed', and its processing verdict is
 * 'no_action'. A future migration may add a first-class 'untrusted_evidence'
 * status; until then this is accurate rather than merely convenient.
 */
export function untrustedRefusal(trust_class) {
  return {
    adoption_status: 'unprocessed',
    processing_status: 'no_action',
    adoption_reason: `untrusted_receipt:${trust_class || 'unknown'}`,
    policy_version: CALLBACK_TRUST_POLICY_VERSION,
  };
}

export default {
  TRUST_CLASS,
  CALLBACK_TRUST_POLICY_VERSION,
  CANONICAL_ADVANCE_MIN_TRUST,
  ORPHAN_ADOPT_MIN_TRUST,
  mayAdvanceCanonicalTruthWithTrust,
  mayAdoptOrphanWithTrust,
  untrustedRefusal,
};
