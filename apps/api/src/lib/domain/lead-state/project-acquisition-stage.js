// ─── project-acquisition-stage.js ───────────────────────────────────────────
// THE canonical projection rule for the thread lifecycle stage.
//
// ONE ACQUISITION LIFECYCLE AUTHORITY:
//
//   acquisition_opportunities.acquisition_stage   CANONICAL
//     - transition-validated (validateStageTransition)
//     - versioned (version column, optimistic concurrency)
//     - audited (acquisition_opportunity_history)
//
//   inbox_thread_state.lifecycle_stage            PROJECTION
//     - operator-facing mirror of the canonical stage
//     - may never independently promote the acquisition lifecycle
//
//   seller_offers                                 OFFER authority
//   closing_cases                                 CONTRACT/CLOSING artifact
//
// WHY A FENCE IS NEEDED (production, thread +19549807015 / opportunity
// 2b3c261d, 2026-09-10):
// A rent of "$4100.00  per  Month." — with a double space the monetary cue
// could not match — was read as a purchase price, written as a seller_counter,
// and accepted 6 seconds later. At 11:59:17 the orchestrator projected
// lifecycle_stage asking_price -> formal_contract with reasoning_code
// S3_TO_S6_UNCLEAR. At 23:51 an authorized correction voided the offer, voided
// the closing case and reset the canonical opportunity stage to asking_price —
// but the projection stayed at formal_contract, and it has been stuck there
// ever since.
//
// It is stuck because the projection is monotonic AGAINST ITSELF:
// `validateLifecycleTransition` refuses any automated regression
// (`monotonic_stage_guard_blocked_regression`), and the gap sweep skips a
// thread whose own stage is already at or above the stage it computed. Nothing
// ever compared the projection to canonical. So a projection that overshoots
// once can never come back.
//
// TWO RULES, BOTH ENFORCED AT THE SINGLE WRITER:
//   1. FENCE — an automated writer may never set the projection ABOVE the
//      canonical acquisition stage. Monotonicity still blocks regressions; this
//      blocks the overshoot that monotonicity then makes permanent.
//   2. RECONCILE — an explicit administrative reconciliation may set the
//      projection to EXACTLY the canonical stage, in either direction, without
//      taking a manual stage lock. That is a correction of a mirror, not a
//      seller-stage regression.

import { normalizeLifecycleStage } from '@/lib/domain/lead-state/universal-lead-state-registry.js';

/** Canonical 10-stage acquisition order. Index is the stage number - 1. */
export const ACQUISITION_STAGE_ORDER = Object.freeze([
  'ownership_confirmation',
  'offer_interest',
  'asking_price',
  'property_condition',
  'offer',
  'formal_contract',
  'disposition',
  'under_contract',
  'prepared_to_close',
  'closed',
]);

const STAGE_RANK = new Map(ACQUISITION_STAGE_ORDER.map((code, i) => [code, i]));

export function acquisitionStageRank(stage) {
  if (!stage) return null;
  const code = normalizeLifecycleStage(stage);
  const rank = STAGE_RANK.get(code);
  return Number.isInteger(rank) ? rank : null;
}

/**
 * What the thread projection MUST show for this opportunity.
 *
 * Deliberately a pure read of the canonical stage. There is no inference here
 * and there must never be one: not `closing_case exists -> formal_contract`,
 * not `contract_request -> formal_contract`, not `seller_offers row exists ->
 * formal_contract`, not `high score -> anything`. Every one of those is a
 * different fact about the deal, and none of them is its acquisition stage.
 */
export function projectAcquisitionStageToThread(opportunity = null) {
  const stage = opportunity?.acquisition_stage ?? null;
  if (!stage) return null;
  const code = normalizeLifecycleStage(stage);
  return acquisitionStageRank(code) === null ? null : code;
}

export const PROJECTION_GUARDS = Object.freeze({
  CLAMPED_TO_CANONICAL: 'projection_clamped_to_canonical_acquisition_stage',
  RECONCILED: 'projection_reconciled_to_canonical_acquisition_stage',
});

/**
 * Decide what the projection is allowed to become.
 *
 * @param {object} args
 * @param {string} args.requested   stage the caller wants to write
 * @param {string} args.canonical   acquisition_opportunities.acquisition_stage
 * @param {boolean} args.reconciliation  explicit administrative correction
 * @returns {{stage: string|null, changed: boolean, guard: string|null}}
 *   `stage: null` means "drop the lifecycle_stage write entirely".
 */
export function resolveProjectedLifecycleStage({
  requested = null,
  canonical = null,
  reconciliation = false,
} = {}) {
  const requestedCode = requested ? normalizeLifecycleStage(requested) : null;
  const canonicalCode = canonical ? normalizeLifecycleStage(canonical) : null;

  // Nothing canonical to measure against — e.g. a thread with no opportunity
  // yet. The existing monotonic guard still applies downstream.
  if (!canonicalCode) return { stage: requestedCode, changed: false, guard: null };

  if (reconciliation) {
    if (requestedCode === canonicalCode) {
      return { stage: canonicalCode, changed: false, guard: PROJECTION_GUARDS.RECONCILED };
    }
    return { stage: canonicalCode, changed: true, guard: PROJECTION_GUARDS.RECONCILED };
  }

  const requestedRank = acquisitionStageRank(requestedCode);
  const canonicalRank = acquisitionStageRank(canonicalCode);
  if (requestedRank === null || canonicalRank === null) {
    return { stage: requestedCode, changed: false, guard: null };
  }

  // THE FENCE. The projection may mirror or trail canonical; it may never lead
  // it. Clamping rather than dropping keeps the thread moving with the deal.
  if (requestedRank > canonicalRank) {
    return { stage: canonicalCode, changed: true, guard: PROJECTION_GUARDS.CLAMPED_TO_CANONICAL };
  }

  return { stage: requestedCode, changed: false, guard: null };
}

export default projectAcquisitionStageToThread;
