import test from 'node:test'
import assert from 'node:assert/strict'

import { filterAndSortBuyers, countBuyers, filterPurchaseEvents } from '../../src/modules/inbox/buyer-match-v4/buyerFilters'
import { buildBuyerDossier } from '../../src/modules/inbox/buyer-match-v4/buildBuyerDossier'
import { INITIAL_FILTER_STATE, DIRECTORY_MODE_OPTIONS } from '../../src/modules/inbox/buyer-match-v4/buyer-match-v4.types'
import type { PurchaseEvent, RankedBuyer } from '../../src/modules/inbox/buyer-match-v4/buyer-match-v4.types'

const activity = {
  unique30d: 1,
  unique60d: 2,
  unique90d: 3,
  unique180d: 4,
  unique365d: 5,
  lifetime: 6,
  events30d: 1,
  events60d: 2,
  events90d: 3,
  events180d: 4,
  events365d: 5,
  lifetimeEvents: 6,
  packageAssets30d: 0,
  packageAssetsLifetime: 2,
  singleAssetPct: 80,
  packagePct: 20,
  localZipPurchases: 2,
  radiusPurchases: 3,
  nearestPurchaseMiles: 0.4,
  mostRecentPurchase: '2026-02-01',
  medianQualifiedPrice: 310000,
  qualifiedPriceLow: 280000,
  qualifiedPriceHigh: 340000,
}

const localBuyer: RankedBuyer = {
  buyerId: 'local-1',
  buyerFamilyId: 'local-1',
  buyerName: 'Local Investor LLC',
  entityType: 'corporate',
  buyerArchetype: 'LOCAL_INVESTOR',
  buyerClass: 'LOCAL_INVESTOR',
  institutionalStatus: null,
  eligibleDispositionBuyer: true,
  matchScore: 85,
  matchGrade: 'A',
  matchConfidence: 0.8,
  reasonSummary: ['3 purchases in this ZIP'],
  likelyBidLow: 280000,
  likelyBidBase: 310000,
  likelyBidHigh: 335000,
  purchases30d: 1,
  purchases60d: 2,
  purchases90d: 3,
  purchases180d: 4,
  purchases365d: 5,
  lifetimePurchases: 6,
  lastPurchaseAt: '2026-02-01',
  nearestPurchaseMiles: 0.4,
  contactReadiness: 'ENRICHMENT_REQUIRED',
  activity,
}

const instBuyer: RankedBuyer = {
  ...localBuyer,
  buyerId: 'inst-1',
  buyerFamilyId: 'inst-1',
  buyerName: 'Invitation Homes',
  buyerClass: 'INSTITUTIONAL_OPERATOR',
  institutionalStatus: 'VERIFIED_INSTITUTIONAL',
  institutionalSubtype: 'SFR_OPERATOR',
  matchScore: 92,
  matchGrade: 'A+',
}

const events: PurchaseEvent[] = [
  {
    eventId: 'e1',
    buyerId: 'local-1',
    buyerFamilyId: 'local-1',
    address: '123 Main',
    latitude: 29.82,
    longitude: -95.41,
    purchaseDate: '2026-02-01',
    purchasePrice: 310000,
    propertyAllocatedConsideration: 310000,
    assetLane: 'single_family',
    distanceMiles: 0.4,
    source: null,
    sourceLabel: 'Verified purchase record',
    transactionScope: 'SINGLE_ASSET',
    pricingEligible: true,
    demandEligible: true,
    demandEligibility: 'DISPOSITION_BUYER',
    buyerClass: 'LOCAL_INVESTOR',
  },
  {
    eventId: 'e2',
    buyerId: 'inst-1',
    buyerFamilyId: 'inst-1',
    address: 'Package row',
    latitude: 29.83,
    longitude: -95.42,
    purchaseDate: '2026-01-15',
    purchasePrice: null,
    totalConsideration: 4000000,
    assetLane: 'single_family',
    distanceMiles: 0.6,
    source: null,
    sourceLabel: 'Public-record acquisition',
    transactionScope: 'MULTI_ASSET_PACKAGE',
    packageAssetCount: 12,
    pricingEligible: false,
    demandEligible: true,
    demandEligibility: 'PACKAGE_UNRESOLVED',
    buyerClass: 'INSTITUTIONAL_OPERATOR',
  },
]

test('default filter mode is best_match', () => {
  assert.equal(INITIAL_FILTER_STATE.directoryMode, 'best_match')
  assert.ok(DIRECTORY_MODE_OPTIONS.some((o) => o.key === 'best_match'))
})

test('institutional count excludes corporate-only buyers', () => {
  const counts = countBuyers([localBuyer, instBuyer])
  assert.equal(counts.institutional, 1)
  assert.equal(counts.localRegional, 1)
})

test('institutional directory mode filters correctly', () => {
  const filtered = filterAndSortBuyers([localBuyer, instBuyer], {
    ...INITIAL_FILTER_STATE,
    directoryMode: 'institutional',
  })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].buyerId, 'inst-1')
})

test('card and dossier purchase counts match via activity projection', () => {
  const dossier = buildBuyerDossier(localBuyer, events)
  assert.equal(dossier.purchaseStats.count30, localBuyer.purchases30d)
  assert.equal(dossier.purchaseStats.count180, localBuyer.purchases180d)
  assert.equal(dossier.purchaseStats.lifetime, localBuyer.lifetimePurchases)
})

test('package events filter separately from single asset', () => {
  const single = filterPurchaseEvents(events, { periodDays: 0, singleAssetOnly: true })
  const pkg = filterPurchaseEvents(events, { periodDays: 0, packageOnly: true })
  assert.equal(single.length, 1)
  assert.equal(pkg.length, 1)
  assert.equal(pkg[0].transactionScope, 'MULTI_ASSET_PACKAGE')
})

test('no raw source table names in event labels', () => {
  for (const e of events) {
    assert.ok(!e.sourceLabel?.includes('buyer_purchase_events'))
    assert.ok(!e.sourceLabel?.includes('_v2'))
  }
})

test('bid range on buyer is ordered', () => {
  assert.ok((localBuyer.likelyBidLow ?? 0) <= (localBuyer.likelyBidBase ?? 0))
  assert.ok((localBuyer.likelyBidBase ?? 0) <= (localBuyer.likelyBidHigh ?? 0))
})