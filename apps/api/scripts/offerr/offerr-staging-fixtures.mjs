/**
 * Offerr staging fixtures — deterministic, rerunnable, staging-only.
 *
 * Provides the synthetic canonical `properties` rows that drive the REAL Offerr
 * address resolver, plus the 12-case evaluation matrix (comps, seller-claimed
 * facts, and the documented expectation for each case).
 *
 * Safety model:
 *   - Every identifier is prefixed OFFERR-STAGING-TEST- so fixtures are
 *     trivially selectable and removable.
 *   - Every address uses a reserved synthetic street token ("Sandbox") that
 *     does not exist in canonical data.
 *   - No production seller, owner, phone, email, campaign, or conversation
 *     record is copied. Every value here is invented.
 *   - The caller MUST pass the offerr-staging-guard before connecting.
 *
 * Deterministic: no randomness, no Date.now(). Rerunnable: seeding deletes the
 * fixture rows first, so a second run converges to the same state.
 */

export const FIXTURE_PREFIX = 'OFFERR-STAGING-TEST';
export const FIXTURE_STREET_TOKEN = 'Sandbox';

const pid = (n) => `${FIXTURE_PREFIX}-P${String(n).padStart(3, '0')}`;

/**
 * Synthetic canonical property rows. Written to a verification-scoped
 * `properties` table so the REAL resolver and REAL candidate loader execute
 * against a real database.
 */
export const SYNTHETIC_PROPERTIES = Object.freeze([
  // 1. Clean SFR with sufficient qualified comps
  {
    property_id: pid(1),
    property_address_full: '4100 Sandbox Clean Ln, Houston, TX 77035',
    property_address: '4100 Sandbox Clean Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    latitude: 29.65086, longitude: -95.50109,
  },
  // 2. Conditionally eligible SFR (thin comp support)
  {
    property_id: pid(2),
    property_address_full: '4200 Sandbox Thin Ln, Houston, TX 77035',
    property_address: '4200 Sandbox Thin Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1380, units_count: 1, estimated_value: 180000,
    latitude: 29.65100, longitude: -95.50200,
  },
  // 3. Small multifamily (supported family SMALL_MULTI)
  {
    property_id: pid(3),
    property_address_full: '4300 Sandbox Duplex Dr, Austin, TX 78744',
    property_address: '4300 Sandbox Duplex Dr',
    property_address_city: 'Austin', property_address_state: 'TX', property_address_zip: '78744',
    market: 'Austin, TX', property_type: 'Multifamily 2-4', property_class: 'Residential',
    building_square_feet: 1776, units_count: 2, estimated_value: 391000,
    latitude: 30.20000, longitude: -97.75000,
  },
  // 4. Unsupported asset class (commercial)
  {
    property_id: pid(4),
    property_address_full: '4350 Sandbox Retail Blvd, Houston, TX 77035',
    property_address: '4350 Sandbox Retail Blvd',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'Commercial Retail', property_class: 'Commercial',
    building_square_feet: 12000, units_count: 0, estimated_value: 2400000,
    latitude: 29.65300, longitude: -95.50400,
  },
  // 5. Ambiguous duplicate address — same street, two different cities
  {
    property_id: pid(5),
    property_address_full: '4400 Sandbox Twin Ave, Houston, TX 77035',
    property_address: '4400 Sandbox Twin Ave',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1350, units_count: 1, estimated_value: 175000,
    latitude: 29.65400, longitude: -95.50500,
  },
  {
    property_id: pid(6),
    property_address_full: '4400 Sandbox Twin Ave, Dallas, TX 75201',
    property_address: '4400 Sandbox Twin Ave',
    property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201',
    market: 'Dallas, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1360, units_count: 1, estimated_value: 265000,
    latitude: 32.78000, longitude: -96.80000,
  },
  // 6. Multi-unit address with missing unit — four units at one street address
  ...[1, 2, 3, 4].map((unit) => ({
    property_id: pid(10 + unit),
    property_address_full: `4500 Sandbox Units Blvd Unit ${unit}, Houston, TX 77035`,
    property_address: `4500 Sandbox Units Blvd Unit ${unit}`,
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'Condo', property_class: 'Residential',
    building_square_feet: 900 + unit * 10, units_count: 1, estimated_value: 140000 + unit * 1000,
    latitude: 29.65500, longitude: -95.50600,
  })),
  // 7. Conflicting ZIP — canonical ZIP differs from what the seller submits
  {
    property_id: pid(20),
    property_address_full: '4600 Sandbox Zipclash Rd, Houston, TX 77035',
    property_address: '4600 Sandbox Zipclash Rd',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1450, units_count: 1, estimated_value: 190000,
    latitude: 29.65600, longitude: -95.50700,
  },
  // 8. (no row — "no property match" case has no canonical property by design)
  // 9. Extreme contaminated comp
  {
    property_id: pid(30),
    property_address_full: '4700 Sandbox Contam Ln, Houston, TX 77035',
    property_address: '4700 Sandbox Contam Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    latitude: 29.65700, longitude: -95.50800,
  },
  // 10. Package / broadcast comp cluster
  {
    property_id: pid(31),
    property_address_full: '4800 Sandbox Package Ave, Caldwell, ID 83605',
    property_address: '4800 Sandbox Package Ave',
    property_address_city: 'Caldwell', property_address_state: 'ID', property_address_zip: '83605',
    market: 'Boise, ID', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1550, units_count: 1, estimated_value: 309000,
    latitude: 43.66000, longitude: -116.68000,
  },
  // 11. Seller condition claim conflicting with canonical facts
  {
    property_id: pid(32),
    property_address_full: '4900 Sandbox Conflict Ln, Houston, TX 77035',
    property_address: '4900 Sandbox Conflict Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    latitude: 29.65800, longitude: -95.50900,
  },
  // 12. Seller asking price materially above independent value
  {
    property_id: pid(33),
    property_address_full: '5000 Sandbox Overask Ln, Houston, TX 77035',
    property_address: '5000 Sandbox Overask Ln',
    property_address_city: 'Houston', property_address_state: 'TX', property_address_zip: '77035',
    market: 'Houston, TX', property_type: 'SFR', property_class: 'Residential',
    building_square_feet: 1400, units_count: 1, estimated_value: 185000,
    latitude: 29.65900, longitude: -95.51000,
  },
]);

/** Healthy Houston comp set: tight, recent, same ZIP, believable prices. */
function houstonComps(prefix) {
  return [
    { sale_price: 182000, sale_date: '2026-05-01', sqft: 1390 },
    { sale_price: 191000, sale_date: '2026-04-15', sqft: 1420 },
    { sale_price: 178000, sale_date: '2026-03-20', sqft: 1350 },
    { sale_price: 195000, sale_date: '2026-02-10', sqft: 1460 },
    { sale_price: 186000, sale_date: '2026-01-05', sqft: 1400 },
    { sale_price: 189000, sale_date: '2025-12-12', sqft: 1410 },
  ].map((c, i) => ({
    property_id: `${prefix}-C${i}`,
    property_address_full: `${4000 + i} Sandbox Comp Ln, Houston, TX 77035`,
    property_address_zip: '77035',
    property_type: 'Single Family',
    units_count: 1,
    building_square_feet: c.sqft,
    sale_price: c.sale_price,
    sale_date: c.sale_date,
    latitude: 29.651 + i * 0.0005,
    longitude: -95.501 - i * 0.0005,
  }));
}

/**
 * The 12-case evaluation matrix. `expect` states the documented behaviour each
 * case must exhibit; the verifier asserts against it.
 */
export const CASES = Object.freeze([
  {
    id: 'C01_CLEAN_SFR',
    title: 'Clean SFR with sufficient qualified comps',
    address: '4100 Sandbox Clean Ln, Houston, TX 77035',
    subject_property_id: pid(1),
    comps: houstonComps('c01'),
    seller_facts: { condition: 'good', occupancy: 'owner_occupied', repairs: { level: 'cosmetic' }, timeline: '30_days' },
    expect: { resolution: 'RESOLVED', range_allowed: true, outcomes: ['INSTANT_RANGE_ELIGIBLE', 'CONDITIONAL_RANGE', 'REVIEW_REQUIRED'] },
  },
  {
    id: 'C02_CONDITIONAL_SFR',
    title: 'Conditionally eligible SFR (thin comp support)',
    address: '4200 Sandbox Thin Ln, Houston, TX 77035',
    subject_property_id: pid(2),
    comps: houstonComps('c02').slice(0, 2),
    seller_facts: { condition: 'fair', repairs: { level: 'moderate' } },
    expect: { resolution: 'RESOLVED', range_allowed: true, outcomes: ['CONDITIONAL_RANGE', 'REVIEW_REQUIRED'] },
  },
  {
    id: 'C03_SMALL_MULTI',
    title: 'Small multifamily property (supported family)',
    address: '4300 Sandbox Duplex Dr, Austin, TX 78744',
    subject_property_id: pid(3),
    comps: [
      { property_id: 'c03-C0', property_address_full: '4301 Sandbox Comp Dr, Austin, TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1728, sale_price: 385000, sale_date: '2026-05-09' },
      { property_id: 'c03-C1', property_address_full: '4302 Sandbox Comp Dr, Austin, TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1800, sale_price: 402000, sale_date: '2026-04-02' },
      { property_id: 'c03-C2', property_address_full: '4303 Sandbox Comp Dr, Austin, TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1750, sale_price: 394000, sale_date: '2026-03-11' },
    ],
    seller_facts: { occupancy: 'tenant_occupied' },
    expect: { resolution: 'RESOLVED', range_allowed: true, outcomes: ['INSTANT_RANGE_ELIGIBLE', 'CONDITIONAL_RANGE', 'REVIEW_REQUIRED'] },
  },
  {
    id: 'C04_UNSUPPORTED_ASSET',
    title: 'Unsupported asset class (commercial retail)',
    address: '4350 Sandbox Retail Blvd, Houston, TX 77035',
    subject_property_id: pid(4),
    comps: [],
    seller_facts: {},
    expect: { resolution: 'RESOLVED', range_allowed: false, outcomes: ['UNSUPPORTED'] },
  },
  {
    id: 'C05_AMBIGUOUS_DUPLICATE',
    title: 'Ambiguous duplicate address (two cities, no city supplied)',
    address: '4400 Sandbox Twin Ave',
    subject_property_id: null,
    comps: [],
    seller_facts: {},
    expect: { resolution: 'AMBIGUOUS', range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C06_MISSING_UNIT',
    title: 'Multi-unit address with the unit omitted',
    address: '4500 Sandbox Units Blvd, Houston, TX 77035',
    subject_property_id: null,
    comps: [],
    seller_facts: {},
    expect: { resolution: 'AMBIGUOUS', range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C07_CONFLICTING_ZIP',
    title: 'Conflicting ZIP (seller ZIP disagrees with canonical)',
    address: '4600 Sandbox Zipclash Rd, Houston, TX 77099',
    subject_property_id: null,
    comps: [],
    seller_facts: {},
    expect: { resolution: ['AMBIGUOUS', 'NOT_FOUND'], range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C08_NO_MATCH',
    title: 'No property match in canonical data',
    address: '9999 Sandbox Missing Way, Houston, TX 77035',
    subject_property_id: null,
    comps: [],
    seller_facts: {},
    expect: { resolution: 'NOT_FOUND', range_allowed: false, outcomes: ['REVIEW_REQUIRED'] },
  },
  {
    id: 'C09_CONTAMINATED_COMP',
    title: 'Extreme contaminated comp (bulk-portfolio price)',
    address: '4700 Sandbox Contam Ln, Houston, TX 77035',
    subject_property_id: pid(30),
    comps: [
      ...houstonComps('c09').slice(0, 3),
      // A single absurd sale price — a portfolio/bulk transaction recorded
      // against one parcel. Must never survive into a seller-facing range.
      { property_id: 'c09-EXTREME', property_address_full: '4799 Sandbox Comp Ln, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1400, sale_price: 332500000, sale_date: '2026-04-09' },
    ],
    seller_facts: {},
    expect: { resolution: 'RESOLVED', range_allowed: false, outcomes: ['REVIEW_REQUIRED', 'CONDITIONAL_RANGE'] },
  },
  {
    id: 'C10_PACKAGE_COMPS',
    title: 'Package/broadcast comp cluster (one economic transaction)',
    address: '4800 Sandbox Package Ave, Caldwell, ID 83605',
    subject_property_id: pid(31),
    // 12 parcels, identical price and identical date == one bulk deal.
    comps: Array.from({ length: 12 }, (_, i) => ({
      property_id: `c10-PKG${i}`,
      property_address_full: `${4800 + i} Sandbox Package Ave, Caldwell, ID 83605`,
      property_address_zip: '83605',
      property_type: 'Single Family',
      units_count: 1,
      building_square_feet: 1500 + i * 10,
      sale_price: 30191000,
      sale_date: '2026-06-21',
    })),
    seller_facts: {},
    expect: { resolution: 'RESOLVED', range_allowed: false, outcomes: ['REVIEW_REQUIRED', 'CONDITIONAL_RANGE'] },
  },
  {
    id: 'C11_SELLER_CONDITION_CONFLICT',
    title: 'Seller condition claim conflicts with canonical facts',
    address: '4900 Sandbox Conflict Ln, Houston, TX 77035',
    subject_property_id: pid(32),
    comps: houstonComps('c11'),
    // Seller claims EXCELLENT condition while also disclosing MAJOR repairs.
    // detectOverlayConflicts flags that pair as
    // condition_claim_conflicts_with_repair_disclosure, which must downgrade
    // eligibility away from INSTANT_RANGE_ELIGIBLE.
    seller_facts: { condition: 'excellent', repairs: { level: 'major' }, timeline: 'asap' },
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
    comps: houstonComps('c12'),
    // Asking 750k against a 185k canonical estimate — more than 1.5x, which
    // detectOverlayConflicts flags as asking_price_far_above_independent_value.
    seller_facts: { condition: 'good', asking_price: 750000 },
    expect: {
      resolution: 'RESOLVED',
      range_allowed: true,
      downgrade_expected: true,
      expected_conflict: 'asking_price_far_above_independent_value',
      outcomes: ['CONDITIONAL_RANGE', 'REVIEW_REQUIRED'],
    },
  },
]);

/**
 * Create the verification-scoped `properties` table the real resolver reads.
 * Only the columns the resolver + classifier need. Never run against a database
 * that already owns a canonical `properties` table — the verifier checks first.
 */
export const PROPERTIES_FIXTURE_DDL = `
CREATE TABLE IF NOT EXISTS public.properties (
  property_id            text PRIMARY KEY,
  property_address_full  text,
  property_address       text,
  property_address_city  text,
  property_address_state text,
  property_address_zip   text,
  market                 text,
  property_type          text,
  property_class         text,
  building_square_feet   numeric,
  units_count            integer,
  estimated_value        numeric,
  latitude               double precision,
  longitude              double precision
);`;

const PROPERTY_COLUMNS = [
  'property_id', 'property_address_full', 'property_address', 'property_address_city',
  'property_address_state', 'property_address_zip', 'market', 'property_type',
  'property_class', 'building_square_feet', 'units_count', 'estimated_value',
  'latitude', 'longitude',
];

/** Idempotently seed the synthetic properties. Deletes fixture rows first. */
export async function seedSyntheticProperties(pool) {
  await pool.query(PROPERTIES_FIXTURE_DDL);
  await pool.query(`DELETE FROM public.properties WHERE property_id LIKE $1`, [`${FIXTURE_PREFIX}-%`]);
  for (const row of SYNTHETIC_PROPERTIES) {
    await pool.query(
      `INSERT INTO public.properties (${PROPERTY_COLUMNS.join(', ')})
       VALUES (${PROPERTY_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`,
      PROPERTY_COLUMNS.map((c) => row[c] ?? null),
    );
  }
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM public.properties WHERE property_id LIKE $1`,
    [`${FIXTURE_PREFIX}-%`],
  );
  return rows[0].n;
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
  ]) {
    const res = await pool.query(sql, params);
    counts[label] = res.rowCount;
  }
  return counts;
}

export default {
  FIXTURE_PREFIX,
  FIXTURE_STREET_TOKEN,
  SYNTHETIC_PROPERTIES,
  CASES,
  PROPERTIES_FIXTURE_DDL,
  seedSyntheticProperties,
  cleanupFixtures,
};
