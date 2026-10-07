/**
 * CANONICAL CORPUS READS — the comps an operator SEES (Comp Intelligence,
 * Deal Intelligence, the cockpit comps route) come from the canonical
 * transaction corpus (comp_private.comp_canonical_transactions + MLS, via the
 * PROPOSED public.get_v3_sales_candidates RPC over
 * comp_private.mv_v3_sales_candidates), not the frozen v_recent_sold_comps
 * import (newest sale 2026-05-08).
 *
 *   Flag COMPS_CANONICAL_CORPUS_READS (default ON). Off, or RPC not applied
 *   yet -> today's source, with an honest "Comps current through <date>" label.
 *
 * DISPLAY / EVIDENCE ONLY. Valuation authority stays with the acquisition
 * engine and its own flags; nothing here prices or writes. Every comp keeps the
 * engine's eligibility gates (callers run scoreComparable /
 * evaluateCompEligibility on canonicalRowToEngineInput), plus the corpus junk
 * rules and a buyer type label (institutional / investor LLC / investor cash /
 * investor inferred / retail individual / retail MLS / unknown).
 *
 * Self-contained on purpose (no merged-engine imports) so it can ship alone.
 */

export const CANONICAL_CORPUS_RPC = 'get_v3_sales_candidates';
export const CANONICAL_CORPUS_SOURCE = 'comp_canonical_transactions';
export const LEGACY_POOL_SOURCE = 'v_recent_sold_comps';
const RPC_MISSING = new Set(['PGRST202', '42883', 'PGRST205', '42P01']);

const clean = (v) => String(v ?? '').trim();
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

/** Default ON; '0' / 'false' / 'off' / 'no' turns it off. */
export function canonicalCorpusReadsEnabled(env = process.env) {
  const v = clean(env?.COMPS_CANONICAL_CORPUS_READS).toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** "Comps current through 2026-09-10" — the data date, said out loud. */
export function freshnessLabel(latestSale) {
  const d = day(latestSale);
  return d ? `Comps current through ${d}` : 'Comps date not available';
}

export function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => !Number.isFinite(v))) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 'sfr' | 'mf' for the RPC lane parameter, from a normalized engine subject. */
export function corpusLaneOf(subject = {}) {
  const fam = clean(subject.asset_family).toLowerCase();
  const units = num(subject.units ?? subject.units_count);
  return fam === 'multifamily' || (units !== null && units >= 2) ? 'mf' : 'sfr';
}

const INSTITUTIONAL = [
  /invitation homes/, /progress residential/, /american homes 4 rent|\bah4r\b/, /tricon/, /firstkey|first key homes/, /amherst/,
  /main street renewal/, /vinebrook/, /home partners/, /pretium/, /cerberus/, /\brenu\b/, /opendoor/, /offerpad/, /roofstock/,
  /divvy homes/, /\bmynd\b/, /front yard residential/, /blackstone/, /\bsfr3\b/, /bridge single.?family/, /havenbrook/, /conrex/,
];
const ENTITY_RE = /\b(llc|l\.l\.c|inc|corp|corporation|company|lp|llp|ltd|holdings?|propert(y|ies)|investments?|capital|homes|realty|partners|ventures|group|trust|fund|enterprises?|reit)\b/i;

/** Buyer type shown on every comp. */
export function canonicalCompBuyerType(row = {}) {
  const name = clean(row.buyer).toLowerCase();
  if (row.source === 'mls') return 'retail_mls';
  if (clean(row.buyer_class) === 'institutional' || (name && INSTITUTIONAL.some((re) => re.test(name)))) return 'institutional';
  if (clean(row.buyer_kind) === 'company' || ['llc_investor', 'portfolio'].includes(clean(row.buyer_class)) || row.is_investor === true || ENTITY_RE.test(name)) return 'investor_llc';
  if (row.is_cash_purchase === true) return 'investor_cash';
  if (row.owner_linked === true && row.owner_corporate === true) return 'investor_inferred';
  if (clean(row.buyer_kind) === 'person' || clean(row.buyer_class) === 'individual') return 'retail_individual';
  return 'unknown';
}
export const BUYER_TYPE_LABELS = Object.freeze({
  institutional: 'Institutional buyer',
  investor_llc: 'Investor (LLC / entity)',
  investor_cash: 'Investor (cash)',
  investor_inferred: 'Investor (entity owner of record)',
  retail_individual: 'Retail (individual)',
  retail_mls: 'Retail (MLS)',
  unknown: 'Buyer not recorded',
});

const DISTRESSED_DEED = /(trustee|sheriff|in lieu|foreclos|certificate of transfer|public action|correction|re-recorded|mortgage|gift|intrafamily|transfer on death|distribution|affidavit|referee|commissioner|special master|quit ?claim|contract of sale|agreement of sale|tax deed)/i;

/** Corpus junk rules (never-a-market-price sales). Returns reason codes ([] = clean). */
export function canonicalJunkReasons(row = {}) {
  const r = [];
  const price = num(row.price);
  if (!(price > 0)) r.push('nominal_price');
  else if (price < 25_000) r.push('junk_price_below_25k');
  if (row.is_arms_length === false) r.push('non_arms_length');
  if (row.doc_type && DISTRESSED_DEED.test(row.doc_type)) r.push('distress_or_transfer_deed');
  if ((num(row.portfolio_size) ?? 1) >= 2) r.push('portfolio_deed');
  if ((num(row.bulk_parcels_zip) ?? 1) >= 2 || (num(row.bulk_parcels_city) ?? 1) >= 3) r.push('multi_parcel_consideration');
  if (['builder', 'bank', 'government'].includes(clean(row.buyer_class))) r.push('builder_bank_or_government_buyer');
  const yb = pos(row.year_built);
  const saleYear = Number(String(day(row.sold_on)).slice(0, 4));
  if (yb && saleYear && yb >= saleYear - 1) r.push('new_construction');
  return r;
}

/** Canonical row -> the production engine comp row (so scoreComparable / evaluateCompEligibility apply unchanged). */
export function canonicalRowToEngineInput(row = {}, subject = {}) {
  const mls = row.source === 'mls';
  const repairKnown = num(row.estimated_repair_cost) !== null;
  const d = num(row.distance_miles) ?? haversineMiles(num(subject.latitude), num(subject.longitude), num(row.lat), num(row.lng));
  return {
    id: row.comp_id,
    comp_id: row.comp_id,
    property_id: row.property_id,
    property_address_full: row.address,
    address: row.address,
    property_address_city: row.city,
    property_address_state: row.state,
    property_address_zip: row.zip,
    latitude: num(row.lat),
    longitude: num(row.lng),
    sale_price: num(row.price),
    sale_date: day(row.sold_on),
    mls_sold_price: mls ? num(row.price) : null,
    mls_sold_date: mls ? day(row.sold_on) : null,
    property_type: row.property_type,
    units_count: pos(row.units),
    total_bedrooms: num(row.beds),
    total_baths: num(row.baths),
    building_square_feet: num(row.sqft),
    year_built: num(row.year_built),
    lot_square_feet: num(row.lot_sqft),
    subdivision_name: row.subdivision_name ?? null,
    estimated_value: num(row.estimated_value),
    estimated_repair_cost: repairKnown ? num(row.estimated_repair_cost) : num(subject?.estimated_repairs),
    distance_miles: d === null ? null : Math.round(d * 100) / 100,
    source: 'mv_map_market_sales',
  };
}

/**
 * One bounded, geo + date indexed read. Never throws for a missing RPC:
 * { available:false, reason:'canonical_rpc_not_applied' } and the caller keeps
 * today's source. Rows are strictly before asOf (default tomorrow).
 */
export async function fetchCanonicalCorpusComps(client, { lat, lng, radiusMiles, months, lane = 'sfr', asOf = null, limit = 300, now = new Date() } = {}, { env = process.env } = {}) {
  if (!canonicalCorpusReadsEnabled(env)) return { available: false, reason: 'flag_off', rows: [] };
  if (!Number.isFinite(num(lat)) || !Number.isFinite(num(lng))) return { available: false, reason: 'no_subject_coordinates', rows: [] };
  const end = asOf ? new Date(`${day(asOf)}T00:00:00Z`) : new Date(now.getTime() + 86_400_000);
  const since = new Date(end);
  since.setUTCMonth(since.getUTCMonth() - Math.max(1, Math.round(num(months) ?? 24)));
  const t0 = Date.now();
  try {
    const { data, error } = await client.rpc(CANONICAL_CORPUS_RPC, {
      p_lat: num(lat), p_lng: num(lng), p_radius_miles: num(radiusMiles) ?? 2.5,
      p_since: day(since), p_as_of: day(end), p_lane: lane === 'mf' ? 'mf' : 'sfr', p_limit: Math.min(9000, Math.max(1, limit)),
    });
    if (error) {
      if (RPC_MISSING.has(clean(error.code)) || /could not find the function|does not exist/i.test(clean(error.message))) return { available: false, reason: 'canonical_rpc_not_applied', rows: [] };
      return { available: false, reason: 'read_failed', error: clean(error.message).slice(0, 200), rows: [] };
    }
    // A set-returning RPC answers with an array ([] when empty); anything else is not this RPC.
    if (!Array.isArray(data)) return { available: false, reason: 'canonical_rpc_unexpected_response', rows: [] };
    const rows = data.map((r) => ({
      ...r,
      distance_miles: (() => { const d = haversineMiles(num(lat), num(lng), num(r.lat), num(r.lng)); return d === null ? null : Math.round(d * 100) / 100; })(),
      buyer_type: canonicalCompBuyerType(r),
      junk_reasons: canonicalJunkReasons(r),
    }));
    const latestSale = rows.map((r) => day(r.sold_on)).filter(Boolean).sort().pop() ?? null;
    return { available: true, source: CANONICAL_CORPUS_SOURCE, rows, latestSale, label: freshnessLabel(latestSale), latencyMs: Date.now() - t0 };
  } catch (error) {
    return { available: false, reason: 'read_failed', error: clean(error?.message).slice(0, 200), rows: [] };
  }
}
