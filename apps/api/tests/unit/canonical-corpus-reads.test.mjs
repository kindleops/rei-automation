/**
 * CANONICAL CORPUS READS (display / evidence only). Flag COMPS_CANONICAL_CORPUS_READS
 * defaults ON; a missing RPC falls back with a reason; every comp carries a buyer type,
 * junk reasons and an engine-shaped row; the freshness label states the data date.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalCorpusReadsEnabled, fetchCanonicalCorpusComps, canonicalCompBuyerType, canonicalJunkReasons,
  canonicalRowToEngineInput, freshnessLabel, corpusLaneOf,
} from '../../src/lib/domain/comp-intelligence/canonical-corpus-reads.js'
import { normalizePropertyFeatures, evaluateCompEligibility } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'

const NOW = new Date('2026-10-07T00:00:00Z')
const row = (o = {}) => ({ comp_id: 't:1', source: 'public_record', sold_on: '2026-09-01', price: 160000, lat: 32.9, lng: -96.7, property_id: 'P1', address: '1 Main St',
  city: 'Dallas', state: 'TX', zip: '75238', property_type: 'Single Family', beds: 3, baths: 2, sqft: 1400, year_built: 1964, units: 1, portfolio_size: 1,
  buyer: 'GATOR HOMES LLC', buyer_class: 'llc_investor', buyer_kind: 'company', is_investor: true, doc_type: 'Warranty Deed', is_cash_purchase: true, is_arms_length: true, ...o })

test('flag defaults ON; explicit off values disable it', () => {
  assert.equal(canonicalCorpusReadsEnabled({}), true)
  for (const v of ['0', 'false', 'off', 'no']) assert.equal(canonicalCorpusReadsEnabled({ COMPS_CANONICAL_CORPUS_READS: v }), false)
})

test('RPC missing -> available:false, reason canonical_rpc_not_applied (caller keeps today\'s source)', async () => {
  const client = { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) }
  const r = await fetchCanonicalCorpusComps(client, { lat: 32.9, lng: -96.7, radiusMiles: 2.5, months: 24, now: NOW }, { env: {} })
  assert.equal(r.available, false)
  assert.equal(r.reason, 'canonical_rpc_not_applied')
  const off = await fetchCanonicalCorpusComps(client, { lat: 32.9, lng: -96.7 }, { env: { COMPS_CANONICAL_CORPUS_READS: 'off' } })
  assert.equal(off.reason, 'flag_off')
})

test('RPC present -> rows labelled with buyer type + junk reasons, strictly-before as-of window, freshness label', async () => {
  let params = null
  const client = { rpc: async (name, p) => { params = { name, ...p }; return { data: [row(), row({ comp_id: 't:2', sold_on: '2026-09-10', price: 20000 })], error: null } } }
  const r = await fetchCanonicalCorpusComps(client, { lat: 32.9, lng: -96.7, radiusMiles: 2.5, months: 24, now: NOW }, { env: {} })
  assert.equal(params.name, 'get_v3_sales_candidates')
  assert.equal(params.p_as_of, '2026-10-08')
  assert.equal(params.p_since, '2024-10-08')
  assert.equal(r.available, true)
  assert.equal(r.latestSale, '2026-09-10')
  assert.equal(r.label, 'Comps current through 2026-09-10')
  assert.equal(r.rows[0].buyer_type, 'investor_llc')
  assert.deepEqual(r.rows[1].junk_reasons, ['junk_price_below_25k'])
})

test('buyer types: institutional / LLC / cash / inferred entity / retail individual / MLS', () => {
  assert.equal(canonicalCompBuyerType(row({ buyer: 'INVITATION HOMES 4 LLC' })), 'institutional')
  assert.equal(canonicalCompBuyerType(row({ buyer: 'OPENDOOR PROPERTY J LLC' })), 'institutional')
  assert.equal(canonicalCompBuyerType(row()), 'investor_llc')
  assert.equal(canonicalCompBuyerType(row({ buyer: null, buyer_kind: null, buyer_class: 'unknown', is_investor: false })), 'investor_cash')
  assert.equal(canonicalCompBuyerType(row({ buyer: null, buyer_kind: null, buyer_class: 'unknown', is_investor: false, is_cash_purchase: null, owner_linked: true, owner_corporate: true })), 'investor_inferred')
  assert.equal(canonicalCompBuyerType(row({ buyer: null, buyer_kind: 'person', buyer_class: 'individual', is_investor: false, is_cash_purchase: false })), 'retail_individual')
  assert.equal(canonicalCompBuyerType(row({ source: 'mls' })), 'retail_mls')
})

test('junk rules: distressed deed, non arm\'s-length, portfolio, multi-parcel, builder buyer, new construction', () => {
  assert.ok(canonicalJunkReasons(row({ doc_type: 'Trustee Deed' })).includes('distress_or_transfer_deed'))
  assert.ok(canonicalJunkReasons(row({ is_arms_length: false })).includes('non_arms_length'))
  assert.ok(canonicalJunkReasons(row({ portfolio_size: 3 })).includes('portfolio_deed'))
  assert.ok(canonicalJunkReasons(row({ bulk_parcels_zip: 2 })).includes('multi_parcel_consideration'))
  assert.ok(canonicalJunkReasons(row({ buyer_class: 'builder' })).includes('builder_bank_or_government_buyer'))
  assert.ok(canonicalJunkReasons(row({ year_built: 2026 })).includes('new_construction'))
  assert.deepEqual(canonicalJunkReasons(row()), [])
})

test('engine row: the production eligibility gate runs unchanged (asset / unit-count guard)', () => {
  const subject = normalizePropertyFeatures({ property_id: 'S', property_type: 'Single Family', units_count: 1, building_square_feet: 1400, total_bedrooms: 3, total_baths: 2, year_built: 1965, latitude: 32.9, longitude: -96.7, property_address_zip: '75238' }, { source: 'properties', now: NOW })
  assert.equal(corpusLaneOf(subject), 'sfr')
  const ok = normalizePropertyFeatures(canonicalRowToEngineInput(row(), subject), { source: 'mv_map_market_sales', now: NOW })
  assert.equal(evaluateCompEligibility(subject, ok, NOW).eligible, true)
  const mf = normalizePropertyFeatures(canonicalRowToEngineInput(row({ property_type: 'Apartment', units: 12, sqft: 9000, price: 1100000 }), subject), { source: 'mv_map_market_sales', now: NOW })
  assert.equal(evaluateCompEligibility(subject, mf, NOW).eligible, false)
  assert.equal(freshnessLabel(null), 'Comps date not available')
})
