// 8.5.21-b — offer plans use the ZIP × type × condition × value prior, falling back county → metro →
// state (labelled) when the subject ZIP has no cell; precision is never "local" from a fallback;
// the band is applied only to a SOURCED value; no evidence ⇒ unavailable (never 0 %, never universal).
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveZipPrior, indicativeInvestorBand, zipTypeOfLane, subjectBands } from '../../src/lib/domain/zip-intelligence/zip-prior.js'
import { planOffer } from '../../src/lib/domain/property-research/offer-plan.js'
import { score } from '../helpers/property-research-fixtures.mjs'

const NOW = Date.parse('2026-10-16T15:00:00.000Z')
const cell = (zip5, o = {}) => ({ model_version: 'zip-acq-econ.v1', zip5, property_type: 'sfr', condition_band: 'all', value_band: 'all', sample_size: 40, investor_n: 25, retail_n: 25, investor_discount_vs_retail: 0.14, discount_p25: 0.1, discount_p75: 0.2, prior_level: 'zip', prior_label: 'own_evidence_only', own_weight: 1, confidence: 0.7, mao_precision: 'local', sales_per_month: 3.3, investor_share: 0.4, cash_share: 0.5, typical_exit: 'flip', last_update: '2026-10-15T00:00:00.000Z', ...o })
const GEO = { 75051: { county: 'TX:113', metro: 'dfw', state: 'TX' }, 75052: { county: 'TX:113', metro: 'dfw', state: 'TX' }, 75060: { county: 'TX:113', metro: 'dfw', state: 'TX' }, 76101: { county: 'TX:439', metro: 'dfw', state: 'TX' }, 77001: { county: 'TX:201', metro: 'hou', state: 'TX' } }

test('ZIP level first (own evidence, local precision only when the cell is local); then county → metro → state, each labelled, never a point', () => {
  const own = resolveZipPrior({ cells: [cell('75051')], zip5: '75051', property_type: 'sfr', geo: GEO })
  assert.deepEqual([own.level, own.label, own.precision, own.investor_discount_point], ['zip', 'zip:own_evidence', 'local', 0.14])
  const county = resolveZipPrior({ cells: [cell('75052', { sample_size: 30 }), cell('75060', { sample_size: 10, discount_p25: 0.2, discount_p75: 0.3 })], zip5: '75051', property_type: 'sfr', geo: GEO })
  assert.deepEqual([county.level, county.label, county.precision, county.investor_discount_point], ['county', 'fallback:county', 'indicative_band', null])
  assert.deepEqual(county.investor_discount_band, [0.125, 0.225], 'sample-weighted pool of the county cells')
  assert.equal(county.cell.parent, 'county:TX:113')
  const metro = resolveZipPrior({ cells: [cell('76101')], zip5: '75051', property_type: 'sfr', geo: GEO })
  assert.deepEqual([metro.level, metro.label], ['metro', 'fallback:metro'])
  const state = resolveZipPrior({ cells: [cell('77001')], zip5: '75051', property_type: 'sfr', geo: GEO })
  assert.deepEqual([state.level, state.label], ['state', 'fallback:state'])
  assert.deepEqual(resolveZipPrior({ cells: [cell('77001')], zip5: '75051', property_type: 'mf_2_4', geo: GEO }), { version: 'zip-prior.v1', available: false, reason: 'no_cell_at_zip_county_metro_state' })
  assert.equal(resolveZipPrior({ cells: [], zip5: null, property_type: 'sfr' }).reason, 'zip_unknown')
  // a thin ZIP cell shrunk toward its county keeps its label and stays indicative
  const shrunk = resolveZipPrior({ cells: [cell('75051', { prior_level: 'county', prior_label: 'shrunk_toward:county', mao_precision: 'indicative_band' })], zip5: '75051', property_type: 'sfr', geo: GEO })
  assert.deepEqual([shrunk.level, shrunk.label, shrunk.precision, shrunk.investor_discount_point], ['zip', 'zip:shrunk_toward:county', 'indicative_band', null])
})

test('the band applies only to a SOURCED value reference; lane → type; bands from recorded value / repairs', () => {
  const p = resolveZipPrior({ cells: [cell('75051')], zip5: '75051', property_type: 'sfr', geo: GEO })
  assert.deepEqual(indicativeInvestorBand(p, null), { price_band: null, reason: 'no_sourced_value_reference' })
  const b = indicativeInvestorBand(p, { value: 200000, source: 'public.properties.estimated_value (recorded AVM)' })
  assert.deepEqual(b.price_band, [160000, 180000])
  assert.equal(b.role, 'indicative_context_not_an_offer')
  assert.equal(zipTypeOfLane('land', { lot_acreage: 3 }), 'land_development')
  assert.equal(zipTypeOfLane('unknown'), null)
  assert.deepEqual(subjectBands({ value: 250000, repairs: 30000 }), { value_band: '200k_350k', condition_band: 'moderate' })
})

test('offer plan: thin engine evidence ⇒ no MAO, no opening, but the labelled prior is operator context; with an engine MAO the prior is a cross-check only', () => {
  const prior = resolveZipPrior({ cells: [cell('75052')], zip5: '75051', property_type: 'sfr', geo: GEO })
  const prop = { property_type: 'Single Family Residential', units_count: 1, estimated_value: 210000 }
  const thin = planOffer({ valuation: score({ tier: 'CREATIVE_TERMS' }), property: prop, zip_prior: prior, now: NOW })
  assert.equal(thin.available, false)
  assert.equal(thin.mao, null)
  assert.equal(thin.opening, null, 'never a fabricated number')
  assert.deepEqual([thin.market_prior.label, thin.market_prior.precision, thin.market_prior.role], ['fallback:county', 'indicative_band', 'context_not_an_offer'])
  assert.ok(thin.notes.some((n) => n.startsWith('market_prior_available:fallback:county')))
  assert.equal(thin.market_prior.indicative.value_reference.source, 'public.property_acquisition_scores.valuation_mid')
  const none = planOffer({ valuation: null, property: prop, zip_prior: prior, now: NOW })
  assert.equal(none.market_prior.indicative.value_reference.source, 'public.properties.estimated_value (recorded AVM)')
  const ready = planOffer({ valuation: score(), property: prop, zip_prior: prior, now: NOW })
  assert.equal(ready.available, true)
  assert.equal(ready.mao.amount, 150000, 'the engine MAO stays the authority')
  assert.ok(['engine_mao_below_market_band', 'engine_mao_inside_market_band', 'engine_mao_above_market_band'].includes(ready.market_prior_check.position))
  assert.equal(planOffer({ valuation: score(), property: prop, now: NOW }).market_prior.available, false, 'no prior loaded ⇒ unavailable, never 0 %')
})
