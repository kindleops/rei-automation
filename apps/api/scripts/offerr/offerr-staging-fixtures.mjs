/**
 * Offerr staging fixtures — deterministic, rerunnable, staging-only.
 *
 * Seeds the REAL canonical objects the REAL comp loader reads:
 *
 *   public.properties          -> subject rows (resolver + loadSubjectProperty)
 *   public.buyer_comp_raw_v2   -> comp rows    (reached via v_recent_sold_comps
 *                                               by get_comp_candidates_for_subject)
 *   public.buyer_entities_v2   -> buyer buy-box rows (loader's optional enrichment)
 *
 * NOTHING here is injected into the service. The 12-case matrix is expressed
 * purely as database rows; the RPC, the identity join, the buyer-entity join,
 * qualification and clustering all run for real against them.
 *
 * Safety model:
 *   - Every identifier is prefixed OFFERR-STAGING-TEST- so fixtures are
 *     trivially selectable and removable, and so the bootstrap's refuse-to-run
 *     guard can tell synthetic rows from real ones.
 *   - Every address uses a reserved synthetic street token ("Sandbox") that
 *     does not exist in canonical data.
 *   - No production seller, owner, phone, email, campaign, or conversation
 *     record is copied. Every value here is invented.
 *   - The caller MUST pass the offerr-staging-guard before connecting.
 *
 * Deterministic: no randomness, no Date.now(). Comp UUIDs are derived from a
 * stable md5 of the fixture key, so a re-seed produces byte-identical ids and
 * the RPC returns byte-identical rows.
 *
 *
 * WHY EACH CASE HAS ITS OWN COORDINATE ISLAND
 * -------------------------------------------
 * get_comp_candidates_for_subject selects every usable comp within
 * p_radius_miles of the subject — for residential that is 4 miles. The original
 * fixtures placed every Houston subject within ~1 mile of every other, which
 * was harmless while comps were injected per-case but is not harmless now: each
 * subject would pull in every other case's comps, and C09's $332.5M
 * contaminated comp would contaminate C01, C11 and C12 as well.
 *
 * Each case is therefore anchored on its own latitude island 0.25 deg apart
 * (~17 miles), with its comps within ~1.5 miles of their own subject. That is
 * more than double the 4-mile radius, so comp sets are provably disjoint and
 * each case remains an independent scenario.
 *
 * The street/city/ZIP strings are unchanged, because address resolution is
 * driven by those strings and cases 5-8 depend on them. Coordinates are used
 * only by the RPC's distance math and never reach a seller, so decoupling them
 * from the nominal city is a deliberate, documented fixture choice.
 */

import { createHash } from 'node:crypto';

import { normalizeEntityName } from '@/lib/acquisition/transactionClustering.js';

export const FIXTURE_PREFIX = 'OFFERR-STAGING-TEST';
export const FIXTURE_STREET_TOKEN = 'Sandbox';

const pid = (n) => `${FIXTURE_PREFIX}-P${String(n).padStart(3, '0')}`;

/** Deterministic UUID from a stable key — same key always yields the same id. */
function fixtureUuid(key) {
  const h = createHash('md5').update(`offerr-staging::${key}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

/** Longitude shared by every island; separation is purely latitudinal. */
const ISLAND_LON = -95.5;
/** 0.25 deg latitude ~= 17.3 miles: comfortably outside the 4-mile comp radius. */
const island = (n) => 29.0 + n * 0.25;

/**
 * Synthetic canonical property rows. Written to the canonical `properties`
 * table created by the staging bootstrap, so the REAL resolver and the REAL
 * candidate loader execute against a real database.
 */
export const SYNTHETIC_PROPERTIES = Object.freeze([
  // 1. Clean SFR with sufficient qualified comps — island 0
  {
    property_id: pid(1),
    property_address_full: '4100 Sandbox Clean Ln, Houston, TX 77035',
    property_address: '4100 Sandbox Clean Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    total_bedrooms: 3, total_baths: 2, year_built: 1975,
    latitude: island(0), longitude: ISLAND_LON,
  },
  // 2. Conditionally eligible SFR (thin comp support) — island 1
  {
    property_id: pid(2),
    property_address_full: '4200 Sandbox Thin Ln, Houston, TX 77035',
    property_address: '4200 Sandbox Thin Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1380, units_count: 1, estimated_value: 180000,
    total_bedrooms: 3, total_baths: 2, year_built: 1974,
    latitude: island(1), longitude: ISLAND_LON,
  },
  // 3. Small multifamily (supported family SMALL_MULTI) — island 2
  {
    property_id: pid(3),
    property_address_full: '4300 Sandbox Duplex Dr, Austin, TX 78744',
    property_address: '4300 Sandbox Duplex Dr',
    property_address_city: 'Austin', property_address_state: 'TX', property_address_zip: '78744',
    market: 'Austin, TX', property_type: 'Multifamily 2-4', property_class: 'Residential',
    building_square_feet: 1776, units_count: 2, estimated_value: 391000,
    total_bedrooms: 4, total_baths: 2, year_built: 1982,
    latitude: island(2), longitude: ISLAND_LON,
  },
  // 4. Unsupported asset class (commercial) — island 3
  {
    property_id: pid(4),
    property_address_full: '4350 Sandbox Retail Blvd, Houston, TX 77035',
    property_address: '4350 Sandbox Retail Blvd',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'Commercial Retail', property_class: 'Commercial',
    building_square_feet: 12000, units_count: 0, estimated_value: 2400000,
    total_bedrooms: null, total_baths: null, year_built: 1990,
    latitude: island(3), longitude: ISLAND_LON,
  },
  // 5. Ambiguous duplicate address — same street, two different cities.
  //    Resolution-only: never reaches comp loading.
  {
    property_id: pid(5),
    property_address_full: '4400 Sandbox Twin Ave, Houston, TX 77035',
    property_address: '4400 Sandbox Twin Ave',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1350, units_count: 1, estimated_value: 175000,
    total_bedrooms: 3, total_baths: 2, year_built: 1972,
    latitude: island(4), longitude: ISLAND_LON,
  },
  {
    property_id: pid(6),
    property_address_full: '4400 Sandbox Twin Ave, Dallas, TX 75201',
    property_address: '4400 Sandbox Twin Ave',
    property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201',
    market: 'Dallas, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1360, units_count: 1, estimated_value: 265000,
    total_bedrooms: 3, total_baths: 2, year_built: 1973,
    latitude: island(5), longitude: ISLAND_LON,
  },
  // 6. Multi-unit address with missing unit — four units at one street address.
  //    Resolution-only.
  ...[1, 2, 3, 4].map((unit) => ({
    property_id: pid(10 + unit),
    property_address_full: `4500 Sandbox Units Blvd Unit ${unit}, Houston, TX 77035`,
    property_address: `4500 Sandbox Units Blvd Unit ${unit}`,
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'Condo', property_class: 'Residential',
    building_square_feet: 900 + unit * 10, units_count: 1, estimated_value: 140000 + unit * 1000,
    total_bedrooms: 2, total_baths: 1, year_built: 1998,
    latitude: island(6), longitude: ISLAND_LON + unit * 0.0001,
  })),
  // 7. Conflicting ZIP — canonical ZIP differs from what the seller submits.
  //    Resolution-only.
  {
    property_id: pid(20),
    property_address_full: '4600 Sandbox Zipclash Rd, Houston, TX 77035',
    property_address: '4600 Sandbox Zipclash Rd',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1450, units_count: 1, estimated_value: 190000,
    total_bedrooms: 3, total_baths: 2, year_built: 1976,
    latitude: island(7), longitude: ISLAND_LON,
  },
  // 8. (no row — "no property match" case has no canonical property by design)
  // 9. Extreme contaminated comp — island 8
  {
    property_id: pid(30),
    property_address_full: '4700 Sandbox Contam Ln, Houston, TX 77035',
    property_address: '4700 Sandbox Contam Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    total_bedrooms: 3, total_baths: 2, year_built: 1975,
    latitude: island(8), longitude: ISLAND_LON,
  },
  // 10. Package / broadcast comp cluster — island 9
  {
    property_id: pid(31),
    property_address_full: '4800 Sandbox Package Ave, Caldwell, ID 83605',
    property_address: '4800 Sandbox Package Ave',
    property_address_city: 'Caldwell', property_address_state: 'ID', property_address_zip: '83605',
    market: 'Boise, ID', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1550, units_count: 1, estimated_value: 309000,
    total_bedrooms: 3, total_baths: 2, year_built: 2001,
    latitude: island(9), longitude: ISLAND_LON,
  },
  // 11. Seller condition claim conflicting with canonical facts — island 10
  {
    property_id: pid(32),
    property_address_full: '4900 Sandbox Conflict Ln, Houston, TX 77035',
    property_address: '4900 Sandbox Conflict Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    total_bedrooms: 3, total_baths: 2, year_built: 1975,
    latitude: island(10), longitude: ISLAND_LON,
  },
  // 12. Seller asking price materially above independent value — island 11
  {
    property_id: pid(33),
    property_address_full: '5000 Sandbox Overask Ln, Houston, TX 77035',
    property_address: '5000 Sandbox Overask Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    total_bedrooms: 3, total_baths: 2, year_built: 1975,
    latitude: island(11), longitude: ISLAND_LON,
  },
]);

/**
 * Synthetic buyer entities. `normalized_buyer_name` is computed with the SAME
 * normalizeEntityName the loader uses, so the `.in('normalized_buyer_name', …)`
 * join resolves for real rather than by coincidence.
 *
 * purchase_count drives resolveBuyer's archetype ladder:
 *   < 40 -> LOCAL_INVESTOR, 40..199 -> REGIONAL_OPERATOR, >= 200 -> INSTITUTIONAL_SFR.
 */
const BUYER_DEFS = [
  { name: 'Sandbox Bayou Holdings LLC',    purchases: 12,  avg: 178000, markets: ['Houston, TX'] },
  { name: 'Sandbox Cypress Capital LLC',   purchases: 61,  avg: 191000, markets: ['Houston, TX', 'Austin, TX', 'Dallas, TX'] },
  { name: 'Sandbox Prairie Homes LLC',     purchases: 7,   avg: 183000, markets: ['Houston, TX'] },
  { name: 'Sandbox Gulf Residential LLC',  purchases: 24,  avg: 187000, markets: ['Houston, TX'] },
  { name: 'Sandbox Heights Partners LLC',  purchases: 33,  avg: 189000, markets: ['Houston, TX'] },
  { name: 'Sandbox Lonestar Assets LLC',   purchases: 18,  avg: 186000, markets: ['Houston, TX'] },
  { name: 'Sandbox Duplex Ventures LLC',   purchases: 15,  avg: 392000, markets: ['Austin, TX'] },
  // Deliberately high volume: exercises the INSTITUTIONAL_SFR branch and the
  // package-broadcast scenario.
  { name: 'Sandbox National Portfolio REIT', purchases: 480, avg: 2500000, markets: ['Boise, ID', 'Houston, TX'] },
];

export const SYNTHETIC_BUYERS = Object.freeze(
  BUYER_DEFS.map((b, i) => ({
    id: fixtureUuid(`buyer:${b.name}`),
    buyer_key: `${FIXTURE_PREFIX}-BUYER-${String(i + 1).padStart(3, '0')}`,
    buyer_name: b.name,
    normalized_buyer_name: normalizeEntityName(b.name),
    buyer_type: 'corporate',
    is_corporate_buyer: true,
    purchase_count: b.purchases,
    avg_purchase_price: b.avg,
    markets_active: b.markets,
    preferred_asset_classes: ['single_family'],
  })),
);

const BUYER_BY_NAME = new Map(SYNTHETIC_BUYERS.map((b) => [b.buyer_name, b]));

/**
 * Build one buyer_comp_raw_v2 row.
 *
 * Every column v_recent_sold_comps.is_usable_comp requires is populated
 * (coalesced sale price, sale_date, latitude, longitude, property_address_full,
 * property_address_zip) — otherwise the RPC would never return the row.
 */
function comp({
  key, caseId, idx, subjectLat, subjectLon,
  salePrice, saleDate, sqft, beds = 3, baths = 2, yearBuilt = 1975,
  units = 1, assetClass = 'single_family', propertyType = 'Single Family',
  city = 'Houston', state = 'TX', zip = '77035',
  buyer, apn = null, latOffset = null, lonOffset = null,
}) {
  const n = idx;
  // ~0.01 deg latitude ~= 0.7 mi: comfortably inside the 4-mile radius and
  // comfortably inside this case's island.
  const latitude = subjectLat + (latOffset ?? (0.004 + n * 0.0015));
  const longitude = subjectLon + (lonOffset ?? (0.004 + n * 0.0015));
  const recordId = `${FIXTURE_PREFIX}-${caseId}-COMP-${String(n).padStart(2, '0')}`;
  return {
    id: fixtureUuid(key),
    source_record_id: recordId,
    row_hash: `${recordId}-HASH`,
    property_id: `${FIXTURE_PREFIX}-${caseId}-CP${n}`,
    // parcelKeyOf() prefers apn_parcel_id: two rows sharing an APN are the SAME
    // parcel and must collapse as a duplicate, not count as two comps.
    apn_parcel_id: apn ?? `${FIXTURE_PREFIX}-APN-${caseId}-${String(n).padStart(2, '0')}`,
    import_status: 'accepted',
    normalized_asset_class: assetClass,
    property_type: propertyType,
    property_class: 'Residential',
    property_address_full: `${4000 + n} Sandbox Comp Ln, ${city}, ${state} ${zip}`,
    property_address: `${4000 + n} Sandbox Comp Ln`,
    property_address_city: city,
    property_address_state: state,
    property_address_zip: zip,
    latitude,
    longitude,
    sale_price: salePrice,
    sale_date: saleDate,
    recording_date: saleDate,
    // Left NULL on purpose: a non-null mls_sold_price would route every comp to
    // TX_CHANNELS.MLS_ARM_LENGTH and the investor/institutional channel
    // branches would never execute.
    mls_sold_price: null,
    mls_sold_date: null,
    building_square_feet: sqft,
    total_bedrooms: beds,
    total_baths: baths,
    year_built: yearBuilt,
    effective_year_built: yearBuilt,
    units_count: units,
    building_condition: 'Average',
    construction_type: 'Frame',
    subdivision_name: 'Sandbox Estates',
    school_district_name: 'Sandbox ISD',
    // Buyer (grantee) identity — this is what the loader joins to
    // buyer_entities_v2 and what resolveBuyer() classifies.
    owner_name: buyer,
    owner_1_name: buyer,
    is_corporate_owner: true,
    out_of_state_owner: false,
    owner_address_full: '1 Sandbox Corporate Way, Houston, TX 77002',
    document_type: 'Warranty Deed',
    last_sale_doc_type: 'Warranty Deed',
    total_loan_amt: null,
    total_loan_balance: null,
    total_loan_payment: null,
    lienholder_name: null,
    estimated_value: salePrice,
  };
}

/** Healthy comp set anchored on a case's own island. */
function healthyComps(caseId, subjectLat, subjectLon, count) {
  const spec = [
    { salePrice: 182000, saleDate: '2026-05-01', sqft: 1390, beds: 3, baths: 2, buyer: 'Sandbox Bayou Holdings LLC' },
    { salePrice: 191000, saleDate: '2026-04-15', sqft: 1420, beds: 3, baths: 2, buyer: 'Sandbox Cypress Capital LLC' },
    { salePrice: 178000, saleDate: '2026-03-20', sqft: 1350, beds: 3, baths: 1, buyer: 'Sandbox Prairie Homes LLC' },
    { salePrice: 195000, saleDate: '2026-02-10', sqft: 1460, beds: 4, baths: 2, buyer: 'Sandbox Gulf Residential LLC' },
    { salePrice: 186000, saleDate: '2026-01-05', sqft: 1400, beds: 3, baths: 2, buyer: 'Sandbox Heights Partners LLC' },
    { salePrice: 189000, saleDate: '2025-12-12', sqft: 1410, beds: 3, baths: 2, buyer: 'Sandbox Lonestar Assets LLC' },
  ].slice(0, count);
  return spec.map((s, i) =>
    comp({ key: `${caseId}:${i}`, caseId, idx: i, subjectLat, subjectLon, ...s }));
}

const P = new Map(SYNTHETIC_PROPERTIES.map((p) => [p.property_id, p]));
const lat = (id) => P.get(id).latitude;
const lon = (id) => P.get(id).longitude;

/** Every comp row, keyed by the case that owns it. */
export const SYNTHETIC_COMPS = Object.freeze([
  // ── C01: six independent transactions PLUS one duplicate parcel row ──────
  // The duplicate shares comp 0's APN, buyer, date and price, so it lands in
  // comp 0's cluster and must be EXCLUDEd as duplicate_parcel_row rather than
  // counted as a seventh comp. Rows are not transactions.
  ...healthyComps('C01', lat(pid(1)), lon(pid(1)), 6),
  comp({
    key: 'C01:dup', caseId: 'C01', idx: 90,
    subjectLat: lat(pid(1)), subjectLon: lon(pid(1)),
    salePrice: 182000, saleDate: '2026-05-01', sqft: 1390, beds: 3, baths: 2,
    buyer: 'Sandbox Bayou Holdings LLC',
    apn: `${FIXTURE_PREFIX}-APN-C01-00`,
    latOffset: 0.004, lonOffset: 0.004,
  }),

  // ── C02: deliberately thin — two independent transactions only ───────────
  ...healthyComps('C02', lat(pid(2)), lon(pid(2)), 2),

  // ── C03: small multifamily, three duplex transactions ────────────────────
  ...[
    { salePrice: 385000, saleDate: '2026-05-09', sqft: 1728, beds: 4, baths: 2 },
    { salePrice: 402000, saleDate: '2026-04-02', sqft: 1800, beds: 4, baths: 3 },
    { salePrice: 394000, saleDate: '2026-03-11', sqft: 1750, beds: 4, baths: 2 },
  ].map((s, i) =>
    comp({
      key: `C03:${i}`, caseId: 'C03', idx: i,
      subjectLat: lat(pid(3)), subjectLon: lon(pid(3)),
      units: 2, assetClass: 'multifamily', propertyType: 'Multi-Family',
      city: 'Austin', zip: '78744', yearBuilt: 1982,
      buyer: 'Sandbox Duplex Ventures LLC', ...s,
    })),

  // ── C09: three clean transactions + one extreme contaminated comp ────────
  ...healthyComps('C09', lat(pid(30)), lon(pid(30)), 3),
  comp({
    key: 'C09:extreme', caseId: 'C09', idx: 80,
    subjectLat: lat(pid(30)), subjectLon: lon(pid(30)),
    // A portfolio/bulk consideration recorded against a single parcel. Must be
    // quarantined by lane ceiling, PPSF plausibility AND anchor ratio — it can
    // never survive into a seller-facing range.
    salePrice: 332500000, saleDate: '2026-04-09', sqft: 1400, beds: 3, baths: 2,
    buyer: 'Sandbox National Portfolio REIT',
    latOffset: 0.006, lonOffset: 0.006,
  }),

  // ── C10: twelve parcels, ONE economic transaction ────────────────────────
  // Identical buyer, identical date, identical consideration broadcast across
  // 12 distinct parcels -> one cluster, distinct_parcels >= PACKAGE_MIN_PARCELS
  // -> package_sale_probability 0.85 >= 0.5 -> quarantined, contributing ZERO
  // comp depth. sqft varies so similarity_score is distinct per row and the
  // canonical ORDER BY is total (see README "Open production-parity risks").
  ...Array.from({ length: 12 }, (_, i) =>
    comp({
      key: `C10:${i}`, caseId: 'C10', idx: i,
      subjectLat: lat(pid(31)), subjectLon: lon(pid(31)),
      salePrice: 30191000, saleDate: '2026-06-21',
      sqft: 1500 + i * 10, beds: 3, baths: 2, yearBuilt: 2001,
      city: 'Caldwell', state: 'ID', zip: '83605',
      buyer: 'Sandbox National Portfolio REIT',
    })),

  // ── C11 / C12: healthy comp support; the conflict is in the seller facts ──
  ...healthyComps('C11', lat(pid(32)), lon(pid(32)), 6),
  ...healthyComps('C12', lat(pid(33)), lon(pid(33)), 6),
]);

/**
 * The 12-case evaluation matrix. `expect` states the documented behaviour each
 * case must exhibit; the verifier asserts against it.
 *
 * `comps` is GONE by design — comps live in the database now. `comp_expect`
 * documents what the REAL loader + clustering must produce for the case.
 */
export const CASES = Object.freeze([
  {
    id: 'C01_CLEAN_SFR',
    title: 'Clean SFR with sufficient qualified comps',
    address: '4100 Sandbox Clean Ln, Houston, TX 77035',
    subject_property_id: pid(1),
    seller_facts: { condition: 'good', occupancy: 'owner_occupied', repairs: { level: 'cosmetic' }, timeline: '30_days' },
    comp_expect: { rpc_rows: 7, min_effective_sample_size: 6, expect_duplicate_rows: true },
    expect: { resolution: 'RESOLVED', range_allowed: true, outcomes: ['INSTANT_RANGE_ELIGIBLE', 'CONDITIONAL_RANGE', 'REVIEW_REQUIRED'] },
  },
  {
    id: 'C02_CONDITIONAL_SFR',
    title: 'Conditionally eligible SFR (thin comp support)',
    address: '4200 Sandbox Thin Ln, Houston, TX 77035',
    subject_property_id: pid(2),
    seller_facts: { condition: 'fair', repairs: { level: 'moderate' } },
    comp_expect: { rpc_rows: 2, min_effective_sample_size: 2 },
    expect: { resolution: 'RESOLVED', range_allowed: true, outcomes: ['CONDITIONAL_RANGE', 'REVIEW_REQUIRED'] },
  },
  {
    id: 'C03_SMALL_MULTI',
    title: 'Small multifamily property (supported family)',
    address: '4300 Sandbox Duplex Dr, Austin, TX 78744',
    subject_property_id: pid(3),
    seller_facts: { occupancy: 'tenant_occupied' },
    comp_expect: { rpc_rows: 3, min_effective_sample_size: 3 },
    expect: { resolution: 'RESOLVED', range_allowed: true, outcomes: ['INSTANT_RANGE_ELIGIBLE', 'CONDITIONAL_RANGE', 'REVIEW_REQUIRED'] },
  },
  {
    id: 'C04_UNSUPPORTED_ASSET',
    title: 'Unsupported asset class (commercial retail)',
    address: '4350 Sandbox Retail Blvd, Houston, TX 77035',
    subject_property_id: pid(4),
    seller_facts: {},
    comp_expect: { rpc_rows: 0 },
    expect: { resolution: 'RESOLVED', range_allowed: false, outcomes: ['UNSUPPORTED'] },
  },
  {
    id: 'C05_AMBIGUOUS_DUPLICATE',
    title: 'Ambiguous duplicate address (two cities, no city supplied)',
    address: '4400 Sandbox Twin Ave',
    subject_property_id: null,
    seller_facts: {},
    comp_expect: { rpc_rows: null },
    expect: { resolution: 'AMBIGUOUS', range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C06_MISSING_UNIT',
    title: 'Multi-unit address with the unit omitted',
    address: '4500 Sandbox Units Blvd, Houston, TX 77035',
    subject_property_id: null,
    seller_facts: {},
    comp_expect: { rpc_rows: null },
    expect: { resolution: 'AMBIGUOUS', range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C07_CONFLICTING_ZIP',
    title: 'Conflicting ZIP (seller ZIP disagrees with canonical)',
    address: '4600 Sandbox Zipclash Rd, Houston, TX 77099',
    subject_property_id: null,
    seller_facts: {},
    comp_expect: { rpc_rows: null },
    expect: { resolution: ['AMBIGUOUS', 'NOT_FOUND'], range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C08_NO_MATCH',
    title: 'No property match in canonical data',
    address: '9999 Sandbox Missing Way, Houston, TX 77035',
    subject_property_id: null,
    seller_facts: {},
    comp_expect: { rpc_rows: null },
    expect: { resolution: 'NOT_FOUND', range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C09_CONTAMINATED_COMP',
    title: 'Extreme contaminated comp (bulk-portfolio price)',
    address: '4700 Sandbox Contam Ln, Houston, TX 77035',
    subject_property_id: pid(30),
    seller_facts: {},
    comp_expect: { rpc_rows: 4, expect_quarantine: true, quarantined_price: 332500000 },
    expect: { resolution: 'RESOLVED', range_allowed: false, outcomes: ['REVIEW_REQUIRED', 'CONDITIONAL_RANGE'] },
  },
  {
    id: 'C10_PACKAGE_COMPS',
    title: 'Package/broadcast comp cluster (one economic transaction)',
    address: '4800 Sandbox Package Ave, Caldwell, ID 83605',
    subject_property_id: pid(31),
    seller_facts: {},
    comp_expect: { rpc_rows: 12, expect_package_cluster: true, max_effective_sample_size: 0 },
    expect: { resolution: 'RESOLVED', range_allowed: false, outcomes: ['REVIEW_REQUIRED', 'CONDITIONAL_RANGE'] },
  },
  {
    id: 'C11_SELLER_CONDITION_CONFLICT',
    title: 'Seller condition claim conflicts with canonical facts',
    address: '4900 Sandbox Conflict Ln, Houston, TX 77035',
    subject_property_id: pid(32),
    // Seller claims EXCELLENT condition while also disclosing MAJOR repairs.
    // detectOverlayConflicts flags that pair as
    // condition_claim_conflicts_with_repair_disclosure, which must downgrade
    // eligibility away from INSTANT_RANGE_ELIGIBLE.
    seller_facts: { condition: 'excellent', repairs: { level: 'major' }, timeline: 'asap' },
    comp_expect: { rpc_rows: 6, min_effective_sample_size: 6 },
    expect: {
      resolution: 'RESOLVED',
      range_allowed: true,
      downgrade_expected: true,
      expected_conflict: 'condition_claim_conflicts_with_repair_disclosure',
      outcomes: ['CONDITIONAL_RANGE', 'REVIEW_REQUIRED'],
    },
  },
  {
    id: 'C12_ASKING_ABOVE_VALUE',
    title: 'Seller asking price materially above independent value',
    address: '5000 Sandbox Overask Ln, Houston, TX 77035',
    subject_property_id: pid(33),
    // Asking 750k against a 185k canonical estimate — more than 1.5x, which
    // detectOverlayConflicts flags as asking_price_far_above_independent_value.
    seller_facts: { condition: 'good', asking_price: 750000 },
    comp_expect: { rpc_rows: 6, min_effective_sample_size: 6 },
    expect: {
      resolution: 'RESOLVED',
      range_allowed: true,
      downgrade_expected: true,
      expected_conflict: 'asking_price_far_above_independent_value',
      outcomes: ['CONDITIONAL_RANGE', 'REVIEW_REQUIRED'],
    },
  },
]);

const PROPERTY_COLUMNS = [
  'property_id', 'property_export_id', 'property_address_full', 'property_address',
  'property_address_city', 'property_address_state', 'property_address_zip', 'market',
  'property_type', 'property_class', 'building_square_feet', 'units_count',
  'estimated_value', 'total_bedrooms', 'total_baths', 'year_built', 'latitude', 'longitude',
];

const COMP_COLUMNS = [
  'id', 'source_record_id', 'row_hash', 'property_id', 'apn_parcel_id', 'import_status',
  'normalized_asset_class', 'property_type', 'property_class', 'property_address_full',
  'property_address', 'property_address_city', 'property_address_state', 'property_address_zip',
  'latitude', 'longitude', 'sale_price', 'sale_date', 'recording_date', 'mls_sold_price',
  'mls_sold_date', 'building_square_feet', 'total_bedrooms', 'total_baths', 'year_built',
  'effective_year_built', 'units_count', 'building_condition', 'construction_type',
  'subdivision_name', 'school_district_name', 'owner_name', 'owner_1_name',
  'is_corporate_owner', 'out_of_state_owner', 'owner_address_full', 'document_type',
  'last_sale_doc_type', 'total_loan_amt', 'total_loan_balance', 'total_loan_payment',
  'lienholder_name', 'estimated_value',
];

const BUYER_COLUMNS = [
  'id', 'buyer_key', 'buyer_name', 'normalized_buyer_name', 'buyer_type',
  'is_corporate_buyer', 'purchase_count', 'avg_purchase_price', 'markets_active',
  'preferred_asset_classes',
];

/**
 * The canonical objects must already exist. The fixtures deliberately do NOT
 * create them: the staging bootstrap owns that DDL, and a fixture loader that
 * quietly invented its own `properties` table is exactly how staging drifted
 * away from production in the first place.
 */
export async function assertCanonicalSchema(pool) {
  const { rows } = await pool.query(`
    SELECT
      to_regclass('public.properties')          IS NOT NULL AS properties,
      to_regclass('public.buyer_comp_raw_v2')   IS NOT NULL AS comps,
      to_regclass('public.buyer_entities_v2')   IS NOT NULL AS buyers,
      to_regclass('public.v_recent_sold_comps') IS NOT NULL AS view,
      to_regproc('public.get_comp_candidates_for_subject') IS NOT NULL AS rpc`);
  const missing = Object.entries(rows[0]).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `canonical comp schema missing [${missing.join(', ')}] — run offerr-staging-bootstrap.sql first`,
    );
  }
}

async function insertRows(pool, table, columns, rows) {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO public.${table} (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((c) => row[c] ?? null),
    );
  }
  return rows.length;
}

/**
 * Idempotently seed every fixture row. Deletes fixture rows first, so a second
 * run converges to exactly the same state.
 *
 * @returns {Promise<{properties:number, comps:number, buyers:number}>}
 */
export async function seedSyntheticFixtures(pool) {
  await assertCanonicalSchema(pool);
  await cleanupFixtures(pool);

  const properties = await insertRows(
    pool, 'properties', PROPERTY_COLUMNS,
    SYNTHETIC_PROPERTIES.map((p) => ({ ...p, property_export_id: `${p.property_id}-EXPORT` })),
  );
  const comps = await insertRows(pool, 'buyer_comp_raw_v2', COMP_COLUMNS, SYNTHETIC_COMPS);
  const buyers = await insertRows(pool, 'buyer_entities_v2', BUYER_COLUMNS, SYNTHETIC_BUYERS);
  return { properties, comps, buyers };
}

/** Back-compat alias used by older callers. */
export async function seedSyntheticProperties(pool) {
  const seeded = await seedSyntheticFixtures(pool);
  return seeded.properties;
}

/** Remove every fixture artifact. Safe to call repeatedly. */
export async function cleanupFixtures(pool) {
  const like = `${FIXTURE_PREFIX}-%`;
  const counts = {};
  for (const [label, sql, params] of [
    ['offerr_evaluation_events', `DELETE FROM public.offerr_evaluation_events WHERE request_id IN (SELECT id FROM public.offerr_evaluation_requests WHERE idempotency_key LIKE $1)`, [like]],
    ['offerr_evaluations', `DELETE FROM public.offerr_evaluations WHERE request_id IN (SELECT id FROM public.offerr_evaluation_requests WHERE idempotency_key LIKE $1)`, [like]],
    ['offerr_evaluation_requests', `DELETE FROM public.offerr_evaluation_requests WHERE idempotency_key LIKE $1`, [like]],
    ['properties', `DELETE FROM public.properties WHERE property_id LIKE $1`, [like]],
    ['buyer_comp_raw_v2', `DELETE FROM public.buyer_comp_raw_v2 WHERE source_record_id LIKE $1`, [like]],
    ['buyer_entities_v2', `DELETE FROM public.buyer_entities_v2 WHERE buyer_key LIKE $1`, [like]],
  ]) {
    const res = await pool.query(sql, params).catch((error) => {
      // The offerr_* tables may legitimately not exist yet when fixtures are
      // seeded before the evaluation-spine migration is applied.
      if (error.code === '42P01') return { rowCount: 0 };
      throw error;
    });
    counts[label] = res.rowCount;
  }
  return counts;
}

export default {
  FIXTURE_PREFIX,
  FIXTURE_STREET_TOKEN,
  SYNTHETIC_PROPERTIES,
  SYNTHETIC_COMPS,
  SYNTHETIC_BUYERS,
  CASES,
  assertCanonicalSchema,
  seedSyntheticFixtures,
  seedSyntheticProperties,
  cleanupFixtures,
};
