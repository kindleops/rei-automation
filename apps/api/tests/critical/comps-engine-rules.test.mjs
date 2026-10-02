/**
 * COMPS ENGINE RULES — the operator-facing description of the acquisition
 * engine's comparable rules must say exactly what the engine does. Every
 * number in comps-engine-rules.js is probed here against the engine's own
 * exported functions, at the boundary, so the description cannot drift.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DAYS_PER_MONTH,
  RECENCY_CURVE as ENGINE_RECENCY_CURVE,
  calculateAcquisitionDecision,
  evaluateCompEligibility,
  normalizePropertyFeatures,
  recencyScore,
  scoreComparable,
} from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import {
  ENGINE_COMP_DETAIL_COLUMNS,
  RECENCY_BASIS,
  RECENCY_CURVE,
  engineRulesFor,
  engineSearchWindow,
  recencyFactorAt,
} from '../../src/lib/domain/comp-intelligence/comps-engine-rules.js'

const NOW = new Date('2026-10-15T12:00:00Z')
const monthsAgo = (m) => {
  const d = new Date(Date.UTC(2026, 9 - m, 15))
  return d.toISOString().slice(0, 10)
}

const subjectOf = (row) => normalizePropertyFeatures({ property_id: 'S1', latitude: 45, longitude: -93, property_address_zip: '55430', ...row }, { source: 'properties', now: NOW })
const compOf = (row) => normalizePropertyFeatures(
  { id: `c-${Math.random().toString(36).slice(2, 8)}`, property_id: `P-${Math.random().toString(36).slice(2, 8)}`, latitude: 45.01, longitude: -93, property_address_zip: '55430', sale_price: 250000, sale_date: monthsAgo(2), ...row },
  { source: 'v_recent_sold_comps', now: NOW, distance_miles: row.distance_miles },
)
const reasons = (subject, comp) => evaluateCompEligibility(subject, comp, NOW).reasons

const SFR = { property_type: 'Single Family', units_count: 1, building_square_feet: 1000, total_bedrooms: 3, total_baths: 2, year_built: 1960 }

test('detail columns are exactly the engine’s RPC_COMP_DETAIL_SELECT', () => {
  const src = readFileSync(new URL('../../src/lib/acquisition/acquisitionDecisionEngine.js', import.meta.url), 'utf8')
  const start = src.indexOf('const RPC_COMP_DETAIL_SELECT = [')
  assert.ok(start > 0, 'engine constant moved — update the contract')
  const block = src.slice(start, src.indexOf("].join(',')", start))
  const engineCols = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
  assert.deepEqual([...ENGINE_COMP_DETAIL_COLUMNS], engineCols)
})

test('residential window and size band match evaluateCompEligibility', () => {
  const r = engineRulesFor('residential')
  assert.equal(r.radiusMiles, 4)
  assert.equal(r.months, 30)
  assert.deepEqual([r.size.min, r.size.max], [0.5, 1.9])
  const s = subjectOf(SFR)
  const base = { ...SFR }
  assert.ok(!reasons(s, compOf({ ...base, distance_miles: 4 })).includes('outside_radius'))
  assert.ok(reasons(s, compOf({ ...base, distance_miles: 4.01 })).includes('outside_radius'))
  assert.ok(!reasons(s, compOf({ ...base, distance_miles: 1, sale_date: monthsAgo(30) })).includes('sale_too_old'))
  assert.ok(reasons(s, compOf({ ...base, distance_miles: 1, sale_date: monthsAgo(31) })).includes('sale_too_old'))
  assert.ok(!reasons(s, compOf({ ...base, distance_miles: 1, building_square_feet: 500 })).includes('square_feet_outside_range'))
  assert.ok(reasons(s, compOf({ ...base, distance_miles: 1, building_square_feet: 499 })).includes('square_feet_outside_range'))
  assert.ok(!reasons(s, compOf({ ...base, distance_miles: 1, building_square_feet: 1900 })).includes('square_feet_outside_range'))
  assert.ok(reasons(s, compOf({ ...base, distance_miles: 1, building_square_feet: 1901 })).includes('square_feet_outside_range'))
})

test('price floor and nominal-price ratio match the engine', () => {
  const r = engineRulesFor('residential')
  assert.equal(r.minSalePrice, 10_000)
  assert.equal(r.nominalPriceToValue, 0.25)
  const s = subjectOf(SFR)
  assert.ok(!reasons(s, compOf({ ...SFR, distance_miles: 1, sale_price: 10_000 })).includes('invalid_sale_price'))
  assert.ok(reasons(s, compOf({ ...SFR, distance_miles: 1, sale_price: 9_999 })).includes('invalid_sale_price'))
  assert.ok(!reasons(s, compOf({ ...SFR, distance_miles: 1, sale_price: 25_000, estimated_value: 100_000 })).includes('nominal_non_arms_length_transfer'))
  assert.ok(reasons(s, compOf({ ...SFR, distance_miles: 1, sale_price: 24_999, estimated_value: 100_000 })).includes('nominal_non_arms_length_transfer'))
})

test('multifamily window and unit band match the engine', () => {
  const r = engineRulesFor('multifamily')
  assert.equal(r.radiusMiles, 7)
  assert.equal(r.months, 36)
  assert.deepEqual([r.size.field, r.size.min, r.size.max], ['units', 0.35, 2.75])
  const mf = { property_type: 'Multi-Family', units_count: 20, building_square_feet: 16000 }
  const s = subjectOf(mf)
  assert.equal(s.asset_family, 'multifamily')
  const c = (over) => compOf({ ...mf, ...over, building_square_feet: (over.units_count ?? 20) * 800 })
  assert.ok(!reasons(s, c({ distance_miles: 7, units_count: 7 })).some((x) => x === 'outside_radius' || x === 'unit_count_outside_range'))
  assert.ok(reasons(s, c({ distance_miles: 7.01, units_count: 20 })).includes('outside_radius'))
  assert.ok(reasons(s, c({ distance_miles: 1, units_count: 6 })).includes('unit_count_outside_range'))
  assert.ok(!reasons(s, c({ distance_miles: 1, units_count: 55 })).includes('unit_count_outside_range'))
  assert.ok(reasons(s, c({ distance_miles: 1, units_count: 56 })).includes('unit_count_outside_range'))
  assert.ok(!reasons(s, c({ distance_miles: 1, units_count: 20, sale_date: monthsAgo(36) })).includes('sale_too_old'))
  assert.ok(reasons(s, c({ distance_miles: 1, units_count: 20, sale_date: monthsAgo(37) })).includes('sale_too_old'))
})

test('the recency curve is the engine’s: same knots, same interpolation, elapsed-day basis', () => {
  // RC 7.1 (2026-10-01): recency used to be a calendar-month step table; it is
  // now piecewise-linear in elapsed months. The description must equal the engine.
  assert.deepEqual(RECENCY_CURVE.map((k) => ({ ...k })), ENGINE_RECENCY_CURVE.map((k) => ({ ...k })))
  assert.equal(RECENCY_BASIS.daysPerMonth, DAYS_PER_MONTH)
  assert.equal(engineRulesFor('residential').recency, RECENCY_CURVE)
  assert.equal(recencyScore(null), RECENCY_BASIS.unknownDateScore)
  assert.equal(recencyFactorAt(null), RECENCY_BASIS.unknownDateScore)
  for (let m = 0; m <= 60; m += 0.125) assert.ok(Math.abs(recencyFactorAt(m) - recencyScore(m)) < 1e-9, `${m} months`)
  // Probed through scoreComparable at exact elapsed ages. The 36-month
  // multifamily window reaches every knot but the last.
  const mf = { property_type: 'Multi-Family', units_count: 4, building_square_feet: 3200 }
  const s = subjectOf(mf)
  const saleAt = (m) => new Date(NOW.getTime() - m * DAYS_PER_MONTH * 86_400_000).toISOString()
  const at = (m) => scoreComparable(s, { ...mf, id: `r${m}`, property_id: `R${m}`, latitude: 45.01, longitude: -93, sale_price: 400000, sale_date: saleAt(m), source: 'v_recent_sold_comps' }, { source: 'v_recent_sold_comps', distance_miles: 0.5, now: NOW }).recency_score
  for (const m of [0, 1.5, 3, 4.5, 6, 7, 9, 12, 13, 15, 18, 21, 24, 25, 30, 33]) {
    assert.equal(at(m), Math.round(recencyFactorAt(m) * 100) / 100, `${m} months`)
  }
})

test('weight is score × confidence × recency × source factor', () => {
  const r = engineRulesFor('residential')
  const s = subjectOf(SFR)
  for (const mls of [true, false]) {
    const row = { ...SFR, id: `w${mls}`, property_id: `W${mls}`, latitude: 45.01, longitude: -93, sale_price: 250000, sale_date: monthsAgo(4), mls_sold_price: mls ? 250000 : null, source: 'v_recent_sold_comps' }
    const sc = scoreComparable(s, row, { source: 'v_recent_sold_comps', distance_miles: 0.6, now: NOW })
    const factor = mls ? r.weight.mlsFactor : r.weight.otherFactor
    const want = Math.round((sc.comp_score / 100) * (sc.comp_confidence / 100) * (sc.recency_score / 100) * factor * 1e4) / 1e4
    assert.ok(Math.abs(sc.weight - want) <= 0.0002, `mls=${mls}: ${sc.weight} vs ${want}`)
    assert.equal(sc.comp.sale_source, mls ? 'mls_sold' : 'public_record_sold')
  }
})

test('valuation confidence blend and top-N cut match calculateAcquisitionDecision', () => {
  const r = engineRulesFor('residential')
  const s = { ...SFR, property_id: 'S1', latitude: 45, longitude: -93, property_address_zip: '55430', estimated_value: 260000 }
  const comps = Array.from({ length: 15 }, (_, i) => ({
    ...SFR,
    id: `k${i}`, property_id: `K${i}`, latitude: 45 + 0.002 * (i + 1), longitude: -93,
    building_square_feet: 950 + i * 10, sale_price: 240000 + i * 2500, sale_date: monthsAgo(1 + (i % 6)),
    mls_sold_price: i % 3 ? 240000 + i * 2500 : null, source: 'v_recent_sold_comps',
  }))
  const d = calculateAcquisitionDecision({ subject: s, comps, now: NOW, v3Enabled: false })
  assert.equal(d.selected_comps.length, r.maxSelected)
  const calc = d.evidence.valuation_calculation_summary
  const w = r.confidence.weights
  const c = calc.components
  const blended = c.depth_score * w.depth + c.average_comp_score * w.compScore + c.average_data_completeness * w.completeness + c.consistency_score * w.consistency + c.source_diversity_score * w.sourceDiversity
  assert.ok(Math.abs(Math.round(blended) - d.valuation.confidence) <= 1, `${blended} vs ${d.valuation.confidence}`)
  assert.equal(c.depth_score, Math.min(100, (r.maxSelected / r.confidence.depthFullAt) * 100))
  assert.ok(d.rejected_comps.some((x) => x.reasons.includes('outside_top_comp_limit')))
})

test('the review opens on the engine window, clamped to what the workspace serves', () => {
  assert.deepEqual(engineSearchWindow('residential'), { radiusMiles: 4, months: 30, clamped: false })
  assert.deepEqual(engineSearchWindow('multifamily'), { radiusMiles: 7, months: 36, clamped: false })
  assert.deepEqual(engineSearchWindow('land'), { radiusMiles: 10, months: 48, clamped: true })
  assert.deepEqual(engineSearchWindow('commercial'), { radiusMiles: 10, months: 48, clamped: true })
  assert.equal(engineRulesFor('other').radiusMiles, 4)
  assert.equal(engineRulesFor('other').size, null)
})
