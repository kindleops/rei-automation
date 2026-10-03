/**
 * ANALYTICS GOALS — targets on canonical Lab metrics.
 * No network, no database: an in-memory table and an injected Lab query.
 *   validation · recurring period bounds (Monday weeks, DST, quarters) ·
 *   pace / run-rate projection only for additive counts · Lab statuses pass
 *   through verbatim · operator-private store · missing table → 503 ·
 *   revision conflict · archive is soft · progress reads the Lab with the
 *   goal's market as a Lab filter and never writes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { GOAL_METRIC_IDS, goalCatalogue, labContextFor, periodBounds, progressOf, validateGoal } from '../../src/lib/domain/analytics/goals/goal-model.js'
import { createGoalService } from '../../src/lib/domain/analytics/goals/goal-service.js'
import { createGoalRoutes } from '../../src/lib/domain/analytics/goals/goal-routes.js'
import { METRICS_BY_ID } from '../../src/lib/domain/analytics/lab/metric-registry.js'
import { normalizeContext } from '../../src/lib/domain/analytics/lab/query-contract.js'

const TZ = 'America/Chicago'
const goal = (over = {}) => ({ goal_id: 'g_reach01', metric_id: 'sellers_reached', period_kind: 'month', comparator: 'at_least', target_value: 600, market: null, timezone: TZ, revision: 1, ...over })

/* ── model ── */

test('every goal metric is a registry metric; the catalogue carries registry facts only', () => {
  for (const id of GOAL_METRIC_IDS) assert.ok(METRICS_BY_ID[id], id)
  const cat = goalCatalogue()
  const reach = cat.find((c) => c.id === 'sellers_reached')
  assert.equal(reach.additive, true)
  assert.equal(cat.find((c) => c.id === 'reply_rate').additive, false)
  assert.equal(cat.find((c) => c.id === 'opt_out_rate').default_comparator, 'at_most')
  assert.match(cat.find((c) => c.id === 'offers_issued').caveat, /offer ledger/, 'near-empty ledgers carry their registry caveat')
})

test('validateGoal refuses what the Lab cannot honour', () => {
  assert.throws(() => validateGoal(goal({ metric_id: 'ai_score' })), /cannot carry a goal/)
  assert.throws(() => validateGoal(goal({ period_kind: 'year' })), /period_kind/)
  assert.throws(() => validateGoal(goal({ target_value: -1 })), /non-negative/)
  assert.throws(() => validateGoal(goal({ target_value: 2.5 })), /whole number/)
  assert.throws(() => validateGoal(goal({ metric_id: 'reply_rate', target_value: 12 })), /between 0 and 1/)
  assert.throws(() => validateGoal(goal({ market: 'x; drop table' })), /canonical market/)
  const ok = validateGoal(goal({ metric_id: 'opt_out_rate', comparator: undefined, target_value: 0.02, market: 'minneapolis-mn' }))
  assert.equal(ok.comparator, 'at_most', 'down-polarity metrics default to at most')
  assert.equal(ok.market, 'minneapolis-mn')
})

test('periods recur on the calendar in the goal time zone (Monday weeks, months, quarters)', () => {
  // Saturday 2026-10-03 12:00 Chicago
  const now = Date.parse('2026-10-03T17:00:00Z')
  const w = periodBounds('week', now, TZ)
  assert.equal(new Date(w.start).toISOString(), '2026-09-28T05:00:00.000Z') // Mon 00:00 CDT
  assert.equal(new Date(w.end).toISOString(), '2026-10-05T05:00:00.000Z')
  const m = periodBounds('month', now, TZ)
  assert.equal(new Date(m.start).toISOString(), '2026-10-01T05:00:00.000Z')
  assert.equal(new Date(m.end).toISOString(), '2026-11-01T05:00:00.000Z')
  const q = periodBounds('quarter', now, TZ)
  assert.equal(new Date(q.start).toISOString(), '2026-10-01T05:00:00.000Z')
  assert.equal(new Date(q.end).toISOString(), '2027-01-01T06:00:00.000Z') // CST after DST ends
  // a Sunday belongs to the week that started the Monday before
  const sun = periodBounds('week', Date.parse('2026-10-04T20:00:00Z'), TZ)
  assert.equal(sun.start, w.start)
})

test('the Lab context is the period-to-date with the market as a Lab filter, and the contract accepts it', () => {
  const now = Date.parse('2026-10-03T17:00:00Z')
  const c = labContextFor(validateGoal(goal({ market: 'minneapolis-mn' })), now)
  assert.deepEqual(c.filters, [{ field: 'market', op: 'eq', value: 'minneapolis-mn' }])
  assert.equal(c.compare.mode, 'none')
  assert.equal(c.range.end, new Date(now).toISOString(), 'never past now')
  const n = normalizeContext(c, { now })
  assert.equal(n.metric, 'sellers_reached')
  assert.equal(n.period.preset, 'custom')
})

test('additive counts get linear pace and a run-rate projection; verdicts follow the comparator', () => {
  const g = validateGoal(goal())
  // Oct 1 → Nov 1 Chicago = 31 days; now = exactly 10 days in
  const start = periodBounds('month', Date.parse('2026-10-03T17:00:00Z'), TZ).start
  const now = start + 10 * 86_400_000
  const p = progressOf(g, { status: 'ok', value: 250, n: 250 }, { now })
  assert.equal(p.status, 'ok')
  assert.equal(p.pace, Math.round(600 * (10 / 31) * 100) / 100)
  assert.equal(p.projection, Math.round(250 / (10 / 31)))
  assert.equal(p.verdict, 'on_pace')
  assert.equal(progressOf(g, { status: 'ok', value: 100 }, { now }).verdict, 'behind')
  assert.equal(progressOf(g, { status: 'ok', value: 600 }, { now }).verdict, 'met')
  const most = validateGoal(goal({ goal_id: 'g_optout1', metric_id: 'opted_out_sellers', comparator: 'at_most', target_value: 10 }))
  assert.equal(progressOf(most, { status: 'ok', value: 5 }, { now }).verdict, 'at_risk', '5 in 10 of 31 days projects to 16 > 10')
  assert.equal(progressOf(most, { status: 'ok', value: 11 }, { now }).verdict, 'missed')
  assert.equal(progressOf(most, { status: 'ok', value: 2 }, { now }).verdict, 'on_pace')
})

test('no projection in the first day; a cumulative line comes from the Lab series', () => {
  const g = validateGoal(goal())
  const start = periodBounds('month', Date.parse('2026-10-03T17:00:00Z'), TZ).start
  const p = progressOf(g, { status: 'ok', value: 12 }, { now: start + 3_600_000, series: { current: [{ start, value: 5 }, { start: start + 86_400_000, value: 7 }] } })
  assert.equal(p.projection, null)
  assert.match(p.projection_basis, /Too early/)
  assert.deepEqual(p.cumulative.map((x) => x.total), [5, 12])
})

test('rates and non-additive counts are never projected', () => {
  const now = Date.parse('2026-10-20T17:00:00Z')
  const rate = progressOf(validateGoal(goal({ goal_id: 'g_rate001', metric_id: 'reply_rate', target_value: 0.08 })), { status: 'ok', value: 0.1, n: 120 }, { now })
  assert.equal(rate.projection, null)
  assert.equal(rate.pace, null)
  assert.equal(rate.verdict, 'met')
  const replied = progressOf(validateGoal(goal({ goal_id: 'g_repl001', metric_id: 'sellers_replied', target_value: 90 })), { status: 'ok', value: 40 }, { now })
  assert.equal(replied.projection, null)
  assert.equal(replied.verdict, 'in_progress')
})

test('Lab statuses pass through verbatim with no number and no verdict', () => {
  const now = Date.parse('2026-10-20T17:00:00Z')
  for (const status of ['unavailable', 'insufficient_sample', 'no_data', 'not_applicable']) {
    const p = progressOf(validateGoal(goal({ goal_id: 'g_offer01', metric_id: 'offers_issued', target_value: 3 })), { status, value: status === 'insufficient_sample' ? 0.5 : null, reason: 'Lab says why' }, { now })
    assert.equal(p.status, status)
    assert.equal(p.verdict, null)
    assert.equal(p.projection, null)
    assert.equal(p.reason, 'Lab says why')
  }
})

/* ── store + routes ── */

function memoryDb({ missing = false } = {}) {
  const rows = []
  const writes = []
  const from = () => {
    const q = { op: 'select', filters: [], payload: null, head: false, maybe: false }
    const match = (r) => q.filters.every(([k, v]) => r[k] === v)
    const run = () => {
      if (missing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.analytics_goals' in the schema cache" } }
      if (q.op === 'select') {
        const hits = rows.filter(match)
        if (q.head) return { data: null, count: hits.length, error: null }
        if (q.maybe) return { data: hits[0] ? { ...hits[0] } : null, error: null }
        return { data: hits.map((r) => ({ ...r })), error: null }
      }
      writes.push(q.op)
      if (q.op === 'update') { for (const r of rows.filter(match)) Object.assign(r, q.payload); return { data: null, error: null } }
      if (q.op === 'upsert') {
        const p = q.payload
        const i = rows.findIndex((r) => r.operator_id === p.operator_id && r.goal_id === p.goal_id)
        if (i >= 0) rows[i] = { ...rows[i], ...p }
        else rows.push({ ...p })
        return { data: { ...rows.find((r) => r.operator_id === p.operator_id && r.goal_id === p.goal_id) }, error: null }
      }
      return { data: null, error: null }
    }
    const b = {
      select(_c, opts) { if (q.op === 'select') q.head = Boolean(opts?.head); return b },
      eq(k, v) { q.filters.push([k, v]); return b },
      order() { return b },
      limit() { return b },
      maybeSingle() { q.maybe = true; return Promise.resolve(run()) },
      single() { return Promise.resolve(run()) },
      update(p) { q.op = 'update'; q.payload = p; return b },
      upsert(p) { q.op = 'upsert'; q.payload = p; return b },
      delete() { q.op = 'delete'; return b },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { rows, writes, from }
}

const allow = () => ({ ok: true })
const deny = () => ({ ok: false, response: new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }) })
const cors = () => ({})
function req(method, { operator = 'op-1', body, query = '' } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (operator) headers.set('x-ops-user-id', operator)
  return new Request(`http://localhost/api/cockpit/analytics/goals${query}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
}
function setup({ missing = false, denied = false, query } = {}) {
  const db = memoryDb({ missing })
  const calls = []
  const q = query ?? (async (ctx, view) => { calls.push({ ctx, view }); return { version: 'lab-test', dataAsOf: '2026-10-20T16:59:00Z', metric: { cur: { status: 'ok', value: 300, n: 300 } }, result: view === 'series' ? { current: [{ start: 1, value: 300 }] } : null } })
  const service = createGoalService({ db, query: q, now: () => Date.parse('2026-10-20T17:00:00Z') })
  return { db, calls, routes: createGoalRoutes({ service, authorize: denied ? deny : allow, cors }) }
}

test('the dashboard gate runs first; the store needs the Worker-verified operator', async () => {
  assert.equal((await setup({ denied: true }).routes.GET(req('GET'))).status, 401)
  const r = await setup().routes.GET(req('GET', { operator: null }))
  assert.equal(r.status, 401)
  assert.equal((await r.json()).error, 'operator_unknown')
})

test('a missing table answers goals_store_unavailable so the dashboard keeps goals locally', async () => {
  const { routes } = setup({ missing: true })
  const r = await routes.GET(req('GET'))
  assert.equal(r.status, 503)
  const body = await r.json()
  assert.equal(body.error, 'goals_store_unavailable')
  assert.ok(body.catalogue.length > 5, 'the static catalogue still travels')
  assert.equal((await routes.PUT(req('PUT', { body: { goal: goal() } }))).status, 503)
})

test('save is operator-private and revision-checked; archive is soft', async () => {
  const { routes, db } = setup()
  assert.equal((await routes.PUT(req('PUT', { body: { goal: goal() } }))).status, 200)
  const stale = await routes.PUT(req('PUT', { body: { goal: goal({ revision: 1, target_value: 700 }) } }))
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).current.target_value, 600)
  assert.equal((await routes.PUT(req('PUT', { body: { goal: goal({ revision: 2, target_value: 700 }) } }))).status, 200)
  const other = await (await routes.GET(req('GET', { operator: 'op-2' }))).json()
  assert.deepEqual(other.goals, [], 'another operator sees nothing')
  const mine = await (await routes.GET(req('GET'))).json()
  assert.equal(mine.goals[0].target_value, 700)
  assert.ok(mine.catalogue.length > 5)
  const del = await (await routes.DELETE(req('DELETE', { query: '?goal_id=g_reach01' }))).json()
  assert.equal(del.archived, true)
  assert.equal(db.rows[0].status, 'archived', 'archived, never deleted')
  assert.ok(!db.writes.includes('delete'))
  assert.equal((await routes.PUT(req('PUT', { body: { goal: goal({ metric_id: 'nope' }) } }))).status, 400)
})

test('progress reads the Lab (series for additive counts, metric for rates) and writes nothing', async () => {
  const { routes, calls, db } = setup()
  const goals = [goal({ market: 'minneapolis-mn' }), goal({ goal_id: 'g_rate001', metric_id: 'reply_rate', target_value: 0.08 })]
  const r = await routes.PROGRESS(new Request(`http://localhost/api/cockpit/analytics/goals/progress?goals=${Buffer.from(JSON.stringify(goals)).toString('base64url')}`))
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.goals.length, 2)
  assert.equal(body.goals[0].current, 300)
  assert.equal(body.goals[0].data_as_of, '2026-10-20T16:59:00Z')
  assert.deepEqual(calls.map((c) => c.view), ['series', 'metric'])
  assert.deepEqual(calls[0].ctx.filters, [{ field: 'market', op: 'eq', value: 'minneapolis-mn' }])
  assert.equal(db.writes.length, 0)
})

test('a failed Lab read is unavailable for that goal only — never a zero', async () => {
  const { routes } = setup({ query: async (ctx) => { if (ctx.metric === 'reply_rate') throw new Error('boom'); return { metric: { cur: { status: 'ok', value: 4 } }, result: null } } })
  const goals = [goal(), goal({ goal_id: 'g_rate001', metric_id: 'reply_rate', target_value: 0.08 })]
  const body = await (await routes.PROGRESS(new Request(`http://localhost/x?goals=${Buffer.from(JSON.stringify(goals)).toString('base64url')}`))).json()
  assert.equal(body.goals[0].current, 4)
  assert.equal(body.goals[1].status, 'unavailable')
  assert.equal(body.goals[1].current, null)
  const bad = await routes.PROGRESS(new Request('http://localhost/x?goals=bm90LWpzb24'))
  assert.equal(bad.status, 400)
})
