// R2 persistent intelligence runtime — PostgreSQL proofs of
// PROPOSED_20261012140000_intel_runtime.sql against a DISPOSABLE local PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it).
// Everything the worker does runs AS agent_api (least privilege, no BYPASSRLS).
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore, RUNTIME_JOB_STATES, canRuntimeTransition, runtimeIdempotencyKey } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { DEFAULT_RUNTIME_HANDLERS } from '../../src/lib/agent/runtime/runtime-service.js'
import { createPgAgentStore } from '../../src/lib/agent/runtime/pg-store.js'

const skip = pgAvailable() ? false : skipReason
const OP = '11111111-1111-4111-8111-111111111111'
const KIND = 'ops.health_check'
const KIND2 = 'ops.test_kind'
const key = (s) => runtimeIdempotencyKey('pg', s)
const code = (re) => (e) => re.test(String(e.message))

const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  create index if not exists idx_send_queue_status_sched on public.send_queue (queue_status, scheduled_for);
  revoke all on public.system_control, public.send_queue from agent_api;`

async function runtimeDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await db.pool.query(PUBLIC_FIXTURE)
  await applyInTransaction(db.pool, SQL.runtime)
  return db
}
const arm = (pool, { kinds = { [KIND]: 2 }, global = 2, tickMax = 2 } = {}) => pool.query(
  `update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = $1, tick_max_jobs = $2, kind_limits = $3::jsonb where id = 1`,
  [global, tickMax, JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: OP }])))])
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows
const job = async (pool, id) => (await sel(pool, 'select * from agent.research_job where job_id = $1', [id]))[0]

function psqlFile(url, file) {
  const r = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8' })
  if (r.error) return { skipped: true }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

async function fingerprint(pool) {
  const cols = await sel(pool, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'agent' order by 1, 2`)
  const cons = await sel(pool, `select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'agent'::regnamespace order by 1, 2`)
  const fns = await sel(pool, `select p.oid::regprocedure::text sig, md5(prosrc) h, coalesce(array_to_string(proacl, ','), '') acl from pg_proc p where pronamespace = 'agent'::regnamespace order by 1`)
  const idx = await sel(pool, `select indexname, indexdef from pg_indexes where schemaname = 'agent' order by 1`)
  return JSON.stringify({ cols, cons, fns, idx })
}

test('PG runtime: pretest (read-only prerequisites) passes and changes nothing; apply; posttest (BEGIN…ROLLBACK) passes and changes nothing; rollback restores the 10-10 schema exactly; pretest passes again; a reserve open at lease loss becomes unknown and blocks rollback', { skip }, async () => {
  const db = await freshDb()
  try {
    await runSqlFile(db.pool, SQL.researchPretest)
    await runSqlFile(db.pool, SQL.research)
    await db.pool.query(PUBLIC_FIXTURE)
    const before = await fingerprint(db.pool)
    const p1 = psqlFile(db.url, SQL.runtimePretest)
    if (!p1.skipped) {
      assert.equal(p1.status, 0, p1.out)
      assert.match(p1.out, /prerequisites OK/)
      assert.equal(await fingerprint(db.pool), before, 'the pretest leaves no trace')
    }
    await applyInTransaction(db.pool, SQL.runtime)
    const applied = await fingerprint(db.pool)
    assert.notEqual(applied, before)
    if (!p1.skipped) {
      const post = psqlFile(db.url, SQL.runtimePosttest)
      assert.equal(post.status, 0, post.out)
      assert.match(post.out, /ALL OK \(rolled back\)/)
      assert.equal(await fingerprint(db.pool), applied, 'the posttest leaves no trace')
    }
    if (!p1.skipped) assert.notEqual(psqlFile(db.url, SQL.runtimePretest).status, 0, 'pretest refuses a second apply')
    // a persisted runtime job blocks the rollback unless discard is explicit
    await arm(db.pool)
    await db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4)', [KIND, key('rb'), '{}', OP])
    await assert.rejects(runSqlFile(db.pool, SQL.runtimeRollback), code(/persisted runtime job/))
    const c = await db.pool.connect()
    try {
      await c.query("set agent.rollback_discard_data = 'on'")
      await c.query((await import('node:fs')).readFileSync(SQL.runtimeRollback, 'utf8'))
    } finally { c.release() }
    assert.equal(await fingerprint(db.pool), before, 'rollback restores columns, constraints, function bodies, grants and indexes')
    if (!p1.skipped) assert.equal(psqlFile(db.url, SQL.runtimePretest).status, 0)
    // spend history is never discarded by a rollback
    await applyInTransaction(db.pool, SQL.runtime)
    await arm(db.pool)
    await db.pool.query('update agent.research_limits set enabled = true where id = 1')
    const e = (await db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4, 100, 3, 0.5) r', [KIND, key('rb2'), '{}', OP])).rows[0].r
    const cl = (await db.api.query("select agent.runtime_claim('w', 1) r")).rows[0].r.claimed[0]
    const rs = (await db.api.query("select agent.runtime_reserve($1, $2::uuid, 'claude-haiku-4-5', 0.01) r", [e.job_id, cl.lease_token])).rows[0].r
    assert.equal(rs.ok, true)
    await db.pool.query("update agent.research_job set lease_until = clock_timestamp() - interval '1 s' where job_id = $1", [e.job_id])
    await db.api.query('select agent.runtime_reap(10)')
    assert.equal((await sel(db.pool, 'select state from agent.spend_ledger where reserve_id = $1', [rs.reserve_id]))[0].state, 'unknown', 'a reserve open at lease loss stays counted as unknown')
    const c2 = await db.pool.connect()
    try {
      await c2.query("set agent.rollback_discard_data = 'on'")
      await assert.rejects(c2.query((await import('node:fs')).readFileSync(SQL.runtimeRollback, 'utf8')), code(/spend history is never discarded/))
    } finally { c2.release() }
  } finally { await db.drop() }
})

test('PG runtime: the SQL state graph equals the JS graph for every pair; illegal transitions and non-function writes are refused', { skip }, async () => {
  const db = await runtimeDb()
  try {
    const { rows } = await db.api.query(`select f, t, agent.runtime_transition_ok(f, t) ok from unnest($1::text[]) f, unnest($1::text[]) t`, [RUNTIME_JOB_STATES])
    for (const r of rows) assert.equal(r.ok, canRuntimeTransition(r.f, r.t), `${r.f} → ${r.t}`)
    await arm(db.pool)
    const e = (await db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4) r', [KIND, key('sm'), '{}', OP])).rows[0].r
    // agent_api has UPDATE on research_job (the S3 store needs it) but can never write a runtime row directly
    await assert.rejects(db.api.query("update agent.research_job set state = 'claimed' where job_id = $1", [e.job_id]), code(/AGENT_JOB_RUNTIME_WRITE/))
    await assert.rejects(db.api.query(`insert into agent.research_job (job_id, org_id, kind, state, requested_by, trigger_kind, trigger_ref, idempotency_key, next_attempt_at, created_at, gen, doc)
      values ('mjob_00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001', 'ops.health_check', 'queued', $1, 'manual', 'manual', $2, now(), now(), 0, '{"runtime":true}')`, [OP, key('x')]), code(/AGENT_JOB_RUNTIME_WRITE/))
    await assert.rejects(db.api.query('delete from agent.research_job where job_id = $1', [e.job_id]), code(/permission denied|AGENT_JOB_RUNTIME_WRITE/))
    // even the owner path cannot skip the graph
    await assert.rejects(db.pool.query("update agent.research_job set state = 'completed', ended_at = now() where job_id = $1", [e.job_id]), code(/AGENT_JOB_ILLEGAL_TRANSITION: queued → completed/))
    await assert.rejects(db.pool.query("update agent.research_job set kind = 'ops.other' where job_id = $1", [e.job_id]), code(/AGENT_JOB_IMMUTABLE/))
    await assert.rejects(db.pool.query("update agent.research_job set budget_cap_usd = 2 where job_id = $1", [e.job_id]), code(/AGENT_JOB_BUDGET_RAISE/))
    // CHECKs: born states, named operator, sha256 key, doc marker
    assert.equal((await db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4) r', [KIND, 'not-a-digest', '{}', OP])).rows[0].r.reason, 'idempotency_key_must_be_sha256_hex')
    assert.equal((await db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4) r', [KIND, key('y'), '{}', 'service_role'])).rows[0].r.reason, 'requested_by_not_named_operator')
    await assert.rejects(db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4)', [KIND, key('pii'), JSON.stringify({ note: 'call 612-555-0147' }), OP]), code(/research_job_input_clean/))
    // events are append-only
    await assert.rejects(db.pool.query("update agent.job_event set type = 'job.x' where job_id = $1", [e.job_id]), code(/AGENT_JOB_EVENT_APPEND_ONLY/))
    await assert.rejects(db.api.query('insert into agent.job_event (job_id, org_id, type, state, actor) values ($1, $2, $3, $4, $5)', [e.job_id, '00000000-0000-4000-8000-00000000a001', 'job.fake', 'queued', 'x']), code(/permission denied/))
    assert.equal(await createRuntimePgStore({ pool: db.api }).assertLeastPrivilege(), true)
    await assert.rejects(createRuntimePgStore({ pool: db.pool }).assertLeastPrivilege(), (e) => e.code === 'AGENT_RUNTIME_ROLE_PRIVILEGED')
    // the API role cannot read the sources directly, only through the bounded snapshot
    await assert.rejects(db.api.query('select * from public.system_control'), code(/permission denied/))
  } finally { await db.drop() }
})

test('PG runtime: 8 concurrent claimers (separate connections) never get the same job; global + per-kind limits hold; every job runs exactly once', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await arm(db.pool, { kinds: { [KIND]: 2, [KIND2]: 2 }, global: 4, tickMax: 5 })
    for (let i = 0; i < 24; i += 1) await db.api.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4)', [i % 2 ? KIND : KIND2, key(`cc${i}`), '{}', OP])
    const pools = Array.from({ length: 8 }, () => db.newPool(1))
    const stores = pools.map((pool) => createRuntimePgStore({ pool }))
    const runs = new Map()
    let rounds = 0
    while (rounds < 40) {
      rounds += 1
      const results = await Promise.all(stores.map((s, i) => s.claim({ worker: `w${i}`, limit: 5 })))
      const claimed = results.flatMap((r) => r.claimed)
      const ids = claimed.map((c) => c.job_id)
      assert.equal(new Set(ids).size, ids.length, 'no job is held by two claimers')
      const live = (await sel(db.pool, "select kind, count(*)::int n from agent.research_job where state in ('claimed','running') group by kind"))
      assert.ok(live.reduce((a, r) => a + r.n, 0) <= 4, 'global cap 4')
      for (const r of live) assert.ok(r.n <= 2, `per-kind cap 2 (${r.kind}=${r.n})`)
      if (!claimed.length) break
      await Promise.all(claimed.map(async (c, i) => {
        const s = stores[i % stores.length]
        runs.set(c.job_id, (runs.get(c.job_id) || 0) + 1)
        await s.start({ job_id: c.job_id, token: c.lease_token })
        await s.finish({ job_id: c.job_id, token: c.lease_token, outcome: 'completed', result: { ok: true } })
      }))
    }
    assert.equal(runs.size, 24)
    assert.ok([...runs.values()].every((n) => n === 1), 'each job executed exactly once')
    assert.equal((await sel(db.pool, "select count(*)::int n from agent.research_job where runtime_managed and state = 'completed'"))[0].n, 24)
  } finally { await db.drop() }
})

test('PG runtime: an expired lease is reaped → retrying with exponential backoff → dead_letter after max_attempts; requeue is manual', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await arm(db.pool)
    const s = createRuntimePgStore({ pool: db.api })
    const e = await s.enqueue({ kind: KIND, idempotency_key: key('lease'), requested_by: OP, max_attempts: 3 })
    const waits = []
    let tok = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const c = await s.claim({ worker: 'w1', limit: 1 })
      assert.equal(c.claimed.length, 1)
      assert.equal(c.claimed[0].attempt, attempt)
      tok = c.claimed[0].lease_token
      await db.pool.query("update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where job_id = $1", [e.job_id]) // the worker died
      const r = await s.reap({ limit: 10 })
      const j = await job(db.pool, e.job_id)
      if (attempt < 3) {
        assert.equal(r.retrying, 1)
        assert.equal(j.state, 'retrying')
        assert.equal(j.last_error.code, 'LEASE_EXPIRED')
        waits.push(Math.round((Date.parse(j.next_attempt_at) - Date.parse(j.updated_at)) / 1000))
        assert.equal((await s.claim({ worker: 'w1', limit: 1 })).claimed.length, 0, 'not claimable during backoff')
        await db.pool.query('update agent.research_job set next_attempt_at = clock_timestamp() where job_id = $1', [e.job_id]) // time passes
      } else {
        assert.equal(r.dead_letter, 1)
        assert.equal(j.state, 'dead_letter')
        assert.ok(j.ended_at)
      }
    }
    assert.deepEqual(waits, [30, 60], 'base 30 s · 2^(attempt-1)')
    assert.equal((await s.finish({ job_id: e.job_id, token: tok, outcome: 'completed' })).reason, 'lease_lost')
    const rq = await s.requeue({ job_id: e.job_id, by: OP })
    assert.equal(rq.state, 'queued')
    assert.equal((await job(db.pool, e.job_id)).attempt, 0)
    const types = (await s.jobEvents(e.job_id)).map((x) => x.type)
    assert.equal(types.filter((t) => t === 'job.lease_expired').length, 3)
    assert.equal(types.at(-1), 'job.requeued')
  } finally { await db.drop() }
})

test('PG runtime: the idempotency key dedupes, also under 12 concurrent enqueues; events dedupe on their hashed key; the raw key is never stored', { skip }, async () => {
  const db = await runtimeDb()
  try {
    const pools = Array.from({ length: 12 }, () => db.newPool(1))
    const rs = await Promise.all(pools.map((p) => p.query('select agent.runtime_enqueue($1, $2, $3::jsonb, $4) r', [KIND, key('same'), '{}', OP]).then((x) => x.rows[0].r)))
    assert.equal(new Set(rs.map((r) => r.job_id)).size, 1)
    assert.equal(rs.filter((r) => !r.deduped).length, 1)
    assert.equal((await sel(db.pool, 'select count(*)::int n from agent.research_job where runtime_managed'))[0].n, 1)
    assert.equal((await db.api.query('select agent.runtime_enqueue_event($1, $2) r', [KIND, 'inbound:x'])).rows[0].r.reason, 'kind_not_armed')
    await arm(db.pool)
    const ev = await Promise.all(pools.slice(0, 6).map((p) => p.query('select agent.runtime_enqueue_event($1, $2) r', [KIND, 'inbound:msg-42']).then((x) => x.rows[0].r)))
    assert.equal(new Set(ev.map((r) => r.job_id)).size, 1)
    const row = await job(db.pool, ev[0].job_id)
    assert.equal(row.requested_by, OP)
    assert.equal(row.trigger_kind, 'event')
    assert.ok(!JSON.stringify(row).includes('msg-42'), 'raw event key never stored')
  } finally { await db.drop() }
})

test('PG runtime: cancel stops a running mission between steps (tick on the real store as agent_api)', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await arm(db.pool)
    const s = createRuntimePgStore({ pool: db.api })
    const e = await s.enqueue({ kind: KIND, idempotency_key: key('cancel'), requested_by: OP })
    const ran = []
    const handler = { async run(ctx) { await ctx.step('one'); ran.push('one'); await s.cancel({ job_id: ctx.job.job_id, by: OP }); await ctx.step('two'); ran.push('two'); return {} } }
    const sum = await runRuntimeTick({ store: s, handlers: { [KIND]: handler }, workerId: 'w1', budgetMs: 10_000 })
    assert.deepEqual(ran, ['one'])
    assert.equal(sum.jobs[0].outcome, 'cancelled')
    const j = await job(db.pool, e.job_id)
    assert.equal(j.state, 'cancelled')
    assert.equal(j.cancel_requested_by, OP)
    assert.deepEqual((await s.jobEvents(e.job_id)).map((x) => x.type), ['job.enqueued', 'job.claimed', 'job.started', 'job.step', 'job.cancel_requested', 'job.cancelled'])
    // a queued job cancels at once
    const q = await s.enqueue({ kind: KIND, idempotency_key: key('cancel2'), requested_by: OP })
    assert.equal((await s.cancel({ job_id: q.job_id, by: OP })).state, 'cancelled')
  } finally { await db.drop() }
})

test('PG runtime: the emergency stop blocks every claim; agent_api may set it but never clear it; paused kinds claim nothing', { skip }, async () => {
  const db = await runtimeDb()
  try {
    const s = createRuntimePgStore({ pool: db.api })
    await s.enqueue({ kind: KIND, idempotency_key: key('es'), requested_by: OP })
    assert.equal((await s.claim({ worker: 'w1', limit: 2 })).blocked, 'runtime_disabled', 'born OFF')
    await arm(db.pool)
    assert.equal((await s.emergencyStop({ by: OP, reason: 'drill' })).ok, true)
    assert.equal((await s.claim({ worker: 'w1', limit: 2 })).blocked, 'emergency_stop')
    assert.equal((await s.enqueueDueSchedules()).enqueued, 0)
    await assert.rejects(db.api.query('update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null where id = 1'), code(/permission denied/))
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await c.query('set local role service_role')
      await c.query('update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1')
      await c.query('commit')
    } finally { c.release() }
    await s.pauseKind({ kind: KIND, by: OP })
    assert.equal((await s.claim({ worker: 'w1', limit: 2 })).blocked, 'no_kind_enabled')
    await assert.rejects(db.api.query(`update agent.runtime_limits set kind_limits = '{"ops.health_check":{"enabled":true,"armed_by":"${OP}"}}' where id = 1`), code(/permission denied/))
    await assert.rejects(db.pool.query(`update agent.runtime_limits set kind_limits = '{"ops.health_check":{"enabled":true}}' where id = 1`), code(/runtime_limits_kind_limits_valid/), 'enabling a kind needs a named armed_by')
    await assert.rejects(db.pool.query('update agent.runtime_limits set max_concurrency_global = 9 where id = 1'), code(/check/))
  } finally { await db.drop() }
})

test('PG runtime: budget — a refused reserve (switch off / job cap) gives budget_blocked via spend_ledger_guard; an allowed one names the job; day cap is shared with research runs', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await arm(db.pool)
    const s = createRuntimePgStore({ pool: db.api })
    const e = await s.enqueue({ kind: KIND, idempotency_key: key('b'), requested_by: OP, budget_cap_usd: 0.05 })
    let c = (await s.claim({ worker: 'w1', limit: 1 })).claimed[0]
    await s.start({ job_id: e.job_id, token: c.lease_token })
    let r = await s.reserve({ job_id: e.job_id, token: c.lease_token, model: 'claude-haiku-4-5', reserved_usd: 0.01 })
    assert.deepEqual([r.ok, r.reason, r.state], [false, 'AGENT_RESEARCH_DISABLED', 'budget_blocked'])
    assert.equal((await job(db.pool, e.job_id)).state, 'budget_blocked')
    assert.equal((await sel(db.pool, 'select count(*)::int n from agent.spend_ledger'))[0].n, 0)
    assert.equal((await s.finish({ job_id: e.job_id, token: c.lease_token, outcome: 'completed' })).state, 'budget_blocked', 'a late finish is idempotent, never a completion')
    // research spend on: the per-job cap (min(run_usd, job cap)) refuses
    await db.pool.query('update agent.research_limits set enabled = true where id = 1')
    await s.requeue({ job_id: e.job_id, by: OP })
    c = (await s.claim({ worker: 'w1', limit: 1 })).claimed[0]
    await s.start({ job_id: e.job_id, token: c.lease_token })
    const ok = await s.reserve({ job_id: e.job_id, token: c.lease_token, model: 'claude-haiku-4-5', reserved_usd: 0.04 })
    assert.equal(ok.ok, true)
    const led = (await sel(db.pool, 'select * from agent.spend_ledger where reserve_id = $1', [ok.reserve_id]))[0]
    assert.equal(led.job_id, e.job_id)
    assert.equal(led.run_id, null)
    assert.equal(led.operator_id, OP)
    assert.equal((await s.settle({ job_id: e.job_id, token: c.lease_token, reserve_id: ok.reserve_id, actual_usd: 0.03 })).ok, true)
    r = await s.reserve({ job_id: e.job_id, token: c.lease_token, model: 'claude-haiku-4-5', reserved_usd: 0.03 })
    assert.deepEqual([r.ok, r.reason], [false, 'AGENT_SPEND_CAP_JOB'])
    // the guard is not bypassable: a direct ledger insert for a non-leased job is refused
    await assert.rejects(db.api.query(`insert into agent.spend_ledger (job_id, operator_id, model, purpose, day, cycle, reserved_usd, state) values ($1, $2, 'claude-haiku-4-5', 'default', '2000-01-01', '2000-01', 0.01, 'reserved')`, [e.job_id, OP]), code(/AGENT_SPEND_JOB_NOT_RUNNING/))
    await assert.rejects(db.api.query(`insert into agent.spend_ledger (operator_id, model, purpose, day, cycle, reserved_usd, state) values ($1, 'claude-haiku-4-5', 'default', '2000-01-01', '2000-01', 0.01, 'reserved')`, [OP]), code(/AGENT_SPEND_OWNER/))
    // the day cap counts job + run reservations together
    await db.pool.query('update agent.research_limits set day_usd = 0.05 where id = 1')
    await db.pool.query(`insert into agent.research_run (run_id, org_id, operator_id, state, question_sha256, question_chars) values ('ask_runtime0001', '00000000-0000-4000-8000-00000000a001', $1, 'running', repeat('a', 64), 1)`, [OP])
    await assert.rejects(db.api.query(`insert into agent.spend_ledger (run_id, operator_id, model, purpose, day, cycle, reserved_usd, state) values ('ask_runtime0001', $1, 'claude-haiku-4-5', 'default', '2000-01-01', '2000-01', 0.03, 'reserved')`, [OP]), code(/AGENT_SPEND_CAP_DAY/), '0.03 settled by the job + 0.03 > 0.05')
  } finally { await db.drop() }
})

test('PG runtime: a schedule slot enqueues at most once under 8 concurrent ticks; missed slots coalesce; overlap is skipped', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await arm(db.pool)
    const sc = (await db.pool.query(`select agent.runtime_upsert_schedule('ops.health', $1, 300, $2, '{}'::jsonb, true, clock_timestamp() - interval '16 minutes') r`, [KIND, OP])).rows[0].r
    await assert.rejects(db.api.query(`select agent.runtime_upsert_schedule('x.y', $1, 300, $2)`, [KIND, OP]), code(/permission denied/), 'creating schedules is an owner act')
    const pools = Array.from({ length: 8 }, () => db.newPool(1))
    const rs = await Promise.all(pools.map((p) => p.query('select agent.runtime_enqueue_due_schedules(10) r').then((x) => x.rows[0].r)))
    assert.equal(rs.reduce((a, r) => a + r.enqueued, 0), 1, 'one job for the due slot')
    const jobs = await sel(db.pool, 'select job_id, schedule_slot, input from agent.research_job where schedule_id = $1', [sc.schedule_id])
    assert.equal(jobs.length, 1)
    assert.ok(jobs[0].input.schedule_watermark, 'the watermark rides along')
    const sched = (await sel(db.pool, 'select * from agent.runtime_schedule where schedule_id = $1', [sc.schedule_id]))[0]
    assert.ok(Date.parse(sched.next_run_at) > Date.now(), 'missed slots (16 min at 5 min) coalesce into the next future slot')
    // replay the same slot after the job ended: deduped by (schedule_id, slot)
    await db.api.query('select agent.runtime_cancel($1, $2)', [jobs[0].job_id, OP])
    await db.pool.query('update agent.runtime_schedule set next_run_at = last_slot where schedule_id = $1', [sc.schedule_id])
    const again = (await db.api.query('select agent.runtime_enqueue_due_schedules(10) r')).rows[0].r
    assert.deepEqual(again, { enqueued: 0, deduped: 1, skipped: 0 })
    // an open previous slot is never overlapped
    await db.pool.query("update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 second' where schedule_id = $1", [sc.schedule_id])
    assert.equal((await db.api.query('select agent.runtime_enqueue_due_schedules(10) r')).rows[0].r.enqueued, 1)
    await db.pool.query("update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 second' where schedule_id = $1", [sc.schedule_id])
    assert.deepEqual((await db.api.query('select agent.runtime_enqueue_due_schedules(10) r')).rows[0].r, { enqueued: 0, deduped: 0, skipped: 1 })
  } finally { await db.drop() }
})

test('PG runtime: the tick respects its wall-clock budget on the real store; the heartbeat row is written', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await arm(db.pool)
    const s = createRuntimePgStore({ pool: db.api })
    const e = await s.enqueue({ kind: KIND, idempotency_key: key('hang'), requested_by: OP })
    const hung = { run: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => setTimeout(resolve, 5000))) }
    const t0 = Date.now()
    const sum = await runRuntimeTick({ store: s, handlers: { [KIND]: hung }, workerId: 'agent-runtime-tick', budgetMs: 2000, minClaimMs: 200, safetyMs: 300 })
    const ms = Date.now() - t0
    assert.ok(ms < 2000, `returned in ${ms} ms (< 2000 budget)`)
    assert.equal(sum.jobs[0].outcome, 'retry')
    const j = await job(db.pool, e.job_id)
    assert.equal(j.state, 'retrying')
    assert.equal(j.last_error.code, 'TICK_DEADLINE')
    const hb = await sel(db.pool, "select * from agent.runtime_heartbeat where worker_id = 'agent-runtime-tick'")
    assert.equal(hb.length, 1)
    assert.equal(Number(hb[0].ticks), 1)
    assert.equal(hb[0].last_summary.outcomes.retry, 1)
    const st = (await db.api.query('select agent.runtime_status() r')).rows[0].r
    assert.equal(st.open.retrying, 1)
    assert.equal(st.heartbeats[0].worker_id, 'agent-runtime-tick')
  } finally { await db.drop() }
})

test('PG runtime: ops.health_check end-to-end at $0 as agent_api — stale heartbeat + overdue queue → findings; the S3 store never loads runtime rows', { skip }, async () => {
  const db = await runtimeDb()
  try {
    await db.pool.query(`insert into public.system_control (key, value, updated_at) values
      ('queue_processor_heartbeat_at', to_char((now() - interval '2 hours') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '2026-07-01'),
      ('campaign_feeder_heartbeat_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '2026-07-01'),
      ('followup_no_response_heartbeat_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '2026-07-01'),
      ('seller_state_reconcile_heartbeat_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '2026-07-01'),
      ('queue_processor_mode', 'off', now()),
      ('unrelated_secret_key', 'never-read', now())`)
    await db.pool.query(`insert into public.send_queue (queue_status, scheduled_for) select 'queued', now() - interval '1 hour' from generate_series(1, 3)`)
    await arm(db.pool, { kinds: { [KIND]: 1 } })
    const s = createRuntimePgStore({ pool: db.api })
    const snap = await s.healthSnapshot()
    assert.ok(!('unrelated_secret_key' in snap.keys), 'only the fixed keys are read')
    const sc = (await db.pool.query(`select agent.runtime_upsert_schedule('ops.health', $1, 900, $2, '{}'::jsonb, true) r`, [KIND, OP])).rows[0].r
    const sum = await runRuntimeTick({ store: s, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'agent-runtime-tick', budgetMs: 15_000 })
    assert.equal(sum.schedules.enqueued, 1)
    assert.equal(sum.jobs[0].outcome, 'completed', JSON.stringify(sum))
    const j = (await sel(db.pool, 'select * from agent.research_job where schedule_id = $1', [sc.schedule_id]))[0]
    assert.equal(j.state, 'completed')
    assert.equal(j.result.healthy, false)
    assert.equal(j.progress.pct, 100)
    const f = await sel(db.pool, 'select finding_type, key, value, actor_user_id, run_id, property_id, source_class, evidence_status, agent.payload_is_clean(value) clean from agent.finding where job_id = $1 order by finding_type, key', [j.job_id])
    assert.deepEqual(f.map((x) => `${x.finding_type}:${x.key}`), ['ops.heartbeat_missing:webhook_delivery_recovery_last_at', 'ops.heartbeat_stale:queue_processor_heartbeat_at', 'ops.queue_overdue:send_queue.queued_or_retry'])
    assert.ok(f.every((x) => x.actor_user_id === OP && x.run_id === null && x.property_id === null && x.source_class === 'internal_record' && x.clean))
    assert.ok(f[1].value.age_seconds >= 7199)
    assert.equal(f[2].value.count, 3)
    assert.equal(f[2].value.queue_processor_mode, 'off')
    assert.equal((await sel(db.pool, 'select count(*)::int n from agent.spend_ledger'))[0].n, 0, '$0: no spend')
    const ev = (await s.jobEvents(j.job_id)).map((x) => x.type)
    assert.deepEqual(ev, ['job.enqueued', 'job.claimed', 'job.started', 'job.step', 'job.step', 'job.step', 'job.finding', 'job.finding', 'job.finding', 'job.completed'])
    // a direct job-finding insert by agent_api is refused (only runtime_record_finding writes them)
    await assert.rejects(db.api.query(`insert into agent.finding (finding_id, job_id, org_id, finding_type, key, evidence_status, source_class, source_id, confidence, retrieved_at, actor_user_id, gen, doc)
      values ('fnd_x', $1, '00000000-0000-4000-8000-00000000a001', 'ops.fake', 'k', 'internal_record', 'internal_record', 's', 1, now(), $2, 0, '{}')`, [j.job_id, OP]), code(/AGENT_JOB_RUNTIME_WRITE/))
    // the S3 store (agent_api) opens cleanly and never caches runtime missions
    const store = createPgAgentStore({ pool: db.api })
    await store.open()
    assert.equal(store.read().researchJobs.size, 0)
  } finally { await db.drop() }
})

test('PG runtime: every runtime predicate is served by an index (seqscan disabled ⇒ the planner still finds one)', { skip }, async () => {
  const db = await runtimeDb()
  try {
    const plan = async (sql) => {
      const c = await db.pool.connect()
      try {
        await c.query('begin')
        await c.query('set local enable_seqscan = off')
        const { rows } = await c.query(`explain ${sql}`)
        await c.query('rollback')
        return rows.map((r) => r['QUERY PLAN']).join('\n')
      } finally { c.release() }
    }
    const cases = {
      research_job_runtime_due_idx: "select job_id from agent.research_job where state in ('queued','retrying') and runtime_managed and next_attempt_at <= now() order by priority, next_attempt_at limit 8",
      research_job_runtime_leased_idx: "select job_id from agent.research_job where state in ('claimed','running') and runtime_managed and lease_until < now() order by lease_until limit 20",
      research_job_schedule_open_idx: 'select 1 from agent.research_job where schedule_id = 1 and ended_at is null',
      research_job_runtime_ended_idx: "select job_id from agent.research_job where runtime_managed and ended_at is not null and ended_at < now() - interval '180 days' order by ended_at limit 200",
      research_job_idem_uq: "select job_id from agent.research_job where kind = 'ops.health_check' and idempotency_key = 'x'",
      runtime_schedule_due_idx: 'select schedule_id from agent.runtime_schedule where enabled and next_run_at <= now() order by next_run_at limit 10',
      job_event_job_idx: "select id from agent.job_event where job_id = 'x' and id > 0 order by id limit 200",
      spend_ledger_job: "select 1 from agent.spend_ledger where job_id = 'x'",
      finding_job_key_uq: "select 1 from agent.finding where job_id = 'x' and finding_type = 'ops.a' and key = 'k'",
      idx_send_queue_status_sched: "select 1 from public.send_queue where queue_status in ('queued','retry') and scheduled_for < now() - interval '15 minutes' limit 1000",
    }
    for (const [idx, sql] of Object.entries(cases)) assert.match(await plan(sql), new RegExp(idx === 'finding_job_key_uq' ? 'finding_job_key_uq|finding_job_recent_idx' : idx), `${idx} serves: ${sql}`)
  } finally { await db.drop() }
})
