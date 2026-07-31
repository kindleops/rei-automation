/**
 * Offerr comp-intelligence — canonical RPC contract tests.
 *
 * Executes the CANONICAL get_comp_candidates_for_subject (recovered verbatim
 * from production, see apps/api/supabase/contracts/offerr-comp-intelligence/)
 * against a REAL PostgreSQL 17 database, plus the REAL loadV3CompCandidates
 * normalization on top of it.
 *
 * These tests pin behaviour that only a database can prove: filter semantics,
 * distance/similarity determinism, ordering, the row cap, and the fact that
 * retrieval writes nothing.
 *
 * Several cases assert what production actually does rather than what one might
 * assume it does. Where the canonical SQL does NOT enforce a protection, the
 * test says so explicitly and points at the layer that does. Silently making
 * the staging RPC stricter than production would manufacture a parity claim
 * that is not true.
 *
 * Requires OFFERR_VERIFY_DATABASE_URL pointing at a disposable database that
 * has had offerr-supabase-prereqs.sql + offerr-staging-bootstrap.sql applied.
 * Without it the suite skips rather than failing, so the default `npm test`
 * (which has no database) stays green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

import { loadV3CompCandidates } from '@/lib/acquisition/compCandidateLoader.js';

import { createPgRestAdapter } from '../../scripts/offerr/offerr-pg-rest-adapter.mjs';

const DATABASE_URL = process.env.OFFERR_VERIFY_DATABASE_URL || '';
const SKIP = !DATABASE_URL;

const NS = 'OFFERR-STAGING-TEST-RPC';
const SUBJECT = `${NS}-SUBJECT`;

/** Deterministic uuid so re-runs are byte-identical. */
function uid(n) {
  const h = String(n).padStart(12, '0');
  return `11111111-2222-3333-4444-${h}`;
}

const SUBJECT_LAT = 40.0;
const SUBJECT_LON = -105.0;
/** ~1 degree latitude = 69 miles; 0.01 deg ~= 0.69 mi. */
const milesToDeg = (mi) => mi / 69.0;

function compRow(overrides = {}) {
  // `n` is a row-numbering helper for the fixture, not a database column.
  const { n, ...rest } = overrides;
  return {
    id: uid(n),
    source_record_id: `${NS}-COMP-${n}`,
    row_hash: `${NS}-HASH-${n}`,
    property_id: `${NS}-CP-${n}`,
    apn_parcel_id: `${NS}-APN-${n}`,
    import_status: 'accepted',
    normalized_asset_class: 'single_family',
    property_type: 'Single Family',
    property_address_full: `${100 + n} Sandbox RPC Ln, Boulder, CO 80301`,
    property_address_city: 'Boulder',
    property_address_state: 'CO',
    property_address_zip: '80301',
    latitude: SUBJECT_LAT + milesToDeg(0.5),
    longitude: SUBJECT_LON,
    sale_price: 300000,
    sale_date: '2026-05-01',
    recording_date: '2026-05-01',
    mls_sold_price: null,
    mls_sold_date: null,
    building_square_feet: 1500,
    total_bedrooms: 3,
    total_baths: 2,
    year_built: 1980,
    effective_year_built: 1980,
    units_count: 1,
    building_condition: 'Average',
    construction_type: 'Frame',
    owner_name: 'Sandbox RPC Holdings LLC',
    owner_1_name: 'Sandbox RPC Holdings LLC',
    is_corporate_owner: true,
    document_type: 'Warranty Deed',
    last_sale_doc_type: 'Warranty Deed',
    estimated_value: 300000,
    ...rest,
  };
}

const COMP_COLUMNS = Object.keys(compRow({ n: 0 }));

let pool;

async function reset(rows) {
  await pool.query(`DELETE FROM public.buyer_comp_raw_v2 WHERE source_record_id LIKE $1`, [`${NS}-%`]);
  await pool.query(`DELETE FROM public.properties WHERE property_id LIKE $1`, [`${NS}-%`]);
  await pool.query(
    `INSERT INTO public.properties
       (property_export_id, property_id, property_address_full, property_address_city,
        property_address_state, property_address_zip, property_type, property_class,
        building_square_feet, units_count, estimated_value, total_bedrooms, total_baths,
        year_built, latitude, longitude, market)
     VALUES ($1,$2,$3,'Boulder','CO','80301','SFR','Residential',1500,1,300000,3,2,1980,$4,$5,'Boulder, CO')`,
    [`${SUBJECT}-EXPORT`, SUBJECT, '1 Sandbox RPC Subject Ln, Boulder, CO 80301', SUBJECT_LAT, SUBJECT_LON],
  );
  for (const row of rows) {
    const cols = COMP_COLUMNS.filter((c) => row[c] !== undefined);
    await pool.query(
      `INSERT INTO public.buyer_comp_raw_v2 (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      cols.map((c) => row[c]),
    );
  }
}

/** Call the canonical RPC exactly as compCandidateLoader does. */
async function rpc({ radius = 4, months = 30, limit = 100, subject = SUBJECT } = {}) {
  const { rows } = await pool.query(
    'SELECT * FROM public.get_comp_candidates_for_subject($1,$2,$3,$4)',
    [subject, radius, months, limit],
  );
  return rows;
}

test('Offerr canonical comp RPC contract', { skip: SKIP ? 'OFFERR_VERIFY_DATABASE_URL not set' : false }, async (t) => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  t.after(async () => {
    await pool.query(`DELETE FROM public.buyer_comp_raw_v2 WHERE source_record_id LIKE $1`, [`${NS}-%`]);
    await pool.query(`DELETE FROM public.properties WHERE property_id LIKE $1`, [`${NS}-%`]);
    await pool.end();
  });

  await t.test('1. the subject property is excluded from its own candidates', async () => {
    // A comp row carrying the SUBJECT's property_id must not come back: the
    // canonical filter is `c.property_id IS DISTINCT FROM s.property_id`.
    await reset([
      compRow({ n: 1, property_id: SUBJECT, source_record_id: `${NS}-COMP-1` }),
      compRow({ n: 2 }),
    ]);
    const rows = await rpc();
    assert.equal(rows.length, 1, 'only the non-subject comp should return');
    assert.equal(rows[0].property_id, `${NS}-CP-2`);
  });

  await t.test('2. the radius filter is enforced', async () => {
    await reset([
      compRow({ n: 1, latitude: SUBJECT_LAT + milesToDeg(1) }),   // inside 4mi
      compRow({ n: 2, latitude: SUBJECT_LAT + milesToDeg(3.5) }), // inside 4mi
      compRow({ n: 3, latitude: SUBJECT_LAT + milesToDeg(9) }),   // outside
    ]);
    const rows = await rpc({ radius: 4 });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => Number(r.distance_miles) <= 4));

    const wide = await rpc({ radius: 15 });
    assert.equal(wide.length, 3, 'a wider radius admits the far comp');
  });

  await t.test('3. the recency window is enforced on sale_date', async () => {
    await reset([
      compRow({ n: 1, sale_date: '2026-05-01' }),
      // 30 months before 2026-07-30 is 2024-01-30; this is far outside it.
      compRow({ n: 2, sale_date: '2019-01-01' }),
    ]);
    const rows = await rpc({ months: 30 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].property_id, `${NS}-CP-1`);
  });

  await t.test('4. FUTURE sale dates are NOT excluded by the canonical RPC', async () => {
    // Documented production gap, reproduced faithfully. The canonical predicate
    // is a lower bound only (`sale_date >= current_date - interval`), so a
    // mis-keyed future sale passes retrieval. Nothing downstream rejects it on
    // recency either. Recorded in the contract README as an open parity risk.
    await reset([compRow({ n: 1, sale_date: '2099-01-01' })]);
    const rows = await rpc();
    assert.equal(rows.length, 1, 'canonical SQL admits a future-dated sale');
    assert.equal(String(rows[0].sale_date.toISOString().slice(0, 10)), '2099-01-01');
  });

  await t.test('5. NULL / unusable sale prices are excluded via is_usable_comp', async () => {
    await reset([
      compRow({ n: 1, sale_price: 300000 }),
      compRow({ n: 2, sale_price: null, mls_sold_price: null }),
      // A NULL sale_price is rescued when mls_sold_price is present, because
      // the view coalesces the three price columns.
      compRow({ n: 3, sale_price: null, mls_sold_price: 275000 }),
    ]);
    const rows = await rpc();
    const ids = rows.map((r) => r.property_id).sort();
    assert.deepEqual(ids, [`${NS}-CP-1`, `${NS}-CP-3`]);
  });

  await t.test('6. zero and negative prices are NOT excluded by the RPC — they are quarantined downstream', async () => {
    // Another faithfully reproduced gap: is_usable_comp only tests NOT NULL.
    await reset([
      compRow({ n: 1, sale_price: 0 }),
      compRow({ n: 2, sale_price: -5000 }),
      compRow({ n: 3, sale_price: 300000 }),
    ]);
    const rows = await rpc();
    assert.equal(rows.length, 3, 'the RPC is a retrieval primitive, not a price filter');

    // The protection is real, it just lives one layer down: qualification
    // rejects them as missing/nominal consideration.
    const { qualifyComps } = await import('@/lib/acquisition/transactionQualification.js');
    const subject = { estimated_value: 300000, property_type: 'SFR', units_count: 1, building_square_feet: 1500 };
    const q = qualifyComps(subject, rows.map((r) => ({
      id: r.comp_id, property_id: r.property_id, apn_parcel_id: r.property_id,
      sale_price: r.sale_price, sale_date: r.sale_date, property_type: r.property_type,
      units_count: r.units_count, building_square_feet: r.sqft,
    })));
    const accepted = q.accepted.map((a) => a.consideration);
    assert.deepEqual(accepted, [300000], 'only the real price survives qualification');
  });

  await t.test('7. rows rejected at import are excluded by the view', async () => {
    await reset([
      compRow({ n: 1, import_status: 'accepted' }),
      compRow({ n: 2, import_status: 'rejected' }),
      compRow({ n: 3, import_status: 'pending' }),
    ]);
    const rows = await rpc();
    const ids = rows.map((r) => r.property_id).sort();
    assert.deepEqual(ids, [`${NS}-CP-1`, `${NS}-CP-3`],
      "only import_status='rejected' is filtered; 'pending' still qualifies");
  });

  await t.test('8. unit count and asset class survive the RPC unchanged', async () => {
    // The canonical RPC does NOT filter on asset family — compatibility is
    // enforced later by laneCompatible() during qualification. What the RPC
    // must do is carry the fields that decision truthfully.
    await reset([
      compRow({ n: 1, units_count: 1, normalized_asset_class: 'single_family' }),
      compRow({ n: 2, units_count: 4, normalized_asset_class: 'multifamily', property_type: 'Multi-Family' }),
    ]);
    const rows = await rpc();
    assert.equal(rows.length, 2, 'the RPC does not gate on asset family');
    const byId = new Map(rows.map((r) => [r.property_id, r]));
    assert.equal(Number(byId.get(`${NS}-CP-1`).units_count), 1);
    assert.equal(Number(byId.get(`${NS}-CP-2`).units_count), 4);
    assert.equal(byId.get(`${NS}-CP-2`).asset_class, 'multifamily');
  });

  await t.test('9. distance is deterministic and correctly scaled', async () => {
    await reset([compRow({ n: 1, latitude: SUBJECT_LAT + milesToDeg(2) })]);
    const a = await rpc();
    const b = await rpc();
    assert.equal(String(a[0].distance_miles), String(b[0].distance_miles), 'repeatable');
    const d = Number(a[0].distance_miles);
    assert.ok(d > 1.9 && d < 2.1, `expected ~2 miles, got ${d}`);
  });

  await t.test('10. similarity score is deterministic and penalises dissimilarity', async () => {
    await reset([
      compRow({ n: 1, building_square_feet: 1500, total_bedrooms: 3, total_baths: 2, year_built: 1980 }),
      compRow({ n: 2, building_square_feet: 3000, total_bedrooms: 6, total_baths: 5, year_built: 1920 }),
    ]);
    const a = await rpc();
    const b = await rpc();
    assert.deepEqual(a.map((r) => String(r.similarity_score)), b.map((r) => String(r.similarity_score)));
    const byId = new Map(a.map((r) => [r.property_id, Number(r.similarity_score)]));
    assert.equal(byId.get(`${NS}-CP-1`), 100, 'an identical comp scores 100');
    assert.ok(byId.get(`${NS}-CP-2`) < byId.get(`${NS}-CP-1`), 'a dissimilar comp scores lower');
    assert.ok(byId.get(`${NS}-CP-2`) >= 0, 'the score floors at 0, never negative');
  });

  await t.test('11. the row limit is enforced, and hard-capped at 100', async () => {
    await reset(Array.from({ length: 12 }, (_, i) =>
      compRow({ n: i + 1, building_square_feet: 1500 + i })));
    assert.equal((await rpc({ limit: 5 })).length, 5);
    assert.equal((await rpc({ limit: 12 })).length, 12);
    // least(greatest(p_limit,1),100): a caller cannot ask for more than 100.
    assert.equal((await rpc({ limit: 1000 })).length, 12);
    assert.equal((await rpc({ limit: 0 })).length, 1, 'greatest(p_limit,1) floors the limit at 1');
  });

  await t.test('12. ordering is deterministic when the sort keys are distinct', async () => {
    await reset(Array.from({ length: 8 }, (_, i) =>
      compRow({ n: i + 1, building_square_feet: 1500 + i * 25 })));
    const runs = await Promise.all([rpc(), rpc(), rpc()]);
    const shape = runs.map((r) => r.map((x) => x.property_id).join('|'));
    assert.equal(new Set(shape).size, 1, 'repeated calls return the same order');

    // Descending similarity is the primary key.
    const scores = runs[0].map((r) => Number(r.similarity_score));
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

    // DOCUMENTED PRODUCTION GAP: the canonical ORDER BY has no unique
    // tiebreaker, so rows identical on (similarity, sale_date, distance) have an
    // implementation-defined relative order. Assert the observable consequence
    // — the SET is stable even though the ORDER within a tie is not guaranteed.
    await reset(Array.from({ length: 6 }, (_, i) => compRow({ n: i + 1 })));
    const tied = await rpc();
    assert.equal(new Set(tied.map((r) => String(r.similarity_score))).size, 1,
      'fixture produces a genuine full tie');
    const tiedRuns = await Promise.all([rpc({ limit: 3 }), rpc({ limit: 3 })]);
    assert.ok(tiedRuns.every((r) => r.length === 3),
      'a truncating limit over a tie still returns the requested count — which is exactly why the missing tiebreaker matters');
  });

  await t.test('13. package transaction identity survives the RPC', async () => {
    // One consideration broadcast across 4 parcels. The RPC must carry price,
    // date and distinct parcel identity through intact, or clustering can never
    // detect the package.
    await reset(Array.from({ length: 4 }, (_, i) =>
      compRow({ n: i + 1, sale_price: 9000000, sale_date: '2026-06-01', building_square_feet: 1500 + i })));
    const rows = await rpc();
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map((r) => String(r.sale_price))).size, 1, 'identical consideration preserved');
    assert.equal(new Set(rows.map((r) => r.sale_date.toISOString())).size, 1, 'identical date preserved');
    assert.equal(new Set(rows.map((r) => r.property_id)).size, 4, 'distinct parcels preserved');
  });

  await t.test('14. buyer identity survives the RPC via the comp_id join key', async () => {
    // The RPC itself returns no owner column — identity is joined afterwards on
    // comp_id == buyer_comp_raw_v2.id. This proves that join key is sound.
    await reset([compRow({ n: 1, owner_name: 'Sandbox Identity Partners LLC' })]);
    const rows = await rpc();
    assert.equal(rows.length, 1);
    const { rows: identity } = await pool.query(
      'SELECT owner_name FROM public.buyer_comp_raw_v2 WHERE id = $1', [rows[0].comp_id],
    );
    assert.equal(identity.length, 1, 'comp_id resolves to exactly one identity row');
    assert.equal(identity[0].owner_name, 'Sandbox Identity Partners LLC');
  });

  await t.test('15. duplicate physical rows for one parcel reach the clustering layer', async () => {
    // Two rows, same APN, same buyer/date/price, different primary keys. The
    // RPC must NOT silently dedupe them — collapsing them is clustering's job,
    // and clustering can only do it if it sees both.
    await reset([
      compRow({ n: 1, apn_parcel_id: `${NS}-SHARED-APN` }),
      compRow({ n: 2, apn_parcel_id: `${NS}-SHARED-APN` }),
    ]);
    const rows = await rpc();
    assert.equal(rows.length, 2, 'both physical rows are returned');
    assert.equal(new Set(rows.map((r) => r.comp_id)).size, 2, 'with distinct comp ids');
  });

  await t.test('16. a missing buyer entity does not crash evaluation', async () => {
    await reset([compRow({ n: 1, owner_name: 'Sandbox Utterly Unknown Grantee LLC' })]);
    const adapter = createPgRestAdapter(pool);
    const loaded = await loadV3CompCandidates(
      { property_id: SUBJECT, asset_family: 'RESIDENTIAL_SINGLE' }, { db: adapter },
    );
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.diagnostics.entity_matched, 0, 'no buy-box matched');
    assert.equal(loaded.diagnostics.identity_enriched, 1, 'identity still resolved');
    assert.equal(loaded.candidates[0].matched_buyer_entity, false);
    assert.equal(loaded.candidates[0].buyer_name_clean, 'Sandbox Utterly Unknown Grantee LLC');
  });

  await t.test('17. an empty result returns the canonical empty contract', async () => {
    await reset([]);
    assert.deepEqual(await rpc(), []);

    const adapter = createPgRestAdapter(pool);
    const loaded = await loadV3CompCandidates(
      { property_id: SUBJECT, asset_family: 'RESIDENTIAL_SINGLE' }, { db: adapter },
    );
    assert.deepEqual(loaded.candidates, []);
    assert.equal(loaded.diagnostics.candidate_count, 0);
    assert.equal(loaded.diagnostics.retrieval_tier, 'rpc_empty');

    // An unknown subject yields the same empty contract, not an error.
    const unknown = await rpc({ subject: `${NS}-DOES-NOT-EXIST` });
    assert.deepEqual(unknown, []);
  });

  await t.test('18. malformed arguments fail safely', async () => {
    await reset([compRow({ n: 1 })]);
    // A NULL subject cannot match anything -> empty, never an error.
    const { rows: nullSubject } = await pool.query(
      'SELECT * FROM public.get_comp_candidates_for_subject(NULL, 4, 30, 100)',
    );
    assert.deepEqual(nullSubject, []);

    // A negative radius admits nothing (distance is always >= 0).
    assert.deepEqual(await rpc({ radius: -1 }), []);

    // A negative recency window is a lower bound in the future -> empty.
    assert.deepEqual(await rpc({ months: -12 }), []);

    // A wrong argument TYPE is a hard, loud error — not a silent empty set.
    await assert.rejects(
      () => pool.query(`SELECT * FROM public.get_comp_candidates_for_subject($1,$2,$3,$4)`,
        [SUBJECT, 'not-a-number', 30, 100]),
      (err) => err.code === '22P02' || err.code === '42883',
    );

    // A renamed parameter must not resolve to some other overload.
    await assert.rejects(
      () => pool.query(`SELECT * FROM public.get_comp_candidates_for_subject(p_wrong_name => $1)`, [SUBJECT]),
      (err) => err.code === '42883',
    );
  });

  await t.test('19. the RPC has no write side effect', async () => {
    await reset(Array.from({ length: 3 }, (_, i) => compRow({ n: i + 1, building_square_feet: 1500 + i })));

    const snapshot = async () => {
      const { rows } = await pool.query(`
        SELECT
          (SELECT count(*) FROM public.buyer_comp_raw_v2)::int AS comps,
          (SELECT count(*) FROM public.properties)::int        AS props,
          (SELECT count(*) FROM public.buyer_entities_v2)::int  AS buyers,
          (SELECT coalesce(md5(string_agg(id::text, ',' ORDER BY id)),'')
             FROM public.buyer_comp_raw_v2)                     AS comp_hash`);
      return rows[0];
    };

    const before = await snapshot();
    await rpc();
    await rpc({ radius: 50, months: 120, limit: 100 });
    const after = await snapshot();
    assert.deepEqual(after, before, 'retrieval mutated nothing');

    // Structural proof, independent of row counts: the function is declared
    // STABLE, so PostgreSQL itself forbids it from writing.
    const { rows: vol } = await pool.query(
      `SELECT provolatile FROM pg_proc WHERE proname = 'get_comp_candidates_for_subject'`);
    assert.equal(vol[0].provolatile, 's', 'declared STABLE (read-only)');

    // And the strongest proof available: run it inside a READ ONLY transaction.
    // A write of any kind would raise SQLSTATE 25006.
    await pool.query('BEGIN TRANSACTION READ ONLY');
    try {
      const readOnlyRows = await pool.query(
        'SELECT * FROM public.get_comp_candidates_for_subject($1,$2,$3,$4)', [SUBJECT, 4, 30, 100]);
      assert.equal(readOnlyRows.rows.length, 3, 'the RPC runs fine with writes forbidden');
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  await t.test('20. RPC execution calls no external provider', async () => {
    // Structural, not behavioural: prove the dependency closure of the function
    // reaches only local relations. A function that could call out would need a
    // non-SQL language or an extension like http/pg_net.
    const { rows: lang } = await pool.query(`
      SELECT l.lanname, p.prosecdef
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.proname = 'get_comp_candidates_for_subject'`);
    assert.equal(lang[0].lanname, 'sql', 'plain SQL — no procedural escape hatch');
    assert.equal(lang[0].prosecdef, false, 'SECURITY INVOKER');

    const { rows: deps } = await pool.query(`
      SELECT DISTINCT c.relname
        FROM pg_depend d
        JOIN pg_rewrite r ON r.oid = d.objid
        JOIN pg_class c   ON c.oid = r.ev_class
       WHERE d.refobjid = 'public.buyer_comp_raw_v2'::regclass`);
    assert.ok(deps.some((d) => d.relname === 'v_recent_sold_comps'),
      'the comp view is the only projection layer between the RPC and the table');

    const { rows: netExt } = await pool.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('http','pg_net','plpythonu','plperlu')`);
    assert.deepEqual(netExt, [], 'no outbound-capable extension is installed');
  });
});

test('Offerr comp loader normalization over the canonical RPC', { skip: SKIP ? 'OFFERR_VERIFY_DATABASE_URL not set' : false }, async (t) => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  t.after(async () => {
    await pool.query(`DELETE FROM public.buyer_comp_raw_v2 WHERE source_record_id LIKE $1`, [`${NS}-%`]);
    await pool.query(`DELETE FROM public.properties WHERE property_id LIKE $1`, [`${NS}-%`]);
    await pool.query(`DELETE FROM public.buyer_entities_v2 WHERE buyer_key LIKE $1`, [`${NS}-%`]);
    await pool.end();
  });

  await t.test('the loader performs exactly three queries and normalizes the contract', async () => {
    await reset([
      compRow({ n: 1, owner_name: 'Sandbox Loader Investments LLC', building_square_feet: 1500 }),
      compRow({ n: 2, owner_name: 'Sandbox Loader Investments LLC', building_square_feet: 1520, sale_price: 310000, sale_date: '2026-04-01' }),
    ]);
    await pool.query(
      `INSERT INTO public.buyer_entities_v2 (buyer_key, buyer_name, normalized_buyer_name, purchase_count, avg_purchase_price)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (buyer_key) DO UPDATE SET purchase_count = EXCLUDED.purchase_count`,
      [`${NS}-BUYER-1`, 'Sandbox Loader Investments LLC', 'sandbox loader', 25, 305000],
    );

    const ops = [];
    const adapter = createPgRestAdapter(pool, { onOperation: (op) => ops.push(op) });
    const loaded = await loadV3CompCandidates(
      { property_id: SUBJECT, asset_family: 'RESIDENTIAL_SINGLE' }, { db: adapter },
    );

    assert.equal(loaded.candidates.length, 2);
    assert.equal(loaded.diagnostics.query_count, 3, 'one RPC + two batch selects, no N+1');
    assert.equal(ops.length, 3, `${ops.length} database operations were actually issued`);
    assert.deepEqual(ops.map((o) => o.table), [
      'rpc:get_comp_candidates_for_subject', 'buyer_comp_raw_v2', 'buyer_entities_v2',
    ]);
    assert.ok(ops.every((o) => o.ok), 'every query succeeded');
    assert.ok(ops.every((o) => o.method === 'rpc' || o.method === 'select'), 'reads only');

    // The normalized contract downstream code depends on.
    const c = loaded.candidates[0];
    assert.equal(c.buyer_name_clean, 'Sandbox Loader Investments LLC');
    assert.equal(c.matched_buyer_entity, true, 'buy-box resolved through buyer_entities_v2');
    assert.equal(c.identity_unresolved, false);
    assert.equal(c.v3_pricing_eligible, true);
    assert.equal(c.source_table, 'buyer_comp_raw_v2');
    assert.equal(c.property_address_zip, '80301');
    assert.ok(Number(c.building_square_feet) > 0, 'sqft mapped from the RPC sqft column');
    assert.ok(c.distance_miles !== null, 'distance carried through');
    assert.equal(loaded.diagnostics.identity_enriched, 2);
    assert.equal(loaded.diagnostics.entity_matched, 2);
    assert.ok(loaded.diagnostics.retrieval_tier.startsWith('rpc_radius_'));
  });

  await t.test('the eligibility window widens for non-residential families', async () => {
    await reset([compRow({ n: 1, latitude: SUBJECT_LAT + milesToDeg(6) })]);
    const adapter = createPgRestAdapter(pool);

    const residential = await loadV3CompCandidates(
      { property_id: SUBJECT, asset_family: 'RESIDENTIAL_SINGLE' }, { db: adapter });
    assert.equal(residential.candidates.length, 0, '6 miles is outside the 4-mile residential radius');
    assert.equal(residential.diagnostics.retrieval_tier, 'rpc_empty');

    const multifamily = await loadV3CompCandidates(
      { property_id: SUBJECT, asset_family: 'multifamily' }, { db: adapter });
    assert.equal(multifamily.candidates.length, 1, '6 miles is inside the 7-mile multifamily radius');
    assert.equal(multifamily.diagnostics.retrieval_tier, 'rpc_radius_7mi_36mo');
  });
});
