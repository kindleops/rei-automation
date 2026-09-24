/**
 * TEMPLATE FALLBACK AUTHORITY.
 *
 * Answers exactly one question: may this logical communication be attempted
 * again with a DIFFERENT approved body?
 *
 * WHY THIS IS SEPARATE FROM RETRY.
 *   `normalizeTextGridFailure` already sets `retry_allowed: false` for a
 *   content-filter block, and that is correct and must not change: resending
 *   the SAME body to the same carrier will be filtered the same way, and other
 *   systems depend on that semantic. Variant fallback is a different claim --
 *   not "try again", but "say the same thing with different approved words".
 *   Conflating them would either resurrect same-body retries or forbid variant
 *   selection; keeping them separate is what lets both be true at once.
 *
 * WHY THE ALLOW-LIST IS ONE ENTRY LONG.
 *   Content filtering is the only failure whose cause is the wording. A DNC
 *   refusal, a paused sender, a quiet-hours deferral or an invalid destination
 *   are all facts about the RECIPIENT, the SENDER or the CLOCK, and no amount
 *   of rephrasing changes any of them -- retrying those with new copy would be
 *   sending unauthorised messages with extra steps. So this fails closed:
 *   anything not positively classified as a content-filter block gets no
 *   fallback, including `unknown_failure`.
 *
 * This module grants NO messaging authority. Every other gate -- suppression,
 * opt-out, sender health, eligibility, caps, contact window, idempotency,
 * lifecycle -- is evaluated independently on the next attempt exactly as it was
 * on the first. All this decides is WHICH APPROVED BODY the next attempt uses,
 * if the system independently decides there is to be one.
 */

/**
 * One original + up to seven approved alternates.
 *
 * Attempt 1 is the originally selected template; 2..8 are alternates. The
 * ceiling is a containment bound, not a target: most groups will succeed on
 * attempt 1 or 2, and a group that burns all eight is telling you something
 * about the group, not about the recipient.
 */
export const MAX_VARIANT_ATTEMPTS = 8;

/** The only failure class whose cause is the wording. */
export const FALLBACK_ELIGIBLE_FAILURE_CLASSES = Object.freeze(["content_filter_blocked"]);

/**
 * The canonical normalized_reason that accompanies it today. Kept alongside the
 * class so a caller holding only the reason string is still answered correctly,
 * but note the ORDER of checks below: the structured class wins. Reason strings
 * are matched exactly, never by substring -- `includes("content")` would match
 * a future `content_too_long` and start rewording a malformed message.
 */
export const FALLBACK_ELIGIBLE_REASONS = Object.freeze(["blocked_by_textgrid_content_filter"]);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

/**
 * Is this failure caused by the WORDING?
 *
 * Reads the structured classification produced by
 * `normalizeTextGridFailure`. Falls back to the normalized reason only when no
 * class is present, and never guesses from free-text provider messages.
 */
export function isContentFilterFailure(failure = null) {
  if (!failure) return false;

  const failure_class = lower(failure.failure_class);
  if (failure_class) {
    return FALLBACK_ELIGIBLE_FAILURE_CLASSES.includes(failure_class);
  }

  const normalized_reason = lower(failure.normalized_reason);
  if (normalized_reason) {
    return FALLBACK_ELIGIBLE_REASONS.includes(normalized_reason);
  }

  return false;
}

/**
 * May this logical communication try another approved variant?
 *
 * @param {object} input
 * @param {object} input.failure            normalized failure for the attempt that just ended
 * @param {number} input.attemptsSoFar      variant attempts already made (>= 1 once one has run)
 * @param {boolean} input.alreadySucceeded  a prior attempt reached accepted/delivered
 * @param {number} input.remainingCandidates approved, eligible, not-yet-attempted variants
 * @returns {{allowed: boolean, reason: string, next_attempt_number: number|null}}
 */
export function evaluateVariantFallback(input = {}) {
  const {
    failure = null,
    attemptsSoFar = 0,
    alreadySucceeded = false,
    remainingCandidates = 0,
  } = input;

  /*
   * SUCCESS IS ABSORBING, AND IT IS CHECKED FIRST.
   *
   * A provider callback for attempt 1 can arrive AFTER attempt 2 has already
   * delivered. Evaluating the failure before the success would let that late
   * callback reopen a closed chain and send a second message to someone who
   * has already received one. Ordering this check first is the whole defence.
   */
  if (alreadySucceeded) {
    return { allowed: false, reason: "logical_communication_already_succeeded", next_attempt_number: null };
  }

  if (!isContentFilterFailure(failure)) {
    return { allowed: false, reason: "failure_class_not_content_filter", next_attempt_number: null };
  }

  const attempts = Number.isFinite(Number(attemptsSoFar)) ? Number(attemptsSoFar) : 0;
  if (attempts >= MAX_VARIANT_ATTEMPTS) {
    return { allowed: false, reason: "variant_attempts_exhausted", next_attempt_number: null };
  }

  if (Number(remainingCandidates) <= 0) {
    // Honest distinction: we were permitted to try another body and the estate
    // does not contain one. That is a template-inventory gap, and it must be
    // reported as such rather than as a delivery failure.
    return { allowed: false, reason: "no_remaining_approved_variants", next_attempt_number: null };
  }

  return {
    allowed: true,
    reason: "content_filter_blocked_alternate_variant_permitted",
    next_attempt_number: attempts + 1,
  };
}

/**
 * The §5 split, stated as data.
 *
 * `retry_allowed` keeps its existing meaning (same body) and is passed through
 * untouched; `alternate_variant_allowed` is the new, separate permission.
 */
export function describeFallbackDecision(failure = null, decision = null) {
  return {
    failure_class: clean(failure?.failure_class) || null,
    normalized_reason: clean(failure?.normalized_reason) || null,
    // Unchanged existing semantic -- same body.
    retry_allowed: typeof failure?.retry_allowed === "boolean" ? failure.retry_allowed : null,
    // New, separate semantic -- different approved body.
    alternate_variant_allowed: Boolean(decision?.allowed),
    fallback_reason: clean(decision?.reason) || null,
    next_variant_attempt_number: decision?.next_attempt_number ?? null,
  };
}

export default evaluateVariantFallback;
