/**
 * V2-2B — CADENCE ACTIVATION BOUNDARY.
 *
 * THE PROBLEM. 7,798 production threads are awaiting a reply, 7,259 of them
 * for more than 30 days, and none has a cadence row. A scheduler that asks
 * only "is next_follow_up_at in the past?" would treat every one of them as
 * due the moment cadence is armed, because that question cannot distinguish
 * "we are waiting on this seller" from "we stopped talking to this seller in
 * May". The blast radius is thousands of texts to people who last heard from
 * us months ago.
 *
 * THE BOUNDARY. `enrolled_at` is the only thing the scheduler may consider. A
 * thread with a NULL enrolled_at is `legacy_unenrolled` and is invisible — not
 * filtered late, but absent from the partial index the due query uses, so a
 * forgotten WHERE clause returns nothing rather than returning the backlog.
 *
 * TWO WAYS IN, both deliberate:
 *   1. a NEW objective created after activation — normal forward operation;
 *   2. an explicitly bounded controlled enrolment — this module.
 *
 * There is no third path, and `enrollAll` does not exist. Every entry point
 * here REQUIRES an explicit limit and refuses an unbounded selector, because
 * the failure mode is not "too many rows returned" but "thousands of people
 * texted".
 */

const clean = (value) => String(value ?? '').trim()

export const ACTIVATION_SOURCE = Object.freeze({
  NEW_OBJECTIVE: 'new_objective_post_activation',
  CONTROLLED: 'controlled_enrollment',
  LEGACY: 'legacy_unenrolled',
})

export const CADENCE_POLICY_VERSION = 'v2_2b_profile_cadence_v1'

/** Hard ceiling for one controlled enrolment call. */
export const MAX_ENROLLMENT_BATCH = 100

export const ENROLLMENT_REFUSAL = Object.freeze({
  NO_LIMIT: 'enrollment_requires_explicit_limit',
  LIMIT_TOO_LARGE: 'enrollment_limit_exceeds_max_batch',
  NO_SELECTOR: 'enrollment_requires_bounded_selector',
  UNBOUNDED: 'enrollment_selector_is_unbounded',
})

/**
 * Is a thread visible to the scheduler at all?
 *
 * Checked before any timing question. An unenrolled row is not "not yet due" —
 * it is out of scope, and reporting it as not-due would invite someone to
 * "fix" the timing later.
 */
export function isEnrolled(row = {}) {
  return Boolean(row.enrolled_at)
}

export function enrollmentStatus(row = {}) {
  if (!row.enrolled_at) {
    return { enrolled: false, status: ACTIVATION_SOURCE.LEGACY, scheduler_visible: false }
  }
  return {
    enrolled: true,
    status: clean(row.activation_source) || ACTIVATION_SOURCE.CONTROLLED,
    policy_version: clean(row.policy_version) || null,
    scheduler_visible: true,
  }
}

/**
 * Enrolment fields for a NEW objective created after activation.
 *
 * This is the forward path: a thread that reaches a new objective today is
 * enrolled because the objective itself is new, not because the thread is old.
 */
export function buildForwardEnrollment({ now = null } = {}) {
  return {
    enrolled_at: now || new Date().toISOString(),
    activation_source: ACTIVATION_SOURCE.NEW_OBJECTIVE,
    policy_version: CADENCE_POLICY_VERSION,
  }
}

/**
 * Validate a controlled historical enrolment request.
 *
 * Refuses before touching the database. The selector must actually narrow: a
 * request with only `{ limit: 100 }` and no dimension would enrol the oldest
 * hundred threads in the system, which is a bounded count but an arbitrary and
 * unreviewable population.
 *
 * @param {object} request { thread_keys?, market?, stage?, cadence_profile?,
 *                           age_band_days?, limit }
 */
export function validateControlledEnrollment(request = {}) {
  const limit = Number(request.limit)
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: false, reason: ENROLLMENT_REFUSAL.NO_LIMIT }
  }
  if (limit > MAX_ENROLLMENT_BATCH) {
    return { ok: false, reason: ENROLLMENT_REFUSAL.LIMIT_TOO_LARGE, max: MAX_ENROLLMENT_BATCH }
  }

  const threadKeys = Array.isArray(request.thread_keys) ? request.thread_keys.filter(Boolean) : []
  const selectors = {
    thread_keys: threadKeys.length ? threadKeys : null,
    market: clean(request.market) || null,
    stage: clean(request.stage) || null,
    cadence_profile: clean(request.cadence_profile) || null,
    age_band_days: Number.isFinite(Number(request.age_band_days)) ? Number(request.age_band_days) : null,
  }

  const active = Object.entries(selectors).filter(([, v]) => v !== null)
  if (!active.length) {
    return { ok: false, reason: ENROLLMENT_REFUSAL.NO_SELECTOR }
  }

  // An explicit thread list is already bounded by its own length.
  const effectiveLimit = selectors.thread_keys
    ? Math.min(limit, selectors.thread_keys.length)
    : limit

  return {
    ok: true,
    selectors: Object.fromEntries(active),
    limit: effectiveLimit,
    activation_source: ACTIVATION_SOURCE.CONTROLLED,
    policy_version: CADENCE_POLICY_VERSION,
    // Stated so a caller cannot read a validated request as an executed one.
    executed: false,
    sends: 0,
  }
}

/**
 * Plan a controlled enrolment. Returns the rows that WOULD be enrolled.
 *
 * Split from execution deliberately: the plan is reviewable, and V2-2B is a
 * contained pass in which no historical thread may actually be enrolled.
 */
export function planControlledEnrollment(request = {}, candidates = []) {
  const validation = validateControlledEnrollment(request)
  if (!validation.ok) return { ...validation, planned: [], count: 0 }

  const { selectors, limit } = validation
  let pool = Array.isArray(candidates) ? candidates : []

  if (selectors.thread_keys) {
    const wanted = new Set(selectors.thread_keys)
    pool = pool.filter((row) => wanted.has(clean(row.thread_key)))
  }
  if (selectors.market) pool = pool.filter((row) => clean(row.market) === selectors.market)
  if (selectors.stage) pool = pool.filter((row) => clean(row.origin_stage) === selectors.stage)
  if (selectors.cadence_profile) pool = pool.filter((row) => clean(row.cadence_profile) === selectors.cadence_profile)
  // Number.isFinite, not `!== null`: validateControlledEnrollment strips unset
  // selectors via Object.fromEntries, so an absent age band arrives as
  // `undefined`. `undefined !== null` is true, which applied a `<= NaN`
  // comparison and silently filtered the entire pool to nothing — an
  // enrolment that looks successful and enrols no one.
  if (Number.isFinite(selectors.age_band_days)) {
    pool = pool.filter((row) => Number(row.age_days) <= selectors.age_band_days)
  }

  // Never enrol something already enrolled — re-enrolment would reset the
  // attempt history and give a thread a fresh set of touches.
  pool = pool.filter((row) => !row.enrolled_at)

  const planned = pool.slice(0, limit)

  return {
    ok: true,
    selectors,
    limit,
    planned,
    count: planned.length,
    truncated: pool.length > planned.length,
    pool_size: pool.length,
    enrollment_fields: {
      activation_source: ACTIVATION_SOURCE.CONTROLLED,
      policy_version: CADENCE_POLICY_VERSION,
    },
    executed: false,
    sends: 0,
  }
}

export default planControlledEnrollment
