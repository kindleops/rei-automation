/**
 * provider-outcome-lattice.js
 *
 * What a TextGrid callback status MEANS, and which way knowledge is allowed to
 * move.
 *
 * TWO SEPARATE JOBS, DELIBERATELY NOT MERGED:
 *
 *   normalizeProviderStatus()  what did the provider tell us?
 *   advanceProviderOutcome()   may that replace what we already believe?
 *
 * Collapsing them is how a late, weaker callback overwrites a stronger truth.
 *
 * ORDERING IS SEMANTIC, NOT CHRONOLOGICAL.
 *   Callbacks arrive out of order. `delivered` then `sent` is normal, and the
 *   later-arriving `sent` is OLDER, WEAKER evidence. Ranking by arrival time
 *   would silently downgrade a delivered message. Rank is a property of the
 *   status, never of when it showed up.
 *
 * THE VOCABULARY IS MEASURED, NOT GUESSED.
 *   Production outbound message_events (11,635 rows) contain exactly three
 *   provider-derived statuses: delivered (7,746), failed (2,708), sent (40).
 *   `queued` (717) and NULL (424) are LOCAL pre-send states that never came
 *   from a callback -- 0 of 717 queued rows carry a provider SID.
 *
 * WHY `failed` IS NOT `definitely_not_sent` -- THE LOAD-BEARING FINDING.
 *   The failure population splits perfectly along SID possession:
 *
 *     delivery_failed (provider callback)   2,086 rows -- 2,086 have a SID
 *     every other failure label (local)       622 rows --     0 have a SID
 *
 *   A provider `failed` callback therefore always describes a message the
 *   provider had ALREADY ACCEPTED (it issued a SID). It means "accepted, then
 *   downstream delivery failed", not "the seller never saw anything". Local
 *   failures -- missing credentials, blank-greeting guard, HTTP 400 blacklist
 *   21610, timeout, emergency brake -- are the ones that never got a SID, and
 *   those are classified on the OUTBOUND side by the transport classifier, not
 *   here.
 *
 *   So this module does NOT implement may_have_been_sent -> definitely_not_sent.
 *   No observed TextGrid status proves a message was never seller-visible, and
 *   inventing that edge would hand back retry authority for a message a seller
 *   may be holding in their hand.
 */

export const PROVIDER_STATUS_POLICY_VERSION = 'textgrid_status_v1';
export const PROVIDER_LATTICE_POLICY_VERSION = 'provider_outcome_lattice_v1';

/** Internal provider-outcome classes, ordered by CERTAINTY OF DELIVERY. */
export const PROVIDER_OUTCOME = Object.freeze({
  UNKNOWN: 'unknown',
  QUEUED_BY_PROVIDER: 'queued_by_provider',
  PROVIDER_ACCEPTED: 'provider_accepted',
  SENT_BY_PROVIDER: 'sent_by_provider',
  DELIVERED: 'delivered',
  DELIVERY_FAILED_AFTER_ACCEPTANCE: 'delivery_failed_after_acceptance',
});

/**
 * RANK = how much this outcome settles the question "did the seller get it?".
 *
 * delivered and delivery_failed_after_acceptance share the TOP rank because
 * both are terminal provider verdicts. Neither may be overwritten by the other
 * (see advanceProviderOutcome: equal rank + different class is a CONFLICT, not
 * a silent overwrite). That is deliberate: a delivered message that later
 * reports failed is not a downgrade to process, it is a contradiction to record.
 */
const RANK = Object.freeze({
  [PROVIDER_OUTCOME.UNKNOWN]: 0,
  [PROVIDER_OUTCOME.QUEUED_BY_PROVIDER]: 1,
  [PROVIDER_OUTCOME.PROVIDER_ACCEPTED]: 2,
  [PROVIDER_OUTCOME.SENT_BY_PROVIDER]: 3,
  [PROVIDER_OUTCOME.DELIVERED]: 4,
  [PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE]: 4,
});

/**
 * Observed TextGrid status vocabulary. Lowercased on lookup.
 *
 * Anything not listed is UNKNOWN and changes nothing. An unrecognised status is
 * not permission to guess: it is recorded as evidence and left inert.
 */
const STATUS_MAP = Object.freeze({
  delivered: PROVIDER_OUTCOME.DELIVERED,
  failed: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
  undelivered: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
  sent: PROVIDER_OUTCOME.SENT_BY_PROVIDER,
  accepted: PROVIDER_OUTCOME.PROVIDER_ACCEPTED,
  queued: PROVIDER_OUTCOME.QUEUED_BY_PROVIDER,
});

function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * @returns {{outcome, rank, recognised, raw, policy_version}}
 */
export function normalizeProviderStatus(rawStatus) {
  const raw = clean(rawStatus);
  const outcome = STATUS_MAP[raw] ?? PROVIDER_OUTCOME.UNKNOWN;
  return {
    outcome,
    rank: RANK[outcome],
    recognised: Boolean(STATUS_MAP[raw]),
    raw,
    policy_version: PROVIDER_STATUS_POLICY_VERSION,
  };
}

/**
 * How a provider outcome maps onto the §11 delivery_possibility axis.
 *
 * Note what is ABSENT: nothing here yields definitely_not_sent. Every provider
 * callback describes a message the provider already had, so the weakest thing a
 * callback can tell us is still "may have been sent".
 */
export function deliveryPossibilityFor(outcome) {
  switch (outcome) {
    case PROVIDER_OUTCOME.DELIVERED:
      return 'delivered';
    case PROVIDER_OUTCOME.PROVIDER_ACCEPTED:
    case PROVIDER_OUTCOME.SENT_BY_PROVIDER:
    case PROVIDER_OUTCOME.QUEUED_BY_PROVIDER:
      return 'provider_accepted';
    case PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE:
      // The provider accepted it and then failed to deliver. The seller may
      // still have received it (carrier-side failures are not uniform), so this
      // is provider_accepted, NOT definitely_not_sent.
      return 'provider_accepted';
    default:
      return null; // unknown changes nothing
  }
}

/**
 * THE MONOTONIC GATE.
 *
 * @param {string} current   current provider outcome class
 * @param {string} incoming  incoming provider outcome class
 * @returns {{action:'advance'|'idempotent'|'stale'|'conflict'|'inert', reason}}
 */
export function advanceProviderOutcome(current, incoming) {
  const from = current || PROVIDER_OUTCOME.UNKNOWN;
  const to = incoming || PROVIDER_OUTCOME.UNKNOWN;

  if (to === PROVIDER_OUTCOME.UNKNOWN) {
    // An unrecognised status is evidence we keep and knowledge we do not claim.
    return { action: 'inert', reason: 'unrecognised_provider_status' };
  }

  if (from === to) {
    return { action: 'idempotent', reason: 'same_outcome_already_recorded' };
  }

  const fromRank = RANK[from] ?? 0;
  const toRank = RANK[to] ?? 0;

  if (toRank > fromRank) {
    return { action: 'advance', reason: 'provider_certainty_increased' };
  }

  if (toRank < fromRank) {
    // Out-of-order delivery: `delivered` then `sent`. The late `sent` is older,
    // weaker evidence. Record it; do not apply it.
    return { action: 'stale', reason: 'weaker_than_current_provider_truth' };
  }

  // Equal rank, different class: delivered vs delivery_failed. Both are terminal
  // provider verdicts and they contradict each other. Never silently overwrite.
  return { action: 'conflict', reason: 'contradictory_terminal_provider_outcomes' };
}

/** True when the outcome is a terminal provider verdict. */
export function isTerminalProviderOutcome(outcome) {
  return RANK[outcome] === 4;
}

export default {
  PROVIDER_OUTCOME,
  normalizeProviderStatus,
  deliveryPossibilityFor,
  advanceProviderOutcome,
  isTerminalProviderOutcome,
  PROVIDER_STATUS_POLICY_VERSION,
  PROVIDER_LATTICE_POLICY_VERSION,
};
