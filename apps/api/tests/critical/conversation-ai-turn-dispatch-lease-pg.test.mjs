// rc-8.5.21 OWNER DIRECTIVE (2026-10-17): "No worker, sender or agent may independently produce a
// duplicate response to the same inbound turn." Proven on a DISPOSABLE local PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it):
//   * 8 and 16 parallel workers × 200 turns: exactly ONE dispatch and ONE send_queue row per turn;
//   * leader crash after claim, before dispatch: every recoverer defers under the live lease, then
//     exactly ONE recovery dispatch after the lease expires (DB clock);
//   * leader crash after dispatch, before the outcome is recorded: the recovery's second enqueue is
//     refused by the send_queue backstop (send_queue_ai_turn_uq) — still ONE row;
//   * the loser's runtime job is rescheduled at "lease remaining + jitter", bounded by max_attempts
//     (→ dead_letter); an exhausted dispatch budget fails the job permanently (both visible to the
//     supervisor, which counts failed / dead_letter jobs).
// Every worker uses its own connection. Nothing is sent: the dispatcher inserts a send_queue row
// the way R3 does (metadata.message_origin ai_generated + metadata.turn) and nothing reads it.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import pg from 'pg'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createPgTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { CONVERSATION_TURN_KIND, DEFERRED_LIVE_DISPATCH, runDueTurn, turnEventKey, turnJobInput } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler } from '../../src/lib/ai/conversation-turn-handler.js'

const skip = pgAvailable() ? false : skipReason
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz, delivered_at timestamptz, queue_key text, metadata jsonb default '{}'::jsonb);
  revoke all on public.system_control, public.send_queue from agent_api;`
const LEGACY_TURNS_FIXTURE = path.join(REPO_DIR, 'scripts/db/fixtures/legacy_conversation_turns_baseline.sql')
const ITERATIONS = Number(process.env.LC_TURN_RACE_ITERATIONS || 200)
const REPLY = { outcome: 'REPLY_CANDIDATE', reply: { text: 'Thanks. Would you consider selling it?' } }

async function leaseDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await db.pool.query(PUBLIC_FIXTURE)
  await runSqlFile(db.pool, LEGACY_TURNS_FIXTURE)
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql'))
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  return db
}
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows
const iso = (d) => new Date(d).toISOString()
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

/** The R3-shaped dispatcher: one ai_generated send_queue row per turn; the backstop's refusal is a hold, never a second row. */
function queueDispatcher(pool, calls) {
  return async ({ turn_id, version }) => {
    calls.push(turn_id)
    await sleep(Math.floor(Math.random() * 4))
    try {
      await pool.query(`insert into public.send_queue (queue_key, queue_status, metadata) values ($1, 'queued', $2::jsonb)`,
        [`ai_conversation:${turn_id}:${calls.length}`, JSON.stringify({ message_origin: 'ai_generated', turn: { turn_id, version } })])
      return { status: 'enqueued' }
    } catch (e) {
      if (e?.code === '23505') return { status: 'held', reasons: ['send_queue_ai_turn_uq'] }
      throw e
    }
  }
}
const rowsFor = async (pool, turnId) => (await sel(pool, `select count(*)::int n from public.send_queue where metadata->'turn'->>'turn_id' = $1`, [turnId]))[0].n

async function openDueTurn(store, thread, inbound) {
  const past = iso(Date.now() - 60_000)
  return store.open({ thread_key: thread, inbound_id: inbound, inbound_at: iso(Date.now() - 120_000), due_at: past })
}

async function race(workersN) {
  const db = await leaseDb()
  try {
    const pools = Array.from({ length: workersN }, () => db.trackPool(new pg.Pool({ connectionString: db.url, max: 1 })))
    const stores = pools.map((p) => createPgTurnStore(p))
    let dispatchesTotal = 0; let deferred = 0; let alreadyDone = 0; let claimedElsewhere = 0
    for (let it = 0; it < ITERATIONS; it += 1) {
      const thread = `+1555${String(workersN).padStart(2, '0')}${String(it).padStart(5, '0')}`
      const o = await openDueTurn(stores[0], thread, `r${workersN}-${it}`)
      const calls = []
      const settled = await Promise.allSettled(stores.map((store, i) => runDueTurn({
        turn_id: o.turn_id, version: 1, store, worker: `w${i}`,
        decideTurn: async () => { await sleep(Math.floor(Math.random() * 3)); return REPLY },
        dispatch: queueDispatcher(pools[i], calls),
      })))
      const codes = settled.map((x) => (x.status === 'fulfilled' ? x.value.code : x.reason?.code))
      for (const x of settled) {
        if (x.status === 'rejected') {
          assert.ok(['DEFERRED_LIVE_DISPATCH', 'DEFERRED_LIVE_CLAIM'].includes(x.reason?.code), `iteration ${it}: unexpected rejection ${x.reason?.stack}`)
          if (x.reason.code === 'DEFERRED_LIVE_DISPATCH') assert.equal(x.reason.outcome, DEFERRED_LIVE_DISPATCH)
          assert.ok(x.reason.retry_after_ms >= 1000, 'retry-after = lease remaining + jitter')
        }
      }
      assert.equal(calls.length, 1, `iteration ${it}: exactly ONE dispatch (${JSON.stringify(codes)})`)
      assert.equal(codes.filter((c) => c === 'TURN_DISPATCHED').length, 1, `iteration ${it}: ${JSON.stringify(codes)}`)
      assert.equal(await rowsFor(db.pool, o.turn_id), 1, `iteration ${it}: ONE send_queue row`)
      dispatchesTotal += calls.length
      deferred += codes.filter((c) => c === 'DEFERRED_LIVE_DISPATCH').length
      alreadyDone += codes.filter((c) => c === 'TURN_ALREADY_DISPATCHED').length
      // D4: a loser under a live CLAIM is rescheduled (never completed): DEFERRED_LIVE_CLAIM
      claimedElsewhere += codes.filter((c) => c === 'DEFERRED_LIVE_CLAIM').length
    }
    const states = await sel(db.pool, `select dispatch_state, count(*)::int n from public.conversation_reply_turns group by 1`)
    assert.deepEqual(states, [{ dispatch_state: 'dispatched', n: ITERATIONS }])
    assert.equal((await sel(db.pool, `select count(*)::int n from public.send_queue`))[0].n, ITERATIONS)
    return { dispatchesTotal, deferred, alreadyDone, claimedElsewhere }
  } finally { await db.drop() }
}

test(`PG dispatch lease: 8 parallel workers × ${ITERATIONS} turns ⇒ exactly ONE dispatch and ONE send_queue row per turn`, { skip, timeout: 600_000 }, async () => {
  const r = await race(8)
  assert.equal(r.dispatchesTotal, ITERATIONS)
  console.log(`race(8×${ITERATIONS}): ${JSON.stringify(r)}`)
})

test(`PG dispatch lease: 16 parallel workers × ${ITERATIONS} turns ⇒ exactly ONE dispatch and ONE send_queue row per turn`, { skip, timeout: 600_000 }, async () => {
  const r = await race(16)
  assert.equal(r.dispatchesTotal, ITERATIONS)
  console.log(`race(16×${ITERATIONS}): ${JSON.stringify(r)}`)
})

/** A leader that claimed + finalized (holds the dispatch lease) and then died: no runDueTurn ever finishes for it. */
async function crashedLeader(store, thread, inbound, leaseSeconds = 60) {
  const o = await openDueTurn(store, thread, inbound)
  const c = await store.claim({ turn_id: o.turn_id, version: 1, worker: 'leader', lease_seconds: leaseSeconds })
  assert.ok(c.ok, JSON.stringify(c))
  const f = await store.finalize({ turn_id: o.turn_id, token: c.token, version: 1, outcome: 'reply:reply_candidate', result: { send_status: 'dispatch_pending', reservation_token: c.token, members: 1 }, reserve: true, reply_origin: 'ai_generated' })
  assert.ok(f.ok && f.reserved, JSON.stringify(f))
  return { turn_id: o.turn_id, token: c.token }
}
const expireLease = (pool, turnId) => pool.query(`update public.conversation_reply_turns set dispatch_lease_until = clock_timestamp() - interval '1 second' where turn_id = $1`, [turnId])

test('PG dispatch lease: leader crash AFTER claim, BEFORE dispatch ⇒ recoverers defer under the live lease, then exactly ONE recovery dispatch after expiry', { skip }, async () => {
  const db = await leaseDb()
  try {
    const pools = Array.from({ length: 8 }, () => db.trackPool(new pg.Pool({ connectionString: db.url, max: 1 })))
    const { turn_id, token } = await crashedLeader(createPgTurnStore(db.pool), '+15555550401', 'cr1')
    const calls = []
    const run = () => Promise.allSettled(pools.map((p, i) => runDueTurn({ turn_id, version: 1, store: createPgTurnStore(p), worker: `rec${i}`, decideTurn: async (c) => { assert.equal(c.token, token, 'the SAME reservation token'); assert.equal(c.resumed, true); return REPLY }, dispatch: queueDispatcher(p, calls) })))
    // live lease: nobody dispatches; every job is rescheduled at ≈ lease remaining + jitter
    const live = await run()
    assert.equal(calls.length, 0, 'no dispatch under a live lease')
    for (const x of live) {
      assert.equal(x.status, 'rejected')
      assert.equal(x.reason.code, 'DEFERRED_LIVE_DISPATCH')
      assert.ok(x.reason.retry_after_ms > 50_000 && x.reason.retry_after_ms <= 65_000, `retry_after_ms ${x.reason.retry_after_ms}`)
    }
    assert.equal(await rowsFor(db.pool, turn_id), 0)
    // the lease expires (DB clock): exactly one recoverer dispatches
    await expireLease(db.pool, turn_id)
    const after = await run()
    const codes = after.map((x) => (x.status === 'fulfilled' ? x.value.code : x.reason?.code))
    assert.equal(calls.length, 1, `exactly ONE recovery dispatch: ${JSON.stringify(codes)}`)
    assert.equal(codes.filter((c) => c === 'TURN_DISPATCHED').length, 1, JSON.stringify(codes))
    assert.ok(codes.every((c) => ['TURN_DISPATCHED', 'TURN_ALREADY_DISPATCHED', 'DEFERRED_LIVE_DISPATCH'].includes(c)), JSON.stringify(codes))
    assert.equal(await rowsFor(db.pool, turn_id), 1)
    const row = (await sel(db.pool, `select dispatch_state, dispatch_attempts from public.conversation_reply_turns where turn_id = $1`, [turn_id]))[0]
    assert.deepEqual(row, { dispatch_state: 'dispatched', dispatch_attempts: 2 })
    // a late retry after the terminal outcome never reaches the dispatcher
    await expireLease(db.pool, turn_id)
    const late = await runDueTurn({ turn_id, version: 1, store: createPgTurnStore(db.pool), worker: 'late', decideTurn: async () => REPLY, dispatch: queueDispatcher(db.pool, calls) })
    assert.equal(late.code, 'TURN_ALREADY_DISPATCHED')
    assert.equal(calls.length, 1)
  } finally { await db.drop() }
})

test('PG dispatch lease: leader crash AFTER dispatch, BEFORE the outcome ⇒ the recovery cannot enqueue a second row (send_queue backstop)', { skip }, async () => {
  const db = await leaseDb()
  try {
    const { turn_id } = await crashedLeader(createPgTurnStore(db.pool), '+15555550402', 'cr2')
    // the leader's enqueue landed, then it died before dispatchDone
    const leaderCalls = []
    assert.equal((await queueDispatcher(db.pool, leaderCalls)({ turn_id, version: 1 })).status, 'enqueued')
    await expireLease(db.pool, turn_id)
    const pools = Array.from({ length: 8 }, () => db.trackPool(new pg.Pool({ connectionString: db.url, max: 1 })))
    const calls = []
    const settled = await Promise.allSettled(pools.map((p, i) => runDueTurn({ turn_id, version: 1, store: createPgTurnStore(p), worker: `rec${i}`, decideTurn: async () => REPLY, dispatch: queueDispatcher(p, calls) })))
    const values = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value)
    assert.equal(calls.length, 1, 'one lease-holding recoverer attempted the dispatch')
    // the backstop's refusal is a HOLD (D3: never recorded as dispatched)
    assert.deepEqual(values.filter((v) => v.code === 'TURN_DISPATCH_HELD').map((v) => [v.dispatch, v.reasons]), [['held', ['send_queue_ai_turn_uq']]])
    assert.equal((await sel(db.pool, `select dispatch_state from public.conversation_reply_turns where turn_id = $1`, [turn_id]))[0].dispatch_state, 'held')
    assert.equal(await rowsFor(db.pool, turn_id), 1, 'still exactly ONE send_queue row for the turn')
    // and at the database itself, whatever the code does:
    await assert.rejects(
      db.pool.query(`insert into public.send_queue (queue_key, queue_status, metadata) values ('direct', 'queued', $1::jsonb)`, [JSON.stringify({ message_origin: 'ai_generated', turn: { turn_id, version: 1 } })]),
      (e) => e.code === '23505' && /send_queue_ai_turn_uq/.test(e.message),
    )
  } finally { await db.drop() }
})

test('PG dispatch lease: the loser\'s runtime job is rescheduled at lease remaining + jitter, bounded by max_attempts (→ dead_letter); an exhausted dispatch budget fails the job', { skip }, async () => {
  const db = await leaseDb()
  try {
    const store = createPgTurnStore(db.pool)
    const runtime = createRuntimePgStore({ pool: db.api })
    const calls = []
    const handlers = { [CONVERSATION_TURN_KIND]: createConversationTurnHandler({ store, decide: async () => REPLY, dispatch: queueDispatcher(db.pool, calls), runtimeStore: runtime }) }

    // (a) a live lease: the job is retried at the lease's end, never dispatching; the budget dead-letters it
    const a = await crashedLeader(store, '+15555550403', 'rb1', 120)
    const ja = await runtime.enqueueEventAt({ kind: CONVERSATION_TURN_KIND, event_key: turnEventKey(a.turn_id, 1), input: turnJobInput({ turn_id: a.turn_id, version: 1 }), priority: 100, not_before: iso(Date.now() - 1000) })
    await db.pool.query(`update agent.research_job set max_attempts = 3 where job_id = $1`, [ja.job_id])
    const jobRow = async (id) => (await sel(db.pool, `select state, attempt, next_attempt_at, last_error from agent.research_job where job_id = $1`, [id]))[0]
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const t0 = Date.now()
      const tick = await runRuntimeTick({ store: runtime, handlers, workerId: 'loser', budgetMs: 5000 })
      assert.equal(tick.claimed, 1, JSON.stringify(tick))
      const j = await jobRow(ja.job_id)
      assert.equal(j.last_error?.code, 'DEFERRED_LIVE_DISPATCH')
      assert.equal(j.last_error?.outcome, 'deferred_live_dispatch')
      if (attempt < 3) {
        assert.equal(j.state, 'retrying')
        const lease = (await sel(db.pool, `select dispatch_lease_until from public.conversation_reply_turns where turn_id = $1`, [a.turn_id]))[0].dispatch_lease_until
        const wait = Date.parse(j.next_attempt_at) - Date.parse(lease)
        assert.ok(wait >= -1500 && wait <= 7000, `next attempt ≈ lease end + jitter (Δ ${wait} ms, at ${j.next_attempt_at}, lease ${iso(lease)}, t0 ${iso(t0)})`)
        await db.pool.query(`update agent.research_job set next_attempt_at = now() - interval '1 second' where job_id = $1`, [ja.job_id])
      } else {
        assert.equal(j.state, 'dead_letter', 'the bounded retry budget escalates to dead_letter')
      }
    }
    assert.equal(calls.length, 0, 'the loser never dispatched')
    assert.equal(await rowsFor(db.pool, a.turn_id), 0)

    // (b) the dispatch budget on the turn is spent (every recovery crashed): the job FAILS permanently
    const b = await crashedLeader(store, '+15555550404', 'rb2', 60)
    await db.pool.query(`update public.conversation_reply_turns set dispatch_attempts = 3, dispatch_lease_until = clock_timestamp() - interval '1 second' where turn_id = $1`, [b.turn_id])
    const jb = await runtime.enqueueEventAt({ kind: CONVERSATION_TURN_KIND, event_key: turnEventKey(b.turn_id, 1), input: turnJobInput({ turn_id: b.turn_id, version: 1 }), priority: 100, not_before: iso(Date.now() - 1000) })
    const tick = await runRuntimeTick({ store: runtime, handlers, workerId: 'rec', budgetMs: 5000 })
    assert.equal(tick.claimed, 1)
    const j = await jobRow(jb.job_id)
    assert.deepEqual([j.state, j.last_error?.code], ['failed', 'TURN_DISPATCH_DEAD_LETTER'])
    assert.equal((await sel(db.pool, `select dispatch_state from public.conversation_reply_turns where turn_id = $1`, [b.turn_id]))[0].dispatch_state, 'dead_letter')
    assert.equal(calls.length, 0)
    // visible: the supervisor's runtime read counts failed + dead_letter jobs
    const visible = await sel(db.pool, `select count(*)::int n from agent.research_job where kind = $1 and state in ('failed','dead_letter')`, [CONVERSATION_TURN_KIND])
    assert.equal(visible[0].n, 2)
  } finally { await db.drop() }
})

test('PG (blind-eval D4): a worker frozen while holding the turn claim never orphans the turn — the job is rescheduled at the claim lease end (DB clock), then decides and dispatches ONCE, with the turn sweep never enabled', { skip }, async () => {
  const db = await leaseDb()
  try {
    const store = createPgTurnStore(db.pool)
    const runtime = createRuntimePgStore({ pool: db.api })
    const calls = []
    const handlers = { [CONVERSATION_TURN_KIND]: createConversationTurnHandler({ store, decide: async () => REPLY, dispatch: queueDispatcher(db.pool, calls), runtimeStore: runtime, operatorItems: { syncWorkItems: async () => ({ ok: true }) } }) }
    const o = await openDueTurn(store, '+15555550405', 'fz1')
    // worker A claims the turn and freezes (SIGSTOP-like: it never renews, never finalizes)
    const a = await store.claim({ turn_id: o.turn_id, version: 1, worker: 'A', lease_seconds: 120 })
    assert.ok(a.ok)
    const j = await runtime.enqueueEventAt({ kind: CONVERSATION_TURN_KIND, event_key: turnEventKey(o.turn_id, 1), input: turnJobInput({ turn_id: o.turn_id, version: 1 }), priority: 100, not_before: iso(Date.now() - 1000) })
    const t1 = await runRuntimeTick({ store: runtime, handlers, workerId: 'B', budgetMs: 5000 })
    assert.equal(t1.claimed, 1)
    const job = (await sel(db.pool, `select state, next_attempt_at, last_error from agent.research_job where job_id = $1`, [j.job_id]))[0]
    assert.deepEqual([job.state, job.last_error?.code], ['retrying', 'DEFERRED_LIVE_CLAIM'], 'the job is rescheduled, NOT completed')
    const lease = (await sel(db.pool, `select lease_until from public.conversation_reply_turns where turn_id = $1`, [o.turn_id]))[0].lease_until
    const delta = Date.parse(job.next_attempt_at) - Date.parse(lease)
    assert.ok(delta >= -1500 && delta <= 7000, `next attempt ≈ claim lease end + jitter (Δ ${delta} ms)`)
    assert.equal(calls.length, 0)
    // the frozen claim expires; the sweep schedule is never enabled; the rescheduled job decides
    await db.pool.query(`update public.conversation_reply_turns set lease_until = clock_timestamp() - interval '1 second' where turn_id = $1`, [o.turn_id])
    await db.pool.query(`update agent.research_job set next_attempt_at = clock_timestamp() - interval '1 second' where job_id = $1`, [j.job_id])
    const t2 = await runRuntimeTick({ store: runtime, handlers, workerId: 'B', budgetMs: 5000 })
    assert.equal(t2.jobs?.[0]?.outcome, 'completed', JSON.stringify(t2))
    assert.equal(calls.length, 1)
    assert.equal(await rowsFor(db.pool, o.turn_id), 1)
    // A wakes: its stale claim token is fenced at finalize
    const late = await store.finalize({ turn_id: o.turn_id, token: a.token, version: 1, outcome: 'reply:x', result: { send_status: 'dispatch_pending', reservation_token: a.token }, reserve: true, reply_origin: 'ai_generated' })
    assert.equal(late.ok, false)
    assert.equal(await rowsFor(db.pool, o.turn_id), 1)
    assert.equal((await sel(db.pool, `select count(*)::int n from agent.schedule where name = 'conversation-turn-sweep' and enabled`).catch(() => [{ n: 0 }]))[0].n, 0, 'the sweep was never enabled')
  } finally { await db.drop() }
})
