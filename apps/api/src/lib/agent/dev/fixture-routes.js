// Dev-only fixture transport for the S2 prototype (DR §11). Serves the
// deterministic fixture event logs with the production cursor contract:
//   GET …/agent/dev/fixtures                      → scenario index
//   GET …/agent/dev/fixtures/:scenario            → EventPage (long-poll shape)
//        ?after=<event_id> | Last-Event-ID header  replay cursor (exclusive)
//        ?run_id=<id>                              one run of a multi-run scenario
//        ?limit=<n>                                page size (≤ 2000)
//        ?format=sse                               text/event-stream (id = event_id)
//        ?view=scenario                            full scenario (sources, resume, presentation)
//        ?view=snapshot                            reduced snapshot at the cursor
// PRODUCTION: always 404 (dev/force-send pattern: NODE_ENV or VERCEL_ENV =
// production → 404 before anything else runs). Every payload is fixture:true.
import { isProductionRuntime } from '../config/agent-config.js'
import { reduceEvents } from '../contracts/reducer.js'
import { FIXTURE_SCENARIO_IDS, generateFixtureScenario, listFixtureScenarios } from '../contracts/fixtures/scenarios.js'
import { toSse } from '../runtime/event-log.js'

const cache = new Map()
function scenario(id) {
  if (!cache.has(id)) cache.set(id, generateFixtureScenario(id))
  return cache.get(id)
}

function notFound() {
  return new Response(null, { status: 404 })
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-agent-fixture': 'true', ...headers } })
}

export async function handleFixtureIndex(request, { env = process.env, guard = null, headers = {} } = {}) {
  if (isProductionRuntime(env)) return notFound()
  const denied = guard ? guard(request) : null
  if (denied) return denied
  return json({ ok: true, fixture: true, notice: 'FIXTURE — fictional test data for design review.', scenarios: listFixtureScenarios() }, 200, headers)
}

export async function handleFixtureScenario(request, { params = {}, env = process.env, guard = null, headers = {} } = {}) {
  if (isProductionRuntime(env)) return notFound()
  const denied = guard ? guard(request) : null
  if (denied) return denied
  const id = String(params.scenario || '')
  if (!FIXTURE_SCENARIO_IDS.includes(id)) return json({ ok: false, error: 'unknown_scenario', fixture: true, scenarios: FIXTURE_SCENARIO_IDS }, 404, headers)
  const s = scenario(id)
  const url = new URL(request.url)
  const view = url.searchParams.get('view')
  if (view === 'scenario') return json({ ok: true, ...s }, 200, headers)
  const headerCursor = request.headers?.get?.('last-event-id')
  const after = Number(url.searchParams.get('after') ?? headerCursor ?? 0) || 0
  const run_id = url.searchParams.get('run_id')
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 500) || 500, 2000))
  const scoped = s.events.filter((e) => !run_id || e.run_id === run_id)
  if (view === 'snapshot') {
    const upto = scoped.filter((e) => e.event_id <= (after || Infinity))
    const views = reduceEvents(upto)
    return json({ ok: true, fixture: true, scenario_id: id, cursor: upto.length ? upto[upto.length - 1].event_id : 0, runs: views }, 200, headers)
  }
  const page = []
  for (const e of scoped) {
    if (e.event_id <= after) continue
    page.push(e)
    if (page.length >= limit) break
  }
  const cursor = page.length ? page[page.length - 1].event_id : after
  const last = scoped.length ? scoped[scoped.length - 1].event_id : 0
  if (url.searchParams.get('format') === 'sse') {
    return new Response(toSse(page), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-agent-fixture': 'true', ...headers } })
  }
  return json({ ok: true, fixture: true, scenario_id: id, events: page, cursor, done: cursor >= last }, 200, headers)
}
