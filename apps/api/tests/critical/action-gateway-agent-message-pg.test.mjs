// Link #32 (PROPOSED_20261029100000) + the ledger kind (PROPOSED_20261029090000) on a DISPOSABLE PostgreSQL 17: an agent
// sends a message on its OWN initiative — a first touch to a lead with no conversation, a re-engagement, a follow-up —
// that LeadCommand WRITES itself (canonical composer + validators, a SCRIPTED fake model), recorded in the AI-message
// ledger (agent_outbound), queued once and sent once by the REAL queue runner to a SIMULATED provider; a governed
// template only as the named fallback. Every gate is proven here: the AI-reply certification gate + the agent-message
// switch (authorize AND dispatch), both emergency stops, the standing grant (and its absence), revocation, lead
// ownership, per-lead serialization, suppression / Spanish STOP history / wrong number / renter / hold, the recipient
// window, the first-touch opener rule, the day caps, the validators, the event feed, and the rollbacks.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { agentMessageDb, AM_ROLLBACK, LEDGER_ROLLBACK } from '../helpers/action-gateway-agent-message-pg.mjs'
import { makeGateway, humanApprovals, trapTransport, ORG, OWNER } from '../helpers/action-gateway-pg.mjs'
import { simProvider, lawfulNowIso } from '../helpers/followup-lifecycle-pg.mjs'
import { fakeProvider } from '../helpers/conversation-ai-runtime-fakes.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { seedT34, agent, worker, receipt, liveDispatch, dispatchQueued, setControls, sel, crypto, OURS } from '../helpers/action-gateway-t34-world.mjs'
import { seedThread, OPERATOR, SELLER } from '../helpers/action-gateway-pg.mjs'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const BASIS = 'owner decision 2026-10-29 (disposable test): agent messages after blind evaluation'
const CLOCK = lawfulNowIso() // inside 09:00-19:00 Chicago: the scenarios never depend on the hour the suite runs
const clockMs = () => Date.parse(CLOCK)
const NIGHT = (() => { let t = Date.parse(CLOCK); const h = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms))); while (h(t) !== 2) t += 3_600_000; return t })()
const LEAD_A = '+13125550171' // first-touch lead (no conversation)
const BRIEF = 'Absentee owner, inherited the house, tax delinquent; likely open to a simple sale'

const firstTouchText = (u) => {
  const persona = /PERSONA: ([A-Z][a-z]+) \(/.exec(u)?.[1]
  const name = /OWNER FIRST NAME: ([A-Z][a-z]+)/.exec(u)?.[1]
  return `Hi${name ? ` ${name}` : ''}, ${persona ? `this is ${persona}, ` : ''}a local buyer interested in the house on Elm St. Do you still own it?`
}
/** A scripted model: the composer's tool call answers from the script; anything else is a plain judgment. */
const scripted = (fn) => fakeProvider((p) => {
  const user = String(p.messages?.[0]?.content?.[0]?.text ?? p.messages?.[0]?.content ?? '')
  return p.tools[0].input_schema?.properties?.message ? { message: fn(user) } : {}
})

const aiPolicy = (threads, categories = ['first_touch', 'reengage', 'followup']) => JSON.stringify({ enabled: true, scope: { thread_keys: threads }, categories })
const switches = ({ threads = [LEAD_A], agentPolicy = {} } = {}) => ({
  ai_conversation_send_enabled: 'true', ai_conversation_send_policy: aiPolicy(threads),
  ai_agent_message_enabled: 'true', ai_agent_message_policy: JSON.stringify({ enabled: true, fallback_templates: { reengage: ['t-csfu-en-1'], followup: ['t-csfu-en-1'] }, ...agentPolicy }),
})

const GRANTS = [['leads.assign_lead', 2], ['leads.release_lead', 2], ['leads.read_assignment', 1], ['events.read', 1], ['conversation.read_message_templates', 1], ['leads.read_pool', 1], ['controls.read', 1]]
/** An owner mints the standing seller-facing grant for agent messages (grants are immutable: a new grant, never an edit). */
const mintStanding = (owner, { agent_id = 'agt_alpha', capability = 'conversation.queue_agent_message', tier = 3, basis = BASIS, leadCap = null } = {}) => owner.query(
  `insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_failures_per_hour, max_cap_hits_per_hour, granted_by, valid_from, expires_at, standing_seller_facing, standing_basis, agent_message_lead_day_cap)
   values ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 30, 200, 0, 5, 5, $5, now(), now() + interval '30 days', true, $6, $7) returning grant_id`, [ORG, agent_id, capability, tier, OWNER, basis, leadCap])

async function seedLead(env, { phone = LEAD_A, pid = 'p200', prospect = 'pr2', first = 'Maria', status = 'ready', identity = 'verified', market = 'Chicago' } = {}) {
  await env.owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ($1, 'SFR', 'Chicago', 'IL', '60601', '18 Elm St') on conflict do nothing`, [pid])
  await env.owner.query(`insert into public.prospects (prospect_id, first_name, full_name) values ($1, $2, $2 || ' R') on conflict do nothing`, [prospect, first])
  const camp = (await env.owner.query(`insert into public.campaigns (name, status) values ('agent first touch', 'active') returning id`)).rows[0].id
  const id = (await env.owner.query(`insert into public.campaign_targets (campaign_id, property_id, prospect_id, to_phone_number, market, language, state, property_address, touch_number, target_status, routing_status, identity_status, suppression_status, metadata)
    values ($1, $2, $3, $4, $5, 'English', 'IL', '18 Elm St', 1, $6, 'ready', $7, 'clear', jsonb_build_object('candidate_snapshot', jsonb_build_object('seller_first_name', $8::text))) returning id`, [camp, pid, prospect, phone, market, status, identity, first])).rows[0].id
  return { campaign_target_id: id, campaign_id: camp, phone, pid, prospect }
}

async function world({ sw = switches(), standing = true, prov = scripted(firstTouchText), agents = ['agt_alpha'] } = {}) {
  const env = await agentMessageDb()
  await seedT34(env)
  await setControls(env.owner, sw)
  await env.owner.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body, template_name) values
    ('t-csfu-en-1', 'consider_selling_follow_up', 'English', true, true, 'Hi {{seller_first_name}}, {{agent_name}} here again. Any change of plans on {{property_address}}?', 'consider selling follow up')`)
  await liveDispatch(env)
  const creds = {}
  for (const a of agents) {
    creds[a] = await agent(env, { agent_id: a, grants: standing ? GRANTS : [...GRANTS, ['conversation.queue_agent_message', 3]] })
    if (standing) await mintStanding(env.owner, { agent_id: a })
  }
  const lead = await seedLead(env)
  const { gateway } = makeGateway(env, { now: clockMs })
  const w = worker(env, { prov, now: clockMs })
  return { env, creds, cred: creds[agents[0]], lead, gateway, w, prov }
}
const call = (g, cred, tool, args) => g.call({ credential: cred, tool, args })
const assign = (g, cred, lead, key = `assign-${crypto.randomUUID().slice(0, 8)}`) => call(g, cred, 'assign_lead', { client_request_id: key, ...lead })
const send = (g, cred, args) => call(g, cred, 'queue_agent_message', { purpose: 'first_touch', brief: BRIEF, ...args })
const agentRows = (env) => sel(env.owner, `select * from public.send_queue where queue_key like 'agent_message:%' order by created_at`)
const approvals = (env) => sel(env.owner, 'select count(*)::int n from agent.approval_request').then((r) => r[0].n)

test('PG agent message: born OFF — capability_unavailable until the AI-reply gate AND the agent-message switch are both on', { skip }, async () => {
  const { env, cred, lead, gateway } = await world({ sw: {} })
  try {
    const off = await send(gateway, cred, { client_request_id: 'am-off-0001', campaign_target_id: lead.campaign_target_id })
    assert.deepEqual([off.error?.code, off.error?.details?.reason], ['capability_unavailable', 'AI_SEND_KILL_SWITCH_OFF'], JSON.stringify(off))
    // the AI-reply gate alone is not enough (the agent-message switch is born off) …
    await setControls(env.owner, { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: aiPolicy([LEAD_A]) })
    const aiOnly = await send(gateway, cred, { client_request_id: 'am-off-0002', campaign_target_id: lead.campaign_target_id })
    assert.equal(aiOnly.error?.code, 'capability_unavailable', JSON.stringify(aiOnly))
    assert.match(JSON.stringify(aiOnly.error), /AGENT_MESSAGE_KILL_SWITCH_OFF/)
    // … nor is the agent-message switch without the AI-reply gate
    await setControls(env.owner, { ...switches(), ai_conversation_send_enabled: null })
    const agentOnly = await send(gateway, cred, { client_request_id: 'am-off-0003', campaign_target_id: lead.campaign_target_id })
    assert.match(JSON.stringify(agentOnly.error), /AI_SEND_KILL_SWITCH_OFF/)
    assert.equal((await agentRows(env)).length, 0)
  } finally { await env.db.drop() }
})

test('PG agent message: an AI-composed FIRST TOUCH to a lead with no conversation, on a standing grant — no approval, ONE ledger record + ONE row, the REAL runner sends once; a replay sends nothing new', { skip }, async () => {
  const { env, cred, lead, gateway, w, prov } = await world()
  const net = trapTransport()
  try {
    const a = await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })
    assert.equal(a.code, 'LEAD_ASSIGNED', JSON.stringify(a))
    const args = { client_request_id: 'am-ft-00001', campaign_target_id: lead.campaign_target_id }
    const first = await send(gateway, cred, args)
    assert.equal(first.code, 'HANDOFF_QUEUED', JSON.stringify(first))
    assert.equal(await approvals(env), 0, 'no per-message approval is filed')
    const auth = (await sel(env.owner, 'select standing, approval_id, evidence from action_gateway.action_authorizations where intent_id = $1', [first.intent_id]))[0]
    assert.deepEqual([auth.standing, auth.approval_id, auth.evidence.authority], [true, null, 'standing_seller_facing'])
    await w.tick()
    const r = await receipt(env, first.intent_id)
    assert.deepEqual([r.state, r.code], ['enqueued', 'AI_COMPOSED_ENQUEUED'], JSON.stringify(r))
    const rows = await agentRows(env)
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].message_origin, rows[0].source, rows[0].to_phone_number, rows[0].template_id], ['ai_generated', 'ai_conversation', LEAD_A, null])
    assert.match(rows[0].message_body, /Do you still own it\?$/)
    assert.equal(rows[0].metadata.agent_message_intent_id, first.intent_id)
    // the composer saw the brief as context, never as the message
    const composeCall = prov.calls.find((c) => c.tools?.[0]?.input_schema?.properties?.message)
    assert.match(JSON.stringify(composeCall), /AGENT BRIEF/)
    assert.ok(!rows[0].message_body.includes('tax delinquent'))
    const rec = (await sel(env.owner, 'select * from public.ai_generated_messages where queue_key = $1', [`agent_message:${first.intent_id}`]))[0]
    assert.deepEqual([rec.record_kind, rec.decision_outcome, rec.inbound_message_id, rec.authorization_scope.category], ['agent_outbound', 'AI_GENERATED_OUTBOUND', null, 'first_touch'])
    // the REAL runner, a SIMULATED provider: exactly one send
    const sim = simProvider()
    const d = await dispatchQueued(env, w, rows[0].id, sim)
    assert.equal(sim.sent.length, 1, JSON.stringify(d.out))
    await w.execution.reconcileReceipts()
    assert.equal((await receipt(env, first.intent_id)).state, 'sent')
    // replay: the same intent, nothing new queued or sent
    const again = await send(gateway, cred, args)
    assert.equal(again.status, 'replayed')
    await w.tick()
    assert.equal((await agentRows(env)).length, 1)
    assert.deepEqual(net.hits, [])
    // the agents' feed carries what happened (never the text, never the number)
    await new Promise((res) => setTimeout(res, 1100))
    const ev = await call(gateway, cred, 'events_since', { cursor: 0 })
    assert.equal(ev.ok, true, JSON.stringify(ev))
    const kinds = ev.result.events.map((e) => `${e.kind}:${e.payload.receipt_state}`)
    assert.ok(kinds.includes('delivery_changed:enqueued') && kinds.includes('delivery_changed:sent'), kinds.join(','))
    assert.ok(!JSON.stringify(ev.result).includes('3125550171'))
  } finally { net.restore(); await env.db.drop() }
})

test('PG agent message: without the standing flag the message waits for a human (TIER_REQUIRES_APPROVAL), exactly like the reply', { skip }, async () => {
  const { env, cred, lead, gateway } = await world({ standing: false })
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await send(gateway, cred, { client_request_id: 'am-nostand-1', campaign_target_id: lead.campaign_target_id })
    assert.deepEqual([r.status, r.code], ['approval_pending', 'TIER_REQUIRES_APPROVAL'], JSON.stringify(r))
    assert.equal(await approvals(env), 1)
    // the human decides through the EXISTING path; the retry hands off
    await humanApprovals(env).decide(r.approval.approval_id)
    const again = await send(gateway, cred, { client_request_id: 'am-nostand-1', campaign_target_id: lead.campaign_target_id })
    assert.equal(again.code, 'HANDOFF_QUEUED', JSON.stringify(again))
  } finally { await env.db.drop() }
})

// ── a quiet conversation (re-engagement / follow-up) ─────────────────────────
const LEAD_T = '+13125550181'
async function seedQuietThread(env, { phone = LEAD_T, pid = 'p300', days = 5 } = {}) {
  const id = crypto.randomUUID()
  await env.owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ($1, 'SFR', 'Chicago', 'IL', '60601', '12 Oak St') on conflict do nothing`, [pid])
  await env.owner.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, our_number, prospect_id) values ($1, $2, $2, $3, $4, 'pr1')`, [id, phone, pid, OURS])
  const ev = (dir, body, hoursAgo) => env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
    values ($1, $2, $3, $4::text, $5::text, $6::text, $7, now() - make_interval(hours => $8::int), now() - make_interval(hours => $8::int), $9, 'en')`,
  [crypto.randomUUID(), `SM${crypto.randomUUID().slice(0, 12)}`, dir, phone, dir === 'outbound' ? OURS : phone, dir === 'outbound' ? phone : OURS, body, hoursAgo, pid])
  await ev('outbound', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', days * 24 + 3)
  await ev('inbound', 'Yes I still own it', days * 24 + 2)
  await ev('outbound', 'Thanks for confirming, appreciate it.', days * 24 + 1)
  await env.owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, created_at, sent_at, metadata)
    values ($1, 'sent', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', $2::text, $3::text, $2::text, 'ownership_check', 'Helen', now() - make_interval(hours => $4::int), now() - make_interval(hours => $4::int), '{}'::jsonb)`, [`seed-${id}`, phone, OURS, days * 24 + 3])
  return { thread_id: id, phone, pid }
}
const reengageText = (u) => `Hi Dana, ${/PERSONA: ([A-Z][a-z]+) \(/.exec(u)?.[1] || 'Helen'} again. Would you consider selling it?`

test('PG agent message: a RE-ENGAGEMENT of a quiet thread is written from the thread history (continuity: established persona + sticky sender)', { skip }, async () => {
  const { env, cred, gateway, w, prov } = await world({ sw: switches({ threads: [LEAD_T] }), prov: scripted(reengageText) })
  try {
    const t = await seedQuietThread(env)
    assert.equal((await assign(gateway, cred, { thread_id: t.thread_id })).code, 'LEAD_ASSIGNED')
    const r = await call(gateway, cred, 'queue_agent_message', { client_request_id: 'am-re-00001', thread_id: t.thread_id, purpose: 'reengage', brief: 'Seller confirmed ownership last week, no answer on selling since' })
    assert.equal(r.code, 'HANDOFF_QUEUED', JSON.stringify(r))
    await w.tick()
    assert.equal((await receipt(env, r.intent_id)).code, 'AI_COMPOSED_ENQUEUED', JSON.stringify(await receipt(env, r.intent_id)))
    const [row] = await agentRows(env)
    assert.deepEqual([row.from_phone_number, row.agent_name, row.message_origin], [OURS, 'Helen', 'ai_generated'])
    const composeUser = JSON.stringify(prov.calls.find((c) => c.tools?.[0]?.input_schema?.properties?.message))
    assert.match(composeUser, /Yes I still own it/, 'the seller\'s own words are in the writer\'s context')
    assert.match(composeUser, /OBJECTIVE: ask whether they would consider selling/, 'the ledger\'s next missing fact is the objective')
    // a re-engagement of a thread whose latest message is the seller's unanswered one is a REPLY, never an agent message
    await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, created_at, property_id) values ($1, 'SMnew1', 'inbound', $2::text, $2::text, $3::text, 'Maybe, what would you pay?', now(), 'p300')`, [crypto.randomUUID(), LEAD_T, OURS])
    const unanswered = await call(gateway, cred, 'queue_agent_message', { client_request_id: 'am-re-00002', thread_id: t.thread_id, purpose: 'followup', brief: 'check in on the selling question' })
    assert.equal(unanswered.code, 'UNANSWERED_SELLER_MESSAGE', JSON.stringify(unanswered))
  } finally { await env.db.drop() }
})

test('PG agent message: the writer refuses (an amount, then again) ⇒ the NAMED governed template is the fallback; with no template the message is refused and nothing is queued', { skip }, async () => {
  const priced = scripted(() => 'We could pay $150,000 cash for it. Interested?')
  const { env, cred, gateway, w } = await world({ sw: switches({ threads: [LEAD_T, '+13125550182'] }), prov: priced })
  try {
    const t = await seedQuietThread(env)
    assert.equal((await assign(gateway, cred, { thread_id: t.thread_id })).code, 'LEAD_ASSIGNED')
    const fb = await call(gateway, cred, 'queue_agent_message', { client_request_id: 'am-fb-00001', thread_id: t.thread_id, purpose: 'followup', brief: 'friendly check-in', template_id: 't-csfu-en-1' })
    assert.equal(fb.code, 'HANDOFF_QUEUED', JSON.stringify(fb))
    await w.tick()
    const rc = await receipt(env, fb.intent_id)
    assert.equal(rc.code, 'TEMPLATE_FALLBACK_ENQUEUED', JSON.stringify(rc))
    const [row] = await agentRows(env)
    assert.equal(row.message_body, 'Hi Dana, Helen here again. Any change of plans on 12 Oak St?')
    assert.deepEqual([row.metadata.origin_detail, row.metadata.template_id, row.message_origin ?? null], ['agent_template', 't-csfu-en-1', null])
    assert.equal((await sel(env.owner, 'select count(*)::int n from public.ai_generated_messages')).length && (await sel(env.owner, 'select count(*)::int n from public.ai_generated_messages'))[0].n, 0, 'a template is not an AI record')
    // the validator refuses the composition and there is no fallback: refused, nothing queued, the day slots given back
    const t2 = await seedQuietThread(env, { phone: '+13125550182', pid: 'p301' })
    assert.equal((await assign(gateway, cred, { thread_id: t2.thread_id })).code, 'LEAD_ASSIGNED')
    const nofb = await call(gateway, cred, 'queue_agent_message', { client_request_id: 'am-fb-00002', thread_id: t2.thread_id, purpose: 'followup', brief: 'friendly check-in' })
    await w.tick()
    const rc2 = await receipt(env, nofb.intent_id)
    assert.deepEqual([rc2.state, rc2.code], ['refused', 'COMPOSITION_REFUSED:composition:composition_rejected'], JSON.stringify(rc2))
    assert.equal((await agentRows(env)).length, 1)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.idempotency_ledger where claim_token = $1 and status = 'failed'`, [nofb.intent_id]))[0].n, 2, 'both day slots released')
  } finally { await env.db.drop() }
})

test('PG agent message: a writer that denies being AI is refused by the validator — nothing queued', { skip }, async () => {
  const denies = scripted(() => 'Hi Maria, I am a real person, not a bot. Do you still own the house on Elm St?')
  const { env, cred, lead, gateway, w } = await world({ prov: denies })
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await send(gateway, cred, { client_request_id: 'am-deny-0001', campaign_target_id: lead.campaign_target_id })
    await w.tick()
    const rc = await receipt(env, r.intent_id)
    assert.equal(rc.state, 'refused', JSON.stringify(rc))
    assert.match(rc.code, /^COMPOSITION_REFUSED/)
    assert.equal((await agentRows(env)).length, 0)
  } finally { await env.db.drop() }
})

test('PG agent message: every compliance gate refuses before anything is queued — suppression, a Spanish STOP in history, wrong number, renter, hold, the first-touch opener rule, outside 08:00–21:00', { skip }, async () => {
  const phones = { sup: '+13125550191', stop: '+13125550192', wrong: '+13125550193', renter: '+13125550194', held: '+13125550195', contacted: '+13125550196' }
  const { env, cred, gateway } = await world({ sw: switches({ threads: [LEAD_A, ...Object.values(phones)] }) })
  try {
    const L = {}
    let n = 0
    for (const [k, phone] of Object.entries(phones)) L[k] = await seedLead(env, { phone, pid: `pg${n}`, prospect: `prg${n++}`, first: 'Sam' })
    await env.owner.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [phones.sup])
    // a thread with ONE inbound, the bare Spanish stop word (F1), no outbound of ours
    const st = crypto.randomUUID()
    await env.owner.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id) values ($1, $2, $2, 'pg1')`, [st, phones.stop])
    await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, created_at, property_id) values ($1, 'SMalto', 'inbound', $2::text, $2::text, $3::text, 'ALTO', now() - interval '2 days', 'pg1')`, [crypto.randomUUID(), phones.stop, OURS])
    await env.owner.query(`insert into public.phones (phone_id, canonical_e164, phone_contact_status) values ('ph-wrong', $1, 'wrong_number')`, [phones.wrong])
    await env.owner.query(`update public.prospects set likely_renting = true, likely_owner = false where prospect_id = $1`, [L.renter.prospect])
    await env.owner.query(`insert into public.automation_holds (hold_key, hold_type, property_id, reason, set_by, approval_ref) values ('h-am', 'operator_hold', $1, 'operator reviewing', 'owner', 'test')`, [L.held.pid])
    await env.owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, created_at, sent_at, metadata) values ('prior-1', 'sent', 'Hi Sam, do you still own it?', $1::text, $2::text, $1::text, now() - interval '30 days', now() - interval '30 days', '{}'::jsonb)`, [phones.contacted, OURS])
    const expect = { sup: /CONTACT_SUPPRESSED|CONTACT_NOT_ELIGIBLE|STOP_REQUESTED|CONTACT_NOT_PERMITTED/, stop: /STOP_REQUESTED|CONTACT_NOT_ELIGIBLE|CONTACT_NOT_PERMITTED/, wrong: /CONTACT_NOT_ELIGIBLE/, renter: /PRESEND_INELIGIBLE/, held: /AUTOMATION_HOLD/, contacted: /ALREADY_CONTACTED/ }
    for (const [k, rx] of Object.entries(expect)) {
      const a = await assign(gateway, cred, { campaign_target_id: L[k].campaign_target_id })
      assert.equal(a.code, 'LEAD_ASSIGNED', `${k}: ${JSON.stringify(a)}`)
      const r = await send(gateway, cred, { client_request_id: `am-gate-${k}`, campaign_target_id: L[k].campaign_target_id })
      assert.equal(r.state, 'refused', `${k}: ${JSON.stringify(r)}`)
      assert.match(r.code, rx, `${k}: ${r.code} ${JSON.stringify(r.result)}`)
    }
    // the recipient window (campaign purpose, 08:00–21:00 local): REFUSED with the next permitted time, never scheduled
    const lead = await seedLead(env, { phone: LEAD_A, pid: 'pw', prospect: 'prw' })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const { gateway: night } = makeGateway(env, { now: () => NIGHT })
    const r = await send(night, cred, { client_request_id: 'am-gate-night', campaign_target_id: lead.campaign_target_id })
    assert.equal(r.code, 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(r))
    assert.ok(Date.parse(r.result.next_permitted_at) > NIGHT)
    assert.equal((await agentRows(env)).length, 0)
  } finally { await env.db.drop() }
})

test('PG agent message: lead ownership — only the holder sends (NOT_LEAD_OWNER), one holder at a time, release hands it over', { skip }, async () => {
  const { env, creds, lead, gateway } = await world({ agents: ['agt_alpha', 'agt_beta'] })
  try {
    const A = creds.agt_alpha
    const B = creds.agt_beta
    const unassigned = await send(gateway, B, { client_request_id: 'am-own-0001', campaign_target_id: lead.campaign_target_id })
    assert.equal(unassigned.code, 'NOT_LEAD_OWNER', JSON.stringify(unassigned))
    assert.equal((await assign(gateway, A, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    assert.equal((await assign(gateway, B, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_OWNED_BY_ANOTHER_AGENT')
    const notOwner = await send(gateway, B, { client_request_id: 'am-own-0002', campaign_target_id: lead.campaign_target_id })
    assert.equal(notOwner.code, 'NOT_LEAD_OWNER')
    const who = await call(gateway, B, 'get_lead_assignment', { campaign_target_id: lead.campaign_target_id })
    assert.equal(who.result.owner_agent_id, 'agt_alpha', JSON.stringify(who))
    assert.equal((await call(gateway, B, 'release_lead', { client_request_id: 'am-own-rel-b', campaign_target_id: lead.campaign_target_id })).code, 'NOT_LEAD_OWNER')
    assert.equal((await call(gateway, A, 'release_lead', { client_request_id: 'am-own-rel-a', campaign_target_id: lead.campaign_target_id })).code, 'LEAD_RELEASED')
    assert.equal((await assign(gateway, B, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    assert.equal((await send(gateway, A, { client_request_id: 'am-own-0003', campaign_target_id: lead.campaign_target_id })).code, 'NOT_LEAD_OWNER')
    assert.equal((await send(gateway, B, { client_request_id: 'am-own-0004', campaign_target_id: lead.campaign_target_id })).code, 'HANDOFF_QUEUED')
  } finally { await env.db.drop() }
})

test('PG agent message: two concurrent sends to ONE seller ⇒ exactly one queued (per-lead serialization at the handoff)', { skip }, async () => {
  const env0 = await world({ standing: false }) // standing minted below with a per-lead cap of 2: the caps are not what serializes
  const { env, cred, lead, gateway, w } = env0
  try {
    // the plain T3 grant is revoked; the owner mints the flagged one with a per-lead cap of 2 (one live grant per capability)
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where capability = 'conversation.queue_agent_message' and not standing_seller_facing`)
    await mintStanding(env.owner, { leadCap: 2 })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const [x, y] = await Promise.all([
      send(gateway, cred, { client_request_id: 'am-conc-0001', campaign_target_id: lead.campaign_target_id }),
      send(makeGateway(env, { now: clockMs, worker: 'gw-2' }).gateway, cred, { client_request_id: 'am-conc-0002', campaign_target_id: lead.campaign_target_id }),
    ])
    const codes = [x.code, y.code].sort()
    assert.deepEqual(codes, ['HANDOFF_QUEUED', 'LEAD_SEND_IN_FLIGHT'], JSON.stringify([x, y]))
    await w.tick()
    assert.equal((await agentRows(env)).length, 1)
  } finally { await env.db.drop() }
})

test('PG agent message: the day caps — one per lead per day, the global cap — refused at the gateway and BOUND by the worker\'s reservation', { skip }, async () => {
  const L2 = '+13125550172'
  const { env, cred, lead, gateway, w } = await world({ sw: switches({ threads: [LEAD_A, L2], agentPolicy: { max_per_day_global: 1 } }) })
  try {
    const lead2 = await seedLead(env, { phone: L2, pid: 'p201', prospect: 'pr4', first: 'Ana' })
    for (const l of [lead, lead2]) assert.equal((await assign(gateway, cred, { campaign_target_id: l.campaign_target_id })).code, 'LEAD_ASSIGNED')
    // both pass the gateway before any reservation exists; the worker's reservation binds the global cap
    const a = await send(gateway, cred, { client_request_id: 'am-cap-0001', campaign_target_id: lead.campaign_target_id })
    const b = await send(gateway, cred, { client_request_id: 'am-cap-0002', campaign_target_id: lead2.campaign_target_id })
    assert.deepEqual([a.code, b.code], ['HANDOFF_QUEUED', 'HANDOFF_QUEUED'])
    await w.tick()
    const states = [(await receipt(env, a.intent_id)).code, (await receipt(env, b.intent_id)).code].sort()
    assert.deepEqual(states, ['AI_COMPOSED_ENQUEUED', 'DAILY_GLOBAL_CAP_REACHED'])
    assert.equal((await agentRows(env)).length, 1)
    // the next request is refused at the gateway already: per lead (the one sent) and global (the other)
    const sentLead = (await receipt(env, a.intent_id)).code === 'AI_COMPOSED_ENQUEUED' ? lead : lead2
    const otherLead = sentLead === lead ? lead2 : lead
    assert.equal((await send(gateway, cred, { client_request_id: 'am-cap-0003', campaign_target_id: sentLead.campaign_target_id })).code, 'DAILY_LEAD_CAP_REACHED')
    assert.equal((await send(gateway, cred, { client_request_id: 'am-cap-0004', campaign_target_id: otherLead.campaign_target_id })).code, 'DAILY_GLOBAL_CAP_REACHED')
    const scopes = await sel(env.owner, `select scope, count(*)::int n from public.idempotency_ledger where scope like 'agent_message_%' and status in ('processing', 'completed') group by scope order by scope`)
    assert.deepEqual(scopes.map((s) => [s.scope, s.n]), [['agent_message_global_day', 1], ['agent_message_lead_day', 1]])
  } finally { await env.db.drop() }
})

test('PG agent message: both emergency stops and both switches refuse at authorize AND cancel at dispatch', { skip }, async () => {
  const { env, cred, lead, gateway, w } = await world()
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    // R2 emergency stop at authorize
    await env.owner.query('update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now() where id = 1')
    const r2 = await send(gateway, cred, { client_request_id: 'am-stop-0001', campaign_target_id: lead.campaign_target_id })
    assert.match(JSON.stringify(r2.error), /EMERGENCY_STOP_ACTIVE/)
    await env.owner.query('update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null where id = 1')
    // queue emergency stop at authorize
    await setControls(env.owner, { queue_emergency_stop_at: new Date().toISOString() })
    assert.match(JSON.stringify((await send(gateway, cred, { client_request_id: 'am-stop-0002', campaign_target_id: lead.campaign_target_id })).error), /EMERGENCY_STOP_ACTIVE/)
    await setControls(env.owner, { queue_emergency_stop_at: null })
    // a queued row, then each brake at dispatch
    const ok = await send(gateway, cred, { client_request_id: 'am-stop-0003', campaign_target_id: lead.campaign_target_id })
    assert.equal(ok.code, 'HANDOFF_QUEUED', JSON.stringify(ok))
    await w.tick()
    const [row] = await agentRows(env)
    assert.ok(row, JSON.stringify(await receipt(env, ok.intent_id)))
    await setControls(env.owner, { ai_agent_message_enabled: 'false' })
    const sim = simProvider()
    const d = await dispatchQueued(env, w, row.id, sim)
    assert.equal(sim.sent.length, 0)
    assert.match(String(d.out?.reason), /agent_message_unavailable_at_send:agent_message_kill_switch_off/)
    assert.equal((await sel(env.owner, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
    // the R2 stop at dispatch (a second row: reset the lead's day slot by a new day is not possible; use a new lead)
    const L3 = '+13125550173'
    await setControls(env.owner, switches({ threads: [LEAD_A, L3] }))
    const lead3 = await seedLead(env, { phone: L3, pid: 'p203', prospect: 'pr5', first: 'Lee' })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead3.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const ok3 = await send(gateway, cred, { client_request_id: 'am-stop-0004', campaign_target_id: lead3.campaign_target_id })
    await w.tick()
    const row3 = (await agentRows(env)).find((x) => x.metadata.agent_message_intent_id === ok3.intent_id)
    assert.ok(row3, JSON.stringify(await receipt(env, ok3.intent_id)))
    await env.owner.query('update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now() where id = 1')
    const d3 = await dispatchQueued(env, w, row3.id, sim)
    assert.equal(sim.sent.length, 0)
    assert.match(String(d3.out?.reason), /emergency_stop_active/)
  } finally { await env.db.drop() }
})

test('PG agent message: a grant revoked after the authorization stops the message at LeadCommand\'s worker; the database confines the flag', { skip }, async () => {
  const { env, cred, lead, gateway, w } = await world()
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await send(gateway, cred, { client_request_id: 'am-rev-0001', campaign_target_id: lead.campaign_target_id })
    assert.equal(r.code, 'HANDOFF_QUEUED')
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await w.tick()
    assert.deepEqual([(await receipt(env, r.intent_id)).state, (await receipt(env, r.intent_id)).code], ['refused', 'NO_PER_USE_AUTHORITY'])
    assert.equal((await agentRows(env)).length, 0)
    await assert.rejects(mintStanding(env.owner, { capability: 'leads.assign_lead', tier: 2 }), /capability_grants_standing_seller_facing_chk/)
    await assert.rejects(mintStanding(env.owner, { basis: null }), /capability_grants_standing_seller_facing_chk/)
    await assert.rejects(env.owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at, agent_message_lead_day_cap) values ($1, 'agt_alpha', 'conversation.queue_reply', 3, $2, now() + interval '1 day', 2)`, [ORG, OWNER]), /capability_grants_agent_message_lead_day_cap_chk/)
  } finally { await env.db.drop() }
})

test('PG agent message: the event feed — idempotent ids, cursor order, settled rows only, never a phone', { skip }, async () => {
  const { env, cred, gateway } = await world()
  try {
    const app = (k, key) => env.owner.query(`select public.lc_lead_event_append($1, $2, $3, null, $4::jsonb, now()) r`, [k, key, LEAD_A, JSON.stringify({ message_id: key })])
    assert.equal((await app('inbound_message', 'm-1')).rows[0].r.appended, true)
    assert.equal((await app('inbound_message', 'm-1')).rows[0].r.appended, false, 'a webhook retry appends nothing')
    await app('opt_out', 'm-2')
    const early = await call(gateway, cred, 'events_since', { cursor: 0 })
    assert.equal(early.result.events.length, 0, 'unsettled rows are not served yet')
    await new Promise((res) => setTimeout(res, 1100))
    const ev = await call(gateway, cred, 'events_since', { cursor: 0, limit: 1 })
    assert.deepEqual(ev.result.events.map((e) => e.kind), ['inbound_message'])
    const next = await call(gateway, cred, 'events_since', { cursor: ev.result.next_cursor })
    assert.deepEqual(next.result.events.map((e) => e.kind), ['opt_out'])
    assert.ok(!JSON.stringify([ev, next]).includes('3125550171'))
    await assert.rejects(env.owner.query(`update action_gateway.lead_events set kind = 'opt_out'`), /append-only/)
  } finally { await env.db.drop() }
})

test('PG agent message: the ledger keeps every reply invariant; the rollbacks refuse while a live grant / evidence exists, then restore the chain', { skip }, async () => {
  const { env, cred, lead, gateway, w } = await world()
  try {
    const base = `insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version, record_kind)
      values ($1, $2, $3, 'tr:${'a'.repeat(64)}', 'ph:${'b'.repeat(64)}', 'Hi there', encode(sha256(convert_to('Hi there', 'UTF8')), 'hex'), 'd', $4, 'm', 'p', 'p', 'c', '{"status":"validated"}', '${'c'.repeat(64)}', $5::jsonb, 'policy_authorized', now(), 'v', $6)`
    const sc = (cat) => JSON.stringify({ policy_hash: 'x', scope_match: 'thread_keys', category: cat })
    const iid = crypto.randomUUID()
    await assert.rejects(env.owner.query(base, [`agent_message:${iid}`, `agent_message_intent:${iid}`, 'in-1', 'AI_GENERATED_OUTBOUND', sc('first_touch'), 'agent_outbound']), /ai_generated_messages_check/)
    await assert.rejects(env.owner.query(base, [`agent_message:${iid}`, `agent_message_intent:${iid}`, null, 'AI_GENERATED_OUTBOUND', sc('next_missing_fact'), 'agent_outbound']), /authorization_scope_check/)
    await assert.rejects(env.owner.query(base, ['ai_conversation:x', 'inbound_reply:x', null, 'AI_GENERATED_REPLY', sc('next_missing_fact'), 'reply']), /ai_generated_messages_check/)
    await assert.rejects(env.owner.query(base, ['ai_conversation:x', 'inbound_reply:x', 'x', 'AI_GENERATED_OUTBOUND', sc('next_missing_fact'), 'reply']), /decision_outcome_check/)
    await env.owner.query(base, ['ai_conversation:x', 'inbound_reply:x', 'x', 'AI_GENERATED_REPLY', sc('next_missing_fact'), 'reply'])
    // rollback #32: refused while a live standing grant exists
    await assert.rejects(applyInTransaction(env.owner, AM_ROLLBACK), /live grant carries standing_seller_facing/)
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await applyInTransaction(env.owner, AM_ROLLBACK)
    assert.equal((await sel(env.owner, `select count(*)::int n from pg_proc where proname in ('agent_message_refusal', 'lc_agent_message_reserve', 'action_gateway_events_since')`))[0].n, 0)
    assert.equal((await sel(env.owner, `select action_gateway.t34_handoff_kind('queue_agent_message') k`))[0].k, null)
    assert.equal((await sel(env.owner, `select (action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean ok`))[0].ok, true)
    // the ledger link rolls back too (only reply records exist)
    await applyInTransaction(env.owner, LEDGER_ROLLBACK)
    assert.equal((await sel(env.owner, `select count(*)::int n from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname = 'record_kind' and not attisdropped`))[0].n, 0)
    void cred; void lead; void gateway; void w
  } finally { await env.db.drop() }
})

test('PG agent message: the rollback refuses while agent-message evidence (a receipt) exists', { skip }, async () => {
  const { env, cred, lead, gateway } = await world()
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    assert.equal((await send(gateway, cred, { client_request_id: 'am-rb-00001', campaign_target_id: lead.campaign_target_id })).code, 'HANDOFF_QUEUED')
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await assert.rejects(applyInTransaction(env.owner, AM_ROLLBACK), /agent-message receipts exist|agent-message intents are still pending/)
  } finally { await env.db.drop() }
})

// ── the agents' lead pool (leads.read_pool) and the feed's ids ───────────────
const PID = (n) => String(227876840 + n) // numeric property ids: the feed carries them encoded (pid_ + g..p)
const ref = (id) => `pid_${[...String(id)].map((d) => 'ghijklmnop'[Number(d)]).join('')}`

test('PG agent message: the lead pool — a market\'s targets and threads with the send path\'s OWN verdicts; ids and codes only; keyset pages', { skip }, async () => {
  const phones = { ok: '+13125550201', sup: '+13125550202', contacted: '+13125550203', renter: '+13125550204', held: '+13125550205' }
  const { env, cred, gateway } = await world({ sw: switches({ threads: [LEAD_A, ...Object.values(phones), LEAD_T] }) })
  try {
    await env.owner.query(`delete from public.campaign_targets`) // the world's default lead is not part of this market
    const L = {}
    let n = 0
    for (const [k, phone] of Object.entries(phones)) L[k] = await seedLead(env, { phone, pid: PID(n), prospect: `prp${n++}`, first: 'Sam', market: 'Chicago, IL' })
    await env.owner.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [phones.sup])
    await env.owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, created_at, sent_at, metadata) values ('prior-p', 'sent', 'Hi Sam, do you still own it?', $1::text, $2::text, $1::text, now() - interval '30 days', now() - interval '30 days', '{}'::jsonb)`, [phones.contacted, OURS])
    await env.owner.query(`update public.prospects set likely_renting = true, likely_owner = false where prospect_id = $1`, [L.renter.prospect])
    await env.owner.query(`insert into public.automation_holds (hold_key, hold_type, property_id, reason, set_by, approval_ref) values ('h-pool', 'operator_hold', $1, 'operator reviewing', 'owner', 'test')`, [L.held.pid])
    const t = await seedQuietThread(env, { pid: PID(9) })
    await env.owner.query(`update public.inbox_thread_state set market = 'Chicago, IL' where id = $1`, [t.thread_id])
    await env.owner.query(`update public.inbox_thread_state set market = 'Elsewhere' where id <> $1`, [t.thread_id])
    assert.equal((await assign(gateway, cred, { campaign_target_id: L.ok.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const all = await call(gateway, cred, 'agent_lead_pool', { market: 'Chicago, IL', limit: 100 })
    assert.equal(all.ok, true, JSON.stringify(all))
    const by = (id) => all.result.rows.find((r) => r.campaign_target_id === id || r.thread_id === id)
    assert.equal(all.result.rows.length, 6, JSON.stringify(all.result.rows))
    assert.deepEqual([by(L.ok.campaign_target_id).eligible, by(L.ok.campaign_target_id).next_purpose, by(L.ok.campaign_target_id).owner, by(L.ok.campaign_target_id).has_conversation, by(L.ok.campaign_target_id).property_ref],
      [true, 'first_touch', 'self', false, ref(PID(0))])
    assert.match(by(L.sup.campaign_target_id).ineligible_reason, /CONTACT_NOT_ELIGIBLE/)
    assert.equal(by(L.contacted.campaign_target_id).ineligible_reason, 'ALREADY_CONTACTED')
    assert.equal(by(L.renter.campaign_target_id).ineligible_reason, 'PRESEND_INELIGIBLE')
    assert.equal(by(L.held.campaign_target_id).ineligible_reason, 'AUTOMATION_HOLD')
    const quiet = by(t.thread_id)
    assert.deepEqual([quiet.campaign_target_id, quiet.has_conversation, quiet.next_purpose, quiet.eligible, quiet.property_id], [null, true, 'reengage', true, PID(9)], JSON.stringify(quiet))
    // the verdicts are the send path's own: the eligible target is accepted, the refused ones refused with the same code
    for (const k of ['contacted', 'held', 'renter']) {
      assert.equal((await assign(gateway, cred, { campaign_target_id: L[k].campaign_target_id })).code, 'LEAD_ASSIGNED')
      assert.equal((await send(gateway, cred, { client_request_id: `am-pool-${k}`, campaign_target_id: L[k].campaign_target_id })).code, by(L[k].campaign_target_id).ineligible_reason, k)
    }
    // ids and codes only: no number, no name, no message text
    const text = JSON.stringify(all.result)
    for (const p of [...Object.values(phones), LEAD_T]) assert.ok(!text.includes(p.slice(2)), p)
    assert.ok(!/Sam|Dana|own it/.test(text))
    // keyset pages: 2 + 2 + 2, the same rows, in order
    const seen = []
    let cursor
    do {
      const page = await call(gateway, cred, 'agent_lead_pool', { market: 'Chicago, IL', limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.result.rows.map((r) => r.campaign_target_id || r.thread_id))
      cursor = page.result.next_cursor
    } while (cursor)
    assert.deepEqual(seen, all.result.rows.map((r) => r.campaign_target_id || r.thread_id))
    // another market is empty; the read needs its own grant
    assert.equal((await call(gateway, cred, 'agent_lead_pool', { market: 'Nowhere' })).result.rows.length, 0)
    const bare = await agent(env, { agent_id: 'agt_bare', grants: [['events.read', 1]] })
    assert.equal((await call(gateway, bare, 'agent_lead_pool', { market: 'Chicago, IL' })).ok, false)
  } finally { await env.db.drop() }
})

test('PG agent message: the feed carries the lead\'s ids — property_id (encoded) and campaign_target_id on delivery and inbound events, the thread once the first touch created it', { skip }, async () => {
  const { env, cred, gateway, w } = await world()
  try {
    await env.owner.query(`delete from public.campaign_targets`)
    const lead = await seedLead(env, { phone: LEAD_A, pid: PID(3), prospect: 'prf', first: 'Maria' })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await send(gateway, cred, { client_request_id: 'am-ids-0001', campaign_target_id: lead.campaign_target_id })
    assert.equal(r.code, 'HANDOFF_QUEUED', JSON.stringify(r))
    await w.tick()
    const [row] = await agentRows(env)
    await dispatchQueued(env, w, row.id, simProvider())
    await w.execution.reconcileReceipts()
    const [thread] = await sel(env.owner, 'select id from public.inbox_thread_state where thread_key = $1', [LEAD_A])
    const ev = await sel(env.owner, `select kind, thread_id, payload from action_gateway.lead_events where intent_id = $1 order by cursor`, [r.intent_id])
    assert.deepEqual(ev.map((e) => e.payload.receipt_state), ['enqueued', 'sent'])
    for (const e of ev) assert.deepEqual([e.payload.property_id, e.payload.campaign_target_id, e.payload.purpose], [ref(PID(3)), lead.campaign_target_id, 'first_touch'])
    assert.ok(thread, 'the first touch created the thread')
    assert.equal(ev[0].thread_id, null, 'enqueued: no thread exists yet')
    assert.equal(ev.at(-1).thread_id, thread.id, 'the sent event names the thread the send created')
    // an inbound on that number (the webhook's writer) carries the same ids
    const a = await env.owner.query(`select public.lc_lead_event_append('inbound_message', 'm-ids-1', $1, null, '{"message_id":"m-ids-1","stop_request":false}'::jsonb, now()) r`, [LEAD_A])
    const [inb] = await sel(env.owner, `select thread_id, payload from action_gateway.lead_events where cursor = $1`, [a.rows[0].r.cursor])
    assert.deepEqual([inb.thread_id, inb.payload.property_id, inb.payload.campaign_target_id], [thread.id, ref(PID(3)), lead.campaign_target_id])
  } finally { await env.db.drop() }
})

test('PG agent message: send controls — the R2 stop, the queue stop and the switches as an agent sees them (no identities); under R2 the certified reply is refused at request time like the agent message', { skip }, async () => {
  const { env, cred, lead, gateway } = await world({ sw: switches({ threads: [LEAD_A, SELLER] }) })
  try {
    const t = await seedThread(env.owner, { phone: SELLER, inboundBody: 'Yes I still own it. Is the roof a problem?' })
    const replier = await agent(env, { agent_id: 'agt_reply', grants: [['conversation.queue_reply', 3], ['controls.read', 1]], tier_ceiling: 3 })
    const c0 = await call(gateway, cred, 'send_controls', {})
    assert.equal(c0.ok, true, JSON.stringify(c0))
    assert.deepEqual([c0.result.runtime_emergency_stop.on, c0.result.send_emergency_stop.on, c0.result.ai_send_enabled, c0.result.agent_message_enabled, c0.result.agent_message_refusal, c0.result.queue_processor_mode, c0.result.seller_sends],
      [false, false, true, true, null, 'live', 'enabled'])
    const before = await call(gateway, replier, 'queue_authorized_reply', { client_request_id: 'r2-reply-0001', thread_id: t.thread_id })
    assert.equal(before.code, 'TIER_REQUIRES_APPROVAL', JSON.stringify(before))
    // the operator engages the R2 runtime emergency stop (as the ops console does: a named operator)
    const stop = (await env.owner.query(`select agent.runtime_emergency_stop($1, 'reviewing a misfire') r`, [OPERATOR])).rows[0].r
    assert.equal(stop.ok, true)
    const c1 = await call(gateway, cred, 'send_controls', {})
    assert.deepEqual([c1.result.runtime_emergency_stop.on, c1.result.runtime_emergency_stop.reason_code, c1.result.runtime_emergency_stop.set_by_role, c1.result.agent_message_refusal, c1.result.seller_sends],
      [true, 'operator_emergency_stop', 'operator', 'EMERGENCY_STOP_ACTIVE', 'stopped'])
    assert.ok(Date.parse(c1.result.runtime_emergency_stop.at) > 0)
    assert.ok(!JSON.stringify(c1).includes(OPERATOR) && !JSON.stringify(c1).includes('misfire'), 'no operator identity, no free-text reason')
    for (const [who, tool, args] of [[replier, 'queue_authorized_reply', { client_request_id: 'r2-reply-0002', thread_id: t.thread_id }],
      [cred, 'queue_agent_message', { client_request_id: 'r2-am-00001', campaign_target_id: lead.campaign_target_id, purpose: 'first_touch', brief: BRIEF }]]) {
      const r = await call(gateway, who, tool, args)
      assert.deepEqual([r.error?.code, r.error?.details?.reason], ['capability_unavailable', 'EMERGENCY_STOP_ACTIVE'], `${tool}: ${JSON.stringify(r)}`)
    }
    // the database refuses it too, whatever the gateway process believed (the authorization's own check)
    assert.equal((await sel(env.owner, `select action_gateway.t34_capability_refusal('queue_authorized_reply') c`))[0].c, 'EMERGENCY_STOP_ACTIVE')
    // cleared on the owner path: the reply is requestable again
    await env.owner.query(`update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1`)
    assert.equal((await call(gateway, replier, 'queue_authorized_reply', { client_request_id: 'r2-reply-0003', thread_id: t.thread_id })).code, 'TIER_REQUIRES_APPROVAL')
    // the queue stop is reported too
    await setControls(env.owner, { queue_emergency_stop_at: new Date().toISOString() })
    assert.equal((await call(gateway, cred, 'send_controls', {})).result.send_emergency_stop.on, true)
    // the read needs its grant
    const bare = await agent(env, { agent_id: 'agt_nocontrols', grants: [['events.read', 1]] })
    assert.equal((await call(gateway, bare, 'send_controls', {})).ok, false)
  } finally { await env.db.drop() }
})
