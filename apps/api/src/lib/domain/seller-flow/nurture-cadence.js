/**
 * V2-2 — NURTURE CADENCE.
 *
 * THE RULE THIS MODULE EXISTS TO HOLD:
 *
 *     no seller inbound → no new seller facts → no stage advancement
 *
 * A nurture touch may move `attempt_count`, `last_attempt_at`,
 * `next_follow_up_at` and `nurture_cycle`. It may never produce ownership,
 * interest, an asking price, condition, occupancy, rents or acceptance. Every
 * decision this module returns therefore carries `seller_facts_created: 0` and
 * `stage_advanced: false`, so a consumer can assert the property from the
 * return value without re-deriving it.
 *
 * WHY A SEPARATE MODULE RATHER THAN MORE ENTRIES IN NURTURE_DAYS. The existing
 * `seller-followup-scheduler.js` NURTURE_DAYS map is a single flat
 * intent → days lookup: `not_interested: 30`, and nothing after it. It can
 * express "wait 30 days" but not "30, then 60, then 90, then stop", because it
 * has no notion of WHICH touch we are on. Adding a second and third number to
 * that map cannot work — the map has no cycle. This module supplies the cycle;
 * the existing scheduler keeps owning the queue write.
 *
 * REASONS STAY DISTINCT. not_interested / price_gap / strategy_exhausted are
 * different seller postures that will eventually deserve different copy and
 * different spacing. Flattening them into one "nurture" fact would destroy the
 * distinction before the later increments can use it, so the reason is
 * first-class here even though only `not_interested` is populated today.
 *
 * NOTHING HERE SENDS, and nothing here schedules. It answers "is a nurture
 * touch due, and which one" — the caller still applies suppression, DNC,
 * contact validity, governance and send authority before anything reaches a
 * seller.
 */

const clean = (value) => String(value ?? '').trim()

/** Why a thread is in nurture. Distinct postures, deliberately not merged. */
export const NURTURE_REASON = Object.freeze({
  NOT_INTERESTED: 'not_interested',
  // Populated by later V2 increments; modelled now so the durable state does
  // not have to change shape when they land.
  PRICE_GAP: 'price_gap',
  STRATEGY_EXHAUSTED: 'strategy_exhausted',
})

export const NURTURE_STATUS = Object.freeze({
  ACTIVE: 'active',
  DUE: 'due',
  COMPLETED: 'completed_long_term_hold',
  CANCELLED: 'cancelled',
})

/**
 * Cycle spacing, in days from the PREVIOUS eligible touch.
 *
 * 30 / 60 / 90 is cumulative spacing, not absolute offsets from the original
 * reply: touch 2 is 60 days after touch 1 actually happened. Anchoring to the
 * original reply would bunch the touches up whenever a touch was delayed by
 * suppression or a contact window.
 */
export const NURTURE_CYCLE_DAYS = Object.freeze({
  [NURTURE_REASON.NOT_INTERESTED]: Object.freeze([30, 60, 90]),
  [NURTURE_REASON.PRICE_GAP]: Object.freeze([30, 60, 90]),
  [NURTURE_REASON.STRATEGY_EXHAUSTED]: Object.freeze([30, 60, 90]),
})

const DAY_MS = 24 * 60 * 60 * 1000

function toDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

/**
 * Plan the next nurture touch.
 *
 * Deliberately returns ONE touch. Pre-creating three messages would mean three
 * rows that each escape the re-validation every cycle is supposed to perform,
 * and a seller who opts out after touch 1 would still have touches 2 and 3
 * sitting in the queue.
 *
 * @param {object} input
 * @param {string} input.reason        NURTURE_REASON
 * @param {number} [input.cycle]       touches already completed (0 = none yet)
 * @param {string} [input.last_attempt_at]
 * @param {string} [input.entered_at]  when the thread entered nurture
 * @param {string} [input.now]
 */
export function planNextNurtureTouch({
  reason = NURTURE_REASON.NOT_INTERESTED,
  cycle = 0,
  last_attempt_at = null,
  entered_at = null,
  now = null,
} = {}) {
  const schedule = NURTURE_CYCLE_DAYS[clean(reason)] || null
  const base = {
    reason: clean(reason) || null,
    cycle,
    seller_facts_created: 0,
    stage_advanced: false,
    sends: 0,
  }

  if (!schedule) {
    return { ...base, status: NURTURE_STATUS.CANCELLED, due: false, next_follow_up_at: null, decision_reason: 'unknown_nurture_reason' }
  }

  // Sequence complete: an explicit long-term hold, NOT an endless monthly drip.
  if (cycle >= schedule.length) {
    return {
      ...base,
      status: NURTURE_STATUS.COMPLETED,
      due: false,
      next_follow_up_at: null,
      requires_review: true,
      decision_reason: 'nurture_sequence_complete_long_term_hold',
    }
  }

  const anchor = toDate(last_attempt_at) || toDate(entered_at)
  if (!anchor) {
    return { ...base, status: NURTURE_STATUS.ACTIVE, due: false, next_follow_up_at: null, decision_reason: 'no_anchor_timestamp' }
  }

  const days = schedule[cycle]
  const nextAt = new Date(anchor.getTime() + days * DAY_MS)
  const current = toDate(now) || new Date()

  return {
    ...base,
    status: current >= nextAt ? NURTURE_STATUS.DUE : NURTURE_STATUS.ACTIVE,
    due: current >= nextAt,
    next_follow_up_at: nextAt.toISOString(),
    interval_days: days,
    next_cycle: cycle + 1,
    total_cycles: schedule.length,
    decision_reason: current >= nextAt ? 'nurture_touch_due' : 'nurture_touch_not_yet_due',
  }
}

/**
 * Re-validate a nurture touch immediately before it is acted on.
 *
 * Every cycle re-checks, rather than trusting the state that existed when the
 * touch was planned — 30 to 90 days is more than long enough for a seller to
 * opt out, for the number to go DNC, or for the opportunity to close.
 *
 * Opt-out is checked FIRST and is terminal: nurture must never resurrect a
 * suppressed contact.
 */
export function revalidateNurtureTouch({
  opted_out = false,
  dnc = false,
  suppressed = false,
  contact_valid = true,
  opportunity_closed = false,
  new_inbound_since_plan = false,
  ownership_changed = false,
} = {}) {
  const blockers = []
  // Compliance first, and terminal — the others are merely disqualifying.
  if (opted_out) blockers.push('opted_out')
  if (dnc) blockers.push('dnc')
  if (suppressed) blockers.push('suppressed')
  if (!contact_valid) blockers.push('contact_invalid')
  if (opportunity_closed) blockers.push('opportunity_closed')
  // A reply means the seller re-engaged; nurture is the wrong lane now and the
  // live conversation must take over.
  if (new_inbound_since_plan) blockers.push('new_inbound_supersedes_nurture')
  if (ownership_changed) blockers.push('ownership_changed')

  return {
    eligible: blockers.length === 0,
    blockers,
    terminal: opted_out || dnc,
    seller_facts_created: 0,
    stage_advanced: false,
    sends: 0,
  }
}

/**
 * Advance the durable cycle after a touch was actually delivered.
 *
 * Only ever moves communication state. Listed explicitly so a reviewer can see
 * that no seller-fact key is reachable from here.
 */
export function advanceNurtureCycle({ cycle = 0, reason = NURTURE_REASON.NOT_INTERESTED, attempted_at = null } = {}) {
  const schedule = NURTURE_CYCLE_DAYS[clean(reason)] || []
  const next = cycle + 1
  return {
    nurture_cycle: next,
    attempt_count_delta: 1,
    last_attempt_at: attempted_at || new Date().toISOString(),
    status: next >= schedule.length ? NURTURE_STATUS.COMPLETED : NURTURE_STATUS.ACTIVE,
    // The invariant, restated where it is easiest to violate.
    seller_facts_created: 0,
    stage_advanced: false,
  }
}

export default planNextNurtureTouch
