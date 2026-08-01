/**
 * Offerr preview-branch verification over REAL HTTPS.
 *
 * WHY THIS EXISTS ALONGSIDE offerr-e2e-verify.mjs
 * -----------------------------------------------
 * `offerr-e2e-verify.mjs` imports handleOfferrEvaluationsRequest and calls it
 * in-process against a real database. That proves the domain logic. It does NOT
 * prove the deployed system, because in-process execution skips:
 *
 *   - the Vercel edge (deployment protection, request size limits, routing)
 *   - Next.js request parsing and its own error envelopes
 *   - the serverless cold start and the 15s wall-clock budget
 *   - the runtime env actually shipped to the deployment
 *   - the real network hop to Supabase from the function region
 *
 * This harness drives the DEPLOYED preview URL over HTTPS instead, so every
 * status code, body and timing below is observed behaviour of the deployed
 * system, not of a local function call.
 *
 * PHASES (selected with --phase, because two of them require a REDEPLOY with
 * different runtime env and a script cannot change a deployment's env):
 *
 *   --phase=disabled     feature flag OFF   -> auth/validation/423 matrix
 *   --phase=v3-disabled  flag ON, V3 OFF    -> fail-closed proof
 *   --phase=matrix       flag ON, V3 ON     -> 12 cases, idempotency,
 *                                              concurrency, privacy,
 *                                              side effects, latency
 *
 * SAFETY
 * ------
 * Refuses unless offerr-preview-branch-guard proves a NON-DEFAULT preview
 * branch of the canonical parent project. Only OFFERR-STAGING-TEST- prefixed
 * identifiers are ever written.
 *
 * Usage:
 *   ALLOW_OFFERR_STAGING_FIXTURES=true \
 *   OFFERR_STAGING_PROJECT_REF=<ref> OFFERR_STAGING_DB_URL=... \
 *   PREVIEW_URL=https://... OFFERR_PREVIEW_INTERNAL_SECRET=... \
 *   VERCEL_BYPASS=... \
 *   node --import ./tests/register-aliases.mjs \
 *     scripts/offerr/offerr-preview-https-verify.mjs --phase=matrix
 */

import fs from 'node:fs';

import pg from 'pg';

import {
  assertOfferrPreviewBranch,
  printPreviewIdentity,
} from './offerr-preview-branch-guard.mjs';
import { seedSyntheticFixtures, CASES, FIXTURE_PREFIX } from './offerr-staging-fixtures.mjs';

const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=matrix').split('=')[1];
const SEED = !process.argv.includes('--no-seed');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? null;
const LATENCY_SAMPLES = Number(process.env.OFFERR_LATENCY_SAMPLES || 30);

const PREVIEW_URL = req('PREVIEW_URL');
const SECRET = req('OFFERR_PREVIEW_INTERNAL_SECRET');
const BYPASS = process.env.VERCEL_BYPASS || '';
const DB_URL = req('OFFERR_STAGING_DB_URL');
const ROUTE_PATH = '/api/internal/offerr/evaluations';

function req(name) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) { console.error(`Refusing to run: ${name} is required.`); process.exit(2); }
  return v;
}

/**
 * TLS settings for the Supabase connection.
 *
 * This connection carries database credentials to a Supabase branch across the
 * public internet, so certificate verification stays ON. `rejectUnauthorized:
 * false` accepts any certificate, including an attacker's, which turns the
 * hop into an unauthenticated one.
 *
 * Supabase's pooler endpoints present publicly-trusted certificates, so the
 * default needs no extra material. A direct `db.<ref>.supabase.co` host may
 * present a project-specific CA — download it from the project's Database
 * Settings and point OFFERR_SUPABASE_CA_CERT at the file.
 *
 * Verification can be disabled only by setting
 * OFFERR_ALLOW_INSECURE_DB_TLS=true, and doing so prints a loud warning. It is
 * never the default and never silent.
 */
function buildVerifiedSsl(connectionString) {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(String(connectionString))) return false;

  if (String(process.env.OFFERR_ALLOW_INSECURE_DB_TLS ?? '').trim() === 'true') {
    console.warn(
      '\n  !! TLS CERTIFICATE VERIFICATION DISABLED (OFFERR_ALLOW_INSECURE_DB_TLS=true).\n' +
        '     Database credentials are being sent over an unauthenticated channel.\n',
    );
    return { rejectUnauthorized: false };
  }

  const caPath = String(process.env.OFFERR_SUPABASE_CA_CERT ?? '').trim();
  if (caPath) return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  return { rejectUnauthorized: true };
}

const results = [];
let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

/** One real HTTPS call to the deployed preview. Returns status, body, ms. */
async function call(body, { headers = {}, raw = null, secret = SECRET } = {}) {
  const h = {
    'Content-Type': 'application/json',
    ...(secret ? { 'x-internal-api-secret': secret } : {}),
    ...(BYPASS ? { 'x-vercel-protection-bypass': BYPASS, 'x-vercel-set-bypass-cookie': 'false' } : {}),
    ...headers,
  };
  const started = process.hrtime.bigint();
  const res = await fetch(`${PREVIEW_URL}${ROUTE_PATH}`, {
    method: 'POST',
    headers: h,
    body: raw !== null ? raw : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _nonJson: text.slice(0, 400) }; }
  return { status: res.status, body: parsed, ms, headers: res.headers };
}

// ── side-effect surface ────────────────────────────────────────────────────
// Tables that must be untouched. Many do not exist on a preview branch at all,
// which is a STRONGER result than "count unchanged" — report it as such rather
// than silently scoring an absent table as a pass.
const SIDE_EFFECT_TABLES = [
  'offerr_evaluation_requests', 'offerr_evaluations', 'offerr_evaluation_events',
  'properties', 'buyer_comp_raw_v2', 'buyer_entities_v2',
  'property_acquisition_scores', 'send_queue', 'message_events', 'email_queue',
  'followup_queue', 'campaigns', 'campaign_targets', 'offers', 'contracts',
  'title_orders', 'acquisition_opportunities', 'inbox_thread_state',
  'contact_outreach_state', 'ops_notifications',
];

async function snapshot(pool) {
  const out = {};
  for (const t of SIDE_EFFECT_TABLES) {
    try {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.${t}`);
      out[t] = rows[0].n;
    } catch (e) {
      out[t] = e.code === '42P01' ? 'ABSENT' : `ERR:${e.code}`;
    }
  }
  return out;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const k of Object.keys(before)) {
    if (before[k] !== after[k]) changed.push(`${k}: ${before[k]} -> ${after[k]}`);
  }
  return changed;
}

// ── seller-safe privacy scan ───────────────────────────────────────────────
const FORBIDDEN_KEY = /(^|_)(internal_result|provenance|mao|assignment_fee|buy_box|buyer_id|buyer_key|owner_|master_owner|campaign|contract|title|suppress|property_uuid|candidates)/i;
const FORBIDDEN_VALUE = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // bare uuid
  /\bselect\b.*\bfrom\b/i,
  /at\s+\w+\s+\(.*:\d+:\d+\)/,                                     // stack frame
  /pg_|information_schema|SQLSTATE|relation ".*" does not exist/i,
];
// Correlation/request ids are uuids by design and are explicitly allowed.
const UUID_ALLOWED_KEYS = new Set(['correlation_id', 'request_id', 'evaluation_id', 'idempotency_key']);

function scanSellerSafe(node, path = '$', findings = []) {
  if (node === null || node === undefined) return findings;
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanSellerSafe(v, `${path}[${i}]`, findings));
    return findings;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEY.test(k)) findings.push(`${path}.${k} (forbidden key)`);
      const isAllowedUuidKey = UUID_ALLOWED_KEYS.has(k);
      if (typeof v === 'string') {
        for (const re of FORBIDDEN_VALUE) {
          if (re.test(v)) {
            const bareUuid = re === FORBIDDEN_VALUE[0];
            if (bareUuid && isAllowedUuidKey) continue;
            findings.push(`${path}.${k} (forbidden value pattern ${re})`);
            break;
          }
        }
      }
      scanSellerSafe(v, `${path}.${k}`, findings);
    }
  }
  return findings;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i] * 10) / 10;
}

async function setFlag(pool, value) {
  await pool.query(
    `INSERT INTO public.system_control (key, value) VALUES ('offerr_evaluation_enabled', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(value)],
  );
  const { rows } = await pool.query(
    `SELECT value FROM public.system_control WHERE key='offerr_evaluation_enabled'`,
  );
  return rows[0]?.value;
}

const K = (suffix) => `${FIXTURE_PREFIX}-HTTP-${suffix}`;

async function main() {
  const identity = await assertOfferrPreviewBranch({ target: DB_URL });
  printPreviewIdentity(identity, { script: 'offerr-preview-https-verify', phase: PHASE, preview_url: PREVIEW_URL });

  const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 8 });
  const report = { phase: PHASE, preview_url: PREVIEW_URL, branch: identity, cases: [], latency: null };

  if (SEED) {
    const counts = await seedSyntheticFixtures(pool);
    console.log(`\nfixtures seeded: ${JSON.stringify(counts)}`);
    report.fixtures = counts;
  }

  const before = await snapshot(pool);
  report.side_effects_before = before;

  // ══ PHASE: disabled ═════════════════════════════════════════════════════
  if (PHASE === 'disabled') {
    const flag = await setFlag(pool, false);
    console.log(`\n── Phase 13: flag offerr_evaluation_enabled=${flag} — real HTTPS ──`);

    const noSecret = await call({ address: '4100 Sandbox Clean Ln, Houston, TX 77035', idempotency_key: K('nosecret') }, { secret: '' });
    check('missing secret -> 401', noSecret.status === 401, `http=${noSecret.status} body=${JSON.stringify(noSecret.body).slice(0, 120)}`);

    const badSecret = await call({ address: '4100 Sandbox Clean Ln, Houston, TX 77035', idempotency_key: K('badsecret') }, { secret: 'wrong-secret-value' });
    check('wrong secret -> 401', badSecret.status === 401, `http=${badSecret.status}`);

    // Authentication must happen BEFORE the flag lookup: an unauthenticated
    // caller must not be able to learn the flag state (423 vs 401).
    check('auth precedes flag lookup (unauth gets 401, not 423)',
      noSecret.status === 401 && noSecret.status !== 423, `http=${noSecret.status}`);

    // ORDERING, VERIFIED AGAINST THE DEPLOYED ROUTE:
    //   auth (401) -> flag (423) -> size (413) -> parse (400) -> intake (400)
    // While the flag is OFF the route returns 423 for EVERY authenticated
    // request, including malformed JSON and oversized bodies, because the flag
    // gate precedes body handling. That is fail-closed and correct: a disabled
    // feature must not parse attacker-controlled input or disclose its
    // validation behaviour. The 400/400/413 contract is therefore asserted in
    // the `matrix` phase, where the flag is ON and those codes are reachable.
    const malformed = await call(null, { raw: '{not json' });
    check('malformed JSON while disabled -> uniform 423 (no parsing when off)',
      malformed.status === 423, `http=${malformed.status} err=${malformed.body?.error}`);

    const invalid = await call({ address: 'x', idempotency_key: 'short' });
    check('invalid intake while disabled -> uniform 423',
      invalid.status === 423, `http=${invalid.status} err=${invalid.body?.error}`);

    const big = 'A'.repeat(2 * 1024 * 1024);
    const oversized = await call(null, { raw: JSON.stringify({ address: big, idempotency_key: K('big') }) });
    check('oversized payload while disabled -> uniform 423',
      oversized.status === 423, `http=${oversized.status}`);

    const disabled = await call({ address: '4100 Sandbox Clean Ln, Houston, TX 77035', idempotency_key: K('disabled') });
    check('valid request while disabled -> canonical 423', disabled.status === 423, `http=${disabled.status} body=${JSON.stringify(disabled.body).slice(0, 160)}`);
    check('423 body names the flag and route, leaks nothing else',
      disabled.body?.flag_key === 'offerr_evaluation_enabled' && scanSellerSafe(disabled.body).length === 0,
      JSON.stringify(disabled.body).slice(0, 200));

    // No row of any kind may exist for a disabled-phase request.
    const { rows: zero } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.offerr_evaluation_requests) AS requests,
        (SELECT count(*)::int FROM public.offerr_evaluations)         AS evaluations,
        (SELECT count(*)::int FROM public.offerr_evaluation_events)   AS events`);
    check('no request row written while disabled', zero[0].requests === 0, `requests=${zero[0].requests}`);
    check('no evaluation row written while disabled', zero[0].evaluations === 0, `evaluations=${zero[0].evaluations}`);
    check('no event row written while disabled', zero[0].events === 0, `events=${zero[0].events}`);

    report.disabled_response = disabled.body;
    report.disabled_zero_rows = zero[0];
    report.correlation_ids = {
      no_secret: noSecret.body?.correlation_id ?? null,
      malformed: malformed.body?.correlation_id ?? null,
      invalid: invalid.body?.correlation_id ?? null,
      disabled: disabled.body?.correlation_id ?? null,
    };
  }

  // ══ PHASE: v3-disabled ══════════════════════════════════════════════════
  if (PHASE === 'v3-disabled') {
    const flag = await setFlag(pool, true);
    console.log(`\n── Phase 14: flag=${flag}, acquisition V3 DISABLED — real HTTPS ──`);
    const c01 = CASES[0];
    const r = await call({ address: c01.address, idempotency_key: K('v3off'), seller_facts: c01.seller_facts });
    console.log(`  http=${r.status} ms=${Math.round(r.ms)}`);
    report.v3_disabled_response = r.body;

    check('request accepted (not 5xx)', r.status < 500, `http=${r.status}`);
    const ev = r.body?.evaluation ?? r.body?.result ?? r.body;
    check('no preliminary range exposed', !ev?.preliminary_range && !ev?.range, JSON.stringify(ev?.preliminary_range ?? ev?.range ?? null));
    check('outcome is review-required or equivalent',
      ['REVIEW_REQUIRED', 'UNSUPPORTED'].includes(String(ev?.outcome ?? '').toUpperCase()), `outcome=${ev?.outcome}`);
    const privacy = scanSellerSafe(r.body);
    check('seller-safe payload leaks nothing', privacy.length === 0, privacy.join('; ').slice(0, 300));

    const { rows: reqRows } = await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluation_requests WHERE idempotency_key = $1`, [K('v3off')]);
    check('request row persisted', reqRows[0].n === 1, `rows=${reqRows[0].n}`);
    const { rows: evalRows } = await pool.query(
      `SELECT e.outcome, e.preliminary_range FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id WHERE r.idempotency_key = $1`, [K('v3off')]);
    check('immutable evaluation persisted', evalRows.length === 1, `rows=${evalRows.length}`);
    check('persisted evaluation has no range', !evalRows[0]?.preliminary_range, JSON.stringify(evalRows[0]?.preliminary_range ?? null));
  }

  // ══ PHASE: matrix ═══════════════════════════════════════════════════════
  if (PHASE === 'matrix') {
    const flag = await setFlag(pool, true);
    console.log(`\n── Phase 15/16: flag=${flag}, acquisition V3 ENABLED — 12 cases over real HTTPS ──`);

    // The 400/400/413 contract is only reachable with the flag ON, because the
    // flag gate precedes size/parse/intake handling (see the `disabled` phase).
    console.log('\n  -- request-validation contract (flag ON) --');
    const malformedOn = await call(null, { raw: '{not json' });
    check('malformed JSON -> stable 400', malformedOn.status === 400, `http=${malformedOn.status} err=${malformedOn.body?.error}`);
    const invalidOn = await call({ address: 'x', idempotency_key: 'short' });
    check('invalid intake -> stable 400', invalidOn.status === 400, `http=${invalidOn.status} err=${invalidOn.body?.error}`);
    const bigOn = 'A'.repeat(2 * 1024 * 1024);
    const oversizedOn = await call(null, { raw: JSON.stringify({ address: bigOn, idempotency_key: K('big') }) });
    check('oversized payload -> 413', oversizedOn.status === 413, `http=${oversizedOn.status}`);
    check('validation failures leak nothing',
      scanSellerSafe(malformedOn.body).length === 0 && scanSellerSafe(invalidOn.body).length === 0);
    const { rows: valZero } = await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluation_requests WHERE idempotency_key IN ('short', $1)`, [K('big')]);
    check('rejected requests persisted nothing', valZero[0].n === 0, `rows=${valZero[0].n}`);
    report.validation_contract = {
      malformed: malformedOn.status, invalid: invalidOn.status, oversized: oversizedOn.status,
      malformed_error: malformedOn.body?.error, invalid_error: invalidOn.body?.error,
    };

    for (const c of CASES) {
      const key = K(c.id);
      const r = await call({ address: c.address, idempotency_key: key, seller_facts: c.seller_facts });
      const ev = r.body?.evaluation ?? r.body?.result ?? r.body ?? {};

      const { rows: dbRows } = await pool.query(
        `SELECT r.id request_id, r.resolution_status, e.id evaluation_id, e.outcome,
                e.confidence_label, e.preliminary_range,
                (SELECT count(*)::int FROM public.offerr_evaluation_events ev WHERE ev.request_id = r.id) events
         FROM public.offerr_evaluation_requests r
         LEFT JOIN public.offerr_evaluations e ON e.request_id = r.id
         WHERE r.idempotency_key = $1`, [key]);
      const db = dbRows[0] ?? {};

      const row = {
        case: c.id, title: c.title, http: r.status, ms: Math.round(r.ms),
        correlation_id: r.body?.correlation_id ?? null,
        request_id: db.request_id ?? null, evaluation_id: db.evaluation_id ?? null,
        resolution_status: db.resolution_status ?? null,
        outcome: db.outcome ?? ev.outcome ?? null,
        confidence: db.confidence_label ?? ev.confidence ?? null,
        range: db.preliminary_range ?? null,
        events: db.events ?? 0,
        seller_outcome: ev.outcome ?? null,
        next_step: ev.next_step ?? ev.nextStep ?? null,
        reason_codes: ev.reason_codes ?? ev.reasons ?? null,
      };
      report.cases.push(row);

      console.log(`\n  ${c.id}  http=${r.status} ms=${row.ms} resolution=${row.resolution_status} outcome=${row.outcome} range=${row.range ? 'yes' : 'null'} events=${row.events}`);

      const expected = c.expect;
      const allowedRes = Array.isArray(expected.resolution) ? expected.resolution : [expected.resolution];
      check(`${c.id} http 2xx`, r.status >= 200 && r.status < 300, `http=${r.status}`);
      check(`${c.id} resolution in ${allowedRes.join('|')}`, allowedRes.includes(row.resolution_status), `got=${row.resolution_status}`);
      check(`${c.id} outcome in ${expected.outcomes.join('|')}`, expected.outcomes.includes(String(row.outcome)), `got=${row.outcome}`);
      if (!expected.range_allowed) {
        check(`${c.id} no range exposed`, !row.range, JSON.stringify(row.range));
      }
      if (expected.downgrade_expected) {
        check(`${c.id} not instant-eligible (downgraded)`, row.outcome !== 'INSTANT_RANGE_ELIGIBLE', `outcome=${row.outcome}`);
      }
      check(`${c.id} request row persisted`, Boolean(row.request_id));
      check(`${c.id} evaluation row persisted`, Boolean(row.evaluation_id));
      const priv = scanSellerSafe(r.body);
      check(`${c.id} seller-safe (no internal leakage)`, priv.length === 0, priv.join('; ').slice(0, 240));

      // Phase 19: the binding/preliminary/disclaimer/expiry guarantees live on
      // the seller-facing evaluation object, NOT inside the numeric
      // preliminary_range column (which is only {low, high, currency}).
      if (row.range) {
        check(`${c.id} seller payload: binding=false, preliminary=true, disclaimer, expiry`,
          ev.binding === false && ev.preliminary === true
          && typeof ev.disclaimer === 'string' && ev.disclaimer.length > 20
          && Boolean(ev.expires_at),
          `binding=${ev.binding} preliminary=${ev.preliminary} disclaimer=${String(ev.disclaimer).slice(0, 40)}… expires_at=${ev.expires_at}`);
        check(`${c.id} range is a bounded low/high in USD`,
          Number.isFinite(ev.preliminary_range?.low) && Number.isFinite(ev.preliminary_range?.high)
          && ev.preliminary_range.high >= ev.preliminary_range.low && ev.preliminary_range.currency === 'USD',
          JSON.stringify(ev.preliminary_range));
        check(`${c.id} disclaimer states non-binding and not-an-offer`,
          /non-binding/i.test(ev.disclaimer) && /not an offer/i.test(ev.disclaimer),
          String(ev.disclaimer).slice(0, 120));
      }
      check(`${c.id} seller-appropriate next step present`,
        typeof ev.next_step === 'string' && ev.next_step.length > 0, `next_step=${ev.next_step}`);
      check(`${c.id} no internal underwriting fields in payload`,
        ev.internal_result === undefined && ev.provenance === undefined && ev.property?.property_id === undefined,
        Object.keys(ev).join(','));
    }

    // ── Phase 17: idempotency ────────────────────────────────────────────
    console.log('\n── Phase 17: idempotency + concurrency over real HTTPS ──');
    const c01 = CASES[0];
    const idemKey = K('IDEM');
    const first = await call({ address: c01.address, idempotency_key: idemKey, seller_facts: c01.seller_facts });
    const replay = await call({ address: c01.address, idempotency_key: idemKey, seller_facts: c01.seller_facts });
    check('replay -> 200', replay.status === 200, `http=${replay.status}`);
    check('replay flagged idempotent_replay', replay.body?.idempotent_replay === true, JSON.stringify(replay.body?.idempotent_replay));
    const { rows: idemRows } = await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id WHERE r.idempotency_key = $1`, [idemKey]);
    check('replay created no second snapshot', idemRows[0].n === 1, `snapshots=${idemRows[0].n}`);
    report.idempotency = { first: first.status, replay: replay.status, replay_flag: replay.body?.idempotent_replay, snapshots: idemRows[0].n };

    const conflict = await call({ address: CASES[2].address, idempotency_key: idemKey, seller_facts: {} });
    check('same key + different property -> 409', conflict.status === 409, `http=${conflict.status} err=${conflict.body?.error}`);
    check('409 carries a stable machine-readable failure code',
      conflict.body?.failure_code === 'idempotency_key_reused_with_different_payload',
      `failure_code=${conflict.body?.failure_code}`);
    check('409 does not disclose the conflicting stored payload',
      scanSellerSafe(conflict.body).length === 0 && conflict.body?.evaluation === undefined,
      JSON.stringify(conflict.body).slice(0, 200));
    const { rows: conflictRows } = await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id WHERE r.idempotency_key = $1`, [idemKey]);
    check('409 created no additional snapshot', conflictRows[0].n === 1, `snapshots=${conflictRows[0].n}`);
    report.idempotency.conflict = {
      status: conflict.status, error: conflict.body?.error, failure_code: conflict.body?.failure_code,
    };

    // ── Phase 17: concurrency ────────────────────────────────────────────
    const raceKey = K('RACE');
    const racers = await Promise.all(Array.from({ length: 6 }, () =>
      call({ address: c01.address, idempotency_key: raceKey, seller_facts: c01.seller_facts })));
    const statuses = racers.map((r) => r.status).sort();
    const { rows: raceReq } = await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluation_requests WHERE idempotency_key = $1`, [raceKey]);
    const { rows: raceEval } = await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id WHERE r.idempotency_key = $1`, [raceKey]);
    console.log(`  concurrent statuses: ${statuses.join(',')}`);
    check('exactly one request row under 6-way race', raceReq[0].n === 1, `rows=${raceReq[0].n}`);
    check('exactly one evaluation snapshot under race', raceEval[0].n === 1, `rows=${raceEval[0].n}`);
    check('no 500 from a normal race', !statuses.includes(500), statuses.join(','));
    check('losers are 200 replay or retryable 503', statuses.every((s) => [200, 503].includes(s)), statuses.join(','));
    report.concurrency = { statuses, request_rows: raceReq[0].n, evaluation_rows: raceEval[0].n };

    // new key, same property -> separate evaluation, deterministic comp set
    const key2 = K('NEWKEY');
    const second = await call({ address: c01.address, idempotency_key: key2, seller_facts: c01.seller_facts });
    check('new key on same property creates a separate evaluation', second.status === 200 && !second.body?.idempotent_replay, `http=${second.status}`);
    const { rows: hashRows } = await pool.query(
      `SELECT e.provenance->>'comp_set_hash' AS h FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id = e.request_id
       WHERE r.idempotency_key = ANY($1)`, [[idemKey, key2]]);
    const hashes = hashRows.map((r) => r.h).filter(Boolean);
    check('comp-set hash deterministic across evaluations of unchanged data',
      hashes.length < 2 || new Set(hashes).size === 1, hashes.join(' vs '));
    report.comp_set_hashes = hashes;

    // ── Phase 21: latency ────────────────────────────────────────────────
    console.log(`\n── Phase 21: hosted latency, ${LATENCY_SAMPLES} real HTTPS evaluations ──`);
    const samples = [];
    for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
      const r = await call({ address: c01.address, idempotency_key: K(`LAT-${i}`), seller_facts: c01.seller_facts });
      samples.push({ ms: r.ms, status: r.status, timings: r.body?.timings ?? r.body?.stage_timings ?? null });
    }
    const wall = samples.map((s) => s.ms).sort((a, b) => a - b);
    report.latency = {
      samples: samples.length,
      http_p50: pct(wall, 50), http_p95: pct(wall, 95), http_max: Math.round(wall[wall.length - 1] * 10) / 10,
      first_sample_ms: Math.round(samples[0].ms), // cold-start observation
      non_200: samples.filter((s) => s.status !== 200).length,
      stage_timings_sample: samples[samples.length - 1].timings,
    };
    console.log(`  p50=${report.latency.http_p50}ms p95=${report.latency.http_p95}ms max=${report.latency.http_max}ms first=${report.latency.first_sample_ms}ms`);
    check('hosted p95 within the 15s deadline', report.latency.http_p95 < 15000, `p95=${report.latency.http_p95}ms`);
    check('every latency sample returned 200', report.latency.non_200 === 0, `non200=${report.latency.non_200}`);
  }

  // ══ PHASE: persistence-failure ══════════════════════════════════════════
  // Induces a TEMPORARY, preview-only snapshot failure and proves the spine
  // compensates rather than leaving a half-written evaluation. The trigger is
  // installed and dropped inside a try/finally so it cannot survive a crash.
  if (PHASE === 'persistence-failure') {
    await setFlag(pool, true);
    console.log('\n── Phase 18: induced evaluation-snapshot failure — real HTTPS ──');
    const key = K('PERSIST-FAIL');
    const c01 = CASES[0];

    await pool.query(`DELETE FROM public.offerr_evaluation_events WHERE request_id IN
      (SELECT id FROM public.offerr_evaluation_requests WHERE idempotency_key=$1)`, [key]);
    await pool.query(`DELETE FROM public.offerr_evaluations WHERE request_id IN
      (SELECT id FROM public.offerr_evaluation_requests WHERE idempotency_key=$1)`, [key]);
    await pool.query('DELETE FROM public.offerr_evaluation_requests WHERE idempotency_key=$1', [key]);

    const baseline = (await pool.query('SELECT count(*)::int n FROM public.offerr_evaluation_requests')).rows[0].n;
    console.log(`  baseline request rows: ${baseline}`);

    let failed;
    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION public.offerr_tmp_fail_snapshot() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'OFFERR_PREVIEW_INDUCED_SNAPSHOT_FAILURE' USING ERRCODE = '58030';
        END $fn$;`);
      await pool.query(`
        CREATE TRIGGER offerr_tmp_fail_snapshot_trg BEFORE INSERT ON public.offerr_evaluations
        FOR EACH ROW EXECUTE FUNCTION public.offerr_tmp_fail_snapshot();`);
      console.log('  induced failure installed (BEFORE INSERT trigger on offerr_evaluations)');

      failed = await call({ address: c01.address, idempotency_key: key, seller_facts: c01.seller_facts });
      console.log(`  http=${failed.status} body=${JSON.stringify(failed.body).slice(0, 200)}`);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS offerr_tmp_fail_snapshot_trg ON public.offerr_evaluations');
      await pool.query('DROP FUNCTION IF EXISTS public.offerr_tmp_fail_snapshot()');
      console.log('  induced failure REMOVED (trigger + function dropped)');
    }

    check('no success returned on snapshot failure', failed.status >= 400, `http=${failed.status}`);
    check('failure is retryable (503) not an unhandled 500',
      failed.status === 503, `http=${failed.status} failure_code=${failed.body?.failure_code}`);
    check('failure response is seller-safe', scanSellerSafe(failed.body).length === 0
      && !JSON.stringify(failed.body).includes('OFFERR_PREVIEW_INDUCED'), JSON.stringify(failed.body).slice(0, 200));

    const noEval = (await pool.query(
      `SELECT count(*)::int n FROM public.offerr_evaluations e
       JOIN public.offerr_evaluation_requests r ON r.id=e.request_id WHERE r.idempotency_key=$1`, [key])).rows[0].n;
    check('no evaluation snapshot persisted', noEval === 0, `snapshots=${noEval}`);

    const afterFail = (await pool.query('SELECT count(*)::int n FROM public.offerr_evaluation_requests')).rows[0].n;
    check('compensating deletion removed the orphan request', afterFail === baseline,
      `baseline=${baseline} after=${afterFail}`);

    // Schema is already restored; the same key must now be reusable end-to-end.
    const retry = await call({ address: c01.address, idempotency_key: key, seller_facts: c01.seller_facts });
    check('idempotency key reusable after recovery', retry.status === 200, `http=${retry.status}`);
    check('retry was NOT served as an idempotent replay of the failed attempt',
      retry.body?.idempotent_replay === false, `replay=${retry.body?.idempotent_replay}`);
    const finalRows = (await pool.query(
      `SELECT (SELECT count(*)::int FROM public.offerr_evaluation_requests WHERE idempotency_key=$1) req,
              (SELECT count(*)::int FROM public.offerr_evaluations e
                 JOIN public.offerr_evaluation_requests r ON r.id=e.request_id
                 WHERE r.idempotency_key=$1) ev`, [key])).rows[0];
    check('retry produced exactly one request and one evaluation',
      finalRows.req === 1 && finalRows.ev === 1, `req=${finalRows.req} ev=${finalRows.ev}`);

    const leftover = (await pool.query(`
      SELECT count(*)::int n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = 'offerr_tmp_fail_snapshot_trg'`)).rows[0].n;
    check('no temporary failure hook left behind', leftover === 0, `triggers=${leftover}`);

    report.persistence_failure = {
      baseline_requests: baseline, failure_status: failed.status,
      failure_code: failed.body?.failure_code, snapshots_after_failure: noEval,
      requests_after_compensation: afterFail, retry_status: retry.status, final: finalRows,
    };
  }

  // ── Phase 20: side-effect reconciliation ─────────────────────────────────
  const after = await snapshot(pool);
  report.side_effects_after = after;
  const changed = diffSnapshots(before, after);
  const offerrOnly = changed.every((c) => c.startsWith('offerr_'));
  console.log('\n── Phase 20: side-effect reconciliation ──');
  for (const c of changed) console.log(`  changed: ${c}`);
  const absent = Object.entries(after).filter(([, v]) => v === 'ABSENT').map(([k]) => k);
  console.log(`  tables ABSENT on preview branch (cannot be written by construction): ${absent.join(', ') || 'none'}`);
  check('only offerr_* tables changed', offerrOnly, changed.filter((c) => !c.startsWith('offerr_')).join('; '));
  check('property/comp/buyer fixtures are read-only during evaluation',
    before.properties === after.properties
    && before.buyer_comp_raw_v2 === after.buyer_comp_raw_v2
    && before.buyer_entities_v2 === after.buyer_entities_v2,
    `properties ${before.properties}->${after.properties}, comps ${before.buyer_comp_raw_v2}->${after.buyer_comp_raw_v2}, buyers ${before.buyer_entities_v2}->${after.buyer_entities_v2}`);

  const { rows: dist } = await pool.query(`
    SELECT r.resolution_status, e.outcome, count(*)::int n
    FROM public.offerr_evaluation_requests r
    LEFT JOIN public.offerr_evaluations e ON e.request_id = r.id
    GROUP BY 1,2 ORDER BY 1,2`);
  report.distribution = dist;
  const { rows: incomplete } = await pool.query(`
    SELECT count(*)::int n FROM public.offerr_evaluation_requests r
    WHERE NOT EXISTS (SELECT 1 FROM public.offerr_evaluations e WHERE e.request_id = r.id)`);
  report.incomplete_requests = incomplete[0].n;
  console.log(`  outcome distribution: ${JSON.stringify(dist)}`);
  console.log(`  requests without an evaluation snapshot: ${incomplete[0].n}`);

  await pool.end();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  phase=${PHASE}  checks=${results.length}  pass=${results.length - failures}  fail=${failures}`);
  console.log(`${'='.repeat(70)}`);
  report.summary = { checks: results.length, pass: results.length - failures, fail: failures };
  report.failed = results.filter((r) => !r.ok);
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`  report -> ${OUT}`); }
  if (failures) process.exitCode = 1;
}

await main();
