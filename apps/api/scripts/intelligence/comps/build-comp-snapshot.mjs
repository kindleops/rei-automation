#!/usr/bin/env node
/**
 * IC8 comp micro-market challenger: point-in-time dataset snapshot builder.
 *
 * Exports, per region, the sale records the offline backtest needs from BOTH
 * comp corpora, then deduplicates across corpora and records which source won:
 *   - public.v_recent_sold_comps (engine pool) + public.buyer_comp_raw_v2
 *     (buyer type, doc type, APN), keyset-paginated on id;
 *   - comp_private.mv_comp_market_evidence (recorded deeds) through the
 *     service-role RPC public.comps_market_evidence, tiled with a quadtree so
 *     no call is ever truncated (the RPC caps a call at 400 rows and reports
 *     total_in_radius, so a truncated tile is split and re-read).
 *
 * Access: the API's existing service-role Supabase client
 * (@/lib/supabase/client.js). Direct Postgres is NOT used: the password in
 * apps/api/.env.local is stale (28P01, measured 2026-10-02). Everything here
 * is a read: GETs against a view/table and a STABLE function. Requests are
 * bounded (keyset pages / small tiles), paced, and resumable through
 * <snapshot>/_work/checkpoint.json. Server-side statement_timeout is the
 * service_role default (REST cannot SET it).
 *
 * Privacy: owner/buyer/seller names are never persisted. The RPC returns the
 * full MV row, so name fields are dropped in memory on receipt; street
 * addresses are reduced in memory to a 16-hex md5 key plus a unit-designator
 * boolean and are never written. Buyer type is kept only as the category
 * institutional / investor / individual / unknown.
 *
 * Output (never inside the repo):
 *   <out-root>/<snapshot-id>/<REGION>.ndjson.gz   one record per line
 *   <out-root>/<snapshot-id>/manifest.json        spec, queries, counts, sha256, code commit
 *
 * Run from apps/api:
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/comps/build-comp-snapshot.mjs [--snapshot-id=...] [--regions=MSP,DFW]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SPEC_VERSION = 'comp-snapshot-v1';
const DEFAULT_OUT_ROOT = '/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/datasets/comps';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RPC_ROW_CAP = 400;

/**
 * Regions are buffered export boxes. Markets are subject-eligible subsets
 * (ZIP3 + a core box that keeps every subject >= ~4 mi inside the export box,
 * so the champion's fixed 4 mi search is never truncated by the box edge).
 */
export const REGIONS = Object.freeze([
  {
    region: 'MSP',
    box: { latMin: 44.72, latMax: 45.38, lngMin: -93.85, lngMax: -92.86 },
    markets: [
      { market: 'MSP', zip3: ['554', '551'], core: { latMin: 44.86, latMax: 45.10, lngMin: -93.40, lngMax: -92.98 } },
      { market: 'MN553', zip3: ['553'], core: { latMin: 44.80, latMax: 45.30, lngMin: -93.72, lngMax: -93.18 } },
    ],
  },
  {
    region: 'DFW',
    box: { latMin: 32.45, latMax: 33.12, lngMin: -97.15, lngMax: -96.40 },
    markets: [
      { market: 'DAL', zip3: ['752'], core: { latMin: 32.62, latMax: 33.02, lngMin: -97.00, lngMax: -96.55 } },
      { market: 'TX751', zip3: ['751'], core: { latMin: 32.50, latMax: 33.05, lngMin: -97.05, lngMax: -96.48 } },
    ],
  },
  {
    region: 'HOU',
    box: { latMin: 29.47, latMax: 30.13, lngMin: -95.85, lngMax: -95.00 },
    markets: [{ market: 'HOU', zip3: ['770'], core: { latMin: 29.55, latMax: 30.05, lngMin: -95.75, lngMax: -95.10 } }],
  },
  {
    region: 'JAX',
    box: { latMin: 30.07, latMax: 30.63, lngMin: -81.95, lngMax: -81.28 },
    markets: [{ market: 'JAX', zip3: ['322'], core: { latMin: 30.15, latMax: 30.55, lngMin: -81.85, lngMax: -81.38 } }],
  },
  {
    region: 'IND',
    box: { latMin: 39.55, latMax: 40.01, lngMin: -86.43, lngMax: -85.84 },
    markets: [{ market: 'IND', zip3: ['462'], core: { latMin: 39.63, latMax: 39.93, lngMin: -86.33, lngMax: -85.94 } }],
  },
]);

export const POOL_COLUMNS = [
  'id', 'property_id', 'property_address_full', 'property_address_zip', 'property_address_state',
  'property_address_county_name', 'latitude', 'longitude', 'sale_date', 'sale_price', 'mls_sold_date',
  'mls_sold_price', 'sale_source', 'is_usable_comp', 'normalized_asset_class', 'property_type',
  'units_count', 'building_square_feet', 'total_bedrooms', 'total_baths', 'year_built',
  'effective_year_built', 'lot_square_feet', 'estimated_value', 'estimated_repair_cost', 'created_at',
  'building_condition', 'building_quality', 'construction_type', 'exterior_walls', 'interior_walls',
  'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'pool', 'porch', 'patio', 'deck',
  'driveway', 'stories', 'style', 'air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer',
  'water', 'subdivision_name', 'school_district_name', 'zoning', 'flood_zone', 'property_class',
  'renovation_level_classification',
];
const RAW_COLUMNS = ['id', 'is_corporate_owner', 'last_sale_doc_type', 'recording_date', 'apn_parcel_id'];

/** Equivalent SQL of what the REST calls read (recorded in the manifest for reproducibility). */
export const QUERY_SPEC = Object.freeze({
  pool: `select ${POOL_COLUMNS.join(', ')} from public.v_recent_sold_comps
 where latitude between :latMin and :latMax and longitude between :lngMin and :lngMax
   and (sale_date >= :date_from or mls_sold_date >= :date_from) and id > :cursor
 order by id limit :page  -- PostgREST keyset page
;
select ${RAW_COLUMNS.join(', ')} from public.buyer_comp_raw_v2 where id in (:page_ids)  -- batches of 150`,
  deeds: `select public.comps_market_evidence(p_lat => :tile_center_lat, p_lng => :tile_center_lng,
   p_radius_miles => :tile_half_diagonal_mi * 1.02, p_months => :months_since_date_from, p_family => null, p_limit => 400)
 -- STABLE SECURITY DEFINER over comp_private.mv_comp_market_evidence; returns total_in_radius + <=400 rows.
 -- A tile is complete iff total_in_radius <= returned; otherwise it is split n x n and re-read.
 -- Rows are kept only inside their own tile (half-open box) and deduplicated on txn_id.`,
});

/**
 * comp_private.comp_canonical_transactions import batches. created_at is not
 * exposed through REST, but the two batches occupy disjoint id ranges, so a
 * deed's txn_id identifies its batch exactly. Measured read-only 2026-10-02:
 *   select created_at::date, count(*), min(id), max(id)
 *   from comp_private.comp_canonical_transactions group by 1;
 */
export const DEED_IMPORT_BATCHES = Object.freeze([
  { created_at: '2026-08-08', min_id: 1446647, max_id: 1777318, rows: 330672 },
  { created_at: '2026-09-30', min_id: 1787765, max_id: 2095911, rows: 228626 },
]);

export function deedImportBatch(txnId) {
  const id = Number(txnId);
  for (const batch of DEED_IMPORT_BATCHES) if (id >= batch.min_id && id <= batch.max_id) return batch.created_at;
  return 'unknown';
}

const ENGINE_DETAIL_FIELDS = Object.freeze([
  'building_condition', 'building_quality', 'construction_type', 'exterior_walls', 'interior_walls',
  'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'pool', 'porch', 'patio', 'deck',
  'driveway', 'stories', 'style', 'air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer',
  'water', 'subdivision_name', 'school_district_name', 'zoning', 'flood_zone', 'property_class',
  'renovation_level_classification',
]);

const INVESTOR_ARCHETYPES = new Set([
  'active_flipper', 'long_term_rental_holder', 'general_acquirer', 'geographically_concentrated_buyer',
  'diversified_buyer', 'multifamily_operator', 'small_multifamily_operator', 'commercial_operator',
  'inactive_stale_buyer',
]);

const STREET_ABBREVIATIONS = [
  [/\bavenue\b/g, 'ave'], [/\bstreet\b/g, 'st'], [/\bdrive\b/g, 'dr'], [/\broad\b/g, 'rd'],
  [/\blane\b/g, 'ln'], [/\bcourt\b/g, 'ct'], [/\bplace\b/g, 'pl'], [/\bboulevard\b/g, 'blvd'],
  [/\bparkway\b/g, 'pkwy'], [/\bnortheast\b/g, 'ne'], [/\bnorthwest\b/g, 'nw'], [/\bsoutheast\b/g, 'se'],
  [/\bsouthwest\b/g, 'sw'], [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'], [/\beast\b/g, 'e'], [/\bwest\b/g, 'w'],
];

/** md5 key of the normalised street line + ZIP5. The raw address is never returned. */
export function addressKey(address, zip) {
  const street = String(address ?? '').split(',')[0].toLowerCase().trim();
  if (!street) return null;
  let normalised = street;
  for (const [pattern, replacement] of STREET_ABBREVIATIONS) normalised = normalised.replace(pattern, replacement);
  normalised = normalised.replace(/[^a-z0-9]/g, '');
  return crypto.createHash('md5').update(`${normalised}|${String(zip ?? '').slice(0, 5)}`).digest('hex').slice(0, 16);
}

export function hasUnitDesignator(address) {
  const street = String(address ?? '').split(',')[0];
  return /(\b(unit|apt|apartment|ste|suite|lot)\b|#)/i.test(street);
}

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    const match = token.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (match) args[match[1]] = match[2] ?? 'true';
  }
  return args;
}

function redact(text) {
  return String(text ?? '')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-url>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/password\S*/gi, '<redacted>');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function gitInfo(files) {
  const repoRoot = path.resolve(path.dirname(SCRIPT_PATH), '../../../../..');
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const fileInfo = {};
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const status = run(['status', '--porcelain', '--', rel]);
    fileInfo[rel] = { sha256: sha256File(file), git_status: status ? status.slice(0, 2).trim() : 'clean' };
  }
  return { commit: run(['rev-parse', 'HEAD']), files: fileInfo };
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function addDays(dateText, days) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function round(value, digits) {
  if (value === null || value === undefined) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function inBox(lat, lng, box) {
  return lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax;
}

function marketFor(region, lat, lng, zip) {
  const zip3 = String(zip ?? '').slice(0, 3);
  for (const m of region.markets) {
    if (m.zip3.includes(zip3) && inBox(lat, lng, m.core)) return m.market;
  }
  return null;
}

function poolBuyerType(raw) {
  if (raw?.is_corporate_owner === true) return 'investor';
  if (raw?.is_corporate_owner === false) return 'individual';
  return 'unknown';
}

function deedBuyerType(row) {
  if (row.buyer_archetype === 'institutional_high_volume_buyer') return 'institutional';
  if (INVESTOR_ARCHETYPES.has(row.buyer_archetype)) return 'investor';
  if (row.buyer_kind === 'company') return 'investor';
  if (row.buyer_kind === 'person') return 'individual';
  return 'unknown';
}

/** Pool REST row (+ buyer_comp_raw_v2 row) -> snapshot record (schema comp-snapshot-v1). */
export function poolRecord(row, raw, region) {
  const mlsPrice = num(row.mls_sold_price);
  const isMls = mlsPrice !== null && mlsPrice > 0;
  const deedDate = dateOnly(row.sale_date);
  const mlsDate = dateOnly(row.mls_sold_date);
  const saleDate = isMls ? mlsDate ?? deedDate : deedDate;
  const lat = num(row.latitude);
  const lng = num(row.longitude);
  const zip = row.property_address_zip ? String(row.property_address_zip).slice(0, 5) : null;
  const eng = {};
  for (const field of ENGINE_DETAIL_FIELDS) {
    const value = row[field];
    if (value !== null && value !== undefined && value !== '') eng[field] = value;
  }
  const apn = String(raw?.apn_parcel_id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    id: `P:${row.id}`,
    src: 'pool',
    region: region.region,
    market: lat !== null && lng !== null ? marketFor(region, lat, lng, zip) : null,
    pid: row.property_id ?? null,
    addr_key: addressKey(row.property_address_full, zip),
    parcel_key: apn
      ? crypto.createHash('md5').update(`${String(row.property_address_state ?? '').toLowerCase()}|${String(row.property_address_county_name ?? '').toLowerCase()}|${apn}`).digest('hex').slice(0, 16)
      : null,
    unit_designator: hasUnitDesignator(row.property_address_full),
    sale_date: saleDate,
    known_date: saleDate,
    date_kind: isMls ? 'mls_close' : 'public_record',
    deed_date: deedDate,
    mls_date: mlsDate,
    recording_date: dateOnly(raw?.recording_date),
    ingested_at: row.created_at ?? null,
    lat: round(lat, 6),
    lng: round(lng, 6),
    zip,
    state: row.property_address_state ?? null,
    property_type: row.property_type ?? null,
    nac: row.normalized_asset_class ?? null,
    units: num(row.units_count),
    sqft: num(row.building_square_feet),
    beds: num(row.total_bedrooms),
    baths: num(row.total_baths),
    year_built: num(row.year_built),
    eff_year_built: num(row.effective_year_built),
    lot_sqft: num(row.lot_square_feet),
    price: isMls ? mlsPrice : num(row.sale_price),
    view_sale_price: num(row.sale_price),
    mls_price: mlsPrice,
    price_estimated: false,
    sale_type: isMls ? 'mls' : 'public_record',
    doc_type: raw?.last_sale_doc_type ?? null,
    arms_length: null,
    cash: null,
    concurrent_loan: null,
    nominal_flag: null,
    distress_flag: null,
    buyer_type: poolBuyerType(raw),
    usable_comp: row.is_usable_comp === true,
    est_value: num(row.estimated_value),
    est_repairs: num(row.estimated_repair_cost),
    corpus: 'engine_pool',
    eng: Object.keys(eng).length ? eng : null,
    package_n: 0,
    dedup: null,
  };
}

/** Deed RPC row -> snapshot record. Name and address fields are read here and dropped. */
export function deedRecord(row, region) {
  const eventDate = dateOnly(row.event_date);
  // event_date_kind is not exposed through the RPC; a contract-of-sale doc type
  // is dated at contract, not closing, so its availability is embargoed.
  const contract = /contract/i.test(String(row.doc_type ?? ''));
  const lat = num(row.lat);
  const lng = num(row.lng);
  const zip = row.zip ? String(row.zip).slice(0, 5) : null;
  return {
    id: `D:${row.txn_id}`,
    src: 'deeds',
    region: region.region,
    market: lat !== null && lng !== null ? marketFor(region, lat, lng, zip) : null,
    pid: row.property_id ?? null,
    addr_key: addressKey(row.address, zip),
    parcel_key: null,
    unit_designator: hasUnitDesignator(row.address),
    sale_date: eventDate,
    known_date: eventDate && contract ? addDays(eventDate, 60) : eventDate,
    date_kind: contract ? 'deed_contract' : 'deed_event',
    deed_date: eventDate,
    mls_date: null,
    recording_date: null,
    ingested_at: deedImportBatch(row.txn_id),
    lat: round(lat, 6),
    lng: round(lng, 6),
    zip,
    state: row.state ?? null,
    property_type: row.property_type ?? null,
    nac: row.family ?? null,
    units: num(row.units),
    sqft: num(row.sqft),
    beds: num(row.beds),
    baths: num(row.baths),
    year_built: num(row.year_built),
    eff_year_built: null,
    lot_sqft: num(row.lot_sqft),
    price: num(row.price),
    view_sale_price: null,
    mls_price: null,
    price_estimated: /estimat/i.test(String(row.price_code ?? '')),
    sale_type: 'deed',
    doc_type: row.doc_type ?? null,
    arms_length: typeof row.is_arms_length === 'boolean' ? row.is_arms_length : null,
    cash: typeof row.is_cash_purchase === 'boolean' ? row.is_cash_purchase : null,
    concurrent_loan: typeof row.has_concurrent_loan === 'boolean' ? row.has_concurrent_loan : null,
    nominal_flag: typeof row.nominal_price === 'boolean' ? row.nominal_price : null,
    distress_flag: typeof row.distress_or_transfer_deed === 'boolean' ? row.distress_or_transfer_deed : null,
    buyer_type: deedBuyerType(row),
    usable_comp: Boolean(num(row.price) && eventDate && lat !== null && lng !== null && zip),
    est_value: num(row.corpus_value),
    est_repairs: null,
    corpus: row.corpus ?? null,
    eng: null,
    package_n: 0,
    dedup: null,
  };
}

function sameParcel(a, b) {
  if (a.pid && b.pid && a.pid === b.pid) return 'property_id';
  if (a.parcel_key && b.parcel_key && a.parcel_key === b.parcel_key) return 'parcel_key';
  if (a.addr_key && b.addr_key && a.addr_key === b.addr_key) return 'address_key';
  return null;
}

function priceClose(a, b, tolerance = 0.05) {
  if (!a || !b) return false;
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

function compareIds(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * Within-deeds exact duplicates, then pool x deeds same-sale matches
 * (same parcel/address key, date within 10 days of the deed or MLS date,
 * price within 5%). Losers are KEPT with role 'loser' so a pool-only replica
 * of the production engine still sees every pool row.
 */
export function deduplicate(records) {
  const stats = { deeds_exact_duplicates: 0, cross_corpus_matches: 0, by_basis: {}, winners: { pool: 0, deeds: 0 } };
  const byKey = new Map();
  const keysOf = (r) => [r.pid && `p:${r.pid}`, r.parcel_key && `k:${r.parcel_key}`, r.addr_key && `a:${r.addr_key}`].filter(Boolean);
  for (const r of records) {
    for (const key of keysOf(r)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
  }
  const markLoser = (loser, winner, basis) => {
    loser.dedup = { role: 'loser', winner: winner.id, basis };
    winner.dedup = winner.dedup?.role === 'winner'
      ? { ...winner.dedup, merged: [...winner.dedup.merged, loser.id].sort(compareIds) }
      : { role: 'winner', merged: [loser.id], basis };
  };

  const deeds = records.filter((r) => r.src === 'deeds').sort((a, b) => compareIds(a.id, b.id));
  for (const r of deeds) {
    if (r.dedup?.role === 'loser') continue;
    for (const key of keysOf(r)) {
      for (const other of byKey.get(key) ?? []) {
        if (other === r || other.src !== 'deeds' || other.dedup?.role === 'loser') continue;
        if (compareIds(other.id, r.id) <= 0) continue;
        if (other.sale_date === r.sale_date && other.price === r.price) {
          markLoser(other, r, 'deeds_exact_duplicate');
          stats.deeds_exact_duplicates += 1;
        }
      }
    }
  }

  const pool = records.filter((r) => r.src === 'pool').sort((a, b) => compareIds(a.id, b.id));
  for (const p of pool) {
    let best = null;
    for (const key of keysOf(p)) {
      for (const d of byKey.get(key) ?? []) {
        if (d.src !== 'deeds' || d.dedup?.role === 'loser') continue;
        const basis = sameParcel(p, d);
        if (!basis || !d.sale_date) continue;
        const dates = [p.deed_date, p.mls_date].filter(Boolean);
        if (!dates.length) continue;
        const gap = Math.min(...dates.map((x) => Math.abs(daysBetween(x, d.sale_date))));
        if (!(gap <= 10)) continue;
        if (!priceClose(p.price, d.price) && !priceClose(p.view_sale_price, d.price)) continue;
        if (!best || gap < best.gap || (gap === best.gap && compareIds(d.id, best.d.id) < 0)) best = { d, gap, basis };
      }
    }
    if (!best) continue;
    const { d, basis } = best;
    // MLS rows carry the closing date/price and richer features; deeds carry
    // validity flags. MLS wins over a deed; a deed wins over a public-record row.
    const poolWins = p.sale_type === 'mls';
    const winner = poolWins ? p : d;
    const loser = poolWins ? d : p;
    stats.cross_corpus_matches += 1;
    stats.by_basis[basis] = (stats.by_basis[basis] ?? 0) + 1;
    stats.winners[winner.src] += 1;
    markLoser(loser, winner, `cross_corpus_${basis}`);
    const filled = [];
    for (const field of ['sqft', 'beds', 'baths', 'year_built', 'lot_sqft', 'units']) {
      if (winner[field] === null && loser[field] !== null) {
        winner[field] = loser[field];
        filled.push(field);
      }
    }
    if (poolWins) {
      for (const field of ['arms_length', 'cash', 'concurrent_loan', 'nominal_flag', 'distress_flag']) {
        if (winner[field] === null && loser[field] !== null) {
          winner[field] = loser[field];
          filled.push(field);
        }
      }
      if (loser.buyer_type !== 'unknown' && winner.buyer_type === 'unknown') {
        winner.buyer_type = loser.buyer_type;
        filled.push('buyer_type');
      }
    } else if (!winner.eng && loser.eng) {
      winner.eng = loser.eng;
      filled.push('eng');
    }
    if (filled.length) winner.dedup.filled = [...new Set([...(winner.dedup.filled ?? []), ...filled])].sort();
  }
  return stats;
}

/**
 * Package / portfolio clusters: identical (sale_date, price) on distinct
 * parcels. >=3 parcels is a package outright; 2 needs the same ZIP or ~1 mi.
 * Computed over dedupe winners and copied to their losers.
 */
export function flagPackages(records) {
  const groups = new Map();
  for (const r of records) {
    if (r.dedup?.role === 'loser' || !r.sale_date || !r.price) continue;
    const key = `${r.sale_date}|${Math.round(r.price)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let clusters = 0;
  let members = 0;
  const flagged = new Map();
  for (const group of groups.values()) {
    const parcels = new Set(group.map((r) => r.pid || r.parcel_key || r.addr_key || r.id));
    if (parcels.size < 2) continue;
    let isPackage = parcels.size >= 3;
    if (!isPackage) {
      const zips = new Set(group.map((r) => r.zip).filter(Boolean));
      const lats = group.map((r) => r.lat);
      const lngs = group.map((r) => r.lng);
      const proximate = Math.max(...lats) - Math.min(...lats) < 0.015 && Math.max(...lngs) - Math.min(...lngs) < 0.015;
      isPackage = zips.size === 1 || proximate;
    }
    if (!isPackage) continue;
    clusters += 1;
    for (const r of group) {
      r.package_n = parcels.size;
      flagged.set(r.id, parcels.size);
      members += 1;
    }
  }
  for (const r of records) {
    if (r.dedup?.role === 'loser' && flagged.has(r.dedup.winner)) r.package_n = flagged.get(r.dedup.winner);
  }
  return { clusters, members };
}

class Checkpoint {
  constructor(file, specHash) {
    this.file = file;
    this.state = { spec_hash: specHash, parts: {} };
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.spec_hash === specHash) this.state = saved;
    }
  }

  part(name) {
    if (!this.state.parts[name]) {
      this.state.parts[name] = { cursor: null, rows: 0, bytes: 0, calls: 0, done: false, done_tiles: [], truncated_tiles: [] };
    }
    return this.state.parts[name];
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}

function prepareWorkFile(workFile, part) {
  if (fs.existsSync(workFile)) {
    if (fs.statSync(workFile).size !== part.bytes) fs.truncateSync(workFile, part.bytes);
  } else if (part.bytes) {
    Object.assign(part, { cursor: null, rows: 0, bytes: 0, calls: 0, done: false, done_tiles: [], truncated_tiles: [] });
  }
}

function appendRecords(workFile, part, records) {
  if (!records.length) return;
  const text = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  fs.appendFileSync(workFile, text);
  part.bytes += Buffer.byteLength(text);
  part.rows += records.length;
}

async function withRetry(label, fn, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      process.stdout.write(`  ${label}: attempt ${attempt} failed (${redact(error?.code ?? '')} ${redact(error?.message ?? error)})\n`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

async function fetchPool({ supabase, region, workFile, part, checkpoint, opts }) {
  prepareWorkFile(workFile, part);
  const box = region.box;
  while (!part.done) {
    const cursor = part.cursor ?? '00000000-0000-0000-0000-000000000000';
    const rows = await withRetry(`${region.region}.pool`, async () => {
      const result = await supabase
        .from('v_recent_sold_comps')
        .select(POOL_COLUMNS.join(','))
        .gte('latitude', box.latMin).lte('latitude', box.latMax)
        .gte('longitude', box.lngMin).lte('longitude', box.lngMax)
        .or(`sale_date.gte.${opts.dateFrom},mls_sold_date.gte.${opts.dateFrom}`)
        .gt('id', cursor)
        .order('id', { ascending: true })
        .limit(opts.pageSize);
      if (result.error) throw result.error;
      return result.data ?? [];
    });
    const rawById = new Map();
    for (let i = 0; i < rows.length; i += 150) {
      const ids = rows.slice(i, i + 150).map((r) => r.id);
      const raws = await withRetry(`${region.region}.pool.raw`, async () => {
        const result = await supabase.from('buyer_comp_raw_v2').select(RAW_COLUMNS.join(',')).in('id', ids);
        if (result.error) throw result.error;
        return result.data ?? [];
      });
      for (const raw of raws) rawById.set(raw.id, raw);
      part.calls += 1;
    }
    appendRecords(workFile, part, rows.map((row) => poolRecord(row, rawById.get(row.id), region)));
    part.calls += 1;
    if (rows.length) part.cursor = rows[rows.length - 1].id;
    if (rows.length < opts.pageSize) part.done = true;
    checkpoint.save();
    process.stdout.write(`  ${region.region}.pool: rows=${part.rows}${part.done ? ' (done)' : ''}\n`);
    await sleep(opts.pauseMs);
  }
}

function monthsSince(dateFrom) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const now = new Date();
  return (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + (now.getUTCMonth() - from.getUTCMonth()) + 2;
}

function initialTiles(box, stepLat) {
  const midLat = (box.latMin + box.latMax) / 2;
  const stepLng = stepLat / Math.cos((midLat * Math.PI) / 180);
  const tiles = [];
  for (let lat = box.latMin; lat < box.latMax - 1e-9; lat += stepLat) {
    for (let lng = box.lngMin; lng < box.lngMax - 1e-9; lng += stepLng) {
      tiles.push({
        latMin: round(lat, 6), latMax: round(Math.min(lat + stepLat, box.latMax), 6),
        lngMin: round(lng, 6), lngMax: round(Math.min(lng + stepLng, box.lngMax), 6),
      });
    }
  }
  return tiles;
}

function tileKey(t) {
  return `${t.latMin},${t.latMax},${t.lngMin},${t.lngMax}`;
}

function halfDiagonalMiles(t) {
  const midLat = ((t.latMin + t.latMax) / 2) * (Math.PI / 180);
  const dy = (t.latMax - t.latMin) * 69.05;
  const dx = (t.lngMax - t.lngMin) * 69.17 * Math.cos(midLat);
  return Math.sqrt(dx * dx + dy * dy) / 2;
}

/** Split a tile into n x n children (n sized so each child disc expects <= ~250 rows). */
function splitTile(t, n) {
  const children = [];
  const dLat = (t.latMax - t.latMin) / n;
  const dLng = (t.lngMax - t.lngMin) / n;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      children.push({
        latMin: round(t.latMin + i * dLat, 6),
        latMax: i === n - 1 ? t.latMax : round(t.latMin + (i + 1) * dLat, 6),
        lngMin: round(t.lngMin + j * dLng, 6),
        lngMax: j === n - 1 ? t.lngMax : round(t.lngMin + (j + 1) * dLng, 6),
      });
    }
  }
  return children;
}

function insideTile(t, lat, lng, box) {
  const latHi = t.latMax >= box.latMax ? lat <= t.latMax : lat < t.latMax;
  const lngHi = t.lngMax >= box.lngMax ? lng <= t.lngMax : lng < t.lngMax;
  return lat >= t.latMin && latHi && lng >= t.lngMin && lngHi;
}

async function fetchDeeds({ supabase, region, workFile, part, checkpoint, opts }) {
  prepareWorkFile(workFile, part);
  if (part.done) return;
  const box = region.box;
  const months = monthsSince(opts.dateFrom);
  const done = new Set(part.done_tiles);
  const stack = initialTiles(box, opts.tileDeg).reverse();
  while (stack.length) {
    const tile = stack.pop();
    const key = tileKey(tile);
    if (done.has(key)) continue;
    const radius = round(halfDiagonalMiles(tile) * 1.02 + 0.01, 3);
    const center = { lat: (tile.latMin + tile.latMax) / 2, lng: (tile.lngMin + tile.lngMax) / 2 };
    const payload = await withRetry(`${region.region}.deeds`, async () => {
      const result = await supabase.rpc('comps_market_evidence', {
        p_lat: center.lat, p_lng: center.lng, p_radius_miles: radius, p_months: months, p_family: null, p_limit: RPC_ROW_CAP,
      });
      if (result.error) throw result.error;
      return result.data ?? { total_in_radius: 0, returned: 0, rows: [] };
    });
    part.calls += 1;
    const total = Number(payload.total_in_radius ?? 0);
    const returned = Number(payload.returned ?? 0);
    const tooSmall = tile.latMax - tile.latMin < 0.002;
    if (total > returned && !tooSmall) {
      // Truncated: split; children are processed next (depth first).
      const n = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(total / 250))));
      for (const child of splitTile(tile, n).reverse()) stack.push(child);
    } else {
      if (total > returned) part.truncated_tiles.push({ tile: key, total, returned });
      const records = [];
      for (const row of payload.rows ?? []) {
        const lat = num(row.lat);
        const lng = num(row.lng);
        if (lat === null || lng === null || !insideTile(tile, lat, lng, box)) continue;
        const eventDate = dateOnly(row.event_date);
        if (!eventDate || eventDate < opts.dateFrom) continue;
        records.push(deedRecord(row, region));
      }
      appendRecords(workFile, part, records);
      part.done_tiles.push(key);
      done.add(key);
    }
    checkpoint.save();
    if (part.calls % 25 === 0) process.stdout.write(`  ${region.region}.deeds: calls=${part.calls} rows=${part.rows} pending_tiles=${stack.length}\n`);
    await sleep(opts.pauseMs);
  }
  part.done = true;
  checkpoint.save();
  process.stdout.write(`  ${region.region}.deeds: calls=${part.calls} rows=${part.rows} (done; truncated leaves ${part.truncated_tiles.length})\n`);
}

async function readNdjson(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) out.push(JSON.parse(line));
  return out;
}

async function writeNdjsonGz(file, records) {
  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(file);
    gzip.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
    for (const r of records) gzip.write(`${JSON.stringify(r)}\n`);
    gzip.end();
  });
}

/** Field coverage and validity profile of a set of deed records (rates over all rows). */
function profileBatch(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const rate = (fn) => Math.round((rows.filter(fn).length / n) * 1000) / 1000;
  return {
    n,
    lat_lng: rate((r) => r.lat !== null && r.lng !== null),
    sqft: rate((r) => r.sqft > 0),
    beds: rate((r) => r.beds !== null),
    baths: rate((r) => r.baths !== null),
    year_built: rate((r) => r.year_built !== null),
    property_type: rate((r) => Boolean(r.property_type)),
    family_single_family: rate((r) => r.nac === 'single_family'),
    price_below_10k: rate((r) => !(r.price >= 10_000)),
    price_estimated: rate((r) => r.price_estimated),
    nominal_flag: rate((r) => r.nominal_flag === true),
    distress_or_transfer_deed: rate((r) => r.distress_flag === true),
    arms_length_true: rate((r) => r.arms_length === true),
    arms_length_false: rate((r) => r.arms_length === false),
    arms_length_unknown: rate((r) => r.arms_length === null),
    buyer_type_unknown: rate((r) => r.buyer_type === 'unknown'),
    unit_designator: rate((r) => r.unit_designator),
  };
}

function countBy(records, fn) {
  const out = {};
  for (const r of records) {
    const key = String(fn(r));
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const args = parseArgs(process.argv);
  const opts = {
    outRoot: args['out-root'] ?? DEFAULT_OUT_ROOT,
    dateFrom: args['date-from'] ?? '2023-01-01',
    pageSize: Number(args['page-size'] ?? 1000),
    pauseMs: Number(args['pause-ms'] ?? 200),
    tileDeg: Number(args['tile-deg'] ?? 0.08),
    regions: (args.regions ?? REGIONS.map((r) => r.region).join(',')).split(',').map((s) => s.trim()).filter(Boolean),
  };
  const spec = {
    spec_version: SPEC_VERSION,
    record_mapping_version: 3,
    deed_import_batches: DEED_IMPORT_BATCHES,
    date_from: opts.dateFrom,
    regions: REGIONS.filter((r) => opts.regions.includes(r.region)),
    queries: QUERY_SPEC,
    page_size: opts.pageSize,
    tile_deg: opts.tileDeg,
  };
  const specHash = sha256Text(JSON.stringify(spec));
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const snapshotId = args['snapshot-id'] ?? `comps-${today}-${specHash.slice(0, 8)}`;
  const outDir = path.join(opts.outRoot, snapshotId);
  const workDir = path.join(outDir, '_work');
  fs.mkdirSync(workDir, { recursive: true });
  const checkpoint = new Checkpoint(path.join(workDir, 'checkpoint.json'), specHash);
  checkpoint.save();

  const { supabase, hasSupabaseConfig } = await import('@/lib/supabase/client.js');
  if (!hasSupabaseConfig()) throw new Error('supabase_config_missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  console.log(`snapshot ${snapshotId} -> ${outDir}`);
  console.log(`regions ${opts.regions.join(',')} | date_from ${opts.dateFrom} | page ${opts.pageSize} | tile ${opts.tileDeg} deg | pause ${opts.pauseMs}ms`);
  const startedAt = new Date().toISOString();
  for (const region of spec.regions) {
    await fetchPool({ supabase, region, workFile: path.join(workDir, `${region.region}.pool.ndjson`), part: checkpoint.part(`${region.region}.pool`), checkpoint, opts });
    await fetchDeeds({ supabase, region, workFile: path.join(workDir, `${region.region}.deeds.ndjson`), part: checkpoint.part(`${region.region}.deeds`), checkpoint, opts });
  }

  const files = [];
  const counts = {};
  for (const region of spec.regions) {
    const pool = await readNdjson(path.join(workDir, `${region.region}.pool.ndjson`));
    const deedsRaw = await readNdjson(path.join(workDir, `${region.region}.deeds.ndjson`));
    const seen = new Set();
    const deeds = deedsRaw.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    const records = [...pool, ...deeds].filter((r) => r.sale_date && r.lat !== null && r.lng !== null);
    const dedupStats = deduplicate(records);
    const packageStats = flagPackages(records);
    records.sort((a, b) => (a.known_date < b.known_date ? -1 : a.known_date > b.known_date ? 1 : compareIds(a.id, b.id)));
    const file = path.join(outDir, `${region.region}.ndjson.gz`);
    await writeNdjsonGz(file, records);
    const winners = records.filter((r) => r.dedup?.role !== 'loser');
    const parts = checkpoint.state.parts;
    counts[region.region] = {
      raw: { pool: pool.length, deeds: deeds.length, deeds_rows_seen_twice: deedsRaw.length - deeds.length },
      calls: { pool: parts[`${region.region}.pool`]?.calls ?? 0, deeds: parts[`${region.region}.deeds`]?.calls ?? 0 },
      truncated_deed_tiles: parts[`${region.region}.deeds`]?.truncated_tiles ?? [],
      written: records.length,
      dedup_losers: records.length - winners.length,
      union_rows: winners.length,
      dedup: dedupStats,
      packages: packageStats,
      union_by_market: countBy(winners, (r) => r.market ?? '(buffer)'),
      union_by_src_sale_type: countBy(winners, (r) => `${r.src}:${r.sale_type}`),
      union_by_buyer_type: countBy(winners, (r) => r.buyer_type),
      union_price_estimated: winners.filter((r) => r.price_estimated).length,
      union_by_sale_month: countBy(winners, (r) => r.sale_date.slice(0, 7)),
      deeds_by_import_batch: countBy(deeds, (r) => r.ingested_at),
      deeds_0930_profile: profileBatch(deeds.filter((r) => r.ingested_at === '2026-09-30')),
      cross_corpus_matches_by_batch: countBy(records.filter((r) => r.src === 'deeds' && r.dedup && String(r.dedup.basis).startsWith('cross_corpus')), (r) => r.ingested_at),
    };
    files.push({ name: path.basename(file), region: region.region, rows: records.length, bytes: fs.statSync(file).size, sha256: sha256File(file) });
    console.log(`  ${region.region}: written ${records.length} (union ${winners.length}; cross-corpus matches ${dedupStats.cross_corpus_matches})`);
  }

  const manifest = {
    snapshot_id: snapshotId,
    spec_version: SPEC_VERSION,
    spec_sha256: specHash,
    built_at: new Date().toISOString(),
    fetch_started_at: startedAt,
    uri: outDir,
    source: {
      supabase_project: 'lcppdrmrdfblstpcbgpf',
      access: 'service-role Supabase client (@/lib/supabase/client.js): PostgREST GETs + STABLE RPC; read only. Direct Postgres unavailable (stale password in .env.local, 28P01).',
      relations: [
        'public.v_recent_sold_comps',
        'public.buyer_comp_raw_v2 (is_corporate_owner, last_sale_doc_type, recording_date, apn_parcel_id)',
        'comp_private.mv_comp_market_evidence via public.comps_market_evidence (SECURITY DEFINER, STABLE)',
      ],
      not_available: 'comp_private.comp_canonical_transactions is not exposed to REST: event_date_kind, first_observed_at and APN are unavailable (deeds carry no parcel key; contract dating is inferred from doc_type); the import batch (created_at date) is derived exactly from txn_id ranges.',
    },
    spec: { ...spec, queries: undefined },
    queries: QUERY_SPEC,
    record_schema: {
      id: "'P:<pool uuid>' | 'D:<deed txn_id>'",
      sale_date: 'transaction date: MLS close date for MLS rows, else deed/event date',
      known_date: 'availability date used for as-of filtering (contract-of-sale deeds embargoed +60 d)',
      ingested_at: 'pool created_at (single import 2026-05-16/17); deeds: comp_canonical_transactions created_at date derived exactly from the txn_id batch range (DEED_IMPORT_BATCHES)',
      price: 'MLS sold price for MLS rows; view sale_price for public-record rows; deed price for deeds',
      price_estimated: "deed price_code says 'Estimated Sales Price' (vendor estimate, not a recorded price)",
      buyer_type: 'institutional | investor | individual | unknown (category only; no names)',
      dedup: "{role:'winner', merged:[ids], basis, filled:[fields]} | {role:'loser', winner, basis} | null",
      package_n: 'parcels sharing the same (sale_date, price) package cluster; 0 = none',
      eng: 'engine-pool detail features read by the production scorer (pool rows only)',
      est_value: 'vendor value as of import (comp-side nominal check only; never used for a subject)',
      est_repairs: 'vendor repair estimate as of import (pool only); not point-in-time, used only by the replica fidelity check',
    },
    privacy: {
      never_persisted: ['owner/buyer/seller names (dropped on receipt)', 'buyer_company', 'seller_company', 'buyer_id', 'street addresses (md5 keys only)', 'phones/emails'],
      buyer_type_derivation: 'pool: buyer_comp_raw_v2.is_corporate_owner; deeds: w8c archetype, else MV buyer_kind category',
    },
    as_of_caveat: 'Backtests treat sale/known_date as knowledge time. LeadCommand actually ingested the pool on 2026-05-16/17 and the deeds from 2026-07-26, so live knowledge at T was lower than an event-time replay assumes.',
    row_counts: counts,
    files,
    code: gitInfo([SCRIPT_PATH]),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const region of spec.regions) {
    for (const src of ['pool', 'deeds']) {
      const file = path.join(workDir, `${region.region}.${src}.ndjson`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  console.log(`manifest: ${path.join(outDir, 'manifest.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`snapshot failed: ${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
