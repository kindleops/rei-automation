import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyDefensive,
  classifyFromV3,
  type CandidateSignals,
  type ClassifyContext,
} from '../../src/views/comp-intelligence-v4/adapters/qualification'
import { adaptProjection } from '../../src/views/comp-intelligence-v4/adapters/projectionAdapter'

const SFR_SUBJECT: ClassifyContext['subject'] = {
  assetLane: 'single_family',
  units: 1,
  providerEstimate: 156000,
  isSingleAsset: true,
}
const ctx = (peerMedianSale: number | null = 117154): ClassifyContext => ({
  subject: SFR_SUBJECT,
  peerMedianSale,
})

function sig(over: Partial<CandidateSignals>): CandidateSignals {
  return {
    assetClass: 'single_family',
    propertyType: 'Single Family',
    propertySubtype: 'Single Family',
    units: 1,
    salePrice: 250000,
    sqft: 1400,
    beds: 3,
    baths: 2,
    yearBuilt: 1980,
    ppsf: 178,
    isUnitAddress: false,
    pricingEligible: null,
    demandEligible: null,
    packageProbability: null,
    parcelCount: null,
    essContribution: null,
    routedUniverse: null,
    evidenceRole: null,
    ...over,
  }
}

// ── 1) The $27.4M 109-unit apartment must NOT be a qualified SFR comp ──────
test('109-unit $27.4M apartment is excluded as wrong asset class, never qualified', () => {
  const r = classifyDefensive(
    sig({ assetClass: 'apartment', propertyType: 'Apartment', units: 109, salePrice: 27398000, sqft: 136724 }),
    ctx(),
  )
  assert.equal(r.state, 'excluded')
  assert.notEqual(r.state, 'qualified')
  assert.match(r.basis.reason, /asset class/i)
  assert.equal(r.basis.assetLaneCompatible, false)
})

// ── 3) Missing physical info cannot silently become strong SFR pricing ─────
test('priced SFR with missing square footage routes to review, not qualified', () => {
  const r = classifyDefensive(sig({ sqft: null, salePrice: 200000 }), ctx())
  assert.equal(r.state, 'review')
  assert.notEqual(r.state, 'qualified')
})

// ── 4) Unit-number address triggers subtype review ────────────────────────
test('unit-number address triggers subtype/parcel review', () => {
  const r = classifyDefensive(
    sig({ isUnitAddress: true, salePrice: 117154, sqft: 1232 }),
    ctx(),
  )
  assert.equal(r.state, 'review')
  assert.match(r.basis.reason, /unit-number/i)
})

// ── No sale price → demand only ───────────────────────────────────────────
test('zero sale price routes to demand_only, never pricing', () => {
  const r = classifyDefensive(sig({ salePrice: 0 }), ctx())
  assert.equal(r.state, 'demand_only')
  assert.equal(r.basis.pricingEligible, false)
})

// ── Extreme price outlier excluded even for compatible asset ──────────────
test('extreme price outlier (>=10x anchors) is excluded', () => {
  const r = classifyDefensive(sig({ salePrice: 5_000_000, units: 1, assetClass: 'single_family' }), ctx(120000))
  assert.equal(r.state, 'excluded')
  assert.equal(r.basis.outlierStatus, 'extreme')
})

// ── 10) Frontend defensive classifier can NEVER output qualified ──────────
test('defensive classifier never promotes to qualified across many inputs', () => {
  const samples: Partial<CandidateSignals>[] = [
    {},
    { salePrice: 150000 },
    { salePrice: 150000, sqft: 1400, beds: 3, baths: 2, isUnitAddress: false },
    { salePrice: 100000, units: 2 },
    { assetClass: 'condo', salePrice: 130000 },
  ]
  for (const s of samples) {
    const r = classifyDefensive(sig(s), ctx())
    assert.notEqual(r.state, 'qualified', `unexpected qualified for ${JSON.stringify(s)}`)
    assert.equal(r.basis.authority, 'frontend_defensive')
  }
})

// ── 5) "Loose comp" notion cannot be qualified — best non-flagged is candidate
test('a clean compatible priced SFR is at most a candidate (not qualified) without V3', () => {
  const r = classifyDefensive(sig({ salePrice: 150000, sqft: 1400, isUnitAddress: false }), ctx())
  assert.equal(r.state, 'candidate')
})

// ── canonical V3 path is the ONLY producer of qualified ───────────────────
test('canonical V3 ACCEPTED + pricing-eligible single-asset → qualified', () => {
  const r = classifyFromV3(
    sig({ pricingEligible: true, packageProbability: 0, parcelCount: 1 }),
    'ACCEPTED',
  )
  assert.equal(r.state, 'qualified')
  assert.equal(r.basis.authority, 'canonical_v3')
})

test('canonical V3 ACCEPTED + pricing-eligible but package contamination → review (safety net)', () => {
  const r = classifyFromV3(sig({ pricingEligible: true, packageProbability: 0.8 }), 'ACCEPTED')
  assert.equal(r.state, 'review')
})

test('canonical V3 REJECTED → excluded; demand-eligible-only → demand_only', () => {
  assert.equal(classifyFromV3(sig({}), 'REJECTED').state, 'excluded')
  assert.equal(
    classifyFromV3(sig({ pricingEligible: false, demandEligible: true }), 'ACCEPTED').state,
    'demand_only',
  )
})

// ── 11) V3 unavailable does NOT mean every candidate is qualified ─────────
// ── 2,6,7,8,9) End-to-end Houston projection integrity ───────────────────
function houstonPayload() {
  const cand = (over: Record<string, unknown>, raw: Record<string, unknown>) => ({
    comp_property_id: String(raw.property_id ?? Math.random()),
    address: over.address,
    latitude: over.latitude,
    longitude: over.longitude,
    distance_miles: over.distance_miles,
    sold_source: 'PUBLIC RECORD SOLD',
    raw: { property_type: 'Single Family', asset_class: 'single_family', units_count: 1, ...raw },
    ...over,
  })
  return {
    subject: {
      property_id: '2130847744',
      canonical_address: '6310 Cambridge Glen Ln, Houston, TX 77035',
      asset_type: 'single_family',
      units: 1,
      bedrooms: 2,
      bathrooms: 1,
      square_feet: 1356,
      year_built: 1979,
      estimated_value: 156000,
      latitude: 29.65086,
      longitude: -95.50109,
      is_subject_resolved: true,
      coordinate_source: 'subject_property',
    },
    transaction_evidence: [],
    decision_projection: { execution_state: 'V3_DISABLED', v3_enabled: false },
    discovery: {
      search_mode: 'subject_radius',
      candidates: [
        cand(
          { address: '11963 Bob White Dr # 18-853, Houston, TX 77035', latitude: 29.649, longitude: -95.4993, distance_miles: 0.16 },
          { property_id: 'c1', sale_price: 117154, sqft: 1232, beds: 2, baths: 2, year_built: 1983, ppsf: 95 },
        ),
        cand(
          { address: '12247 Sunset Meadow Ln # 109, Houston, TX 77035', latitude: 29.6447, longitude: -95.5035, distance_miles: 0.45 },
          { property_id: 'c2', asset_class: 'apartment', property_type: 'Apartment', units_count: 109, sale_price: 27398000, sqft: 136724, year_built: 1980 },
        ),
        cand(
          { address: '12111 Bob White Dr, Houston, TX 77035', latitude: 29.65, longitude: -95.5, distance_miles: 0.31 },
          { property_id: 'c3', sale_price: 0, sqft: 1663, beds: 3, baths: 2.5, year_built: 1979 },
        ),
        cand(
          { address: '6437 Chatham Island Ln, Houston, TX 77035', latitude: 29.651, longitude: -95.501, distance_miles: 0.29 },
          { property_id: 'c4', sale_price: 0, sqft: 1838, beds: 4, baths: 2.5, year_built: 1983 },
        ),
      ],
    },
  }
}

test('Houston end-to-end: zero qualified, apartment excluded, $0 SFRs demand-only', () => {
  const m = adaptProjection(houstonPayload() as Record<string, unknown>, {
    propertyId: '2130847744',
    radiusMiles: 1,
    monthsBack: 6,
  })

  // 11) V3 unavailable does not auto-qualify anything.
  assert.equal(m.summary.qualified, 0)
  assert.equal(m.summary.hasQualified, false)

  // 9) No qualified → no manufactured median/range.
  assert.equal(m.summary.qualifiedMedianSale, null)
  assert.equal(m.summary.qualifiedSaleLow, null)
  assert.equal(m.summary.qualifiedSaleHigh, null)

  // 8) Demand-only / excluded never contribute to qualified ESS.
  assert.equal(m.summary.qualifiedEss, null)

  // 2,7) The $27.4M apartment is excluded and is the largest excluded txn,
  // and it cannot appear in qualified stats.
  const apartment = m.evidence.find((e) => e.address?.includes('Sunset Meadow'))
  assert.ok(apartment)
  assert.equal(apartment!.state, 'excluded')
  assert.equal(m.summary.largestExcludedSale, 27398000)

  // unit-number condo → review; $0 SFRs → demand_only
  const condo = m.evidence.find((e) => e.address?.includes('Bob White Dr # 18-853'))
  assert.equal(condo!.state, 'review')
  const zeroPriceSfrs = m.evidence.filter((e) => e.state === 'demand_only')
  assert.equal(zeroPriceSfrs.length, 2)

  // 6) Single source of truth: state counts equal summary counts.
  const counted = { qualified: 0, candidate: 0, review: 0, demand_only: 0, excluded: 0 }
  for (const e of m.evidence) counted[e.state] += 1
  assert.equal(counted.qualified, m.summary.qualified)
  assert.equal(counted.review, m.summary.review)
  assert.equal(counted.excluded, m.summary.excluded)
  assert.equal(counted.demand_only, m.summary.demandOnly)
})

test('physical facts are read from raw.* (no silent "unavailable")', () => {
  const m = adaptProjection(houstonPayload() as Record<string, unknown>, {
    propertyId: '2130847744',
    radiusMiles: 1,
    monthsBack: 6,
  })
  const condo = m.evidence.find((e) => e.address?.includes('Bob White Dr # 18-853'))
  assert.equal(condo!.beds, 2)
  assert.equal(condo!.baths, 2)
  assert.equal(condo!.buildingSqft, 1232)
})
