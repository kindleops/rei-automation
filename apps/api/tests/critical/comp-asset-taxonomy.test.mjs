import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_CLASS,
  COMPATIBILITY,
  classifyAssetToken,
  compareAssetClasses,
  engineLaneFor,
  resolveAssetClass,
} from '@/lib/acquisition/assetTaxonomy.js'
import {
  evaluateCompEligibility,
  normalizePropertyFeatures,
} from '@/lib/acquisition/acquisitionDecisionEngine.js'

/**
 * COMPARABLE ASSET-TYPE RECONCILIATION.
 *
 * THE RIVERDALE DEFECT (property 237838109, 6710 Delta Dr, 2026-09-12).
 * A single-family subject reported "No usable comps — Asset type mismatch"
 * against single-family comps. `properties.normalized_asset_class` and
 * `properties.asset_class` are both NULL for that row, so the comp panel's
 * subject builder fell through to `property_class` = 'Residential' — a
 * CLASS-level vocabulary one semantic level above an asset TYPE. The type
 * normalizer had no pattern for it, answered 'other', and 'other' is compatible
 * with nothing.
 *
 * Two things had to be true for that to happen, and both are pinned here:
 *   * a class-level token must not end the search for an asset type, and
 *   * every single-family vocabulary must reach the same lane without any two
 *     raw strings being equal.
 */

// ── Single-family vocabulary ───────────────────────────────────────────────

test('TAXONOMY: every single-family vocabulary lands in one lane', () => {
  const vocabularies = [
    'single_family', 'single-family', 'Single Family', 'SINGLE FAMILY',
    'SFR', 'sfr', 'SFH', 'SFD',
    'Residential Single Family', 'Single Family Residential',
    '1 Family', 'One Family', '1-family',
    'Detached', 'Detached Single Family',
    'residential_1_unit', 'Residential 1 Unit', 'res 1 unit',
    'Single Unit',
  ]
  for (const raw of vocabularies) {
    assert.equal(
      classifyAssetToken(raw).class,
      ASSET_CLASS.SINGLE_FAMILY,
      `"${raw}" did not resolve to single_family`,
    )
  }
})

test('TAXONOMY: a single-family subject and an SFR comp are compatible', () => {
  const verdict = compareAssetClasses(
    resolveAssetClass({ property_type: 'single_family' }),
    resolveAssetClass({ property_type: 'SFR' }),
  )
  assert.equal(verdict.verdict, COMPATIBILITY.EXACT_MATCH)
})

// ── Class-level tokens are NOT an answer ───────────────────────────────────

test('TAXONOMY: "Residential" is indefinite, never a lane', () => {
  const verdict = classifyAssetToken('Residential')
  assert.equal(verdict.definite, false)
  assert.equal(verdict.class, ASSET_CLASS.UNKNOWN)
  assert.equal(verdict.reason, 'class_level_token_not_an_asset_type')
})

test('RIVERDALE: an indefinite field falls through to one that names an asset', () => {
  // The exact row shape. Both real columns NULL, property_class 'Residential',
  // property_type 'Single Family'.
  const resolved = resolveAssetClass({
    normalized_asset_class: null,
    asset_class: null,
    property_class: 'Residential',
    property_type: 'Single Family',
    units_count: 0,
  })
  assert.equal(resolved.class, ASSET_CLASS.SINGLE_FAMILY)
  assert.equal(resolved.definite, true)
  assert.equal(resolved.source_field, 'property_type')
})

test('RIVERDALE: "Residential" does not become single_family by invention', () => {
  // Falling through is right; GUESSING is not. With nothing else to go on the
  // answer must be unknown, because 'Residential' could be a house, a duplex or
  // a 40-unit building.
  const resolved = resolveAssetClass({ property_class: 'Residential' })
  assert.equal(resolved.class, ASSET_CLASS.UNKNOWN)
  assert.equal(resolved.definite, false)
})

test('RIVERDALE REGRESSION: the subject no longer rejects its own asset type', () => {
  const subject = normalizePropertyFeatures({
    property_id: '237838109',
    property_address_full: '6710 Delta Dr, Riverdale, Ga 30274',
    normalized_asset_class: null,
    asset_class: null,
    property_class: 'Residential',
    property_type: 'Single Family',
    units_count: 0,
    building_square_feet: 1102,
    latitude: 33.571605,
    longitude: -84.408271,
    property_address_zip: '30274',
  })
  assert.equal(subject.asset_type, 'single_family')
  assert.equal(subject.asset_family, 'residential')
  assert.equal(subject.asset_class, ASSET_CLASS.SINGLE_FAMILY)

  const comp = normalizePropertyFeatures({
    property_id: 'comp-1',
    property_type: 'Single Family',
    property_class: 'Residential',
    sale_price: 150_000,
    sale_date: '2026-05-01',
    building_square_feet: 1150,
    latitude: 33.5721,
    longitude: -84.4091,
    property_address_zip: '30274',
  })

  const eligibility = evaluateCompEligibility(subject, comp, new Date('2026-09-12T00:00:00Z'))
  assert.ok(
    !eligibility.reasons.includes('asset_type_mismatch'),
    `single family rejected single family: ${JSON.stringify(eligibility.reasons)}`,
  )
  assert.equal(eligibility.asset_compatibility.verdict, COMPATIBILITY.EXACT_MATCH)
})

test('RIVERDALE: the mismatch reason now names the field and the string', () => {
  // A bare 'asset_type_mismatch' is what made this undiagnosable. The verdict
  // has to carry the provenance of BOTH sides.
  const subject = normalizePropertyFeatures({ property_id: 's', property_class: 'Residential' })
  const comp = normalizePropertyFeatures({ property_id: 'c', property_type: 'Single Family' })
  const verdict = evaluateCompEligibility(subject, comp).asset_compatibility

  assert.equal(verdict.verdict, COMPATIBILITY.UNKNOWN_NEEDS_REVIEW)
  assert.equal(verdict.detail, 'subject_asset_class_unknown')
  assert.equal(verdict.subject_source_field, 'property_class')
  assert.equal(verdict.subject_source_value, 'Residential')
  assert.equal(verdict.comp_class, ASSET_CLASS.SINGLE_FAMILY)
})

// ── Genuine mismatches stay excluded ───────────────────────────────────────

test('TAXONOMY: single family against 8-unit multifamily is incompatible', () => {
  const verdict = compareAssetClasses(
    resolveAssetClass({ property_type: 'Single Family' }),
    resolveAssetClass({ property_type: 'Multi-Family', units_count: 8 }),
  )
  assert.equal(verdict.verdict, COMPATIBILITY.INCOMPATIBLE)
})

test('TAXONOMY: a true mismatch is still REJECTED by the gate', () => {
  const subject = normalizePropertyFeatures({
    property_id: 's', property_type: 'Single Family', units_count: 1,
    latitude: 33.57, longitude: -84.40, building_square_feet: 1100,
  })
  const comp = normalizePropertyFeatures({
    property_id: 'c', property_type: 'Apartment Building', units_count: 8,
    sale_price: 900_000, sale_date: '2026-06-01',
    latitude: 33.571, longitude: -84.401, building_square_feet: 7000,
  })
  const eligibility = evaluateCompEligibility(subject, comp, new Date('2026-09-12T00:00:00Z'))
  assert.ok(eligibility.reasons.includes('asset_type_mismatch'))
  assert.equal(eligibility.asset_compatibility.verdict, COMPATIBILITY.INCOMPATIBLE)
})

test('TAXONOMY: land never comps a house', () => {
  const verdict = compareAssetClasses(
    resolveAssetClass({ property_type: 'Single Family' }),
    resolveAssetClass({ property_type: 'Vacant Residential Land' }),
  )
  assert.equal(verdict.verdict, COMPATIBILITY.INCOMPATIBLE)
})

// ── Unknown is its own state ───────────────────────────────────────────────

test('TAXONOMY: unknown is reported as needing review, not asserted incompatible', () => {
  const verdict = compareAssetClasses(
    resolveAssetClass({ property_type: 'Single Family' }),
    resolveAssetClass({ property_type: 'Zzz Unclassified' }),
  )
  assert.equal(verdict.verdict, COMPATIBILITY.UNKNOWN_NEEDS_REVIEW)
  assert.equal(verdict.detail, 'comp_asset_class_unknown')
})

test('TAXONOMY: two unknowns are not silently an exact match', () => {
  const verdict = compareAssetClasses(resolveAssetClass({}), resolveAssetClass({}))
  assert.equal(verdict.verdict, COMPATIBILITY.UNKNOWN_NEEDS_REVIEW)
  assert.equal(verdict.detail, 'both_sides_unknown')
})

// ── Unit count governs the residential lanes ───────────────────────────────

test('TAXONOMY: unit count splits 2-4 from 5-plus regardless of the label', () => {
  assert.equal(resolveAssetClass({ property_type: 'Multi-Family', units_count: 2 }).class, ASSET_CLASS.RESIDENTIAL_2_TO_4)
  assert.equal(resolveAssetClass({ property_type: 'Multi-Family', units_count: 4 }).class, ASSET_CLASS.RESIDENTIAL_2_TO_4)
  assert.equal(resolveAssetClass({ property_type: 'Multi-Family', units_count: 5 }).class, ASSET_CLASS.MULTIFAMILY_5_PLUS)
  // A bare "Multifamily" with no unit count is the 5-plus lane, which is the
  // pre-existing behaviour 2-4 identity work already depends on.
  assert.equal(resolveAssetClass({ property_type: 'Multifamily' }).class, ASSET_CLASS.MULTIFAMILY_5_PLUS)
})

test('TAXONOMY: a "Single Family" row with 3 units is a 2-4, not a house', () => {
  assert.equal(
    resolveAssetClass({ property_type: 'Single Family', units_count: 3 }).class,
    ASSET_CLASS.RESIDENTIAL_2_TO_4,
  )
})

test('TAXONOMY: unit count never overrides land, storage or commercial', () => {
  assert.equal(resolveAssetClass({ property_type: 'Vacant Land', units_count: 6 }).class, ASSET_CLASS.LAND)
  assert.equal(resolveAssetClass({ property_type: 'Self Storage', units_count: 200 }).class, ASSET_CLASS.STORAGE)
  assert.equal(resolveAssetClass({ property_type: 'Office', units_count: 12 }).class, ASSET_CLASS.COMMERCIAL)
})

// ── Engine lane translation preserves existing behaviour ───────────────────

test('TAXONOMY: canonical classes map onto the engine lanes unchanged', () => {
  assert.equal(engineLaneFor(ASSET_CLASS.SINGLE_FAMILY), 'single_family')
  assert.equal(engineLaneFor(ASSET_CLASS.RESIDENTIAL_2_TO_4), 'multifamily')
  assert.equal(engineLaneFor(ASSET_CLASS.MULTIFAMILY_5_PLUS), 'multifamily')
  assert.equal(engineLaneFor(ASSET_CLASS.STORAGE), 'storage')
  assert.equal(engineLaneFor(ASSET_CLASS.UNKNOWN), 'other')
})

test('TELEMETRY: eligibility always carries an asset verdict, eligible or not', () => {
  const subject = normalizePropertyFeatures({ property_id: 's', property_type: 'Single Family' })
  const comp = normalizePropertyFeatures({
    property_id: 'c', property_type: 'Single Family', sale_price: 5_000,
  })
  const eligibility = evaluateCompEligibility(subject, comp)
  assert.ok(eligibility.reasons.includes('invalid_sale_price'))
  assert.equal(eligibility.asset_compatibility.verdict, COMPATIBILITY.EXACT_MATCH)
})
