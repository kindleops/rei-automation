import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSellerFacts } from '@/lib/domain/seller-flow/extract-seller-facts.js'
import {
  extractDiscoveryFacts,
  extractProjectedRent,
  extractTenancy,
  extractRentDisclosure,
  extractUnitOccupancy,
  extractUnitMix,
  TENANCY_TYPES,
} from '@/lib/domain/seller-flow/discovery-facts.js'

/**
 * ACQUISITION FLOW V2 — structured extraction matrix.
 *
 * These are the adversarial cases from the V2 spec. Several of them were
 * producing WRONG numbers rather than missing ones, which is the more
 * dangerous failure: a rent roll containing the asking price feeds NOI and
 * therefore the offer.
 */

const rentsOf = (text) => extractSellerFacts({ message: text }).facts?.rents?.value ?? null
const askOf = (text) => extractSellerFacts({ message: text }).facts?.asking_price?.value?.amount ?? null

// ── Rent vs asking price: the collision that reached underwriting ───────────

test('V2: "Rents are 7500 a month and I would sell for 900k" — no collision', () => {
  const text = "Rents are 7500 a month and I'd sell for 900k"
  assert.equal(rentsOf(text)?.monthly_gross_rent, 7500)
  assert.equal(askOf(text), 900_000)
})

test('V2 REGRESSION: an asking price never enters the rent roll', () => {
  // Before the classified-mention fix this produced reported_unit_rents
  // [1800, 250] — the asking price sitting inside the rent list.
  const rents = rentsOf("It's rented for 1800 and I want 250")
  const list = rents?.reported_unit_rents ?? []
  assert.ok(!list.includes(250), `asking price leaked into rents: ${JSON.stringify(list)}`)
})

test('V2 REGRESSION: a comma-grouped rent is never split into its tail', () => {
  // `\b\d{3,5}\b` matched the "400" inside "$1,400" because a comma is a word
  // boundary, so a $1,400 rent was recorded as $400.
  const rents = rentsOf("Yeah I own it. It's rented for $1,400 month-to-month and I'd take 220.")
  const list = rents?.reported_unit_rents ?? []
  assert.ok(!list.includes(400), `comma-split magnitude survived: ${JSON.stringify(list)}`)
  assert.ok(!list.includes(220), `asking price leaked into rents: ${JSON.stringify(list)}`)
})

test('V2: duplex with letter-labelled units yields both rents', () => {
  const rents = rentsOf('Unit A pays 1200, Unit B pays 1350. Both are month to month.')
  assert.deepEqual(rents?.reported_unit_rents, [1200, 1350])
})

test('V2: duplex aggregate is derivable from the enumerated rents', () => {
  const rents = rentsOf('Unit A pays 1200, Unit B pays 1350. Both are month to month.')
  const sum = (rents?.reported_unit_rents ?? []).reduce((a, b) => a + b, 0)
  assert.equal(sum, 2550)
})

// ── Projected vs current: the V2 invariant ─────────────────────────────────

test('V2 INVARIANT: projected rent never enters the current rent roll', () => {
  const text = 'The units should rent for $1,800 but right now they pay 1200'
  const list = rentsOf(text)?.reported_unit_rents ?? []
  assert.ok(!list.includes(1800), `projected rent entered current rents: ${JSON.stringify(list)}`)
})

test('V2: projected rent is captured separately, not discarded', () => {
  const p = extractProjectedRent('The units should rent for $1,800 but right now they pay 1200')
  assert.equal(p.projection_detected, true)
  assert.equal(p.seller_projected_rent, 1800)
  assert.equal(p.is_current_income, false)
})

test('V2: "you could raise rents $400" is upside, not income', () => {
  const p = extractProjectedRent('You could raise rents $400')
  assert.equal(p.projection_detected, true)
  assert.equal(p.is_current_income, false)
  assert.equal(rentsOf('You could raise rents $400'), null)
})

test('V2: "market rent" phrasing is a projection', () => {
  assert.equal(extractProjectedRent('Market rent is 1800 for these')?.projection_detected, true)
})

test('V2: plain present-tense reporting is NOT a projection', () => {
  // "rents for" / "pays" are current-state verbs. If these were treated as
  // projections the current rent roll would empty itself.
  assert.equal(extractProjectedRent('It rents for 1800'), null)
  assert.equal(extractProjectedRent('Unit A pays 1200'), null)
})

// ── Tenancy ────────────────────────────────────────────────────────────────

test('V2: month-to-month is recognised', () => {
  assert.equal(extractTenancy('Both are month to month.')?.tenancy_type, TENANCY_TYPES.MONTH_TO_MONTH)
})

test('V2: a fixed term with a date is recognised', () => {
  const t = extractTenancy('Lease expires 12/31/2026')
  assert.equal(t.tenancy_type, TENANCY_TYPES.FIXED_TERM)
  assert.equal(t.lease_end_date_text, '12/31/2026')
})

test('V2: MIXED tenancy is preserved, not flattened', () => {
  const t = extractTenancy('One tenant is month to month, the other lease ends in March.')
  assert.equal(t.tenancy_type, TENANCY_TYPES.MIXED)
  assert.equal(t.lease_end_month, 'mar')
})

test('V2: no tenancy language yields no tenancy fact', () => {
  assert.equal(extractTenancy('The roof is old'), null)
})

// ── Unit occupancy + mix ───────────────────────────────────────────────────

test('V2: "8 units, 7 occupied" derives vacancy rather than asserting it', () => {
  const o = extractUnitOccupancy("It's 8 units, 7 occupied.")
  assert.equal(o.total_units_reported, 8)
  assert.equal(o.occupied_units, 7)
  assert.equal(o.vacant_units_derived, 1)
  assert.equal(o.vacancy_rate_is_derived, true)
  assert.equal(o.vacancy_rate_derived, 0.125)
})

test('V2: unit mix is structured', () => {
  const m = extractUnitMix('Four 2/1s and four 1/1s.')
  assert.deepEqual(m.unit_mix, [
    { count: 4, beds: 2, baths: 1 },
    { count: 4, beds: 1, baths: 1 },
  ])
  assert.equal(m.unit_mix_total_units, 8)
})

test('V2: an inconsistent occupancy trio is flagged, not reconciled', () => {
  const o = extractUnitOccupancy('8 units, 7 occupied and 3 vacant')
  assert.equal(o.occupancy_conflict, true)
  assert.equal(o.vacancy_rate_derived, undefined)
})

test('V2: the 8-unit message yields units, occupancy and mix together', () => {
  const d = extractDiscoveryFacts("It's 8 units, 7 occupied. Four 2/1s and four 1/1s.")
  assert.equal(d.unit_occupancy.total_units_reported, 8)
  assert.equal(d.unit_occupancy.occupied_units, 7)
  assert.equal(d.unit_mix.unit_mix_total_units, 8)
})

// ── Rent disclosure posture ────────────────────────────────────────────────

test('V2 INVARIANT: a rent refusal never becomes "below market"', () => {
  const d = extractRentDisclosure("I'm not sharing the rents. Look it up.")
  assert.equal(d.rents_disclosed, false)
  assert.equal(d.rent_disclosure, 'refused')
  assert.equal(d.rents_below_market, null, 'inference must not become a seller fact')
  assert.equal(d.requires_independent_research, true)
})

test('V2: a refusal produces no rent figures', () => {
  assert.equal(rentsOf("I'm not sharing the rents. Look it up."), null)
})

// ── Rich multi-fact message ────────────────────────────────────────────────

test('V2: a rich reply yields ownership and occupancy without a corrupt rent roll', () => {
  const text = "Yeah I own it. It's rented for $1,400 month-to-month and I'd take 220."
  const f = extractSellerFacts({ message: text }).facts
  assert.equal(f.ownership?.value?.ownership_claim, 'confirmed')
  assert.equal(f.occupancy?.value?.occupancy_status, 'tenant_occupied')
  assert.equal(extractTenancy(text).tenancy_type, TENANCY_TYPES.MONTH_TO_MONTH)
  // The rent roll must be empty rather than wrong. Capturing 1,400 as a single
  // SF rent is a known open gap (see the V2 report); recording 400 is a defect.
  const list = f.rents?.value?.reported_unit_rents ?? []
  assert.ok(!list.includes(400) && !list.includes(220), JSON.stringify(list))
})

test('V2: occupancy is not confused with ownership', () => {
  const f = extractSellerFacts({ message: "It's rented out to a tenant" }).facts
  assert.equal(f.occupancy?.value?.occupancy_status, 'tenant_occupied')
  assert.equal(f.ownership?.value?.ownership_claim, undefined)
})
