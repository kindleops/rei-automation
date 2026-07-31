/**
 * Offerr comp-intelligence — source-control contract tests.
 *
 * These are the guards that keep the parity claim honest over time. They need
 * no database; they assert properties of the repository itself:
 *
 *   * the canonical contract directory still describes the recovered production
 *     surface (32-column RPC, exact signature, all four objects);
 *   * the staging bootstrap builds that surface from the canonical files rather
 *     than re-implementing it;
 *   * the E2E harness does not inject comps, buyers or the subject loader —
 *     the regression this whole work item exists to prevent;
 *   * the drift checker's machine-readable failure codes match the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAILURE_CODES, loadContract, CONTRACT_PATH } from '../../scripts/offerr/offerr-schema-drift-check.mjs';
import { CASES, SYNTHETIC_COMPS, SYNTHETIC_BUYERS, SYNTHETIC_PROPERTIES } from '../../scripts/offerr/offerr-staging-fixtures.mjs';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_DIR = path.join(API_ROOT, 'supabase/contracts/offerr-comp-intelligence');
const CANONICAL_DIR = path.join(CONTRACT_DIR, 'canonical');
const BOOTSTRAP = path.join(API_ROOT, 'scripts/offerr/offerr-staging-bootstrap.sql');
const E2E = path.join(API_ROOT, 'scripts/offerr/offerr-e2e-verify.mjs');

const read = (p) => fs.readFileSync(p, 'utf8');

const CANONICAL_FILES = [
  '010_properties.sql',
  '020_buyer_comp_raw_v2.sql',
  '030_buyer_entities_v2.sql',
  '040_v_recent_sold_comps.sql',
  '050_get_comp_candidates_for_subject.sql',
];

test('every canonical contract file is source-controlled', () => {
  for (const f of CANONICAL_FILES) {
    const p = path.join(CANONICAL_DIR, f);
    assert.ok(fs.existsSync(p), `${f} is missing`);
    assert.ok(read(p).length > 200, `${f} is suspiciously small`);
  }
  assert.ok(fs.existsSync(path.join(CONTRACT_DIR, 'README.md')));
  assert.ok(fs.existsSync(CONTRACT_PATH));
});

test('the machine-readable contract pins the recovered RPC signature and 32-column result', () => {
  const c = loadContract();
  assert.equal(c.schema_contract_version, '1.0.0');
  assert.equal(c.rpc.name, 'get_comp_candidates_for_subject');
  assert.equal(
    c.rpc.identity_arguments,
    'p_subject_property_id text, p_radius_miles numeric, p_months_back integer, p_limit integer',
  );
  assert.equal(c.rpc.result_columns.length, 32);
  assert.equal(c.rpc.volatility, 'STABLE');
  assert.equal(c.rpc.security_definer, false);
  assert.deepEqual(c.rpc.writes, [], 'the comp RPC must be declared write-free');
  assert.deepEqual(c.rpc.reads, ['public.v_recent_sold_comps', 'public.properties']);

  // comp_id is a uuid — the fact the previous behavioural stand-in got wrong,
  // and the reason the identity join to buyer_comp_raw_v2.id works at all.
  const compId = c.rpc.result_columns[0];
  assert.deepEqual(compId, { name: 'comp_id', type: 'uuid' });
  assert.ok(!c.rpc.result_columns.some((col) => col.name === 'id'),
    'the canonical contract returns comp_id only, never a separate id column');
});

test('the canonical RPC file carries the verbatim production definition', () => {
  const sql = read(path.join(CANONICAL_DIR, '050_get_comp_candidates_for_subject.sql'));
  assert.match(sql, /EXACT PRODUCTION DEFINITION \(verbatim pg_get_functiondef\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_comp_candidates_for_subject/);
  assert.match(sql, /RETURNS TABLE\(comp_id uuid/);
  // The load-bearing facts of the recovered body.
  assert.match(sql, /from public\.v_recent_sold_comps c/);
  assert.match(sql, /c\.is_usable_comp = true/);
  assert.match(sql, /c\.property_id is distinct from s\.property_id/);
  assert.match(sql, /limit least\(greatest\(p_limit, 1\), 100\)/);
  assert.match(sql, /3958\.8 \* acos/, 'spherical law of cosines, not haversine');
  // The known gap must stay documented in the file that reproduces it.
  assert.match(sql, /KNOWN PRODUCTION DEFECT/);
});

test('the canonical view file explains the gating semantics it encodes', () => {
  const sql = read(path.join(CANONICAL_DIR, '040_v_recent_sold_comps.sql'));
  assert.match(sql, /CREATE OR REPLACE VIEW public\.v_recent_sold_comps/);
  assert.match(sql, /FROM buyer_comp_raw_v2/);
  assert.match(sql, /import_status IS DISTINCT FROM 'rejected'/);
  assert.match(sql, /AS is_usable_comp/);
  assert.match(sql, /AS computed_ppsf/);
  assert.match(sql, /does NOT reject zero\/negative/i);
});

test('the staging bootstrap builds the surface from the canonical files, not its own copy', () => {
  const sql = read(BOOTSTRAP);
  for (const f of CANONICAL_FILES) {
    assert.match(sql, new RegExp(`\\\\ir \\.\\./\\.\\./supabase/contracts/offerr-comp-intelligence/canonical/${f}`),
      `bootstrap does not \\ir-include ${f}`);
  }
  // A second definition of any canonical object would reintroduce drift.
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.get_comp_candidates_for_subject/.test(sql),
    'the bootstrap must not define the comp RPC itself');
  assert.ok(!/CREATE OR REPLACE VIEW public\.v_recent_sold_comps/.test(sql),
    'the bootstrap must not define the comp view itself');
  assert.ok(!/CREATE TABLE IF NOT EXISTS public\.buyer_comp_raw_v2/.test(sql),
    'the bootstrap must not define the comp table itself');
});

test('the staging bootstrap refuses non-synthetic property, comp and buyer data', () => {
  const sql = read(BOOTSTRAP);
  assert.match(sql, /REFUSING TO BOOTSTRAP/);
  for (const table of ['public.properties', 'public.buyer_comp_raw_v2', 'public.buyer_entities_v2']) {
    assert.ok(sql.includes(table), `${table} is not checked by the refusal guard`);
  }
  assert.match(sql, /NOT LIKE 'OFFERR-STAGING-TEST-%'/);
  assert.match(sql, /Aborting before any DDL/);
});

test('the staging bootstrap records a schema-contract version and asserts the RPC contract', () => {
  const sql = read(BOOTSTRAP);
  const contract = loadContract();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.comp_intelligence_schema_contract/);
  assert.ok(sql.includes(`'${contract.schema_contract_version}'`),
    'bootstrap does not record the current contract version');
  assert.ok(sql.includes(contract.rpc.identity_arguments),
    'bootstrap does not assert the canonical RPC signature');
  assert.match(sql, /rpc_result_contract_mismatch/);
  assert.match(sql, /result_cols <> 32/);
});

test('the staging bootstrap pins every automation flag OFF', () => {
  const sql = read(BOOTSTRAP);
  const section = sql.slice(sql.indexOf('INSERT INTO public.system_control'), sql.indexOf('ON CONFLICT (key)'));
  const values = [...section.matchAll(/\('([a-z0-9_]+)',\s*'([a-z]+)'\)/g)];
  assert.ok(values.length >= 10, 'flag seed list looks truncated');
  for (const [, key, value] of values) {
    assert.equal(value, 'false', `${key} must be seeded false in staging`);
  }
  assert.ok(values.some(([, k]) => k === 'offerr_evaluation_enabled'));
});

test('the E2E harness injects NO comp candidates, comps, buyers or subject loader', () => {
  // The precise regression this work item removed. If any of these reappear as
  // an injected dependency, the harness stops proving the real comp path.
  const src = read(E2E);
  const banned = [
    'loadV3CompCandidates:',
    'loadComparableProperties:',
    'loadBuyerPurchases:',
    'loadSubjectProperty:',
    'calculateDecision:',
    'resolveSubjectProperty:',
  ];
  for (const token of banned) {
    assert.ok(!src.includes(token), `E2E harness injects ${token} — the real comp path is bypassed`);
  }
  // And it must still assert this about itself at runtime.
  assert.match(src, /harness injects no comp candidates/);
  assert.match(src, /the canonical comp RPC was actually invoked through the adapter/);
});

test('fixtures express the matrix as database rows, not injected comp arrays', () => {
  for (const c of CASES) {
    assert.ok(!('comps' in c), `${c.id} still carries an injected comps array`);
    assert.ok('comp_expect' in c, `${c.id} has no comp_expect contract`);
  }
  assert.ok(SYNTHETIC_COMPS.length > 0, 'no comp rows are defined');
  assert.ok(SYNTHETIC_BUYERS.length > 0, 'no buyer entities are defined');
  assert.equal(CASES.length, 12, 'the 12-case matrix must be preserved');
});

test('every fixture identifier is synthetic so the bootstrap guard can recognise it', () => {
  for (const p of SYNTHETIC_PROPERTIES) {
    assert.match(p.property_id, /^OFFERR-STAGING-TEST-/);
    assert.match(p.property_address_full, /Sandbox/);
  }
  for (const c of SYNTHETIC_COMPS) {
    assert.match(c.source_record_id, /^OFFERR-STAGING-TEST-/);
    assert.match(c.row_hash, /^OFFERR-STAGING-TEST-/);
    assert.match(c.property_id, /^OFFERR-STAGING-TEST-/);
  }
  for (const b of SYNTHETIC_BUYERS) {
    assert.match(b.buyer_key, /^OFFERR-STAGING-TEST-/);
    assert.match(b.buyer_name, /Sandbox/);
  }
});

test('comp fixtures are deterministic and satisfy is_usable_comp', () => {
  const ids = SYNTHETIC_COMPS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'comp uuids collide');
  assert.equal(new Set(SYNTHETIC_COMPS.map((c) => c.row_hash)).size, ids.length,
    'row_hash is UNIQUE in the canonical contract');
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
  // v_recent_sold_comps.is_usable_comp requires all of these to be NOT NULL.
  for (const c of SYNTHETIC_COMPS) {
    for (const col of ['sale_date', 'latitude', 'longitude', 'property_address_full', 'property_address_zip']) {
      assert.ok(c[col] !== null && c[col] !== undefined, `${c.source_record_id}.${col} is null`);
    }
    assert.ok(c.sale_price != null || c.mls_sold_price != null,
      `${c.source_record_id} has no coalesced sale price`);
    assert.notEqual(c.import_status, 'rejected');
  }
});

test('each case owns a coordinate island wider than its comp radius', () => {
  // The correctness condition for the real RPC path: subjects must be far
  // enough apart that one case's comps can never appear in another's candidate
  // set. The widest window compCandidateLoader uses is 20 miles (land), and the
  // residential window is 4 miles; islands are ~17 miles apart, so no two
  // residential subjects can share comps.
  const subjects = SYNTHETIC_PROPERTIES.map((p) => ({ id: p.property_id, lat: p.latitude, lon: p.longitude }));
  const milesBetween = (a, b) => {
    const R = 3958.8;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  // Group subjects that intentionally share an island (the resolution-only
  // ambiguity cases), then require distinct islands to be >= 8 miles apart:
  // 4-mile radius around each of two subjects cannot overlap at 8 miles.
  const compBearing = new Set(['P001', 'P002', 'P003', 'P004', 'P030', 'P031', 'P032', 'P033']
    .map((s) => `OFFERR-STAGING-TEST-${s}`));
  const withComps = subjects.filter((s) => compBearing.has(s.id));
  for (let i = 0; i < withComps.length; i += 1) {
    for (let j = i + 1; j < withComps.length; j += 1) {
      const d = milesBetween(withComps[i], withComps[j]);
      assert.ok(d >= 8, `${withComps[i].id} and ${withComps[j].id} are only ${d.toFixed(1)} mi apart`);
    }
  }
});

test('the package fixture models one economic transaction across many parcels', () => {
  const pkg = SYNTHETIC_COMPS.filter((c) => c.source_record_id.includes('-C10-'));
  assert.equal(pkg.length, 12);
  assert.equal(new Set(pkg.map((c) => c.sale_price)).size, 1, 'identical consideration');
  assert.equal(new Set(pkg.map((c) => c.sale_date)).size, 1, 'identical date');
  assert.equal(new Set(pkg.map((c) => c.owner_name)).size, 1, 'identical buyer');
  assert.equal(new Set(pkg.map((c) => c.apn_parcel_id)).size, 12, 'twelve distinct parcels');
  // sqft varies so similarity_score is distinct per row and the canonical
  // ORDER BY is a total order over this set.
  assert.equal(new Set(pkg.map((c) => c.building_square_feet)).size, 12);
});

test('the duplicate-row fixture shares a parcel key with a real comp', () => {
  const c01 = SYNTHETIC_COMPS.filter((c) => c.source_record_id.includes('-C01-'));
  const byApn = new Map();
  for (const c of c01) byApn.set(c.apn_parcel_id, (byApn.get(c.apn_parcel_id) ?? 0) + 1);
  const duped = [...byApn.entries()].filter(([, n]) => n > 1);
  assert.equal(duped.length, 1, 'exactly one duplicated parcel is modelled');
  const [apn] = duped[0];
  const rows = c01.filter((c) => c.apn_parcel_id === apn);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.id)).size, 2, 'distinct primary keys');
  assert.equal(new Set(rows.map((r) => r.sale_price)).size, 1, 'same consideration');
  assert.equal(new Set(rows.map((r) => r.sale_date)).size, 1, 'same date');
  assert.equal(new Set(rows.map((r) => r.owner_name)).size, 1, 'same buyer -> same cluster');
});

test('the extreme-comp fixture is extreme enough to trip every quarantine rule', () => {
  const extreme = SYNTHETIC_COMPS.find((c) => c.source_record_id.includes('-C09-COMP-80'));
  assert.ok(extreme, 'the contaminated comp fixture is missing');
  assert.equal(extreme.sale_price, 332_500_000);
  // SFR lane ceiling is 30_000_000; PPSF bound is 2_000; anchor multiple is 4x
  // against a 185_000 subject.
  assert.ok(extreme.sale_price > 30_000_000, 'exceeds the SFR lane ceiling');
  assert.ok(extreme.sale_price / extreme.building_square_feet > 2_000, 'implausible PPSF');
  assert.ok(extreme.sale_price / 185_000 > 4, 'exceeds the anchor multiple');
});

test('drift-check failure codes match the contract exactly', () => {
  const contract = loadContract();
  assert.deepEqual([...FAILURE_CODES].sort(), [...contract.failure_codes].sort());
  for (const code of FAILURE_CODES) {
    assert.match(code, /^[a-z0-9_]+$/, 'failure codes must be stable machine-readable slugs');
  }
  // The codes named in the mission brief must all be present.
  for (const required of [
    'missing_properties_table', 'missing_comp_table', 'missing_buyer_entity_table',
    'missing_comp_rpc', 'comp_rpc_signature_mismatch', 'comp_rpc_result_contract_mismatch',
    'schema_contract_version_mismatch',
  ]) {
    assert.ok(FAILURE_CODES.includes(required), `${required} is not emitted by the drift checker`);
  }
});

test('the drift checker never mutates schema', () => {
  const src = read(path.join(API_ROOT, 'scripts/offerr/offerr-schema-drift-check.mjs'));
  for (const forbidden of [/\bCREATE\s+TABLE/i, /\bALTER\s+TABLE/i, /\bDROP\s+/i, /\bINSERT\s+INTO/i, /\bUPDATE\s+public/i]) {
    assert.ok(!forbidden.test(src), `drift checker contains a mutating statement: ${forbidden}`);
  }
  assert.match(src, /default_transaction_read_only=on/);
  assert.match(src, /BEGIN TRANSACTION READ ONLY/);
});

test('the contract README classifies parity honestly', () => {
  const readme = read(path.join(CONTRACT_DIR, 'README.md'));
  assert.match(readme, /EXACT_PRODUCTION_DEFINITION/);
  assert.match(readme, /Open production-parity risks/);
  assert.match(readme, /Licensing and data-rights boundary/);
  // The stand-in must be described as removed, not as current.
  assert.match(readme, /Nothing in this directory is in this class any more/);

  const contract = loadContract();
  assert.equal(contract.parity['public.get_comp_candidates_for_subject'], 'EXACT_PRODUCTION_DEFINITION');
  assert.equal(contract.parity['public.v_recent_sold_comps'], 'EXACT_PRODUCTION_DEFINITION');
  assert.equal(contract.parity['public.properties'], 'COMPATIBLE_RECONSTRUCTION_READ_SURFACE_SUBSET');
});

test('no production credential or row data leaked into the contract directory', () => {
  const files = [
    path.join(CONTRACT_DIR, 'README.md'),
    CONTRACT_PATH,
    ...CANONICAL_FILES.map((f) => path.join(CANONICAL_DIR, f)),
  ];
  for (const f of files) {
    const body = read(f);
    assert.ok(!/postgresql:\/\/[^\s"']*:[^\s"'@]+@/.test(body), `${f} contains a connection string with a password`);
    assert.ok(!/\beyJ[A-Za-z0-9_-]{20,}/.test(body), `${f} contains what looks like a JWT`);
    assert.ok(!/SUPABASE_SERVICE_ROLE_KEY\s*=/.test(body), `${f} contains a service-role key assignment`);
  }
});
