// Agent GATE B (owner D1, 10-10) — named-user authentication before any paid
// operation, review-only S3, spend guard, kill switch, per-user rate limits.
//
//   1 auth: no session → 401; not on the allowlist → 403; spoofed header → 403;
//     expired / service / anonymous / forged tokens → 401; verifier down → 503
//   2 actor stamping: the verified user id is on every run, event and finding
//     (memory store here; Postgres + DB triggers in the PG section)
//   3 read-only gating in the REGISTRY (registration + authorization), not the UI
//   4 kill switch AGENT_ENABLED: default off in prod; routes 404; dispatcher stops
//   5 spend caps: $0 by default; per-user + global USD and token caps; clamped
//   6 per-user rate limits + durable daily run cap
//   7 the provider key never reaches the browser
// No network: the Supabase verifier is injected (tests/helpers/agent-test-identity.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

import { multiDb, FIXTURE_PII } from '../helpers/agent-s3-fake-db.mjs'
import { OP, OTHER, OUTSIDER, authHeaders, bearer, gateB, makeToken } from '../helpers/agent-test-identity.mjs'
import { pgAvailable, skipReason, freshDb } from '../pg/agent-pg-harness.mjs'
import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createRunService, SHARED_IDENTITY_RE } from '../../src/lib/agent/runtime/run-service.js'
import { createLiveAgent, isLiveAgentEnabled, __resetLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'
import { createQuickScanToolRegistry, QUICK_SCAN_TOOL_NAMES } from '../../src/lib/agent/quick-scan/tools.js'
import { createToolRegistry, authorizeToolCall, readOnlyViolation } from '../../src/lib/agent/tools/registry.js'
import { createDefaultToolRegistry, ADAPTER_TOOL_SPECS } from '../../src/lib/agent/tools/adapters/index.js'
import { isAgentEnabled, resolveAgentReadOnly, isAgentReadOnly } from '../../src/lib/agent/config/agent-config.js'
import { createAgentIdentityProvider, checkClaims, decodeJwt } from '../../src/lib/agent/security/agent-auth.js'
import { createSupabaseUserVerifier } from '../../src/lib/security/supabase-session-verifier.js'
import { createUserRateLimiter, resolveRateLimits, RATE_LIMIT_MAX } from '../../src/lib/agent/security/rate-limit.js'
import { resolveSpendCaps, checkSpend, spendUsage, SPEND_HARD_CEILINGS } from '../../src/lib/agent/budget/spend-guard.js'
import { createBudgetLedger } from '../../src/lib/agent/budget/ledger.js'
import { createPgAgentStore, DEFAULT_ORG_ID } from '../../src/lib/agent/runtime/pg-store.js'
import * as R from '../../src/lib/agent/live/live-routes.js'
import { ensureMutationAuth } from '../../src/app/api/cockpit/_shared.js'
import * as statusRoute from '../../src/app/api/cockpit/agent/live/status/route.js'
import * as preflightRoute from '../../src/app/api/cockpit/agent/live/quick-scan/preflight/route.js'
import * as confirmRoute from '../../src/app/api/cockpit/agent/live/quick-scan/confirm/route.js'
import * as runsRoute from '../../src/app/api/cockpit/agent/live/runs/route.js'
import * as runRoute from '../../src/app/api/cockpit/agent/live/runs/[run_id]/route.js'
import * as eventsRoute from '../../src/app/api/cockpit/agent/live/runs/[run_id]/events/route.js'
import * as cancelRoute from '../../src/app/api/cockpit/agent/live/runs/[run_id]/cancel/route.js'

const BASE = 'http://localhost:3000/api/cockpit/agent/live'
const ON = { AGENT_LIVE_ROUTES: '1', AGENT_MAX_MODE: 'read', NODE_ENV: 'development' }
const IDS = ['9000000001', '9000000002']
const req = (p, { method = 'GET', headers = authHeaders(OP), body } = {}) => new Request(`${BASE}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
const post = (p, body, headers) => req(p, { method: 'POST', body, ...(headers ? { headers } : {}) })

function makeAgent(env = ON, opts = {}) {
  const db = multiDb(IDS)
  const agent = createLiveAgent({ env, store: createInMemoryAgentStore(), createServices: () => createQuickScanServices({ db }), requireVerifiedOperator: true, ...opts })
  return { agent, db }
}

async function fullScan(o, ids = IDS) {
  const pf = await (await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: ids }), o)).json()
  assert.equal(pf.ok, true, JSON.stringify(pf))
  const c = await R.handleQuickScanConfirm(post('/quick-scan/confirm', { job_id: pf.job_id, scope_hash: pf.scope_hash }), o)
  assert.equal(c.status, 202)
  await o.agent.quickScan.idle()
  return pf
}

// ── 1 auth ──────────────────────────────────────────────────────────────────

test('auth: no session → 401 on EVERY agent route; the worker-asserted header alone is never an identity', async () => {
  const { agent } = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...gateB(), agent }
  const noSession = { 'x-ops-dashboard-secret': 'test', 'x-ops-user-id': OP } // secret + header, no session token
  const p = { params: { run_id: 'run_x' } }
  const all = [
    await R.handleLiveStatus(req('/status', { headers: noSession }), o),
    await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }, noSession), o),
    await R.handleQuickScanConfirm(post('/quick-scan/confirm', { job_id: 'j', scope_hash: 'h' }, noSession), o),
    await R.handleLiveRuns(req('/runs', { headers: noSession }), o),
    await R.handleLiveRunSnapshot(req('/runs/run_x', { headers: noSession }), { ...o, ...p }),
    await R.handleLiveRunEvents(req('/runs/run_x/events', { headers: noSession }), { ...o, ...p }),
    await R.handleLiveRunCancel(post('/runs/run_x/cancel', {}, noSession), { ...o, ...p }),
  ]
  for (const r of all) {
    assert.equal(r.status, 401)
    assert.equal((await r.json()).error, 'SESSION_REQUIRED')
  }
  // no shared secret at all → the ops gate answers 401 first
  assert.equal((await R.handleLiveStatus(req('/status', { headers: { authorization: bearer(OP) } }), o)).status, 401)
  assert.equal(agent.store.read().runs.size, 0, 'nothing was created')
})

test('auth: not on the allowlist → 403; empty allowlist authorizes nobody; spoofed x-ops-user-id → 403', async () => {
  const { agent } = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...gateB({ allow: [OP] }), agent }
  const out = await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }, authHeaders(OUTSIDER)), o)
  assert.equal(out.status, 403)
  assert.equal((await out.json()).error, 'OPERATOR_NOT_ALLOWLISTED')
  const empty = { env: ON, auth: ensureMutationAuth, ...gateB({ allow: [], live: new Set([OP]) }), agent }
  assert.equal((await R.handleLiveStatus(req('/status'), empty)).status, 403)
  // a valid session for OUTSIDER cannot borrow OP's id through the header
  const spoof = await R.handleLiveStatus(req('/status', { headers: authHeaders(OUTSIDER, { header: OP }) }), o)
  assert.equal(spoof.status, 403)
  // ...nor can OP's own session claim another operator
  const mismatch = await R.handleLiveRuns(req('/runs', { headers: authHeaders(OP, { header: OTHER }) }), { ...o, ...gateB({ allow: [OP, OTHER] }) })
  assert.equal(mismatch.status, 403)
  assert.equal((await mismatch.json()).error, 'OPERATOR_MISMATCH')
  // the header is optional; the session alone identifies the user
  assert.equal((await R.handleLiveStatus(req('/status', { headers: authHeaders(OP, { header: null }) }), o)).status, 200)
  assert.equal(agent.store.read().runs.size, 0)
})

test('auth: expired, service-role, anon, anonymous-user, wrong-audience, forged and revoked tokens are refused (401); verifier down → 503', async () => {
  const env = { OPS_ALLOWED_USER_IDS: `${OP}`, SUPABASE_URL: 'https://proj.supabase.co' }
  const accepts = new Set([OP])
  const idp = createAgentIdentityProvider({ env, verifyToken: async (t) => { const sub = decodeJwt(t).claims.sub; return accepts.has(sub) ? { id: sub } : null } })
  const H = (claims, sub = OP) => new Request('http://x', { headers: { authorization: `Bearer ${makeToken(sub, claims)}` } })
  const now = Math.floor(Date.now() / 1000)
  const cases = [
    [{ exp: now - 120 }, 'SESSION_EXPIRED'],
    [{ role: 'service_role' }, 'SERVICE_IDENTITY_REFUSED'],
    [{ role: 'anon' }, 'SERVICE_IDENTITY_REFUSED'],
    [{ is_anonymous: true }, 'SESSION_INVALID'],
    [{ aud: 'other' }, 'SESSION_INVALID'],
    [{ iss: 'https://evil.supabase.co/auth/v1' }, 'SESSION_INVALID'],
    [{ exp: undefined }, 'SESSION_INVALID'],
  ]
  for (const [claims, code] of cases) {
    const r = await idp.authenticate(H(claims))
    assert.deepEqual([r.ok, r.status, r.code], [false, 401, code], JSON.stringify(claims))
  }
  assert.equal((await idp.authenticate(H({}, 'not-a-uuid'))).code, 'SESSION_INVALID')
  assert.equal((await idp.authenticate(new Request('http://x', { headers: { authorization: 'Bearer abc.def' } }))).code, 'SESSION_INVALID')
  // Supabase Auth no longer accepts the session (signed out / revoked)
  accepts.delete(OP)
  assert.deepEqual([(await idp.authenticate(H({}))).status, (await idp.authenticate(H({}))).code], [401, 'SESSION_INVALID'])
  // verifier unconfigured (no SUPABASE_URL / service key on the API) → 503, never a fallback identity
  const real = createAgentIdentityProvider({ env: { OPS_ALLOWED_USER_IDS: OP } })
  const down = await real.authenticate(H({}))
  assert.deepEqual([down.ok, down.status, down.code], [false, 503, 'IDENTITY_VERIFIER_UNCONFIGURED'])
  // the happy path
  accepts.add(OP)
  const ok = await idp.authenticate(H({ iss: 'https://proj.supabase.co/auth/v1' }))
  assert.deepEqual([ok.ok, ok.identity.verified, ok.identity.named, ok.identity.user_id, ok.identity.method], [true, true, true, OP, 'supabase_jwt'])
  assert.ok(Object.isFrozen(ok.identity))
})

test('auth: optional local HS256 check (AGENT_SUPABASE_JWT_SECRET) rejects a forged signature before the network check', async () => {
  const secret = 'test-jwt-secret-not-real'
  let calls = 0
  const idp = createAgentIdentityProvider({ env: { OPS_ALLOWED_USER_IDS: OP, AGENT_SUPABASE_JWT_SECRET: secret }, verifyToken: async () => { calls += 1; return { id: OP } } })
  const forged = makeToken(OP)
  assert.equal((await idp.authenticate(new Request('http://x', { headers: { authorization: `Bearer ${forged}` } }))).code, 'SESSION_INVALID')
  assert.equal(calls, 0)
  const [h, p] = forged.split('.')
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')
  const r = await idp.authenticate(new Request('http://x', { headers: { authorization: `Bearer ${h}.${p}.${sig}` } }))
  assert.equal(r.ok, true)
  assert.equal(calls, 1)
  assert.equal(checkClaims(decodeJwt(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.x`)).reason, 'alg_none')
})

test('auth: the Supabase verifier calls /auth/v1/user with the service key as apikey only, caches by digest, and fails closed', async () => {
  const seen = []
  let up = true
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, apikey: init.headers.apikey })
    if (!up) throw new Error('down')
    return { ok: true, json: async () => ({ id: OP.toUpperCase(), email: 'x@example.test' }) }
  }
  const v = createSupabaseUserVerifier({ env: { SUPABASE_URL: 'https://proj.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, fetchImpl })
  const tok = makeToken(OP)
  assert.deepEqual(await v(tok), { id: OP, is_anonymous: false })
  assert.deepEqual(await v(tok), { id: OP, is_anonymous: false })
  assert.equal(seen.length, 1, 'cached')
  assert.deepEqual(seen[0], { url: 'https://proj.supabase.co/auth/v1/user', auth: `Bearer ${tok}`, apikey: 'svc' })
  up = false
  assert.equal(await v(makeToken(OTHER)), null, 'auth unreachable ⇒ deny')
  assert.equal(await createSupabaseUserVerifier({ env: {}, fetchImpl })(tok), 'unconfigured')
})

test('auth: the real route modules are wired to named-user auth (no bearer → 401 even with the shared secret + header)', async () => {
  const keep = { routes: process.env.AGENT_LIVE_ROUTES, mode: process.env.AGENT_MAX_MODE, enabled: process.env.AGENT_ENABLED }
  process.env.AGENT_LIVE_ROUTES = '1'
  process.env.AGENT_MAX_MODE = 'read'
  delete process.env.AGENT_ENABLED
  __resetLiveAgent()
  try {
    const H = { 'x-ops-dashboard-secret': 'test', 'x-ops-user-id': OP }
    const ctx = { params: Promise.resolve({ run_id: 'run_x' }) }
    for (const r of [
      await statusRoute.GET(req('/status', { headers: H })),
      await preflightRoute.POST(post('/quick-scan/preflight', { property_ids: IDS }, H)),
      await confirmRoute.POST(post('/quick-scan/confirm', { job_id: 'j', scope_hash: 'h' }, H)),
      await runsRoute.GET(req('/runs', { headers: H })),
      await runRoute.GET(req('/runs/run_x', { headers: H }), ctx),
      await eventsRoute.GET(req('/runs/run_x/events', { headers: H }), ctx),
      await cancelRoute.POST(post('/runs/run_x/cancel', {}, H), ctx),
    ]) assert.equal(r.status, 401)
    // with a bearer but no Supabase config on the API: 503, never an unverified fallback
    assert.equal((await statusRoute.GET(req('/status', { headers: authHeaders(OP) }))).status, 503)
  } finally {
    for (const [k, v] of [['AGENT_LIVE_ROUTES', keep.routes], ['AGENT_MAX_MODE', keep.mode], ['AGENT_ENABLED', keep.enabled]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    __resetLiveAgent()
  }
})

// ── 2 actor stamping ────────────────────────────────────────────────────────

test('actor stamping: the verified user id is on the run, on EVERY event and on EVERY finding', async () => {
  const { agent } = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...gateB(), agent }
  const pf = await fullScan(o)
  const st = agent.store.read()
  const run = st.runs.get(pf.run_id)
  assert.deepEqual([run.operator_id, run.actor_user_id, run.operator_verified, run.actor_verified_via], [OP, OP, true, 'supabase_jwt'])
  const events = st.events.filter((e) => e.run_id === pf.run_id)
  assert.ok(events.length > 50)
  for (const e of events) assert.equal(e.actor_user_id, OP, e.type)
  const findings = [...st.findings.values()].filter((f) => f.run_id === pf.run_id)
  assert.ok(findings.length > 10)
  for (const f of findings) assert.equal(f.actor_user_id, OP, f.finding_id)
  // the events route serves the stamp; another operator sees nothing
  const page = await (await R.handleLiveRunEvents(req(`/runs/${pf.run_id}/events?limit=2000`), { ...o, params: { run_id: pf.run_id } })).json()
  assert.ok(page.events.every((e) => e.actor_user_id === OP))
  assert.equal((await R.handleLiveRunEvents(req(`/runs/${pf.run_id}/events`, { headers: authHeaders(OTHER) }), { ...o, params: { run_id: pf.run_id } })).status, 404)
  // no PII entered the store while stamping
  const blob = JSON.stringify([...st.findings.values(), st.events])
  for (const v of [FIXTURE_PII.ownerName, FIXTURE_PII.phoneDigits, FIXTURE_PII.email]) assert.ok(!blob.includes(v))
})

test('actor stamping: no shared or service identity can own a run; the server path requires a verified named user', async () => {
  const runs = createRunService({ store: createInMemoryAgentStore() })
  for (const id of ['principal:ops_dashboard_secret', 'system:cron', 'service_role', 'service:queue', 'anon', 'authenticated', 'ops-dashboard', 'shared:secret']) {
    assert.ok(SHARED_IDENTITY_RE.test(id), id)
    await assert.rejects(runs.createRun({ kind: 'task', operator_id: id }), (e) => e.code === 'OPERATOR_NOT_NAMED', id)
  }
  const me = { verified: true, named: true, user_id: OP, method: 'supabase_jwt' }
  await assert.rejects(runs.createRun({ kind: 'task', operator_id: OTHER, identity: me }), (e) => e.code === 'OPERATOR_IDENTITY_MISMATCH')
  await assert.rejects(runs.createRun({ kind: 'task', operator_id: OP, identity: { ...me, verified: false } }), (e) => e.code === 'OPERATOR_IDENTITY_MISMATCH')
  const strict = createRunService({ store: createInMemoryAgentStore(), requireVerifiedOperator: true })
  await assert.rejects(strict.createRun({ kind: 'task', operator_id: OP }), (e) => e.code === 'IDENTITY_REQUIRED')
  assert.equal((await strict.createRun({ kind: 'task', operator_id: OP, identity: me })).actor_user_id, OP)
  // the live agent the server builds (requireVerifiedOperator) refuses an unverified preflight
  const { agent } = makeAgent()
  await assert.rejects(agent.quickScan.preflight({ operator_id: OP, property_ids: IDS }), (e) => e.code === 'IDENTITY_REQUIRED')
})

// ── 3 read-only gating (registry) ───────────────────────────────────────────

const spec = (over = {}) => ({
  name: 'test.read_thing', version: 1, capability: 1, label: 'Reading a thing', description: 't',
  input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', maxLength: 40 } } },
  output_schema: { type: 'object' }, side_effect: 'read', permission: { min_role: 'operator', apps: ['entity-graph'] },
  cost_class: 'db_light', limits: { rows_to_model: 50, max_rows: 200, timeout_ms: 30_000, per_run: 5 },
  disclosure: { to_model: ['id'], never: ['phone', 'email'] }, wraps: { module: '@/lib/domain/test/fake.js', export: 'readFake' },
  execute: async () => ({ rows: [] }), audit: () => ({ summary: 'r' }), failure: { retry: 'none', surface: 'tool_error' }, ...over,
})
const draft = { side_effect: 'draft', idempotency: () => 'k' }
const t2 = { side_effect: 'reversible_write', idempotency: () => 'k', touches: ['lead_state.temperature'], readback: async () => ({}), undo: { kind: 'inverse', build: () => ({}), window_h: 24 }, intent_family: 'pipeline', action_fields: ['t'], risk_assessment: { consumers: ['x'], undo_restores_all: false, approved_by: 'owner', approved_at: '2026-10-08' } }
const t3 = { side_effect: 'consequential', idempotency: () => 'k', touches: ['campaign_targets'], readback: async () => ({}), approval_class: 'default', effects: () => [], preconditions: async () => ({}) }

test('read-only registry: only small T0 reads can be REGISTERED — drafts, writes, consequential, heavy, large and send/offer/campaign-verb tools are refused', () => {
  const ro = createToolRegistry({ readOnly: true })
  assert.equal(ro.readOnly, true)
  const refused = [
    spec({ name: 'test.draft_note', ...draft }),
    spec({ name: 'pipeline.temperature', ...t2 }),
    spec({ name: 'campaigns.materialize', ...t3 }),
    spec({ name: 'eg.heavy', cost_class: 'db_heavy' }),
    spec({ name: 'eg.paid', cost_class: 'paid_external' }),
    spec({ name: 'eg.wide', limits: { rows_to_model: 50, max_rows: 5000, timeout_ms: 30_000, per_run: 5 } }),
    spec({ name: 'eg.chatty', limits: { rows_to_model: 51, max_rows: 200, timeout_ms: 30_000, per_run: 5 } }),
    spec({ name: 'campaign.launch_preview' }),
    spec({ name: 'inbox.send_preview' }),
    spec({ name: 'deal.offer_range' }),
    spec({ name: 'notes.create' }),
    spec({ name: 'queue.enqueue_check' }),
  ]
  for (const s of refused) assert.throws(() => ro.register(s), (e) => e.code === 'READ_ONLY_REGISTRY' || e.code === 'TOOL_PROHIBITED', s.name)
  assert.equal(ro.list().length, 0)
  ro.register(spec())
  assert.deepEqual(ro.list().map((t) => t.tier), ['T0'])
})

test('read-only authorization: even a tool registered elsewhere is refused (AGENT_READ_ONLY) when the request is read-only', () => {
  const rw = createToolRegistry()
  rw.register(spec({ name: 'test.draft_note', ...draft }))
  rw.register(spec({ name: 'test.read_thing' }))
  const ctx = { mode: 'full', enabled_capabilities: [1], role: 'owner', session_user_id: OP, read_only: true }
  assert.equal(authorizeToolCall({ registry: rw, tool: 'test.draft_note', input: {}, ctx }).code, 'AGENT_READ_ONLY')
  assert.equal(authorizeToolCall({ registry: rw, tool: 'test.read_thing', input: {}, ctx }).decision, 'allow')
  assert.equal(authorizeToolCall({ registry: rw, tool: 'test.draft_note', input: {}, ctx: { ...ctx, read_only: false } }).decision, 'allow')
})

test('the S3 review path: the live registry is read-only, sealed, exactly the 9 Quick Scan T0 reads; the default registry excludes non-small reads', () => {
  const { agent } = makeAgent()
  assert.equal(agent.registry.readOnly, true)
  assert.equal(agent.registry.sealed, true)
  assert.deepEqual(agent.registry.list().map((t) => t.name).sort(), [...QUICK_SCAN_TOOL_NAMES].sort())
  for (const t of agent.registry.list()) assert.equal(readOnlyViolation(t), null, t.name)
  assert.throws(() => agent.registry.register(spec({ name: 'eg.late' })), (e) => e.code === 'REGISTRY_SEALED')
  assert.equal(createQuickScanToolRegistry().readOnly, true)
  const def = createDefaultToolRegistry()
  assert.equal(def.readOnly, true)
  assert.ok(def.list().every((t) => t.tier === 'T0' && readOnlyViolation(t) === null))
  assert.deepEqual(def.excluded.map((x) => `${x.name}: ${x.reason}`), ['eg.property_ids: max_rows 5000 > 200', 'composer.audience_preview: cost_class db_heavy', 'mi.market: cost_class db_heavy'])
  const all = Object.values(ADAPTER_TOOL_SPECS).flat().map((s) => s.name)
  assert.equal(def.list().length + def.excluded.length, all.length)
  // no send / offer / campaign-write / write verb is reachable anywhere in the review path
  for (const t of [...agent.registry.list(), ...def.list()]) assert.ok(!/(send|offer|launch|enqueue|publish|activate|create|update|delete|write)/.test(t.name.split('.').slice(1).join('.')), t.name)
})

test('AGENT_READ_ONLY: on by default; frozen on in production (code ceiling); only non-production may lift it', () => {
  assert.equal(isAgentReadOnly({}), true)
  assert.deepEqual(resolveAgentReadOnly({ AGENT_READ_ONLY: '0' }), { read_only: false, source: 'env' })
  assert.deepEqual(resolveAgentReadOnly({ AGENT_READ_ONLY: '0', NODE_ENV: 'production' }), { read_only: true, source: 'code_ceiling' })
  assert.deepEqual(resolveAgentReadOnly({ AGENT_READ_ONLY: 'false', VERCEL_ENV: 'production' }), { read_only: true, source: 'code_ceiling' })
  assert.equal(isAgentReadOnly({ AGENT_READ_ONLY: 'maybe' }), true)
})

// ── 4 kill switch ───────────────────────────────────────────────────────────

test('kill switch: AGENT_ENABLED default OFF in production, on in dev unless 0; off ⇒ every route 404 with an empty body, even for a verified operator', async () => {
  assert.equal(isAgentEnabled({ NODE_ENV: 'production' }), false)
  assert.equal(isAgentEnabled({ NODE_ENV: 'production', AGENT_ENABLED: 'yes please' }), false)
  assert.equal(isAgentEnabled({ NODE_ENV: 'production', AGENT_ENABLED: '1' }), true)
  assert.equal(isAgentEnabled({}), true)
  assert.equal(isAgentEnabled({ AGENT_ENABLED: '0' }), false)
  assert.equal(isLiveAgentEnabled({ NODE_ENV: 'production', AGENT_LIVE_ROUTES: '1', AGENT_LIVE_PRODUCTION_PILOT: '1', AGENT_STORE: 'postgres' }), false)
  assert.equal(isLiveAgentEnabled({ NODE_ENV: 'production', AGENT_LIVE_ROUTES: '1', AGENT_LIVE_PRODUCTION_PILOT: '1', AGENT_STORE: 'postgres', AGENT_ENABLED: '1' }), true)
  const { agent } = makeAgent()
  const off = { env: { ...ON, AGENT_ENABLED: '0' }, auth: ensureMutationAuth, ...gateB(), agent }
  for (const r of [
    await R.handleLiveStatus(req('/status'), off),
    await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }), off),
    await R.handleLiveRuns(req('/runs'), off),
  ]) {
    assert.equal(r.status, 404)
    assert.equal(await r.text(), '')
  }
  assert.equal(agent.store.read().runs.size, 0)
})

test('kill switch: a scan in flight stops at its next task boundary (system-attributed cancel, $0); recovery never resumes while off', async () => {
  const env = { ...ON }
  const db = multiDb(IDS)
  let reads = 0
  const agent = createLiveAgent({
    env, store: createInMemoryAgentStore(), requireVerifiedOperator: true,
    createServices: () => {
      const svc = createQuickScanServices({ db })
      // the services object is frozen: wrap each function on a plain object
      return Object.fromEntries(Object.entries(svc).map(([k, v]) => [k, typeof v === 'function' ? async (...a) => { reads += 1; if (reads === 2) env.AGENT_ENABLED = '0'; return v(...a) } : v]))
    },
  })
  const o = { env: ON, auth: ensureMutationAuth, ...gateB(), agent }
  const pf = await (await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }), o)).json()
  assert.equal((await R.handleQuickScanConfirm(post('/quick-scan/confirm', { job_id: pf.job_id, scope_hash: pf.scope_hash }), o)).status, 202)
  await agent.quickScan.idle()
  const st = agent.store.read()
  const run = st.runs.get(pf.run_id)
  assert.equal(run.state, 'cancelled')
  assert.equal(run.accrued_usd, 0)
  const ev = st.events.filter((e) => e.run_id === pf.run_id)
  assert.ok(ev.some((e) => e.type === 'job.cancel_requested' && e.payload.requested_by === 'system:kill_switch'))
  assert.ok(ev.every((e) => e.actor_user_id === OP), 'the run stays attributed to its operator')
  const started = ev.filter((e) => e.type === 'task.started').length
  assert.ok(started < IDS.length * QUICK_SCAN_TOOL_NAMES.length, `stopped early (${started} reads started)`)
  // still off: recovery resumes nothing, preflight/confirm refuse
  const rec = await agent.quickScan.recover()
  assert.deepEqual([rec.length, rec.disabled], [0, true])
  await assert.rejects(agent.quickScan.preflight({ operator_id: OP, property_ids: IDS, identity: { verified: true, named: true, user_id: OP } }), (e) => e.code === 'AGENT_DISABLED')
})

// ── 5 spend caps ────────────────────────────────────────────────────────────

test('spend caps: $0 / 0 tokens by default (production included); env is clamped to code ceilings; garbage ⇒ 0', () => {
  const zero = { user_day_usd: 0, global_day_usd: 0, user_day_tokens: 0, global_day_tokens: 0 }
  assert.deepEqual({ ...resolveSpendCaps({}) }, zero)
  assert.deepEqual({ ...resolveSpendCaps({ NODE_ENV: 'production' }) }, zero)
  assert.deepEqual({ ...resolveSpendCaps({ AGENT_SPEND_USER_DAILY_USD: '-5', AGENT_SPEND_GLOBAL_DAILY_USD: 'lots' }) }, zero)
  const big = resolveSpendCaps({ AGENT_SPEND_USER_DAILY_USD: '1000', AGENT_SPEND_GLOBAL_DAILY_USD: '1000', AGENT_TOKENS_USER_DAILY: '1e12', AGENT_TOKENS_GLOBAL_DAILY: '1e12' })
  assert.deepEqual([big.global_day_usd, big.user_day_usd, big.global_day_tokens], [SPEND_HARD_CEILINGS.global_day_usd, SPEND_HARD_CEILINGS.user_day_usd, SPEND_HARD_CEILINGS.global_day_tokens])
  // a user cap can never exceed the global cap
  assert.equal(resolveSpendCaps({ AGENT_SPEND_USER_DAILY_USD: '5', AGENT_SPEND_GLOBAL_DAILY_USD: '2' }).user_day_usd, 2)
  // the proposed ≤ $10 eval allowance is NOT configured anywhere by default
  assert.equal(resolveSpendCaps(process.env).global_day_usd, 0)
})

test('spend guard: structural $0 passes; any billable op needs a verified actor and fits per-user AND global USD + token caps', () => {
  const caps = resolveSpendCaps({ AGENT_SPEND_USER_DAILY_USD: '1', AGENT_SPEND_GLOBAL_DAILY_USD: '1.5', AGENT_TOKENS_USER_DAILY: '1000', AGENT_TOKENS_GLOBAL_DAILY: '1500' })
  const me = { user_id: OP, verified: true }
  const none = { user_usd: 0, global_usd: 0, user_tokens: 0, global_tokens: 0 }
  assert.equal(checkSpend({ caps: resolveSpendCaps({}), actor: null, worst_usd: 0, usage: none }).ok, true)
  assert.equal(checkSpend({ caps, actor: { user_id: OP, verified: false }, worst_usd: 0.1, usage: none }).code, 'SPEND_ACTOR_REQUIRED')
  assert.equal(checkSpend({ caps: resolveSpendCaps({}), actor: me, worst_usd: 0.000001, usage: none }).code, 'SPEND_CAP_USER_DAY')
  assert.equal(checkSpend({ caps, actor: me, worst_usd: 0.5, usage: { ...none, user_usd: 0.6 } }).code, 'SPEND_CAP_USER_DAY')
  assert.equal(checkSpend({ caps, actor: me, worst_usd: 0.5, usage: { ...none, user_usd: 0.2, global_usd: 1.2 } }).code, 'SPEND_CAP_GLOBAL_DAY')
  assert.equal(checkSpend({ caps, actor: me, worst_usd: 0.01, worst_tokens: 600, usage: { ...none, user_tokens: 500 } }).code, 'TOKEN_CAP_USER_DAY')
  assert.equal(checkSpend({ caps, actor: me, worst_usd: 0.01, worst_tokens: 400, usage: { ...none, user_tokens: 100, global_tokens: 1200 } }).code, 'TOKEN_CAP_GLOBAL_DAY')
  assert.equal(checkSpend({ caps, actor: me, worst_usd: 0.5, worst_tokens: 500, usage: none }).ok, true)
})

test('spend guard in the ledger: default caps refuse every billable reserve (budget.stopped); per-user cap binds one user, global binds all', async () => {
  const haiku = { op_type: 'model', provider: 'anthropic', model: 'claude-haiku-4-5', max_input_tokens: 40_000, max_tokens: 2_000 } // $0.05
  const me = (user_id) => ({ verified: true, named: true, user_id, method: 'supabase_jwt' })
  {
    const store = createInMemoryAgentStore()
    const runs = createRunService({ store, activeRunLimit: 100 })
    const ledger = createBudgetLedger({ store }) // env caps: $0
    const r = await runs.createRun({ kind: 'task', operator_id: OP, identity: me(OP) })
    const out = await ledger.reserve({ run_id: r.id, op: haiku, route: 'agent.turn' })
    assert.deepEqual([out.ok, out.code], [false, 'SPEND_CAP_USER_DAY'])
    assert.equal(store.read().ledger.length, 0, 'nothing reserved')
    assert.ok(store.read().events.some((e) => e.type === 'budget.stopped' && e.payload.binding_cap === 'user_day_usd'))
    const anon = await runs.createRun({ kind: 'task', operator_id: 'op_unverified' })
    assert.equal((await ledger.reserve({ run_id: anon.id, op: haiku, route: 'agent.turn' })).code, 'SPEND_ACTOR_REQUIRED')
  }
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store, activeRunLimit: 100 })
  const ledger = createBudgetLedger({ store, spendCaps: resolveSpendCaps({ AGENT_SPEND_USER_DAILY_USD: '0.1', AGENT_SPEND_GLOBAL_DAILY_USD: '0.15', AGENT_TOKENS_USER_DAILY: '1000000', AGENT_TOKENS_GLOBAL_DAILY: '1000000' }) })
  const a = await runs.createRun({ kind: 'task', operator_id: OP, identity: me(OP) })
  const b = await runs.createRun({ kind: 'task', operator_id: OTHER, identity: me(OTHER) })
  assert.equal((await ledger.reserve({ run_id: a.id, op: haiku, route: 'agent.turn' })).ok, true)
  assert.equal((await ledger.reserve({ run_id: a.id, op: haiku, route: 'agent.turn' })).ok, true)
  assert.equal((await ledger.reserve({ run_id: a.id, op: haiku, route: 'agent.turn' })).code, 'SPEND_CAP_USER_DAY')
  assert.equal((await ledger.reserve({ run_id: b.id, op: haiku, route: 'agent.turn' })).ok, true, 'another user still has room')
  assert.equal((await ledger.reserve({ run_id: b.id, op: haiku, route: 'agent.turn' })).code, 'SPEND_CAP_GLOBAL_DAY')
  const u = spendUsage(store.read().ledger, { user_id: OP, day: new Date().toISOString().slice(0, 10) })
  assert.deepEqual([u.user_usd, u.global_usd], [0.1, 0.15])
  // an injected cap above the code ceiling is clamped ($50/day): org caps lifted in config, the guard still binds at $50
  const s2 = createInMemoryAgentStore()
  const base = createBudgetLedger({ store: s2 }).config
  const cfg = { ...base, org: { per_day_usd: 1e9, per_month_usd: 1e9 }, research: { ...base.research, per_batch_usd: 1e9 } }
  const r2 = createRunService({ store: s2, activeRunLimit: 1000, budgetConfig: cfg })
  const huge = createBudgetLedger({ store: s2, config: cfg, spendCaps: { user_day_usd: 1e9, global_day_usd: 1e9, user_day_tokens: 1e15, global_day_tokens: 1e15 } })
  const big = { op_type: 'model', provider: 'anthropic', model: 'claude-haiku-4-5', max_input_tokens: 300_000, max_tokens: 340_000 } // $2
  const rr = await r2.createRun({ kind: 'research', depth: 'diligence', property_count: 50, operator_id: OP, identity: me(OP) })
  let ok = 0
  let last
  for (let i = 0; i < 40 && (!last || last.ok); i += 1) {
    last = await huge.reserve({ run_id: rr.id, property_id: `p${i}`, op: big, route: 'x' })
    if (last.ok) ok += 1
  }
  assert.equal(ok, 25, '25 × $2 = the $50 code ceiling')
  assert.equal(last.code, 'SPEND_CAP_USER_DAY')
})

test('spend guard at the route: Quick Scan ($0) runs with every cap at 0; a job that would cost money is refused 423 before anything runs', async () => {
  const { agent, db } = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...gateB(), agent }
  const pf = await (await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS.slice(0, 1) }), o)).json()
  assert.deepEqual([pf.spend_guard.this_job_usd, pf.spend_guard.structural_zero, pf.spend_guard.user_day_usd, pf.spend_guard.global_day_usd], [0, true, 0, 0])
  // simulate a paid job draft (cannot be produced by S3 code: quick is $0 by structure)
  agent.store.read().researchJobs.get(pf.job_id).budget_cap_usd = 0.75
  const c = await R.handleQuickScanConfirm(post('/quick-scan/confirm', { job_id: pf.job_id, scope_hash: pf.scope_hash }), o)
  assert.equal(c.status, 423)
  assert.equal((await c.json()).error, 'SPEND_CAP_USER_DAY')
  assert.equal(db.calls.length, 0, 'no read ran')
})

// ── 6 rate limits ───────────────────────────────────────────────────────────

test('rate limits: per verified user (not per header / IP); 429 with Retry-After; one user hitting the limit never blocks another', async () => {
  const { agent } = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...gateB({ limits: { mutation_per_min: 2, read_per_min: 3, daily_runs: 100 } }), agent }
  for (let i = 0; i < 2; i += 1) assert.equal((await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }), o)).status, 200)
  const limited = await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }), o)
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
  assert.equal((await limited.json()).error, 'RATE_LIMITED')
  assert.equal((await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }, authHeaders(OTHER)), o)).status, 200)
  for (let i = 0; i < 3; i += 1) assert.equal((await R.handleLiveRuns(req('/runs'), o)).status, 200)
  assert.equal((await R.handleLiveRuns(req('/runs'), o)).status, 429)
  // a refused (unauthenticated) request never consumes the user's budget
  const lim = createUserRateLimiter({ limits: { mutation_per_min: 1, read_per_min: 1, daily_runs: 1 }, now: () => 0 })
  assert.equal(lim.check(OP, 'read').ok, true)
  assert.equal(lim.check(OP, 'read').ok, false)
  assert.equal(lim.check(OP, 'mutation').ok, true, 'buckets are separate')
})

test('rate limits: durable per-user daily run cap (from the store); env bounded by code maxima', async () => {
  const { agent } = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...gateB({ limits: { mutation_per_min: 100, read_per_min: 100, daily_runs: 2 } }), agent }
  for (let i = 0; i < 2; i += 1) assert.equal((await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }), o)).status, 200)
  const capped = await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }), o)
  assert.equal(capped.status, 429)
  assert.equal((await capped.json()).error, 'DAILY_RUN_CAP')
  assert.equal((await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS }, authHeaders(OTHER)), o)).status, 200)
  assert.deepEqual({ ...resolveRateLimits({}) }, { mutation_per_min: 6, read_per_min: 240, daily_runs: 20 })
  const hi = resolveRateLimits({ AGENT_RATE_MUTATIONS_PER_MIN: '9999', AGENT_RATE_READS_PER_MIN: '9999', AGENT_USER_DAILY_RUNS: '9999' })
  assert.deepEqual({ ...hi }, { ...RATE_LIMIT_MAX })
  assert.equal(resolveRateLimits({ AGENT_RATE_MUTATIONS_PER_MIN: 'x' }).mutation_per_min, 6)
})

// ── 7 the provider key never reaches the browser ────────────────────────────

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(m?[jt]sx?|css|html|json)$/.test(f)) out.push(p)
  }
  return out
}

test('secrets: no provider or service key name/value pattern anywhere in the dashboard source; lib/agent never reads ANTHROPIC_API_KEY', () => {
  const dash = walk(join(REPO, 'apps/dashboard/src'))
  assert.ok(dash.length > 100)
  const bad = /ANTHROPIC_API_KEY|VITE_[A-Z_]*ANTHROPIC|sk-ant-[A-Za-z0-9]|SUPABASE_SERVICE_ROLE|AGENT_DATABASE_URL|AGENT_SUPABASE_JWT_SECRET/
  const hits = dash.filter((f) => bad.test(readFileSync(f, 'utf8')))
  assert.deepEqual(hits.map((f) => f.replace(REPO, '')), [])
  const agentLib = walk(fileURLToPath(new URL('../../src/lib/agent/', import.meta.url)))
  for (const f of agentLib) assert.ok(!/ANTHROPIC_API_KEY|sk-ant-/.test(readFileSync(f, 'utf8')), f)
})

test('secrets: agent responses never echo server secrets, tokens or the DB URL', async () => {
  const env = { ...ON, SUPABASE_SERVICE_ROLE_KEY: 'svc-secret-value-xyz', ANTHROPIC_API_KEY: 'sk-ant-secret-value-xyz', AGENT_DATABASE_URL: 'postgresql://agent_api:pw-secret-xyz@h/db' }
  const { agent } = makeAgent(env)
  const o = { env, auth: ensureMutationAuth, ...gateB(), agent }
  const tok = makeToken(OP)
  const H = { 'x-ops-dashboard-secret': 'test', authorization: `Bearer ${tok}` }
  const pf = await (await R.handleQuickScanPreflight(post('/quick-scan/preflight', { property_ids: IDS.slice(0, 1) }, H), o)).text()
  const st = await (await R.handleLiveStatus(req('/status', { headers: H }), o)).text()
  const denied = await (await R.handleLiveStatus(req('/status', { headers: authHeaders(OUTSIDER) }), o)).text()
  for (const body of [pf, st, denied]) {
    for (const s of ['svc-secret-value-xyz', 'sk-ant-secret-value-xyz', 'pw-secret-xyz', tok, 'x-ops-dashboard-secret']) assert.ok(!body.includes(s), s)
  }
  assert.equal(JSON.parse(st).identity.method, 'supabase_jwt')
  assert.equal(JSON.parse(st).read_only, true)
})

// ── Postgres: the DB enforces the actor stamp ───────────────────────────────

const PG = pgAvailable()

test('PG: every persisted event and finding carries the run operator; the DB refuses a mismatched stamp and a shared-identity run', { skip: PG ? false : skipReason }, async () => {
  const d = await freshDb()
  try {
    const store = createPgAgentStore({ pool: d.api })
    await store.open()
    const db = multiDb(IDS)
    const agent = createLiveAgent({ env: ON, store, createServices: () => createQuickScanServices({ db }), requireVerifiedOperator: true })
    const o = { env: ON, auth: ensureMutationAuth, ...gateB(), agent }
    const pf = await fullScan(o, IDS.slice(0, 1))
    const q = async (sql, args = []) => (await d.pool.query(sql, args)).rows
    assert.deepEqual(await q('select operator_id from agent.run where run_id = $1', [pf.run_id]), [{ operator_id: OP }])
    const ev = await q('select count(*)::int n, count(*) filter (where actor_user_id = $2)::int stamped from agent.run_event where run_id = $1', [pf.run_id, OP])
    assert.ok(ev[0].n > 20)
    assert.equal(ev[0].stamped, ev[0].n)
    const fi = await q('select count(*)::int n, count(*) filter (where actor_user_id = $2)::int stamped from agent.finding where run_id = $1', [pf.run_id, OP])
    assert.ok(fi[0].n > 5)
    assert.equal(fi[0].stamped, fi[0].n)
    // the API role cannot write a mismatched stamp
    const head = Number((await q('select event_id from agent.store_head'))[0].event_id)
    const seq = (await q('select max(seq)+1 s from agent.run_event where run_id = $1', [pf.run_id]))[0].s
    await assert.rejects(d.api.query("insert into agent.run_event (event_id, run_id, org_id, seq, type, at, actor_user_id, payload) values ($1, $2, $3, $4, 'decision', now(), $5, '{}')", [head + 1, pf.run_id, DEFAULT_ORG_ID, seq, OTHER]), /actor mismatch/)
    await assert.rejects(d.api.query('update agent.finding set actor_user_id = $2 where run_id = $1', [pf.run_id, OTHER]), /actor mismatch/)
    for (const bad of ['principal:ops_dashboard_secret', 'system:cron', 'service_role']) {
      await assert.rejects(d.pool.query("update agent.run set operator_id = $2 where run_id = $1", [pf.run_id, bad]), (e) => e.code === '23514' && /run_operator_named/.test(e.constraint || e.message), bad)
    }
  } finally {
    await d.drop()
  }
})
