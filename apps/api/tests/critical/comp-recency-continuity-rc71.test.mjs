/**
 * RC 7.1: COMP RECENCY IS CONTINUOUS IN ELAPSED TIME (2026-10-01)
 *
 * Defect (owner-reported, audit-confirmed). Property 273312064 was valued at
 * $362,500 on 2026-09-30 and $327,900 on 2026-10-01 from an identical
 * 100-candidate pool. The engine aged sales in CALENDAR months, and recency
 * stepped on that count (<=6 -> 94, <=12 -> 82). At 00:00 UTC on 10-01 every
 * March sale lost about 15% of its weight at once, and two of them left the
 * top 12.
 *
 * (a) Stability. The same comps valued at 23:59 on the last day of a month and
 *     at 00:01 the next day, through the full engine, move less than 0.5%. They
 *     also stay inside the bound proven in acquisitionDecisionEngine.js: in 2
 *     minutes each 4-dp weight can drop by at most one unit (1e-4), so
 *     |dV| <= 1e-4 * sum|p_i - V| / sum(w).
 * (b) Monotonic. Older is never weighted more than newer, all else equal.
 * (c) The 273312064 pool, de-identified: sale dates, prices, sizes and the
 *     engine's own stored per-comp numbers, with no ids, addresses, ZIPs or
 *     plats. The legacy calendar-month rule reproduces the stored
 *     $362,500 -> $327,900 jump exactly. The engine's curve does not jump.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DAYS_PER_MONTH,
  RECENCY_CURVE,
  calculateAcquisitionDecision,
  normalizePropertyFeatures,
  recencyScore,
  saleAgeDays,
  scoreComparable,
} from '../../src/lib/acquisition/acquisitionDecisionEngine.js'

const RUN_0930 = new Date('2026-09-30T15:18:26.744Z') // the run that stored $362,500
const RUN_1001 = new Date('2026-10-01T12:58:05.986Z') // the run that stored $327,900
const BEFORE = new Date('2026-09-30T23:59:00Z')
const AFTER = new Date('2026-10-01T00:01:00Z')
const DAY_MS = 86_400_000

/*
 * The 99 eligible candidates of 273312064 (the 100th was a nominal transfer),
 * as stored by the 10-01 12:58 run. Columns:
 *   [sale date, sale price, adjusted price, sqft, MLS?, comp_score at RUN_1001,
 *    data completeness, status, stored weight at RUN_1001, stored weight at RUN_0930]
 * status: S = in the 10-01 set, T = cut at the top-12 limit, O = adjusted-price outlier.
 * Subject: single-family, 1,853 sq ft.
 */
const POOL = [
  ['2026-04-03', 110000, 115100, 1473, 0, 84.66, 60.3466, 'S', 0.5767, 0.5767],
  ['2026-01-09', 235000, 264300, 1430, 1, 88.15, 60.3466, 'S', 0.5702, 0.5702],
  ['2026-04-06', 208000, 231900, 1364, 1, 79.32, 60.3466, 'S', 0.5654, 0.5654],
  ['2026-04-15', 400000, 383700, 1933, 1, 79.05, 60.3466, 'S', 0.5623, 0.5623],
  ['2026-02-12', 395000, 384200, 2000, 1, 87.37, 60.3466, 'S', 0.5621, 0.5621],
  ['2026-04-17', 450000, 477400, 1620, 1, 78.24, 60.3466, 'S', 0.5533, 0.5533],
  ['2026-04-15', 281500, 306700, 1488, 1, 77.32, 60.3466, 'S', 0.5432, 0.5432],
  ['2026-03-12', 280000, 300500, 1538, 1, 85.4, 60.3466, 'S', 0.5418, 0.6398],
  ['2026-04-21', 622000, 646400, 1796, 1, 76.52, 60.3466, 'S', 0.5344, 0.5344],
  ['2026-04-07', 230000, 296200, 1734, 1, 75.94, 60.3466, 'S', 0.528, 0.528],
  ['2025-12-19', 230000, 240200, 1617, 1, 83.49, 60.3466, 'S', 0.5226, null],
  ['2026-01-02', 285000, 301100, 1598, 1, 82.89, 60.3466, 'S', 0.5165, null],
  ['2025-09-12', 175000, 181100, 1766, 1, 81.33, 60.3466, 'T', null, null],
  ['2026-02-11', 351500, 356000, 1791, 1, 81.13, 60.3466, 'T', null, null],
  ['2026-01-02', 290058, 307800, 1679, 1, 80.05, 60.3466, 'T', null, null],
  ['2025-12-30', 450000, 430500, 2086, 1, 79.6, 60.3466, 'T', null, null],
  ['2025-12-17', 167500, 176800, 1500, 0, 79.47, 60.3466, 'T', null, null],
  ['2026-02-06', 350000, 327200, 2101, 1, 79.17, 60.3466, 'T', null, null],
  ['2025-12-12', 220000, 257500, 1248, 1, 78.89, 60.3466, 'T', null, null],
  ['2026-03-25', 453000, 451400, 1782, 1, 78.77, 60.3466, 'T', null, 0.5632],
  ['2026-02-23', 135000, 137100, 1648, 0, 78.63, 60.3466, 'T', null, null],
  ['2025-12-11', 399000, 411000, 1632, 1, 78.12, 60.3466, 'T', null, null],
  ['2025-12-05', 250000, 289100, 1300, 1, 78.03, 60.3466, 'T', null, null],
  ['2025-11-21', 386100, 401700, 1682, 1, 77.98, 60.3466, 'T', null, null],
  ['2025-12-17', 205000, 222400, 1448, 1, 77.97, 60.3466, 'T', null, null],
  ['2025-11-13', 275000, 261800, 2272, 1, 77.83, 60.3466, 'T', null, null],
  ['2026-01-02', 460000, 512000, 1540, 1, 77.78, 60.3466, 'T', null, null],
  ['2026-01-07', 899841, 833600, 2361, 1, 77.47, 60.3466, 'O', null, null],
  ['2026-02-20', 275000, 290200, 1699, 1, 77.04, 60.3466, 'T', null, null],
  ['2025-11-07', 325000, 353300, 1456, 1, 77.01, 60.3466, 'T', null, null],
  ['2026-01-29', 209900, 245500, 1240, 1, 76.77, 60.3466, 'T', null, null],
  ['2026-01-21', 170000, 185100, 1473, 1, 76.58, 60.3466, 'T', null, null],
  ['2026-02-17', 216000, 229800, 1632, 1, 76.49, 60.3466, 'T', null, null],
  ['2025-09-25', 220000, 233300, 1476, 1, 76.4, 60.3466, 'T', null, null],
  ['2025-12-24', 177700, 197200, 1340, 0, 76.35, 60.3466, 'T', null, null],
  ['2026-01-05', 160000, 164000, 1640, 1, 76.25, 60.3466, 'T', null, null],
  ['2026-04-02', 105000, 105400, 1580, 0, 76, 60.3466, 'T', null, null],
  ['2025-11-24', 447000, 502700, 1506, 1, 75.96, 60.3466, 'T', null, null],
  ['2026-03-05', 445000, 530700, 1296, 1, 75.16, 60.3466, 'T', null, 0.5235],
  ['2025-12-15', 254900, 283500, 1409, 1, 75.09, 60.3466, 'T', null, null],
  ['2025-12-05', 475000, 531400, 1461, 1, 75.06, 60.3466, 'T', null, null],
  ['2025-12-16', 408000, 399200, 1860, 1, 75.01, 60.3466, 'T', null, null],
  ['2025-11-19', 279900, 277300, 2106, 1, 74.92, 60.3466, 'T', null, null],
  ['2025-11-19', 300000, 335300, 1487, 1, 74.8, 60.3466, 'T', null, null],
  ['2026-04-14', 255000, 270500, 1568, 1, 74.8, 60.3466, 'T', null, null],
  ['2025-11-21', 298000, 350700, 1284, 1, 74.67, 60.3466, 'T', null, null],
  ['2026-01-30', 305000, 345100, 1450, 1, 74.59, 60.3466, 'T', null, null],
  ['2026-03-09', 475000, 498600, 1750, 1, 74.19, 60.3466, 'T', null, null],
  ['2026-01-09', 551000, 587200, 1697, 1, 74.01, 60.3466, 'T', null, null],
  ['2025-11-17', 360000, 405800, 1480, 1, 73.51, 60.3466, 'T', null, null],
  ['2026-02-13', 320000, 366500, 1360, 1, 73.45, 60.3466, 'T', null, null],
  ['2026-03-06', 219000, 279100, 1074, 1, 72.87, 60.3466, 'T', null, null],
  ['2026-04-15', 194000, 212700, 1399, 1, 72.83, 60.3466, 'T', null, null],
  ['2026-02-10', 190000, 199200, 1485, 0, 72.72, 60.3466, 'T', null, null],
  ['2026-03-04', 767000, 857100, 1490, 1, 72.68, 60.3466, 'O', null, null],
  ['2026-03-05', 800000, 776900, 1976, 1, 72.55, 60.3466, 'O', null, null],
  ['2025-11-03', 430000, 490800, 1459, 1, 72.53, 60.3466, 'T', null, null],
  ['2026-01-13', 450000, 404200, 2390, 1, 72.26, 60.3466, 'T', null, null],
  ['2025-12-31', 450500, 472600, 1660, 1, 72.16, 60.3466, 'T', null, null],
  ['2026-03-13', 310000, 358600, 1388, 1, 72.03, 60.3466, 'T', null, null],
  ['2025-12-10', 295000, 328000, 1432, 1, 71.89, 60.3466, 'T', null, null],
  ['2025-12-01', 440000, 533600, 1258, 1, 71.7, 60.3466, 'T', null, null],
  ['2026-02-02', 339000, 422900, 1216, 1, 71.09, 60.3466, 'T', null, null],
  ['2026-04-27', 610000, 656100, 1591, 1, 70.88, 60.3466, 'T', null, null],
  ['2026-03-30', 315000, 334600, 1588, 1, 69.72, 60.3466, 'T', null, null],
  ['2026-04-17', 490000, 560500, 1404, 1, 69.14, 60.3466, 'T', null, null],
  ['2026-02-18', 520000, 499500, 2049, 1, 68.91, 60.3466, 'T', null, null],
  ['2026-03-17', 400852, 409500, 1757, 1, 68.24, 58.3078, 'T', null, null],
  ['2026-03-02', 336000, 337500, 1830, 1, 68.09, 58.3078, 'T', null, null],
  ['2025-12-18', 366000, 411300, 1426, 1, 67.53, 58.3078, 'T', null, null],
  ['2025-12-01', 438000, 432100, 1824, 1, 67.01, 58.3078, 'T', null, null],
  ['2026-04-21', 417000, 461100, 1484, 1, 66.51, 58.3078, 'T', null, null],
  ['2026-03-31', 322000, 384600, 1260, 1, 65.42, 58.3078, 'T', null, null],
  ['2026-02-23', 515000, 545400, 1718, 1, 64.7, 58.3078, 'T', null, null],
  ['2025-12-22', 380000, 396700, 1767, 1, 63.96, 58.3078, 'T', null, null],
  ['2026-01-23', 330000, 328700, 2028, 1, 63.26, 58.3078, 'T', null, null],
  ['2026-04-02', 803500, 877500, 1556, 1, 62.7, 58.3078, 'O', null, null],
  ['2026-02-04', 702000, 653900, 2194, 1, 62.58, 58.3078, 'T', null, null],
  ['2026-03-20', 472500, 508300, 1656, 1, 62.38, 58.3078, 'T', null, null],
  ['2025-12-28', 592500, 601300, 1897, 1, 62.35, 58.3078, 'T', null, null],
  ['2026-03-19', 230000, 225500, 2016, 1, 62.1, 52.1916, 'T', null, null],
  ['2025-11-20', 365000, 399900, 1500, 1, 62.07, 58.3078, 'T', null, null],
  ['2026-02-24', 455000, 488400, 1582, 1, 61.59, 58.3078, 'T', null, null],
  ['2026-03-09', 510000, 477900, 2200, 1, 61.4, 58.3078, 'T', null, null],
  ['2026-01-06', 599900, 646500, 1660, 1, 61.38, 58.3078, 'T', null, null],
  ['2026-01-14', 361000, 382800, 1697, 1, 61.15, 58.3078, 'T', null, null],
  ['2026-01-27', 375000, 381200, 1695, 1, 61.09, 58.3078, 'T', null, null],
  ['2025-12-19', 715000, 700500, 1854, 1, 60.92, 58.3078, 'T', null, null],
  ['2026-03-30', 665000, 652600, 2056, 1, 60.74, 58.3078, 'T', null, null],
  ['2026-02-27', 880000, 829400, 2114, 1, 60.6, 58.3078, 'O', null, null],
  ['2026-03-20', 945000, 968600, 1853, 1, 60.48, 58.3078, 'O', null, null],
  ['2026-03-17', 523147, 524100, 1962, 1, 60.36, 58.3078, 'T', null, null],
  ['2026-04-22', 885000, 959000, 1653, 1, 59.84, 58.3078, 'O', null, null],
  ['2025-12-11', 400000, 428000, 1667, 1, 59.48, 58.3078, 'T', null, null],
  ['2026-02-27', 300000, 337300, 1468, 1, 58.81, 52.1916, 'T', null, null],
  ['2025-11-26', 355000, 391900, 1474, 1, 58.47, 58.3078, 'T', null, null],
  ['2025-12-12', 247000, 280100, 1349, 1, 57.99, 52.1916, 'T', null, null],
  ['2025-12-16', 500000, 497900, 1872, 1, 57.87, 58.3078, 'T', null, null],
  ['2026-03-16', 750000, 754800, 1931, 1, 57.02, 58.3078, 'T', null, null],
]
const comps = POOL.map(([saleDate, salePrice, adjusted, sqft, mls, score, q, status, w1001, w0930]) => ({
  saleDate, salePrice, adjusted, sqft, mls: mls === 1, score, q, status, w1001, w0930,
}))

/* ── the pricing replay ─────────────────────────────────────────────────── */

// The pre-RC-7.1 rule, frozen here for the record: calendar-month age, step table.
const LEGACY_STEPS = [[3, 100], [6, 94], [12, 82], [18, 68], [24, 52], [36, 30]]
function legacyRecency(saleDate, now) {
  const d = new Date(saleDate)
  const months = Math.max(0, (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + now.getUTCMonth() - d.getUTCMonth())
  return LEGACY_STEPS.find(([max]) => months <= max)?.[1] ?? 10
}
// The engine's rule: its own curve, at elapsed days from the as-of time.
const engineRecency = (saleDate, now) => recencyScore(saleAgeDays(saleDate, now) / DAYS_PER_MONTH)

const clamp100 = (v) => Math.min(100, Math.max(0, v))
const round4 = (v) => Math.round(v * 1e4) / 1e4
// scoreComparable's weight as a function of recency r, given the comp's
// time-free comparability D (its direct feature score) and completeness q.
function weightFor({ D, q, mls }, r) {
  const F = clamp100(0.95 * D + 0.05 * (0.6 * r + 0.4 * q))
  const C = clamp100(0.55 * F + 0.3 * q + 0.15 * r)
  const exact = (F / 100) * (C / 100) * (r / 100) * (mls ? 1 : 0.92)
  return { F, C, exact, rounded: round4(exact) }
}
// D does not depend on time. Back it out of the stored comp_score with the
// recency that was in force at that run.
for (const c of comps) c.D = (c.score - 0.03 * legacyRecency(c.saleDate, RUN_1001) - 0.02 * c.q) / 0.95

// The final-set step of calculateAcquisitionDecision on this pool. The outlier
// set depends only on adjusted prices, and every comp_score here is far above
// the 30 floor, so only the top-12 ranking moves with time. The legacy engine
// ranked on the 4-dp weight; the fixed engine ranks on the exact weight.
function price(now, recencyOf, exactOrder) {
  const ranked = comps
    .filter((c) => c.status !== 'O')
    .map((c) => ({ c, ...weightFor(c, recencyOf(c.saleDate, now)) }))
    .sort((a, b) => (exactOrder ? b.exact - a.exact : b.rounded - a.rounded))
  const set = ranked.slice(0, 12)
  const total = set.reduce((sum, x) => sum + x.rounded, 0)
  return { value: set.reduce((sum, x) => sum + x.rounded * x.c.adjusted, 0) / total, set }
}
const legacy = (now) => price(now, legacyRecency, false)
const fixed = (now) => price(now, engineRecency, true)
const roundMoney = (v) => Math.round(v / 100) * 100
const setKey = (p) => p.set.map((x) => comps.indexOf(x.c)).sort((a, b) => a - b).join(',')

/* ── the de-identified pool as raw rows, for the full engine ────────────── */

// Only age, price, size and sale channel differ. Everything else equals the
// subject, and every comp sits 0.5 mi away.
const SUBJECT = {
  property_id: 'SUBJ', property_type: 'Single Family', units_count: 1, building_square_feet: 1853,
  total_bedrooms: 4, total_baths: 2.5, year_built: 1907, latitude: 45, longitude: -93, property_address_zip: '00001',
}
const RAW = comps.map((c, i) => ({
  id: `c${i}`, property_id: `P${i}`, property_type: 'Single Family', units_count: 1, building_square_feet: c.sqft,
  total_bedrooms: 4, total_baths: 2.5, year_built: 1907, latitude: 45.007, longitude: -93, property_address_zip: '00001',
  sale_price: c.salePrice, sale_date: c.saleDate, mls_sold_price: c.mls ? c.salePrice : null, mls_sold_date: c.mls ? c.saleDate : null,
  distance_miles: 0.5, source: 'v_recent_sold_comps',
}))
const decide = (now) => calculateAcquisitionDecision({ subject: SUBJECT, comps: RAW, now, v3Enabled: false })
// Unrounded mid: the engine's own weighted total over its own total weight.
const exactMid = (d) => d.valuation.calculation.weighted_value_total / d.valuation.calculation.total_weight

/* ── (a) stability across every month boundary ──────────────────────────── */

test('(a) the same comps priced at 23:59 and 00:01 across every 2026 month boundary move < 0.5%, inside the proven bound', () => {
  for (let month = 0; month < 12; month += 1) {
    const before = new Date(Date.UTC(2026, month + 1, 0, 23, 59))
    const after = new Date(Date.UTC(2026, month + 1, 1, 0, 1))
    const d1 = decide(before)
    const d2 = decide(after)
    const label = before.toISOString().slice(0, 10)
    assert.deepEqual(d2.selected_comps.map((c) => c.id), d1.selected_comps.map((c) => c.id), `${label}: same set`)
    const v1 = exactMid(d1)
    const v2 = exactMid(d2)
    assert.ok(Math.abs(v2 / v1 - 1) < 0.005, `${label}: ${v1} -> ${v2}`)
    // Proven bound for a 2-minute step on a fixed set (4-dp weights).
    const w2 = d2.valuation.calculation.total_weight
    const spread = d1.selected_comps.reduce((sum, c) => sum + Math.abs(c.adjusted_price - v1), 0)
    assert.ok(Math.abs(v2 - v1) <= (1e-4 * spread) / w2 + 0.05, `${label}: |dV| ${Math.abs(v2 - v1)} > bound ${(1e-4 * spread) / w2}`)
    assert.ok(Math.abs(d2.valuation.mid - d1.valuation.mid) <= 100, `${label}: stored mid moved more than one $100 step`)
  }
})

test('(a) the 09-30 -> 10-01 midnight that moved 273312064 -9.5% does not move the engine', () => {
  const d1 = decide(BEFORE)
  const d2 = decide(AFTER)
  // The pool still straddles the boundary: every March sale crosses from 6 to 7 calendar months.
  const march = RAW.filter((r) => r.sale_date.startsWith('2026-03'))
  assert.equal(march.length, 19)
  for (const r of march) {
    const a = normalizePropertyFeatures(r, { now: BEFORE })
    const b = normalizePropertyFeatures(r, { now: AFTER })
    assert.equal(b.sale_age_months, a.sale_age_months + 1)
    assert.ok(Math.abs(b.sale_age_days - a.sale_age_days - 2 / 1440) < 1e-9)
  }
  assert.ok(Math.abs(exactMid(d2) / exactMid(d1) - 1) < 1e-4)
})

/* ── (b) monotonic ──────────────────────────────────────────────────────── */

test('(b) the curve is continuous, non-increasing, bounded, and passes through its knots', () => {
  const maxSlope = Math.max(...RECENCY_CURVE.slice(1).map((k, i) => (RECENCY_CURVE[i].score - k.score) / (k.months - RECENCY_CURVE[i].months)))
  assert.ok(Math.abs(maxSlope - 12 / 4.5) < 1e-12)
  for (const k of RECENCY_CURVE) assert.equal(recencyScore(k.months), k.score)
  let prev = recencyScore(0)
  assert.equal(prev, 100)
  const step = 1 / 64
  for (let m = step; m <= 72; m += step) {
    const r = recencyScore(m)
    assert.ok(r <= prev, `rises at ${m} mo`)
    assert.ok(prev - r <= maxSlope * step + 1e-9, `jumps at ${m} mo`)
    assert.ok(r >= 10 && r <= 100)
    prev = r
  }
  assert.equal(recencyScore(72), 10)
})

test('(b) all else equal, an older sale never scores or weighs more than a newer one', () => {
  const NOW = new Date('2026-10-15T12:00:00Z')
  for (const family of [
    { row: { property_type: 'Single Family', units_count: 1, building_square_feet: 1500, total_bedrooms: 3, total_baths: 2, year_built: 1950 }, maxDays: 900 },
    { row: { property_type: 'Commercial', building_square_feet: 12000, year_built: 1990 }, maxDays: 1440 },
  ]) {
    const subject = normalizePropertyFeatures({ property_id: 'S', latitude: 45, longitude: -93, property_address_zip: '00001', ...family.row }, { source: 'properties', now: NOW })
    let prev = null
    for (let days = 0; days <= family.maxDays; days += 1) {
      const saleDate = new Date(NOW.getTime() - days * DAY_MS).toISOString()
      const s = scoreComparable(subject, { ...family.row, id: `d${days}`, property_id: `D${days}`, latitude: 45.007, longitude: -93, property_address_zip: '00001', sale_price: 300000, sale_date: saleDate, source: 'v_recent_sold_comps' }, { source: 'v_recent_sold_comps', distance_miles: 0.5, now: NOW })
      assert.equal(s.eligible, true, `${family.row.property_type} ${days} d: ${s.reasons}`)
      if (prev) {
        for (const k of ['recency_score', 'comp_score', 'comp_confidence', 'weight_exact']) {
          assert.ok(s[k] <= prev[k], `${family.row.property_type}: ${k} rises from ${days - 1} to ${days} days (${prev[k]} -> ${s[k]})`)
        }
      }
      prev = s
    }
  }
})

/* ── (c) the 273312064 pool ─────────────────────────────────────────────── */

test('(c) the replay is the engine: its weight at any as-of time is scoreComparable’s', () => {
  const t1 = RUN_1001
  for (const t2 of [new Date('2026-06-01T08:00:00Z'), BEFORE, AFTER, new Date('2027-02-14T20:00:00Z')]) {
    for (const [i, raw] of RAW.entries()) {
      if (i % 7) continue
      const a = scoreComparable(normalizePropertyFeatures(SUBJECT, { now: t1 }), raw, { source: raw.source, distance_miles: 0.5, now: t1 })
      const b = scoreComparable(normalizePropertyFeatures(SUBJECT, { now: t2 }), raw, { source: raw.source, distance_miles: 0.5, now: t2 })
      const D = (a.comp_score - 0.03 * a.recency_score - 0.02 * a.data_completeness) / 0.95
      const predicted = weightFor({ D, q: a.data_completeness, mls: raw.mls_sold_price !== null }, engineRecency(raw.sale_date, t2))
      assert.ok(Math.abs(predicted.exact - b.weight_exact) < 2e-4, `comp ${i} at ${t2.toISOString()}: ${predicted.exact} vs ${b.weight_exact}`)
    }
  }
})

test('(c) BEFORE the fix: the legacy calendar-month rule reproduces both stored valuations and the jump', () => {
  for (const c of comps.filter((x) => x.w1001 !== null)) assert.ok(Math.abs(weightFor(c, legacyRecency(c.saleDate, RUN_1001)).rounded - c.w1001) <= 1e-4 + 1e-12)
  for (const c of comps.filter((x) => x.w0930 !== null)) assert.ok(Math.abs(weightFor(c, legacyRecency(c.saleDate, RUN_0930)).rounded - c.w0930) <= 1e-4 + 1e-12)
  const at0930 = legacy(RUN_0930)
  const at1001 = legacy(RUN_1001)
  assert.equal(roundMoney(at0930.value), 362_500)
  assert.equal(roundMoney(at1001.value), 327_900)
  assert.deepEqual(at0930.set.map((x) => x.c.w0930 !== null), Array(12).fill(true))
  assert.deepEqual(at1001.set.map((x) => x.c.status), Array(12).fill('S'))
  // Across one midnight, with nothing else changing:
  const jump = legacy(AFTER).value / legacy(BEFORE).value - 1
  assert.ok(jump < -0.09, `legacy jump ${jump}`)
})

test('(c) AFTER the fix: the same pool does not move across that midnight', () => {
  const a = fixed(BEFORE)
  const b = fixed(AFTER)
  assert.equal(setKey(b), setKey(a))
  assert.ok(Math.abs(b.value / a.value - 1) < 0.005, `${a.value} -> ${b.value}`)
  assert.ok(Math.abs(b.value / a.value - 1) < 1e-5)
  // Between the two real runs (21.7 hours apart) the value barely moves either.
  assert.ok(Math.abs(fixed(RUN_1001).value / fixed(RUN_0930).value - 1) < 0.001)
})

test('(c) over ten months the legacy rule re-prices on the 1st; the engine changes the set only at a weight crossing, without flip-flop', () => {
  const sweep = (fn) => {
    const changes = []
    let prev = null
    for (let t = Date.parse('2026-06-01T00:30:00Z'); t <= Date.parse('2027-03-31T23:30:00Z'); t += 3_600_000) {
      const at = new Date(t)
      const p = fn(at)
      const members = p.set.map((x) => x.c)
      if (prev && setKey(p) !== prev.key) {
        changes.push({
          at, from: prev.value, to: p.value,
          moved: [...prev.members.filter((c) => !members.includes(c)), ...members.filter((c) => !prev.members.includes(c))],
        })
      }
      prev = { key: setKey(p), value: p.value, members }
    }
    return changes
  }
  const onTheFirst = (c) => c.at.getUTCDate() === 1 && c.at.getUTCHours() === 0
  const old = sweep(legacy)
  assert.ok(old.length >= 6, `legacy set changes: ${old.length}`)
  assert.ok(old.every(onTheFirst), 'legacy changes happen only at 00:00 UTC on the 1st')
  assert.ok(old.some((c) => Math.abs(c.to / c.from - 1) > 0.09))

  const engine = sweep(fixed)
  assert.ok(engine.length >= 1 && engine.length <= 2, `engine set changes: ${engine.length}`)
  assert.ok(!engine.some(onTheFirst), 'no change on a calendar boundary')
  // No flip-flop: across ten months no comp changes membership more than once.
  const toggles = new Map()
  for (const c of engine) for (const x of c.moved) toggles.set(x, (toggles.get(x) ?? 0) + 1)
  assert.ok([...toggles.values()].every((n) => n === 1), `flip-flop: ${[...toggles.values()]}`)
})
