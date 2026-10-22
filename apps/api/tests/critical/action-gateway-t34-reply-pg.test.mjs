// Action Gateway T3: queue_authorized_reply END TO END on a DISPOSABLE PostgreSQL 17 (t34Db: #26 + the R3 / turn
// world + the negotiation tables + the PROPOSED T3 / T4 link). The production AI send capability is activated in the
// disposable database ONLY. Gateway (AS lc_action_gateway) → approval (the existing human decide path) → the handoff
// domain write (one runtime job) → LeadCommand's worker (decideAndCompose → validator → R3 → the canonical queue
// writer) → the REAL queue runner with a SIMULATED provider. Any fetch / TextGrid credential read fails the test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { API_DIR } from '../pg/agent-pg-harness.mjs'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { t34Db } from '../helpers/action-gateway-t34-pg.mjs'
import { makeGateway, trapTransport, intentRow } from '../helpers/action-gateway-pg.mjs'
import { simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { seedT34, agent, replyThread, approveAndRetry, worker, receipt, aiRows, workItems, replySwitches, liveDispatch, dispatchQueued, provider as replyProvider, setControls, sel, REPLY_TEXT, SELLER, OURS, crypto } from '../helpers/action-gateway-t34-world.mjs'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null) // the REAL registry answers every hold check

async function world({ switches = replySwitches() } = {}) {
  const env = await t34Db()
  await seedT34(env)
  await setControls(env.owner, switches)
  const cred = await agent(env)
  const t = await replyThread(env)
  return { env, cred, t }
}

test('PG T3: capability OFF (kill switch / policy absent) ⇒ capability_unavailable, whatever the grants; nothing is written', { skip }, async () => {
  const { env, cred, t } = await world({ switches: {} })
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-off-01', thread_id: t.thread_id } })
    assert.equal(r.ok, false)
    assert.deepEqual([r.error.class, r.error.code], ['unavailable', 'capability_unavailable'], JSON.stringify(r))
    await setControls(env.owner, { ai_conversation_send_enabled: 'true' }) // policy still absent: NO-GO
    const r2 = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-off-02', thread_id: t.thread_id } })
    assert.equal(r2.error.code, 'capability_unavailable')
    // no grant at all: still capability_unavailable (availability is checked before grants)
    const bare = await agent(env, { agent_id: 'agt_bare', grants: [] })
    assert.equal((await gateway.call({ credential: bare, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-off-03', thread_id: t.thread_id } })).error.code, 'capability_unavailable')
    assert.equal((await sel(env.owner, 'select count(*)::int n from action_gateway.action_intents'))[0].n, 0)
    assert.equal((await sel(env.owner, 'select count(*)::int n from public.send_queue where message_origin = $1', ['ai_generated']))[0].n, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T3 happy path: approval (human) → handoff (one job) → canonical decideAndCompose → R3 → ONE queued AI row on the thread\'s persona + sender → the REAL runner sends exactly once (simulated provider); replays write nothing new', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const args = { client_request_id: 'reply-happy-01', thread_id: t.thread_id }
    const { first, decided, final } = await approveAndRetry(env, gateway, cred, 'queue_authorized_reply', args)
    assert.equal(first.status, 'approval_pending', JSON.stringify(first))
    assert.equal(first.code, 'TIER_REQUIRES_APPROVAL')
    assert.equal(decided.ok, true, JSON.stringify(decided))
    assert.equal(final.ok, true, JSON.stringify(final))
    assert.equal(final.code, 'HANDOFF_QUEUED')
    const rec0 = await receipt(env, final.intent_id)
    assert.equal(rec0.state, 'requested')
    assert.equal((await aiRows(env)).length, 0, 'the gateway itself queues nothing')
    const w = worker(env)
    const tk = await w.tick()
    assert.equal(tk.jobs?.[0]?.outcome, 'completed', JSON.stringify(tk))
    const rec = await receipt(env, final.intent_id)
    assert.equal(rec.state, 'enqueued', JSON.stringify(rec))
    const rows = await aiRows(env)
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].message_body, rows[0].agent_name, rows[0].from_phone_number, rows[0].to_phone_number, rows[0].queue_key], [REPLY_TEXT, 'Helen', OURS, SELLER, `ai_conversation:${t.inbound_id}`])
    assert.equal(rows[0].metadata.decision_id, `action_gateway:${final.intent_id}`)
    assert.equal(String(rec.queue_row_id), String(rows[0].id))
    // the REAL runner, simulated provider: exactly one send
    const sim = simProvider()
    await liveDispatch(env)
    const { out } = await dispatchQueued(env, w, rows[0].id, sim)
    assert.equal(sim.sent.length, 1, JSON.stringify(out).slice(0, 400))
    assert.ok(JSON.stringify(sim.sent[0]).includes(REPLY_TEXT))
    await w.execution.reconcileReceipts()
    assert.equal((await receipt(env, final.intent_id)).state, 'sent')
    // replays: the gateway returns the recorded outcome; the worker refuses a second run
    const again = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args })
    assert.equal(again.status, 'replayed')
    await w.tick()
    assert.equal((await aiRows(env)).length, 1)
    assert.deepEqual(net.hits, [])
    assert.deepEqual(net.credReads || [], [])
  } finally { net.restore(); await env.db.drop() }
})

/** Approve + hand off one reply; returns the intent id. */
async function handOff(env, cred, t, key = 'reply-0001') {
  const { gateway } = makeGateway(env)
  const { final } = await approveAndRetry(env, gateway, cred, 'queue_authorized_reply', { client_request_id: key, thread_id: t.thread_id })
  assert.equal(final.code, 'HANDOFF_QUEUED', JSON.stringify(final))
  return final.intent_id
}
const stopInbound = (env, t, body = 'STOP') => env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
  values ($1, $2, 'inbound', $3::text, $3::text, $4::text, $5, now(), now(), $6, 'en')`, [crypto.randomUUID(), `SMstop${crypto.randomUUID().slice(0, 6)}`, t.phone, OURS, body, t.property])

test('PG T3: STOP on the latest inbound refuses BEFORE any approval is filed; a STOP arriving WHILE LeadCommand prepares the reply discards it (refused receipt, operator item, nothing queued)', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    // (a) a STOP that is already there
    const t2 = await replyThread(env, { phone: '+13125550162', property: 'p200', inboundBody: 'STOP' })
    await setControls(env.owner, replySwitches([SELLER, '+13125550162']))
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-stop-01', thread_id: t2.thread_id } })
    assert.equal(r.code, 'STOP_REQUESTED', JSON.stringify(r))
    assert.equal(r.state, 'refused')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.approval_request`))[0].n, 0, 'no approval is ever filed for a refused reply')
    // (b) a STOP that arrives during preparation (the model call is the preparation)
    const id = await handOff(env, cred, t)
    const base = replyProvider()
    const prov = { ...base, async createMessage(p, o) { await stopInbound(env, t); return base.createMessage(p, o) } }
    const w = worker(env, { prov })
    await w.tick()
    const rec = await receipt(env, id)
    assert.deepEqual([rec.state, rec.code], ['refused', 'STOP_RECEIVED_DURING_PREPARATION'], JSON.stringify(rec))
    assert.equal((await aiRows(env)).length, 0)
    assert.equal((await workItems(env)).length, 1, 'the refusal is visible to an operator')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T3: an operator hold applied BEFORE dispatch refuses — at the approval retry (policy), and on an already-queued row (the registry trigger / the REAL dispatcher: zero provider calls)', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const args = { client_request_id: 'reply-hold-01', thread_id: t.thread_id }
    const first = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args })
    await (await import('../helpers/action-gateway-pg.mjs')).humanApprovals(env).decide(first.approval.approval_id)
    await env.owner.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('op:hold-1', 'operator_hold', $1, 'operator review', 'owner', 'test')`, [t.phone])
    const retry = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args })
    assert.deepEqual([retry.state, retry.code], ['refused', 'AUTOMATION_HOLD'], JSON.stringify(retry))
    await env.owner.query(`update public.automation_holds set released_at = now(), released_by = 'owner', release_reason = 'test' where hold_key = 'op:hold-1'`).catch(async () => {
      await env.owner.query(`update public.automation_holds set released_at = now() where hold_key = 'op:hold-1'`)
    })
    // a queued row, then the hold: the runner never sends it
    const id = await handOff(env, cred, t, 'reply-hold-02')
    const w = worker(env)
    await w.tick()
    assert.equal((await receipt(env, id)).state, 'enqueued')
    await env.owner.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('op:hold-2', 'operator_hold', $1, 'operator review', 'owner', 'test')`, [t.phone])
    await liveDispatch(env)
    const sim = simProvider()
    const d = await dispatchQueued(env, w, (await aiRows(env))[0].id, sim)
    assert.equal(sim.sent.length, 0, JSON.stringify(d).slice(0, 300))
    assert.equal(d.refused_by, 'AUTOMATION_HOLD', 'the registry trigger refuses the claim of a held thread\'s row')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T3: an UNHEALTHY sender holds the row (never a different number, zero provider calls); the reconciler records the hold and raises an operator item', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const id = await handOff(env, cred, t)
    const w = worker(env)
    await w.tick()
    await liveDispatch(env, { health: 'blocked', status: 'inactive' })
    const sim = simProvider()
    const d = await dispatchQueued(env, w, (await aiRows(env))[0].id, sim)
    assert.equal(sim.sent.length, 0, JSON.stringify(d).slice(0, 400))
    const row = (await aiRows(env))[0]
    assert.equal(row.from_phone_number, OURS, 'the sender is never switched')
    await w.execution.reconcileReceipts()
    const rec = await receipt(env, id)
    assert.ok(['held', 'failed'].includes(rec.state), JSON.stringify([rec, row.queue_status]))
    assert.equal((await workItems(env)).length, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T3: an AMBIGUOUS provider accept (timeout after the request) is never resent: one provider attempt, the row is final, the receipt is outcome_unknown with a CRITICAL operator item', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const id = await handOff(env, cred, t)
    const w = worker(env)
    await w.tick()
    await liveDispatch(env)
    const sim = simProvider(['timeout', 'accept'])
    const rowId = (await aiRows(env))[0].id
    await dispatchQueued(env, w, rowId, sim)
    const again = await dispatchQueued(env, w, rowId, sim)
    assert.equal(sim.sent.length, 1, `one attempt only (${JSON.stringify(again).slice(0, 200)})`)
    await w.execution.reconcileReceipts()
    const rec = await receipt(env, id)
    assert.deepEqual([rec.state, rec.code], ['outcome_unknown', 'PROVIDER_ACCEPT_AMBIGUOUS_NOT_RETRIED'], JSON.stringify([rec, (await aiRows(env))[0].queue_status, (await aiRows(env))[0].metadata]))
    const items = await workItems(env)
    assert.deepEqual([items.length, items[0].severity], [1, 'critical'])
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T3: two agents asking to answer the SAME inbound ⇒ exactly ONE queued reply (the per-inbound reservation), the other held and visible', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const cred2 = await agent(env, { agent_id: 'agt_beta' })
    const a = await handOff(env, cred, t, 'reply-race-a1')
    const b = await handOff(env, cred2, t, 'reply-race-b1')
    const w1 = worker(env)
    const w2 = worker(env)
    await Promise.all([w1.tick('w1'), w2.tick('w2')])
    await w1.tick('w1')
    assert.equal((await aiRows(env)).length, 1)
    const states = [(await receipt(env, a)).state, (await receipt(env, b)).state].sort()
    assert.deepEqual(states, ['enqueued', 'held'], JSON.stringify(states))
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T3 (REAL SIGKILL): the worker is killed between R3\'s immutable record and the queue insert ⇒ nothing dispatched; the retried job finishes ONE row with the record\'s exact text', { skip }, async () => {
  const { env, cred, t } = await world()
  try {
    const id = await handOff(env, cred, t)
    await env.owner.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, max_concurrency_global = 2, tick_max_jobs = 4, kind_limits = $1::jsonb where id = 1`,
      [JSON.stringify({ 'action_gateway.execute': { enabled: true, max_concurrency: 2, armed_by: (await import('../helpers/action-gateway-pg.mjs')).OPERATOR } })])
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/action-gateway-t34-crash-child.mjs', env.db.url, env.db.apiUrl, 'reply'],
      { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(child.signal, 'SIGKILL', `child: ${child.status} ${child.stdout} ${String(child.stderr).slice(-800)}`)
    const recs = await sel(env.owner, `select id, message_body from public.ai_generated_messages`)
    assert.equal(recs.length, 1)
    assert.equal((await aiRows(env)).length, 0)
    await env.owner.query(`update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where state in ('claimed','running')`)
    const w = worker(env)
    await w.tick() // reap
    await env.owner.query(`update agent.research_job set next_attempt_at = clock_timestamp() where state = 'retrying'`)
    const t2 = await w.tick()
    const rows = await aiRows(env)
    assert.equal(rows.length, 1, `exactly ONE queued reply ${JSON.stringify(t2)} ${JSON.stringify(await sel(env.owner, 'select state, attempt, next_attempt_at > now() fut from agent.research_job'))} ${JSON.stringify(await receipt(env, id))}`)
    assert.equal(rows[0].message_body, recs[0].message_body)
    assert.equal((await receipt(env, id)).state, 'enqueued')
  } finally { await env.db.drop() }
})

test('PG T3 adversarial: a forged approval claim and raw SQL / routing in the arguments are refused before anything is opened; an approval never carries over to another request', { skip }, async () => {
  const { env, cred, t } = await world()
  try {
    const { gateway } = makeGateway(env)
    const forged = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-forge-1', thread_id: t.thread_id, approval_id: 'apr_00000000-0000-4000-8000-000000000001' } })
    assert.equal(forged.error.code, 'FORGED_CONTEXT')
    const sql = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-sql-01', thread_id: t.thread_id, sql: "insert into send_queue values ('x')" } })
    assert.equal(sql.error.code, 'ESCALATION_REFUSED')
    const phone = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-phone1', thread_id: t.thread_id, to_phone_number: '+13125550199' } })
    assert.equal(phone.error.code, 'INPUT_INVALID', 'no phone / sender argument exists')
    const id1 = await handOff(env, cred, t, 'reply-carry-1')
    const second = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'reply-carry-2', thread_id: t.thread_id } })
    assert.equal(second.status, 'approval_pending', 'each use needs its own human approval')
    assert.ok(id1)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents where state = 'succeeded'`))[0].n, 1)
  } finally { await env.db.drop() }
})
