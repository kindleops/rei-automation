import { describe, expect, it } from 'vitest'
import {
  AGE_BUCKETS,
  ageBucket,
  arrivals,
  clockBucket,
  groupOffers,
  liveCount,
  moveToActivity,
  pulseRoute,
  riverReaches,
  riverStrata,
  stackStrata,
  stratumPath,
} from './pipeline-desk-model'
import type { DeskMove, DeskOfferRow, DeskStage } from './pipeline-desk-api'

const stage = (code: string, over: Partial<DeskStage> = {}): DeskStage => ({
  code, index: 1, short: 'S1', label: code, group: 'g', count: 0, working: 0, dormant: 0, attention: 0, stalled: 0, movedToday: 0, value: null, ...over,
})

describe('the river', () => {
  it('thickness follows √count; an empty reach is a dry 2px channel', () => {
    const r = riverReaches([76, 5, 0], { along: 300, across: 120, minT: 10 })
    expect(r[0].t).toBe(120)
    expect(r[1].t).toBeCloseTo(120 * Math.sqrt(5) / Math.sqrt(76), 5)
    expect(r[2].t).toBe(2)
    expect(r.map((x) => x.c)).toEqual([50, 150, 250])
  })

  it('a stratum path is one closed shape with no NaN', () => {
    const reaches = riverReaches([4, 9, 1, 0], { along: 400, across: 100 })
    const path = stratumPath(reaches, reaches.map((r) => [0, r.t] as [number, number]), { mid: 60 })
    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    expect(path).not.toMatch(/NaN|undefined/)
    const vertical = stratumPath(reaches, reaches.map((r) => [0, r.t] as [number, number]), { mid: 60, orientation: 'vertical' })
    expect(vertical).not.toEqual(path)
  })

  it('strata stack inside a reach with a 2px surface gap and never exceed its thickness', () => {
    const reaches = riverReaches([10], { along: 100, across: 80 })
    const stacked = stackStrata(reaches, [
      { key: 'a', label: 'a', color: 'x', values: [6] },
      { key: 'b', label: 'b', color: 'y', values: [0] },
      { key: 'c', label: 'c', color: 'z', values: [4] },
    ])
    const [a, b, c] = stacked.map((s) => s.edges[0])
    expect(a[0]).toBe(0)
    expect(b[1] - b[0]).toBe(0)
    expect(c[0] - a[1]).toBeCloseTo(2, 5)
    expect(c[1]).toBeCloseTo(80, 5)
  })

  it('lenses re-project the same live deals', () => {
    const stages = [
      stage('ownership_confirmation', { count: 7, working: 5, dormant: 2, owners: { autopilot: 0, scheduled: 0, seller: 2, external: 0, needs_you: 3, blocked: 0, dormant: 2, complete: 0 }, aging: { median: 4, max: 9, overClock: 0, clockDays: 14, buckets: { fresh: 4, aging: 1, over: 0 } } }),
      stage('closed', { count: 0, working: 0 }),
    ]
    expect(riverStrata(stages, 'stage')[0].values[0]).toBe(5)
    const owner = riverStrata(stages, 'owner')
    expect(owner.find((s) => s.key === 'needs_you')?.values[0]).toBe(3)
    expect(owner.reduce((n, s) => n + s.values[0], 0)).toBe(5)
    const age = riverStrata(stages, 'age')
    expect(age.reduce((n, s) => n + s.values[0], 0)).toBe(5)
    expect(riverStrata(stages, 'stage')[0].values).toHaveLength(10)
  })

  it('S10 counts recorded closings only; other stages count working deals', () => {
    expect(liveCount(stage('closed', { count: 0, working: 0 }))).toBe(0)
    expect(liveCount(stage('offer_interest', { count: 245, working: 76, dormant: 169 }))).toBe(76)
  })
})

describe('movement', () => {
  const mv = (over: Partial<DeskMove>): DeskMove => ({ id: 'm1', opportunityId: 'o1', at: '2026-09-30T20:20:49Z', kind: 'advance', title: 'S2 → S4', detail: 'Asking price provided', address: '5124 Russell Ave N', seller: null, stage: 'property_condition', stageIndex: 4, ...over })

  it('the first read seeds and never pulses; later reads pulse only what is new', () => {
    expect(arrivals(null, [mv({})])).toEqual([])
    expect(arrivals(new Set(['m1']), [mv({}), mv({ id: 'm2' })]).map((m) => m.id)).toEqual(['m2'])
  })

  it('a pulse travels the real route', () => {
    expect(pulseRoute(mv({ fromStage: 'offer_interest', toStage: 'property_condition' }))).toEqual({ from: 1, to: 3 })
    expect(pulseRoute(mv({ kind: 'created', toStage: 'offer_interest' }))).toEqual({ from: null, to: 1 })
    expect(pulseRoute(mv({ kind: 'exit', stage: 'offer_interest' }))).toEqual({ from: 1, to: null })
    expect(pulseRoute(mv({ kind: 'reply' }))).toBeNull()
  })

  it('maps to the shared activity grammar, with the source named', () => {
    const human = moveToActivity(mv({ by: 'human', title: 'S3 → S5', detail: 'Made offer' }))
    expect(human.source).toBe('You')
    expect(human.title).toBe('S3 → S5 · Made offer')
    const reply = moveToActivity(mv({ kind: 'reply', by: 'seller', title: 'Seller replied', detail: '250,000' }))
    expect(reply.source).toBe('Seller')
    expect(reply.result).toBe('“250,000”')
    const exit = moveToActivity(mv({ kind: 'exit', title: 'Moved to nurture', detail: '30-day follow-up' }))
    expect(exit.groupKey).toBe('exit:Moved to nurture')
  })
})

describe('age buckets', () => {
  it('buckets days in stage and marks where the stage clock falls', () => {
    expect(ageBucket(0)).toBe(0)
    expect(ageBucket(5)).toBe(2)
    expect(ageBucket(127)).toBe(AGE_BUCKETS.length - 1)
    expect(ageBucket(null)).toBe(-1)
    expect(clockBucket(7)).toBe(3) // S5: 1–2w is past a 7-day clock
    expect(clockBucket(21)).toBe(5) // S2: 1–2mo is past a 21-day clock
    expect(clockBucket(null)).toBeNull()
  })
})

describe('offers', () => {
  it('groups by the server’s autonomy state and never invents one', () => {
    const row = (state: 'autonomous' | 'resolving' | 'exception' | 'parked' | null, idx = 5): DeskOfferRow => ({
      card: { stageIndex: idx } as DeskOfferRow['card'],
      autonomy: state ? { state, cause: 'x', label: 'x', why: 'x', reprices: 'none', zone: null, valuationAgeDays: 1, stale: false, implausible: false } : null,
      plausibility: { engineValueOff: false, recommendedOff: false }, negotiation: null, engine: null, offer: null, offersCount: 0,
      readiness: { state: 'needs_validation', spendable: false, reason: null, reasons: [], tier: null, tierLabel: null, compCount: null, thinCoverage: false, persistedIgnored: null },
      askImplausible: false, counterImplausible: false,
    })
    const g = groupOffers([row('autonomous'), row('exception', 2), row('exception', 5), row(null)])
    expect(g.autonomous).toHaveLength(1)
    expect(g.exception.map((r) => r.card.stageIndex)).toEqual([5, 2])
    expect(g.resolving).toHaveLength(0)
  })
})
