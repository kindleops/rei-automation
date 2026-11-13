// Operation Hidden Gold (link #29) END TO END on a DISPOSABLE PostgreSQL 17 (t34Db + the PROPOSED OHG link): the
// acquisitions family an agent runs ON ITS OWN under standing grants — a lead temperature and an operational status
// through the handoff to LeadCommand's worker (the canonical lead-state registry), conversation notes and seller-stated
// facts in the append-only ledger — and the delivery read behind sms_get_delivery_status over a reply the worker
// queued and the REAL runner sent to a SIMULATED provider. Any fetch / TextGrid credential read fails the test.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { t34Db } from '../helpers/action-gateway-t34-pg.mjs'
import { makeGateway, trapTransport, registerAgent, outcomeRow, MIG } from '../helpers/action-gateway-pg.mjs'
import { simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { seedT34, replyThread, approveAndRetry, worker, receipt, aiRows, replySwitches, liveDispatch, dispatchQueued, setControls, sel, OURS, crypto } from '../helpers/action-gateway-t34-world.mjs'

const OHG_MIGRATION = MIG('PROPOSED_20261027120000_action_gateway_ohg.sql')
const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null) // the REAL registry answers every hold check

const OHG_GRANTS = [['acquisitions.set_lead_temperature', 2], ['acquisitions.update_lead_status', 2], ['acquisitions.record_conversation_note', 2], ['acquisitions.record_seller_statement', 2],
  ['acquisitions.read_delivery', 1], ['acquisitions.read_annotations', 1], ['conversation.queue_reply', 3]]
const SELLER_WORDS = 'Yes I still own it. I would want 185,000 for it and need to close by December'

async function world({ switches = replySwitches(), grants = OHG_GRANTS, inbound = SELLER_WORDS } = {}) {
  const env = await t34Db()
  await applyInTransaction(env.db.pool, OHG_MIGRATION)
  await seedT34(env)
  await setControls(env.owner, switches)
  const cred = await registerAgent(env.owner, { agent_id: 'agt_alpha', grants, tier_ceiling: 3, read_scopes: ['conversation_context.read'] })
  const t = await replyThread(env, { inboundBody: inbound })
  return { env, cred, t }
}
const thread = async (env, id) => (await sel(env.owner, 'select * from public.inbox_thread_state where id = $1', [id]))[0]
const approvals = async (env) => (await sel(env.owner, 'select count(*)::int n from agent.approval_request'))[0].n
const hold = (env, { key, thread_id, tk, type = 'operator_hold' }) => env.owner.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, reason, set_by, approval_ref) values ($1, $2, $3, $4, 'test hold', 'owner', 'test')`, [key, type, tk, thread_id])

test('PG OHG: set_lead_temperature / update_lead_status run under STANDING grants (no approval) → HANDOFF_QUEUED → LeadCommand\'s worker runs the canonical lead-state registry → receipt recorded, thread updated, attributed to the agent; replays write nothing; an operator lock and a hold refuse at the gateway', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const args = { client_request_id: 'ohg-temp-0001', thread_id: t.thread_id, temperature: 'warm', basis: 'seller_price', reason: 'Seller confirmed ownership and named a price' }
    const r = await gateway.call({ credential: cred, tool: 'set_lead_temperature', args })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.code, 'HANDOFF_QUEUED')
    assert.equal(await approvals(env), 0, 'standing authority: no per-use approval')
    assert.equal((await receipt(env, r.intent_id)).state, 'requested')
    assert.equal((await thread(env, t.thread_id)).lead_temperature ?? null, null, 'the gateway itself changes no pipeline field')
    const w = worker(env)
    const tk = await w.tick()
    assert.equal(tk.jobs?.[0]?.outcome, 'completed', JSON.stringify(tk))
    const rec = await receipt(env, r.intent_id)
    assert.deepEqual([rec.state, rec.code], ['recorded', 'LEAD_STATE_RECORDED'], JSON.stringify(rec))
    const row = await thread(env, t.thread_id)
    assert.equal(row.lead_temperature, 'warm')
    assert.equal(row.manual_temperature_lock, false)
    assert.match(String(row.temperature_reason || ''), /agent_standing:seller_price/)
    // replay: the recorded outcome, no second job
    const again = await gateway.call({ credential: cred, tool: 'set_lead_temperature', args })
    assert.equal(again.status, 'replayed', JSON.stringify(again))
    await w.tick()
    assert.equal((await sel(env.owner, 'select count(*)::int n from action_gateway.seller_action_receipts'))[0].n, 1)
    // the same value again is refused before any intent is opened (ALREADY_SET)
    const same = await gateway.call({ credential: cred, tool: 'set_lead_temperature', args: { ...args, client_request_id: 'ohg-temp-0002' } })
    assert.equal(same.code, 'ALREADY_SET', JSON.stringify(same))
    // operational status through the same path
    const s = await gateway.call({ credential: cred, tool: 'update_lead_status', args: { client_request_id: 'ohg-status-0001', thread_id: t.thread_id, status: 'waiting_on_seller', reason: 'Asked for the closing timeline' } })
    assert.equal(s.code, 'HANDOFF_QUEUED', JSON.stringify(s))
    await w.tick()
    const srec = await receipt(env, s.intent_id)
    assert.deepEqual([srec.state, srec.code], ['recorded', 'LEAD_STATE_RECORDED'], JSON.stringify(srec))
    assert.equal((await thread(env, t.thread_id)).operational_status, 'waiting_on_seller')
    // an operator's manual lock is final: refused at the gateway, nothing opened
    await env.owner.query('update public.inbox_thread_state set manual_temperature_lock = true where id = $1', [t.thread_id])
    const locked = await gateway.call({ credential: cred, tool: 'set_lead_temperature', args: { ...args, client_request_id: 'ohg-temp-0003', temperature: 'hot' } })
    assert.equal(locked.code, 'TEMPERATURE_LOCKED', JSON.stringify(locked))
    await env.owner.query('update public.inbox_thread_state set manual_temperature_lock = false where id = $1', [t.thread_id])
    // a hold on the thread refuses the pipeline write (the registry is THE authority)
    await hold(env, { key: 'ohg-hold-1', thread_id: t.thread_id, tk: t.phone })
    const held = await gateway.call({ credential: cred, tool: 'set_lead_temperature', args: { ...args, client_request_id: 'ohg-temp-0004', temperature: 'hot' } })
    assert.equal(held.ok, false, JSON.stringify(held))
    assert.match(String(held.code || held.error?.code), /HOLD/)
    assert.equal((await thread(env, t.thread_id)).lead_temperature, 'warm')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG OHG: notes and seller statements — a note records at once; a statement is BOUND to the seller\'s inbound and a price must be in the seller\'s words; an outbound id or an invented number is refused; get_lead_annotations lists them attributed; the ledger is append-only and masked', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const note = await gateway.call({ credential: cred, tool: 'record_conversation_note', args: { client_request_id: 'ohg-note-0001', thread_id: t.thread_id, kind: 'objection', note: 'Seller wants 185k and will not consider less before December; call them at 312-555-0161', evidence_message_id: t.inbound_id } })
    assert.equal(note.ok, true, JSON.stringify(note))
    assert.equal(note.code, 'ANNOTATION_RECORDED')
    assert.equal(await approvals(env), 0)
    const price = await gateway.call({ credential: cred, tool: 'record_seller_statement', args: { client_request_id: 'ohg-stmt-0001', thread_id: t.thread_id, inbound_message_id: t.inbound_id, kind: 'asking_price', value: '185,000 as stated', amount: 185000 } })
    assert.equal(price.code, 'STATEMENT_RECORDED', JSON.stringify(price))
    const invented = await gateway.call({ credential: cred, tool: 'record_seller_statement', args: { client_request_id: 'ohg-stmt-0002', thread_id: t.thread_id, inbound_message_id: t.inbound_id, kind: 'asking_price', value: '200,000', amount: 200000 } })
    assert.equal(invented.code, 'AMOUNT_NOT_IN_SELLER_WORDS', JSON.stringify(invented))
    const [out] = await sel(env.owner, `select id from public.message_events where thread_key = $1 and direction = 'outbound' limit 1`, [t.phone])
    const outbound = await gateway.call({ credential: cred, tool: 'record_seller_statement', args: { client_request_id: 'ohg-stmt-0003', thread_id: t.thread_id, inbound_message_id: String(out.id), kind: 'timeline', value: 'December' } })
    assert.equal(outbound.code, 'STATEMENT_NOT_BOUND_TO_INBOUND', JSON.stringify(outbound))
    const timeline = await gateway.call({ credential: cred, tool: 'record_seller_statement', args: { client_request_id: 'ohg-stmt-0004', thread_id: t.thread_id, inbound_message_id: t.inbound_id, kind: 'timeline', value: 'needs to close by December' } })
    assert.equal(timeline.code, 'STATEMENT_RECORDED', JSON.stringify(timeline))
    const list = await gateway.call({ credential: cred, tool: 'get_lead_annotations', args: { thread_id: t.thread_id } })
    assert.equal(list.ok, true, JSON.stringify(list))
    const rows = list.result.rows
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['asking_price', 'objection', 'timeline'])
    for (const r of rows) assert.equal(r.agent_id, 'agt_alpha')
    const stmt = rows.find((r) => r.kind === 'asking_price')
    assert.deepEqual([stmt.class, stmt.inbound_message_id, Number(stmt.amount)], ['seller_statement', t.inbound_id, 185000])
    const text = JSON.stringify(rows)
    assert.ok(!text.includes('555-0161') && !text.includes('5550161'), `a phone number in the ledger: ${text}`)
    assert.ok(!/0161/.test(text), 'the phone run in the note is neutralized')
    // append-only, whoever asks
    await assert.rejects(env.owner.query('update action_gateway.lead_annotations set note = $1', ['edited']), /append-only/)
    await assert.rejects(env.owner.query('delete from action_gateway.lead_annotations'), /append-only/)
    // a note is allowed under a hold (it changes nothing a seller sees); the pipeline write is not
    await hold(env, { key: 'ohg-hold-2', thread_id: t.thread_id, tk: t.phone })
    const under = await gateway.call({ credential: cred, tool: 'record_conversation_note', args: { client_request_id: 'ohg-note-0002', thread_id: t.thread_id, kind: 'context', note: 'Operator hold observed; no outreach until released' } })
    assert.equal(under.code, 'ANNOTATION_RECORDED', JSON.stringify(under))
    assert.equal((await outcomeRow(env.owner, under.intent_id)).status, 'succeeded')
    // no grant: refused, nothing written
    const bare = await registerAgent(env.owner, { agent_id: 'agt_bare', grants: [], read_scopes: [] })
    const no = await gateway.call({ credential: bare, tool: 'record_conversation_note', args: { client_request_id: 'ohg-note-0003', thread_id: t.thread_id, kind: 'context', note: 'should not record' } })
    assert.equal(no.ok, false)
    assert.equal((await sel(env.owner, 'select count(*)::int n from action_gateway.lead_annotations'))[0].n, 4)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG OHG: sms delivery read — a reply approved and handed off is queued by the worker (enqueued / queued, NOT sent); after the REAL runner sends to the simulated provider it reads sent (never delivered unless the provider reported it); get_reply_delivery_status lists the lead-state handoffs beside it', { skip }, async () => {
  const { env, cred, t } = await world({ inbound: 'Yes I still own it' }) // the scripted decider replies to this turn (a priced turn is the negotiation path, not this test)
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const { final } = await approveAndRetry(env, gateway, cred, 'queue_authorized_reply', { client_request_id: 'ohg-reply-0001', thread_id: t.thread_id })
    assert.equal(final.code, 'HANDOFF_QUEUED', JSON.stringify(final))
    const before = await gateway.call({ credential: cred, tool: 'get_reply_delivery_status', args: { thread_id: t.thread_id } })
    assert.equal(before.ok, true, JSON.stringify(before))
    assert.deepEqual(before.result.rows.map((r) => [r.intent_id, r.receipt_state, r.sent, r.delivered]), [[final.intent_id, 'requested', false, false]])
    const w = worker(env)
    await w.tick()
    const queued = (await gateway.call({ credential: cred, tool: 'get_reply_delivery_status', args: { thread_id: t.thread_id } })).result.rows[0]
    assert.deepEqual([queued.receipt_state, queued.queue_status, queued.delivery_status, queued.sent, queued.delivered], ['enqueued', 'queued', 'not_sent', false, false], JSON.stringify(queued))
    const rows = await aiRows(env)
    assert.equal(rows.length, 1)
    const sim = simProvider()
    await liveDispatch(env)
    await dispatchQueued(env, w, rows[0].id, sim)
    assert.equal(sim.sent.length, 1)
    await w.execution.reconcileReceipts()
    const sent = (await gateway.call({ credential: cred, tool: 'get_reply_delivery_status', args: { thread_id: t.thread_id } })).result.rows[0]
    assert.deepEqual([sent.receipt_state, sent.sent, sent.delivered], ['sent', true, false], JSON.stringify(sent))
    assert.equal(sent.provider_message_id === undefined || sent.provider_message_id === null || sent.provider_message_id === 'present', true, 'no provider id leaks')
    // a lead-state handoff shows beside the reply, with its own receipt
    const temp = await gateway.call({ credential: cred, tool: 'set_lead_temperature', args: { client_request_id: 'ohg-temp-0101', thread_id: t.thread_id, temperature: 'hot', basis: 'seller_price', reason: 'Named a price and a timeline' } })
    assert.equal(temp.code, 'HANDOFF_QUEUED', JSON.stringify(temp))
    await w.tick()
    const all = (await gateway.call({ credential: cred, tool: 'get_reply_delivery_status', args: { thread_id: t.thread_id } })).result.rows
    assert.deepEqual(all.map((r) => [r.action, r.receipt_state]).sort(), [['queue_authorized_reply', 'sent'], ['set_lead_temperature', 'recorded']])
    assert.deepEqual(net.hits, [])
    assert.deepEqual(net.credReads || [], [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG OHG: persistence — what the agent recorded and changed survives a new gateway / worker instance (the database is the memory), and the gateway refuses the family when the T2 tier is off', { skip }, async () => {
  const { env, cred, t } = await world()
  try {
    const { gateway } = makeGateway(env)
    assert.equal((await gateway.call({ credential: cred, tool: 'record_conversation_note', args: { client_request_id: 'ohg-p-0001', thread_id: t.thread_id, kind: 'next_step', note: 'Follow up after the seller talks to their sister' } })).code, 'ANNOTATION_RECORDED')
    assert.equal((await gateway.call({ credential: cred, tool: 'set_lead_temperature', args: { client_request_id: 'ohg-p-0002', thread_id: t.thread_id, temperature: 'warm', basis: 'seller_words', reason: 'Engaged' } })).code, 'HANDOFF_QUEUED')
    await worker(env).tick()
    // a "restart": new gateway, new worker, same database
    const fresh = makeGateway(env, { worker: 'gw-after-restart' })
    const list = await fresh.gateway.call({ credential: cred, tool: 'get_lead_annotations', args: { thread_id: t.thread_id } })
    assert.equal(list.result.rows.length, 1)
    assert.equal((await thread(env, t.thread_id)).lead_temperature, 'warm')
    assert.equal((await fresh.gateway.call({ credential: cred, tool: 'get_reply_delivery_status', args: { thread_id: t.thread_id } })).result.rows[0].receipt_state, 'recorded')
    await setControls(env.owner, { action_gateway_tiers: 'T1' })
    const off = await fresh.gateway.call({ credential: cred, tool: 'record_conversation_note', args: { client_request_id: 'ohg-p-0003', thread_id: t.thread_id, kind: 'context', note: 'tier off' } })
    assert.equal(off.ok, false, JSON.stringify(off))
    assert.equal((await sel(env.owner, 'select count(*)::int n from action_gateway.lead_annotations'))[0].n, 1)
  } finally { await env.db.drop() }
})
