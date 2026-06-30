/**
 * Buyer Match V4 Phase 2 — canonical purchase-event truth (read-only).
 */
import { buildTransactions, clusterTransactions } from '../acquisition/transactionClustering.js';
import { classifyDemandEligibility } from './buyer-match-v4-identity.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.7559 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Human-readable source labels — never expose raw table names. */
export function labelPurchaseSource(row = {}) {
  const src = String(row.source ?? '').toLowerCase();
  if (/mls|listing/.test(src) || /mls/i.test(String(row.purchase_price_source ?? ''))) {
    return 'MLS transaction';
  }
  if (/recently_sold|public/.test(src)) {
    return 'Public-record acquisition';
  }
  if (row.source_dedup_key) {
    return 'Verified purchase record';
  }
  return 'Buyer purchase event';
}

function assetKey(row) {
  return row.comp_property_id || row.raw_id || row.property_address_full || row.id;
}

function familyIdForRow(row, familyByEntity = new Map()) {
  if (row.buyer_key && familyByEntity.has(row.buyer_key)) return familyByEntity.get(row.buyer_key);
  if (row.buyer_entity_id && familyByEntity.has(row.buyer_entity_id)) return familyByEntity.get(row.buyer_entity_id);
  return row.buyer_key || row.buyer_entity_id || null;
}

/**
 * Deduplicate raw rows by source_dedup_key or id.
 */
export function dedupePurchaseRows(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.source_dedup_key || String(row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Annotate rows with package cluster metadata.
 */
export function annotatePackageClusters(rows = []) {
  const txs = buildTransactions(rows.map((r) => ({
    ...r,
    property_id: r.comp_property_id || r.raw_id,
    apn_parcel_id: r.comp_property_id || r.raw_id,
    address: r.property_address_full,
    zip: r.property_zip,
    buyer_name: r.buyer_name,
    buyer_key: r.buyer_key,
    purchase_date: r.purchase_date,
    purchase_price: r.purchase_price,
    document_type: r.document_type,
  })));
  const { txs: clustered } = clusterTransactions(txs);
  return rows.map((row, idx) => {
    const tx = clustered[idx];
    return {
      ...row,
      _isPackage: Boolean(tx?.is_package),
      _packageAssetCount: tx?.cluster_distinct_parcels ?? 1,
      _packageId: tx?.is_package ? tx.cluster_id : null,
      _packageAllocationSupported: false,
      _isDuplicate: Boolean(tx?.is_duplicate),
    };
  });
}

/**
 * Build canonical purchase events from deduped, package-annotated rows.
 */
export function buildCanonicalPurchaseEvents(rows = [], subject = {}, familyByEntity = new Map(), buyerClassByFamily = new Map()) {
  const deduped = dedupePurchaseRows(rows);
  const annotated = annotatePackageClusters(deduped);

  return annotated
    .filter((row) => !row._isDuplicate)
    .map((row) => {
      const lat = num(row.latitude);
      const lng = num(row.longitude);
      const distanceMiles =
        subject.lat !== null && subject.lng !== null && lat !== null && lng !== null
          ? Math.round(haversineMiles(subject.lat, subject.lng, lat, lng) * 100) / 100
          : null;

      const buyerFamilyId = familyIdForRow(row, familyByEntity);
      const buyerClass = buyerFamilyId ? buyerClassByFamily.get(buyerFamilyId) ?? 'UNKNOWN' : 'UNKNOWN';
      const eligibility = classifyDemandEligibility(row, buyerClass);

      const isPackage = row._isPackage;
      const totalConsideration = num(row.purchase_price);
      const pricingEligible = eligibility.pricingEligible && !isPackage && totalConsideration != null;

      return {
        eventId: String(row.id),
        propertyId: row.comp_property_id || row.raw_id || null,
        buyerFamilyId,
        legalEntityId: row.buyer_entity_id ?? row.buyer_key ?? null,
        buyerName: row.buyer_name ?? null,
        legalEntityName: row.buyer_name ?? null,

        transactionScope: isPackage
          ? (row._packageAssetCount >= 10 ? 'PORTFOLIO' : 'MULTI_ASSET_PACKAGE')
          : 'SINGLE_ASSET',
        packageId: row._packageId,
        packageAssetCount: isPackage ? row._packageAssetCount : null,

        totalConsideration: isPackage ? totalConsideration : null,
        propertyAllocatedConsideration: !isPackage ? totalConsideration : null,
        propertyAllocationBasis: isPackage ? null : 'single_asset_record',
        propertyAllocationConfidence: !isPackage && totalConsideration != null ? 90 : null,

        // Legacy flat fields for dashboard adapter
        purchasePrice: pricingEligible ? totalConsideration : (isPackage ? null : totalConsideration),
        purchaseDate: row.purchase_date ?? null,
        address: row.property_address_full || 'Address unavailable',
        latitude: lat,
        longitude: lng,
        distanceMiles,
        assetLane: row.normalized_asset_class ?? null,
        propertySubtype: row.property_type ?? null,

        pricingEligible,
        demandEligible: eligibility.demandEligible === 'DISPOSITION_BUYER',
        demandEligibility: eligibility.demandEligible,
        exclusionReasons: eligibility.exclusionReasons,
        buyerClass,

        sourceLabel: labelPurchaseSource(row),
        source: null,
      };
    });
}

export function countGeocodedEvents(events = []) {
  return events.filter((e) => e.latitude != null && e.longitude != null).length;
}

export default {
  labelPurchaseSource,
  dedupePurchaseRows,
  annotatePackageClusters,
  buildCanonicalPurchaseEvents,
  countGeocodedEvents,
};