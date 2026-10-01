import { describe, expect, it } from 'vitest'
import type { LabOverview, SeriesPoint, WhatChanged } from '../../../domain/analytics/analytics-lab-api'
import { alignTrend, changeText, changeTone, denominatorLine, filterText, funnelStages, layoutFlow, placeFlowLabels, sellerAutomationPath, splitChanges, topOf } from './intel-model'
import { fmtMoney, fmtPct, fmtPts, fmtRange, labelIndices, niceTicks } from './intel-format'
import { VIEWBOX, dots, fitBox, nearestDot, project, stateAbbr, stateBox } from './intel-geo'

/* The production funnel of 2026-10-01 (30D): reached 849 → replied 101 → interested 20 / became opportunity 31. */
const steps: LabOverview['funnel']['steps'] = [
  { id: 'sellers_reached', label: 'Reached', value: 849, base: null, conversion: null },
  { id: 'reached_replied', label: 'Replied', value: 101, base: 849, conversion: 101 / 849 },
  { id: 'interested_sellers', label: 'Interested', value: 20, base: 101, conversion: 20 / 101, note: 'subset of replied' },
  { id: 'opportunity_rate', label: 'Became opportunity', value: 31, base: 101, conversion: 31 / 101, note: 'repliers whose thread produced an opportunity' },
]

describe('funnel', () => {
  it('drop-off only where the previous stage IS the base; siblings keep their own base', () => {
    const s = funnelStages(steps)
    expect(s[1].dropped).toBe(748)
    expect(s[2].dropped).toBe(81) // interested is nested in replied
    // "became opportunity" is based on replied, not on interested: no drop-off from 20
    expect(s[3].dropped).toBeNull()
    expect(s[3].retained).toBeCloseTo(31 / 101, 6)
    expect(s[3].ofFirst).toBeCloseTo(31 / 849, 6)
  })
  it('every stage names the seller cohort it selects', () => {
    expect(funnelStages(steps).map((x) => x.cohort)).toEqual(['reached', 'replied', 'interested', 'opportunity'])
  })
  it('a missing stage value is never turned into a zero', () => {
    const s = funnelStages([steps[0], { ...steps[1], value: null }])
    expect(s[1].value).toBeNull()
    expect(s[1].dropped).toBeNull()
    expect(s[1].ofFirst).toBeNull()
  })
})

describe('trend', () => {
  const p = (start: number, value: number | null, extra: Partial<SeriesPoint> = {}): SeriesPoint => ({ start, end: start + 1, value, ...extra })
  it('aligns the comparison by bucket index and keeps gaps as gaps', () => {
    const t = alignTrend([p(1, null, { num: 0, den: 0 }), p(2, 0.2, { num: 2, den: 10 })], [p(10, 0.1), p(11, null)])
    expect(t[0].value).toBeNull()
    expect(t[0].prev?.value).toBe(0.1)
    expect(t[1].prev?.value).toBeNull()
  })
  it('a rate says its denominator in words', () => {
    const def = { unit: 'rate', denominator: { label: 'sellers reached' } } as Parameters<typeof denominatorLine>[0]
    expect(denominatorLine(def, { num: 18, den: 121 })).toBe('18 of 121 sellers reached')
  })
  it('the top group of a stacked bucket ignores remainder, unresolved and test groups', () => {
    const r = { available: true, dim: 'market', keys: [{ key: '__other', label: 'Other', total: 9 }, { key: 'mpls', label: 'Minneapolis, MN', total: 5 }, { key: 'miami', label: 'Miami, FL', total: 4 }, { key: 'zz', label: 'ZZ proof', total: 50, test: true }], buckets: [{ start: 0, end: 1, total: 20, values: { __other: 9, mpls: 2, miami: 3, zz: 6 } }] }
    expect(topOf(r, 0)?.label).toBe('Miami, FL')
    expect(topOf(r, 3)).toBeNull()
  })
})

describe('what changed', () => {
  const c = (over: Partial<WhatChanged>): WhatChanged => ({ id: 'x', label: 'X', kind: 'count', cur: 0, prev: 0, num: null, den: null, prevNum: null, prevDen: null, delta: 0, pct: null, pts: null, ciPts: null, p: 0.01, polarity: 'up', drill: [], top: null, ...over })
  it('rates move in points, counts in units; tone follows polarity', () => {
    expect(changeText(c({ kind: 'rate', pts: -19.9 }))).toBe('−19.9 pts')
    expect(changeText(c({ delta: 705 }))).toBe('+705')
    expect(changeTone(c({ kind: 'rate', pts: -19.9, polarity: 'up' }))).toBe('bad')
    expect(changeTone(c({ delta: 172, polarity: 'down' }))).toBe('bad')
    expect(changeTone(c({ delta: 50, polarity: 'neutral' }))).toBe('neutral')
  })
  it('splits improved from degraded and leaves neutral-polarity moves apart', () => {
    const s = splitChanges([c({ id: 'a', delta: 30 }), c({ id: 'b', kind: 'rate', pts: -2, polarity: 'up' }), c({ id: 'n', delta: 9, polarity: 'neutral' })])
    expect(s.improved.map((x) => x.id)).toEqual(['a'])
    expect(s.degraded.map((x) => x.id)).toEqual(['b'])
    expect(s.moved.map((x) => x.id)).toEqual(['n'])
  })
})

describe('flow layout', () => {
  it('conserves every node: ribbons in = ribbons out = the node, at one scale', () => {
    const nodes = [
      { id: 'q', column: 0, label: 'Queue rows', value: 100, tone: 'neutral' },
      { id: 'd:delivered', column: 1, label: 'Delivered', value: 60, tone: 'ok' },
      { id: 'd:undelivered', column: 1, label: 'Undelivered', value: 30, tone: 'crit' },
      { id: 'd:held', column: 1, label: 'Held', value: 10, tone: 'neutral' },
      { id: 'c:spam', column: 2, label: 'Spam', value: 20, tone: 'crit' },
      { id: 'c:other', column: 2, label: 'Other', value: 10, tone: 'crit' },
    ]
    const links = [
      { from: 'q', to: 'd:delivered', value: 60 }, { from: 'q', to: 'd:undelivered', value: 30 }, { from: 'q', to: 'd:held', value: 10 },
      { from: 'd:undelivered', to: 'c:spam', value: 20 }, { from: 'd:undelivered', to: 'c:other', value: 10 },
    ]
    const f = layoutFlow(nodes, links, { width: 600, height: 300, columns: 3 })
    const h = (id: string) => f.nodes.find((n) => n.id === id)?.h ?? 0
    expect(h('d:delivered') / h('q')).toBeCloseTo(0.6, 5)
    expect((h('c:spam') + h('c:other')) / h('d:undelivered')).toBeCloseTo(1, 5)
    expect(f.ribbons).toHaveLength(5)
    expect(f.nodes.every((n) => n.y >= -0.001 && n.y + n.h <= 300.001)).toBe(true)
  })
  it('labels of tiny neighbouring nodes are spread apart and stay inside the flow', () => {
    // production 09-30: 1 waiting · 1 expired · 115 cancelled sit a few pixels apart
    const nodes = [
      { id: 'a', column: 1, y: 200, h: 0.5 }, { id: 'b', column: 1, y: 211, h: 0.5 }, { id: 'c', column: 1, y: 222, h: 30 },
      { id: 'x', column: 2, y: 290, h: 1 }, { id: 'y', column: 2, y: 294, h: 1 },
    ]
    const at = placeFlowLabels(nodes, 300, 16)
    const ys = ['a', 'b', 'c'].map((k) => at.get(k) as number)
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(16)
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(16)
    expect(at.get('a')).toBeCloseTo(200.25, 5) // the first keeps its own centre
    expect((at.get('y') as number) - (at.get('x') as number)).toBeGreaterThanOrEqual(16)
    expect(at.get('y')).toBeLessThanOrEqual(300)
  })
  it('a middle column can sit off-centre to leave its labels a lane', () => {
    const f = layoutFlow([{ id: 'q', column: 0, label: 'Q', value: 10, tone: 'neutral' }, { id: 'm', column: 1, label: 'M', value: 10, tone: 'ok' }, { id: 'e', column: 2, label: 'E', value: 10, tone: 'ok' }], [{ from: 'q', to: 'm', value: 10 }, { from: 'm', to: 'e', value: 10 }], { width: 410, height: 100, columns: 3, colX: [0, 0.4, 1] })
    expect(f.nodes.find((n) => n.id === 'm')?.x).toBeCloseTo(160, 5)
    expect(f.nodes.find((n) => n.id === 'e')?.x).toBeCloseTo(400, 5)
  })
})

describe('formatting', () => {
  it('money has no false precision and an absent sum is never "$0" unless asked', () => {
    expect(fmtMoney(663_800)).toBe('$664K')
    expect(fmtMoney(75_600)).toBe('$75.6K')
    expect(fmtMoney(84_238_895)).toBe('$84.2M')
    expect(fmtMoney(0)).toBe('—')
    expect(fmtMoney(0, { zero: '$0' })).toBe('$0')
    expect(fmtMoney(null)).toBe('—')
  })
  it('rates and points', () => {
    expect(fmtPct(0.11896)).toBe('11.9%')
    expect(fmtPts(2.87)).toBe('+2.9 pts')
    expect(fmtPts(-19.9)).toBe('−19.9 pts')
  })
  it('a range shows its last included day (the end instant is exclusive)', () => {
    expect(fmtRange('2026-09-01T05:00:00.000Z', '2026-10-01T05:00:00.000Z', 'America/Chicago')).toBe('Sep 1 – Sep 30')
  })
  it('axis labels always keep the newest bucket', () => {
    const idx = labelIndices(31, 600, 74)
    expect(idx[idx.length - 1]).toBe(30)
    expect(idx[0]).toBe(0)
  })
  it('ticks are clean', () => {
    expect(niceTicks(0, 0.137, 4).ticks).toEqual([0, 0.05, 0.1, 0.15])
  })
})

describe('geography', () => {
  it('projects the lower 48 inside the dot matrix and refuses points outside the US', () => {
    const mpls = project(-93.27, 44.98)
    expect(mpls).not.toBeNull()
    expect(mpls![0]).toBeGreaterThan(0)
    expect(mpls![0]).toBeLessThan(VIEWBOX.width)
    expect(project(2.35, 48.85)).toBeNull() // Paris
    const i = nearestDot(mpls![0], mpls![1])
    expect(i).not.toBeNull()
    expect(stateAbbr(dots()[i as number].state)).toBe('MN')
  })
  it('zooms to a state with the map’s own aspect', () => {
    const b = stateBox('MN')
    expect(b).not.toBeNull()
    const f = fitBox(b!)
    expect(f.w / f.h).toBeCloseTo(VIEWBOX.width / VIEWBOX.height, 5)
    expect(f.scale).toBeGreaterThan(1)
  })
})

describe('hand-offs', () => {
  it('a run opens in Workflow Studio’s seller-autopilot view (thread + execution)', () => {
    expect(sellerAutomationPath({ thread: '+15551234567', id: 'run-1' })).toBe('/workflow-studio?seller_automation=1&workflow=seller-inbound-v1&thread_key=%2B15551234567&execution_id=run-1')
  })
  it('filter chips say the field and the value, never the raw key', () => {
    const fields = [{ id: 'market', family: 'GEOGRAPHY', label: 'Market', type: 'category', operators: ['in'], applies: ['seller'], coverage: '', source: '', viability: 'bounded_cohort' }] as Parameters<typeof filterText>[1]
    expect(filterText({ field: 'market', op: 'in', value: ['mpls'], labels: ['Minneapolis, MN'] }, fields)).toEqual({ field: 'Market', value: 'Minneapolis, MN' })
  })
})
