/**
 * Acquisition Engine V3 — transaction identity & clustering (mission §2).
 *
 * "Rows are not transactions." This module collapses comp/buyer-event ROWS into
 * economic TRANSACTION CLUSTERS, detects package/portfolio sales (one
 * consideration broadcast across many parcels) and exact duplicate parcel rows,
 * and computes an effective sample size that is correlation-aware.
 *
 * Pure & deterministic. No I/O.
 */

import {
  MONEY_BUCKET_USD,
  PACKAGE_MIN_PARCELS,
  PACKAGE_MIN_ZIPS,
  PACKAGE_QUARANTINE_PROBABILITY,
  num,
  lower,
  clean,
  round,
} from './modelConstants.js';

const ENTITY_SUFFIXES =
  /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|lp|l\.p|llp|ltd|limited|trust|tr|holdings|properties|property|investments|invest|capital|group|partners|enterprises|homes|realty|management|mgmt|fund|reit)\b/g;

export function normalizeMoney(value) {
  const n = num(value);
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / MONEY_BUCKET_USD) * MONEY_BUCKET_USD;
}

export function normalizeDate(value) {
  if (!value) return null;
  const s = clean(value);
  // already ISO-ish
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function normalizeEntityName(value) {
  const base = lower(value)
    .replace(/[.,#&'"`]/g, ' ')
    .replace(ENTITY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

function normalizeAddress(value) {
  return lower(value).replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parcelKeyOf(tx) {
  return (
    clean(tx.apn_parcel_id) ||
    clean(tx.property_id) ||
    clean(tx.comp_property_id) ||
    normalizeAddress(tx.address) ||
    clean(tx.id) ||
    `idx:${tx._idx}`
  );
}

/** Stable transaction fingerprint (mission §2). */
export function transactionFingerprint(tx) {
  return [
    normalizeEntityName(tx.buyer) || '∅',
    normalizeEntityName(tx.seller) || '∅',
    normalizeDate(tx.sale_date) || normalizeDate(tx.recording_date) || '∅',
    normalizeMoney(tx.consideration) ?? '∅',
    lower(tx.document_type) || '∅',
    parcelKeyOf(tx) || '∅',
  ].join('|');
}

/** Map raw comp / buyer-event rows into a normalized transaction shape. */
export function buildTransactions(rawRows = []) {
  return rawRows.map((row, idx) => {
    const consideration =
      num(row.consideration) ??
      num(row.sale_price) ??
      num(row.purchase_price) ??
      num(row.mls_sold_price) ??
      num(row.price) ??
      null;
    return {
      _idx: idx,
      raw: row,
      id: clean(row.id ?? row.comp_id ?? ''),
      property_id: clean(row.property_id ?? ''),
      comp_property_id: clean(row.comp_property_id ?? ''),
      apn_parcel_id: clean(row.apn_parcel_id ?? ''),
      address: clean(row.property_address_full ?? row.address ?? ''),
      zip: clean(row.property_address_zip ?? row.property_zip ?? row.zip ?? ''),
      city: clean(row.property_address_city ?? row.property_city ?? row.city ?? ''),
      buyer: clean(row.buyer_name_clean ?? row.buyer_name ?? row.buyer_key ?? ''),
      seller: clean(
        row.owner_name_clean ?? row.owner_name ?? row.seller_name ?? row.owner_key ?? '',
      ),
      sale_date: row.sale_date ?? row.purchase_date ?? row.mls_sold_date ?? null,
      recording_date: row.recording_date ?? null,
      consideration,
      consideration_source: clean(row.sale_price_source ?? row.purchase_price_source ?? ''),
      document_type: clean(row.document_type ?? row.last_sale_doc_type ?? ''),
      source: clean(row.source ?? ''),
    };
  });
}

function clusterKeyOf(tx) {
  const dateKey = normalizeDate(tx.sale_date) || normalizeDate(tx.recording_date) || '∅';
  const moneyKey = normalizeMoney(tx.consideration);
  if (moneyKey === null) return `solo:${tx._idx}`; // no price ⇒ cannot be a price-broadcast package
  const buyerKey = normalizeEntityName(tx.buyer);
  // buyer present ⇒ tightest grouping; absent ⇒ still group by (date, price) which
  // is exactly what catches the broadcast packages on the identity-blind view path.
  return `${buyerKey || '∅'}|${dateKey}|${moneyKey}`;
}

function packageProbability(distinctParcels, distinctZips, consideration) {
  if (consideration === null) return 0;
  if (distinctParcels >= PACKAGE_MIN_PARCELS && distinctZips >= PACKAGE_MIN_ZIPS) return 0.97;
  if (distinctParcels >= PACKAGE_MIN_PARCELS) return 0.85;
  if (distinctParcels >= 2 && distinctZips >= 2) return 0.6;
  if (distinctParcels >= 2) return 0.35;
  return 0.05;
}

/**
 * Cluster transactions and annotate each with package/duplicate signals.
 * @returns {{ txs: object[], clusters: object[], byKey: Map<string,object> }}
 */
export function clusterTransactions(txs = []) {
  const groups = new Map();
  for (const tx of txs) {
    const key = clusterKeyOf(tx);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }

  const clusters = [];
  for (const [key, members] of groups) {
    const parcelKeys = new Map(); // parcelKey -> first member (for duplicate detection)
    const zips = new Set();
    const cities = new Set();
    const dates = new Set();
    for (const m of members) {
      const pk = parcelKeyOf(m);
      if (m.zip) zips.add(lower(m.zip));
      if (m.city) cities.add(lower(m.city));
      const dk = normalizeDate(m.sale_date) || normalizeDate(m.recording_date);
      if (dk) dates.add(dk);
      if (!parcelKeys.has(pk)) parcelKeys.set(pk, m);
    }
    const consideration = normalizeMoney(members[0].consideration);
    const distinctParcels = parcelKeys.size;
    const distinctZips = zips.size;
    const pkgProb = packageProbability(distinctParcels, distinctZips, consideration);
    const isPackage = pkgProb >= PACKAGE_QUARANTINE_PROBABILITY;
    const independenceScore = round(100 * (1 - pkgProb), 0);

    // duplicate detection within cluster: same parcel appearing more than once
    const seenParcel = new Set();
    for (const m of members) {
      const pk = parcelKeyOf(m);
      const isDuplicate = seenParcel.has(pk);
      if (!isDuplicate) seenParcel.add(pk);
      m.cluster_id = key;
      m.cluster_size = members.length;
      m.cluster_distinct_parcels = distinctParcels;
      m.cluster_distinct_zips = distinctZips;
      m.package_sale_probability = pkgProb;
      m.is_package = isPackage;
      m.is_duplicate = isDuplicate;
      m.duplicate_probability = isDuplicate ? 1 : 0;
      m.independence_score = isDuplicate ? 0 : independenceScore;
      m.fingerprint = transactionFingerprint(m);
    }

    clusters.push({
      cluster_id: key,
      cluster_size: members.length,
      distinct_parcels: distinctParcels,
      distinct_zips: distinctZips,
      distinct_cities: cities.size,
      distinct_dates: dates.size,
      consideration,
      repeated_consideration_count: consideration === null ? 0 : members.length,
      package_sale_probability: pkgProb,
      is_package: isPackage,
      duplicate_rows: members.length - distinctParcels,
      independence_score: independenceScore,
    });
  }

  const byKey = new Map(clusters.map((c) => [c.cluster_id, c]));
  return { txs, clusters, byKey };
}

/**
 * Correlation-aware effective sample size (mission §22).
 * Package clusters and duplicate rows do NOT add comp depth.
 */
export function effectiveSampleSize(clusters = []) {
  const independentClusters = clusters.filter(
    (c) => !c.is_package && c.package_sale_probability < PACKAGE_QUARANTINE_PROBABILITY,
  );
  const rawRows = clusters.reduce((s, c) => s + c.cluster_size, 0);
  const packageClusters = clusters.filter((c) => c.is_package);
  return {
    raw_rows: rawRows,
    distinct_clusters: clusters.length,
    independent_clusters: independentClusters.length,
    // each correlated cluster contributes exactly 1 toward depth
    effective_sample_size: independentClusters.length,
    package_cluster_count: packageClusters.length,
    parcels_in_package_clusters: packageClusters.reduce((s, c) => s + c.distinct_parcels, 0),
    duplicate_row_count: clusters.reduce((s, c) => s + (c.duplicate_rows || 0), 0),
  };
}
