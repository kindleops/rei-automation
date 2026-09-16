import { describe, expect, it } from 'vitest'
import {
  classifyCandidatesResponse,
  describeMatchCount,
  readCandidatesEnvelope,
} from './buyer-match-subject'
import {
  dedupeByBuyerEntity,
  describeActivity,
  describeDisposition,
  describeGeography,
  describeMatchGrade,
  matchReasons,
  type BuyerMatchCandidate,
} from './buyer-match-presentation'

/**
 * BUYER-MATCH-MOBILE-LOCK-1 §6/§8/§10/§14/§15/§16/§18.
 *
 * THE DEFECT THIS REPLACES. `/buyer-match` rendered `BuyerIntelPage` fed by
 * `referenceCommandCenterData` — hardcoded demo buyers and properties with
 * synthetic `minutesAgo()` timestamps — and computed its OWN match score by
 * looping buyers x demo properties, then sorted by it. No property subject
 * existed at all.
 *
 * The canonical engine was already there and already good: 26,390
 * buyer_entities_v2, 55,479 buyer_purchase_events_v2, and 350 candidates across
 * 23 runs where 100% carry reason_for_match, distance_miles, purchase counts
 * and last_purchase_date. These fixtures are real shapes from production.
 */

/** A real production candidate (property 24613730, Phoenix). */
const real = (over: Partial<BuyerMatchCandidate> = {}): BuyerMatchCandidate => ({
  buyer_match_candidate_id: 'c1',
  buyer_entity_id: 'be-1',
  buyer_name: 'Tule River Homebuyer Earned Equity Agency',
  buyer_type: 'corporate',
  total_match_score: 89.9,
  match_grade: 'A',
  reason_for_match: '2 purchase(s) in zip 85033; nearest buy 0.5mi away; active local buyer (7 nearby purchases); bought in last 6mo; ',
  buyer_response_status: 'not_contacted',
  distance_miles: 0.5,
  purchase_count: 51,
  purchase_count_365d: 35,
  last_purchase_date: '2026-01-29',
  median_purchase_price: 343000,
  matched_purchase_count: 7,
  ...over,
})

// ───────────────────────────────────────── §6 score truth

describe('the match grade is the engine\'s, never a percentage we invented', () => {
  it('maps the real A/B/C grades to words and keeps the engine score', () => {
    expect(describeMatchGrade(real({ match_grade: 'A', total_match_score: 91.4 })))
      .toEqual({ label: 'Strong match', tone: 'strong', score: '91.4' })
    expect(describeMatchGrade(real({ match_grade: 'B', total_match_score: 76.5 })))
      .toEqual({ label: 'Good match', tone: 'good', score: '76.5' })
    expect(describeMatchGrade(real({ match_grade: 'C', total_match_score: 57.2 })))
      .toEqual({ label: 'Fair match', tone: 'fair', score: '57.2' })
  })

  /** §6: "Do not display 95% Match unless the backend produces that." */
  it('never renders the score as a percentage', () => {
    for (const grade of ['A', 'B', 'C']) {
      const out = describeMatchGrade(real({ match_grade: grade }))
      expect(out.label).not.toContain('%')
      expect(out.score).not.toContain('%')
    }
  })

  it('an ungraded candidate is not promoted to a good one', () => {
    expect(describeMatchGrade(real({ match_grade: null })).tone).toBe('unknown')
    expect(describeMatchGrade(real({ match_grade: 'Z' })).label).toBe('Grade Z')
    expect(describeMatchGrade(real({ match_grade: null, total_match_score: null })).score).toBeNull()
  })
})

// ───────────────────────────────────────── §8 real evidence

describe('match reasons are the engine\'s own clauses', () => {
  it('splits the canonical reason string without rewording it', () => {
    expect(matchReasons(real())).toEqual([
      '2 purchase(s) in zip 85033',
      'nearest buy 0.5mi away',
      'active local buyer (7 nearby purchases)',
    ])
  })

  it('drops the trailing separator rather than emitting an empty reason', () => {
    expect(matchReasons(real({ reason_for_match: 'institutional capital; ' }))).toEqual(['institutional capital'])
    expect(matchReasons(real({ reason_for_match: '' }))).toEqual([])
    expect(matchReasons(real({ reason_for_match: null }))).toEqual([])
  })

  it('honours the requested limit and the engine ordering', () => {
    expect(matchReasons(real(), 1)).toEqual(['2 purchase(s) in zip 85033'])
    expect(matchReasons(real(), 10)).toHaveLength(4)
  })
})

// ───────────────────────────────────────── §14 exists != active

describe('no buyer is labelled Active without a signal for it', () => {
  it('states a factual recency marker instead', () => {
    expect(describeActivity(real())).toBe('Last purchase · Jan 2026 · 35 in 12mo')
    expect(describeActivity(real({ purchase_count_365d: 0 }))).toBe('Last purchase · Jan 2026')
  })

  it('falls back to a recorded count, and says nothing when there is nothing', () => {
    expect(describeActivity(real({ last_purchase_date: null, purchase_count: 3 }))).toBe('3 recorded purchases')
    expect(describeActivity(real({ last_purchase_date: null, purchase_count: 1 }))).toBe('1 recorded purchase')
    expect(describeActivity(real({ last_purchase_date: null, purchase_count: 0 }))).toBeNull()
  })

  it('never emits the word Active', () => {
    for (const c of [real(), real({ last_purchase_date: null, purchase_count: 9 })]) {
      expect(String(describeActivity(c))).not.toMatch(/\bactive\b/i)
    }
  })
})

describe('geography comes from recorded evidence', () => {
  it('prefers the engine distance and nearby count', () => {
    expect(describeGeography(real())).toBe('Nearest buy 0.5mi · 7 nearby')
    expect(describeGeography(real({ matched_purchase_count: 0 }))).toBe('Nearest buy 0.5mi')
  })

  it('falls back to active markets, then mailing state, then nothing', () => {
    expect(describeGeography(real({ distance_miles: null, markets_active: ['Phoenix, AZ', 'Tucson, AZ'] })))
      .toBe('Phoenix, AZ, Tucson, AZ')
    expect(describeGeography(real({ distance_miles: null, markets_active: [], mailing_state: 'AZ' })))
      .toBe('Mails to AZ')
    expect(describeGeography(real({ distance_miles: null, markets_active: [], mailing_state: null }))).toBeNull()
  })
})

// ───────────────────────────────────────── §18 disposition

describe('contacted state is canonical, never inferred from a row existing', () => {
  it('a candidate row alone is not contact', () => {
    expect(describeDisposition(real())).toEqual({ label: 'Not contacted', contacted: false })
  })

  it('reports the real statuses', () => {
    expect(describeDisposition(real({ buyer_response_status: 'package_sent' })))
      .toEqual({ label: 'Package sent', contacted: true })
    expect(describeDisposition(real({ buyer_response_status: 'passed' })))
      .toEqual({ label: 'Passed', contacted: true })
  })

  it('an unknown status is shown as itself, not folded into a friendlier one', () => {
    expect(describeDisposition(real({ buyer_response_status: 'weird_new_state' })).label).toBe('weird new state')
  })

  it('an absent status says so rather than claiming not-contacted', () => {
    expect(describeDisposition(real({ buyer_response_status: null })))
      .toEqual({ label: 'No outreach recorded', contacted: false })
  })
})

// ───────────────────────────────────────── §10 duplicates

describe('one canonical buyer, once', () => {
  /**
   * Production currently has no duplicates: every run is exactly 25 rows for 25
   * distinct buyer_entity_ids, and the endpoint scopes to the latest run. (The
   * 100-vs-25 seen per PROPERTY is four separate runs, not repetition.) This
   * keeps it true if a run ever repeats an entity.
   */
  it('keeps the highest-scoring row when an entity repeats', () => {
    const out = dedupeByBuyerEntity([
      real({ buyer_match_candidate_id: 'a', buyer_entity_id: 'be-1', total_match_score: 70 }),
      real({ buyer_match_candidate_id: 'b', buyer_entity_id: 'be-1', total_match_score: 88 }),
      real({ buyer_match_candidate_id: 'c', buyer_entity_id: 'be-2', total_match_score: 60 }),
    ])
    expect(out).toHaveLength(2)
    expect(out.find((c) => c.buyer_entity_id === 'be-1')?.buyer_match_candidate_id).toBe('b')
  })

  it('leaves a clean run untouched', () => {
    const run = Array.from({ length: 25 }, (_, i) =>
      real({ buyer_match_candidate_id: `c${i}`, buyer_entity_id: `be-${i}` }))
    expect(dedupeByBuyerEntity(run)).toHaveLength(25)
  })
})

// ───────────────────────────────────────── §16 error != empty

describe('the four states never collapse into "no buyers found"', () => {
  it('a failed request is a failure, not zero matches', () => {
    const state = classifyCandidatesResponse({ propertyId: 'p1', ok: false, message: 'fetch_failed' })
    expect(state.kind).toBe('failed')
    expect(state).toMatchObject({ message: 'fetch_failed' })
  })

  it('no run is distinguished from a run that found nothing', () => {
    expect(classifyCandidatesResponse({ propertyId: 'p1', ok: true, runId: null, total: 0 }).kind).toBe('no_run')
    expect(classifyCandidatesResponse({ propertyId: 'p1', ok: true, runId: 'r1', total: 0 }).kind).toBe('no_candidates')
  })

  it('a populated run is ready and carries the canonical total', () => {
    const state = classifyCandidatesResponse({ propertyId: 'p1', ok: true, runId: 'r1', total: 25, loaded: 25 })
    expect(state).toEqual({ kind: 'ready', propertyId: 'p1', runId: 'r1', total: 25, loaded: 25 })
  })
})

// ───────────────────────────────────────── §15 count truth

describe('counts are truthful and disclose a cap', () => {
  it('states the canonical total when everything is loaded', () => {
    expect(describeMatchCount(25, 25)).toBe('25 matches')
    expect(describeMatchCount(1, 1)).toBe('1 match')
  })

  it('discloses truncation rather than showing the page size as the total', () => {
    expect(describeMatchCount(350, 50)).toBe('Showing 50 of 350 matches')
  })

  it('zero is zero', () => {
    expect(describeMatchCount(0, 0)).toBe('No matches')
  })
})

// ────────────────────────────────── the envelope, and error-is-not-empty (§16)

/**
 * THE DEFECT THIS LOCKS.
 *
 * `callBackend` returns `{ ok, status, data }` where `data` is the whole
 * response BODY, and the body is itself `{ ok, data: {...} }`. The surface read
 * `res.data.candidates` — one level too shallow — so for a property with 25
 * canonical candidates it got `undefined` candidates and an `undefined`
 * run_id, classified that as "No match run for this property yet", and showed
 * the operator a confident empty state. Measured 2026-09-16: the endpoint
 * returned run 86b21a07 with 25 candidates while the UI rendered 0 cards.
 *
 * The important part is not the missing level — it is that THREE different
 * failures all produced the same output as a legitimate empty result.
 */
describe('the candidates envelope is unwrapped at the right depth', () => {
  const payload = (candidates: unknown[], extra: Record<string, unknown> = {}) => ({
    ok: true,
    data: { ok: true, data: { candidates, total: candidates.length, run_id: 'run-1', ...extra } },
  })

  it('reads candidates from the nested payload, not the envelope', () => {
    const read = readCandidatesEnvelope(payload([{ buyer_name: 'A' }, { buyer_name: 'B' }]))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.candidates).toHaveLength(2)
    expect(read.runId).toBe('run-1')
    expect(read.total).toBe(2)
  })

  /** The exact shape that produced the bug: payload one level too deep to see. */
  it('does not mistake the envelope for the payload', () => {
    const read = readCandidatesEnvelope({ ok: true, data: { ok: true, data: null } })
    expect(read.ok, 'a missing payload is a failure, not an empty match set').toBe(false)
  })

  it('reports a transport failure as a failure', () => {
    const read = readCandidatesEnvelope({ ok: false, error: 'HTTP_500', message: 'boom' })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.message).toBe('boom')
  })

  it('reports an envelope-level ok:false as a failure', () => {
    const read = readCandidatesEnvelope({
      ok: true,
      data: { ok: false, error: 'RUN_LOOKUP_FAILED', message: 'could not read the run' },
    })
    expect(read.ok, 'HTTP 200 with ok:false is still an error').toBe(false)
    if (read.ok) return
    expect(read.message).toBe('could not read the run')
  })

  /**
   * The distinction the whole surface rests on: a run that genuinely found
   * nobody is EMPTY, and must not be reported as an error; every failure above
   * must not be reported as empty.
   */
  it('a genuinely empty run is empty, not an error', () => {
    const read = readCandidatesEnvelope({
      ok: true,
      data: { ok: true, data: { candidates: [], total: 0, run_id: 'run-empty' } },
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.candidates).toHaveLength(0)
    expect(read.runId, 'the run existed and found nobody').toBe('run-empty')
  })

  it('never turns an absent total into a confident zero', () => {
    const read = readCandidatesEnvelope({
      ok: true,
      data: { ok: true, data: { candidates: [{ buyer_name: 'A' }], run_id: 'r' } },
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.total, 'falls back to what arrived rather than asserting 0').toBe(1)
  })

  it('each failure reaches a state the operator can tell apart from empty', () => {
    const failed = classifyCandidatesResponse({ propertyId: 'p1', ok: false, message: 'boom' })
    const empty = classifyCandidatesResponse({ propertyId: 'p1', ok: true, runId: 'r', total: 0, loaded: 0 })
    const norun = classifyCandidatesResponse({ propertyId: 'p1', ok: true, runId: null, total: 0, loaded: 0 })
    expect(new Set([failed.kind, empty.kind, norun.kind]).size,
      'failed / no_candidates / no_run must be three distinct states').toBe(3)
  })
})

// ────────────────────────────────────────── §13 disposition write authority

/**
 * "Send Package" TRANSMITS NOTHING. The desktop workspace button writes
 * `package_sent_at` and `buyer_response_status: 'package_sent'` to the
 * candidate row and stops — no email, no SMS, no messaging infrastructure, and
 * therefore no DNC or suppression check.
 *
 * So the shared disposition authority must not offer it. A mobile control
 * labelled "Send Package" would record outreach to a buyer that never left the
 * building, which is manufactured evidence.
 */
describe('the shared buyer action authority offers no fake send', () => {
  it('exposes only actions that mean what they say', async () => {
    const actions = await import('./buyer-match-actions')
    expect(typeof actions.setBuyerDisposition).toBe('function')
    expect(typeof actions.selectBuyerCandidate).toBe('function')
    expect(
      Object.keys(actions).some((k) => /send|package|outreach|email|sms|blast/i.test(k)),
      'no send-shaped export may exist here until a real send path with suppression does',
    ).toBe(false)
  })

  it('refuses a write with no candidate rather than guessing one', async () => {
    const { setBuyerDisposition, selectBuyerCandidate } = await import('./buyer-match-actions')
    for (const res of [await setBuyerDisposition(undefined, 'interested'), await selectBuyerCandidate(null)]) {
      expect(res.ok).toBe(false)
      expect(res.updates).toEqual({})
    }
  })
})
