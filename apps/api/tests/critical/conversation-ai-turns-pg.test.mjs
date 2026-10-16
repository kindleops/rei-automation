// rc-8.5.20 part A — the turn engine on a DISPOSABLE local PostgreSQL 17 (AGENT_PG_TEST_DB_URL;
// skipped — reported, never vacuous — without it). Applied in order: research RO → R2 runtime →
// kind_limits event budget → conversation.decide event budget → conversation turns
// (PROPOSED_20261016120000_conversation_reply_turns; the unrelated legacy
// public.conversation_turns is modelled and must stay untouched). Parallel workers use separate connections. Nothing is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import pg from 'pg'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createPgTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { CONVERSATION_TURN_KIND, handleConversationEvent, recoverDueTurns, runDueTurn } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler } from '../../src/lib/ai/conversation-turn-handler.js'

const skip = pgAvailable() ? false : skipReason
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz, delivered_at timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`
const TZ = 'America/Chicago'
const LEGACY_TURNS_FIXTURE = path.join(REPO_DIR, 'scripts/db/fixtures/legacy_conversation_turns_baseline.sql')
const LEGACY_SHAPE_SQL = `select string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C") shape
                            from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns'`

async function turnsDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await db.pool.query(PUBLIC_FIXTURE)
  // the UNRELATED legacy public.conversation_turns (phase-3) exists in production: model it
  await runSqlFile(db.pool, LEGACY_TURNS_FIXTURE)
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  return db
}
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows
const iso = (d) => new Date(d).toISOString()

test('PG turns: the engine writes public.conversation_reply_turns only — the legacy public.conversation_turns keeps its 10 columns and rows', { skip }, async () => {
  const db = await turnsDb()
  try {
    const shape0 = (await sel(db.pool, LEGACY_SHAPE_SQL))[0].shape
    assert.equal(shape0.split(',').length, 10, shape0)
    const backend = createPgTurnStore(db.pool)
    const past = iso(Date.now() - 60_000)
    const r = await backend.open({ thread_key: '+15555550109', inbound_id: 'l1', inbound_at: iso(Date.now() - 120_000), due_at: past })
    assert.equal((await sel(db.pool, `select count(*)::int n from public.conversation_reply_turns where turn_id = $1`, [r.turn_id]))[0].n, 1)
    assert.equal((await backend.peekOpen('+15555550109')).turn_id, r.turn_id)
    assert.equal((await sel(db.pool, LEGACY_SHAPE_SQL))[0].shape, shape0, 'legacy column set unchanged')
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.conversation_turns'))[0].n, 3, 'legacy rows untouched')
  } finally { await db.drop() }
})

test('PG turns: one reply per turn under 8 parallel workers — one claim, one finalize, every member reserved exactly once', { skip }, async () => {
  const db = await turnsDb()
  try {
    const backend = createPgTurnStore(db.pool)
    const past = iso(Date.now() - 60_000)
    await backend.open({ thread_key: '+15555550101', inbound_id: 'm1', inbound_at: iso(Date.now() - 120_000), due_at: past })
    const r = await backend.open({ thread_key: '+15555550101', inbound_id: 'm2', inbound_at: iso(Date.now() - 90_000), due_at: past })
    const workers = Array.from({ length: 8 }, () => db.trackPool(new pg.Pool({ connectionString: db.url, max: 1 })))
    const decided = []
    const outs = await Promise.all(workers.map((pool, i) => runDueTurn({
      turn_id: r.turn_id, version: 2, store: createPgTurnStore(pool), worker: `w${i}`,
      decideTurn: async () => { decided.push(i); await new Promise((res) => setTimeout(res, 20)); return { outcome: 'REPLY_CANDIDATE', reply: { text: 'Thanks. Would you consider selling it?' } } },
      dispatch: async () => ({ status: 'enqueued' }),
    })))
    const codes = outs.map((o) => o.code)
    assert.equal(codes.filter((c) => c === 'TURN_DISPATCHED').length, 1, JSON.stringify(codes))
    assert.equal(decided.length, 1, 'exactly one worker decided')
    const res = await sel(db.pool, `select key, metadata->>'turn_id' t from public.idempotency_ledger where scope = 'inbound_reply' order by key`)
    assert.deepEqual(res.map((x) => [x.key, x.t]), [['m1', r.turn_id], ['m2', r.turn_id]])
    assert.equal((await sel(db.pool, `select state from public.conversation_reply_turns where turn_id = $1`, [r.turn_id]))[0].state, 'decided')
  } finally { await db.drop() }
})

test('PG turns: 10 parallel inbounds of one seller ⇒ ONE turn at version 10 (advisory-locked); a template reservation racing the finalize ⇒ exactly one owner', { skip }, async () => {
  const db = await turnsDb()
  try {
    const pools = Array.from({ length: 10 }, () => db.trackPool(new pg.Pool({ connectionString: db.url, max: 1 })))
    const past = iso(Date.now() - 60_000)
    const outs = await Promise.all(pools.map((pool, i) => createPgTurnStore(pool).open({ thread_key: '+15555550102', inbound_id: `b${i}`, inbound_at: iso(Date.now() - 100_000 + i * 1000), due_at: past })))
    assert.equal(new Set(outs.map((o) => o.turn_id)).size, 1)
    const row = (await sel(db.pool, `select version, cardinality(inbound_ids) n from public.conversation_reply_turns where thread_key = '+15555550102'`))
    assert.deepEqual(row, [{ version: 10, n: 10 }])
    // duplicate deliveries of the same inbound in parallel: no version bump
    await Promise.all(pools.slice(0, 5).map((pool) => createPgTurnStore(pool).open({ thread_key: '+15555550102', inbound_id: 'b3', inbound_at: past, due_at: past })))
    assert.equal((await sel(db.pool, `select version from public.conversation_reply_turns where thread_key = '+15555550102'`))[0].version, 10)

    // race: the template path claims ONE member through the existing idempotency_begin while the turn finalizes
    const store = createPgTurnStore(db.pool)
    const claim = await store.claim({ turn_id: outs[0].turn_id, version: 10, worker: 'w1' })
    assert.ok(claim.ok)
    const [fin, tpl] = await Promise.all([
      createPgTurnStore(pools[1]).finalize({ turn_id: outs[0].turn_id, token: claim.token, version: 10, outcome: 'reply:reply_candidate', reserve: true, reply_origin: 'ai_generated' }),
      pools[2].query(`select public.idempotency_begin('inbound_reply', 'b7', null, 'template_auto_reply', '{"engine":"template"}'::jsonb, 86400000, null) r`).then((x) => x.rows[0].r),
    ])
    const turnWon = fin.reserved === true
    const templateWon = tpl.duplicate === false
    assert.ok(turnWon !== templateWon, `exactly one owner: ${JSON.stringify({ fin, tpl })}`)
    const owners = await sel(db.pool, `select key, summary from public.idempotency_ledger where scope = 'inbound_reply'`)
    if (turnWon) assert.equal(owners.length, 10)
    else { assert.deepEqual(owners.map((o) => [o.key, o.summary]), [['b7', 'template_auto_reply']]); assert.equal(fin.state, 'answered_elsewhere') }
  } finally { await db.drop() }
})

test('PG turns: restart recovery — the job row IS the schedule (not claimable before due); after a "restart" (new pools) the due job decides once; a lost enqueue is recovered by the sweep', { skip }, async () => {
  const db = await turnsDb()
  try {
    let backend = createPgTurnStore(db.pool)
    let runtime = createRuntimePgStore({ pool: db.api })
    const now = iso(Date.now())
    const r = await handleConversationEvent({ event: { kind: 'inbound', thread_key: '+15555550103', inbound: { id: 'c1', at: now, body: 'Yes I still own it' } }, store: backend, enqueueAt: (o) => runtime.enqueueEventAt(o), planArgs: { timezone: TZ }, now })
    assert.equal(r.code, 'TURN_OPENED', JSON.stringify(r))
    const job = (await sel(db.pool, `select job_id, next_attempt_at, input from agent.research_job where kind = $1`, [CONVERSATION_TURN_KIND]))[0]
    assert.ok(Math.abs(Date.parse(job.next_attempt_at) - Date.parse(r.due_at)) < 1000, 'next_attempt_at = the planned due time')
    assert.ok((await sel(db.pool, `select agent.payload_is_clean(input) ok from agent.research_job where job_id = $1`, [job.job_id]))[0].ok)
    const decided = []
    const handlers = () => ({ [CONVERSATION_TURN_KIND]: createConversationTurnHandler({ store: backend, decide: async (c) => { decided.push(c.version); return { code: 'SHADOW_RECORDED', outcome: 'REPLY_CANDIDATE' } } }) })
    const early = await runRuntimeTick({ store: runtime, handlers: handlers(), workerId: 'w1', budgetMs: 5000 })
    assert.equal(early.claimed, 0, 'not claimable before due')

    // "restart": every pool and store is replaced; the clock moves past due (simulated on the rows)
    await db.pool.query(`update agent.research_job set next_attempt_at = now() - interval '1 second' where kind = $1`, [CONVERSATION_TURN_KIND])
    await db.pool.query(`update public.conversation_reply_turns set due_at = now() - interval '1 second'`)
    backend = createPgTurnStore(db.trackPool(new pg.Pool({ connectionString: db.url, max: 2 })))
    runtime = createRuntimePgStore({ pool: db.newPool(2) })
    const s = await runRuntimeTick({ store: runtime, handlers: handlers(), workerId: 'w2', budgetMs: 5000 })
    assert.equal(s.claimed, 1)
    assert.deepEqual(decided, [1])
    assert.equal((await sel(db.pool, `select state from public.conversation_reply_turns where thread_key = '+15555550103'`))[0].state, 'decided')
    const s2 = await runRuntimeTick({ store: runtime, handlers: handlers(), workerId: 'w2', budgetMs: 5000 })
    assert.equal(s2.claimed, 0, 'decided once; nothing left')

    // a lost enqueue: the turn row exists, no job — the sweep re-enqueues, the tick decides
    const lost = await handleConversationEvent({ event: { kind: 'inbound', thread_key: '+15555550104', inbound: { id: 'd1', at: now, body: 'yes' } }, store: backend, enqueueAt: async () => ({ ok: false, reason: 'enqueue_lost' }), planArgs: { timezone: TZ }, now })
    assert.equal(lost.job.ok, false)
    await db.pool.query(`update public.conversation_reply_turns set due_at = now() - interval '5 minutes' where thread_key = '+15555550104'`)
    const rec = await recoverDueTurns({ store: backend, enqueueAt: (o) => runtime.enqueueEventAt(o), now: iso(Date.now()) })
    assert.deepEqual([rec.due, rec.enqueued], [1, 1])
    const again = await recoverDueTurns({ store: backend, enqueueAt: (o) => runtime.enqueueEventAt(o), now: iso(Date.now()) })
    assert.equal(again.deduped + again.enqueued, 1)
    await runRuntimeTick({ store: runtime, handlers: handlers(), workerId: 'w3', budgetMs: 5000 })
    assert.equal((await sel(db.pool, `select state from public.conversation_reply_turns where thread_key = '+15555550104'`))[0].state, 'decided')
    assert.deepEqual(decided, [1, 1])
    // a stop request cancels the open turn immediately, no job
    const t = await handleConversationEvent({ event: { kind: 'inbound', thread_key: '+15555550105', inbound: { id: 'e1', at: now, body: 'yes' } }, store: backend, enqueueAt: (o) => runtime.enqueueEventAt(o), planArgs: { timezone: TZ }, now })
    const before = (await sel(db.pool, `select count(*)::int n from agent.research_job where kind = $1`, [CONVERSATION_TURN_KIND]))[0].n
    const stop = await handleConversationEvent({ event: { kind: 'inbound', thread_key: '+15555550105', inbound: { id: 'e2', at: now, body: 'STOP' } }, store: backend, enqueueAt: (o) => runtime.enqueueEventAt(o), planArgs: { timezone: TZ }, now })
    assert.deepEqual([stop.code, stop.cancelled], ['SUPPRESSED_NOW', 1])
    assert.equal((await sel(db.pool, `select state from public.conversation_reply_turns where turn_id = $1`, [t.turn_id]))[0].state, 'cancelled')
    assert.equal((await sel(db.pool, `select count(*)::int n from agent.research_job where kind = $1`, [CONVERSATION_TURN_KIND]))[0].n, before)
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.send_queue'))[0].n, 0, 'nothing queued, nothing sent')
  } finally { await db.drop() }
})
