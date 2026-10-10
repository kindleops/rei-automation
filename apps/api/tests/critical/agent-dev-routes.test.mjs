// Agent S1 — dev fixture routes: 404 in production, fixture:true everywhere, cursor contract.
import test from 'node:test'
import assert from 'node:assert/strict'

import { handleFixtureIndex, handleFixtureScenario } from '../../src/lib/agent/dev/fixture-routes.js'
import * as indexRoute from '../../src/app/api/cockpit/agent/dev/fixtures/route.js'
import * as scenarioRoute from '../../src/app/api/cockpit/agent/dev/fixtures/[scenario]/route.js'

const BASE = 'http://localhost:3000/api/cockpit/agent/dev/fixtures'
const req = (path = '', headers = {}) => new Request(`${BASE}${path}`, { headers })

test('production → 404 for index and scenarios (NODE_ENV or VERCEL_ENV), even with the internal secret', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development', VERCEL_ENV: 'production' }]) {
    const a = await handleFixtureIndex(req('', { 'x-internal-api-secret': 'test' }), { env })
    assert.equal(a.status, 404)
    assert.equal(await a.text(), '')
    const b = await handleFixtureScenario(req('/single-deep'), { env, params: { scenario: 'single-deep' } })
    assert.equal(b.status, 404)
    const c = await handleFixtureScenario(req('/single-deep?format=sse'), { env, params: { scenario: 'single-deep' } })
    assert.equal(c.status, 404)
  }
})

test('route modules 404 when the process runs in production', async () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.equal((await indexRoute.GET(req())).status, 404)
    assert.equal((await scenarioRoute.GET(req('/batch-25'), { params: { scenario: 'batch-25' } })).status, 404)
  } finally {
    process.env.NODE_ENV = prev
  }
})

test('dev: index lists the 8 scenarios, labelled fixture', async () => {
  const res = await indexRoute.GET(req())
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-agent-fixture'), 'true')
  const body = await res.json()
  assert.equal(body.fixture, true)
  assert.equal(body.scenarios.length, 8)
  assert.ok(body.scenarios.every((s) => s.fixture === true))
})

test('dev: cursor paging (after / Last-Event-ID), run filter, done flag; every event fixture:true', async () => {
  const p1 = await (await scenarioRoute.GET(req('/campaign-handoff?limit=10'), { params: { scenario: 'campaign-handoff' } })).json()
  assert.equal(p1.fixture, true)
  assert.equal(p1.events.length, 10)
  assert.ok(p1.events.every((e) => e.fixture === true))
  assert.equal(p1.done, false)
  const p2 = await (await scenarioRoute.GET(req(`/campaign-handoff?limit=2000`, { 'last-event-id': String(p1.cursor) }), { params: { scenario: 'campaign-handoff' } })).json()
  assert.equal(p2.events[0].event_id, p1.cursor + 1)
  assert.equal(p2.done, true)
  const only = await (await scenarioRoute.GET(req('/campaign-handoff?run_id=fx-run-handoff-task&limit=2000'), { params: { scenario: 'campaign-handoff' } })).json()
  assert.ok(only.events.length > 0 && only.events.every((e) => e.run_id === 'fx-run-handoff-task'))
  const drained = await (await scenarioRoute.GET(req(`/campaign-handoff?after=${p2.cursor}`), { params: { scenario: 'campaign-handoff' } })).json()
  assert.deepEqual([drained.events.length, drained.cursor, drained.done], [0, p2.cursor, true])
})

test('dev: SSE format, snapshot and full scenario views', async () => {
  const sse = await scenarioRoute.GET(req('/single-deep?format=sse&limit=3'), { params: { scenario: 'single-deep' } })
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  const text = await sse.text()
  assert.equal((text.match(/^id: /gm) || []).length, 3)
  const snap = await (await scenarioRoute.GET(req('/resume-reload?view=snapshot&after=100'), { params: { scenario: 'resume-reload' } })).json()
  assert.equal(snap.cursor, 100)
  assert.equal(snap.runs['fx-run-resume'].last_event_id, 100)
  assert.equal(snap.runs['fx-run-resume'].fixture, true)
  const full = await (await scenarioRoute.GET(req('/ultrawide?view=scenario'), { params: { scenario: 'ultrawide' } })).json()
  assert.equal(full.fixture, true)
  assert.ok(full.sources.every((s) => s.test_data === true))
})

test('dev: unknown scenario → 404 JSON (still fixture-labelled)', async () => {
  const res = await scenarioRoute.GET(req('/nope'), { params: { scenario: 'nope' } })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).fixture, true)
})
