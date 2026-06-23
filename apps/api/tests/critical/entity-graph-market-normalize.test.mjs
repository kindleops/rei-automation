import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveEntityGraphMarket,
  formatPropertySummary,
  formatContactMethodPresentation,
  computeContactCoverage,
  clampCoveragePct,
} from '@/lib/domain/entity-graph/entity-graph-normalize.js'

test('Tulsa, OK stays Tulsa — not Dallas', () => {
  const result = resolveEntityGraphMarket({ market: 'Tulsa, OK' })
  assert.equal(result.displayMarket, 'Tulsa, OK')
  assert.equal(result.isUnmapped, false)
})

test('Dallas, TX remains Dallas', () => {
  const result = resolveEntityGraphMarket({ market: 'Dallas, TX' })
  assert.equal(result.displayMarket, 'Dallas, TX')
  assert.equal(result.isUnmapped, false)
})

test('San Antonio, TX stays San Antonio — not Dallas', () => {
  const result = resolveEntityGraphMarket({ market: 'San Antonio, TX' })
  assert.equal(result.displayMarket, 'San Antonio, TX')
  assert.equal(result.isUnmapped, false)
})

test('Sacramento, CA stays Sacramento — not Los Angeles', () => {
  const result = resolveEntityGraphMarket({ market: 'Sacramento, CA' })
  assert.equal(result.displayMarket, 'Sacramento, CA')
  assert.equal(result.isUnmapped, false)
})

test('Los Angeles, CA remains Los Angeles', () => {
  const result = resolveEntityGraphMarket({ market: 'Los Angeles, CA' })
  assert.equal(result.displayMarket, 'Los Angeles, CA')
})

test('Columbus, OH stays Columbus — not Jacksonville', () => {
  const result = resolveEntityGraphMarket({ market: 'Columbus, OH' })
  assert.equal(result.displayMarket, 'Columbus, OH')
  assert.equal(result.isUnmapped, false)
})

test('Jacksonville, FL remains Jacksonville', () => {
  const result = resolveEntityGraphMarket({ market: 'Jacksonville, FL' })
  assert.equal(result.displayMarket, 'Jacksonville, FL')
})

test('Saint Paul maps to Minneapolis via explicit alias', () => {
  const result = resolveEntityGraphMarket({ market: 'St. Paul, MN' })
  assert.equal(result.displayMarket, 'Minneapolis, MN')
  assert.equal(result.isUnmapped, false)
})

test('Rochester, NY stays as verified metro', () => {
  const result = resolveEntityGraphMarket({ market: 'Rochester, NY' })
  assert.equal(result.displayMarket, 'Rochester, NY')
})

test('Providence, RI stays as verified metro', () => {
  const result = resolveEntityGraphMarket({ market: 'Providence, RI' })
  assert.equal(result.displayMarket, 'Providence, RI')
})

test('unknown locality becomes Unmapped label', () => {
  const result = resolveEntityGraphMarket({ market: 'Smalltown', city: 'Smalltown', state: 'TX' })
  assert.match(result.displayMarket, /^Unmapped · Smalltown, TX$/)
  assert.equal(result.isUnmapped, true)
})

test('trusted market_region wins over raw market', () => {
  const result = resolveEntityGraphMarket({ market: 'Tulsa, OK', marketRegion: 'Tulsa, OK' })
  assert.equal(result.displayMarket, 'Tulsa, OK')
})

test('property summary never renders leading comma address', () => {
  const summary = formatPropertySummary({
    property_address_full: ', Ok',
    property_address_city: 'Tulsa',
    property_address_state: 'OK',
    property_address_zip: '74104',
    normalized_asset_class: 'SFR',
    units_count: 0,
    market: 'Tulsa, OK',
  })
  assert.equal(summary.title, 'Address incomplete')
  assert.equal(summary.subtitle, 'Tulsa, OK, 74104')
  assert.equal(summary.units, undefined)
  assert.equal(summary.assetType, 'SFR')
})

test('Columbus, OH property is not mapped to Tampa when market_region is wrong', () => {
  const result = resolveEntityGraphMarket({
    market: 'Columbus, OH',
    marketRegion: 'Tampa, FL',
    city: 'Columbus',
    state: 'OH',
  })
  assert.match(result.displayMarket, /Unmapped · Columbus, OH|Columbus, OH/)
  assert.notEqual(result.displayMarket, 'Tampa, FL')
})

test('Tampa, FL property stays Tampa', () => {
  const result = resolveEntityGraphMarket({
    market: 'Tampa, FL',
    marketRegion: 'Tampa, FL',
    city: 'Tampa',
    state: 'FL',
  })
  assert.equal(result.displayMarket, 'Tampa, FL')
})

test('Durham, NC is not mapped to Charlotte when market_region is wrong', () => {
  const result = resolveEntityGraphMarket({
    market: 'Durham, NC',
    marketRegion: 'Charlotte, NC',
    city: 'Durham',
    state: 'NC',
  })
  assert.match(result.displayMarket, /Unmapped · Durham, NC|Durham, NC/)
  assert.notEqual(result.displayMarket, 'Charlotte, NC')
})

test('Charlotte, NC property stays Charlotte', () => {
  const result = resolveEntityGraphMarket({
    market: 'Charlotte, NC',
    marketRegion: 'Charlotte, NC',
    city: 'Charlotte',
    state: 'NC',
  })
  assert.equal(result.displayMarket, 'Charlotte, NC')
})

test('contact coverage returns null with no linked people', () => {
  assert.equal(computeContactCoverage({ linkedPeople: 0, reachablePeople: 0 }), null)
})

test('contact coverage for one reachable person', () => {
  assert.equal(computeContactCoverage({ linkedPeople: 1, reachablePeople: 1 }), 100)
})

test('contact coverage for partial reachability', () => {
  assert.equal(computeContactCoverage({ linkedPeople: 4, reachablePeople: 2 }), 50)
})

test('contact coverage never exceeds 100%', () => {
  assert.equal(clampCoveragePct(700), 100)
  assert.equal(computeContactCoverage({ linkedPeople: 1, reachablePeople: 7 }), 100)
})

test('contact method presentation humanizes phone type and eligibility', () => {
  const presentation = formatContactMethodPresentation({
    phone_type: 'W',
    canonical_e164: '+19185551212',
    contact_score_final: 80,
    wrong_number_at: null,
  }, 'phone')
  assert.equal(presentation.phoneType, 'Wireless')
  assert.equal(presentation.eligibility, 'Eligible')
  assert.equal(presentation.reachability, 'Reachable')
  assert.match(presentation.displayValue, /918/)
})