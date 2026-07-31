/**
 * Offerr Evaluation Spine — end-to-end staging verification harness.
 *
 * Drives the REAL internal route handler (handleOfferrEvaluationsRequest), the
 * REAL Supabase-backed store, and — as of the comp-parity work — the REAL
 * default comp-retrieval path, against a REAL Postgres database.
 *
 *   NOTHING ABOUT COMPS IS INJECTED ANY MORE.
 *
 * The harness supplies exactly two dependencies:
 *   db / supabase   the PostgREST-shaped adapter over a real `pg` pool
 *   getSystemFlag   a reader of the real system_control row
 *
 * Everything else runs by default resolution, which means every one of these
 * executes for real against PostgreSQL:
 *
 *   loadSubjectProperty       -> public.properties (+ optional enrichment)
 *   loadV3CompCandidates      -> rpc get_comp_candidates_for_subject
 *                                -> public.v_recent_sold_comps
 *                                -> public.buyer_comp_raw_v2  (identity join)
 *                                -> public.buyer_entities_v2  (buy-box join)
 *   loadComparableProperties  -> the same RPC + v_recent_sold_comps detail
 *   loadBuyerPurchases        -> buyer_purchase_events_v2 (optional-missing)
 *   normalizeCandidate / qualifyComps / clusterTransactions / buildV3Decision
 *   applyOfferrSafetyGates / persistence / seller projection
 *
 * The only way to change what the engine sees is to change database rows.
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
import {
  CASES,
  FIXTURE_PREFIX,
  SYNTHETIC_BUYERS,
  SYNTHETIC_COMPS,
  cleanupFixtures,
  seedSyntheticFixtures,
} from './offerr-staging-fixtures.mjs';

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'offerr-staging-verify-secret';
const ROUTE_URL = 'https://offerr-staging.invalid/api/internal/offerr/evaluations';

/** How many repeated evaluations back the latency percentiles. */
const LATENCY_SAMPLES = Number(process.env.OFFERR_LATENCY_SAMPLES || 30);

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

/**
 * Comp-corpus objects the evaluation path may READ but must never WRITE.
 * Row counts are captured before and after to prove the comp path is read-only.
 */
const COMP_SOURCE_TABLES = ['properties', 'buyer_comp_raw_v2', 'buyer_entities_v2'];

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

function parseJson(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
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

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
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

  /** Call the canonical RPC directly, exactly as compCandidateLoader would. */
  const probeRpc = async (propertyId, radius = 4, months = 30, limit = 100) => {
    const { rows } = await pool.query(
      'SELECT * FROM public.get_comp_candidates_for_subject($1,$2,$3,$4)',
      [propertyId, radius, months, limit],
    );
    return rows;
  };

  try {
    // ── Fixtures + side-effect stubs ────────────────────────────────────────
    section('1. FIXTURES — real rows in the real canonical tables');
    for (const t of SIDE_EFFECT_TABLES) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now())`,
      );
    }

    const { rows: contractRows } = await pool.query(
      `SELECT version FROM public.comp_intelligence_schema_contract WHERE contract_name = 'offerr-comp-intelligence'`,
    ).catch(() => ({ rows: [] }));
    check('canonical comp-intelligence schema contract 1.0.0 is applied',
      contractRows[0]?.version === '1.0.0', String(contractRows[0]?.version));

    const seeded = await seedSyntheticFixtures(pool);
    console.log(`  seeded: ${JSON.stringify(seeded)}`);
    check(`seeded ${seeded.properties} synthetic canonical properties`, seeded.properties > 0);
    check(`seeded ${seeded.comps} synthetic comp rows into buyer_comp_raw_v2`,
      seeded.comps === SYNTHETIC_COMPS.length, `${seeded.comps}/${SYNTHETIC_COMPS.length}`);
    check(`seeded ${seeded.buyers} synthetic buyer entities into buyer_entities_v2`,
      seeded.buyers === SYNTHETIC_BUYERS.length, `${seeded.buyers}/${SYNTHETIC_BUYERS.length}`);

    // Re-seeding must converge, not accumulate: prove it before relying on it.
    const reseeded = await seedSyntheticFixtures(pool);
    check('fixture seeding is idempotent (re-seed converges to the same counts)',
      stableStringify(reseeded) === stableStringify(seeded),
      `${JSON.stringify(seeded)} vs ${JSON.stringify(reseeded)}`);

    // The comp view must actually expose the seeded rows as usable comps,
    // otherwise the RPC would return nothing and every case would fail closed
    // for the wrong reason.
    const { rows: usableRows } = await pool.query(
      `SELECT count(*)::int AS n FROM public.v_recent_sold_comps
       WHERE is_usable_comp AND id IN (SELECT id FROM public.buyer_comp_raw_v2 WHERE source_record_id LIKE $1)`,
      [`${FIXTURE_PREFIX}-%`],
    );
    check('every seeded comp satisfies v_recent_sold_comps.is_usable_comp',
      usableRows[0].n === SYNTHETIC_COMPS.length, `${usableRows[0].n}/${SYNTHETIC_COMPS.length}`);

    const before = {
      requests: await countRows('offerr_evaluation_requests'),
      evaluations: await countRows('offerr_evaluations'),
      events: await countRows('offerr_evaluation_events'),
    };
    const sideEffectBefore = {};
    for (const t of SIDE_EFFECT_TABLES) sideEffectBefore[t] = await countRows(t);
    const compSourceBefore = {};
    for (const t of COMP_SOURCE_TABLES) compSourceBefore[t] = await countRows(t);
    console.log(`  baseline: requests=${before.requests} evaluations=${before.evaluations} events=${before.events}`);
    console.log(`  comp corpus baseline: ${JSON.stringify(compSourceBefore)}`);

    // ── The ONLY injected dependencies ──────────────────────────────────────
    // `db` is read by the Offerr store, the property resolver and
    // compCandidateLoader; `supabase` is read by acquisitionDecisionEngine's
    // db(deps). Both are the same real-Postgres adapter.
    //
    // There is deliberately NO loadV3CompCandidates, loadComparableProperties,
    // loadBuyerPurchases or loadSubjectProperty here. Adding one back would
    // silently disable the real comp path this harness exists to verify.
    const baseDeps = {
      db: adapter,
      supabase: adapter,
      getSystemFlag: dbFlagReader,
    };
    const depsFor = ({ v3Enabled }) => ({ ...baseDeps, v3Enabled });

    check('harness injects no comp candidates, comps, buyers or subject loader',
      !('loadV3CompCandidates' in baseDeps) && !('loadComparableProperties' in baseDeps)
      && !('loadBuyerPurchases' in baseDeps) && !('loadSubjectProperty' in baseDeps));

    // ── Phase 9a: flag disabled ─────────────────────────────────────────────
    section('2. FEATURE FLAG DISABLED → canonical 423, zero writes');
    await setFlag(OFFERR_FLAG_KEY, 'false');
    check('flag is false before disabled-route test', (await dbFlagReader(OFFERR_FLAG_KEY)) === false);

    const disabledRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: CASES[0].address, idempotency_key: `${FIXTURE_PREFIX}-DISABLED-001` }),
      depsFor({ v3Enabled: false }),
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
      depsFor({ v3Enabled: false }),
    );
    check('bad internal secret rejected (401/403)', [401, 403].includes(unauthRes.status), `got ${unauthRes.status}`);

    // ── Phase 9b: flag enabled, V3 disabled → fail closed ───────────────────
    section('4. FLAG ENABLED + ACQUISITION V3 DISABLED → fail closed, no range');
    await setFlag(OFFERR_FLAG_KEY, 'true');
    check('flag is true', (await dbFlagReader(OFFERR_FLAG_KEY)) === true);

    const v3OffRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: CASES[0].address, idempotency_key: `${FIXTURE_PREFIX}-V3OFF-001` }),
      depsFor({ v3Enabled: false }),
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

    // ── Phase 10/11: full matrix with V3 enabled, REAL comp loader ──────────
    section('5. FULL SYNTHETIC MATRIX — real RPC, real loader, real clustering');
    const matrix = [];
    for (const c of CASES) {
      const key = `${FIXTURE_PREFIX}-${c.id}`;

      // Independent probe of the canonical RPC, so the harness reports what the
      // database actually returned rather than trusting the engine's own count.
      const rpcRows = c.subject_property_id ? await probeRpc(c.subject_property_id) : null;

      const started = Date.now();
      const res = await handleOfferrEvaluationsRequest(
        makeRequest({ address: c.address, idempotency_key: key, seller_facts: c.seller_facts, source: 'staging_verify' }),
        depsFor({ v3Enabled: true }),
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

      // The internal snapshot is where comp depth, clustering and confidence
      // live. It is stored server-side only and never projected to a seller.
      const internal = evalRows[0] ? parseJson(evalRows[0].internal_result) : null;
      const prov = evalRows[0] ? parseJson(evalRows[0].provenance) : null;
      const v3 = internal?.decision?.v3 ?? null;
      const sample = v3?.sample ?? null;
      const diag = v3?.loader_diagnostics ?? null;

      const rec = {
        id: c.id, title: c.title, http: res.status, latency_ms: latencyMs,
        request_id: body.request_id ?? null, evaluation_id: body.evaluation_id ?? null,
        rpc_rows: rpcRows ? rpcRows.length : null,
        resolution_status: requestRow?.resolution_status ?? null,
        outcome: evaluation?.outcome ?? evalRows[0]?.outcome ?? null,
        confidence: evaluation?.confidence_label ?? null,
        has_range: range != null,
        next_step: evaluation?.next_step ?? null,
        comp_candidate_count: prov?.comp_candidate_count ?? null,
        retrieval_tier: prov?.comp_retrieval_tier ?? null,
        raw_rows: sample?.raw_rows ?? null,
        distinct_clusters: sample?.distinct_clusters ?? null,
        accepted_clusters: sample?.accepted_clusters ?? null,
        effective_sample_size: sample?.effective_sample_size ?? null,
        package_cluster_count: sample?.package_cluster_count ?? null,
        duplicate_row_count: sample?.duplicate_row_count ?? null,
        quarantined_count: sample?.quarantined_count ?? null,
        excluded_count: sample?.excluded_count ?? null,
        anomaly_flags: v3?.anomaly_flags ?? [],
        execution_state: v3?.execution_state ?? null,
        value_classification: v3?.value_classification ?? null,
        final_confidence: v3?.final_confidence ?? null,
        entity_matched: diag?.entity_matched ?? null,
        buyer_resolved: diag?.buyer_resolved ?? null,
        identity_enriched: diag?.identity_enriched ?? null,
        reason_codes: prov?.reason_codes ?? [],
        request_rows: reqRows.length, evaluation_rows: evalRows.length, event_rows: evtRows.length,
      };
      matrix.push(rec);

      console.log(`\n  ── ${c.id}: ${c.title}`);
      console.log(`     http=${res.status} resolution=${requestRow?.resolution_status ?? '-'} outcome=${evaluation?.outcome ?? '-'} range=${range ? 'YES' : 'null'} ${latencyMs}ms`);
      console.log(`     rpc_rows=${rec.rpc_rows ?? '-'} candidates=${rec.comp_candidate_count ?? '-'} tier=${rec.retrieval_tier ?? '-'}`);
      console.log(`     clusters=${rec.distinct_clusters ?? '-'} accepted=${rec.accepted_clusters ?? '-'} ESS=${rec.effective_sample_size ?? '-'} package=${rec.package_cluster_count ?? '-'} dup=${rec.duplicate_row_count ?? '-'} quar=${rec.quarantined_count ?? '-'} excl=${rec.excluded_count ?? '-'}`);
      console.log(`     buyers: identity_enriched=${rec.identity_enriched ?? '-'} buyer_resolved=${rec.buyer_resolved ?? '-'} entity_matched=${rec.entity_matched ?? '-'}`);
      console.log(`     anomalies=[${rec.anomaly_flags.join(',')}] exec=${rec.execution_state ?? '-'} conf=${rec.final_confidence ?? '-'}`);

      check(`${c.id} route returned 200`, res.status === 200, `got ${res.status}`);
      check(`${c.id} resolution_status in ${expectedRes.join('|')}`,
        expectedRes.includes(requestRow?.resolution_status), String(requestRow?.resolution_status));
      check(`${c.id} exactly one persisted request row`, reqRows.length === 1, String(reqRows.length));
      check(`${c.id} exactly one immutable evaluation snapshot`, evalRows.length === 1, String(evalRows.length));
      check(`${c.id} lifecycle event persisted`, evtRows.length >= 1, String(evtRows.length));
      check(`${c.id} outcome in documented vocabulary`,
        c.expect.outcomes.includes(evaluation?.outcome), String(evaluation?.outcome));

      // ── Real-comp-path assertions ─────────────────────────────────────────
      const ce = c.comp_expect ?? {};
      if (ce.rpc_rows != null) {
        check(`${c.id} canonical RPC returned ${ce.rpc_rows} candidate row(s)`,
          rpcRows.length === ce.rpc_rows, `${rpcRows.length}`);
        check(`${c.id} loader consumed exactly the RPC's candidates`,
          rec.comp_candidate_count === ce.rpc_rows, `${rec.comp_candidate_count}`);
        check(`${c.id} retrieval tier proves the RPC path ran (not a fixture)`,
          typeof rec.retrieval_tier === 'string' && rec.retrieval_tier.startsWith('rpc_'),
          String(rec.retrieval_tier));
      }
      if (ce.min_effective_sample_size != null) {
        check(`${c.id} effective sample size >= ${ce.min_effective_sample_size}`,
          (rec.effective_sample_size ?? -1) >= ce.min_effective_sample_size,
          String(rec.effective_sample_size));
      }
      if (ce.max_effective_sample_size != null) {
        check(`${c.id} effective sample size <= ${ce.max_effective_sample_size} (correlated evidence adds no depth)`,
          (rec.effective_sample_size ?? 99) <= ce.max_effective_sample_size,
          String(rec.effective_sample_size));
      }
      if (ce.expect_duplicate_rows) {
        check(`${c.id} duplicate parcel row detected by real clustering`,
          (rec.duplicate_row_count ?? 0) >= 1, String(rec.duplicate_row_count));
        check(`${c.id} DUPLICATE_PARCEL_ROWS anomaly raised`,
          rec.anomaly_flags.includes('DUPLICATE_PARCEL_ROWS'), rec.anomaly_flags.join(','));
        check(`${c.id} duplicate row did NOT inflate comp depth`,
          rec.effective_sample_size < rec.raw_rows,
          `ESS=${rec.effective_sample_size} raw_rows=${rec.raw_rows}`);
      }
      if (ce.expect_package_cluster) {
        check(`${c.id} package cluster detected by real clustering`,
          (rec.package_cluster_count ?? 0) >= 1, String(rec.package_cluster_count));
        check(`${c.id} PACKAGE_CONSIDERATION_DETECTED anomaly raised`,
          rec.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'), rec.anomaly_flags.join(','));
        check(`${c.id} ${ce.rpc_rows} package rows collapsed to ONE economic transaction`,
          rec.distinct_clusters === 1, `clusters=${rec.distinct_clusters}`);
        check(`${c.id} package cluster contributed ZERO independent comp depth`,
          rec.effective_sample_size === 0, String(rec.effective_sample_size));
      }
      if (ce.expect_quarantine) {
        check(`${c.id} extreme comp quarantined by real qualification`,
          (rec.quarantined_count ?? 0) >= 1, String(rec.quarantined_count));
        check(`${c.id} IMPLAUSIBLE_COMP_PRICE anomaly raised`,
          rec.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'), rec.anomaly_flags.join(','));
        // The decisive proof: the contaminated price must not reach any
        // surfaced valuation figure.
        const surfaced = internal?.decision?.valuation_high ?? internal?.decision?.v3?.reconciliation?.reconciled_market_value_high ?? null;
        check(`${c.id} contaminated $${ce.quarantined_price.toLocaleString()} never reached a valuation`,
          surfaced == null || Number(surfaced) < ce.quarantined_price / 100, String(surfaced));
      }
      // Buyer/entity loading must have executed for every case with comps.
      if (ce.rpc_rows) {
        check(`${c.id} identity join resolved every comp against buyer_comp_raw_v2`,
          rec.identity_enriched === ce.rpc_rows, `${rec.identity_enriched}/${ce.rpc_rows}`);
        check(`${c.id} buyer_entities_v2 buy-box matched at least one comp`,
          (rec.entity_matched ?? 0) >= 1, String(rec.entity_matched));
      }
      if (ce.rpc_rows === 0) {
        check(`${c.id} empty comp result failed closed (no range)`, range == null, JSON.stringify(range));
      }

      if (!c.expect.range_allowed) {
        check(`${c.id} NO preliminary range (safety gate held)`, range == null, JSON.stringify(range));
      }

      // A material seller-fact conflict must be recorded in provenance AND must
      // cost the evaluation its top-tier eligibility.
      if (c.expect.downgrade_expected) {
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
      // Comp identity is the new leak surface now that real buyers are loaded.
      const buyerLeak = SYNTHETIC_BUYERS.filter((b) => projStr.includes(b.buyer_name));
      check(`${c.id} seller payload contains no comp buyer identity`,
        buyerLeak.length === 0, buyerLeak.map((b) => b.buyer_name).join(','));

      // The stored snapshot's seller_projection must equal what was returned.
      if (evalRows[0]) {
        const stored = parseJson(evalRows[0].seller_projection);
        check(`${c.id} stored seller_projection matches the response`,
          stableStringify(stored) === stableStringify(evaluation));
        check(`${c.id} internal_result stored server-side only`,
          evalRows[0].internal_result != null && !projStr.includes('internal_result'));
      }
    }

    // ── Idempotency ─────────────────────────────────────────────────────────
    section('6. IDEMPOTENCY (real comp loader)');
    const idemCase = CASES[0];
    const idemKey = `${FIXTURE_PREFIX}-${idemCase.id}`;
    const replayRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: idemCase.address, idempotency_key: idemKey, seller_facts: idemCase.seller_facts }),
      depsFor({ v3Enabled: true }),
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
    const originalEvaluationId = matrix.find((m) => m.id === idemCase.id)?.evaluation_id ?? null;
    check('replay returned the same evaluation_id',
      originalEvaluationId != null && replayBody.evaluation_id === originalEvaluationId,
      `${replayBody.evaluation_id} vs ${originalEvaluationId}`);

    const conflictRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: '4200 Sandbox Thin Ln, Houston, TX 77035', idempotency_key: idemKey }),
      depsFor({ v3Enabled: true }),
    );
    const conflictBody = await conflictRes.json();
    check('same key + different address → HTTP 409', conflictRes.status === 409, `got ${conflictRes.status}`);
    check('409 failure_code is key reuse',
      conflictBody.failure_code === 'idempotency_key_reused_with_different_payload',
      String(conflictBody.failure_code));

    // Determinism of the real path: the same subject evaluated under a fresh key
    // must reproduce the same comp evidence, or the RPC is not deterministic.
    const detKey = `${FIXTURE_PREFIX}-DETERMINISM-001`;
    await handleOfferrEvaluationsRequest(
      makeRequest({ address: idemCase.address, idempotency_key: detKey, seller_facts: idemCase.seller_facts }),
      depsFor({ v3Enabled: true }),
    );
    const { rows: detRows } = await pool.query(
      `SELECT e.provenance FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id
       WHERE r.idempotency_key = ANY($1)`, [[idemKey, detKey]],
    );
    const hashes = new Set(detRows.map((r) => parseJson(r.provenance)?.comp_set_hash));
    check('identical subject re-evaluated under a new key produced an identical comp set hash',
      detRows.length === 2 && hashes.size === 1, `hashes=${hashes.size} rows=${detRows.length}`);

    // ── Persistence failure + compensating cleanup ──────────────────────────
    section('6b. PERSISTENCE FAILURE → compensating cleanup, no orphan');
    // Force the snapshot insert to fail against the REAL database using a
    // temporary always-false CHECK constraint. The two inserts are not
    // transactional, so without compensation the idempotency key would be
    // consumed by a request row that has no evaluation. This proves the
    // compensating delete runs on the real comp path, not just in unit tests.
    const failKey = `${FIXTURE_PREFIX}-PERSIST-FAIL-001`;
    const requestsBeforeFail = await countRows('offerr_evaluation_requests');
    await pool.query(
      `ALTER TABLE public.offerr_evaluations
         ADD CONSTRAINT offerr_verify_forced_failure CHECK (false) NOT VALID`,
    );
    let failRes;
    let failBody;
    try {
      failRes = await handleOfferrEvaluationsRequest(
        makeRequest({ address: CASES[0].address, idempotency_key: failKey, seller_facts: CASES[0].seller_facts }),
        depsFor({ v3Enabled: true }),
      );
      failBody = await failRes.json();
    } finally {
      await pool.query(
        'ALTER TABLE public.offerr_evaluations DROP CONSTRAINT offerr_verify_forced_failure',
      );
    }
    const { rows: orphanRows } = await pool.query(
      'SELECT count(*)::int AS n FROM public.offerr_evaluation_requests WHERE idempotency_key = $1', [failKey],
    );
    check('persistence failure returned a retryable 503, never success',
      failRes.status === 503, `got ${failRes.status}`);
    check('persistence failure surfaced offerr_persistence_failed',
      failBody.failure_code === 'offerr_persistence_failed', String(failBody.failure_code));
    check('persistence failure returned NO evaluation to the caller',
      failBody.evaluation == null && failBody.ok === false);
    check('compensating delete removed the orphaned request row',
      orphanRows[0].n === 0, `orphan request rows=${orphanRows[0].n}`);
    check('request table returned to its pre-failure count',
      (await countRows('offerr_evaluation_requests')) === requestsBeforeFail);

    // The idempotency key must be reusable after a compensated failure —
    // otherwise a transient database error would permanently burn the key.
    const retryRes = await handleOfferrEvaluationsRequest(
      makeRequest({ address: CASES[0].address, idempotency_key: failKey, seller_facts: CASES[0].seller_facts }),
      depsFor({ v3Enabled: true }),
    );
    check('the same idempotency key succeeds on retry after cleanup',
      retryRes.status === 200, `got ${retryRes.status}`);

    // ── Concurrency ─────────────────────────────────────────────────────────
    section('7. CONCURRENCY — same key, parallel requests, real comp loader');
    const raceKey = `${FIXTURE_PREFIX}-RACE-001`;
    const raceCase = CASES[0];
    const raceResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        handleOfferrEvaluationsRequest(
          makeRequest({ address: raceCase.address, idempotency_key: raceKey, seller_facts: raceCase.seller_facts }),
          depsFor({ v3Enabled: true }),
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

    // The comp corpus is READ by the real loader. It must not be written.
    let compCorpusClean = true;
    for (const t of COMP_SOURCE_TABLES) {
      const now = await countRows(t);
      console.log(`    ${t}: ${compSourceBefore[t]} → ${now}`);
      if (now !== compSourceBefore[t]) compCorpusClean = false;
    }
    check('comp corpus row counts unchanged — the real comp path is read-only', compCorpusClean);

    const touchedTables = new Set(adapter._operations.map((o) => o.table));
    const writes = adapter._operations.filter((o) => o.method !== 'select' && o.method !== 'rpc');
    const writtenTables = new Set(writes.map((o) => o.table));
    const rpcCalls = adapter._operations.filter((o) => o.method === 'rpc');
    console.log(`  tables touched by the spine: ${[...touchedTables].sort().join(', ')}`);
    console.log(`  tables WRITTEN by the spine: ${[...writtenTables].sort().join(', ')}`);
    console.log(`  RPC invocations through the adapter: ${rpcCalls.length}`);
    check('spine wrote ONLY offerr_* tables',
      [...writtenTables].every((t) => t.startsWith('offerr_')), [...writtenTables].join(','));
    check('spine never touched a side-effect table (even for reads)',
      ![...touchedTables].some((t) => SIDE_EFFECT_TABLES.includes(t)),
      [...touchedTables].filter((t) => SIDE_EFFECT_TABLES.includes(t)).join(','));
    check('the canonical comp RPC was actually invoked through the adapter',
      rpcCalls.some((o) => o.table === 'rpc:get_comp_candidates_for_subject'),
      rpcCalls.map((o) => o.table).join(','));
    check('the comp corpus was read but never written',
      ['buyer_comp_raw_v2', 'buyer_entities_v2', 'v_recent_sold_comps', 'properties']
        .every((t) => !writtenTables.has(t)),
      [...writtenTables].join(','));

    // ── Latency ─────────────────────────────────────────────────────────────
    section('9. LATENCY — real comp path, repeated samples');
    // NOTE: persistence_ms and total_ms are deliberately absent here. The
    // service assigns them AFTER the lifecycle event's payload has been handed
    // to the store, so they cannot appear in the event that the same call
    // writes. Persistence is therefore reported as a derived residual below.
    const stageTotals = {
      validate_ms: [], idempotency_ms: [], resolution_ms: [], subject_ms: [],
      overlay_ms: [], comp_load_ms: [], engine_ms: [], gates_ms: [],
    };
    const wallLatencies = [];
    for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
      const lkey = `${FIXTURE_PREFIX}-LAT-${String(i).padStart(3, '0')}`;
      const t0 = Date.now();
      const r = await handleOfferrEvaluationsRequest(
        makeRequest({ address: CASES[0].address, idempotency_key: lkey, seller_facts: CASES[0].seller_facts }),
        depsFor({ v3Enabled: true }),
      );
      wallLatencies.push(Date.now() - t0);
      if (r.status !== 200) check(`latency sample ${i} returned 200`, false, `got ${r.status}`);
    }
    const { rows: timingRows } = await pool.query(
      `SELECT payload FROM public.offerr_evaluation_events WHERE dedupe_key LIKE $1`,
      [`offerr_evaluation:${FIXTURE_PREFIX}-LAT-%`],
    );
    for (const row of timingRows) {
      const t = parseJson(row.payload)?.timings ?? {};
      for (const k of Object.keys(stageTotals)) {
        if (typeof t[k] === 'number') stageTotals[k].push(t[k]);
      }
    }
    const wall = [...wallLatencies].sort((a, b) => a - b);
    console.log(`  wall-clock over ${wall.length} evaluations:`);
    console.log(`    min=${wall[0]}ms p50=${pct(wall, 50)}ms p95=${pct(wall, 95)}ms max=${wall[wall.length - 1]}ms`);
    console.log('  per-stage (ms):');
    let stageP50Sum = 0;
    for (const [stage, values] of Object.entries(stageTotals)) {
      if (!values.length) continue;
      const s = [...values].sort((a, b) => a - b);
      stageP50Sum += pct(s, 50);
      console.log(`    ${stage.padEnd(16)} n=${String(s.length).padStart(3)} p50=${String(pct(s, 50)).padStart(5)} p95=${String(pct(s, 95)).padStart(5)} max=${String(s[s.length - 1]).padStart(5)}`);
    }
    console.log(`    ${'persistence+ovh'.padEnd(16)} p50=${String(Math.max(0, pct(wall, 50) - stageP50Sum)).padStart(5)}   (derived: wall p50 minus the sum of stage p50s)`);
    const matrixLat = matrix.map((m) => m.latency_ms).sort((a, b) => a - b);
    console.log(`  12-case matrix: min=${matrixLat[0]}ms p50=${pct(matrixLat, 50)}ms p95=${pct(matrixLat, 95)}ms max=${matrixLat[matrixLat.length - 1]}ms`);
    check('every evaluation completed inside the 15s service deadline',
      wall[wall.length - 1] < 15_000, `max=${wall[wall.length - 1]}ms`);
    check('every evaluation completed well under the 60s route budget',
      wall[wall.length - 1] < 60_000, `max=${wall[wall.length - 1]}ms`);

    // ── Final staging state ─────────────────────────────────────────────────
    section('10. FINAL STAGING STATE');
    await setFlag(OFFERR_FLAG_KEY, 'false');
    check('offerr_evaluation_enabled returned to FALSE', (await dbFlagReader(OFFERR_FLAG_KEY)) === false);

    const { rows: flagRows } = await pool.query(
      `SELECT key, value FROM public.system_control ORDER BY key`,
    );
    console.log('  system_control final state:');
    flagRows.forEach((r) => console.log(`    ${r.key} = ${r.value}`));

    section('MATRIX SUMMARY (real comp path)');
    const cols = [30, 6, 12, 5, 5, 5, 5, 5, 22, 6];
    const head = ['CASE', 'HTTP', 'RESOLUTION', 'RPC', 'CAND', 'CLUS', 'ESS', 'RANGE', 'OUTCOME', 'ms'];
    console.log(head.map((h, i) => h.padEnd(cols[i])).join(''));
    for (const m of matrix) {
      console.log([
        m.id, String(m.http), m.resolution_status ?? '-',
        m.rpc_rows == null ? '-' : String(m.rpc_rows),
        m.comp_candidate_count == null ? '-' : String(m.comp_candidate_count),
        m.distinct_clusters == null ? '-' : String(m.distinct_clusters),
        m.effective_sample_size == null ? '-' : String(m.effective_sample_size),
        m.has_range ? 'YES' : 'null',
        m.outcome ?? '-', String(m.latency_ms),
      ].map((v, i) => String(v).padEnd(cols[i])).join(''));
    }

    if (process.env.OFFERR_MATRIX_JSON) {
      const fs = await import('node:fs');
      fs.writeFileSync(process.env.OFFERR_MATRIX_JSON, JSON.stringify(matrix, null, 2));
      console.log(`\n  matrix written to ${process.env.OFFERR_MATRIX_JSON}`);
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
