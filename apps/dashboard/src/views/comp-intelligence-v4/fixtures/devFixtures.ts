/**
 * Comp Intelligence V4 — DEV-ONLY fixtures.
 *
 * Exercise isolated visual states that are hard to trigger live (no-coordinate
 * subject, zero qualified comps). NEVER imported by the live data path and never
 * silently replaces a real projection.
 */

import type { QualificationBasis, V4Model, V4Subject } from '../state/types'

const BASIS: QualificationBasis = {
  reason: 'Preliminary candidate — canonical qualification unavailable',
  authority: 'frontend_defensive',
  pricingEligible: null,
  singleAssetEligible: null,
  assetLaneCompatible: true,
  evidenceUniverse: null,
  evidenceRole: null,
  packageStatus: null,
  outlierStatus: 'within_band',
  physicalCompleteness: 0.8,
  essContribution: null,
}

const BASE_SUBJECT: V4Subject = {
  propertyId: 'fixture-subject',
  opportunityId: null,
  threadKey: null,
  masterOwnerId: null,
  address: '8734 W Vale Dr, Phoenix, AZ 85037',
  coord: { lat: 33.4942, lng: -112.2543 },
  hasCoord: true,
  coordSource: 'fixture',
  coordConfidence: 1,
  isResolved: true,
  isMarketFallback: false,
  coordFailureReason: null,
  assetLane: 'single_family',
  assetLaneLabel: 'Single Family',
  propertySubtype: 'Single Family',
  units: 1,
  beds: 3,
  baths: 2,
  buildingSqft: 1540,
  lotSqft: 7200,
  lotAcreage: null,
  yearBuilt: 1994,
  condition: 'Average',
  constructionType: 'Frame',
  zoning: null,
  imageUrl: null,
  providerEstimate: 312000,
  taxAssessedValue: 268000,
  lastSalePrice: 240000,
  lastSaleDate: '2019-05-01',
  ownerName: null,
  ownerType: null,
  dataFreshness: '2026-06-01',
}

const EMPTY_SUMMARY: V4Model['summary'] = {
  discovered: 0,
  candidate: 0,
  qualified: 0,
  review: 0,
  excluded: 0,
  demandOnly: 0,
  hasQualified: false,
  qualifiedMedianSale: null,
  qualifiedSaleLow: null,
  qualifiedSaleHigh: null,
  qualifiedMedianPpsf: null,
  qualifiedEss: null,
  closestQualifiedMiles: null,
  newestQualifiedDate: null,
  discoveredSaleLow: null,
  discoveredSaleHigh: null,
  largestExcludedSale: null,
  largestExcludedReason: null,
}

const UNAVAILABLE_DECISION: V4Model['decision'] = {
  available: false,
  v3Enabled: false,
  assetLaneLabel: 'Single Family',
  executionLabel: 'Comp Research Mode',
  valueClassificationLabel: null,
  qualifiedMarketValue: null,
  conservativeBuyerExit: null,
  recommendedShadowOffer: null,
  primaryStrategyLabel: null,
  confidence: null,
  qualifiedEvidenceCount: 0,
  largestBlocker: null,
  unavailableNote:
    'Official underwriting is temporarily unavailable. Comp research remains available.',
}

export const FIXTURE_NO_COORD: V4Model = {
  subject: { ...BASE_SUBJECT, coord: null, hasCoord: false, coordFailureReason: 'geocode_failed' },
  evidence: [],
  summary: EMPTY_SUMMARY,
  decision: UNAVAILABLE_DECISION,
  search: { radiusMiles: 1, monthsBack: 6, searchMode: 'fixture', isMarketFallback: false },
  meta: { readOnly: true, queryMs: 0, source: 'fixture' },
}

export const FIXTURE_NO_QUALIFIED: V4Model = {
  subject: BASE_SUBJECT,
  evidence: [
    {
      id: 'fx-rev-1',
      propertyId: 'fx-rev-1',
      state: 'review',
      rawStatus: 'REVIEW',
      imageUrl: null,
      address: '8810 W Vale Dr # 4, Phoenix, AZ 85037',
      city: 'Phoenix',
      state_region: 'AZ',
      zip: '85037',
      coord: { lat: 33.495, lng: -112.256 },
      distanceMiles: 0.4,
      salePrice: 305000,
      saleDate: '2026-04-12',
      ppsf: 194,
      ppu: null,
      sourceKind: 'public_record',
      sourceLabel: 'Public records',
      transactionBadges: [{ label: 'Public records', tone: 'neutral' }],
      assetLane: 'single_family',
      propertySubtype: 'Single Family',
      propertyType: 'Single Family',
      units: 1,
      beds: 3,
      baths: 2,
      buildingSqft: 1572,
      lotSqft: 6900,
      yearBuilt: 1996,
      condition: 'Average',
      constructionType: 'Frame',
      providerEstimate: null,
      isUnitAddress: true,
      buyerName: null,
      buyerEntityType: null,
      buyerArchetype: null,
      matchScore: 0.62,
      matchTier: 'close',
      matchLabel: null,
      reasons: ['Unit-number address — subtype & parcel review'],
      basis: { ...BASIS, reason: 'Unit-number address — subtype & parcel review' },
      dataFreshness: '2026-04-12',
    },
  ],
  summary: { ...EMPTY_SUMMARY, discovered: 1, review: 1 },
  decision: UNAVAILABLE_DECISION,
  search: { radiusMiles: 1, monthsBack: 6, searchMode: 'fixture', isMarketFallback: false },
  meta: { readOnly: true, queryMs: 0, source: 'fixture' },
}

export const DEV_FIXTURES: Record<string, V4Model> = {
  'no-coord': FIXTURE_NO_COORD,
  'no-qualified': FIXTURE_NO_QUALIFIED,
}
