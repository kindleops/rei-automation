/**
 * Offerr hosted RLS / privilege proof — exercises the REAL PostgREST surface of
 * a Supabase preview branch as anon, authenticated and service_role.
 *
 * WHY THIS EXISTS
 * ---------------
 * `offerr-schema-verify.sql` reads the catalog: it proves the GRANTs and
 * policies are *recorded* correctly. That is not the same as proving the hosted
 * API *behaves* correctly. PostgREST sits in front of the database with its own
 * schema cache, its own role switching (`SET LOCAL ROLE` derived from the JWT),
 * and its own error mapping. A table can look locked down in pg_catalog and
 * still be reachable if, say, it were exposed through an exposed-schema view.
 *
 * This script asserts observable HTTP behaviour instead:
 *
 *   anon           → must be denied every read and every write on all three
 *                    offerr_* tables, and must not be able to execute the
 *                    internal helper function.
 *   authenticated  → identical denial (no seller-facing policy exists, and none
 *                    should be introduced by this work).
 *   service_role   → may run the request lifecycle (select/insert/update/delete)
 *                    and may append evaluations and events, but must NOT be able
 *                    to UPDATE or DELETE an evaluation or an event. That is what
 *                    makes "immutable snapshot" and "append-only ledger" real
 *                    rather than conventional.
 *
 * SAFETY
 * ------
 * Refuses to run unless offerr-preview-branch-guard.mjs proves the target is a
 * NON-DEFAULT preview branch of the canonical parent project. Probe rows are
 * written with an OFFERR-STAGING-TEST- prefixed idempotency key and removed
 * again at the end (via the same service-role API where permitted, and reported
 * when a deliberate privilege denial makes cleanup impossible).
 *
 * Usage:
 *   ALLOW_OFFERR_STAGING_FIXTURES=true \
 *   OFFERR_STAGING_PROJECT_REF=<preview-ref> \
 *   OFFERR_STAGING_DB_URL=... SUPABASE_URL=... SUPABASE_ANON_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_JWT_SECRET=... \
 *   node apps/api/scripts/offerr/offerr-preview-rls-proof.mjs
 */

import crypto from 'node:crypto';

import {
  assertOfferrPreviewBranch,
  printPreviewIdentity,
} from './offerr-preview-branch-guard.mjs';

const FIXTURE_PREFIX = 'OFFERR-STAGING-TEST-';

const SUPABASE_URL = required('SUPABASE_URL');
const ANON_KEY = required('SUPABASE_ANON_KEY');
const SERVICE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');
const JWT_SECRET = required('SUPABASE_JWT_SECRET');

function required(name) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) {
    console.error(`Refusing to run: ${name} is required.`);
    process.exit(2);
  }
  return v;
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Mint an HS256 Supabase JWT for a given role. */
function mintJwt(role, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    role,
    iss: 'supabase',
    sub: '00000000-0000-0000-0000-000000000000',
    aud: 'authenticated',
    iat: now,
    exp: now + 3600,
  }));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

async function rest(path, { method = 'GET', apikey, token, body, prefer } = {}) {
  const headers = {
    apikey,
    Authorization: `Bearer ${token ?? apikey}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const results = [];
function record({ role, op, expected, status, body }) {
  // A privilege denial is 401/403 (42501) or 404 when PostgREST will not even
  // admit the routine exists. 409 is NOT a privilege denial — it is a
  // constraint refusal — so it is only accepted where explicitly expected.
  const denied = status === 401 || status === 403 || status === 404;
  const ok =
    typeof expected === 'number' ? status === expected
      : expected === 'DENY' ? denied
        : status >= 200 && status < 300;
  const code = body && typeof body === 'object' && body.code ? body.code : '';
  results.push({ role, op, expected, status, code, ok });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(
    `  ${mark}  ${role.padEnd(14)} ${op.padEnd(46)} expected=${String(expected).padEnd(5)} http=${String(status).padEnd(4)} ${code}`,
  );
  return ok;
}

async function main() {
  const identity = await assertOfferrPreviewBranch({
    target: process.env.OFFERR_STAGING_DB_URL ?? SUPABASE_URL,
  });
  printPreviewIdentity(identity, { script: 'offerr-preview-rls-proof' });

  const authedJwt = mintJwt('authenticated', JWT_SECRET);
  const stamp = `${FIXTURE_PREFIX}RLS-${Date.now()}`;

  // Each table needs a column that genuinely exists on it. PostgREST parses the
  // request body against its schema cache BEFORE it reaches the privilege
  // check, so patching a non-existent column returns 400/PGRST204 and proves
  // nothing about authorization. Use a real, constraint-valid column per table.
  const TABLES = [
    ['offerr_evaluation_requests', { resolution_status: 'NOT_FOUND' }],
    ['offerr_evaluations', { outcome: 'REVIEW_REQUIRED' }],
    ['offerr_evaluation_events', { event_type: 'probe' }],
  ];

  // ── anon + authenticated must be denied everything ──────────────────────
  for (const [role, apikey, token] of [
    ['anon', ANON_KEY, undefined],
    ['authenticated', ANON_KEY, authedJwt],
  ]) {
    console.log(`\n── ${role}: every Offerr surface must be denied ──`);
    for (const [t, patch] of TABLES) {
      record({ role, op: `SELECT ${t}`, expected: 'DENY',
        ...(await rest(`/${t}?select=id&limit=1`, { apikey, token })) });
      record({ role, op: `INSERT ${t}`, expected: 'DENY',
        ...(await rest(`/${t}`, { apikey, token, method: 'POST', body: { id: crypto.randomUUID() } })) });
      record({ role, op: `UPDATE ${t}`, expected: 'DENY',
        ...(await rest(`/${t}?id=eq.${crypto.randomUUID()}`, { apikey, token, method: 'PATCH', body: patch })) });
      record({ role, op: `DELETE ${t}`, expected: 'DENY',
        ...(await rest(`/${t}?id=eq.${crypto.randomUUID()}`, { apikey, token, method: 'DELETE' })) });
    }
    record({ role, op: 'RPC offerr_touch_updated_at', expected: 'DENY',
      ...(await rest('/rpc/offerr_touch_updated_at', { apikey, token, method: 'POST', body: {} })) });
  }

  // ── service_role: the exact intended capability set ─────────────────────
  console.log('\n── service_role: intended capabilities only ──');
  const svc = { apikey: SERVICE_KEY, token: SERVICE_KEY };

  const insReq = await rest('/offerr_evaluation_requests', {
    ...svc, method: 'POST', prefer: 'return=representation',
    body: {
      idempotency_key: stamp,
      raw_submitted_address: '1 Preview Rls Probe St, Testville, TX 75001',
      normalized_submitted_address: '1 PREVIEW RLS PROBE ST TESTVILLE TX 75001',
      spine_version: 'rls-proof',
      resolution_status: 'RESOLVED',
      source: 'internal',
    },
  });
  record({ role: 'service_role', op: 'INSERT request', expected: 'ALLOW', ...insReq });
  const requestId = Array.isArray(insReq.body) && insReq.body[0] ? insReq.body[0].id : null;

  // Fail fast: without a real request id every downstream probe degrades into
  // `id=eq.null` and returns 22P02, which would be reported as a privilege
  // result when it is really a broken probe.
  if (!requestId) {
    console.error('\nABORT: could not create the probe request row; downstream '
      + 'privilege probes would be meaningless. Response: '
      + JSON.stringify(insReq.body));
    process.exit(1);
  }

  record({ role: 'service_role', op: 'SELECT request', expected: 'ALLOW',
    ...(await rest(`/offerr_evaluation_requests?select=id&idempotency_key=eq.${stamp}`, svc)) });
  record({ role: 'service_role', op: 'UPDATE request', expected: 'ALLOW',
    ...(await rest(`/offerr_evaluation_requests?idempotency_key=eq.${stamp}`, {
      ...svc, method: 'PATCH', body: { resolution_status: 'AMBIGUOUS' } })) });

  const insEval = await rest('/offerr_evaluations', {
    ...svc, method: 'POST', prefer: 'return=representation',
    body: {
      request_id: requestId,
      outcome: 'REVIEW_REQUIRED',
      seller_projection: { probe: true },
      internal_result: { probe: true },
      provenance: { probe: true },
      spine_version: 'rls-proof',
      computed_at: new Date().toISOString(),
    },
  });
  record({ role: 'service_role', op: 'INSERT evaluation', expected: 'ALLOW', ...insEval });
  const evaluationId = Array.isArray(insEval.body) && insEval.body[0] ? insEval.body[0].id : null;

  record({ role: 'service_role', op: 'SELECT evaluation', expected: 'ALLOW',
    ...(await rest(`/offerr_evaluations?select=id&request_id=eq.${requestId}`, svc)) });
  record({ role: 'service_role', op: 'UPDATE evaluation (immutable)', expected: 'DENY',
    ...(await rest(`/offerr_evaluations?id=eq.${evaluationId}`, { ...svc, method: 'PATCH', body: { outcome: 'tampered' } })) });
  record({ role: 'service_role', op: 'DELETE evaluation (immutable)', expected: 'DENY',
    ...(await rest(`/offerr_evaluations?id=eq.${evaluationId}`, { ...svc, method: 'DELETE' })) });

  const insEvent = await rest('/offerr_evaluation_events', {
    ...svc, method: 'POST', prefer: 'return=representation',
    body: { request_id: requestId, evaluation_id: evaluationId, event_type: 'rls_proof', payload: { probe: true } },
  });
  record({ role: 'service_role', op: 'INSERT event', expected: 'ALLOW', ...insEvent });
  const eventId = Array.isArray(insEvent.body) && insEvent.body[0] ? insEvent.body[0].id : null;

  record({ role: 'service_role', op: 'SELECT event', expected: 'ALLOW',
    ...(await rest(`/offerr_evaluation_events?select=id&request_id=eq.${requestId}`, svc)) });
  record({ role: 'service_role', op: 'UPDATE event (append-only)', expected: 'DENY',
    ...(await rest(`/offerr_evaluation_events?id=eq.${eventId}`, { ...svc, method: 'PATCH', body: { event_type: 'tampered' } })) });
  record({ role: 'service_role', op: 'DELETE event (append-only)', expected: 'DENY',
    ...(await rest(`/offerr_evaluation_events?id=eq.${eventId}`, { ...svc, method: 'DELETE' })) });

  // Compensating deletion of the request must remain possible — the spine
  // relies on it to remove an orphan when snapshot persistence fails.
  //
  // It is probed on a SEPARATE, childless request. Neither FK from
  // offerr_evaluations / offerr_evaluation_events is ON DELETE CASCADE, so a
  // request that already has an evaluation or event cannot be deleted (23503).
  // That is the correct shape: compensation only ever runs on the failure path,
  // where by definition no snapshot was persisted. Deleting the row used above
  // would test a scenario the spine never reaches.
  const orphanStamp = `${stamp}-ORPHAN`;
  const orphan = await rest('/offerr_evaluation_requests', {
    ...svc, method: 'POST', prefer: 'return=representation',
    body: {
      idempotency_key: orphanStamp,
      raw_submitted_address: '2 Preview Rls Probe St, Testville, TX 75001',
      normalized_submitted_address: '2 PREVIEW RLS PROBE ST TESTVILLE TX 75001',
      spine_version: 'rls-proof',
      resolution_status: 'RESOLVED',
      source: 'internal',
    },
  });
  record({ role: 'service_role', op: 'INSERT orphan request', expected: 'ALLOW', ...orphan });
  record({ role: 'service_role', op: 'DELETE request (compensating)', expected: 'ALLOW',
    ...(await rest(`/offerr_evaluation_requests?idempotency_key=eq.${orphanStamp}`, { ...svc, method: 'DELETE' })) });

  // A request that DOES have children must be protected from deletion — this is
  // what stops an evaluation snapshot from being orphaned by a stray delete.
  record({ role: 'service_role', op: 'DELETE request with children (FK 409)', expected: 409,
    ...(await rest(`/offerr_evaluation_requests?idempotency_key=eq.${stamp}`, { ...svc, method: 'DELETE' })) });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  checks: ${results.length}   pass: ${results.length - failed.length}   fail: ${failed.length}`);
  console.log(`${'='.repeat(64)}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.role} ${f.op} (http ${f.status} ${f.code})`);
    process.exitCode = 1;
  } else {
    console.log('  HOSTED RLS/PRIVILEGE POSTURE PROVEN');
  }

  console.log('\nNOTE: evaluation/event probe rows cannot be removed via the API by '
    + 'design (no UPDATE/DELETE grant). Remove them with a direct owner connection.');
  console.log(JSON.stringify({ requestId, evaluationId, eventId, stamp }));
}

await main();
