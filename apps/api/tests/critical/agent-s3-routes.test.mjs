// Agent S3 — live cockpit routes: 404 unless AGENT_LIVE_ROUTES=1 and not
// production (before auth, before anything); auth + operator session
// required; preflight → confirm (exact scope hash) → events (cursor) →
// snapshot → cancel → history. Fixture routes are untouched.
import test from 'node:test'
import assert from 'node:assert/strict'

import { multiDb } from '../helpers/agent-s3-fake-db.mjs'
import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createLiveAgent, isLiveAgentEnabled, liveStoreKind, agentPgPoolConfig, __resetLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'
import * as R from '../../src/lib/agent/live/live-routes.js'
import { ensureMutationAuth } from '../../src/app/api/cockpit/_shared.js'
import { OP, OTHER, authHeaders, gateB } from '../helpers/agent-test-identity.mjs'
import * as probeRoute from '../../src/app/api/cockpit/agent/live/route.js'
import * as statusRoute from '../../src/app/api/cockpit/agent/live/status/route.js'
import * as preflightRoute from '../../src/app/api/cockpit/agent/live/quick-scan/preflight/route.js'
import * as confirmRoute from '../../src/app/api/cockpit/agent/live/quick-scan/confirm/route.js'
import * as runsRoute from '../../src/app/api/cockpit/agent/live/runs/route.js'
import * as runRoute from '../../src/app/api/cockpit/agent/live/runs/[run_id]/route.js'
import * as eventsRoute from '../../src/app/api/cockpit/agent/live/runs/[run_id]/events/route.js'
import * as cancelRoute from '../../src/app/api/cockpit/agent/live/runs/[run_id]/cancel/route.js'

const BASE = 'http://localhost:3000/api/cockpit/agent/live'
// Gate B: the Worker forwards the shared secret + the user's own Supabase session token
const AUTH = authHeaders(OP)
const GB = gateB()
const req = (p, { method = 'GET', headers = AUTH, body } = {}) => new Request(`${BASE}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
const ON = { AGENT_LIVE_ROUTES: '1', AGENT_MAX_MODE: 'read', NODE_ENV: 'development' }
const PROD_ON = { AGENT_ENABLED: '1' } // Gate B kill switch: production needs it explicitly

function makeAgent() {
  const db = multiDb(['9000000001', '9000000002'])
  return createLiveAgent({ env: ON, store: createInMemoryAgentStore(), createServices: () => createQuickScanServices({ db }) })
}

test('gate: off by default, off in production even with the flag, on only with AGENT_LIVE_ROUTES=1', () => {
  assert.equal(isLiveAgentEnabled({}), false)
  assert.equal(isLiveAgentEnabled({ AGENT_LIVE_ROUTES: 'true' }), false)
  assert.equal(isLiveAgentEnabled({ AGENT_LIVE_ROUTES: '1', NODE_ENV: 'production' }), false)
  assert.equal(isLiveAgentEnabled({ AGENT_LIVE_ROUTES: '1', VERCEL_ENV: 'production' }), false)
  assert.equal(isLiveAgentEnabled({ AGENT_LIVE_ROUTES: '1', NODE_ENV: 'development' }), true)
})

test('feature-flag matrix: production needs AGENT_LIVE_ROUTES=1 + AGENT_LIVE_PRODUCTION_PILOT=1 + AGENT_STORE=postgres — every other combination is off', () => {
  const P = { NODE_ENV: 'production' }
  const combos = []
  for (const routes of [undefined, '1']) for (const pilot of [undefined, '1']) for (const store of [undefined, 'file', 'postgres']) combos.push({ AGENT_LIVE_ROUTES: routes, AGENT_LIVE_PRODUCTION_PILOT: pilot, AGENT_STORE: store })
  for (const c of combos) {
    const want = c.AGENT_LIVE_ROUTES === '1' && c.AGENT_LIVE_PRODUCTION_PILOT === '1' && c.AGENT_STORE === 'postgres'
    assert.equal(isLiveAgentEnabled({ ...P, ...PROD_ON, ...c }), want, JSON.stringify(c))
    assert.equal(isLiveAgentEnabled({ VERCEL_ENV: 'production', ...PROD_ON, ...c }), want, JSON.stringify(c))
    // Gate B: without AGENT_ENABLED (default OFF in production) every combination is off
    assert.equal(isLiveAgentEnabled({ ...P, ...c }), false, JSON.stringify(c))
  }
  // non-production: the pilot flag is irrelevant; the store defaults to the local file store
  assert.equal(isLiveAgentEnabled({ AGENT_LIVE_ROUTES: '1', AGENT_LIVE_PRODUCTION_PILOT: '0' }), true)
  assert.equal(liveStoreKind({}), 'file')
  assert.equal(liveStoreKind({ AGENT_STORE: 'postgres' }), 'postgres')
  assert.equal(liveStoreKind({ AGENT_STORE: 'memory' }), 'file')
})

test('every route module 404s (empty body) when the flag is off — even with valid auth', async () => {
  const prev = process.env.AGENT_LIVE_ROUTES
  delete process.env.AGENT_LIVE_ROUTES
  __resetLiveAgent()
  try {
    const ctx = { params: Promise.resolve({ run_id: 'run_x' }) }
    const responses = [
      await probeRoute.GET(req('')),
      await statusRoute.GET(req('/status')),
      await preflightRoute.POST(req('/quick-scan/preflight', { method: 'POST', body: { property_ids: ['1'] } })),
      await confirmRoute.POST(req('/quick-scan/confirm', { method: 'POST', body: { job_id: 'j', scope_hash: 'h' } })),
      await runsRoute.GET(req('/runs')),
      await runRoute.GET(req('/runs/run_x'), ctx),
      await eventsRoute.GET(req('/runs/run_x/events'), ctx),
      await cancelRoute.POST(req('/runs/run_x/cancel', { method: 'POST' }), ctx),
    ]
    for (const r of responses) {
      assert.equal(r.status, 404)
      assert.equal(await r.text(), '')
    }
  } finally {
    if (prev === undefined) delete process.env.AGENT_LIVE_ROUTES
    else process.env.AGENT_LIVE_ROUTES = prev
  }
})

test('production: 404 even with the flag set and an injected agent', async () => {
  const agent = makeAgent()
  for (const env of [{ ...ON, NODE_ENV: 'production' }, { ...ON, VERCEL_ENV: 'production' }]) {
    const r = await R.handleQuickScanPreflight(req('/quick-scan/preflight', { method: 'POST', body: { property_ids: ['9000000001'] } }), { env, auth: ensureMutationAuth, ...GB, agent })
    assert.equal(r.status, 404)
  }
})

test('flag on: auth required (no secret → 401); operator session required for writes to the local store', async () => {
  const agent = makeAgent()
  const noAuth = await R.handleLiveStatus(req('/status', { headers: {} }), { env: ON, auth: ensureMutationAuth, ...GB, agent })
  assert.equal(noAuth.status, 401)
  const noUser = await R.handleQuickScanPreflight(req('/quick-scan/preflight', { method: 'POST', headers: { 'x-ops-dashboard-secret': 'test', 'x-ops-user-id': OP }, body: { property_ids: ['9000000001'] } }), { env: ON, auth: ensureMutationAuth, ...GB, agent })
  assert.equal(noUser.status, 401)
  assert.equal((await noUser.json()).error, 'SESSION_REQUIRED')
  const st = await R.handleLiveStatus(req('/status'), { env: ON, auth: ensureMutationAuth, ...GB, agent })
  const body = await st.json()
  assert.deepEqual([st.status, body.live, body.fixture, body.ai_enabled, body.mode, body.tools.length], [200, true, false, false, 'read', 9])
})

test('preflight → confirm (wrong hash 409, right hash 202) → long-poll events by cursor → snapshot → history', async () => {
  const agent = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...GB, agent }
  const pf = await (await R.handleQuickScanPreflight(req('/quick-scan/preflight', { method: 'POST', body: { property_ids: ['9000000001', '9000000002'] } }), o)).json()
  assert.equal(pf.ok, true)
  const bad = await R.handleQuickScanConfirm(req('/quick-scan/confirm', { method: 'POST', body: { job_id: pf.job_id, scope_hash: '0'.repeat(64) } }), o)
  assert.equal(bad.status, 409)
  assert.equal((await bad.json()).error, 'JOB_SCOPE_CHANGED')
  const missing = await R.handleQuickScanConfirm(req('/quick-scan/confirm', { method: 'POST', body: { job_id: pf.job_id } }), o)
  assert.equal(missing.status, 422)
  const ok = await R.handleQuickScanConfirm(req('/quick-scan/confirm', { method: 'POST', body: { job_id: pf.job_id, scope_hash: pf.scope_hash } }), o)
  assert.equal(ok.status, 202)
  const run_id = (await ok.json()).run_id
  // stream by cursor until done
  let cursor = 0
  const seen = []
  for (let i = 0; i < 50; i += 1) {
    const page = await (await R.handleLiveRunEvents(req(`/runs/${run_id}/events?after=${cursor}&timeout_ms=500&limit=25`), { ...o, params: { run_id } })).json()
    seen.push(...page.events)
    cursor = page.cursor
    if (page.done) break
  }
  assert.ok(seen.length > 50)
  seen.forEach((e, i) => assert.equal(e.seq, i + 1))
  assert.equal(new Set(seen.map((e) => e.event_id)).size, seen.length)
  // Last-Event-ID header resumes the same cursor
  const resumed = await (await R.handleLiveRunEvents(req(`/runs/${run_id}/events`, { headers: { ...AUTH, 'last-event-id': String(seen[9].event_id) } }), { ...o, params: { run_id } })).json()
  assert.equal(resumed.events[0].event_id, seen[10].event_id)
  const sse = await R.handleLiveRunEvents(req(`/runs/${run_id}/events?format=sse&limit=3`), { ...o, params: { run_id } })
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  assert.equal(((await sse.text()).match(/^id: /gm) || []).length, 3)
  const snap = await (await R.handleLiveRunSnapshot(req(`/runs/${run_id}`), { ...o, params: { run_id } })).json()
  assert.deepEqual([snap.ok, snap.live, snap.fixture, snap.state, snap.last_event_id], [true, true, false, 'completed', seen[seen.length - 1].event_id])
  const hist = await (await R.handleLiveRuns(req('/runs'), o)).json()
  assert.equal(hist.runs[0].run_id, run_id)
  const nf = await R.handleLiveRunSnapshot(req('/runs/nope'), { ...o, params: { run_id: 'nope' } })
  assert.equal(nf.status, 404)
})

test('cancel route: draft scan cancels immediately ($0, no reads)', async () => {
  const agent = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...GB, agent }
  const pf = await (await R.handleQuickScanPreflight(req('/quick-scan/preflight', { method: 'POST', body: { property_ids: ['9000000001'] } }), o)).json()
  const r = await R.handleLiveRunCancel(req(`/runs/${pf.run_id}/cancel`, { method: 'POST' }), { ...o, params: { run_id: pf.run_id } })
  assert.equal(r.status, 202)
  assert.equal(agent.store.read().runs.get(pf.run_id).state, 'cancelled')
})

test('mode off: preflight reports the blocker; confirm answers 423 and nothing runs', async () => {
  const db = multiDb(['9000000001'])
  const agent = createLiveAgent({ env: { ...ON, AGENT_MAX_MODE: 'off' }, store: createInMemoryAgentStore(), createServices: () => createQuickScanServices({ db }) })
  const o = { env: ON, auth: ensureMutationAuth, ...GB, agent }
  const pf = await (await R.handleQuickScanPreflight(req('/quick-scan/preflight', { method: 'POST', body: { property_ids: ['9000000001'] } }), o)).json()
  assert.equal(pf.can_run, false)
  const c = await R.handleQuickScanConfirm(req('/quick-scan/confirm', { method: 'POST', body: { job_id: pf.job_id, scope_hash: pf.scope_hash } }), o)
  assert.equal(c.status, 423)
  assert.equal(db.calls.length, 0)
})

test('L5: run-scoped routes answer only the operator who started the run (404 otherwise); history is per operator', async () => {
  const agent = makeAgent()
  const o = { env: ON, auth: ensureMutationAuth, ...GB, agent }
  const pf = await (await R.handleQuickScanPreflight(req('/quick-scan/preflight', { method: 'POST', body: { property_ids: ['9000000001'] } }), o)).json()
  const other = authHeaders(OTHER)
  for (const r of [
    await R.handleLiveRunSnapshot(req(`/runs/${pf.run_id}`, { headers: other }), { ...o, params: { run_id: pf.run_id } }),
    await R.handleLiveRunEvents(req(`/runs/${pf.run_id}/events`, { headers: other }), { ...o, params: { run_id: pf.run_id } }),
    await R.handleLiveRunCancel(req(`/runs/${pf.run_id}/cancel`, { method: 'POST', headers: other }), { ...o, params: { run_id: pf.run_id } }),
  ]) assert.equal(r.status, 404)
  assert.equal(agent.store.read().runs.get(pf.run_id).cancel_requested_at, null, 'another operator cannot cancel')
  assert.deepEqual((await (await R.handleLiveRuns(req('/runs', { headers: other }), o)).json()).runs, [])
  assert.equal((await (await R.handleLiveRuns(req('/runs'), o)).json()).runs.length, 1)
  assert.equal((await R.handleQuickScanConfirm(req('/quick-scan/confirm', { method: 'POST', headers: other, body: { job_id: pf.job_id, scope_hash: pf.scope_hash } }), o)).status, 403)
})

test('M3: agent DB pool — production requires AGENT_DATABASE_URL (no fallback), a least-privilege role, a verified CA; loopback TLS-off only by parsed hostname', () => {
  const P = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres' }
  assert.throws(() => agentPgPoolConfig(P), /AGENT_DATABASE_URL_REQUIRED/)
  assert.throws(() => agentPgPoolConfig({ ...P, AGENT_DATABASE_URL: 'postgresql://postgres.ref:pw@pooler.example.com:6543/postgres', AGENT_DATABASE_CA_PEM: 'CA' }), /LEAST_PRIVILEGE/)
  assert.throws(() => agentPgPoolConfig({ ...P, AGENT_DATABASE_URL: 'postgresql://agent_api.ref:pw@pooler.example.com:6543/postgres' }), /AGENT_DATABASE_CA_REQUIRED/)
  assert.throws(() => agentPgPoolConfig({ ...P, AGENT_DATABASE_URL: 'postgresql://agent_api:pw@localhost:5432/postgres', AGENT_DATABASE_CA_PEM: 'CA' }), /LOOPBACK/)
  const ok = agentPgPoolConfig({ ...P, AGENT_DATABASE_URL: 'postgresql://agent_api.ref:pw@pooler.example.com:6543/postgres?sslmode=no-verify&sslrootcert=x', AGENT_DATABASE_CA_PEM: '-----BEGIN CERTIFICATE-----' })
  assert.deepEqual([ok.ssl.rejectUnauthorized, ok.ssl.ca.startsWith('-----BEGIN'), ok.ssl.servername], [true, true, 'pooler.example.com'])
  assert.ok(!/sslmode|sslrootcert/.test(ok.connectionString), 'ssl query params can never downgrade verification')
  // "localhost" appearing elsewhere in the URL no longer disables TLS
  const dev = agentPgPoolConfig({ AGENT_DATABASE_URL: 'postgresql://u:localhost@db.example.com:5432/postgres?application_name=localhost' })
  assert.equal(dev.ssl.rejectUnauthorized, true)
  assert.equal(agentPgPoolConfig({ AGENT_DATABASE_URL: 'postgresql://u@127.0.0.1:55417/x' }).ssl, false)
  assert.equal(agentPgPoolConfig({ AGENT_DATABASE_URL: 'postgresql://u@localhost:55417/x' }).ssl, false)
  assert.throws(() => agentPgPoolConfig({ AGENT_DATABASE_URL: 'https://example.com/x' }), /INVALID/)
  for (const q of ['host=evil.example', 'hostaddr=10.0.0.1', 'HOST=/tmp']) {
    assert.throws(() => agentPgPoolConfig({ ...P, AGENT_DATABASE_URL: `postgresql://agent_api.ref:pw@pooler.example.com:6543/postgres?${q}`, AGENT_DATABASE_CA_PEM: 'CA' }), /HOST_OVERRIDE/)
    assert.throws(() => agentPgPoolConfig({ AGENT_DATABASE_URL: `postgresql://u@127.0.0.1:5432/x?${q}` }), /HOST_OVERRIDE/)
  }
})
