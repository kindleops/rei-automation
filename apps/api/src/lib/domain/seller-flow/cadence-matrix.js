/**
 * V2-2B — CADENCE MATRIX.
 *
 *     (stage, cadence profile, attempt number) → delay
 *
 * The old model was one scalar delay per stage, which forced a single number
 * to serve a cold list lead and a verified pre-foreclosure alike. It also made
 * the S3 requirement unsatisfiable: a 24-hour asking-price follow-up created a
 * "cadence hump" against the scalar monotonic guard, and the only way to
 * satisfy that guard was to flatten three later stages to 24 hours for
 * everyone. Splitting the profile out removes the false choice.
 *
 * EVERYTHING IS IN HOURS. Days could not express the 24h stages and hours can
 * express days, so one unit avoids a class of conversion bug at the boundary.
 *
 * TWO INVARIANTS REPLACE THE OLD SCALAR TEST (they are enforced by test, and
 * the tables below are written to satisfy them):
 *
 *   A. Within ONE profile, each stage's FIRST delay is <= the previous
 *      stage's first delay. Urgency tightens as the seller advances. Profiles
 *      are compared separately — STANDARD S1 against URGENT S2 is not one
 *      lifecycle and comparing them is meaningless.
 *
 *   B. Within one (stage, profile), attempt N+1's delay is >= attempt N's.
 *      Unanswered touches spread out. This is what stops an urgent lead
 *      becoming an indefinite daily chase.
 *
 * S1 IS DELIBERATELY COLD ON STANDARD. A cold list owner who has not replied
 * to a first text is not a conversation; 30 then 60 days respects that, and
 * after two touches the CONTACT is exhausted — which hands the property back
 * to V2-1 contact resolution rather than declaring the owner uninterested.
 */

import { LIFECYCLE_STAGE_CODES as C } from '@/lib/domain/lead-state/universal-lead-state-registry.js'
import { CADENCE_PROFILE } from './cadence-priority-resolver.js'

const H = 1
const D = 24

/**
 * delays_hours[n] is the wait before attempt n+1, measured from the previous
 * delivered outbound. `max_attempts` is the hard ceiling for the pairing.
 */
export const CADENCE_MATRIX = Object.freeze({
  [CADENCE_PROFILE.STANDARD]: Object.freeze({
    // Cold. Two touches, then hand back to contact resolution.
    [C.OWNERSHIP_CONFIRMATION]: Object.freeze({ delays_hours: [30 * D, 60 * D], max_attempts: 2 }),
    [C.OFFER_INTEREST]:        Object.freeze({ delays_hours: [3 * D, 7 * D, 14 * D], max_attempts: 3 }),
    [C.ASKING_PRICE]:          Object.freeze({ delays_hours: [24 * H, 3 * D, 7 * D], max_attempts: 3 }),
    [C.PROPERTY_CONDITION]:    Object.freeze({ delays_hours: [24 * H, 3 * D, 7 * D], max_attempts: 3 }),
    [C.OFFER]:                 Object.freeze({ delays_hours: [24 * H, 3 * D], max_attempts: 2 }),
    [C.FORMAL_CONTRACT]:       Object.freeze({ delays_hours: [24 * H, 2 * D], max_attempts: 2 }),
  }),

  [CADENCE_PROFILE.PRIORITY]: Object.freeze({
    // Verified time pressure with no fixed clock: faster at the cold stage,
    // identical downstream because those stages are already conversational.
    [C.OWNERSHIP_CONFIRMATION]: Object.freeze({ delays_hours: [7 * D, 14 * D, 30 * D], max_attempts: 3 }),
    [C.OFFER_INTEREST]:        Object.freeze({ delays_hours: [3 * D, 7 * D, 14 * D], max_attempts: 3 }),
    [C.ASKING_PRICE]:          Object.freeze({ delays_hours: [24 * H, 3 * D, 7 * D], max_attempts: 3 }),
    [C.PROPERTY_CONDITION]:    Object.freeze({ delays_hours: [24 * H, 3 * D, 7 * D], max_attempts: 3 }),
    [C.OFFER]:                 Object.freeze({ delays_hours: [24 * H, 3 * D], max_attempts: 2 }),
    [C.FORMAL_CONTRACT]:       Object.freeze({ delays_hours: [24 * H, 2 * D], max_attempts: 2 }),
  }),

  [CADENCE_PROFILE.URGENT]: Object.freeze({
    // S1's FIRST delay is deadline-aware and computed, not read from here;
    // this entry supplies the ceiling and the spread for later attempts. The
    // listed first value is the slowest urgent opening (72h) so the table
    // still satisfies invariant B when the deadline is distant.
    [C.OWNERSHIP_CONFIRMATION]: Object.freeze({ delays_hours: [72 * H, 72 * H, 120 * H], max_attempts: 3, deadline_aware_first: true }),
    [C.OFFER_INTEREST]:        Object.freeze({ delays_hours: [24 * H, 48 * H, 96 * H], max_attempts: 3 }),
    [C.ASKING_PRICE]:          Object.freeze({ delays_hours: [24 * H, 48 * H, 96 * H], max_attempts: 3 }),
    [C.PROPERTY_CONDITION]:    Object.freeze({ delays_hours: [24 * H, 48 * H, 96 * H], max_attempts: 3 }),
    [C.OFFER]:                 Object.freeze({ delays_hours: [24 * H, 48 * H], max_attempts: 2 }),
    [C.FORMAL_CONTRACT]:       Object.freeze({ delays_hours: [24 * H, 48 * H], max_attempts: 2 }),
  }),
})

/**
 * Deadline-aware opening delay for an URGENT S1.
 *
 * Never below 24h. Going lower would collide with the contact window and
 * quiet-hours rules, and an auction three days away does not make a 6am text
 * acceptable.
 */
export function resolveUrgentS1FirstDelayHours(daysToDeadline) {
  const days = Number(daysToDeadline)
  if (!Number.isFinite(days)) return 72
  if (days <= 7) return 24
  if (days <= 21) return 48
  return 72
}

/**
 * Resolve the delay before the next attempt.
 *
 * @param {object} input
 * @param {string} input.stage        canonical lifecycle stage code
 * @param {string} input.profile      CADENCE_PROFILE
 * @param {number} input.attempt      attempts ALREADY made (0 = none yet)
 * @param {number} [input.days_to_deadline]
 * @returns {object} — `due` is never decided here; the caller compares
 *                     next_at against the clock.
 */
export function resolveCadence({ stage, profile = CADENCE_PROFILE.STANDARD, attempt = 0, days_to_deadline = null } = {}) {
  const profileTable = CADENCE_MATRIX[profile] || CADENCE_MATRIX[CADENCE_PROFILE.STANDARD]
  const entry = profileTable[stage] || null

  if (!entry) {
    // Unknown or operational stage: no automated seller follow-up. Absence of
    // a policy is not permission to invent one.
    return {
      eligible: false,
      reason: 'no_cadence_policy_for_stage',
      stage, profile, attempt,
      delay_hours: null, max_attempts: 0, exhausted: true,
    }
  }

  if (attempt >= entry.max_attempts) {
    return {
      eligible: false,
      reason: 'attempts_exhausted',
      stage, profile, attempt,
      delay_hours: null,
      max_attempts: entry.max_attempts,
      exhausted: true,
      // S1 exhaustion specifically must hand back to contact resolution rather
      // than concluding anything about the owner.
      hands_back_to_contact_resolution: stage === C.OWNERSHIP_CONFIRMATION,
    }
  }

  let delay = entry.delays_hours[attempt]
  if (entry.deadline_aware_first && attempt === 0) {
    delay = resolveUrgentS1FirstDelayHours(days_to_deadline)
  }

  return {
    eligible: true,
    reason: 'cadence_resolved',
    stage,
    profile,
    attempt,
    next_attempt: attempt + 1,
    delay_hours: delay,
    max_attempts: entry.max_attempts,
    exhausted: false,
    deadline_aware: Boolean(entry.deadline_aware_first && attempt === 0),
  }
}

/** First-attempt delay for a (stage, profile) — the input to invariant A. */
export function firstDelayHours(profile, stage, daysToDeadline = null) {
  const entry = (CADENCE_MATRIX[profile] || {})[stage]
  if (!entry) return null
  if (entry.deadline_aware_first) return resolveUrgentS1FirstDelayHours(daysToDeadline)
  return entry.delays_hours[0]
}

/** Compute the absolute next-attempt instant. Pure; no clock is read. */
export function computeNextFollowUpAt({ from, delay_hours }) {
  if (!from || !Number.isFinite(Number(delay_hours))) return null
  const base = from instanceof Date ? from : new Date(from)
  if (!Number.isFinite(base.getTime())) return null
  return new Date(base.getTime() + Number(delay_hours) * 60 * 60 * 1000).toISOString()
}

export default resolveCadence
