/**
 * Buyer Match V4 Phase 2 — unified activity + bid aggregations (read-only).
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const WINDOWS = [30, 60, 90, 180, 365];

function assetKey(event) {
  return event.propertyId || event.address || event.eventId;
}

function eventTime(event) {
  if (!event.purchaseDate) return null;
  const t = new Date(event.purchaseDate).getTime();
  return Number.isNaN(t) ? null : t;
}

function eventsForFamily(events, familyId) {
  return events.filter((e) => e.buyerFamilyId === familyId);
}

/**
 * Count unique assets in rolling windows (cumulative monotonic).
 */
export function computeActivityWindows(events = [], subjectZip = null, radiusMiles = null) {
  const now = Date.now();
  const counts = {
    unique30d: 0,
    unique60d: 0,
    unique90d: 0,
    unique180d: 0,
    unique365d: 0,
    lifetime: 0,
    events30d: 0,
    events60d: 0,
    events90d: 0,
    events180d: 0,
    events365d: 0,
    lifetimeEvents: 0,
    packageAssets30d: 0,
    packageAssetsLifetime: 0,
    singleAssetPct: null,
    packagePct: null,
    localZipPurchases: 0,
    radiusPurchases: 0,
    nearestPurchaseMiles: null,
    mostRecentPurchase: null,
    medianQualifiedPrice: null,
    qualifiedPriceLow: null,
    qualifiedPriceHigh: null,
  };

  const lifetimeAssets = new Set();
  const windowAssets = Object.fromEntries(WINDOWS.map((d) => [d, new Set()]));
  const windowEvents = Object.fromEntries(WINDOWS.map((d) => [d, 0]));
  let packageAssets = 0;
  let singleAssets = 0;
  const qualifiedPrices = [];

  for (const event of events) {
    const t = eventTime(event);
    const ak = assetKey(event);
    lifetimeAssets.add(ak);
    counts.lifetimeEvents += 1;

    if (subjectZip && event.address?.includes(subjectZip)) counts.localZipPurchases += 1;
    if (radiusMiles != null && event.distanceMiles != null && event.distanceMiles <= radiusMiles) {
      counts.radiusPurchases += 1;
    }
    if (event.distanceMiles != null) {
      counts.nearestPurchaseMiles = counts.nearestPurchaseMiles == null
        ? event.distanceMiles
        : Math.min(counts.nearestPurchaseMiles, event.distanceMiles);
    }
    if (t && (!counts.mostRecentPurchase || t > new Date(counts.mostRecentPurchase).getTime())) {
      counts.mostRecentPurchase = event.purchaseDate;
    }

    if (event.transactionScope === 'SINGLE_ASSET') singleAssets += 1;
    if (event.transactionScope === 'MULTI_ASSET_PACKAGE' || event.transactionScope === 'PORTFOLIO') {
      packageAssets += event.packageAssetCount ?? 1;
      counts.packageAssetsLifetime += event.packageAssetCount ?? 1;
    }

    if (event.pricingEligible && event.propertyAllocatedConsideration != null) {
      qualifiedPrices.push(event.propertyAllocatedConsideration);
    }

    if (t) {
      const ageDays = (now - t) / 86400000;
      for (const d of WINDOWS) {
        if (ageDays <= d) {
          windowAssets[d].add(ak);
          windowEvents[d] += 1;
          if (event.transactionScope !== 'SINGLE_ASSET') {
            if (d === 30) counts.packageAssets30d += event.packageAssetCount ?? 1;
          }
        }
      }
    }
  }

  counts.unique30d = windowAssets[30].size;
  counts.unique60d = windowAssets[60].size;
  counts.unique90d = windowAssets[90].size;
  counts.unique180d = windowAssets[180].size;
  counts.unique365d = windowAssets[365].size;
  counts.lifetime = lifetimeAssets.size;
  counts.events30d = windowEvents[30];
  counts.events60d = windowEvents[60];
  counts.events90d = windowEvents[90];
  counts.events180d = windowEvents[180];
  counts.events365d = windowEvents[365];

  const totalScoped = singleAssets + packageAssets;
  if (totalScoped > 0) {
    counts.singleAssetPct = Math.round((singleAssets / totalScoped) * 100);
    counts.packagePct = Math.round((packageAssets / totalScoped) * 100);
  }

  if (qualifiedPrices.length) {
    qualifiedPrices.sort((a, b) => a - b);
    const mid = Math.floor(qualifiedPrices.length / 2);
    counts.medianQualifiedPrice = qualifiedPrices.length % 2
      ? qualifiedPrices[mid]
      : Math.round((qualifiedPrices[mid - 1] + qualifiedPrices[mid]) / 2);
    counts.qualifiedPriceLow = qualifiedPrices[0];
    counts.qualifiedPriceHigh = qualifiedPrices[qualifiedPrices.length - 1];
  }

  enforceMonotonicity(counts);
  return counts;
}

/** Enforce 30 ≤ 60 ≤ 90 ≤ 180 ≤ 365 ≤ lifetime */
export function enforceMonotonicity(counts) {
  const keys = ['unique30d', 'unique60d', 'unique90d', 'unique180d', 'unique365d', 'lifetime'];
  let prev = 0;
  for (const k of keys) {
    if ((counts[k] ?? 0) < prev) counts[k] = prev;
    else prev = counts[k];
  }
  return counts;
}

/**
 * Repair bid range to satisfy low ≤ base ≤ high.
 */
export function repairBidRange(low, base, high) {
  let l = num(low);
  let b = num(base);
  let h = num(high);

  if (l == null && b != null) l = Math.round(b * 0.92);
  if (h == null && b != null) h = Math.round(b * 1.05);
  if (b == null && l != null && h != null) b = Math.round((l + h) / 2);

  if (l != null && b != null && l > b) [l, b] = [b, l];
  if (b != null && h != null && b > h) [b, h] = [h, b];
  if (l != null && h != null && l > h) [l, h] = [h, l];
  if (l != null && b != null && l > b) b = l;
  if (b != null && h != null && b > h) h = b;

  return { low: l, base: b, high: h };
}

export function aggregateFamilyActivity(familyId, allEvents, subjectZip, radiusMiles = 25) {
  const familyEvents = eventsForFamily(allEvents, familyId);
  return computeActivityWindows(familyEvents, subjectZip, radiusMiles);
}

export function buildMarketIntelligenceCounts(families = [], events = []) {
  const eligible = families.filter((f) => f.classification?.eligibleDispositionBuyer);
  const highFit = eligible.filter((f) => ['A+', 'A'].includes(f.match?.matchGrade));
  const institutional = families.filter((f) =>
    ['INSTITUTIONAL_OPERATOR', 'REIT', 'PRIVATE_EQUITY_PLATFORM'].includes(f.classification?.buyerClass),
  );
  const localRegional = families.filter((f) =>
    ['LOCAL_INVESTOR', 'REGIONAL_OPERATOR'].includes(f.classification?.buyerClass),
  );
  const builders = families.filter((f) => f.classification?.buyerClass === 'BUILDER');
  const government = families.filter((f) =>
    ['GOVERNMENT_AGENCY', 'NONPROFIT', 'LENDER_OR_SERVICER'].includes(f.classification?.buyerClass),
  );
  const unresolved = families.filter((f) => f.classification?.buyerClass === 'UNKNOWN');

  const packageEvents = events.filter((e) => e.transactionScope !== 'SINGLE_ASSET');
  const qualifiedSingle = events.filter((e) => e.pricingEligible && e.transactionScope === 'SINGLE_ASSET');
  const uniqueAssets = new Set(events.map(assetKey)).size;

  return {
    eligibleBuyerFamilies: eligible.length || null,
    highFitFamilies: highFit.length || null,
    localRegionalFamilies: localRegional.length || null,
    institutionalPlatforms: institutional.length || null,
    builderFamilies: builders.length || null,
    governmentNonMarketFamilies: government.length || null,
    unresolvedIdentities: unresolved.length || null,
    uniquePurchaseEvents: events.length || null,
    uniquePurchasedAssets: uniqueAssets || null,
    packageEventCount: packageEvents.length || null,
    packageAssetCount: packageEvents.reduce((s, e) => s + (e.packageAssetCount ?? 1), 0) || null,
    qualifiedSingleAssetCount: qualifiedSingle.length || null,
    geocodedEventCount: events.filter((e) => e.latitude != null && e.longitude != null).length || null,
  };
}

export function familyToRankedBuyer(family, activity) {
  const m = family.match ?? {};
  const bids = repairBidRange(m.likelyBidLow, m.likelyBidBase, m.likelyBidHigh);
  const cls = family.classification ?? {};

  return {
    buyerId: family.buyerFamilyId,
    buyerFamilyId: family.buyerFamilyId,
    buyerName: family.displayName,
    entityType: m.candidate?.buyer_type ?? null,
    buyerArchetype: cls.buyerClass ?? 'UNKNOWN',
    buyerClass: cls.buyerClass ?? 'UNKNOWN',
    institutionalSubtype: cls.institutionalSubtype ?? null,
    institutionalStatus: cls.buyerClass === 'INSTITUTIONAL_OPERATOR' || cls.buyerClass === 'REIT' || cls.buyerClass === 'PRIVATE_EQUITY_PLATFORM'
      ? 'VERIFIED_INSTITUTIONAL'
      : cls.buyerClass === 'BUILDER'
        ? 'BUILDER'
        : null,
    eligibleDispositionBuyer: cls.eligibleDispositionBuyer ?? false,
    matchScore: m.matchScore ?? null,
    matchGrade: m.matchGrade ?? null,
    matchConfidence: m.matchConfidence ?? null,
    reasonSummary: m.reasonSummary?.length ? m.reasonSummary : [],
    likelyBidLow: bids.low,
    likelyBidBase: bids.base,
    likelyBidHigh: bids.high,
    purchases30d: activity.unique30d || null,
    purchases60d: activity.unique60d || null,
    purchases90d: activity.unique90d || null,
    purchases180d: activity.unique180d || null,
    purchases365d: activity.unique365d || null,
    lifetimePurchases: activity.lifetime || null,
    lastPurchaseAt: activity.mostRecentPurchase ?? m.lastPurchaseAt ?? null,
    nearestPurchaseMiles: activity.nearestPurchaseMiles ?? m.nearestPurchaseMiles ?? null,
    medianQualifiedPrice: activity.medianQualifiedPrice,
    localPurchases: activity.localZipPurchases || null,
    contactReadiness: m.contactReadiness ?? 'ENRICHMENT_REQUIRED',
    legalEntities: family.legalEntities,
    parentPlatform: family.parentPlatform,
    classification: family.classification,
    activity,
  };
}

export default {
  computeActivityWindows,
  enforceMonotonicity,
  repairBidRange,
  aggregateFamilyActivity,
  buildMarketIntelligenceCounts,
  familyToRankedBuyer,
};