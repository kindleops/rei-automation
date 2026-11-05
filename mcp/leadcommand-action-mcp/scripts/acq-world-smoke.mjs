#!/usr/bin/env node
// Smoke run against a RUNNING acquisitions certification world (apps/api/tests/ohg/acq-world-server.mjs): the real
// Action MCP over HTTP as the agents, the world's loopback control endpoint for the simulated seller, the carrier and
// the pump. Owner architecture correction 2026-10-29: the agents COMPOSE every SMS (sms_send_agent_text); LeadCommand
// validates, enforces and transports — no model anywhere on the agent path (the world's worker refuses any model call).
// DISPOSABLE WORLD ONLY (SIMULATED provider). Usage: node scripts/acq-world-smoke.mjs <world.json> [out.json]
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

const ATTR = (employee, turn) => ({ employee, model: 'smoke-scripted', provider: 'agntei-smoke', route: `agntei.acquisitions.${employee === 'sterling' ? 'head' : 'representative'}`, session_id: null, turn_id: turn })
const sendText = (a, employee, args) => a.call('sms_send_agent_text', { client_request_id: agnteiKey(), attribution: ATTR(employee, `t-${crypto.randomBytes(4).toString('hex')}`), ...args })
const sterling = await agent('sterling')
const equity = await agent('equity')
const nova = await agent('nova')
try {
  const start = (await sterling.call('leadcommand_events_since', { cursor: 0, limit: 500 })).result?.next_cursor ?? 0
  const sentBefore = (await http('GET', '/sends')).sent.length

  // 0a. the send controls: nothing stopped, agent texts on (the agents' own switch)
  const c0 = await sterling.call('leadcommand_send_controls', {})
  assert.equal(c0.isError, false, JSON.stringify(c0))
  assert.deepEqual([c0.result.runtime_emergency_stop.on, c0.result.send_emergency_stop.on, c0.result.agent_text_enabled, c0.result.agent_text_refusal, c0.result.seller_sends], [false, false, true, null, 'enabled'])
  step('send controls', { result: c0.result })

  // 0b. the pool: the agent-text path's verdicts; is the 808 window open right now?
  const pool = await sterling.call('leadcommand_agent_lead_pool', { market: world.market, limit: 100 })
  assert.equal(pool.isError, false, JSON.stringify(pool))
  const rowOf = (id) => pool.result.rows.find((r) => (r.campaign_target_id || r.thread_id) === id)
  assert.equal(rowOf(S.ft_a.campaign_target_id).eligible, true)
  assert.equal(rowOf(S.stopped.campaign_target_id).eligible, false)
  const open = rowOf(S.ft_a.campaign_target_id).window_open === true
  step('pool read', { rows: pool.result.rows.length, window_open_808: open, next_permitted_at: rowOf(S.ft_a.campaign_target_id).next_permitted_at, ft_a: rowOf(S.ft_a.campaign_target_id), stopped: rowOf(S.stopped.campaign_target_id).ineligible_reason })

  // 0c. the retired composer path: LeadCommand never writes an agent's words
  const retired = await nova.call('sms_send_agent_message', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id, purpose: 'first_touch', brief: 'owner of Kapiolani Blvd' })
  assert.equal(codeOf(retired), 'AGENT_COMPOSES_TEXT', JSON.stringify(retired))
  step('0c retired brief-based path', { code: codeOf(retired), use: retired.error?.details?.use })

  // 1. nova holds ft_a and sends the first touch SHE composed → the exact words go out once (window open) / the window
  //    refusal with next_permitted_at (closed: nothing is scheduled)
  assert.equal(codeOf(await nova.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id })), 'LEAD_ASSIGNED')
  const FT = 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Kapiolani Blvd?'
  const ft = await sendText(nova, 'nova', { campaign_target_id: S.ft_a.campaign_target_id, purpose: 'first_touch', body: FT })
  let replyThread = S.soft.thread_id
  let replyHolder = sterling
  let replyEmployee = 'sterling'
  if (open) {
    assert.equal(codeOf(ft), 'HANDOFF_QUEUED', JSON.stringify(ft))
    const { t: ftState, rc } = await untilReceipt(S.ft_a.campaign_target_id, ft.intent_id, DONE)
    assert.equal(rc.state, 'sent', JSON.stringify(rc))
    const sends = (await http('GET', '/sends')).sent
    assert.equal(sends.length, sentBefore + 1)
    assert.equal(sends.at(-1).body, FT, 'the exact words the agent composed')
    assert.ok(ftState.thread_id, 'the first touch created the thread')
    const rec = ftState.ledger.find((l) => l.record_kind === 'agent_text')
    assert.deepEqual([rec?.author_employee, rec?.message_body, rec?.category], ['nova', FT, 'first_touch'])
    // the carrier says delivered → delivery_changed delivered on the feed
    const row = ftState.queue.find((q) => String(q.queue_key || '').startsWith('agent_text:'))
    assert.equal((await http('POST', '/carrier-receipt', { queue_row_id: row.id, status: 'delivered' })).final_delivery_status, 'delivered')
    const fd = await feedSince(nova, start, (e) => e.kind === 'delivery_changed' && e.intent_id === ft.intent_id && e.payload.receipt_state === 'delivered')
    replyThread = ftState.thread_id
    replyHolder = nova
    replyEmployee = 'nova'
    step('1 first touch ft_a (nova composed)', { intent_id: ft.intent_id, receipt: rc, text: sends.at(-1).body, thread_id: ftState.thread_id, ledger: { record_kind: rec.record_kind, author: rec.author_employee, attribution: rec.author_attribution, model: rec.model }, carrier: fd.hits[0].payload.receipt_state })
  } else {
    assert.equal(codeOf(ft), 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(ft))
    assert.ok(Date.parse(ft.result.next_permitted_at) > Date.now())
    step('1 first touch ft_a (window closed)', { code: codeOf(ft), result: ft.result, sends: (await http('GET', '/sends')).sent.length - sentBefore })
  }

  // 1b. one holder at a time: sterling (head) transfers ft_a from nova to himself; nova is refused while he holds it;
  //     he hands it back
  const toSterling = await sterling.call('transfer_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id, to_agent_id: 'agt_sterling', reason: 'head of acquisitions reviews this lead' })
  assert.deepEqual([codeOf(toSterling), toSterling.result.from_agent_id, toSterling.result.to_agent_id], ['LEAD_TRANSFERRED', 'agt_nova', 'agt_sterling'], JSON.stringify(toSterling))
  const novaRefused = await sendText(nova, 'nova', { campaign_target_id: S.ft_a.campaign_target_id, purpose: 'followup', body: 'Hi, Nova again. Any thoughts on the house on Kapiolani Blvd?' })
  assert.equal(codeOf(novaRefused), 'NOT_LEAD_OWNER', JSON.stringify(novaRefused))
  const novaCannot = await nova.call('transfer_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id, to_agent_id: 'agt_nova', reason: 'take it back' })
  assert.ok(novaCannot.isError || codeOf(novaCannot) === 'CAPABILITY_NOT_GRANTED', JSON.stringify(novaCannot))
  const back = await sterling.call('transfer_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_a.campaign_target_id, to_agent_id: 'agt_nova', reason: 'nova continues the conversation' })
  assert.deepEqual([codeOf(back), back.result.from_agent_id, back.result.to_agent_id], ['LEAD_TRANSFERRED', 'agt_sterling', 'agt_nova'])
  const ft1b = await feedSince(sterling, start, (e) => e.kind === 'lead_transferred' && e.intent_id === back.intent_id)
  step('1b transfer ft_a nova → sterling → nova', { to_sterling: toSterling.result, nova_while_sterling_holds: codeOf(novaRefused), nova_transfer: codeOf(novaCannot), back: back.result,
    events: ft1b.events.filter((e) => e.kind === 'lead_transferred').map((e) => [e.payload.from_agent_id, e.payload.to_agent_id, e.payload.requested_by]) })

  // 2. a seller reply (ft_a's thread when the first touch went out, else the soft thread) → inbound_message on the feed;
  //    its holder answers it with the text it composed, bound to that inbound
  if (replyThread === S.soft.thread_id) assert.equal(codeOf(await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: replyThread })), 'LEAD_ASSIGNED')
  const r2 = await http('POST', '/seller-reply', { thread_id: replyThread, body: 'Yes I still own it. The roof needs some work though, is that a problem for you?' })
  const f2 = await feedSince(replyHolder, start, (e) => e.kind === 'inbound_message' && e.payload.message_id === r2.message_id)
  assert.deepEqual([f2.hits[0].thread_id, f2.hits[0].payload.stop_request], [replyThread, false])
  const ANS = 'Thanks for letting me know about the roof, that is not a problem for us. When would you ideally want to sell?'
  const noRef = await sendText(replyHolder, replyEmployee, { thread_id: replyThread, purpose: 'reply', body: ANS })
  assert.equal(codeOf(noRef), 'IN_REPLY_TO_REQUIRED', JSON.stringify(noRef))
  const ans = await sendText(replyHolder, replyEmployee, { thread_id: replyThread, purpose: 'reply', in_reply_to_message_id: r2.message_id, body: ANS })
  let ansOut = { code: codeOf(ans) }
  if (codeOf(ans) === 'HANDOFF_QUEUED') {
    const { rc } = await untilThreadReceipt(replyThread, ans.intent_id, DONE)
    ansOut = { intent_id: ans.intent_id, receipt: rc, text: rc.state === 'sent' ? (await http('GET', '/sends')).sent.at(-1).body : null }
    if (rc.state === 'sent') assert.equal(ansOut.text, ANS)
  } else assert.equal(codeOf(ans), 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(ans))
  step(`2 seller reply on ${replyThread === S.soft.thread_id ? 'soft' : 'ft_a'} + the bound answer`, { inbound_event: f2.hits[0], without_in_reply_to: codeOf(noRef), answer: ansOut })

  // 3. a money text with no negotiation authority → MONEY_NOT_AUTHORIZED (an answer to a fresh price question on gold)
  assert.equal(codeOf(await sterling.call('assign_lead', { client_request_id: agnteiKey(), thread_id: S.gold.thread_id })), 'LEAD_ASSIGNED')
  const r3 = await http('POST', '/seller-reply', { thread_id: S.gold.thread_id, body: 'What would you pay for it?' })
  const money = await sendText(sterling, 'sterling', { thread_id: S.gold.thread_id, purpose: 'negotiation', in_reply_to_message_id: r3.message_id, body: 'We could pay $150,000 cash for it as-is. Would that work for you?' })
  assert.equal(money.status, 'refused', JSON.stringify(money))
  assert.ok(['MONEY_NOT_AUTHORIZED', 'OUTSIDE_RECIPIENT_WINDOW'].includes(codeOf(money)), JSON.stringify(money))
  step('3 money text without authority', { code: codeOf(money), reasons: money.result?.reasons || null })

  // 4. a STOP on gold → inbound_message (stop_request) + opt_out; a text to gold is then refused
  const r4 = await http('POST', '/seller-reply', { thread_id: S.gold.thread_id, body: 'STOP' })
  const f4 = await feedSince(sterling, start, (e) => e.payload?.message_id === r4.message_id && e.kind === 'opt_out')
  assert.deepEqual(f4.events.filter((e) => e.payload?.message_id === r4.message_id).map((e) => e.kind).sort(), ['inbound_message', 'opt_out'])
  const afterStop = await sendText(sterling, 'sterling', { thread_id: S.gold.thread_id, purpose: 'reply', in_reply_to_message_id: r4.message_id, body: 'Understood, thanks for letting me know.' })
  assert.equal(afterStop.status, 'refused', JSON.stringify(afterStop))
  assert.match(codeOf(afterStop), /STOP_REQUESTED|CONTACT_NOT_PERMITTED|CONTACT_NOT_ELIGIBLE/)
  step('4 text after STOP on gold', { code: codeOf(afterStop) })

  // 5. the stopped target (opted out 40 days ago) → refused; equity (no seller-facing capability) → refused
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.stopped.campaign_target_id })
  const r5 = await sendText(sterling, 'sterling', { campaign_target_id: S.stopped.campaign_target_id, purpose: 'first_touch', body: 'Hi, this is Sterling, an AI assistant with Reivesti Home Buyers. Do you still own the house on Kaimuki Ave?' })
  assert.equal(r5.status, 'refused', JSON.stringify(r5))
  const r5b = await sendText(equity, 'equity', { campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', body: 'Hi, do you still own the house on Wilder Ave?' })
  assert.ok(r5b.isError || r5b.status === 'refused' || r5b.ok === false, JSON.stringify(r5b))
  step('5 stopped target / equity', { stopped: codeOf(r5), equity: codeOf(r5b) })

  // 6. the Eastern window: refused OUTSIDE_RECIPIENT_WINDOW (with next_permitted_at) while 08:00–21:00 Eastern is closed
  await sterling.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.eastern.campaign_target_id })
  const re = await sendText(sterling, 'sterling', { campaign_target_id: S.eastern.campaign_target_id, purpose: 'first_touch', body: 'Hi, this is Sterling, an AI assistant with Reivesti Home Buyers. Do you still own the house on Pali Hwy?' })
  if (S.eastern.pool?.window_open === false || codeOf(re) === 'OUTSIDE_RECIPIENT_WINDOW') { assert.equal(codeOf(re), 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(re)); assert.ok(re.result.next_permitted_at) }
  step('6 eastern window', { code: codeOf(re), next_permitted_at: re.result?.next_permitted_at || null })

  // 7. the R2 emergency stop: the controls show it; a text is refused EMERGENCY_STOP_ACTIVE at request time; cleared,
  //    it is requestable again
  assert.equal(codeOf(await nova.call('assign_lead', { client_request_id: agnteiKey(), campaign_target_id: S.ft_b.campaign_target_id })), 'LEAD_ASSIGNED')
  assert.equal(codeOf(await sendText(sterling, 'sterling', { campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', body: 'Hi, do you still own the house on Wilder Ave?' })), 'NOT_LEAD_OWNER')
  assert.equal((await http('POST', '/emergency-stop', { on: true })).emergency_stop, true)
  const cStop = await nova.call('leadcommand_send_controls', {})
  const FTB = 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Wilder Ave?'
  const stopped = await sendText(nova, 'nova', { campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', body: FTB })
  assert.equal((await http('POST', '/emergency-stop', { on: false })).emergency_stop, false)
  assert.deepEqual([cStop.result.runtime_emergency_stop.on, cStop.result.agent_text_refusal, cStop.result.seller_sends], [true, 'EMERGENCY_STOP_ACTIVE', 'stopped'])
  assert.equal(codeOf(stopped), 'EMERGENCY_STOP_ACTIVE', JSON.stringify(stopped))
  const go = await sendText(nova, 'nova', { campaign_target_id: S.ft_b.campaign_target_id, purpose: 'first_touch', body: FTB })
  let after = { code: codeOf(go) }
  if (codeOf(go) === 'HANDOFF_QUEUED') { const { rc } = await untilReceipt(S.ft_b.campaign_target_id, go.intent_id, DONE); after = { receipt: rc, text: (await http('GET', '/sends')).sent.at(-1).body } }
  else assert.equal(codeOf(go), open ? 'HANDOFF_QUEUED' : 'OUTSIDE_RECIPIENT_WINDOW')
  step('7 R2 emergency stop', { send_controls: cStop.result.runtime_emergency_stop, agent_text: codeOf(stopped), after_clear: after })

  const model = (await http('POST', '/tick')).model_calls
  assert.equal(model, 0, 'no model was called anywhere on the agent path')
  console.log(`SMOKE PASS (808 window ${open ? 'OPEN: deliveries exercised' : 'CLOSED: send steps asserted the window refusal'}; model calls: ${model})`)
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2))
} finally {
  await sterling.close(); await equity.close(); await nova.close()
}
