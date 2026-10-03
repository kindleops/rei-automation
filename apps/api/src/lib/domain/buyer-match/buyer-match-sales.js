/**
 * BUYER MATCH SALES ADAPTER — the one server-side read of recorded sales for
 * Buyer Match (engine comps, the workspace comp panel, the buyer-command
 * purchase feed). Every Buyer Match path reads sales through this module.
 *
 * SOURCE: public.mv_map_market_sales — the published projection of
 * comp_private.comp_canonical_transactions (+ the engine pool's MLS closes),
 * deduplicated with ic8_txn_dedupe@1 parity, geocoded, last 5 years, refreshed
 * daily by pg_cron refresh_map_market_sales. One row = one economic sale; the
 * unique key is comp_id ('t:<canonical txn id>' or 'p:<pool id>').
 *
 * Why the MV and not comp_canonical_transactions directly: the raw table has no
 * geography (lat/lng/zip live in comp_properties / properties), is not
 * deduplicated against the MLS pool, and carries raw buyer_1_name (person names).
 * The MV already resolves geo, dedupes, classifies buyers (buyer_class,
 * is_investor) and exposes only COMPANY buyer names. It is service_role-only, so
 * the browser reads it through /api/cockpit/buyer-match/sales.
 *
 * PRICE RULE (owner, locked 2026-10-02):
 *   price > 0                -> usable priced comp evidence
 *   price zero / NULL        -> may count as transaction ACTIVITY (purchase
 *                               counts), never as a priced comp, a price stat
 *                               or a ppsf.
 *
 * LEGACY: the frozen recently-sold import (ends 2026-02-06) is not a Buyer
 * Match source. tests/unit/buyer-match-sales-legacy-guard.test.mjs fails if any
 * new code reads it.
 */
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js';

export const BUYER_MATCH_SALES_SOURCE = 'mv_map_market_sales';
export const BUYER_MATCH_SALES_KEY = 'comp_id';

export const SALES_COLUMNS = [
  'comp_id', 'txn_id', 'source', 'sold_on', 'price', 'is_priced', 'price_source',
  'doc_type', 'is_arms_length', 'is_cash_purchase', 'buyer', 'buyer_kind', 'buyer_class',
  'is_investor', 'portfolio_size', 'property_id', 'address', 'city', 'state', 'zip',
  'lat', 'lng', 'property_type', 'beds', 'baths', 'sqft', 'year_built', 'units',
].join(',');

/** Progressive search radii (miles). The first radius with enough sales wins. */
export const DEFAULT_RADII_MILES = [1, 3, 10, 25];
const MAX_RADIUS_MILES = 25;
const READ_CAP = 500;
const MILES_PER_DEG_LAT = 68.5;

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const clampInt = (v, lo, hi, dflt) => {
  const n = num(v);
  if (n === null) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

export function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || !Number.isFinite(v))) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.7559 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The owner's price rule: a priced sale is price > 0 and nothing else. */
export function isPricedSale(row) {
  const p = num(row?.price);
  return p !== null && p > 0;
}

/**
 * Pure: one MV row -> the Buyer Match sale contract. Unpriced sales keep
 * price = null and ppsf = null (activity only). Person buyer names are never
 * emitted: only a displayable company name survives.
 */
export function shapeSale(row, origin = null) {
  const priced = isPricedSale(row);
  const price = priced ? num(row.price) : null;
  const sqft = num(row.sqft);
  const portfolio = num(row.portfolio_size) ?? 1;
  const lat = num(row.lat);
  const lng = num(row.lng);
  const distance = origin && origin.lat !== null && origin.lng !== null && lat !== null && lng !== null
    ? haversineMiles(origin.lat, origin.lng, lat, lng)
    : null;
  return {
    comp_id: clean(row.comp_id),
    txn_id: row.txn_id ?? null,
    property_id: clean(row.property_id) || null,
    sold_on: row.sold_on ?? null,
    price,
    is_priced: priced,
    // A bulk/portfolio deed's price is for many doors: never a per-sqft figure.
    ppsf: priced && sqft !== null && sqft > 0 && portfolio < 2 ? Math.round(price / sqft) : null,
    sale_source: row.source === 'mls' ? 'mls' : 'public_record',
    price_source: row.price_source ?? null,
    doc_type: row.doc_type ?? null,
    is_arms_length: row.is_arms_length ?? null,
    is_cash_purchase: row.is_cash_purchase ?? null,
    buyer: displayableCompanyName(row.buyer),
    buyer_kind: row.buyer_kind ?? null,
    buyer_class: row.buyer_class ?? null,
    is_investor: row.is_investor === true,
    portfolio_size: portfolio,
    address: row.address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
    lat,
    lng,
    property_type: row.property_type ?? null,
    beds: num(row.beds),
    baths: num(row.baths),
    sqft,
    year_built: num(row.year_built),
    units: num(row.units),
    distance_miles: distance === null ? null : Math.round(distance * 100) / 100,
  };
}

/** Pure: keep the first row per canonical key. One economic sale = one row. */
export function dedupeSales(rows) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = clean(r?.[BUYER_MATCH_SALES_KEY]);
    if (!key) { duplicates += 1; continue; }
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    out.push(r);
  }
  return { rows: out, duplicates };
}

/** Throws if the adapter output repeats a canonical key (contract assertion). */
export function assertUniqueSales(sales) {
  const seen = new Set();
  for (const s of sales) {
    const key = clean(s?.[BUYER_MATCH_SALES_KEY]);
    if (!key || seen.has(key)) throw new Error(`buyer_match_sales_duplicate_key:${key || '(empty)'}`);
    seen.add(key);
  }
  return true;
}

/** Pure: normalise a request into a bounded query. */
export function normalizeSalesQuery(q = {}) {
  const lat = num(q.lat ?? q.latitude);
  const lng = num(q.lng ?? q.longitude);
  const hasGeo = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const zip = clean(q.zip).slice(0, 5);
  const state = clean(q.state).toUpperCase().slice(0, 2);
  const priced = q.priced === 'all' ? 'all' : 'only';
  return {
    lat: hasGeo ? lat : null,
    lng: hasGeo ? lng : null,
    zip: /^\d{5}$/.test(zip) ? zip : null,
    state: /^[A-Z]{2}$/.test(state) ? state : null,
    property_type: clean(q.property_type ?? q.propertyType) || null,
    radius_miles: Math.min(MAX_RADIUS_MILES, Math.max(0.5, num(q.radius_miles ?? q.radius) ?? MAX_RADIUS_MILES)),
    months: clampInt(q.months, 1, 60, 24),
    limit: clampInt(q.limit, 1, READ_CAP, 20),
    priced,
  };
}

function sinceDate(months, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function baseQuery(db, q, since) {
  let query = db.from(BUYER_MATCH_SALES_SOURCE).select(SALES_COLUMNS).gte('sold_on', since);
  if (q.priced === 'only') query = query.gt('price', 0);
  if (q.property_type) query = query.eq('property_type', q.property_type);
  return query;
}

/**
 * Read Buyer Match sales. Strategy, in order:
 *   geo    lat/lng present: progressive radii (1, 3, 10, 25 mi, capped at
 *          radius_miles) over the covering (lat, lng) index; first radius with
 *          >= limit sales wins; results ordered by distance, then recency.
 *   zip    no coordinates: the subject's zip, most recent first.
 *   state  neither: the state, most recent first.
 * Returns { sales, meta }. Never throws on an empty result; throws on a DB error.
 */
export async function loadBuyerMatchSales(rawQuery = {}, deps = {}) {
  const startedAt = Date.now();
  const q = normalizeSalesQuery(rawQuery);
  const db = deps.db ?? (await import('@/lib/supabase/client.js')).supabase;
  const since = sinceDate(q.months, deps.now ? new Date(deps.now) : new Date());
  let rows = [];
  let strategy = 'none';
  let radiusUsed = null;
  let queries = 0;
  let lastBatch = 0;

  if (q.lat !== null) {
    strategy = 'geo';
    const radii = [...DEFAULT_RADII_MILES.filter((r) => r < q.radius_miles), q.radius_miles];
    for (const r of radii) {
      const dLat = r / MILES_PER_DEG_LAT;
      const dLng = r / (MILES_PER_DEG_LAT * Math.max(Math.cos((q.lat * Math.PI) / 180), 0.05));
      const { data, error } = await baseQuery(db, q, since)
        .gte('lat', q.lat - dLat).lte('lat', q.lat + dLat)
        .gte('lng', q.lng - dLng).lte('lng', q.lng + dLng)
        .order('sold_on', { ascending: false })
        .limit(READ_CAP);
      queries += 1;
      if (error) throw error;
      lastBatch = (data ?? []).length;
      const within = (data ?? []).filter((row) => {
        const d = haversineMiles(q.lat, q.lng, num(row.lat), num(row.lng));
        return d !== null && d <= r;
      });
      rows = within;
      radiusUsed = r;
      if (within.length >= q.limit) break;
    }
  } else if (q.zip || q.state) {
    strategy = q.zip ? 'zip' : 'state';
    let query = baseQuery(db, q, since);
    query = q.zip ? query.eq('zip', q.zip) : query.eq('state', q.state);
    const { data, error } = await query.order('sold_on', { ascending: false }).limit(READ_CAP);
    queries += 1;
    if (error) throw error;
    rows = data ?? [];
    lastBatch = rows.length;
  }

  const { rows: unique, duplicates } = dedupeSales(rows);
  const origin = q.lat !== null ? { lat: q.lat, lng: q.lng } : null;
  let sales = unique
    .map((r) => shapeSale(r, origin))
    // Defence in depth: priced mode never lets an unpriced sale through.
    .filter((s) => q.priced === 'all' || s.is_priced);
  sales.sort((a, b) => {
    if (origin && a.distance_miles !== b.distance_miles) {
      if (a.distance_miles === null) return 1;
      if (b.distance_miles === null) return -1;
      return a.distance_miles - b.distance_miles;
    }
    return String(b.sold_on ?? '').localeCompare(String(a.sold_on ?? ''));
  });
  sales = sales.slice(0, q.limit);
  assertUniqueSales(sales);

  return {
    sales,
    meta: {
      source: BUYER_MATCH_SALES_SOURCE,
      key: BUYER_MATCH_SALES_KEY,
      strategy,
      radius_miles: radiusUsed,
      months: q.months,
      since,
      priced: q.priced,
      rows_read: rows.length,
      // the read hit its cap: counts are the most recent READ_CAP, not a census
      truncated: lastBatch >= READ_CAP,
      duplicates_dropped: duplicates,
      priced_count: sales.filter((s) => s.is_priced).length,
      latest_sold_on: sales.reduce((m, s) => (s.sold_on && (!m || s.sold_on > m) ? s.sold_on : m), null),
      queries,
      query_ms: Date.now() - startedAt,
    },
  };
}

/** Pure: a priced sale -> the comp shape the engine and the workspace render. */
export function toBuyerMatchComp(sale) {
  if (!sale?.is_priced) return null;
  return {
    id: sale.comp_id,
    comp_id: sale.comp_id,
    property_id: sale.property_id,
    address: sale.address || 'Address Unknown',
    city: sale.city || undefined,
    state: sale.state || undefined,
    zip: sale.zip || undefined,
    sold_price: sale.price,
    sold_date: sale.sold_on,
    beds: sale.beds,
    baths: sale.baths,
    sqft: sale.sqft,
    ppsf: sale.ppsf,
    latitude: sale.lat,
    longitude: sale.lng,
    property_type: sale.property_type || undefined,
    source_type: 'CANONICAL_SALE',
    sale_source: sale.sale_source,
    buyer: sale.buyer,
    buyer_class: sale.buyer_class,
    is_investor: sale.is_investor,
    distance_miles: sale.distance_miles,
  };
}

/** Nearest priced sold comps for a Buyer Match subject (engine + workspace). */
export async function loadBuyerMatchComps(subject = {}, opts = {}, deps = {}) {
  const res = await loadBuyerMatchSales({
    lat: subject.lat,
    lng: subject.lng,
    zip: subject.zip,
    // no state fallback: a state-wide "most recent" list is not a nearby comp set
    radius_miles: opts.radius_miles ?? 25,
    months: opts.months ?? 24,
    limit: opts.limit ?? 12,
    priced: 'only',
  }, deps);
  return { comps: res.sales.map(toBuyerMatchComp).filter(Boolean), meta: res.meta };
}

export default { loadBuyerMatchSales, loadBuyerMatchComps, shapeSale, dedupeSales, isPricedSale, toBuyerMatchComp };
