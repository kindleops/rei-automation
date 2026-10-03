/**
 * PROPERTY SALE RECORD — what a comp-derived property id is when it is NOT a
 * canonical property.
 *
 * Comps carry the property_id of the sale corpus (buyer_comp_raw_v2 /
 * comp_canonical_transactions). Many of those ids name a parcel that was sold
 * but never entered the `properties` universe, so the canonical subject read
 * (`/api/cockpit/properties/:id/subject`) honestly answers property_not_found.
 *
 * This read returns the RECORDED SALES for that id from mv_map_market_sales
 * (the published projection of comp_canonical_transactions): what was sold,
 * when, for how much and how the price is known. It is a sale record, labelled
 * as one -- never a property record (no owner, no valuation, no equity, no
 * seller, no deal). Read-only.
 */

const SALE_COLUMNS = [
  'comp_id', 'txn_id', 'source', 'sold_on', 'price', 'price_source', 'is_priced',
  'doc_type', 'is_arms_length', 'is_cash_purchase', 'buyer', 'buyer_kind', 'is_investor',
  'property_id', 'address', 'city', 'state', 'zip', 'lat', 'lng',
  'property_type', 'beds', 'baths', 'sqft', 'year_built', 'units',
].join(',');

const MAX_SALES = 12;

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const firstPresent = (rows, key) => {
  for (const r of rows) {
    const v = r?.[key];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
};

/** Pure: mv_map_market_sales rows (any order) -> the sale-record contract, or null. */
export function shapeSaleRecord(propertyId, rows) {
  const id = clean(propertyId);
  const own = (Array.isArray(rows) ? rows : []).filter((r) => clean(r?.property_id) === id);
  if (!id || !own.length) return null;
  const sorted = [...own].sort((a, b) => String(b.sold_on ?? '').localeCompare(String(a.sold_on ?? '')));
  return {
    kind: 'sale_record',
    property_id: id,
    // Explicit: this id is not a canonical property. Consumers must not offer
    // property surfaces (Deal Intelligence, seller, valuation) for it.
    canonical_property: false,
    address: firstPresent(sorted, 'address'),
    city: firstPresent(sorted, 'city'),
    state: firstPresent(sorted, 'state'),
    zip: firstPresent(sorted, 'zip'),
    lat: numOrNull(firstPresent(sorted, 'lat')),
    lng: numOrNull(firstPresent(sorted, 'lng')),
    property_type: firstPresent(sorted, 'property_type'),
    beds: numOrNull(firstPresent(sorted, 'beds')),
    baths: numOrNull(firstPresent(sorted, 'baths')),
    sqft: numOrNull(firstPresent(sorted, 'sqft')),
    year_built: numOrNull(firstPresent(sorted, 'year_built')),
    units: numOrNull(firstPresent(sorted, 'units')),
    sales: sorted.slice(0, MAX_SALES).map((r) => ({
      comp_id: clean(r.comp_id) || null,
      txn_id: r.txn_id ?? null,
      sold_on: r.sold_on ?? null,
      // a sale with no recorded price stays unpriced -- never estimated here
      price: r.is_priced === false ? null : numOrNull(r.price),
      price_source: r.price_source ?? null,
      source: r.source ?? null,
      doc_type: r.doc_type ?? null,
      is_arms_length: r.is_arms_length ?? null,
      is_cash_purchase: r.is_cash_purchase ?? null,
      buyer: r.buyer ?? null,
      buyer_kind: r.buyer_kind ?? null,
      is_investor: r.is_investor ?? null,
    })),
    sale_count: own.length,
    source: 'mv_map_market_sales',
  };
}

export async function loadPropertySaleRecord(propertyId, deps = {}) {
  const startedAt = Date.now();
  const id = clean(propertyId);
  if (!id) return { ok: false, error: 'missing_property_id', data: null, queryMs: 0 };
  const db = deps.db ?? (await import('@/lib/supabase/client.js')).supabase;
  const { data, error } = await db
    .from('mv_map_market_sales')
    .select(SALE_COLUMNS)
    .eq('property_id', id)
    .order('sold_on', { ascending: false })
    .limit(50);
  if (error) throw error;
  const record = shapeSaleRecord(id, data ?? []);
  return record
    ? { ok: true, error: null, data: record, queryMs: Date.now() - startedAt }
    : { ok: false, error: 'sale_record_not_found', data: null, queryMs: Date.now() - startedAt };
}

export default { loadPropertySaleRecord, shapeSaleRecord };
