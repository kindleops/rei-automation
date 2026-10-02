/**
 * Campaign send caps: one reading of the operator's throttle columns
 * (rc-7.1 D9b).
 *
 *   null / absent  -> no campaign-level cap of that kind (other bounds still
 *                     apply: buffer, hydration chunk, sender/window capacity)
 *   0              -> SEND NOTHING. "Throttle to zero" is a stop, never "unlimited".
 *   n > 0          -> at most n
 *
 * The defect this replaces: PATCH stored 0 as null (positive-int coercion +
 * `|| null`), and the feeder read `cap ? ... : Infinity`, so throttling a live
 * campaign to zero uncapped it.
 */

export const CAMPAIGN_CAP_COLUMNS = Object.freeze(['daily_cap', 'total_cap', 'market_cap', 'per_sender_cap'])

/** null for "not set" (null/undefined/''), else a non-negative integer, else NaN (invalid). */
function readCap(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  if (typeof value === 'boolean') return Number.NaN
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return Number.NaN
  return Math.trunc(parsed)
}

/** Parse a cap for storage or reading: null (unset) | 0 (send nothing) | n. Invalid -> null. */
export function parseCampaignCap(value) {
  const cap = readCap(value)
  return Number.isNaN(cap) ? null : cap
}

/** True when the value is a valid cap input (unset, zero or a positive number). */
export function isValidCampaignCapInput(value) {
  return !Number.isNaN(readCap(value))
}

/** Remaining room under a cap: Infinity when unset, never negative. */
export function capRemaining(cap, used = 0) {
  const parsed = parseCampaignCap(cap)
  if (parsed === null) return Number.POSITIVE_INFINITY
  return Math.max(0, parsed - Math.max(0, Number(used) || 0))
}

/** The cap columns explicitly set to 0 on a campaign row (or input). */
export function zeroCampaignCaps(source = {}) {
  return CAMPAIGN_CAP_COLUMNS.filter((column) => parseCampaignCap(source?.[column]) === 0)
}
