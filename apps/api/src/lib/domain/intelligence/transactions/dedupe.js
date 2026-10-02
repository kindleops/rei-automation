/**
 * IC8.1 canonical transaction dedupe + source priority. Pure; no I/O.
 *
 * Collapses observations of ONE economic transaction (the same parcel, sold
 * once, seen by several corpora/providers: the 48K engine pool, the canonical
 * deeds, MLS) into one canonical transaction that keeps EVERY provenance
 * record. Never merges two different transactions:
 *
 *   identity    same parcel (property_id, else APN key, else address key) AND
 *               sale dates within `windowDays` (MLS close vs deed record dates
 *               differ by days, not months)
 *   repeat sale a later sale of the same parcel (> driftDays apart) is a new
 *               transaction, never a duplicate
 *   drift       dates windowDays..driftDays apart merge only on an identical
 *               reliable price; otherwise the pair is reported AMBIGUOUS
 *   conflict    two reliable prices > priceTolerance apart in the window are
 *               NOT merged (a double close / flip on one day is two
 *               transactions) and are reported AMBIGUOUS
 *   same source two records of the same source with distinct provider
 *               transaction ids are distinct transactions unless date AND
 *               price are identical (an exact re-delivery)
 *   packages    one deed stamped on several parcels (same date + same price)
 *               stays one transaction PER PARCEL, flagged package_n
 *
 * Canonical price = the best record by explicit quality rules, never by
 * recency: confidence (HIGH > MEDIUM > LOW > UNKNOWN), then a non-estimate,
 * then the SOURCE_PRIORITY ladder, then corpus order, then id.
 */

import { CONFIDENCE_RANK, SOURCE_PRIORITY, isReliablePrice } from "./price-taxonomy.js";

export const DEDUPE_VERSION = "ic8_txn_dedupe@1";
export const DEDUPE_DEFAULTS = Object.freeze({ windowDays: 10, driftDays: 45, priceTolerance: 0.05, exactTolerance: 0.005 });
const SRC_ORDER = Object.freeze(["pool", "deeds", "canonical", "seller_sale", "comp_transaction"]);
const DAY_MS = 86_400_000;

const dayMs = (d) => {
  if (!d) return null;
  const t = Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
};
const cmpId = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

export function parcelKeys(r) {
  return [r.pid && `p:${r.pid}`, r.parcel_key && `k:${r.parcel_key}`, r.addr_key && `a:${r.addr_key}`].filter(Boolean);
}

export function sameParcelBasis(a, b) {
  if (a.pid && b.pid && a.pid === b.pid) return "property_id";
  if (a.parcel_key && b.parcel_key && a.parcel_key === b.parcel_key) return "parcel_key";
  // address only for single-unit addresses: "123 Main St Unit 4" vs "Unit 7" share no key, and a
  // building address without a unit can be many parcels.
  if (a.addr_key && b.addr_key && a.addr_key === b.addr_key && !a.unit_designator && !b.unit_designator) return "address_key";
  return null;
}

/** Smallest gap in days between any of the two records' sale dates. */
export function dateGapDays(a, b) {
  const da = [a.sale_date, a.deed_date, a.mls_date].map(dayMs).filter((x) => x !== null);
  const db = [b.sale_date, b.deed_date, b.mls_date].map(dayMs).filter((x) => x !== null);
  if (!da.length || !db.length) return null;
  let best = Infinity;
  for (const x of da) for (const y of db) best = Math.min(best, Math.abs(x - y) / DAY_MS);
  return best;
}

const relDiff = (a, b) => (a && b ? Math.abs(a - b) / Math.max(a, b) : null);

/** Ordering of price records, best first. */
export function comparePriceRecords(a, b) {
  const na = a.price_norm;
  const nb = b.price_norm;
  const conf = (CONFIDENCE_RANK[nb?.confidence] ?? 0) - (CONFIDENCE_RANK[na?.confidence] ?? 0);
  if (conf) return conf;
  const est = (na?.is_estimated === true ? 1 : 0) - (nb?.is_estimated === true ? 1 : 0);
  if (est) return est;
  const sp = SOURCE_PRIORITY.indexOf(na?.source) - SOURCE_PRIORITY.indexOf(nb?.source);
  if (sp) return sp;
  const so = SRC_ORDER.indexOf(a.src) - SRC_ORDER.indexOf(b.src);
  if (so) return so;
  return cmpId(a.id, b.id);
}

/**
 * Decide whether two records of the same parcel are the same transaction.
 * @returns {{merge:boolean, basis?:string, ambiguous?:string, gap:number|null}}
 */
export function pairDecision(a, b, opts = DEDUPE_DEFAULTS) {
  const o = { ...DEDUPE_DEFAULTS, ...opts };
  const parcel = sameParcelBasis(a, b);
  if (!parcel) return { merge: false, gap: null };
  const gap = dateGapDays(a, b);
  if (gap === null || gap > o.driftDays) return { merge: false, gap };
  const pa = a.price_norm?.transaction_price ?? null;
  const pb = b.price_norm?.transaction_price ?? null;
  const ra = isReliablePrice(a.price_norm);
  const rb = isReliablePrice(b.price_norm);
  const diff = relDiff(pa, pb);
  const exactPrice = diff !== null && diff <= o.exactTolerance;
  const sameSource = a.src === b.src;
  const distinctTxn = sameSource && a.provider_txn_id && b.provider_txn_id && a.provider_txn_id !== b.provider_txn_id;

  if (gap > o.windowDays) {
    if (exactPrice && (ra || rb) && !distinctTxn) return { merge: true, basis: `${parcel}|date_drift_exact_price`, gap };
    return { merge: false, ambiguous: "date_drift_within_45d", gap };
  }
  if (sameSource) {
    if (gap === 0 && (exactPrice || (pa === null && pb === null))) return { merge: true, basis: `${parcel}|exact_redelivery`, gap };
    return { merge: false, ambiguous: distinctTxn ? "same_source_distinct_txn_in_window" : "same_source_in_window", gap };
  }
  if (ra && rb && diff !== null && diff > o.priceTolerance) return { merge: false, ambiguous: "reliable_price_conflict_in_window", gap };
  return { merge: true, basis: `${parcel}|${ra && rb ? "price_agrees" : "price_unreliable_date_parcel"}`, gap };
}

/**
 * @param records  [{id, src, pid, parcel_key, addr_key, unit_designator, sale_date, deed_date, mls_date,
 *                   provider_txn_id, market, price_norm (normalizeTransactionPrice output), ...}]
 * @returns {{transactions, ambiguous, stats}}
 */
export function canonicalizeTransactions(records, opts = {}) {
  const o = { ...DEDUPE_DEFAULTS, ...opts };
  const list = [...records].sort((a, b) => cmpId(a.id, b.id));
  const byKey = new Map();
  for (const r of list) for (const k of parcelKeys(r)) {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  // candidate pairs, evaluated once
  const pairs = [];
  const seen = new Set();
  for (const r of list) for (const k of parcelKeys(r)) for (const other of byKey.get(k)) {
    if (other === r || cmpId(other.id, r.id) <= 0) continue;
    const pk = `${r.id}|${other.id}`;
    if (seen.has(pk)) continue;
    seen.add(pk);
    pairs.push({ a: r, b: other, d: pairDecision(r, other, o) });
  }
  // union-find with a cluster-level guard: never join clusters that contain a non-mergeable pair
  const parent = new Map(list.map((r) => [r.id, r.id]));
  const members = new Map(list.map((r) => [r.id, [r]]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const blocked = new Set(pairs.filter((p) => !p.d.merge && p.d.gap !== null && p.d.gap <= o.driftDays).map((p) => `${p.a.id}|${p.b.id}`));
  const isBlocked = (x, y) => blocked.has(cmpId(x.id, y.id) < 0 ? `${x.id}|${y.id}` : `${y.id}|${x.id}`);
  const ambiguous = [];
  const merges = pairs.filter((p) => p.d.merge).sort((p, q) => p.d.gap - q.d.gap || cmpId(p.a.id, q.a.id) || cmpId(p.b.id, q.b.id));
  const basisOf = new Map();
  for (const p of merges) {
    const ra = find(p.a.id);
    const rb = find(p.b.id);
    if (ra === rb) continue;
    const A = members.get(ra);
    const B = members.get(rb);
    if (A.some((x) => B.some((y) => isBlocked(x, y)))) {
      ambiguous.push({ kind: "transitive_merge_refused", ids: [p.a.id, p.b.id], gap_days: p.d.gap, market: p.a.market ?? p.b.market ?? null });
      continue;
    }
    const [keep, drop] = cmpId(ra, rb) < 0 ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    members.set(keep, [...members.get(keep), ...members.get(drop)]);
    members.delete(drop);
    basisOf.set(keep, [...(basisOf.get(keep) ?? []), ...(basisOf.get(drop) ?? []), p.d.basis]);
  }
  for (const p of pairs) {
    if (p.d.merge || !p.d.ambiguous) continue;
    if (find(p.a.id) === find(p.b.id)) continue;
    ambiguous.push({ kind: p.d.ambiguous, ids: [p.a.id, p.b.id], gap_days: p.d.gap, market: p.a.market ?? p.b.market ?? null });
  }

  const transactions = [];
  for (const [root, group] of members) {
    const ranked = [...group].sort(comparePriceRecords);
    const winner = ranked[0];
    const reliable = ranked.filter((r) => isReliablePrice(r.price_norm));
    const prices = reliable.map((r) => r.price_norm.transaction_price);
    const priceConflict = prices.length > 1 && relDiff(Math.min(...prices), Math.max(...prices)) > o.priceTolerance;
    const mls = group.find((r) => r.mls_date);
    const dates = group.map((r) => r.sale_date).filter(Boolean).sort();
    transactions.push({
      canonical_id: `T:${root}`,
      parcel: winner.pid ?? winner.parcel_key ?? winner.addr_key ?? null,
      market: winner.market ?? group.find((r) => r.market)?.market ?? null,
      zip: winner.zip ?? group.find((r) => r.zip)?.zip ?? null,
      lat: typeof winner.lat === "number" ? winner.lat : group.find((r) => typeof r.lat === "number")?.lat ?? null,
      lng: typeof winner.lng === "number" ? winner.lng : group.find((r) => typeof r.lng === "number")?.lng ?? null,
      sale_date: mls?.mls_date ?? dates[0] ?? null,
      price_record_id: winner.id,
      price: winner.price_norm,
      price_conflict: priceConflict,
      sources: [...new Set(group.map((r) => r.src))].sort(),
      members: ranked.map((r, i) => ({
        id: r.id,
        src: r.src,
        role: i === 0 ? "price_source" : "provenance",
        price: r.price_norm?.transaction_price ?? null,
        source: r.price_norm?.source ?? null,
        confidence: r.price_norm?.confidence ?? null,
      })),
      merge_basis: [...new Set(basisOf.get(root) ?? [])].sort(),
      package_n: 0,
    });
  }
  const packages = flagPackageDeeds(transactions);
  transactions.sort((a, b) => cmpId(a.canonical_id, b.canonical_id));

  const byMarket = {};
  const bump = (m, k, n = 1) => {
    const key = m ?? "(none)";
    byMarket[key] ??= { records: 0, transactions: 0, merged_records: 0, cross_source_transactions: 0, ambiguous: 0 };
    byMarket[key][k] += n;
  };
  for (const r of list) bump(r.market, "records");
  for (const t of transactions) {
    bump(t.market, "transactions");
    bump(t.market, "merged_records", t.members.length - 1);
    if (t.sources.length > 1) bump(t.market, "cross_source_transactions");
  }
  for (const a of ambiguous) bump(a.market, "ambiguous");
  for (const m of Object.values(byMarket)) m.dedupe_rate = m.records ? Math.round((m.merged_records / m.records) * 1e4) / 1e4 : null;
  const ambiguousByKind = {};
  for (const a of ambiguous) ambiguousByKind[a.kind] = (ambiguousByKind[a.kind] ?? 0) + 1;
  return {
    transactions,
    ambiguous,
    stats: {
      version: DEDUPE_VERSION,
      params: o,
      records: list.length,
      transactions: transactions.length,
      merged_records: list.length - transactions.length,
      dedupe_rate: list.length ? Math.round(((list.length - transactions.length) / list.length) * 1e4) / 1e4 : null,
      ambiguous_by_kind: ambiguousByKind,
      packages,
      by_market: byMarket,
    },
  };
}

/**
 * Package / portfolio deeds: the same (sale date, price) on >= 2 distinct
 * parcels in the same ZIP or within ~1 mi, or on >= 3 parcels anywhere when
 * the price is not a round $1,000. Each parcel stays its own transaction;
 * package_n records the package size.
 */
export function flagPackageDeeds(transactions) {
  const groups = new Map();
  for (const t of transactions) {
    const p = t.price?.transaction_price;
    if (!t.sale_date || !p) continue;
    const key = `${t.sale_date}|${Math.round(p)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  let clusters = 0;
  let members = 0;
  for (const group of groups.values()) {
    const parcels = new Set(group.map((t) => t.parcel ?? t.canonical_id));
    if (parcels.size < 2) continue;
    // Same ZIP or ~1 mi, any size; across a metro only when >= 3 parcels share a NON-round
    // price (identical round prices on one day across a county are coincidences: in LA a
    // date+price rule flagged 25% of all sales).
    const zips = new Set(group.map((t) => t.zip).filter(Boolean));
    const lats = group.map((t) => t.lat).filter((x) => typeof x === "number");
    const lngs = group.map((t) => t.lng).filter((x) => typeof x === "number");
    const proximate = lats.length === group.length && Math.max(...lats) - Math.min(...lats) < 0.015 && Math.max(...lngs) - Math.min(...lngs) < 0.015;
    const price = group[0].price.transaction_price;
    const isPackage = (zips.size === 1 && group.every((t) => t.zip)) || proximate || (parcels.size >= 3 && price % 1000 !== 0);
    if (!isPackage) continue;
    clusters += 1;
    for (const t of group) {
      t.package_n = parcels.size;
      members += 1;
    }
  }
  return { clusters, members };
}
