#!/usr/bin/env node
/**
 * Builds the de-identified North Minneapolis regression fixture
 * (tests/intelligence/fixtures/comp-north-minneapolis.json) from a comp
 * snapshot, plus a case-subject feature file for the offline backtest's
 * replica-vs-production check (written next to the snapshot, never in the repo).
 *
 * The owner's case: property 273312064 (North Minneapolis, ZIP 55412), valued
 * by the production engine at $362,500 (2026-09-30) and $327,900 (2026-10-01).
 *
 * De-identification of the repo fixture:
 *   - no addresses, names, property ids or record ids (sequential ids only);
 *   - coordinates rounded to 3 decimals (~110 m x 80 m);
 *   - square feet rounded to 10; price rebuilt from whole-dollar PPSF x rounded
 *     sqft (or rounded to $5,000 when sqft is unknown);
 *   - dates rounded down to the 1st or the 15th of the month;
 *   - no vendor values; doc types and validity reduced to short validity codes.
 *
 * Network: one read-only service-role REST GET for the subject's property
 * features (no owner, contact or address columns are selected).
 *
 * Run from apps/api:
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/comps/build-north-minneapolis-fixture.mjs --snapshot=<snapshot dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { haversineMiles } from '../../../src/lib/domain/intelligence/comps/geo.js';
import { saleValidity } from '../../../src/lib/domain/intelligence/comps/comp-records.js';
import { championSearch, probeEngineWindows } from '../../../src/lib/domain/intelligence/comps/champion-replica.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const API_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../../..');
const FIXTURE_PATH = path.join(API_ROOT, 'tests/intelligence/fixtures/comp-north-minneapolis.json');
const SUBJECT_PROPERTY_ID = '273312064';
const AS_OF = '2026-10-01';
const RADIUS_MILES = 4.1;
const WINDOW_START = '2024-04-01';

export const SUBJECT_FEATURE_COLUMNS = [
  'property_type', 'units_count', 'building_square_feet', 'total_bedrooms', 'total_baths', 'year_built',
  'effective_year_built', 'lot_square_feet', 'building_condition', 'building_quality', 'construction_type',
  'exterior_walls', 'interior_walls', 'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'pool',
  'porch', 'patio', 'deck', 'driveway', 'stories', 'style', 'air_conditioning', 'heating_type',
  'heating_fuel_type', 'sewer', 'water', 'subdivision_name', 'school_district_name', 'zoning', 'flood_zone',
  'property_class', 'latitude', 'longitude', 'property_address_zip', 'property_address_state',
  'normalized_asset_class', 'sum_garage_sqft', 'estimated_repair_cost',
];

/**
 * The 12 comps the production engine stored for this subject on 2026-10-01
 * 12:58 UTC (audit comps-micromarket.md section 3.2), identified without
 * addresses by (zip, sqft, sale price, engine sale date).
 */
/** Engine scoring features carried (dictionary-coded) for the champion's candidate rows only. */
const ENGINE_FIELDS = [
  'building_condition', 'building_quality', 'construction_type', 'exterior_walls', 'interior_walls', 'floor_cover',
  'roof_cover', 'roof_type', 'basement', 'garage', 'pool', 'porch', 'patio', 'deck', 'driveway', 'stories', 'style',
  'air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer', 'water', 'subdivision_name', 'school_district_name',
  'zoning', 'flood_zone', 'property_class', 'renovation_level_classification',
];

const PRODUCTION_SET_20261001 = [
  ['55412', 1473, 110000, '2026-04-03'], ['55412', 1430, 235000, '2026-01-09'], ['55412', 1364, 208000, '2026-04-06'],
  ['55414', 1933, 400000, '2026-04-15'], ['55418', 2000, 395000, '2026-02-12'], ['55418', 1620, 450000, '2026-04-17'],
  ['55411', 1488, 281500, '2026-04-15'], ['55412', 1538, 280000, '2026-03-12'], ['55418', 1796, 622000, '2026-04-21'],
  ['55411', 1734, 230000, '2026-04-07'], ['55418', 1617, 230000, '2025-12-19'], ['55411', 1598, 285000, '2026-01-02'],
];

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    const match = token.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (match) args[match[1]] = match[2] ?? 'true';
  }
  return args;
}

function halfMonth(dateText) {
  if (!dateText) return null;
  const day = Number(dateText.slice(8, 10));
  return `${dateText.slice(0, 8)}${day >= 15 ? '15' : '01'}`;
}

function round(value, step) {
  return value === null || value === undefined ? null : Math.round(value / step) * step;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.snapshot) throw new Error('--snapshot=<dir> required');
  const manifest = JSON.parse(fs.readFileSync(path.join(args.snapshot, 'manifest.json'), 'utf8'));
  const file = manifest.files.find((f) => f.region === 'MSP');
  const records = zlib.gunzipSync(fs.readFileSync(path.join(args.snapshot, file.name))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));

  const { supabase, hasSupabaseConfig } = await import('@/lib/supabase/client.js');
  if (!hasSupabaseConfig()) throw new Error('supabase_config_missing');
  const { data, error } = await supabase.from('properties').select(SUBJECT_FEATURE_COLUMNS.join(',')).eq('property_id', SUBJECT_PROPERTY_ID).limit(1);
  if (error) throw new Error(`subject read failed: ${error.code ?? ''} ${error.message}`);
  const subject = data?.[0];
  if (!subject) throw new Error('subject_not_found');

  // Case-subject file for the offline backtest (outside the repo).
  const caseFile = path.join(args.snapshot, `case-subject-${SUBJECT_PROPERTY_ID}.json`);
  fs.writeFileSync(caseFile, `${JSON.stringify({ property_id: SUBJECT_PROPERTY_ID, read_at: new Date().toISOString(), features: subject }, null, 2)}\n`);

  const sLat = Number(subject.latitude);
  const sLng = Number(subject.longitude);
  const near = records.filter((r) => r.sale_date >= WINDOW_START && r.known_date < AS_OF && haversineMiles(sLat, sLng, r.lat, r.lng) <= RADIUS_MILES);
  near.sort((a, b) => (a.sale_date < b.sale_date ? -1 : a.sale_date > b.sale_date ? 1 : a.id.localeCompare(b.id)));

  // The champion's top-100 candidates (unrounded data, both as-of dates): only
  // these rows need the engine's scoring features for a faithful replica run.
  const subjectForSearch = {
    id: 'subject', pid: SUBJECT_PROPERTY_ID, lat: sLat, lng: sLng, nac: null, property_type: subject.property_type,
    units: subject.units_count, sqft: subject.building_square_feet, beds: subject.total_bedrooms, baths: subject.total_baths, year_built: subject.year_built,
  };
  const windows = probeEngineWindows();
  const pool = near.filter((r) => r.src === 'pool');
  const championIds = new Set();
  for (const asOf of ['2026-09-30', '2026-10-01']) {
    for (const c of championSearch({ subjectRecord: subjectForSearch, asOf, records: pool, windows }).candidates) championIds.add(c.r.id);
  }
  const dict = Object.fromEntries(ENGINE_FIELDS.map((f) => [f, []]));
  const encode = (field, value) => {
    if (value === null || value === undefined || value === '') return null;
    const key = String(value);
    let idx = dict[field].indexOf(key);
    if (idx < 0) {
      dict[field].push(key);
      idx = dict[field].length - 1;
    }
    return idx;
  };
  // Plat names and zoning are reduced to opaque codes (equality survives, text does not).
  const OPAQUE = new Set(['subdivision_name', 'zoning']);
  const engineRow = (eng) => ENGINE_FIELDS.map((f) => encode(f, eng?.[f]));
  const subjectEngine = engineRow(subject);

  const productionKeys = new Set(PRODUCTION_SET_20261001.map((x) => x.join('|')));
  // Compact columnar encoding; tests/intelligence/helpers/north-minneapolis-fixture.mjs expands it.
  const cols = [
    'id', 'src', 'loser', 'lat', 'lng', 'zip', 'sale', 'deed', 'known', 'type', 'buyer', 'pt', 'units', 'sqft',
    'beds', 'baths', 'yb', 'price', 'vprice', 'flags', 'cond', 'usable', 'unit', 'prod', 'eng',
  ];
  const TYPE = { mls: 'm', public_record: 'p', deed: 'd' };
  const BUYER = { individual: 'i', investor: 'v', institutional: 't', unknown: 'u' };
  const PT = { 'Single Family': 'SF', 'Multi-Family': 'MF', Apartment: 'AP', Other: 'OT', 'Vacant Land': 'VL' };
  const FLAG = {
    price_missing: 'M', price_below_floor: 'F', price_estimated: 'E', nominal_price: 'N', distress_or_transfer_deed: 'D',
    non_arms_length: 'A', package_sale: 'P', contract_dated: 'C', sale_date_missing: 'S',
  };
  const rows = near.map((r, i) => {
    const sqft = r.sqft ? round(r.sqft, 10) : null;
    const rebuild = (price) => (price === null || price === undefined ? null : sqft && r.sqft ? Math.round(price / r.sqft) * sqft : round(price, 5000));
    const validity = saleValidity(r);
    const engineDate = r.mls_date ?? r.deed_date ?? r.sale_date;
    const enginePrice = r.mls_price ?? r.view_sale_price ?? r.price;
    const sale = halfMonth(r.sale_date);
    const deed = halfMonth(r.deed_date);
    const known = halfMonth(r.known_date);
    const price = rebuild(r.price);
    const vprice = rebuild(r.view_sale_price);
    return [
      i + 1,
      r.src === 'pool' ? 'P' : 'D',
      r.dedup?.role === 'loser' ? 1 : 0,
      Math.round(r.lat * 1000) / 1000,
      Math.round(r.lng * 1000) / 1000,
      r.zip,
      sale,
      deed && deed !== sale ? deed : null,
      known && known !== sale ? known : null,
      TYPE[r.sale_type] ?? r.sale_type,
      BUYER[r.buyer_type] ?? 'u',
      PT[r.property_type] ?? r.property_type,
      r.units,
      sqft,
      r.beds,
      r.baths,
      r.year_built,
      price,
      vprice !== null && vprice !== price ? vprice : null,
      validity.reasons.map((x) => FLAG[x] ?? '?').join(''),
      r.eng?.building_condition ?? null,
      r.usable_comp ? 1 : 0,
      r.unit_designator ? 1 : 0,
      productionKeys.has([r.zip, r.sqft, enginePrice, engineDate].join('|')) ? 1 : 0,
      championIds.has(r.id) ? engineRow(r.eng) : null,
    ];
  });
  for (const field of OPAQUE) dict[field] = dict[field].map((_, i) => `${field === 'zoning' ? 'Z' : 'PLAT'}${i}`);
  const fixture = {
    fixture: 'comp-north-minneapolis',
    version: 1,
    as_of: AS_OF,
    description: 'De-identified comp evidence around the North Minneapolis case (owner case, ZIP 55412) from both corpora, 30 months before as_of, within 4.1 miles. Built by scripts/intelligence/comps/build-north-minneapolis-fixture.mjs.',
    source_snapshot: { id: manifest.snapshot_id, file: file.name, sha256: file.sha256 },
    deidentification: [
      'no addresses, names, property ids or record ids (sequential ids)',
      'coordinates rounded to 3 decimals',
      'sqft rounded to 10; prices rebuilt from whole-dollar PPSF x rounded sqft (else rounded to $5,000)',
      'dates rounded down to the 1st or 15th of the month',
      'no vendor values; doc types and validity flags reduced to short validity codes',
      'engine scoring features only for the champion candidate rows, dictionary-coded; plat and zoning text replaced by opaque codes',
    ],
    production_engine_record: {
      note: 'Stored production valuations for this subject (audit comps-micromarket.md section 3); documentation only, never asserted.',
      valuation_mid_2026_09_30: 362500,
      valuation_mid_2026_10_01: 327900,
      non_north_weight_share_2026_10_01: 0.416,
    },
    subject: {
      lat: Math.round(sLat * 1000) / 1000,
      lng: Math.round(sLng * 1000) / 1000,
      zip: String(subject.property_address_zip ?? '').slice(0, 5),
      property_type: subject.property_type,
      units: subject.units_count ?? 1,
      sqft: round(Number(subject.building_square_feet), 10),
      beds: subject.total_bedrooms,
      baths: subject.total_baths,
      year_built: subject.year_built,
      condition: subject.building_condition ?? null,
    },
    codes: { src: { P: 'pool', D: 'deeds' }, type: TYPE, buyer: BUYER, pt: PT, flags: FLAG },
    engine_features: {
      note: 'Dictionary-coded production-engine scoring features, carried only for the champion replica top-100 candidate rows (both as-of dates) and the subject. Plat and zoning text replaced by opaque codes.',
      fields: ENGINE_FIELDS,
      dictionary: dict,
      subject: subjectEngine,
      subject_garage_sqft: subject.sum_garage_sqft ?? null,
    },
    columns: cols,
    rows,
  };
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture)}\n`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
  console.log(`fixture rows=${rows.length} production-set matches=${rows.filter((r) => r[cols.indexOf('prod')] === 1).length} engine-feature rows=${rows.filter((r) => r[cols.indexOf('eng')]).length} bytes=${fs.statSync(FIXTURE_PATH).size} sha256=${sha.slice(0, 16)}`);
  console.log(`case subject features -> ${caseFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`fixture build failed: ${String(error?.message ?? error).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<redacted>')}`);
    process.exitCode = 1;
  });
}
