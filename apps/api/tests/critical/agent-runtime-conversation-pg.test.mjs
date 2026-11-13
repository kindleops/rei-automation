// 8.5.15 — the persistent shadow runtime on a DISPOSABLE local PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it).
// Applied in order: research RO → R2 runtime (PROPOSED_20261012140000) → kind_limits
// accepts the event budget (PROPOSED_20261014121000) → event budget (PROPOSED_20261013161000) → health delivery ref (PROPOSED_20261014150000) → shadow
// tables (PROPOSED_20261013160000). The runtime runs AS agent_api; the shadow table is
// written by the backend role. Every model is a local fake ($0).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore, runtimeIdempotencyKey } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { DEFAULT_RUNTIME_HANDLERS } from '../../src/lib/agent/runtime/runtime-service.js'
import { OPS_HEALTH_CHECK_KIND } from '../../src/lib/agent/runtime/handlers/ops-health-check.js'
import { scheduleConversationAiShadow, CONVERSATION_DECIDE_KIND } from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { createConversationDecideHandler } from '../../src/lib/ai/conversation-decide-handler.js'
import { runConversationAiShadowForInbound } from '../../src/lib/ai/conversation-ai-shadow-wiring.js'
import { fakeSupabase, SID, threadTables, fakeProvider, routineDecision, semanticOk } from '../helpers/conversation-ai-runtime-fakes.mjs'

const skip = pgAvailable() ? false : skipReason
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const ON = { AI_CONVERSATION_SHADOW_ENABLED: 'true' }
const GATE_OPEN = async () => ({ enabled: true, reason: null })
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const KIND_LIMITS_FIX = MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql')
const EVENT_BUDGET = MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql')
const HEALTH_REF = MIG('PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql')
const SHADOW = MIG('PROPOSED_20261013160000_conversation_ai_shadow.sql')

const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz, delivered_at timestamptz);
  create index if not exists idx_send_queue_status_sched on public.send_queue (queue_status, scheduled_for);
  create index if not exists idx_send_queue_delivered_at on public.send_queue (delivered_at desc) where delivered_at is not null;
  revoke all on public.system_control, public.send_queue from agent_api;`

async function shadowRuntimeDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await db.pool.query(PUBLIC_FIXTURE)
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, KIND_LIMITS_FIX)
  await applyInTransaction(db.pool, EVENT_BUDGET)
  await applyInTransaction(db.pool, HEALTH_REF)
  await applyInTransaction(db.pool, SHADOW)
  return db
}
/** The runbook arming: conversation.decide max_concurrency 1, event budget $0.01, a named operator. */
const arm = (pool, { budget = '0.01', concurrency = 1, extraKinds = {} } = {}) => pool.query(
  `update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`,
  [JSON.stringify({ [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: concurrency, armed_by: OP, event_budget_cap_usd: budget }, ...extraKinds })])
const spendOn = (pool) => pool.query('update agent.research_limits set enabled = true where id = 1')
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

/** Supabase-shaped access to the REAL public.conversation_ai_shadow_decisions table (everything else: the read-only fake). */
function pgBackedSupabase(pool, tables) {
  const fake = fakeSupabase(tables)
  return {
    log: fake.log,
    from(table) {
      if (table !== 'conversation_ai_shadow_decisions') return fake.from(table)
      let key = null
      const q = {
        select: () => q,
        eq: (_c, v) => { key = v; return q },
        limit: async () => {
          try { return { data: (await pool.query('select record from public.conversation_ai_shadow_decisions where idempotency_key = $1 limit 1', [key])).rows, error: null } } catch (e) { return { data: null, error: e } }
        },
        upsert: (row) => ({
          select: async () => {
            fake.log.writes.push({ table, row: { idempotency_key: row.idempotency_key } })
            const cols = Object.keys(row)
            const vals = cols.map((c) => (c === 'record' ? JSON.stringify(row[c]) : row[c]))
            try {
              const r = await pool.query(`insert into public.conversation_ai_shadow_decisions (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) on conflict (idempotency_key) do nothing returning idempotency_key`, vals)
              return { data: r.rows, error: null }
            } catch (e) { if (process.env.DBG) console.error('SHADOW_INSERT', e.message); return { data: null, error: e } }
          },
        }),
      }
      return q
    },
  }
}
const decideHandler = ({ pool, tables, provider }) => createConversationDecideHandler({ env: ON, run: (args) => runConversationAiShadowForInbound({ ...args, supabase: pgBackedSupabase(pool, tables), provider }) })
async function drain(store, handlers, max = 8) {
  const ticks = []
  for (let i = 0; i < max; i += 1) {
    const s = await runRuntimeTick({ store, handlers, workerId: 'agent-runtime-tick', budgetMs: 15_000 })
    ticks.push(s)
    if (!s.claimed) break
  }
  return ticks
}
const routine = (p) => (p.max_tokens === 200 ? semanticOk : routineDecision())

test('PG shadow runtime: hook → runtime_enqueue_event → tick (max_concurrency 1) → handler → shadow row; one job per inbound VERSION; $0.01 per routine reply settled in agent.spend_ledger; nothing sent', { skip }, async () => {
  const db = await shadowRuntimeDb()
  try {
    await arm(db.pool)
    await spendOn(db.pool)
    const tables = threadTables()
    const in2 = { ...tables.message_events.at(-1), id: 'in-2', provider_message_sid: 'SMsecond2', message_body: 'Maybe, what are you thinking?', created_at: new Date().toISOString() }
    tables.message_events.push(in2)
    const body1 = tables.message_events.find((m) => m.id === 'in-1').message_body
    const store = createRuntimePgStore({ pool: db.api })
    let pending = []
    const opts = { env: ON, getStore: async () => store, gate: GATE_OPEN, defer: (fn) => { pending.push(fn()) } }
    for (let i = 0; i < 3; i += 1) scheduleConversationAiShadow({ providerMessageSid: SID, messageBody: body1, deterministic: { intent: 'asks_offer' } }, opts) // repeat webhooks
    scheduleConversationAiShadow({ providerMessageSid: SID, messageBody: `${body1} ` }, opts) // whitespace drift: same version
    scheduleConversationAiShadow({ providerMessageSid: SID, messageBody: 'an edited body the store does not hold' }, opts) // stale version
    scheduleConversationAiShadow({ providerMessageSid: SID, messageBody: body1, revision: 1 }, opts) // explicit reprocess
    scheduleConversationAiShadow({ providerMessageSid: 'SMsecond2', messageBody: in2.message_body }, opts)
    await Promise.all(pending)
    const jobs = await sel(db.pool, `select job_id, budget_cap_usd::float8 cap, max_attempts, input from agent.research_job where kind = $1 order by created_at`, [CONVERSATION_DECIDE_KIND])
    assert.equal(jobs.length, 4, 'four versions → four jobs (three duplicates deduped)')
    assert.ok(jobs.every((j) => j.cap === 0.01 && j.max_attempts === 3), JSON.stringify(jobs.map((j) => [j.cap, j.max_attempts])))
    assert.ok((await sel(db.pool, 'select bool_and(agent.payload_is_clean(input)) ok from agent.research_job where kind = $1', [CONVERSATION_DECIDE_KIND]))[0].ok)

    const provider = fakeProvider(routine)
    const handlers = { [CONVERSATION_DECIDE_KIND]: decideHandler({ pool: db.pool, tables, provider }) }
    const ticks = await drain(store, handlers)
    assert.ok(ticks.filter((t) => t.claimed).every((t) => t.claimed === 1), 'max_concurrency 1: never two conversation.decide jobs in one claim')
    const done = await sel(db.pool, `select state, result, last_error from agent.research_job where kind = $1 order by created_at`, [CONVERSATION_DECIDE_KIND])
    assert.ok(done.every((j) => j.state === 'completed'), JSON.stringify(done))
    const codes = done.map((j) => j.result.code)
    assert.equal(codes.filter((c) => c === 'SHADOW_RECORDED').length, 2)
    assert.equal(codes.filter((c) => c === 'INBOUND_VERSION_MISMATCH').length, 1)
    assert.equal(codes.filter((c) => c === 'PRIOR_VERSION_RECORDED').length, 1)
    // rc-8.5.21: the canonical runtime — one understanding call per recorded inbound; both inbounds
    // ask for an offer (human-bound: the negotiation authority, never model text), so no composition
    assert.equal(provider.calls.length, 2, 'two recorded inbound × one understanding call; duplicates and stale versions never call a model')

    const rows = await sel(db.pool, `select inbound_message_id, send_status, outcome, cost_usd::float8 cost, record->>'inbound_version' v, record->>'writer_version' w from public.conversation_ai_shadow_decisions order by inbound_message_id`)
    assert.deepEqual(rows.map((r) => [r.inbound_message_id, r.send_status, r.outcome]), [['in-1', 'not_sent_shadow', 'NEEDS_REVIEW'], ['in-2', 'not_sent_shadow', 'NEEDS_REVIEW']])
    assert.ok(rows.every((r) => r.w === 'conv-ai.pipeline.v2+playbook.v3+compose.v3'), JSON.stringify(rows))
    assert.ok(rows.every((r) => /^[a-p]{16}$/.test(r.v)))
    const ledger = await sel(db.pool, `select job_id, state, reserved_usd::float8 r, actual_usd::float8 a from agent.spend_ledger order by created_at`)
    assert.equal(ledger.length, 2)
    assert.ok(ledger.every((l) => l.state === 'settled' && l.r <= 0.01))
    const perJob = Object.values(ledger.reduce((m, l) => ({ ...m, [l.job_id]: (m[l.job_id] || 0) + l.a }), {}))
    assert.ok(perJob.every((usd) => usd <= 0.01), JSON.stringify(perJob))
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.send_queue'))[0].n, 0, 'nothing queued, nothing sent')
    assert.ok((await sel(db.pool, `select count(*)::int n from agent.runtime_heartbeat`))[0].n >= 1, 'every tick heartbeats')
  } finally { await db.drop() }
})

test('PG shadow runtime: spend — a Haiku ESCALATE is a NEEDS_REVIEW hold, Sonnet never attempted, Haiku spend only; spend switch off / day cap ⇒ budget_blocked, no record, no call; caps $10/day, $150/cycle, $2.50/run are CHECK-bounded; event budget clamps at $0.05', { skip }, async () => {
  const db = await shadowRuntimeDb()
  try {
    await arm(db.pool)
    const store = createRuntimePgStore({ pool: db.api })
    const tables = threadTables()
    const body = tables.message_events.at(-1).message_body
    const enqueue = async (sid, b = body) => { let p; scheduleConversationAiShadow({ providerMessageSid: sid, messageBody: b }, { env: ON, getStore: async () => store, gate: GATE_OPEN, defer: (fn) => { p = fn() } }); await p }

    // 1. spend switch off (research_limits.enabled = false, the shipped default) ⇒ budget_blocked at the first reservation
    await enqueue(SID)
    let provider = fakeProvider(routine)
    let t = await drain(store, { [CONVERSATION_DECIDE_KIND]: decideHandler({ pool: db.pool, tables, provider }) })
    assert.equal(t[0].jobs[0].outcome, 'budget_blocked', JSON.stringify(t[0]))
    assert.equal(provider.calls.length, 0)
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.conversation_ai_shadow_decisions'))[0].n, 0)
    assert.equal((await sel(db.pool, 'select count(*)::int n from agent.spend_ledger'))[0].n, 0)
    assert.equal((await sel(db.pool, `select last_error->>'code' c from agent.research_job where kind = $1`, [CONVERSATION_DECIDE_KIND]))[0].c, 'AGENT_RESEARCH_DISABLED')

    // 2. spend on, escalation: Haiku asks for Sonnet without a reply candidate ⇒ human hold, no Sonnet call
    await spendOn(db.pool)
    const jid = (await sel(db.pool, `select job_id from agent.research_job where kind = $1`, [CONVERSATION_DECIDE_KIND]))[0].job_id
    assert.equal((await store.requeue({ job_id: jid, by: OP })).state, 'queued')
    provider = fakeProvider(() => routineDecision({ outcome: 'ESCALATE_TO_SONNET', escalation_required: true, escalation_reason: 'complex_negotiation', proposed_message: null }))
    t = await drain(store, { [CONVERSATION_DECIDE_KIND]: decideHandler({ pool: db.pool, tables, provider }) })
    assert.equal(t[0].jobs[0].outcome, 'completed', JSON.stringify(t[0]))
    assert.equal(provider.calls.length, 1)
    assert.equal(provider.calls[0].model, 'claude-haiku-5-5')
    const rec = (await sel(db.pool, `select outcome, draft_text, record from public.conversation_ai_shadow_decisions`))[0]
    assert.equal(rec.outcome, 'NEEDS_REVIEW')
    assert.equal(rec.draft_text, null)
    // 8.5.15 b8e00ad1 (Sonnet only for a REPLY_CANDIDATE) + 8.5.16 (no Sonnet on a human-bound turn):
    // a Haiku ESCALATE is a human hold, Sonnet is never attempted. The $0.01 budget refusal of a
    // Sonnet attempt is covered by conversation-ai-shadow-runtime-8515.test.mjs (rc-8.5.20).
    // rc-8.5.21: the canonical record names the evidence-backed reason (the model's claim kept)
    assert.equal(rec.record.decision.terminal.reason, 'missing_negotiation_authority', JSON.stringify(rec.record.decision.terminal))
    // the offer request is the negotiation authority's step (the stub has no envelope)
    assert.equal(rec.record.decision.terminal.evidence.request, 'offer_request')
    assert.equal(rec.record.model.path, 'canonical:haiku')
    const led = await sel(db.pool, `select model, state, reserved_usd::float8 r from agent.spend_ledger`)
    assert.deepEqual(led.map((l) => [l.model, l.state]), [['claude-haiku-5-5', 'settled']])

    // 3. the shared day cap reached ⇒ the next inbound parks budget_blocked (never a partial record)
    await db.pool.query('update agent.research_limits set day_usd = 0.0001 where id = 1')
    const t2 = threadTables({ body: 'Second message' })
    const in3 = { ...t2.message_events.at(-1), id: 'in-3', provider_message_sid: 'SMthird3' }
    t2.message_events.push(in3)
    await enqueue('SMthird3', in3.message_body)
    provider = fakeProvider(routine)
    t = await drain(store, { [CONVERSATION_DECIDE_KIND]: decideHandler({ pool: db.pool, tables: t2, provider }) })
    assert.equal(t[0].jobs[0].outcome, 'budget_blocked')
    assert.equal(provider.calls.length, 0)
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.conversation_ai_shadow_decisions'))[0].n, 1)

    // 4. the hard caps are CHECK constraints (lower-only): $10/day, $150/cycle, $2.50/run
    for (const [col, v] of [['day_usd', 10.01], ['cycle_usd', 150.01], ['run_usd', 2.51]]) {
      await assert.rejects(db.pool.query(`update agent.research_limits set ${col} = $1 where id = 1`, [v]), /check/i, col)
    }
    // 5. the event budget is clamped to $0.05 whatever the arming says
    await arm(db.pool, { budget: '9' })
    await enqueue('SMclamp', 'x')
    assert.equal((await sel(db.pool, `select budget_cap_usd::float8 c from agent.research_job where kind = $1 order by created_at desc limit 1`, [CONVERSATION_DECIDE_KIND]))[0].c, 0.05)
  } finally { await db.drop() }
})

test('PG shadow runtime: retry with backoff → dead_letter after 3 attempts; a worker that died mid-job is reaped and the job completes on restart, exactly one record', { skip }, async () => {
  const db = await shadowRuntimeDb()
  try {
    await arm(db.pool)
    await spendOn(db.pool)
    const store = createRuntimePgStore({ pool: db.api })
    const tables = threadTables()
    const body = tables.message_events.at(-1).message_body
    let p
    scheduleConversationAiShadow({ providerMessageSid: SID, messageBody: body }, { env: ON, getStore: async () => store, gate: GATE_OPEN, defer: (fn) => { p = fn() } })
    await p
    const jid = (await sel(db.pool, `select job_id from agent.research_job where kind = $1`, [CONVERSATION_DECIDE_KIND]))[0].job_id

    // transient failure (the context store is down) every attempt
    const failing = { [CONVERSATION_DECIDE_KIND]: createConversationDecideHandler({ env: ON, run: async () => { throw Object.assign(new Error('down'), { code: 'CONTEXT_READ_FAILED' }) } }) }
    const states = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const s = await runRuntimeTick({ store, handlers: failing, workerId: 'agent-runtime-tick', budgetMs: 10_000 })
      assert.equal(s.claimed, 1)
      const j = (await sel(db.pool, 'select state, attempt, next_attempt_at, updated_at, last_error from agent.research_job where job_id = $1', [jid]))[0]
      states.push([j.state, j.attempt, j.last_error?.code])
      if (j.state === 'retrying') {
        assert.ok(Date.parse(j.next_attempt_at) > Date.parse(j.updated_at), 'backoff')
        assert.equal((await runRuntimeTick({ store, handlers: failing, workerId: 'agent-runtime-tick', budgetMs: 5_000 })).claimed, 0, 'not claimable during backoff')
        await db.pool.query('update agent.research_job set next_attempt_at = clock_timestamp() where job_id = $1', [jid])
      }
    }
    assert.deepEqual(states, [['retrying', 1, 'CONTEXT_READ_FAILED'], ['retrying', 2, 'CONTEXT_READ_FAILED'], ['dead_letter', 3, 'CONTEXT_READ_FAILED']])
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.conversation_ai_shadow_decisions'))[0].n, 0)

    // manual requeue; the worker claims, then dies (no finish, lease never renewed)
    await store.requeue({ job_id: jid, by: OP })
    const c = await store.claim({ worker: 'agent-runtime-tick', limit: 1, kinds: [CONVERSATION_DECIDE_KIND] })
    assert.equal(c.claimed.length, 1)
    await store.start({ job_id: jid, token: c.claimed[0].lease_token })
    await db.pool.query("update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where job_id = $1", [jid])
    // restart: the next tick reaps the stale lease (→ retrying, backoff), then a later tick runs it
    const provider = fakeProvider(routine)
    const ok = { [CONVERSATION_DECIDE_KIND]: decideHandler({ pool: db.pool, tables, provider }) }
    const r1 = await runRuntimeTick({ store, handlers: ok, workerId: 'agent-runtime-tick', budgetMs: 10_000 })
    assert.equal(r1.reaped?.retrying, 1, JSON.stringify(r1.reaped))
    assert.equal((await sel(db.pool, 'select state from agent.research_job where job_id = $1', [jid]))[0].state, 'retrying')
    await db.pool.query('update agent.research_job set next_attempt_at = clock_timestamp() where job_id = $1', [jid])
    const r2 = await runRuntimeTick({ store, handlers: ok, workerId: 'agent-runtime-tick', budgetMs: 15_000 })
    assert.equal(r2.jobs[0].outcome, 'completed', JSON.stringify(r2))
    // a second worker / replay of the same job id finds the record: no second decision
    await store.requeue({ job_id: jid, by: OP }).catch(() => null)
    assert.equal((await sel(db.pool, 'select count(*)::int n from public.conversation_ai_shadow_decisions'))[0].n, 1)
    assert.equal(provider.calls.length, 1, 'rc-8.5.21: one understanding call (an offer request composes nothing)')
    const ev = (await store.jobEvents(jid)).map((x) => x.type)
    assert.ok(ev.includes('job.lease_expired') && ev.includes('job.dead_letter') && ev.includes('job.requeued') && ev.at(-1) === 'job.completed', ev.join(','))
  } finally { await db.drop() }
})

test('PG health: agent.ops_health_snapshot carries the newest delivery; an 8 h quiet night is no finding, deliveries an hour past the heartbeat are', { skip }, async () => {
  const db = await shadowRuntimeDb()
  try {
    const iso = (sql) => `to_char((${sql}) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    await db.pool.query(`insert into public.system_control (key, value) values
      ('queue_processor_heartbeat_at', ${iso('now()')}), ('campaign_feeder_heartbeat_at', ${iso('now()')}),
      ('followup_no_response_heartbeat_at', ${iso("now() - interval '8 hours'")}),
      ('seller_state_reconcile_heartbeat_at', ${iso('now()')}), ('webhook_delivery_recovery_last_at', ${iso('now()')})`)
    await db.pool.query(`insert into public.send_queue (queue_status, delivered_at) values ('delivered', now() - interval '8 hours 1 minute'), ('delivered', now() - interval '9 hours')`)
    await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`, [JSON.stringify({ [OPS_HEALTH_CHECK_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } })])
    const store = createRuntimePgStore({ pool: db.api })
    const snap = await store.healthSnapshot()
    assert.ok(snap.deliveries && 'last_delivered_at' in snap.deliveries, JSON.stringify(snap))
    const run = async (k) => {
      const e = await store.enqueue({ kind: OPS_HEALTH_CHECK_KIND, idempotency_key: runtimeIdempotencyKey('pg-health', k), requested_by: OP })
      assert.ok(e.job_id, JSON.stringify(e))
      await runRuntimeTick({ store, handlers: DEFAULT_RUNTIME_HANDLERS, workerId: 'agent-runtime-tick', budgetMs: 10_000 })
      const j = (await sel(db.pool, 'select job_id, result from agent.research_job where kind = $1 order by created_at desc limit 1', [OPS_HEALTH_CHECK_KIND]))[0]
      const f = await sel(db.pool, 'select finding_type, key, value from agent.finding where job_id = $1', [j.job_id])
      return { j, f }
    }
    const night = await run('h1')
    assert.equal(night.j.result.heartbeats.followup_no_response_heartbeat_at, 'fresh')
    assert.equal(night.f.length, 0, JSON.stringify(night.f))
    await db.pool.query(`insert into public.send_queue (queue_status, delivered_at) values ('delivered', now() - interval '7 hours')`)
    const bad = await run('h2')
    assert.deepEqual(bad.f.map((x) => `${x.finding_type}:${x.key}`), ['ops.heartbeat_stale:followup_no_response_heartbeat_at'])
    assert.ok(bad.f[0].value.lag_seconds >= 3590 && bad.f[0].value.lag_seconds <= 3660, JSON.stringify(bad.f[0].value))
  } finally { await db.drop() }
})
