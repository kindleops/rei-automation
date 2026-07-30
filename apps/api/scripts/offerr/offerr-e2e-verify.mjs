/**
 * Offerr Evaluation Spine — end-to-end staging verification harness.
 *
 * Drives the REAL internal route handler (handleOfferrEvaluationsRequest) and
 * the REAL Supabase-backed store against a REAL Postgres database, so that
 * feature-flag gating, persistence, idempotency, concurrency, seller-safe
 * projection, and side-effect containment are proven by observed behaviour
 * rather than asserted from code reading.
 *
 * Target safety: offerr-staging-guard refuses production refs, refuses other
 * products' projects, and requires ALLOW_OFFERR_STAGING_FIXTURES=true.
 *
 * Usage:
 *   ALLOW_OFFERR_STAGING_FIXTURES=true \
 *   OFFERR_VERIFY_DATABASE_URL='postgresql://...' \
 *   node --import ./tests/register-aliases.mjs scripts/offerr/offerr-e2e-verify.mjs
 *
 * Exit code 0 only when every assertion passes.
 */

import pg from 'pg';

import { handleOfferrEvaluationsRequest } from '@/app/api/internal/offerr/evaluations/route.js';
import { OFFERR_FLAG_KEY } from '@/lib/domain/offerr/offerr-contracts.js';

import {
  assertOfferrStagingTarget,
  isLocalTarget,
  printTargetIdentity,
} from './offerr-staging-guard.mjs';
import { createPgRestAdapter } from './offerr-pg-rest-adapter.mjs';
import { CASES, FIXTURE_PREFIX, cleanupFixtures, seedSyntheticProperties } from './offerr-staging-fixtures.mjs';

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'offerr-staging-verify-secret';
const ROUTE_URL = 'https://offerr-staging.invalid/api/internal/offerr/evaluations';

/**
 * Execution/side-effect tables that must remain untouched. Created as empty
 * stubs in the verification database so "zero rows" is a measured fact about a
 * real table, not an inference from the absence of a code reference.
 */
const SIDE_EFFECT_TABLES = [
  'property_acquisition_scores', 'property_cash_offer_snapshots', 'send_queue',
  'message_events', 'email_send_queue', 'follow_up_queue', 'campaigns',
  'campaign_targets', 'contracts', 'offers', 'title_orders',
  'acquisition_opportunities', 'acquisition_events', 'deal_thread_state',
  'universal_lead_command_cache', 'lead_command_state', 'exchange_listings',
  'exchange_publications',
];

/** Fields a seller-safe payload may never contain, at any nesting depth. */
const FORBIDDEN_PROJECTION_KEYS = [
  'comps', 'comp_rows', 'comparables', 'comp_set', 'candidates', 'comp_candidates',
  'mao', 'max_allowable_offer', 'assignment_fee', 'target_assignment_fee',
  'buyer', 'buyers', 'buyer_id', 'buyer_identities', 'buyer_purchases',
  'internal_result', 'provenance', 'property_id', 'master_owner_id',
  'owner_name', 'owner_phone', 'owner_email', 'contact', 'contacts',
  'provider_payload', 'risk_rules', 'gate_checks', 'reason_codes',
  'arv', 'spread', 'margin', 'profit', 'engine_version', 'formula_version',
];

const results = [];
let failures = 0;

function check(label, passed, detail = '') {
  results.push({ label, passed: Boolean(passed), detail });
  if (!passed) failures += 1;
  // Detail is diagnostic context for a failure; printing it on success just
  // makes a passing line look like it is reporting a problem.
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${!passed && detail ? `  — got ${detail}` : ''}`);
}

/** Key-order-independent structural comparison (jsonb does not preserve order). */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function section(title) {
  console.log(`\n${'='.repeat(66)}\n ${title}\n${'='.repeat(66)}`);
}

/** Recursively collect every object key in a payload. */
function allKeys(value, acc = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((v) => allKeys(v, acc));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k.toLowerCase());
      allKeys(v, acc);
    }
  }
  return acc;
}

function makeRequest(body, { secret = INTERNAL_SECRET } = {}) {
  const payload = JSON.stringify(body);
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      'x-internal-api-secret': secret,
    },
    body: payload,
  });
}

async function main() {
  const target = process.env.OFFERR_VERIFY_DATABASE_URL || '';

  section('0. TARGET IDENTITY + PRODUCTION GUARD');
  // A hosted staging run must carry its own explicit secret; a disposable local
  // container may fall back to the documented verification default.
  const requiredSecrets = ['OFFERR_VERIFY_DATABASE_URL'];
  if (!isLocalTarget(target)) requiredSecrets.push('INTERNAL_API_SECRET');
  const verdict = assertOfferrStagingTarget({
    target,
    label: 'offerr-e2e-verify',
    requiredSecrets,
  });
  printTargetIdentity(verdict, { purpose: 'Offerr E2E verification' });

  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

  const pool = new pg.Pool({ connectionString: target, max: 12 });
  const adapter = createPgRestAdapter(pool);

  // Flag reader that reads the REAL system_control row from the database.
  const dbFlagReader = async (key) => {
    const { rows } = await pool.query('SELECT value FROM public.system_control WHERE key = $1', [key]);
    return String(rows[0]?.value ?? '').toLowerCase() === 'true';
  };
  const setFlag = async (key, value) => {
    await pool.query(
      `INSERT INTO public.system_control (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, String(value)],
    );
  };

  const countRows = async (table) => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.${table}`);
    return rows[0].n;
  };

  try {
    // ── Fixtures + side-effect stubs ────────────────────────────────────────
    section('1. FIXTURES');
    for (const t of SIDE_EFFECT_TABLES) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now())`,
      );
    }
    const seeded = await seedSyntheticProperties(pool);
    check(`seeded ${seeded} synthetic canonical properties`, seeded > 0);
    await cleanupFixtures(pool).then(() => seedSyntheticProperties(pool));

    const before = {
      requests: await countRows('offerr_evaluation_requests'),
      evaluations: await countRows('offerr_evaluations'),
      events: await countRows('offerr_evaluation_events'),
    };
    const sideEffectBefore = {};
    for (const t of SIDE_EFFECT_TABLES) sideEffectBefore[t] = await countRows(t);
    console.log(`  baseline: requests=${before.requests} evaluations=${before.evaluations} events=${before.events}`);

    const baseDeps = {
      db: adapter,
      getSystemFlag: dbFlagReader,
      loadBuyerPurchases: async () => [],
    };

    function depsForCase(c, { v3Enabled }) {
      return {
        ...baseDeps,
        v3Enabled,
        loadSubjectProperty: async (propertyId) => {
          const { rows } = await pool.query('SELECT * FROM public.properties WHERE property_id = $1', [propertyId]);
          return rows[0] ?? null;
        },
        loadComparableProperties: async () => c.comps ?? [],
        loadV3CompCandidates: async () => ({
          candidates: c.comps ?? [],
          diagnostics: { retrieval_tier: 'staging_fixture', requested: (c.comps ?? []).length },
        }),
      };
    }

    // ── Phase 9a: flag disabled ─────────────────────────────────────────────
    section('2. FEATURE FLAG DISABLED → canonical 423, zero writes');
    await setFlag(OFFERR_FLAG_KEY, 'false');
    check('flag is false before disabled-route test', (await dbFlagReader(OFFERR_FLAG_KEY)) === false);

    const disabledRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: CASES[0].address, idempotency_key: `${FIXTURE_PREFIX}-DISABLED-001` }),
      depsForCase(CASES[0], { v3Enabled: false }),
    );
    const disabledBody = await disabledRes.json();
    check('HTTP 423', disabledRes.status === 423, `got ${disabledRes.status}`);
    check('error is system_control_disabled', disabledBody.error === 'system_control_disabled', JSON.stringify(disabledBody.error));
    check('correct flag_key echoed', disabledBody.flag_key === OFFERR_FLAG_KEY, String(disabledBody.flag_key));
    check('no request row created', (await countRows('offerr_evaluation_requests')) === before.requests);
    check('no evaluation row created', (await countRows('offerr_evaluations')) === before.evaluations);
    check('no event row created', (await countRows('offerr_evaluation_events')) === before.events);

    section('3. UNAUTHORIZED REQUEST IS REFUSED');
    const unauthRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: CASES[0].address, idempotency_key: `${FIXTURE_PREFIX}-UNAUTH-001` }, { secret: 'wrong-secret' }),
      depsForCase(CASES[0], { v3Enabled: false }),
    );
    check('bad internal secret rejected (401/403)', [401, 403].includes(unauthRes.status), `got ${unauthRes.status}`);

    // ── Phase 9b: flag enabled, V3 disabled → fail closed ───────────────────
    section('4. FLAG ENABLED + ACQUISITION V3 DISABLED → fail closed, no range');
    await setFlag(OFFERR_FLAG_KEY, 'true');
    check('flag is true', (await dbFlagReader(OFFERR_FLAG_KEY)) === true);

    const v3OffRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: CASES[0].address, idempotency_key: `${FIXTURE_PREFIX}-V3OFF-001` }),
      depsForCase(CASES[0], { v3Enabled: false }),
    );
    const v3OffBody = await v3OffRes.json();
    check('request accepted (200)', v3OffRes.status === 200, `got ${v3OffRes.status}`);
    check('V3-disabled produces NO preliminary range',
      v3OffBody.evaluation?.preliminary_range == null,
      JSON.stringify(v3OffBody.evaluation?.preliminary_range));
    check('V3-disabled outcome is review/unsupported, never range-eligible',
      v3OffBody.evaluation?.outcome !== 'INSTANT_RANGE_ELIGIBLE',
      String(v3OffBody.evaluation?.outcome));
    check('result is non-binding', v3OffBody.evaluation?.binding === false, String(v3OffBody.evaluation?.binding));
    check('result is preliminary', v3OffBody.evaluation?.preliminary === true, String(v3OffBody.evaluation?.preliminary));

    // ── Phase 10: full matrix with V3 enabled ───────────────────────────────
    section('5. FULL SYNTHETIC MATRIX (V3 enabled, staging only)');
    const matrix = [];
    for (const c of CASES) {
      const key = `${FIXTURE_PREFIX}-${c.id}`;
      const started = Date.now();
      const res = await handleOfferrEvaluationsRequest(
        makeRequest({ address: c.address, idempotency_key: key, seller_facts: c.seller_facts, source: 'staging_verify' }),
        depsForCase(c, { v3Enabled: true }),
      );
      const latencyMs = Date.now() - started;
      const body = await res.json();

      const { rows: reqRows } = await pool.query(
        'SELECT * FROM public.offerr_evaluation_requests WHERE idempotency_key = $1', [key],
      );
      const requestRow = reqRows[0] ?? null;
      const { rows: evalRows } = requestRow
        ? await pool.query('SELECT * FROM public.offerr_evaluations WHERE request_id = $1 ORDER BY evaluation_version', [requestRow.id])
        : { rows: [] };
      const { rows: evtRows } = requestRow
        ? await pool.query('SELECT * FROM public.offerr_evaluation_events WHERE request_id = $1', [requestRow.id])
        : { rows: [] };

      const evaluation = body.evaluation ?? null;
      const range = evaluation?.preliminary_range ?? null;
      const expectedRes = Array.isArray(c.expect.resolution) ? c.expect.resolution : [c.expect.resolution];

      matrix.push({
        id: c.id, title: c.title, http: res.status, latency_ms: latencyMs,
        request_id: body.request_id ?? null, evaluation_id: body.evaluation_id ?? null,
        resolution_status: requestRow?.resolution_status ?? null,
        outcome: evaluation?.outcome ?? evalRows[0]?.outcome ?? null,
        confidence: evaluation?.confidence_label ?? null,
        has_range: range != null,
        next_step: evaluation?.next_step ?? null,
        request_rows: reqRows.length, evaluation_rows: evalRows.length, event_rows: evtRows.length,
      });

      console.log(`\n  ── ${c.id}: ${c.title}`);
      console.log(`     http=${res.status} resolution=${requestRow?.resolution_status ?? '-'} outcome=${evaluation?.outcome ?? '-'} range=${range ? 'YES' : 'null'} next=${evaluation?.next_step ?? '-'} ${latencyMs}ms`);

      check(`${c.id} route returned 200`, res.status === 200, `got ${res.status}`);
      check(`${c.id} resolution_status in ${expectedRes.join('|')}`,
        expectedRes.includes(requestRow?.resolution_status), String(requestRow?.resolution_status));
      check(`${c.id} exactly one persisted request row`, reqRows.length === 1, String(reqRows.length));
      check(`${c.id} exactly one immutable evaluation snapshot`, evalRows.length === 1, String(evalRows.length));
      check(`${c.id} lifecycle event persisted`, evtRows.length >= 1, String(evtRows.length));
      check(`${c.id} outcome in documented vocabulary`,
        c.expect.outcomes.includes(evaluation?.outcome), String(evaluation?.outcome));

      if (!c.expect.range_allowed) {
        check(`${c.id} NO preliminary range (safety gate held)`, range == null, JSON.stringify(range));
      }

      // A material seller-fact conflict must be recorded in provenance AND must
      // cost the evaluation its top-tier eligibility.
      if (c.expect.downgrade_expected) {
        const prov = evalRows[0]
          ? (typeof evalRows[0].provenance === 'string'
              ? JSON.parse(evalRows[0].provenance) : evalRows[0].provenance)
          : null;
        const conflicts = prov?.material_conflicts ?? [];
        check(`${c.id} conflict "${c.expect.expected_conflict}" recorded in provenance`,
          conflicts.includes(c.expect.expected_conflict), JSON.stringify(conflicts));
        check(`${c.id} conflict downgraded eligibility below INSTANT_RANGE_ELIGIBLE`,
          evaluation?.outcome !== 'INSTANT_RANGE_ELIGIBLE', String(evaluation?.outcome));
      }
      if (evaluation?.outcome === 'REVIEW_REQUIRED' || evaluation?.outcome === 'UNSUPPORTED') {
        check(`${c.id} review/unsupported carries no range`, range == null, JSON.stringify(range));
      }

      // Universal seller-safe invariants
      check(`${c.id} binding:false`, evaluation?.binding === false, String(evaluation?.binding));
      check(`${c.id} preliminary:true`, evaluation?.preliminary === true, String(evaluation?.preliminary));
      check(`${c.id} disclaimer present`,
        typeof evaluation?.disclaimer === 'string' && evaluation.disclaimer.length > 0);

      const keys = allKeys(evaluation);
      const leaked = FORBIDDEN_PROJECTION_KEYS.filter((k) => keys.has(k));
      check(`${c.id} seller payload leaks nothing internal`, leaked.length === 0, leaked.join(','));

      const projStr = JSON.stringify(evaluation ?? {});
      check(`${c.id} seller payload contains no private property id`,
        !projStr.includes(FIXTURE_PREFIX), 'fixture property id leaked into the seller payload');

      // The stored snapshot's seller_projection must equal what was returned.
      if (evalRows[0]) {
        const stored = typeof evalRows[0].seller_projection === 'string'
          ? JSON.parse(evalRows[0].seller_projection) : evalRows[0].seller_projection;
        check(`${c.id} stored seller_projection matches the response`,
          stableStringify(stored) === stableStringify(evaluation));
        check(`${c.id} internal_result stored server-side only`,
          evalRows[0].internal_result != null && !projStr.includes('internal_result'));
      }
    }

    // ── Idempotency ─────────────────────────────────────────────────────────
    section('6. IDEMPOTENCY');
    const idemCase = CASES[0];
    const idemKey = `${FIXTURE_PREFIX}-${idemCase.id}`;
    const replayRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: idemCase.address, idempotency_key: idemKey, seller_facts: idemCase.seller_facts }),
      depsForCase(idemCase, { v3Enabled: true }),
    );
    const replayBody = await replayRes.json();
    const { rows: afterReplay } = await pool.query(
      `SELECT count(*)::int AS n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id
       WHERE r.idempotency_key = $1`, [idemKey],
    );
    check('replay returns 200', replayRes.status === 200, `got ${replayRes.status}`);
    check('replay flagged idempotent_replay:true', replayBody.idempotent_replay === true, String(replayBody.idempotent_replay));
    check('replay created NO second snapshot', afterReplay[0].n === 1, `snapshots=${afterReplay[0].n}`);
    check('replay returned the same evaluation_id',
      replayBody.evaluation_id === matrix.find((m) => m.id === idemCase.id)?.evaluation_id);

    const conflictRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: '4200 Sandbox Thin Ln, Houston, TX 77035', idempotency_key: idemKey }),
      depsForCase(idemCase, { v3Enabled: true }),
    );
    const conflictBody = await conflictRes.json();
    check('same key + different address → HTTP 409', conflictRes.status === 409, `got ${conflictRes.status}`);
    check('409 failure_code is key reuse',
      conflictBody.failure_code === 'idempotency_key_reused_with_different_payload',
      String(conflictBody.failure_code));

    // ── Concurrency ─────────────────────────────────────────────────────────
    section('7. CONCURRENCY — same key, parallel requests');
    const raceKey = `${FIXTURE_PREFIX}-RACE-001`;
    const raceCase = CASES[0];
    const raceResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        handleOfferrEvaluationsRequest(
          makeRequest({ address: raceCase.address, idempotency_key: raceKey, seller_facts: raceCase.seller_facts }),
          depsForCase(raceCase, { v3Enabled: true }),
        ).then(async (r) => ({ status: r.status, body: await r.json() })),
      ),
    );
    const { rows: raceRows } = await pool.query(
      `SELECT count(*)::int AS n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id
       WHERE r.idempotency_key = $1`, [raceKey],
    );
    const { rows: raceReqRows } = await pool.query(
      'SELECT count(*)::int AS n FROM public.offerr_evaluation_requests WHERE idempotency_key = $1', [raceKey],
    );
    const statuses = raceResults.map((r) => r.status);
    console.log(`     statuses: ${statuses.join(', ')}`);
    check('concurrent same-key produced exactly ONE request row', raceReqRows[0].n === 1, `rows=${raceReqRows[0].n}`);
    check('concurrent same-key produced exactly ONE completed evaluation', raceRows[0].n === 1, `snapshots=${raceRows[0].n}`);
    check('every concurrent response was 200 or a retryable 503',
      statuses.every((s) => s === 200 || s === 503), statuses.join(','));
    const distinctEvalIds = new Set(raceResults.filter((r) => r.status === 200).map((r) => r.body.evaluation_id));
    check('all successful concurrent responses agree on one evaluation_id',
      distinctEvalIds.size <= 1, `distinct=${distinctEvalIds.size}`);

    // ── Reconciliation ──────────────────────────────────────────────────────
    section('8. PERSISTENCE + SIDE-EFFECT RECONCILIATION');
    const after = {
      requests: await countRows('offerr_evaluation_requests'),
      evaluations: await countRows('offerr_evaluations'),
      events: await countRows('offerr_evaluation_events'),
    };
    console.log(`  requests    ${before.requests} → ${after.requests}`);
    console.log(`  evaluations ${before.evaluations} → ${after.evaluations}`);
    console.log(`  events      ${before.events} → ${after.events}`);

    const { rows: statusBreakdown } = await pool.query(
      `SELECT resolution_status, count(*)::int AS n FROM public.offerr_evaluation_requests
       WHERE idempotency_key LIKE $1 GROUP BY resolution_status ORDER BY resolution_status`, [`${FIXTURE_PREFIX}-%`],
    );
    console.log('  resolution status breakdown:');
    statusBreakdown.forEach((r) => console.log(`    ${r.resolution_status.padEnd(15)} ${r.n}`));

    const { rows: outcomeBreakdown } = await pool.query(
      `SELECT outcome, count(*)::int AS n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id
       WHERE r.idempotency_key LIKE $1 GROUP BY outcome ORDER BY outcome`, [`${FIXTURE_PREFIX}-%`],
    );
    console.log('  outcome breakdown:');
    outcomeBreakdown.forEach((r) => console.log(`    ${r.outcome.padEnd(24)} ${r.n}`));

    const { rows: orphans } = await pool.query(
      `SELECT count(*)::int AS n FROM public.offerr_evaluation_requests r
       LEFT JOIN public.offerr_evaluations e ON e.request_id = r.id
       WHERE r.idempotency_key LIKE $1 AND e.id IS NULL`, [`${FIXTURE_PREFIX}-%`],
    );
    check('zero orphaned/incomplete request rows', orphans[0].n === 0, `orphans=${orphans[0].n}`);

    const { rows: multiSnap } = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT request_id FROM public.offerr_evaluations GROUP BY request_id HAVING count(*) > 1
       ) t`,
    );
    check('no request has more than one snapshot', multiSnap[0].n === 0, `multi=${multiSnap[0].n}`);

    let sideEffectClean = true;
    const sideEffectReport = [];
    for (const t of SIDE_EFFECT_TABLES) {
      const now = await countRows(t);
      const wasBefore = sideEffectBefore[t];
      sideEffectReport.push(`${t}: ${wasBefore} → ${now}`);
      if (now !== wasBefore) sideEffectClean = false;
    }
    check(`all ${SIDE_EFFECT_TABLES.length} side-effect tables unchanged (measured, not inferred)`, sideEffectClean);
    sideEffectReport.forEach((line) => console.log(`    ${line}`));

    const touchedTables = new Set(adapter._operations.map((o) => o.table));
    const writes = adapter._operations.filter((o) => o.method !== 'select');
    const writtenTables = new Set(writes.map((o) => o.table));
    console.log(`  tables touched by the spine: ${[...touchedTables].sort().join(', ')}`);
    console.log(`  tables WRITTEN by the spine: ${[...writtenTables].sort().join(', ')}`);
    check('spine wrote ONLY offerr_* tables',
      [...writtenTables].every((t) => t.startsWith('offerr_')), [...writtenTables].join(','));
    check('spine never touched a side-effect table (even for reads)',
      ![...touchedTables].some((t) => SIDE_EFFECT_TABLES.includes(t)),
      [...touchedTables].filter((t) => SIDE_EFFECT_TABLES.includes(t)).join(','));

    // ── Latency ─────────────────────────────────────────────────────────────
    section('9. LATENCY');
    const lat = matrix.map((m) => m.latency_ms).sort((a, b) => a - b);
    const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
    console.log(`  n=${lat.length} min=${lat[0]}ms p50=${pct(50)}ms p95=${pct(95)}ms max=${lat[lat.length - 1]}ms`);
    check('all evaluations completed well under the 60s route budget', lat[lat.length - 1] < 60_000);

    // ── Final staging state ─────────────────────────────────────────────────
    section('10. FINAL STAGING STATE');
    await setFlag(OFFERR_FLAG_KEY, 'false');
    check('offerr_evaluation_enabled returned to FALSE', (await dbFlagReader(OFFERR_FLAG_KEY)) === false);

    const { rows: flagRows } = await pool.query(
      `SELECT key, value FROM public.system_control ORDER BY key`,
    );
    console.log('  system_control final state:');
    flagRows.forEach((r) => console.log(`    ${r.key} = ${r.value}`));

    section('MATRIX SUMMARY');
    console.log(
      ['CASE', 'HTTP', 'RESOLUTION', 'OUTCOME', 'RANGE', 'ms'].map((h, i) =>
        h.padEnd([30, 6, 14, 24, 6, 6][i])).join(''),
    );
    for (const m of matrix) {
      console.log(
        [m.id, String(m.http), m.resolution_status ?? '-', m.outcome ?? '-', m.has_range ? 'YES' : 'null', String(m.latency_ms)]
          .map((v, i) => String(v).padEnd([30, 6, 14, 24, 6, 6][i])).join(''),
      );
    }

    section('RESULT');
    const passed = results.filter((r) => r.passed).length;
    console.log(`  assertions: ${passed} passed, ${failures} failed, ${results.length} total`);
    if (failures > 0) {
      console.log('\n  FAILED ASSERTIONS:');
      results.filter((r) => !r.passed).forEach((r) => console.log(`    - ${r.label} ${r.detail}`));
    }

    if (process.env.OFFERR_KEEP_FIXTURES !== 'true') {
      const removed = await cleanupFixtures(pool);
      console.log(`\n  fixture cleanup: ${JSON.stringify(removed)}`);
    } else {
      console.log('\n  fixtures RETAINED (OFFERR_KEEP_FIXTURES=true)');
    }

    return failures === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('\nFATAL:', error?.message ?? error);
    if (error?.stack) console.error(error.stack);
    process.exit(2);
  });
