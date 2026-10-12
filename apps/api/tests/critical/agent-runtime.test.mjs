// R2 persistent intelligence runtime — unit tests on the memory twin + the tick.
// The SAME rules are proven against real PostgreSQL in agent-runtime-pg.test.mjs
// (AGENT_PG_TEST_DB_URL); this file always runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createRuntimeMemoryStore, RUNTIME_JOB_TRANSITIONS, RUNTIME_JOB_STATES, canRuntimeTransition, runtimeIdempotencyKey, backoffSeconds,
} from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick, RuntimePermanentError } from '../../src/lib/agent/runtime/runtime-tick.js'
import { opsHealthCheckHandler, evaluateHealthSnapshot, OPS_HEALTH_CHECK_KIND } from '../../src/lib/agent/runtime/handlers/ops-health-check.js'
import { runScheduledRuntimeTick, runtimeGate, DEFAULT_RUNTIME_HANDLERS } from '../../src/lib/agent/runtime/runtime-service.js'

const OP = '11111111-1111-4111-8111-111111111111'
const KIND = 'ops.health_check'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const MIGRATION = path.join(REPO, 'supabase/migrations/PROPOSED_20261012140000_intel_runtime.sql')

function clock(start = Date.parse('2026-10-12T12:00:00Z')) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}
function armed(opts = {}) {
  const c = opts.clock || clock()
  const store = createRuntimeMemoryStore({ now: c.now, limits: { runtime_enabled: true, kind_limits: { [KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } }, ...(opts.limits || {}) }, research: opts.research, health: opts.health })
  return { store, c }
}
const key = (s) => runtimeIdempotencyKey('test', s)

test('state machine: the JS graph is exactly the SQL agent.runtime_transition_ok graph', () => {
  const sql = readFileSync(MIGRATION, 'utf8')
  const body = /function agent\.runtime_transition_ok[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(sql)[1]
  const fromSql = {}
  for (const m of body.matchAll(/when '([a-z_]+)'\s+then p_to in \(([^)]*)\)/g)) fromSql[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
  const fromJs = Object.fromEntries(Object.entries(RUNTIME_JOB_TRANSITIONS).filter(([, v]) => v.length).map(([k, v]) => [k, [...v].sort()]))
  assert.deepEqual(fromSql, fromJs)
  assert.deepEqual(Object.keys(RUNTIME_JOB_TRANSITIONS).sort(), [...RUNTIME_JOB_STATES].sort())
  for (const t of ['completed', 'cancelled']) assert.deepEqual(RUNTIME_JOB_TRANSITIONS[t], [], `${t} is final`)
})

test('state machine: illegal transitions are refused (claimed → completed, terminal → anything but requeue)', async () => {
  const { store } = armed()
  assert.ok(!canRuntimeTransition('claimed', 'completed'))
  assert.ok(!canRuntimeTransition('completed', 'queued'))
  assert.ok(canRuntimeTransition('dead_letter', 'queued'))
  const e = await store.enqueue({ kind: KIND, idempotency_key: key('a'), requested_by: OP })
  const c = await store.claim({ worker: 'w1', limit: 1 })
  const tok = c.claimed[0].lease_token
  await assert.rejects(store.finish({ job_id: e.job_id, token: tok, outcome: 'completed' }), (err) => err.code === 'AGENT_JOB_ILLEGAL_TRANSITION' && /claimed → completed/.test(err.message))
  await store.start({ job_id: e.job_id, token: tok })
  assert.equal((await store.finish({ job_id: e.job_id, token: tok, outcome: 'completed' })).state, 'completed')
  assert.equal((await store.requeue({ job_id: e.job_id, by: OP })).reason, 'not_requeueable')
  assert.equal((await store.enqueue({ kind: KIND, idempotency_key: key('b'), requested_by: 'system:cron' })).reason, 'requested_by_not_named_operator')
  assert.equal((await store.enqueue({ kind: 'research.quick', idempotency_key: key('c'), requested_by: OP })).reason, 'kind_invalid')
  assert.equal((await store.enqueue({ kind: KIND, idempotency_key: 'raw-phone-5551234567', requested_by: OP })).reason, 'idempotency_key_must_be_sha256_hex')
})

test('claim: two concurrent claimers never get the same job; global and per-kind concurrency bound the claim', async () => {
  const { store } = armed({ limits: { max_concurrency_global: 4, tick_max_jobs: 5, kind_limits: { [KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } } } })
  for (let i = 0; i < 6; i += 1) await store.enqueue({ kind: KIND, idempotency_key: key(`c${i}`), requested_by: OP })
  const [a, b] = await Promise.all([store.claim({ worker: 'w1', limit: 5 }), store.claim({ worker: 'w2', limit: 5 })])
  const ids = [...a.claimed, ...b.claimed].map((x) => x.job_id)
  assert.equal(new Set(ids).size, ids.length, 'disjoint')
  assert.equal(ids.length, 2, 'per-kind max_concurrency 2 across both claimers')
  assert.ok(a.claimed.length === 2 && b.claimed.length === 0, 'the second claimer gets nothing while the kind is at its cap')
  for (const x of a.claimed) assert.match(x.lease_token, /^[0-9a-f-]{36}$/)
})

test('lease expiry: reaped → retrying with exponential backoff → … → dead_letter after max_attempts; a reaped token cannot finish', async () => {
  const { store, c } = armed()
  const e = await store.enqueue({ kind: KIND, idempotency_key: key('lease'), requested_by: OP, max_attempts: 3 })
  const waits = []
  let lastTok = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const cl = await store.claim({ worker: 'w1', limit: 1 })
    assert.equal(cl.claimed.length, 1, `attempt ${attempt} claimable`)
    assert.equal(cl.claimed[0].attempt, attempt)
    lastTok = cl.claimed[0].lease_token
    c.advance(61_000) // lease_seconds 60
    const r = await store.reap()
    const job = store._state.jobs.get(e.job_id)
    if (attempt < 3) {
      assert.equal(r.retrying, 1)
      assert.equal(job.state, 'retrying')
      const wait = Date.parse(job.next_attempt_at) - c.now()
      waits.push(wait)
      assert.equal((await store.claim({ worker: 'w1', limit: 1 })).claimed.length, 0, 'not claimable during backoff')
      c.advance(wait)
    } else {
      assert.equal(r.dead_letter, 1)
      assert.equal(job.state, 'dead_letter')
      assert.ok(job.ended_at)
    }
  }
  assert.deepEqual(waits, [backoffSeconds(1) * 1000, backoffSeconds(2) * 1000])
  assert.ok(waits[1] === 2 * waits[0], 'exponential')
  assert.equal((await store.finish({ job_id: e.job_id, token: lastTok, outcome: 'completed' })).reason, 'lease_lost')
  const r = await store.requeue({ job_id: e.job_id, by: OP })
  assert.equal(r.state, 'queued', 'manual requeue from dead_letter')
  assert.equal(store._state.jobs.get(e.job_id).attempt, 0)
})

test('idempotency: the same key, the same event and the same schedule slot each enqueue exactly once', async () => {
  const { store, c } = armed()
  const a = await store.enqueue({ kind: KIND, idempotency_key: key('same'), requested_by: OP })
  const b = await store.enqueue({ kind: KIND, idempotency_key: key('same'), requested_by: OP })
  assert.equal(a.job_id, b.job_id)
  assert.equal(b.deduped, true)
  const e1 = await store.enqueueEvent({ kind: KIND, event_key: 'inbound:abc' })
  const e2 = await store.enqueueEvent({ kind: KIND, event_key: 'inbound:abc' })
  assert.equal(e1.job_id, e2.job_id)
  assert.equal(store._state.jobs.get(e1.job_id).requested_by, OP, 'event jobs are accountable to the operator who armed the kind')
  assert.equal((await store.enqueueEvent({ kind: 'ops.other_kind', event_key: 'x' })).reason, 'kind_not_armed')
  assert.ok(!JSON.stringify([...store._state.jobs.values()]).includes('inbound:abc'), 'the raw event key is never stored')
  // schedule
  await store.upsertSchedule({ name: 'ops.health', kind: KIND, interval_seconds: 300, created_by: OP, enabled: true, first_run_at: new Date(c.now()).toISOString() })
  assert.equal((await store.enqueueDueSchedules()).enqueued, 1)
  assert.equal((await store.enqueueDueSchedules()).enqueued, 0, 'not due again until the next slot')
  const s = [...store._state.schedules.values()][0]
  await store.cancel({ job_id: s.last_job_id, by: OP })
  s.next_run_at = s.last_slot // a replayed tick sees the same slot again
  const again = await store.enqueueDueSchedules()
  assert.equal(again.enqueued, 0)
  assert.equal(again.deduped, 1)
  assert.equal([...store._state.jobs.values()].filter((j) => j.schedule_id === s.schedule_id).length, 1)
  // missed slots coalesce into one; an open previous slot is never overlapped
  c.advance(3 * 300_000 + 1000)
  assert.equal((await store.enqueueDueSchedules()).enqueued, 1)
  c.advance(300_000)
  assert.deepEqual(await store.enqueueDueSchedules(), { enqueued: 0, deduped: 0, skipped: 1 })
  assert.equal(s.last_outcome, 'skipped_overlap')
})

test('cancel stops a running mission between steps (the next step never runs); cancel of a queued job is immediate', async () => {
  const { store } = armed()
  const q = await store.enqueue({ kind: KIND, idempotency_key: key('q'), requested_by: OP, priority: 500 })
  const e = await store.enqueue({ kind: KIND, idempotency_key: key('run'), requested_by: OP, priority: 1 })
  const ran = []
  const handler = {
    async run(ctx) {
      await ctx.step('one')
      ran.push('one')
      await store.cancel({ job_id: ctx.job.job_id, by: OP }) // the operator cancels mid-mission
      await ctx.step('two')
      ran.push('two')
      return { result: { done: true } }
    },
  }
  assert.equal((await store.cancel({ job_id: q.job_id, by: OP })).state, 'cancelled')
  const s = await runRuntimeTick({ store, handlers: { [KIND]: handler }, workerId: 'w1', budgetMs: 10_000, now: () => Date.now() })
  assert.deepEqual(ran, ['one'])
  assert.equal(s.jobs[0].outcome, 'cancelled')
  assert.equal(store._state.jobs.get(e.job_id).state, 'cancelled')
  const types = (await store.jobEvents(e.job_id)).map((x) => x.type)
  assert.deepEqual(types, ['job.enqueued', 'job.claimed', 'job.started', 'job.step', 'job.cancel_requested', 'job.cancelled'])
})

test('emergency stop: blocks every claim and schedule; a running job stops at its next step without burning an attempt; per-kind switch too', async () => {
  const { store } = armed()
  await store.enqueue({ kind: KIND, idempotency_key: key('es1'), requested_by: OP })
  assert.equal((await store.emergencyStop({ by: 'system:x' })).reason, 'by_not_named_operator')
  await store.emergencyStop({ by: OP, reason: 'drill' })
  assert.equal((await store.claim({ worker: 'w1', limit: 2 })).blocked, 'emergency_stop')
  const s = await runRuntimeTick({ store, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s.blocked, 'emergency_stop')
  assert.equal(s.claimed, 0)
  store.setLimits({ emergency_stop: false, emergency_stop_at: null, emergency_stop_by: null })
  // mid-run stop
  const handler = { async run(ctx) { await ctx.step('one'); await store.emergencyStop({ by: OP }); await ctx.step('two'); return {} } }
  const s2 = await runRuntimeTick({ store, handlers: { [KIND]: handler }, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s2.jobs[0].outcome, 'release')
  const job = [...store._state.jobs.values()][0]
  assert.equal(job.state, 'retrying')
  assert.equal(job.attempt, 0, 'a stop does not burn an attempt')
  store.setLimits({ emergency_stop: false, emergency_stop_at: null, emergency_stop_by: null })
  await store.pauseKind({ kind: KIND, by: OP })
  assert.equal((await store.claim({ worker: 'w1', limit: 2 })).blocked, 'no_kind_enabled')
  store.setLimits({ runtime_enabled: false })
  assert.equal((await store.claim({ worker: 'w1', limit: 2 })).blocked, 'runtime_disabled')
})

test('budget: a refused reserve parks the mission in budget_blocked (switch off, then job cap); nothing is spent; requeue is manual', async () => {
  const { store } = armed()
  const e = await store.enqueue({ kind: 'ops.health_check', idempotency_key: key('b1'), requested_by: OP, budget_cap_usd: 0.05 })
  let after = null
  const handler = { async run(ctx) { await ctx.reserve('claude-haiku-4-5', 0.01); after = 'ran'; return {} } }
  const s = await runRuntimeTick({ store, handlers: { [KIND]: handler }, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s.jobs[0].outcome, 'budget_blocked')
  assert.equal(after, null, 'the step after a refused reserve never runs')
  const job = store._state.jobs.get(e.job_id)
  assert.equal(job.state, 'budget_blocked')
  assert.equal(job.last_error.code, 'AGENT_RESEARCH_DISABLED')
  assert.equal(store._state.ledger.length, 0)
  // spend switched on, but the mission cap ($0.05) refuses a $0.10 reserve
  store.setResearch({ enabled: true })
  await store.requeue({ job_id: e.job_id, by: OP })
  const big = { async run(ctx) { await ctx.reserve('claude-haiku-4-5', 0.1); return {} } }
  await runRuntimeTick({ store, handlers: { [KIND]: big }, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(store._state.jobs.get(e.job_id).last_error.code, 'AGENT_SPEND_CAP_JOB')
  assert.equal(store._state.ledger.length, 0)
})

test('tick: respects its wall-clock budget — a hung handler is abandoned (abort signal), its attempt finishes as retry, the heartbeat is written', async () => {
  const { store } = armed()
  await store.enqueue({ kind: KIND, idempotency_key: key('hang'), requested_by: OP })
  let aborted = false
  const hung = { run: (ctx) => new Promise(() => { ctx.signal.addEventListener('abort', () => { aborted = true }) }) }
  const t0 = Date.now()
  const s = await runRuntimeTick({ store, handlers: { [KIND]: hung }, workerId: 'w1', budgetMs: 1200, minClaimMs: 100, safetyMs: 200 })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1200, `tick returned inside its budget (${elapsed} ms)`)
  assert.ok(aborted, 'handler signal aborted')
  assert.equal(s.jobs[0].outcome, 'retry')
  const job = [...store._state.jobs.values()][0]
  assert.equal(job.state, 'retrying')
  assert.equal(job.last_error.code, 'TICK_DEADLINE')
  assert.equal(store._state.heartbeats.get('w1').ticks, 1)
  // too little budget left to claim at all
  const s2 = await runRuntimeTick({ store, handlers: { [KIND]: hung }, workerId: 'w1', budgetMs: 600, minClaimMs: 3000, safetyMs: 100 })
  assert.equal(s2.blocked, 'budget_exhausted_before_claim')
  assert.equal(store._state.heartbeats.get('w1').ticks, 2)
})

test('tick: errors are retried, permanent errors fail, unknown kinds are never claimed, disabled runtime only heartbeats', async () => {
  const { store } = armed()
  const a = await store.enqueue({ kind: KIND, idempotency_key: key('t1'), requested_by: OP })
  const boom = { async run() { throw new Error('network reset') } }
  await runRuntimeTick({ store, handlers: { [KIND]: boom }, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(store._state.jobs.get(a.job_id).state, 'retrying')
  assert.equal(store._state.jobs.get(a.job_id).last_error.code, 'HANDLER_ERROR')
  const b = await store.enqueue({ kind: KIND, idempotency_key: key('t2'), requested_by: OP, priority: 0 })
  const perm = { async run() { throw new RuntimePermanentError('BAD_INPUT') } }
  await runRuntimeTick({ store, handlers: { [KIND]: perm }, workerId: 'w1', budgetMs: 10_000, maxJobs: 1 })
  assert.equal(store._state.jobs.get(b.job_id).state, 'failed')
  const other = createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { 'ops.other': { enabled: true, armed_by: OP } } } })
  await other.enqueue({ kind: 'ops.other', idempotency_key: key('o'), requested_by: OP })
  const so = await runRuntimeTick({ store: other, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(so.claimed, 0, 'only registered handler kinds are claimed')
  const off = createRuntimeMemoryStore()
  const s3 = await runRuntimeTick({ store: off, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s3.blocked, 'runtime_disabled')
  assert.equal(off._state.heartbeats.get('w1').ticks, 1)
})

const SNAP_AT = '2026-10-12T12:00:00.000Z'
const snap = (keys, queue = {}) => ({ at: SNAP_AT, keys, queue: { overdue_queued_or_retry: 0, stale_processing: 0, cap: 1000, overdue_minutes: 15, processing_stale_minutes: 10, ...queue } })
const fresh = { queue_processor_heartbeat_at: '2026-10-12T11:59:00.000Z', campaign_feeder_heartbeat_at: '2026-10-12T11:55:00.000Z', followup_no_response_heartbeat_at: '2026-10-12T11:58:00.000Z', seller_state_reconcile_heartbeat_at: '2026-10-12T11:56:00.000Z', webhook_delivery_recovery_last_at: '2026-10-12T11:57:00.000Z', queue_processor_mode: 'off' }

test('ops.health_check: all fresh → completed, no finding; stale / missing / unparseable heartbeats and overdue queue → one finding each', async () => {
  const ok = armed({ health: () => snap(fresh) })
  await ok.store.enqueue({ kind: OPS_HEALTH_CHECK_KIND, idempotency_key: key('h1'), requested_by: OP })
  const s = await runRuntimeTick({ store: ok.store, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s.jobs[0].outcome, 'completed')
  const job = [...ok.store._state.jobs.values()][0]
  assert.equal(job.result.healthy, true)
  assert.equal(ok.store._state.findings.size, 0)
  assert.equal(job.progress.pct, 100)

  const bad = armed({ health: () => snap({ ...fresh, queue_processor_heartbeat_at: '2026-10-12T11:00:00.000Z', campaign_feeder_heartbeat_at: undefined, followup_no_response_heartbeat_at: 'garbage' }, { overdue_queued_or_retry: 7 }) })
  await bad.store.enqueue({ kind: OPS_HEALTH_CHECK_KIND, idempotency_key: key('h2'), requested_by: OP })
  await runRuntimeTick({ store: bad.store, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'w1', budgetMs: 10_000 })
  const f = [...bad.store._state.findings.values()].map((x) => `${x.finding_type}:${x.key}`).sort()
  assert.deepEqual(f, ['ops.heartbeat_missing:campaign_feeder_heartbeat_at', 'ops.heartbeat_missing:followup_no_response_heartbeat_at', 'ops.heartbeat_stale:queue_processor_heartbeat_at', 'ops.queue_overdue:send_queue.queued_or_retry'])
  const stale = [...bad.store._state.findings.values()].find((x) => x.key === 'queue_processor_heartbeat_at')
  assert.equal(stale.value.age_seconds, 3600)
  assert.equal(stale.actor_user_id, OP)
  assert.equal(stale.source_class, 'internal_record')
  const types = (await bad.store.jobEvents([...bad.store._state.jobs.keys()][0])).map((e) => e.type)
  assert.deepEqual(types.filter((t) => t === 'job.step').length, 3, 'three real steps, each a heartbeat + progress row')
  assert.equal(types.filter((t) => t === 'job.finding').length, 4)
  assert.equal(evaluateHealthSnapshot(snap(fresh)).modes.queue_processor_mode, 'off')
  assert.throws(() => evaluateHealthSnapshot({ keys: {} }), /server time/)
})

test('route gate: the scheduled tick touches nothing unless AGENT_ENABLED and AGENT_RUNTIME_ENABLED are on', async () => {
  const trap = new Proxy({}, { get: () => () => { throw new Error('store touched') } })
  assert.deepEqual(runtimeGate({ NODE_ENV: 'production' }), { enabled: false, reason: 'AGENT_ENABLED_off' })
  assert.deepEqual(runtimeGate({ NODE_ENV: 'production', AGENT_ENABLED: '1' }), { enabled: false, reason: 'AGENT_RUNTIME_ENABLED_off' })
  assert.equal(runtimeGate({ NODE_ENV: 'production', AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1' }).enabled, true)
  assert.equal((await runScheduledRuntimeTick({ env: { NODE_ENV: 'production' }, store: trap })).skipped, 'AGENT_ENABLED_off')
  assert.equal((await runScheduledRuntimeTick({ env: { NODE_ENV: 'test' }, store: trap })).skipped, 'AGENT_RUNTIME_ENABLED_off', 'default OFF outside production too')
  const { store } = armed({ health: () => snap(fresh) })
  const r = await runScheduledRuntimeTick({ env: { NODE_ENV: 'test', AGENT_RUNTIME_ENABLED: '1' }, store })
  assert.equal(r.skipped, null)
  assert.equal(r.summary.worker_id, 'agent-runtime-tick')
})
