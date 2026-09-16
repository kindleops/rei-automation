import { describe, expect, it } from 'vitest'
import { numOrNull } from './kpiDashboardData'

/**
 * ANALYTICS-MOBILE-LOCK-1 §46.
 *
 * THE DEFECT THIS LOCKS. The service reports "not measured" as null — for an
 * unwired buyer source, an uncommissioned email channel, absent
 * offer/contract/closing authorities, and health scores with no rows to judge.
 * The client mapped every number through:
 *
 *   const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
 *
 * and `Number(null)` is 0 while `Number.isFinite(0)` is true — so every null
 * silently became a zero and the entire distinction was erased at the
 * boundary. An operator would have seen "0 offers created" for a pipeline the
 * system cannot see at all. Same trap as the buyer-match match scores.
 */
describe('a null from the metrics service never becomes a zero', () => {
  it('preserves null for values that were not measured', () => {
    for (const absent of [null, undefined, '']) {
      expect(numOrNull(absent), `${JSON.stringify(absent)} must stay null`).toBeNull()
    }
  })

  it('is the specific trap Number() falls into', () => {
    // Documents WHY numOrNull exists rather than reusing num().
    expect(Number(null)).toBe(0)
    expect(Number.isFinite(Number(null))).toBe(true)
    expect(numOrNull(null)).toBeNull()
  })

  it('keeps a genuine zero as zero', () => {
    // Zero IS data — a real "nothing happened" must survive intact.
    expect(numOrNull(0)).toBe(0)
    expect(numOrNull('0')).toBe(0)
  })

  it('passes real numbers through unchanged', () => {
    expect(numOrNull(148)).toBe(148)
    expect(numOrNull('60')).toBe(60)
    expect(numOrNull(17.3)).toBe(17.3)
  })

  it('rejects non-numeric junk rather than inventing a figure', () => {
    // [] and true are the subtle ones: Number([]) is 0 and Number(true) is 1,
    // so a loose coercion turns both into a confident measurement.
    for (const junk of ['n/a', 'unknown', {}, [], NaN, Infinity, -Infinity, true, false]) {
      expect(numOrNull(junk), `${JSON.stringify(junk)} must not become a number`).toBeNull()
    }
  })

  /**
   * The distinction the whole surface rests on: zero is a measurement, null is
   * the absence of one, and they must never collapse into each other.
   */
  it('keeps "measured zero" and "not measured" distinguishable', () => {
    expect(numOrNull(0)).not.toBeNull()
    expect(numOrNull(null)).toBeNull()
    expect(numOrNull(0) === numOrNull(null)).toBe(false)
  })
})
