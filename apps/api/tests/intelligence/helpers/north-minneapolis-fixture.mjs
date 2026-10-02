/**
 * Expands tests/intelligence/fixtures/comp-north-minneapolis.json (compact,
 * de-identified) into snapshot-shaped records (schema comp-snapshot-v1) that
 * comp-records.toSale() and the champion replica consume. Hermetic: reads a
 * local file only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'comp-north-minneapolis.json');

const PROPERTY_TYPE = { SF: 'Single Family', MF: 'Multi-Family', AP: 'Apartment', OT: 'Other', VL: 'Vacant Land' };
const NAC = { SF: 'single_family', MF: 'multifamily', AP: 'apartment', OT: 'single_family', VL: 'land' };
const SALE_TYPE = { m: 'mls', p: 'public_record', d: 'deed' };
const BUYER = { i: 'individual', v: 'investor', t: 'institutional', u: 'unknown' };

/** North Minneapolis (west bank) vs the east bank, by ZIP: a reporting label only. */
export const NORTH_ZIPS = new Set(['55411', '55412', '55430']);
export const EAST_BANK_ZIPS = new Set(['55418', '55413', '55414']);

function decodeEngine(codes, engine) {
  if (!Array.isArray(codes)) return null;
  const out = {};
  engine.fields.forEach((field, i) => {
    if (codes[i] !== null && codes[i] !== undefined) out[field] = engine.dictionary[field][codes[i]];
  });
  return out;
}

export function loadNorthMinneapolisFixture() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const col = Object.fromEntries(fixture.columns.map((name, i) => [name, i]));
  const engine = fixture.engine_features;
  const records = fixture.rows.map((row) => {
    const get = (name) => row[col[name]];
    const flags = String(get('flags') ?? '');
    const type = get('pt');
    const saleType = SALE_TYPE[get('type')];
    const sale = get('sale');
    const price = get('price');
    const isPool = get('src') === 'P';
    return {
      id: `fx:${get('id')}`,
      src: isPool ? 'pool' : 'deeds',
      region: 'MSP',
      market: null,
      pid: null,
      addr_key: null,
      parcel_key: null,
      unit_designator: get('unit') === 1,
      sale_date: sale,
      known_date: get('known') ?? sale,
      date_kind: flags.includes('C') ? 'deed_contract' : saleType === 'mls' ? 'mls_close' : saleType === 'deed' ? 'deed_event' : 'public_record',
      deed_date: get('deed') ?? sale,
      mls_date: saleType === 'mls' ? sale : null,
      lat: get('lat'),
      lng: get('lng'),
      zip: get('zip'),
      state: 'MN',
      property_type: PROPERTY_TYPE[type] ?? type,
      nac: NAC[type] ?? null,
      units: get('units'),
      sqft: get('sqft'),
      beds: get('beds'),
      baths: get('baths'),
      year_built: get('yb'),
      eff_year_built: null,
      lot_sqft: null,
      price,
      view_sale_price: isPool ? get('vprice') ?? price : null,
      mls_price: saleType === 'mls' ? price : null,
      price_estimated: flags.includes('E'),
      sale_type: saleType,
      doc_type: null,
      arms_length: flags.includes('A') ? false : null,
      nominal_flag: flags.includes('N'),
      distress_flag: flags.includes('D'),
      buyer_type: BUYER[get('buyer')] ?? 'unknown',
      usable_comp: get('usable') === 1,
      // The snapshot's nominal flag, expressed so the production engine's own
      // price / estimated_value < 0.25 check fires on the same rows.
      est_value: flags.includes('N') && price ? price * 5 : null,
      eng: decodeEngine(get('eng'), engine) ?? (get('cond') ? { building_condition: get('cond') } : null),
      package_n: flags.includes('P') ? 2 : 0,
      dedup: get('loser') === 1 ? { role: 'loser' } : null,
      production_set_20261001: get('prod') === 1,
    };
  });
  const subjectEngine = decodeEngine(engine.subject, engine) ?? {};
  if (engine.subject_garage_sqft !== null && engine.subject_garage_sqft !== undefined) subjectEngine.sum_garage_sqft = engine.subject_garage_sqft;
  return { asOf: fixture.as_of, subject: { ...fixture.subject, engine: subjectEngine }, productionRecord: fixture.production_engine_record, records, meta: fixture };
}

/** Subject as a snapshot-shaped record (attributes only; it is not a sale). */
export function subjectRecord(subject) {
  return {
    id: 'fx:subject',
    src: 'subject',
    pid: 'fx-subject',
    lat: subject.lat,
    lng: subject.lng,
    zip: subject.zip,
    state: 'MN',
    property_type: subject.property_type,
    nac: 'single_family',
    units: subject.units,
    sqft: subject.sqft,
    beds: subject.beds,
    baths: subject.baths,
    year_built: subject.year_built,
    eff_year_built: null,
    lot_sqft: null,
    eng: subject.engine && Object.keys(subject.engine).length ? subject.engine : subject.condition ? { building_condition: subject.condition } : null,
    sale_date: null,
    known_date: null,
    price: null,
    sale_type: null,
    buyer_type: 'unknown',
    unit_designator: false,
  };
}
