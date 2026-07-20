#!/usr/bin/env node
// Versioned listing-history snapshots from source_records payloads (mls.*
// vendor fields). Every snapshot is timestamped by the batch scrape moment
// (observed_at) and carries only vendor-dated events — nothing inferred, no
// removal dates invented (status + date_updated are the only closure evidence).
// Coverage is ~1-2% of rows; absent MLS data => NO snapshot row (features stay
// unknown, never defaulted).
import { readPartition, writePartition, writeReport } from '../lib/store.mjs';
import { deterministicId } from '../lib/hash.mjs';

export const LISTING_SNAPSHOT_VERSION = 'listing-v1';

const numOr = (x) => (x !== undefined && x !== '' && Number.isFinite(Number(String(x).replace(/[$,]/g, ''))) ? Number(String(x).replace(/[$,]/g, '')) : null);
const strOr = (x) => (x !== undefined && x !== '' ? String(x) : null);

export function snapshotFromPayload(rec, { batchId, observedAt }) {
  const status = strOr(rec['mls.status']);
  const active = rec.is_mls_active === '1' || String(rec.is_mls_active).toLowerCase() === 'true';
  const currentPrice = numOr(rec['mls.current_listing_price']);
  if (!status && !active && currentPrice === null) return null;   // no MLS evidence => no row
  const maxP = numOr(rec['mls.max_list_price']);
  const minP = numOr(rec['mls.min_list_price']);
  const cutAbs = maxP !== null && minP !== null ? maxP - minP : null;
  return {
    id: deterministicId('lst', rec.property_id ?? '', batchId),
    property_id: rec.property_id ? deterministicId('prop', rec.property_id) : null,
    vendor_property_id: rec.property_id ?? null,
    snapshot_version: LISTING_SNAPSHOT_VERSION,
    import_batch_id: batchId,
    observed_at: observedAt ?? rec.scraped_at ?? null,
    status, status_sub_type: strOr(rec['mls.status_sub_type']),
    is_active: active,
    current_list_price: currentPrice,
    initial_list_date: strOr(rec['mls.initial_listing_date']),
    days_on_market: numOr(rec['mls.days_on_market']),
    max_list_price: maxP, max_list_price_date: strOr(rec['mls.max_list_price_date']),
    min_list_price: minP, min_list_price_date: strOr(rec['mls.min_list_price_date']),
    price_cut_abs: cutAbs,
    price_cut_pct: cutAbs !== null && maxP > 0 ? Math.round((cutAbs / maxP) * 1000) / 1000 : null,
    sold_date: strOr(rec['mls.sold_date']), sold_price: numOr(rec['mls.sold_price']),
    listing_number: strOr(rec['mls.listing_number']),
    mls_id: strOr(rec['mls.mls_id']),
    agent_name: strOr(rec['mls.listing_agent_name']),
    office_name: strOr(rec['mls.listing_office_name']),
    date_updated: strOr(rec['mls.date_updated']),
  };
}

// Relisting detection needs history: multiple snapshots of the same property
// across batches with different listing_numbers, or a new initial_list_date
// after a prior sold/expired closure.
export function markRelistings(snapshots) {
  const byProp = new Map();
  for (const s of snapshots) if (s.property_id) (byProp.get(s.property_id) ?? byProp.set(s.property_id, []).get(s.property_id)).push(s);
  for (const rows of byProp.values()) {
    rows.sort((a, b) => String(a.observed_at ?? '') < String(b.observed_at ?? '') ? -1 : 1);
    const nums = new Set(rows.map((r) => r.listing_number).filter(Boolean));
    for (const r of rows) r.relisting_observed = nums.size > 1;
  }
  return snapshots;
}

export function buildListingSnapshots(propertiesBatchId) {
  const src = readPartition('source_records', propertiesBatchId);
  const snaps = [];
  for (const row of src) {
    const s = snapshotFromPayload(row.payload ?? {}, { batchId: propertiesBatchId, observedAt: row.scraped_at });
    if (s) snaps.push(s);
  }
  markRelistings(snaps);
  writePartition('listing_snapshots', propertiesBatchId, snaps);
  const report = {
    batch: propertiesBatchId, source_rows: src.length, snapshots: snaps.length,
    coverage: src.length ? Math.round((snaps.length / src.length) * 10000) / 10000 : 0,
    active: snaps.filter((s) => s.is_active).length,
    with_price_cut: snaps.filter((s) => (s.price_cut_abs ?? 0) > 0).length,
    sold_outcomes: snaps.filter((s) => s.sold_date).length,
    relistings: snaps.filter((s) => s.relisting_observed).length,
    version: LISTING_SNAPSHOT_VERSION,
  };
  writeReport(`listing_snapshots_${propertiesBatchId}`, report);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const batchId = process.argv[2];
  if (!batchId) { console.error('usage: buildListingSnapshots.mjs <propertiesBatchId>'); process.exit(1); }
  console.log(JSON.stringify(buildListingSnapshots(batchId), null, 2));
}
