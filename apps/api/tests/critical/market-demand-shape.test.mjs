/**
 * AREA MARKET DEMAND — shaping of the deal_market_demand() payload.
 *
 * RAW is a trimmed real production payload (Houston SFR 2130391950, 1.5 mi,
 * 24 months, 2026-09-27). The shaper must keep numbers as numbers, keep
 * unknowns null (never 0), and carry the SQL's definitions untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeMarketDemand, getMarketDemand } from '../../src/lib/domain/deal-intelligence/market-demand-service.js'

const RAW = {
  ok: true,
  property_id: '2130391950',
  subject: { family: 'residential_1', property_type: 'Single Family', units: 1, sqft: 1256, estimated_value: 186000, zip: '77016', city: 'Houston', state: 'TX' },
  radius_requested: 1.5,
  radius_used: 1.5,
  min_sales_target: 8,
  radius_tiers: [
    { radius: 1.5, sales: 77, priced: 38, priced_in_band: 38 },
    { radius: 3, sales: 230, priced: 120, priced_in_band: 120 },
  ],
  units_band: { applied: false, min: null, max: null },
  months: 24,
  window: { since: '2024-09-27', until: '2026-09-27' },
  data_through: '2026-05-08',
  total_sales: 76,
  priced_sales: 37,
  excluded_outliers: 1,
  excluded_by_reason: { price_far_from_area_median: 1 },
  overall: {
    priced_sales: 37, median_price: 159600, avg_price: 164856, p25_price: 131000, p75_price: 190000,
    median_ppsf: 129, ppsf_sample: 37, median_ppu: null, ppu_sample: 0, median_beds: 3, median_sqft: 1300,
    median_units: 1, median_year_built: 1960, median_distance_miles: 0.8, buyer_known_share: 0.553,
    portfolio_doors: 2, portfolio_transactions: 1, latest_sale_on: '2026-05-05', earliest_sale_on: '2024-10-01',
  },
  by_source: [
    { source: 'investor', count: 40, priced: 20, share: 0.526, median_price: 159000, median_ppsf: 121 },
    { source: 'public_record', count: 34, priced: 15, share: 0.447, median_price: 146812, median_ppsf: 139 },
    { source: 'mls', count: 2, priced: 2, share: 0.026, median_price: 179783, median_ppsf: 128 },
  ],
  by_buyer: [
    { group: 'unknown', count: 34, priced: 16, share: 0.447, median_price: 158935, median_ppsf: 142, out_of_state_share: null },
    { group: 'company_llc', count: 28, priced: 14, share: 0.368, median_price: 160000, median_ppsf: 120, out_of_state_share: 0.25 },
    { group: 'institutional', count: 8, priced: 4, share: 0.105, median_price: 150000, median_ppsf: 118, out_of_state_share: 0 },
  ],
  investor_vs_retail: {
    investor: { count: 42, priced: 21, median_price: 159600, median_ppsf: 122, median_ppu: null },
    retail: { count: 2, priced: 2, median_price: 179783, median_ppsf: 128, median_ppu: null },
    non_investor: { count: 34, priced: 16, median_price: 158935, median_ppsf: 142 },
    unclassified_count: 32,
    non_market_count: 0,
    min_sample: 3,
    discount_pct: null,
    ppsf_discount_pct: null,
    discount_vs_non_investor_pct: -0.4,
    definitions: { investor: 'buyer_class in (...)', non_investor: 'retail + unclassified', discount_pct: '(1 - ...)' },
  },
  trend: [
    { quarter: '2025-Q4', quarter_start: '2025-10-01', count: 8, priced: 2, median_price: 147830, median_ppsf: 97, investor_count: 5 },
    { quarter: '2026-Q1', quarter_start: '2026-01-01', count: 25, priced: 11, median_price: 144400, median_ppsf: 115, investor_count: 3 },
  ],
  zips: [
    { zip: '77016', count: 60, priced: 30, median_price: 158000, median_ppsf: 128, is_subject_zip: true },
    { zip: '77028', count: 16, priced: 7, median_price: 150000, median_ppsf: 125, is_subject_zip: false },
  ],
  generated_at: '2026-09-27T23:30:00+00:00',
}

const NOW = Date.parse('2026-09-27T12:00:00Z')

test('shapes subject, radius, window and totals', () => {
  const s = shapeMarketDemand(RAW, { now: NOW })
  assert.equal(s.ok, true)
  assert.equal(s.propertyId, '2130391950')
  assert.deepEqual(s.subject, {
    family: 'residential_1', familyLabel: 'Single family', propertyType: 'Single Family', units: 1, sqft: 1256,
    estimatedValue: 186000, zip: '77016', city: 'Houston', state: 'TX',
  })
  assert.equal(s.radius.requested, 1.5)
  assert.equal(s.radius.used, 1.5)
  assert.equal(s.radius.widened, false)
  assert.equal(s.radius.minSalesTarget, 8)
  assert.deepEqual(s.radius.tiers[1], { radius: 3, sales: 230, priced: 120, pricedInBand: 120 })
  assert.deepEqual(s.unitsBand, { applied: false, min: null, max: null })
  assert.equal(s.window.months, 24)
  assert.equal(s.window.dataThrough, '2026-05-08')
  assert.equal(s.window.dataAgeDays, 142)
  assert.deepEqual(s.totals, {
    sales: 76, pricedSales: 37, unpricedSales: 39, excludedOutliers: 1,
    excludedByReason: [{ reason: 'price_far_from_area_median', label: 'Price > 6× from area median', count: 1 }],
  })
})

test('overall keeps unknowns null, never 0', () => {
  const { overall } = shapeMarketDemand(RAW, { now: NOW })
  assert.equal(overall.medianPrice, 159600)
  assert.equal(overall.avgPrice, 164856)
  assert.equal(overall.medianPpsf, 129)
  assert.equal(overall.medianPpu, null)
  assert.equal(overall.ppuSample, 0)
  assert.equal(overall.buyerKnownShare, 0.553)
  assert.equal(overall.portfolioTransactions, 1)
  assert.equal(overall.latestSaleOn, '2026-05-05')
})

test('breakdowns are labelled and camelCased', () => {
  const s = shapeMarketDemand(RAW, { now: NOW })
  assert.deepEqual(s.bySource.map((x) => [x.source, x.label, x.count]), [
    ['investor', 'Investor purchases', 40], ['public_record', 'Public record', 34], ['mls', 'MLS', 2],
  ])
  const llc = s.byBuyer.find((b) => b.group === 'company_llc')
  assert.deepEqual(llc, {
    group: 'company_llc', label: 'LLC / company', count: 28, priced: 14, share: 0.368,
    medianPrice: 160000, medianPpsf: 120, outOfStateShare: 0.25,
  })
  assert.equal(s.byBuyer[0].outOfStateShare, null)
  assert.deepEqual(s.trend[0], {
    quarter: '2025-Q4', quarterStart: '2025-10-01', count: 8, priced: 2, medianPrice: 147830, medianPpsf: 97, investorCount: 5,
  })
  assert.equal(s.zips[0].isSubjectZip, true)
  assert.equal(s.zips[1].isSubjectZip, false)
})

test('investor vs retail carries discounts and definitions without inventing values', () => {
  const { investorVsRetail: ivr } = shapeMarketDemand(RAW, { now: NOW })
  assert.deepEqual(ivr.investor, { count: 42, priced: 21, medianPrice: 159600, medianPpsf: 122, medianPpu: null })
  assert.deepEqual(ivr.retail, { count: 2, priced: 2, medianPrice: 179783, medianPpsf: 128, medianPpu: null })
  assert.equal(ivr.nonInvestor.medianPrice, 158935)
  assert.equal(ivr.discountPct, null, 'retail has < 3 priced sales: no discount')
  assert.equal(ivr.discountVsNonInvestorPct, -0.4)
  assert.equal(ivr.unclassifiedCount, 32)
  assert.equal(ivr.minSample, 3)
  assert.deepEqual(Object.keys(ivr.definitions).sort(), ['discountPct', 'investor', 'nonInvestor'])
})

test('string numerics coerce; garbage becomes null; widened radius detected', () => {
  const s = shapeMarketDemand({
    ...RAW,
    radius_requested: '1.5', radius_used: '5', total_sales: '12', priced_sales: '9',
    overall: { ...RAW.overall, median_price: '250000.4', median_ppsf: 'n/a', median_beds: '3.5' },
    units_band: { applied: true, min: '12', max: '75' },
  }, { now: NOW })
  assert.equal(s.radius.widened, true)
  assert.equal(s.radius.used, 5)
  assert.equal(s.totals.unpricedSales, 3)
  assert.equal(s.overall.medianPrice, 250000)
  assert.equal(s.overall.medianPpsf, null)
  assert.equal(s.overall.medianBeds, 3.5)
  assert.deepEqual(s.unitsBand, { applied: true, min: 12, max: 75 })
})

test('empty market: counts are 0, statistics null, arrays empty', () => {
  const s = shapeMarketDemand({
    ok: true, property_id: 'x', subject: { family: 'land' }, radius_requested: 1.5, radius_used: 10,
    total_sales: 0, priced_sales: 0, excluded_outliers: 0, excluded_by_reason: {},
    overall: { median_price: null, priced_sales: 0 }, by_source: [], by_buyer: [], trend: [], zips: [],
    investor_vs_retail: { investor: { count: 0, priced: 0 }, retail: { count: 0, priced: 0 }, non_investor: { count: 0, priced: 0 } },
  }, { now: NOW })
  assert.equal(s.subject.familyLabel, 'Land')
  assert.equal(s.totals.sales, 0)
  assert.equal(s.overall.medianPrice, null)
  assert.deepEqual(s.bySource, [])
  assert.equal(s.investorVsRetail.investor.medianPrice, null)
  assert.equal(s.window.dataAgeDays, null)
})

test('SQL error payloads and missing data surface as ok:false', () => {
  assert.deepEqual(shapeMarketDemand({ ok: false, error: 'subject_not_found', property_id: 'nope' }), {
    ok: false, propertyId: 'nope', error: 'subject_not_found',
  })
  assert.deepEqual(shapeMarketDemand(null), { ok: false, propertyId: null, error: 'market_demand_unavailable' })
})

test('getMarketDemand clamps inputs and passes them to the RPC (fake client)', async () => {
  const calls = []
  const fake = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: RAW, error: null } } }
  const out = await getMarketDemand({ propertyId: ' 2130391950 ', radiusMiles: 50, months: 0 }, { supabase: fake, now: NOW })
  assert.deepEqual(calls, [['deal_market_demand', { p_property_id: '2130391950', p_radius_miles: 10, p_months: 1 }]])
  assert.equal(out.ok, true)

  const defaults = []
  await getMarketDemand({ propertyId: 'a' }, { supabase: { rpc: async (fn, args) => { defaults.push(args); return { data: RAW, error: null } } } })
  assert.deepEqual(defaults[0], { p_property_id: 'a', p_radius_miles: 1.5, p_months: 12 })

  assert.deepEqual(await getMarketDemand({}, { supabase: fake }), { ok: false, propertyId: null, error: 'property_id_required' })

  const failing = { rpc: async () => ({ data: null, error: { message: 'permission denied for function deal_market_demand' } }) }
  assert.deepEqual(await getMarketDemand({ propertyId: 'a' }, { supabase: failing }), {
    ok: false, propertyId: 'a', error: 'market_demand_unavailable', detail: 'permission denied for function deal_market_demand',
  })
})
