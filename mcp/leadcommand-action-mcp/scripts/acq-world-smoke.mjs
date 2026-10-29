#!/usr/bin/env node
// Smoke run against a RUNNING acquisitions certification world (apps/api/tests/ohg/acq-world-server.mjs): the real
// Action MCP over HTTP as the agents, the world's loopback control endpoint for the simulated seller and the pump.
// DISPOSABLE WORLD ONLY (SIMULATED provider, SCRIPTED model). Usage: node scripts/acq-world-smoke.mjs <world.json> [out.json]
//
// The 08:00–21:00 recipient-local window is REAL in the world (808 seeds: 18:00–07:00 UTC). While it is closed the
// send steps assert the window refusal (with next_permitted_at) instead of a delivery; every other step runs either way.
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
const reasonOf = (r) => r.error?.details?.reason || null
async function untilState(path, pick, states, tries = 20) {
  for (let i = 0; i < tries; i++) {
    await http('POST', '/tick')
    const t = await http('GET', path)
    const rc = pick(t)
    if (rc && states.includes(rc.state)) return { t, rc }
    await sleep(300)
  }
  throw new Error(`${path}: never reached ${states}`)
}
const untilReceipt = (ctId, intentId, states) => untilState(`/target/${ctId}`, (t) => t.receipts.find((x) => x.intent_id === intentId), states)
const untilThreadReceipt = (threadId, intentId, states) => untilState(`/state/${threadId}`, (t) => { const i = t.intents.find((x) => x.intent_id === intentId); return i?.receipt_state ? { state: i.receipt_state, code: i.receipt_code } : null }, states)
async function feedSince(a, cursor, pred, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const r = await a.call('leadcommand_events_since', { cursor, limit: 200 })
    const hits = (r.result?.events || []).filter(pred)
    if (hits.length) return { events: r.result.events, hits, next_cursor: r.result.next_cursor }
    await sleep(400) // the feed serves settled rows (older than one second)
  }
  throw new Error('event never appeared on the feed')
}
const DONE = ['sent', 'refused', 'held', 'failed', 'deferred']

const sterling = await agent('sterling')
const equity = await agent('equity')
const nova = await agent('nova')
try {
  const start = (await sterling.call('leadcommand_events_since', { cursor: 0, limit: 500 })).result?.next_cursor ?? 0
  const sentBefore = (await http('GET', '/sends')).sent.length

  // 0a. the send controls: nothing stopped, everything on
  const c0 = await sterling.call('leadcommand_send_controls', {})
  assert.equal(c0.isError, false, JSON.stringify(c0))
  assert.deepEqual([c0.result.runtime_emergency_stop.on, c0.result.send_emergency_stop.on, c0.result.ai_send_enabled, c0.result.agent_message_enabled, c0.result.seller_sends], [false, false, true, true, 'enabled'])
  step('send controls', { result: c0.result })

  // 0b. the pool: the same verdicts world.json recorded; is the 808 window open right now?
  const pool = await sterling.call('leadcommand_agent_lead_pool', { market: world.market, limit: 100 })
  assert.equal(pool.isError, false, JSON.stringify(pool))
  const rowOf = (id) => pool.result.rows.find((r) => (r.campaign_target_id || r.thread_id) === id)
  assert.equal(rowOf(S.ft_a.campaign_target_id).eligible, true)
  assert.equal(rowOf(S.stopped.campaign_target_id).eligible, false)
  const open = rowOf(S.ft_a.campaign_target_id).window_open === true
  step('pool read', { rows: pool.result.rows.length, window_open_808: open, next_permitted_at: rowOf(S.ft_a.campaign_target_id).next_permitted_at, ft_a: rowOf(S.ft_a.campaign_target_id), stopped: rowOf(S.stopped.campaign_target_id).ineligible_reason })

  // 1. sterling holds ft_a and sends a first touch → ONE simulated send (window open) / the window refusal (closed)
  const own = await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id })
  assert.equal(codeOf(own), 'LEAD_ASSIGNED', JSON.stringify(own))
  const ft = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id, purpose: 'first_touch', brief: 'Absentee owner on Kapiolani Blvd; long-time owner, likely open to a simple sale' })
  let replyThread = S.soft.thread_id
  if (open) {
    assert.equal(codeOf(ft), 'HANDOFF_QUEUED', JSON.stringify(ft))
    const { t: ftState, rc } = await untilReceipt(S.ft_a.campaign_target_id, ft.intent_id, DONE)
    assert.equal(rc.state, 'sent', JSON.stringify(rc))
    const sends = (await http('GET', '/sends')).sent
    assert.equal(sends.length, sentBefore + 1)
    assert.ok(ftState.thread_id, 'the first touch created the thread')
    replyThread = ftState.thread_id
    step('1 first touch ft_a', { intent_id: ft.intent_id, receipt: rc, text: sends.at(-1).body, thread_id: ftState.thread_id, ledger: ftState.ledger.map((l) => l.record_kind) })
  } else {
    assert.equal(codeOf(ft), 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(ft))
    assert.ok(Date.parse(ft.result.next_permitted_at) > Date.now())
    step('1 first touch ft_a (window closed)', { code: codeOf(ft), result: ft.result, sends: (await http('GET', '/sends')).sent.length - sentBefore })
  }

  // 2. a seller reply (ft_a's new thread when the first touch went out, else the soft thread) → inbound_message on the feed
  const r2 = await http('POST', '/seller-reply', { thread_id: replyThread, body: 'Yes I still own it. Why do you ask?' })
  const f2 = await feedSince(sterling, start, (e) => e.kind === 'inbound_message' && e.payload.message_id === r2.message_id)
  const e2 = f2.hits[0]
  assert.deepEqual([e2.thread_id, e2.payload.stop_request], [replyThread, false])
  if (open) assert.deepEqual([e2.payload.campaign_target_id, e2.payload.property_id], [S.ft_a.campaign_target_id, S.ft_a.property_ref])
  else assert.equal(e2.payload.property_id, S.soft.property_ref)
  const delivery = f2.events.filter((e) => e.kind === 'delivery_changed' && e.intent_id === ft.intent_id).map((e) => ({ state: e.payload.receipt_state, thread_id: e.thread_id, campaign_target_id: e.payload.campaign_target_id, property_id: e.payload.property_id }))
  step(`2 seller reply on ${open ? 'ft_a' : 'soft'}`, { event: e2, delivery_changed: delivery })

  // 2b. sterling answers it (purpose answer → the certified reply)
  assert.equal(codeOf(await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: replyThread })), 'LEAD_ASSIGNED')
  const ans = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: replyThread, purpose: 'answer', brief: 'they asked why we are asking' })
  if (codeOf(ans) === 'HANDOFF_QUEUED') {
    const { rc: ansRc } = await untilThreadReceipt(replyThread, ans.intent_id, DONE)
    step('2b answer (certified reply)', { tool: ans.tool, intent_id: ans.intent_id, receipt: ansRc, text: ansRc.state === 'sent' ? (await http('GET', '/sends')).sent.at(-1).body : null })
  } else step('2b answer (certified reply)', { tool: ans.tool, code: codeOf(ans), status: ans.status, result: ans.result || null })

  // 3. a STOP on gold → inbound_message (stop_request) + opt_out; an answer to gold is then refused
  const r3 = await http('POST', '/seller-reply', { thread_id: S.gold.thread_id, body: 'STOP' })
  const f3 = await feedSince(sterling, start, (e) => e.payload?.message_id === r3.message_id && e.kind === 'opt_out')
  const e3 = f3.events.filter((e) => e.payload?.message_id === r3.message_id)
  assert.deepEqual(e3.map((e) => e.kind).sort(), ['inbound_message', 'opt_out'])
  assert.equal(e3.find((e) => e.kind === 'inbound_message').payload.stop_request, true)
  step('3 STOP on gold', { events: e3.map((e) => ({ cursor: e.cursor, event_id: e.event_id, kind: e.kind, thread_id: e.thread_id, payload: e.payload })) })
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: S.gold.thread_id })
  const gAns = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.gold.thread_id, purpose: 'answer', brief: 'answer the roof question' })
  assert.equal(gAns.status, 'refused', JSON.stringify(gAns))
  step('3b answer to gold after STOP', { code: codeOf(gAns), status: gAns.status })

  // 4. a send to `stopped` → refused
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.stopped.campaign_target_id })
  const r4 = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.stopped.campaign_target_id, purpose: 'first_touch', brief: 'owner of Kaimuki Ave' })
  const r4b = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.stopped.thread_id, purpose: 'answer', brief: 'answer them' })
  assert.equal(r4.status, 'refused', JSON.stringify(r4))
  assert.equal(r4b.status, 'refused', JSON.stringify(r4b))
  step('4 send to stopped', { first_touch: { code: codeOf(r4), result: r4.result }, answer: { code: codeOf(r4b) } })

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
  assert.equal(codeOf(nh), 'NOT_LEAD_OWNER')
  step('x not holding ft_b', { code: codeOf(nh), result: nh.result })

  // the R2 emergency stop: the send controls show it; BOTH the agent message and the certified reply are refused at
  // request time (capability_unavailable / EMERGENCY_STOP_ACTIVE); cleared, they are requestable again
  assert.equal(codeOf(await nova.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id })), 'LEAD_ASSIGNED')
  assert.equal((await http('POST', '/emergency-stop', { on: true })).emergency_stop, true)
  const cStop = await nova.call('leadcommand_send_controls', {})
  const amStop = await nova.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', brief: 'owner of Wilder Ave' })
  const replyStop = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.soft.thread_id, purpose: 'answer', brief: 'answer them' })
  assert.equal((await http('POST', '/emergency-stop', { on: false })).emergency_stop, false)
  assert.deepEqual([cStop.result.runtime_emergency_stop.on, cStop.result.seller_sends], [true, 'stopped'])
  for (const r of [amStop, replyStop]) assert.deepEqual([codeOf(r), reasonOf(r)], ['capability_unavailable', 'EMERGENCY_STOP_ACTIVE'], JSON.stringify(r))
  const go = await nova.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', brief: 'owner of Wilder Ave' })
  let after = { code: codeOf(go) }
  if (codeOf(go) === 'HANDOFF_QUEUED') { const { rc } = await untilReceipt(S.ft_b.campaign_target_id, go.intent_id, DONE); after = { receipt: rc, text: (await http('GET', '/sends')).sent.at(-1).body } }
  else assert.equal(codeOf(go), open ? 'HANDOFF_QUEUED' : 'OUTSIDE_RECIPIENT_WINDOW')
  step('x R2 emergency stop', { send_controls: cStop.result.runtime_emergency_stop, agent_message: [codeOf(amStop), reasonOf(amStop)], certified_reply: [codeOf(replyStop), reasonOf(replyStop)], after_clear: after })

  // a re-engagement of the quiet soft thread (written from its history) — only when the window is open
  if (open) {
    const rs = await sterling.call('sms_send_agent_message', { client_request_id: agnteiKey(), thread_id: S.soft.thread_id, purpose: 'reengage', brief: 'Said not now, maybe in the spring once the sister moves out' })
    step('x reengage soft', { code: codeOf(rs), result: rs.result || null })
  }

  console.log(`SMOKE PASS (808 window ${open ? 'OPEN: deliveries exercised' : 'CLOSED: send steps asserted the window refusal'})`)
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2))
} finally {
  await sterling.close(); await equity.close(); await nova.close()
}
