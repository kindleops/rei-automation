// 8.5.20-b — ZIP acquisition economics: labelled hierarchical priors, thin-data handling,
// no precise local MAO without evidence, never one universal %, the builder is OFF by
// default and incremental, and the learning loop accepts ONLY validated outcomes.
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildZipCells, lookupZipEconomics, propertyTypeOf, valueBandOf, conditionBandOf, buyerSideOf, ZIP_MODEL_RULES } from '../../src/lib/domain/zip-intelligence/zip-model.js'
import { createZipModelBuilder, createZipMemoryStore, zipBuilderEnabled } from '../../src/lib/domain/zip-intelligence/zip-builder.js'
import { acceptForTraining, applyValidatedOutcomes, validateOutcome, predictionError } from '../../src/lib/domain/zip-intelligence/learning-loop.js'

const NOW = Date.parse('2026-10-15T00:00:00Z')
let seq = 0
function sale(zip, { investor = null, price = 200000, value = 250000, type = 'Single Family', units = 1, cash = null, month = 3, arms = true } = {}) {
  seq += 1
  return { zip, property_type: type, units, price, estimated_value: value, sold_on: `2026-0${month}-1${seq % 9}`, is_investor: investor === true, buyer_kind: investor === true ? 'company' : investor === false ? 'person' : null, is_cash_purchase: cash, is_arms_length: arms, is_priced: true }
}
/** A dense ZIP (local evidence), a thin ZIP in the same county, an empty-type ZIP. */
function world() {
  const rows = []
  for (let i = 0; i < 26; i += 1) rows.push(sale('75051', { investor: true, price: 150000 + i * 500, value: 220000, cash: true }))
  for (let i = 0; i < 26; i += 1) rows.push(sale('75051', { investor: false, price: 205000 + i * 500, value: 220000, cash: false }))
  for (let i = 0; i < 40; i += 1) rows.push(sale('75051', { investor: null, price: 190000, value: 220000 })) // unclassified: never retail
  rows.push(sale('75052', { investor: true, price: 120000, value: 200000 }), sale('75052', { investor: false, price: 190000, value: 200000 }))
  for (let i = 0; i < 6; i += 1) rows.push(sale('75053', { investor: false, price: 300000, value: 310000, type: 'Multi-Family', units: 3 }))
  rows.push(sale('75051', { investor: true, price: 1, value: 220000 }), sale('75051', { investor: true, price: 100000, arms: false }), { ...sale('75051', { investor: true }), sold_on: '2024-01-01' })
  return rows
}
const GEO = { 75051: { county: 'TX:dallas', metro: 'dallas-tx', state: 'TX' }, 75052: { county: 'TX:dallas', metro: 'dallas-tx', state: 'TX' }, 75053: { county: 'TX:tarrant', metro: 'dallas-tx', state: 'TX' } }

test('classifiers: property type, value band, condition band, buyer side (unclassified is never retail)', () => {
  assert.equal(propertyTypeOf({ property_type: 'Single Family' }), 'sfr')
  assert.equal(propertyTypeOf({ property_type: 'Multi-Family', units: 3 }), 'mf_2_4')
  assert.equal(propertyTypeOf({ property_type: 'Multi-Family', units: 12 }), 'mf_5_plus')
  assert.equal(propertyTypeOf({ property_type: 'Apartment' }), 'mf_5_plus')
  assert.equal(propertyTypeOf({ property_type: 'Vacant Land' }), 'land_vacant_residential')
  assert.equal(propertyTypeOf({ property_type: 'Vacant Land', lot_acreage: 5 }), 'land_development')
  assert.equal(propertyTypeOf({ property_type: 'Other' }), null)
  assert.equal(valueBandOf(150000), '100k_200k')
  assert.equal(conditionBandOf({ repair_to_value: 0.3 }), 'heavy')
  assert.equal(conditionBandOf({}), 'unknown')
  assert.equal(buyerSideOf({ buyer_kind: null, is_investor: false }), 'unknown')
  assert.equal(buyerSideOf({ buyer_kind: 'company' }), 'investor')
  assert.equal(buyerSideOf({ buyer_kind: 'person' }), 'retail')
})

test('cells: a dense ZIP stands on its own evidence (local precision); a thin ZIP is shrunk toward the county and SAYS so; no evidence ⇒ none', () => {
  const m = buildZipCells(world(), GEO, { now: NOW, scope: 'market:dallas-tx' })
  const get = (zip, type, cb = 'all', vb = 'all') => m.cells.find((c) => c.zip5 === zip && c.property_type === type && c.condition_band === cb && c.value_band === vb)
  const dense = get('75051', 'sfr')
  assert.equal(dense.unclassified_n, 40)
  assert.equal(dense.investor_n, 26)
  assert.equal(dense.retail_n, 26, 'unclassified sales are not retail; bad price / non-arm\'s-length / out-of-window rows excluded')
  assert.ok(dense.investor_discount_vs_retail > 0.15 && dense.investor_discount_vs_retail < 0.35, String(dense.investor_discount_vs_retail))
  assert.ok(dense.discount_p25 <= dense.investor_discount_vs_retail && dense.investor_discount_vs_retail <= dense.discount_p75)
  // the county prior exists (it holds the dense ZIP), so even the dense ZIP is shrunk a little — and labelled
  assert.equal(dense.prior_label, 'shrunk_toward:county')
  assert.ok(dense.own_weight > 0.7)
  const thin = get('75052', 'sfr')
  assert.equal(thin.investor_discount_vs_retail_own, null, 'two sales do not make a ZIP estimate')
  assert.equal(thin.prior_level, 'county')
  assert.equal(thin.prior_label, 'prior_only:county')
  assert.equal(thin.prior_geo, 'county:TX:dallas')
  assert.equal(thin.own_weight, 0)
  assert.equal(thin.mao_precision, 'indicative_band', 'a prior is never local precision')
  assert.ok(thin.confidence < dense.confidence)
  const mf = get('75053', 'mf_2_4')
  assert.equal(mf.investor_discount_vs_retail, null)
  assert.equal(mf.prior_level, 'none')
  assert.equal(mf.mao_precision, 'none')
  // every row's label is consistent with the DB CHECK
  for (const c of m.cells) {
    if (c.prior_level === 'zip') assert.equal(c.prior_label, 'own_evidence_only')
    if (['county', 'metro', 'state'].includes(c.prior_level)) assert.ok(c.prior_label.endsWith(`:${c.prior_level}`) && c.prior_geo.startsWith(`${c.prior_level}:`) && c.own_weight < 1)
    if (c.mao_precision === 'local') assert.ok(c.prior_level === 'zip' && c.investor_n >= ZIP_MODEL_RULES.local_min && c.retail_n >= ZIP_MODEL_RULES.local_min)
  }
})

test('local precision needs the ZIP\'s own evidence; lookups return bands + labels, never one universal %', () => {
  const geoNoParent = { 75051: {} }
  const m = buildZipCells(world().filter((r) => r.zip === '75051'), geoNoParent, { now: NOW })
  const own = m.cells.find((c) => c.zip5 === '75051' && c.property_type === 'sfr' && c.condition_band === 'all' && c.value_band === 'all')
  assert.equal(own.prior_level, 'zip')
  assert.equal(own.mao_precision, 'local')
  const l = lookupZipEconomics(m.cells, { zip5: '75051', property_type: 'sfr' })
  assert.equal(l.mao_guidance.precision, 'local')
  assert.ok(Array.isArray(l.investor_discount_band) && l.investor_discount_band[0] < l.investor_discount_band[1], 'a band, not one number')
  const full = buildZipCells(world(), GEO, { now: NOW })
  const thin = lookupZipEconomics(full.cells, { zip5: '75052', property_type: 'sfr', value_band: '200k_350k' })
  assert.equal(thin.found, true)
  assert.equal(thin.investor_discount_point, null, 'no point estimate (no precise local MAO) from a prior')
  assert.equal(thin.mao_guidance.precision, 'indicative_band')
  assert.match(thin.prior_label, /prior_only:county|shrunk_toward/)
  assert.equal(lookupZipEconomics(full.cells, { zip5: '99999', property_type: 'sfr' }).mao_guidance.precision, 'none')
  // different ZIPs / types / bands carry different numbers: never one universal % per ZIP
  const ds = new Set(full.cells.filter((c) => c.investor_discount_vs_retail != null).map((c) => c.investor_discount_vs_retail))
  assert.ok(ds.size > 1)
})

test('builder: OFF by default (reads nothing); incremental — an unchanged generation is skipped; a market above the bound is refused, not truncated', async () => {
  const calls = []
  const rows = world()
  const source = {
    zipsForMarket: async (m) => { calls.push(['zips', m]); return ['75051', '75052', '75053'] },
    generation: async () => { calls.push(['gen']); return `2026-07-28#${rows.length}` },
    sales: async (z, o) => { calls.push(['sales', o.limit]); return rows },
    geoForZips: async () => ({ 75051: { county: 'TX:dallas', state: 'TX' }, 75052: { county: 'TX:dallas', state: 'TX' }, 75053: { county: 'TX:tarrant', state: 'TX' } }),
  }
  const store = createZipMemoryStore()
  assert.equal(zipBuilderEnabled({}), false)
  const off = await createZipModelBuilder({ source, store, env: {}, now: () => NOW }).run({ markets: ['dallas-tx'] })
  assert.equal(off.skipped, 'ZIP_INTEL_BUILDER_DISABLED')
  assert.equal(calls.length, 0, 'disabled ⇒ nothing read')
  const b = createZipModelBuilder({ source, store, env: { ZIP_INTEL_BUILDER_ENABLED: '1' }, now: () => NOW })
  const r1 = await b.run({ markets: ['dallas-tx'] })
  assert.equal(r1.markets[0].status, 'built')
  assert.ok(store.cells.size > 5)
  assert.ok([...store.cells.values()].every((c) => c.build_scope === 'market:dallas-tx'))
  assert.ok([...store.cells.values()].some((c) => c.prior_level === 'metro' || c.prior_level === 'county'), 'the market is the metro prior')
  const r2 = await b.run({ markets: ['dallas-tx'] })
  assert.equal(r2.markets[0].status, 'unchanged')
  const small = createZipModelBuilder({ source, store: createZipMemoryStore(), env: { ZIP_INTEL_BUILDER_ENABLED: '1' }, now: () => NOW, limits: { max_rows: 10 } })
  assert.equal((await small.run({ markets: ['dallas-tx'] })).markets[0].status, 'too_large_for_one_bounded_read')
  const capped = await b.run({ markets: ['a', 'b', 'c', 'd', 'e'], force: true })
  assert.equal(capped.markets.length, 3, 'bounded: at most max_markets per run')
})

test('learning loop: only validated, closing-grade, trusted-origin outcomes train; chat claims never do; error is measured before the update', () => {
  const cells = buildZipCells(world(), GEO, { now: NOW }).cells
  const base = { opportunity_id: 'o', zip5: '75051', property_type: 'sfr', asking_price: 230000, recommended_offer: 160000, opening_offer: 150000, counters: [{ by: 'seller', amount: 200000 }], retail_reference_value: 220000 }
  const validated = { ...base, final_price: 165000, closing_outcome: 'closed_purchased', origin: 'closing_desk', validation_status: 'validated', validation_source: 'settlement_statement', validated_by: 'op-1' }
  const chat = { ...base, final_price: 100000, closing_outcome: 'closed_purchased', origin: 'seller_chat', validation_status: 'validated', validation_source: 'closing_case', validated_by: 'op-1' }
  const unverified = { ...base, final_price: 100000, closing_outcome: 'closed_purchased', origin: 'operator', validation_status: 'unverified' }
  const noSource = { ...validated, validation_source: 'seller_said_so' }
  const pending = { ...validated, closing_outcome: 'pending', final_price: null }
  assert.equal(acceptForTraining(validated).accepted, true)
  assert.match(acceptForTraining(chat).reason, /untrusted/)
  assert.equal(validateOutcome(chat).ok, false)
  assert.match(acceptForTraining(unverified).reason, /not_validated/)
  assert.match(acceptForTraining(noSource).reason, /validation_source/)
  assert.equal(acceptForTraining(pending).accepted, false)
  assert.match(acceptForTraining({ ...validated, final_price: null }).reason, /final_price/)

  const before = cells.find((c) => c.zip5 === '75051' && c.property_type === 'sfr' && c.condition_band === 'all' && c.value_band === 'all')
  const { cells: after, version } = applyValidatedOutcomes(cells, [validated, chat, unverified, noSource, pending], { now: NOW })
  const updated = after.find((c) => c.zip5 === '75051' && c.property_type === 'sfr' && c.condition_band === 'all' && c.value_band === 'all')
  assert.equal(version.validated_outcomes_n, 1)
  assert.equal(updated.validated_outcomes_n, 1)
  assert.notEqual(updated.investor_discount_vs_retail, before.investor_discount_vs_retail)
  // only the validated outcome moved the cell: the chat claim's 100K (a 55 % discount) would move it much further
  const onlyValidated = applyValidatedOutcomes(cells, [validated], { now: NOW }).cells.find((c) => c === updated || (c.zip5 === '75051' && c.property_type === 'sfr' && c.condition_band === 'all' && c.value_band === 'all'))
  assert.equal(onlyValidated.investor_discount_vs_retail, updated.investor_discount_vs_retail)
  assert.equal(version.prediction_error.measured_on, 'validated_outcomes_before_update')
  assert.equal(version.prediction_error.n, 1)
  assert.equal(version.prediction_error.mae, predictionError(cells, [validated]).mae)
  assert.ok(version.refused_outcomes && Object.values(version.refused_outcomes).reduce((a, b) => a + b, 0) === 4)
  assert.equal(version.status, 'shadow')
})

test('a thin parent is not a prior: a county with 3 investor / 4 retail sales is skipped for the metro', () => {
  const rows = []
  for (let i = 0; i < 3; i += 1) rows.push(sale('76036', { investor: true, price: 400000, value: 220000 }))
  for (let i = 0; i < 4; i += 1) rows.push(sale('76036', { investor: false, price: 215000, value: 220000 }))
  for (let i = 0; i < 15; i += 1) rows.push(sale('75051', { investor: true, price: 180000, value: 220000 }), sale('75051', { investor: false, price: 220000, value: 220000 }))
  rows.push(sale('76099', { investor: null, price: 200000, value: 220000 }))
  const geo = { 76036: { county: 'TX:tarrant', metro: 'dallas-tx', state: 'TX' }, 76099: { county: 'TX:tarrant', metro: 'dallas-tx', state: 'TX' }, 75051: { county: 'TX:dallas', metro: 'dallas-tx', state: 'TX' } }
  const c = buildZipCells(rows, geo, { now: NOW }).cells.find((x) => x.zip5 === '76099' && x.property_type === 'sfr' && x.condition_band === 'all' && x.value_band === 'all')
  assert.equal(c.prior_level, 'metro', 'the 3-vs-4 county is noise; the metro carries the prior')
  assert.equal(c.prior_label, 'prior_only:metro')
  assert.ok(c.investor_discount_vs_retail > 0, 'no absurd negative discount from a thin county')
})
