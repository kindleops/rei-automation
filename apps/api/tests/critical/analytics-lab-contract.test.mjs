/**
 * ANALYTICS LAB — the metric registry's integrity and the query contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFINITION_CHANGES, DIMENSION_REGISTRY, FILTER_FIELDS, METRIC_REGISTRY, METRICS_BY_ID, NON_VIABLE_FIELDS, TIME_BASES, publicRegistry,
} from '../../src/lib/domain/analytics/lab/metric-registry.js'
import { DEF, entityOf } from '../../src/lib/domain/analytics/lab/metric-engine.js'
import {
  autoGrain, bucketList, bucketStart, cacheKey, ContractError, decodeContext, encodeContext, normalizeContext, publicContext, resolveCompare, resolveRange, zonedParts,
} from '../../src/lib/domain/analytics/lab/query-contract.js'
import { compareCounts, compareProportions, decomposeRateChange, mannWhitney, percentile, wilson } from '../../src/lib/domain/analytics/lab/stats.js'

const NOW = Date.parse('2026-09-30T17:23:41Z')

test('registry: every metric is fully declared and executable', () => {
  for (const m of METRIC_REGISTRY) {
    for (const k of ['id', 'version', 'family', 'entity', 'label', 'short', 'description', 'unit', 'numerator', 'time_basis', 'sources', 'polarity', 'comparison', 'null_behavior', 'freshness', 'dimensions', 'v1']) {
      assert.ok(m[k] !== undefined && m[k] !== '', `${m.id}.${k}`)
    }
    assert.ok(TIME_BASES[m.time_basis], `${m.id} time basis`)
    assert.ok(DEF[m.id], `${m.id} has no executable definition`)
    for (const d of m.dimensions) assert.ok(DIMENSION_REGISTRY[d], `${m.id} dimension ${d}`)
    if (m.unit === 'rate' || m.unit === 'ratio') {
      assert.ok(m.denominator, `${m.id} rate without an explicit denominator`)
      assert.ok(m.min_sample > 0, `${m.id} rate without a minimum sample`)
      assert.equal(m.comparison, m.unit === 'rate' ? 'pts' : 'ratio', `${m.id} comparison semantics`)
    }
    if (m.numerator.metric) assert.ok(METRICS_BY_ID[m.numerator.metric], `${m.id} numerator ref`)
    if (m.denominator?.metric) assert.ok(METRICS_BY_ID[m.denominator.metric], `${m.id} denominator ref`)
    assert.ok(entityOf(m.id), `${m.id} entity`)
  }
})

test('registry: filters are real, viable and never AI scores; the non-viable list explains omissions', () => {
  const banned = /score|ai_|model|motivation|deal_strength/i
  for (const f of FILTER_FIELDS) {
    assert.ok(f.family && f.label && f.type && f.operators?.length && f.viability === 'bounded_cohort' && f.coverage && f.source, f.id)
    assert.ok(!banned.test(f.id) && !banned.test(f.source), `${f.id} looks like a model score`)
    assert.ok(f.applies.length, `${f.id} applies to no entity`)
  }
  const families = new Set(FILTER_FIELDS.map((f) => f.family))
  for (const fam of ['SELLER', 'PROPERTY', 'OWNER', 'GEOGRAPHY', 'CAMPAIGN', 'COMMUNICATION', 'CHANNEL', 'SENDER', 'TEMPLATE', 'WORKFLOW', 'PIPELINE', 'TIME', 'SYSTEM']) assert.ok(families.has(fam), fam)
  assert.ok(NON_VIABLE_FIELDS.some((x) => /score/.test(x.field)))
  assert.ok(DEFINITION_CHANGES.length >= 8)
  assert.ok(DEFINITION_CHANGES.every((c) => c.note.length > 20))
  const pub = publicRegistry()
  assert.doesNotThrow(() => JSON.stringify(pub))
  assert.equal(pub.metrics.length, METRIC_REGISTRY.length)
})

test('contract: defaults, bounded values, explicit rejections', () => {
  const ctx = normalizeContext({}, { now: NOW })
  assert.equal(ctx.metric, 'reply_rate')
  assert.equal(ctx.range.preset, '30d')
  assert.equal(ctx.compare.mode, 'previous')
  assert.equal(ctx.period.end, Math.floor(NOW / 60000) * 60000)
  assert.throws(() => normalizeContext({ metric: 'ai_score' }, { now: NOW }), ContractError)
  assert.throws(() => normalizeContext({ filters: [{ field: 'final_acquisition_score', op: 'gt', value: 50 }] }, { now: NOW }), /unknown filter field/)
  assert.throws(() => normalizeContext({ filters: [{ field: 'equity_percent', op: 'in', value: [1] }] }, { now: NOW }), /not valid for equity_percent/)
  assert.throws(() => normalizeContext({ filters: [{ field: 'market', op: 'in', value: Array.from({ length: 201 }, (_, i) => `m${i}`) }] }, { now: NOW }), /at most 200/)
  assert.throws(() => normalizeContext({ metric: 'opportunities_created', groupBy: 'template' }, { now: NOW }), /cannot be grouped by Template/)
  assert.throws(() => normalizeContext({ range: { preset: 'custom', start: '2026-09-10', end: '2026-09-01' } }, { now: NOW }), /before end/)
  assert.throws(() => normalizeContext({ range: { preset: 'custom', start: '2025-01-01', end: '2026-09-01' } }, { now: NOW }), /longer than/)
  assert.throws(() => decodeContext('%%%not-base64%%%'), ContractError)
})

test('contract: comparison windows — identical length, calendar shifts, history floor', () => {
  const p = resolveRange({ preset: '30d' }, { now: NOW, tz: 'America/Chicago' })
  const prev = resolveCompare({ mode: 'previous' }, p)
  assert.equal(prev.end, p.start)
  assert.equal(prev.end - prev.start, p.end - p.start)
  const wk = resolveCompare({ mode: 'week' }, p)
  assert.equal(p.start - wk.start, 7 * 86_400_000)
  const yr = resolveCompare({ mode: 'year' }, p, { tz: 'America/Chicago' })
  assert.equal(yr.available, false) // history begins 2026-04-18
  assert.match(yr.reason, /History begins/)
  const ytd = resolveRange({ preset: 'ytd' }, { now: NOW, tz: 'America/Chicago' })
  assert.equal(new Date(ytd.start).toISOString(), '2026-01-01T06:00:00.000Z') // Jan 1 local midnight
  assert.equal(ytd.coverage, 'partial')
  assert.equal(resolveCompare({ mode: 'previous' }, ytd).available, false)
  const today = resolveRange({ preset: 'today' }, { now: NOW, tz: 'America/Chicago' })
  assert.equal(new Date(today.start).toISOString(), '2026-09-30T05:00:00.000Z') // CDT midnight
})

test('contract: auto grain and DST-correct local buckets (weeks start Monday)', () => {
  const g = (preset) => autoGrain(resolveRange({ preset }, { now: NOW, tz: 'America/Chicago' }))
  assert.equal(g('today'), 'hour')
  assert.equal(g('7d'), 'day')
  assert.equal(g('30d'), 'day')
  assert.equal(g('90d'), 'week')
  assert.equal(g('ytd'), 'week')
  // America/Chicago falls back on 2026-11-01: that local day is 25 hours long
  const days = bucketList(Date.parse('2026-10-31T05:00:00Z'), Date.parse('2026-11-03T06:00:00Z'), 'day', 'America/Chicago')
  assert.equal(days.length, 3)
  assert.equal(days[2] - days[1], 25 * 3_600_000)
  const monday = bucketStart(Date.parse('2026-09-30T17:00:00Z'), 'week', 'America/Chicago') // a Wednesday
  const z = zonedParts(monday, 'America/Chicago')
  assert.equal(z.wd, 1); assert.equal(z.h, 0); assert.equal(z.d, 28)
  assert.throws(() => normalizeContext({ range: { preset: '90d' }, grain: 'hour' }, { now: NOW }), /more than 400 points/)
})

test('contract: the cache key is the whole normalised context, and URLs round-trip', () => {
  const a = normalizeContext({ filters: [{ field: 'state', op: 'in', value: ['MN', 'GA'] }, { field: 'equity_percent', op: 'gt', value: 50 }] }, { now: NOW })
  const b = normalizeContext({ filters: [{ field: 'equity_percent', op: 'gt', value: '50' }, { field: 'state', op: 'in', value: ['GA', 'MN'] }] }, { now: NOW + 5_000 })
  assert.equal(cacheKey(a), cacheKey(b))
  const c = normalizeContext({ filters: [{ field: 'state', op: 'in', value: ['MN'] }] }, { now: NOW })
  assert.notEqual(cacheKey(a), cacheKey(c))
  const round = normalizeContext(decodeContext(encodeContext(publicContext(a))), { now: NOW })
  assert.equal(cacheKey(round), cacheKey(a))
})

test('stats: Wilson, Newcombe, exact count test, Mann–Whitney, percentiles, exact decomposition', () => {
  assert.equal(wilson(0, 0), null)
  const w = wilson(5, 10)
  assert.ok(Math.abs(w.low - 0.2366) < 1e-3 && Math.abs(w.high - 0.7634) < 1e-3)
  const cp = compareProportions(81, 660, 14, 144)
  assert.ok(cp.low < cp.diff && cp.diff < cp.high)
  assert.ok(cp.p > 0 && cp.p < 1)
  assert.ok(compareCounts(30, 10).p < 0.01)
  assert.ok(compareCounts(12, 10).p > 0.5)
  assert.ok(compareCounts(20, 10, 2, 1).p > 0.5) // twice the window, twice the count: no change
  const mw = mannWhitney([1, 2, 3, 4, 5, 6, 7, 8], [11, 12, 13, 14, 15, 16, 17, 18])
  assert.ok(mw.p < 0.01)
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5)
  const dec = decomposeRateChange([{ key: 'a', n1: 10, d1: 100, n0: 5, d0: 100 }, { key: 'b', n1: 1, d1: 50, n0: 20, d0: 100 }, { key: 'new', n1: 3, d1: 10, n0: 0, d0: 0 }])
  const sum = dec.rows.reduce((s, r) => s + r.contribution, 0)
  assert.ok(Math.abs(sum - dec.total) < 1e-12)
})
