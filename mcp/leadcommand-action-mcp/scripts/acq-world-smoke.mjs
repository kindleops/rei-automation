#!/usr/bin/env node
// Smoke run against a RUNNING acquisitions certification world (apps/api/tests/ohg/acq-world-server.mjs): the real
// Action MCP over HTTP as the agents, the world's loopback control endpoint for the simulated seller and the pump.
// DISPOSABLE WORLD ONLY (SIMULATED provider, SCRIPTED model). Usage: node scripts/acq-world-smoke.mjs <world.json>
import fs from 'node:fs'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const world = JSON.parse(fs.readFileSync(process.argv[2] || 'world.json', 'utf8'))
const ctl = world.control.url
const S = world.seeds
const out = []
const step = (name, detail) => { out.push({ step: name, ...detail }); console.log(`ok  ${name}`, JSON.stringify(detail).slice(0, 400)) }
const http = async (method, p, body) => { const r = await fetch(`${ctl}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const agnteiKey = () => `agntei:${crypto.randomBytes(20).toString('hex')}`
async function agent(name) {
  const c = new Client({ name: `acq-smoke-${name}`, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(world.action.url), { requestInit: { headers: { Authorization: `Bearer ${fs.readFileSync(world.action.credential_files[name], 'utf8').trim()}` } } }))
  return { call: async (tool, args) => { const r = await c.callTool({ name: tool, arguments: args }); return { isError: r.isError === true, ...(r.structuredContent || {}) } }, close: () => c.close() }
}
const codeOf = (r) => r.code || r.error?.code || r.status
async function untilReceipt(ctId, intentId, states, tries = 20) {
  for (let i = 0; i < tries; i++) {
    await http('POST', '/tick')
    const t = await http('GET', `/target/${ctId}`)
    const rc = t.receipts.find((x) => x.intent_id === intentId)
    if (rc && states.includes(rc.state)) return { t, rc }
    await sleep(300)
  }
  throw new Error(`receipt for ${intentId} never reached ${states}`)
}
async function feedSince(a, cursor, pred, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const r = await a.call('leadcommand_events_since', { cursor, limit: 200 })
    const hits = (r.result?.events || []).filter(pred)
    if (hits.length) return { events: r.result.events, hits, next_cursor: r.result.next_cursor }
    await sleep(400) // the feed serves settled rows (older than one second)
  }
  throw new Error('event never appeared on the feed')
}

const sterling = await agent('sterling')
const equity = await agent('equity')
try {
  const start = (await sterling.call('leadcommand_events_since', { cursor: 0, limit: 500 })).result?.next_cursor ?? 0
  const sentBefore = (await http('GET', '/sends')).sent.length

  // 0. the pool: the same verdicts world.json recorded
  const pool = await sterling.call('leadcommand_agent_lead_pool', { market: world.market, limit: 100 })
  assert.equal(pool.isError, false, JSON.stringify(pool))
  const rowOf = (id) => pool.result.rows.find((r) => r.campaign_target_id === id || r.thread_id === id)
  assert.equal(rowOf(S.ft_a.campaign_target_id).eligible, true)
  step('pool read', { rows: pool.result.rows.length, ft_a: rowOf(S.ft_a.campaign_target_id), stopped: rowOf(S.stopped.campaign_target_id).ineligible_reason })

  // 1. sterling holds ft_a and sends a first touch → ONE simulated send
  const own = await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id })
  assert.equal(codeOf(own), 'LEAD_ASSIGNED', JSON.stringify(own))
  const ft = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id, purpose: 'first_touch', brief: 'Absentee owner on Kapiolani Blvd; long-time owner, likely open to a simple sale' })
  assert.equal(codeOf(ft), 'HANDOFF_QUEUED', JSON.stringify(ft))
  const { t: ftState, rc } = await untilReceipt(S.ft_a.campaign_target_id, ft.intent_id, ['sent', 'refused', 'held', 'failed'])
  assert.equal(rc.state, 'sent', JSON.stringify(rc))
  const sends = (await http('GET', '/sends')).sent
  assert.equal(sends.length, sentBefore + 1)
  assert.ok(ftState.thread_id, 'the first touch created the thread')
  step('1 first touch ft_a', { intent_id: ft.intent_id, receipt: rc, text: sends.at(-1).body, thread_id: ftState.thread_id, ledger: ftState.ledger.map((l) => l.record_kind) })

  // 2. the seller answers on ft_a's new thread → inbound_message on the feed (with the target's ids)
  const r2 = await http('POST', '/seller-reply', { thread_id: ftState.thread_id, body: 'Yes I still own it. Why do you ask?' })
  const f2 = await feedSince(sterling, start, (e) => e.kind === 'inbound_message' && e.payload.message_id === r2.message_id)
  const e2 = f2.hits[0]
  assert.deepEqual([e2.thread_id, e2.payload.stop_request, e2.payload.campaign_target_id, e2.payload.property_id], [ftState.thread_id, false, S.ft_a.campaign_target_id, S.ft_a.property_ref])
  const delivery = f2.events.filter((e) => e.kind === 'delivery_changed' && e.intent_id === ft.intent_id).map((e) => ({ state: e.payload.receipt_state, thread_id: e.thread_id, campaign_target_id: e.payload.campaign_target_id, property_id: e.payload.property_id }))
  step('2 seller reply on ft_a', { event: e2, delivery_changed: delivery })

  // 2b. sterling answers it (purpose answer → the certified reply)
  const ans = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: ftState.thread_id, purpose: 'answer', brief: 'they asked why we are asking' })
  assert.equal(codeOf(ans), 'HANDOFF_QUEUED', JSON.stringify(ans))
  const { t: ansState, rc: ansRc } = await untilReceipt(S.ft_a.campaign_target_id, ans.intent_id, ['sent', 'refused', 'held', 'failed'])
  step('2b answer on ft_a thread (certified reply)', { tool: ans.tool, intent_id: ans.intent_id, receipt: ansRc, text: (await http('GET', '/sends')).sent.at(-1).body, queue: ansState.queue.map((q) => q.queue_status) })

  // 3. a STOP on gold → inbound_message (stop_request) + opt_out
  const r3 = await http('POST', '/seller-reply', { thread_id: S.gold.thread_id, body: 'STOP' })
  const f3 = await feedSince(sterling, start, (e) => e.payload?.message_id === r3.message_id && e.kind === 'opt_out')
  const e3 = f3.events.filter((e) => e.payload?.message_id === r3.message_id)
  assert.deepEqual(e3.map((e) => e.kind).sort(), ['inbound_message', 'opt_out'])
  assert.equal(e3.find((e) => e.kind === 'inbound_message').payload.stop_request, true)
  step('3 STOP on gold', { events: e3.map((e) => ({ cursor: e.cursor, event_id: e.event_id, kind: e.kind, thread_id: e.thread_id, payload: e.payload })) })
  // … and an answer to gold is now refused
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: S.gold.thread_id })
  const gAns = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.gold.thread_id, purpose: 'answer', brief: 'answer the roof question' })
  step('3b answer to gold after STOP', { code: codeOf(gAns), status: gAns.status })

  // 4. a send to `stopped` → refused
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.stopped.campaign_target_id })
  const r4 = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.stopped.campaign_target_id, purpose: 'first_touch', brief: 'owner of Kaimuki Ave' })
  assert.equal(r4.status, 'refused', JSON.stringify(r4))
  step('4 send to stopped', { code: codeOf(r4), result: r4.result })

  // 5. equity (no seller-facing capability) → refused
  const r5 = await equity.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', brief: 'owner of Wilder Ave' })
  assert.ok(r5.isError || r5.status === 'refused' || r5.ok === false, JSON.stringify(r5))
  step('5 equity sends', { code: codeOf(r5), status: r5.status, error: r5.error || null })

  // extras: wrong number, the Eastern window, not holding the lead
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: S.wrong.thread_id })
  const rw = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.wrong.thread_id, purpose: 'answer', brief: 'they said wrong number' })
  const rwf = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.wrong.thread_id, purpose: 'followup', brief: 'check in' })
  step('x wrong number', { answer: { code: codeOf(rw), status: rw.status }, followup: { code: codeOf(rwf), result: rwf.result } })
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.eastern.campaign_target_id })
  const re = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.eastern.campaign_target_id, purpose: 'first_touch', brief: 'owner of Pali Hwy' })
  step('x eastern window', { code: codeOf(re), result: re.result })
  const nh = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', brief: 'owner of Wilder Ave' })
  step('x not holding ft_b', { code: codeOf(nh), result: nh.result })

  // a re-engagement of the quiet soft thread (written from its history)
  assert.equal(codeOf(await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: S.soft.thread_id })), 'LEAD_ASSIGNED')
  const rs = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.soft.thread_id, purpose: 'reengage', brief: 'Said not now, maybe in the spring once the sister moves out' })
  let softState = null
  for (let i = 0; i < 20 && codeOf(rs) === 'HANDOFF_QUEUED'; i++) { await http('POST', '/tick'); softState = await http('GET', `/state/${S.soft.thread_id}`); const it = softState.intents.find((x) => x.intent_id === rs.intent_id); if (it?.receipt_state && it.receipt_state !== 'executing' && it.receipt_state !== 'enqueued') break; await sleep(300) }
  const softIntent = softState?.intents.find((x) => x.intent_id === rs.intent_id)
  step('x reengage soft', { code: codeOf(rs), receipt: softIntent ? { state: softIntent.receipt_state, code: softIntent.receipt_code } : null, last_queued: softState?.queue.at(-1)?.message_body || null })

  // the operator's R2 emergency stop: nova's send is refused while it is engaged, then goes through
  const nova = await agent('nova')
  try {
    assert.equal(codeOf(await nova.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id })), 'LEAD_ASSIGNED')
    await http('POST', '/emergency-stop', { on: true })
    const st = await nova.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', brief: 'owner of Wilder Ave' })
    await http('POST', '/emergency-stop', { on: false })
    const go = await nova.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', brief: 'owner of Wilder Ave' })
    assert.equal(codeOf(go), 'HANDOFF_QUEUED', JSON.stringify(go))
    const { rc: goRc } = await untilReceipt(S.ft_b.campaign_target_id, go.intent_id, ['sent', 'refused', 'held', 'failed'])
    step('x emergency stop (nova, ft_b)', { while_stopped: { code: codeOf(st), status: st.status, error: st.error || null }, after_clear: goRc, text: (await http('GET', '/sends')).sent.at(-1).body })
  } finally { await nova.close() }

  console.log('SMOKE PASS')
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2))
} finally {
  await sterling.close(); await equity.close()
}
