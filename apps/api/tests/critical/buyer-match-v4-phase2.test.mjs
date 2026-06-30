import test from 'node:test';
import assert from 'node:assert/strict';
import { mapBuyerClass, classifyDemandEligibility, buildBuyerFamilyProjections } from '../../src/lib/intel/buyer-match-v4-identity.js';
import {
  dedupePurchaseRows,
  annotatePackageClusters,
  buildCanonicalPurchaseEvents,
  labelPurchaseSource,
} from '../../src/lib/intel/buyer-match-v4-transactions.js';
import {
  computeActivityWindows,
  enforceMonotonicity,
  repairBidRange,
  familyToRankedBuyer,
} from '../../src/lib/intel/buyer-match-v4-aggregations.js';
import { BUYER_ARCHETYPES } from '../../src/lib/acquisition/buyerIdentityResolution.js';

test('government grantee is not disposition eligible', () => {
  const cls = mapBuyerClass({
    archetype: BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT,
    candidate: { buyer_name: 'Secretary of Veterans Affairs' },
  });
  assert.equal(cls.buyerClass, 'GOVERNMENT_AGENCY');
  assert.equal(cls.eligibleDispositionBuyer, false);
});

test('lender grantee is classified and excluded from disposition', () => {
  const cls = mapBuyerClass({
    archetype: BUYER_ARCHETYPES.UNKNOWN,
    candidate: { buyer_name: 'Wells Fargo Bank NA' },
  });
  assert.equal(cls.buyerClass, 'LENDER_OR_SERVICER');
  assert.equal(cls.eligibleDispositionBuyer, false);
});

test('verified institutional requires type or pattern evidence', () => {
  const cls = mapBuyerClass({
    archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR,
    candidate: { buyer_type: 'institutional', institutional_score: 85, buyer_name: 'Acme LLC' },
  });
  assert.equal(cls.buyerClass, 'INSTITUTIONAL_OPERATOR');
  assert.equal(cls.eligibleDispositionBuyer, true);
});

test('corporate buyer alone is not institutional', () => {
  const cls = mapBuyerClass({
    archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR,
    candidate: { is_corporate_buyer: true, buyer_name: 'Local Homes LLC', purchase_count: 3 },
    entity: { purchase_count: 3, markets_active: 1 },
  });
  assert.equal(cls.buyerClass, 'LOCAL_INVESTOR');
});

test('buyer families group on buyer_key only', () => {
  const families = buildBuyerFamilyProjections([
    { buyer_key: 'k1', buyer_entity_id: 'e1', buyer_name: 'Alpha LLC', total_match_score: 90, match_grade: 'A' },
    { buyer_key: 'k1', buyer_entity_id: 'e2', buyer_name: 'Alpha Holdings LLC', total_match_score: 70, match_grade: 'B' },
    { buyer_key: 'k2', buyer_entity_id: 'e3', buyer_name: 'Beta LLC', total_match_score: 60, match_grade: 'B' },
  ]);
  assert.equal(families.length, 2);
  const alpha = families.find((f) => f.buyerFamilyId === 'k1');
  assert.equal(alpha.legalEntities.length, 2);
});

test('package purchase is not pricing eligible', () => {
  const rows = annotatePackageClusters([
    { id: '1', buyer_key: 'b1', buyer_name: 'Fund LLC', purchase_date: '2026-01-01', purchase_price: 4000000, property_address_full: '1 A St', comp_property_id: 'p1' },
    { id: '2', buyer_key: 'b1', buyer_name: 'Fund LLC', purchase_date: '2026-01-01', purchase_price: 4000000, property_address_full: '2 B St', comp_property_id: 'p2', property_zip: '77002' },
    { id: '3', buyer_key: 'b1', buyer_name: 'Fund LLC', purchase_date: '2026-01-01', purchase_price: 4000000, property_address_full: '3 C St', comp_property_id: 'p3', property_zip: '77003' },
  ]);
  const pkg = rows.find((r) => r._isPackage);
  assert.ok(pkg);
  const events = buildCanonicalPurchaseEvents(rows, { lat: 29.8, lng: -95.4, zip: '77091' }, new Map([['b1', 'b1']]), new Map([['b1', 'INSTITUTIONAL_OPERATOR']]));
  const pkgEvent = events.find((e) => e.transactionScope !== 'SINGLE_ASSET');
  assert.ok(pkgEvent);
  assert.equal(pkgEvent.pricingEligible, false);
  assert.equal(pkgEvent.propertyAllocatedConsideration, null);
  assert.ok(pkgEvent.totalConsideration > 0);
});

test('dedupe removes duplicate source_dedup_key rows', () => {
  const out = dedupePurchaseRows([
    { id: '1', source_dedup_key: 'x' },
    { id: '2', source_dedup_key: 'x' },
    { id: '3', source_dedup_key: 'y' },
  ]);
  assert.equal(out.length, 2);
});

test('activity windows are monotonic', () => {
  const events = [
    { eventId: '1', propertyId: 'a', purchaseDate: new Date().toISOString().slice(0, 10), pricingEligible: true, propertyAllocatedConsideration: 200000, transactionScope: 'SINGLE_ASSET' },
    { eventId: '2', propertyId: 'b', purchaseDate: '2025-01-01', pricingEligible: true, propertyAllocatedConsideration: 210000, transactionScope: 'SINGLE_ASSET' },
  ];
  const counts = computeActivityWindows(events, '77091', 25);
  enforceMonotonicity(counts);
  assert.ok(counts.unique30d <= counts.unique60d);
  assert.ok(counts.unique60d <= counts.unique90d);
  assert.ok(counts.unique90d <= counts.unique180d);
  assert.ok(counts.unique180d <= counts.unique365d);
  assert.ok(counts.unique365d <= counts.lifetime);
});

test('repairBidRange enforces low <= base <= high', () => {
  const r = repairBidRange(350000, 280000, 200000);
  assert.ok(r.low <= r.base);
  assert.ok(r.base <= r.high);
});

test('source labels never expose raw table names', () => {
  const label = labelPurchaseSource({ source: 'buyer_purchase_events_v2', source_dedup_key: 'dedup-1' });
  assert.equal(label, 'Verified purchase record');
  assert.doesNotMatch(label, /buyer_purchase_events|_v2|get_buyer/);
});

test('card and dossier activity fields align via familyToRankedBuyer', () => {
  const family = {
    buyerFamilyId: 'k1',
    displayName: 'Test Buyer',
    classification: { buyerClass: 'LOCAL_INVESTOR', eligibleDispositionBuyer: true, institutionalSubtype: null },
    legalEntities: [],
    parentPlatform: { verified: false },
    match: {
      matchScore: 80,
      matchGrade: 'A',
      likelyBidLow: 200000,
      likelyBidBase: 220000,
      likelyBidHigh: 240000,
      contactReadiness: 'ENRICHMENT_REQUIRED',
    },
  };
  const activity = {
    unique30d: 2,
    unique60d: 3,
    unique90d: 4,
    unique180d: 5,
    unique365d: 6,
    lifetime: 7,
    events30d: 2,
    events60d: 3,
    events90d: 4,
    events180d: 5,
    events365d: 6,
    lifetimeEvents: 7,
    packageAssets30d: 0,
    packageAssetsLifetime: 0,
    singleAssetPct: 100,
    packagePct: 0,
    localZipPurchases: 1,
    radiusPurchases: 2,
    nearestPurchaseMiles: 0.5,
    mostRecentPurchase: '2026-01-01',
    medianQualifiedPrice: 220000,
    qualifiedPriceLow: 200000,
    qualifiedPriceHigh: 240000,
  };
  const ranked = familyToRankedBuyer(family, activity);
  assert.equal(ranked.purchases30d, 2);
  assert.equal(ranked.purchases180d, 5);
  assert.equal(ranked.lifetimePurchases, 7);
  assert.ok(ranked.likelyBidLow <= ranked.likelyBidBase);
  assert.ok(ranked.likelyBidBase <= ranked.likelyBidHigh);
});