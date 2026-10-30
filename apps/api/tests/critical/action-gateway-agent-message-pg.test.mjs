// Link #32 (PROPOSED_20261029100000) + the ledger kinds (PROPOSED_20261029090000) on a DISPOSABLE PostgreSQL 17, after the
// owner's architecture correction (2026-10-29): "Agntei owns the intelligence and conversation. LeadCommand owns messaging
// infrastructure and compliance enforcement. The carrier delivers the SMS." An agent sends the EXACT text it composed
// (queue_agent_text): LeadCommand validates it deterministically, records it word for word in the AI-message ledger
// (record_kind agent_text, the author and attribution, NO model call — the worker's model provider throws if touched),
// queues it once and the REAL queue runner sends it once to a SIMULATED provider. Every gate is proven here: born OFF
// (its own switch, never the reply engine's), both emergency stops (request AND dispatch), the standing grant (and its
// absence), revocation, ONE holder per lead + transfer_lead, per-lead serialization, an answer bound to the latest
// inbound (one answer per inbound), suppression / Spanish STOP / wrong number / renter / hold / the opener rule / the
// window, the caps, idempotency (IDEMPOTENCY_CONFLICT), the content validator (CONTENT_REJECTED, MONEY_NOT_AUTHORIZED),
// the retired composer paths (AGENT_COMPOSES_TEXT), the stand-down of LeadCommand's own engine on an agent-held lead, the
// event feed (incl. the carrier's delivered verdict and the production receipt sweep), and the rollbacks.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { agentMessageDb, AM_ROLLBACK, LEDGER_ROLLBACK } from '../helpers/action-gateway-agent-message-pg.mjs'
import { makeGateway, trapTransport, ORG, OWNER } from '../helpers/action-gateway-pg.mjs'
import { simProvider, lawfulNowIso } from '../helpers/followup-lifecycle-pg.mjs'
import { fakeProvider } from '../helpers/conversation-ai-runtime-fakes.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { seedT34, agent, worker, receipt, liveDispatch, dispatchQueued, setControls, sel, crypto, OURS } from '../helpers/action-gateway-t34-world.mjs'
import { seedThread, OPERATOR, SELLER } from '../helpers/action-gateway-pg.mjs'
import { createCanonicalTurnDecider } from '../../src/lib/ai/conversation-turn-wiring.js'
import { createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { syncDeliveryEvent } from '../../src/lib/supabase/sms-engine.js'
import { actionGatewayRuntimeMaintenance, __resetReceiptSweepThrottleForTests } from '../../src/lib/ai/action-gateway-execution.js'
import { AGENT_HELD_STAND_DOWN } from '../../src/lib/ai/agent-lead-stand-down.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const BASIS = 'owner decision 2026-10-29 (disposable test): agents send the texts they compose'
const CLOCK = lawfulNowIso() // inside 09:00-19:00 Chicago: the scenarios never depend on the hour the suite runs
const clockMs = () => Date.parse(CLOCK)
// grants are minted at the database's now(); the gateway judges them at the frozen CLOCK, so they are valid from before both
const VALID_FROM = new Date(Math.min(Date.now(), clockMs()) - 3_600_000).toISOString()
const valid = (grants) => grants.map(([capability, tier, o]) => [capability, tier, { validFrom: VALID_FROM, ...(o || {}) }])
const NIGHT = (() => { let t = Date.parse(CLOCK); const h = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms))); while (h(t) !== 2) t += 3_600_000; return t })()
const LEAD_A = '+13125550171' // first-touch lead (no conversation)
const ATTR = { employee: 'nova', model: 'claude-sonnet-x', provider: 'anthropic', route: 'agntei.acquisitions.representative', session_id: null, turn_id: 'turn-001' }
const FIRST_TOUCH = 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Elm St?'
const COMPANY = JSON.stringify({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })

/** A model provider that must never be called: nothing on the agent-text path composes. */
const noModel = () => fakeProvider(() => { throw new Error('A MODEL WAS CALLED ON THE AGENT-TEXT PATH') })
// the contact scope is REQUIRED (AGENT_TEXT_SCOPE_NOT_SET otherwise): every test number, as an activation lists its contacts
const TEST_SCOPE = JSON.stringify({ enabled: false, scope: { thread_keys: Array.from({ length: 120 }, (_, i) => `+1312555${String(100 + i).padStart(4, '0')}`), market_ids: ['Chicago'] } })
const switches = (extra = {}) => ({ ai_agent_text_enabled: 'true', ai_conversation_company_identity: COMPANY, ai_conversation_send_policy: TEST_SCOPE, ...extra })

const GRANTS = [['leads.assign_lead', 2], ['leads.release_lead', 2], ['leads.read_assignment', 1], ['events.read', 1], ['leads.read_pool', 1], ['controls.read', 1]]
/** An owner mints the standing seller-facing grant for agent texts (grants are immutable: a new grant, never an edit). */
const mintStanding = (owner, { agent_id = 'agt_alpha', capability = 'conversation.queue_agent_text', tier = 3, basis = BASIS } = {}) => owner.query(
  `insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_failures_per_hour, max_cap_hits_per_hour, granted_by, valid_from, expires_at, standing_seller_facing, standing_basis)
   values ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 30, 200, 0, 5, 5, $5, $7::timestamptz, now() + interval '30 days', true, $6) returning grant_id`, [ORG, agent_id, capability, tier, OWNER, basis, VALID_FROM])

async function seedLead(env, { phone = LEAD_A, pid = 'p200', prospect = 'pr2', first = 'Maria', status = 'ready', identity = 'verified', market = 'Chicago' } = {}) {
  await env.owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ($1, 'SFR', 'Chicago', 'IL', '60601', '18 Elm St') on conflict do nothing`, [pid])
  await env.owner.query(`insert into public.prospects (prospect_id, first_name, full_name) values ($1, $2, $2 || ' R') on conflict do nothing`, [prospect, first])
  const camp = (await env.owner.query(`insert into public.campaigns (name, status) values ('agent first touch', 'active') returning id`)).rows[0].id
  const id = (await env.owner.query(`insert into public.campaign_targets (campaign_id, property_id, prospect_id, to_phone_number, market, language, state, property_address, touch_number, target_status, routing_status, identity_status, suppression_status, metadata)
    values ($1, $2, $3, $4, $5, 'English', 'IL', '18 Elm St', 1, $6, 'ready', $7, 'clear', jsonb_build_object('candidate_snapshot', jsonb_build_object('seller_first_name', $8::text))) returning id`, [camp, pid, prospect, phone, market, status, identity, first])).rows[0].id
  return { campaign_target_id: id, campaign_id: camp, phone, pid, prospect }
}

async function world({ sw = switches(), standing = true, agents = ['agt_alpha'], supervisor = false } = {}) {
  const env = await agentMessageDb()
  await seedT34(env)
  await setControls(env.owner, sw)
  await liveDispatch(env)
  const creds = {}
  for (const a of agents) {
    creds[a] = await agent(env, { agent_id: a, grants: valid(standing ? GRANTS : [...GRANTS, ['conversation.queue_agent_text', 3]]) })
    if (standing) await mintStanding(env.owner, { agent_id: a })
  }
  if (supervisor) creds.agt_sterling = await agent(env, { agent_id: 'agt_sterling', grants: valid([...GRANTS, ['leads.transfer_lead', 2]]) })
  const lead = await seedLead(env)
  const { gateway } = makeGateway(env, { now: clockMs, legacyComposer: false })
  const prov = noModel()
  const w = worker(env, { prov, now: clockMs, legacyComposer: false })
  return { env, creds, cred: creds[agents[0]], lead, gateway, w, prov }
}
const call = (g, cred, tool, args) => g.call({ credential: cred, tool, args })
const key = (p) => `${p}-${crypto.randomUUID().slice(0, 8)}`
const assign = (g, cred, lead, k = key('assign')) => call(g, cred, 'assign_lead', { client_request_id: k, ...lead })
const text = (g, cred, args) => call(g, cred, 'queue_agent_text', { purpose: 'first_touch', body: FIRST_TOUCH, attribution: ATTR, ...args })
const agentRows = (env) => sel(env.owner, `select * from public.send_queue where queue_key like 'agent_text:%' order by created_at`)
const approvals = (env) => sel(env.owner, 'select count(*)::int n from agent.approval_request').then((r) => r[0].n)
const settle = () => new Promise((res) => setTimeout(res, 1100)) // the feed serves settled rows (older than one second)

test('PG agent text: born OFF — AGENT_TEXT_KILL_SWITCH_OFF until ITS switch is on; the reply engine\'s switch neither opens nor closes it', { skip }, async () => {
  const { env, cred, lead, gateway } = await world({ sw: { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [LEAD_A] } }) } })
  try {
    const off = await text(gateway, cred, { client_request_id: 'at-off-0001', campaign_target_id: lead.campaign_target_id })
    assert.deepEqual([off.error?.code, off.error?.details?.reason], ['AGENT_TEXT_KILL_SWITCH_OFF', 'AGENT_TEXT_KILL_SWITCH_OFF'], JSON.stringify(off))
    await setControls(env.owner, { ai_conversation_send_enabled: null, ai_conversation_send_policy: null, ...switches() })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const on = await text(gateway, cred, { client_request_id: 'at-off-0002', campaign_target_id: lead.campaign_target_id })
    assert.equal(on.code, 'HANDOFF_QUEUED', JSON.stringify(on))
  } finally { await env.db.drop() }
})

test('PG agent text: the EXACT first touch on a standing grant — no approval, NO model, ONE agent_text ledger record (author + attribution verbatim) + ONE row; the REAL runner sends the exact words once; replay = the same intent; another body under the id = IDEMPOTENCY_CONFLICT; the feed carries enqueued / sent / delivered', { skip }, async () => {
  const { env, cred, lead, gateway, w, prov } = await world()
  const net = trapTransport()
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const args = { client_request_id: 'at-ft-00001', campaign_target_id: lead.campaign_target_id }
    const first = await text(gateway, cred, args)
    assert.equal(first.code, 'HANDOFF_QUEUED', JSON.stringify(first))
    assert.equal(await approvals(env), 0, 'no per-message approval is filed')
    const auth = (await sel(env.owner, 'select standing, approval_id, evidence from action_gateway.action_authorizations where intent_id = $1', [first.intent_id]))[0]
    assert.deepEqual([auth.standing, auth.approval_id, auth.evidence.authority, auth.evidence.composer], [true, null, 'standing_seller_facing', 'agent'])
    // the intent carries hashes, never the words
    const [intent] = await sel(env.owner, 'select params from action_gateway.action_intents where intent_id = $1', [first.intent_id])
    assert.ok(!JSON.stringify(intent.params).includes('Kapiolani') && !JSON.stringify(intent.params).includes('this is Nova') && /^[0-9a-f]{64}$/.test(intent.params.text_hash), JSON.stringify(intent.params))
    await w.tick()
    const r = await receipt(env, first.intent_id)
    assert.deepEqual([r.state, r.code], ['enqueued', 'AGENT_TEXT_ENQUEUED'], JSON.stringify(r))
    assert.equal(prov.calls.length, 0, 'no model was called')
    const rows = await agentRows(env)
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].message_body, rows[0].message_origin, rows[0].source, rows[0].template_id, rows[0].max_retries, rows[0].metadata.agent_text_intent_id], [FIRST_TOUCH, 'ai_generated', 'ai_conversation', null, 1, first.intent_id])
    const [rec] = await sel(env.owner, 'select * from public.ai_generated_messages where queue_key = $1', [`agent_text:${first.intent_id}`])
    assert.deepEqual([rec.record_kind, rec.decision_outcome, rec.message_body, rec.inbound_message_id, rec.author_employee, rec.model, rec.authorization_scope.category, Number(rec.cost_usd)],
      ['agent_text', 'AGENT_COMPOSED_TEXT', FIRST_TOUCH, null, 'nova', 'claude-sonnet-x', 'first_touch', 0])
    assert.deepEqual(rec.author_attribution, { employee: 'nova', model: 'claude-sonnet-x', provider: 'anthropic', route: 'agntei.acquisitions.representative', turn_id: 'turn-001' }, 'stored verbatim (a null session id is absent)')
    // the REAL runner, a SIMULATED provider: exactly one send, the exact words (a greeting + comma is ordinary writing here)
    const sim = simProvider()
    const d = await dispatchQueued(env, w, rows[0].id, sim)
    assert.equal(sim.sent.length, 1, JSON.stringify(d.out))
    assert.equal(sim.sent[0].body, FIRST_TOUCH)
    // the production receipt sweep (a runtime-tick maintenance task) follows the row to 'sent'
    __resetReceiptSweepThrottleForTests()
    const [sweep] = actionGatewayRuntimeMaintenance({ LC_ACTION_GATEWAY_EXECUTION: '1' }, { execution: w.execution })
    assert.ok((await sweep.run({ now: new Date().toISOString() })).recorded >= 1)
    __resetReceiptSweepThrottleForTests()
    assert.equal((await receipt(env, first.intent_id)).state, 'sent')
    // the carrier's verdict through the REAL delivery reconciliation (syncDeliveryEvent): 'delivered' on the agents' feed
    const [sentRow] = await sel(env.owner, 'select id, provider_message_id, metadata from public.send_queue where id = $1', [rows[0].id])
    const delivered = await syncDeliveryEvent({ message_id: sentRow.provider_message_id || 'SMsim1', status: 'delivered' }, { supabase: w.sb, force_local_delivery_reconcile: true,
      reconcileDeliveryReceipt: async () => ({ final_delivery_status: 'delivered', send_queue_data: [sentRow], message_events_data: [] }), updateContactOutreachState: async () => ({ ok: true }) })
    assert.equal(delivered.final_delivery_status, 'delivered')
    // replay: the same intent, nothing new; another body under the same id is a conflict
    const again = await text(gateway, cred, args)
    assert.equal(again.status, 'replayed')
    const conflict = await text(gateway, cred, { ...args, body: 'Hi, this is Nova. Are you still the owner of the house on Elm St?' })
    assert.equal(conflict.error?.code, 'IDEMPOTENCY_CONFLICT', JSON.stringify(conflict))
    await w.tick()
    assert.equal((await agentRows(env)).length, 1)
    assert.deepEqual(net.hits, [])
    await settle()
    const ev = await call(gateway, cred, 'events_since', { cursor: 0 })
    const kinds = ev.result.events.filter((e) => e.intent_id === first.intent_id).map((e) => e.payload.receipt_state)
    assert.deepEqual(kinds, ['enqueued', 'sent', 'delivered'], JSON.stringify(ev.result.events))
    assert.ok(!JSON.stringify(ev.result).includes('3125550171') && !JSON.stringify(ev.result).includes('this is Nova'))
  } finally { net.restore(); await env.db.drop() }
})

test('PG agent text: without the standing flag the text waits for a human (TIER_REQUIRES_APPROVAL)', { skip }, async () => {
  const { env, cred, lead, gateway } = await world({ standing: false })
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await text(gateway, cred, { client_request_id: 'at-nostand-1', campaign_target_id: lead.campaign_target_id })
    assert.deepEqual([r.status, r.code], ['approval_pending', 'TIER_REQUIRES_APPROVAL'], JSON.stringify(r))
  } finally { await env.db.drop() }
})

// ── a conversation: an answer bound to the latest inbound ─────────────────────
const LEAD_T = '+13125550181'
async function seedQuietThread(env, { phone = LEAD_T, pid = 'p300', days = 5 } = {}) {
  const id = crypto.randomUUID()
  await env.owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ($1, 'SFR', 'Chicago', 'IL', '60601', '12 Oak St') on conflict do nothing`, [pid])
  await env.owner.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, our_number, prospect_id) values ($1, $2, $2, $3, $4, 'pr1')`, [id, phone, pid, OURS])
  const ev = (dir, body, hoursAgo) => env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
    values ($1, $2, $3, $4::text, $5::text, $6::text, $7, now() - make_interval(hours => $8::int), now() - make_interval(hours => $8::int), $9, 'en') returning id`,
  [crypto.randomUUID(), `SM${crypto.randomUUID().slice(0, 12)}`, dir, phone, dir === 'outbound' ? OURS : phone, dir === 'outbound' ? phone : OURS, body, hoursAgo, pid])
  await ev('outbound', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', days * 24 + 3)
  await ev('inbound', 'Yes I still own it', days * 24 + 2)
  await ev('outbound', 'Thanks for confirming, appreciate it.', days * 24 + 1)
  await env.owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, created_at, sent_at, metadata)
    values ($1, 'sent', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', $2::text, $3::text, $2::text, 'ownership_check', 'Helen', now() - make_interval(hours => $4::int), now() - make_interval(hours => $4::int), '{}'::jsonb)`, [`seed-${id}`, phone, OURS, days * 24 + 3])
  return { thread_id: id, phone, pid }
}
const inboundNow = async (env, phone, body, pid = 'p300') => (await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, created_at, property_id)
  values ($1, $2, 'inbound', $3::text, $3::text, $4::text, $5, now() - interval '2 minutes', $6) returning id`, [crypto.randomUUID(), `SMin${crypto.randomUUID().slice(0, 8)}`, phone, OURS, body, pid])).rows[0].id

test('PG agent text: an ANSWER names the latest unanswered inbound (IN_REPLY_TO_REQUIRED / IN_REPLY_TO_NOT_LATEST_INBOUND / UNANSWERED_SELLER_MESSAGE); ONE answer per inbound; a follow-up of a quiet thread; the reply is sent with the established sender', { skip }, async () => {
  const { env, cred, gateway, w } = await world()
  try {
    const t = await seedQuietThread(env)
    assert.equal((await assign(gateway, cred, { thread_id: t.thread_id })).code, 'LEAD_ASSIGNED')
    const fu = await text(gateway, cred, { client_request_id: 'at-fu-00001', thread_id: t.thread_id, purpose: 'followup', body: 'Hi Dana, Nova here. Would you consider selling the house on Oak St?' })
    assert.equal(fu.code, 'HANDOFF_QUEUED', JSON.stringify(fu))
    await w.tick()
    assert.equal((await receipt(env, fu.intent_id)).code, 'AGENT_TEXT_ENQUEUED', JSON.stringify(await receipt(env, fu.intent_id)))
    await env.owner.query(`update public.send_queue set queue_status = 'sent', sent_at = now() - interval '1 hour' where queue_key = $1`, [`agent_text:${fu.intent_id}`])
    await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, created_at, property_id) values ($1, 'SMfu1', 'outbound', $2::text, $3::text, $2::text, 'Hi Dana, Nova here. Would you consider selling the house on Oak St?', now() - interval '1 hour', 'p300')`, [crypto.randomUUID(), LEAD_T, OURS])
    const inb = await inboundNow(env, LEAD_T, 'Maybe. The roof needs work though, is that a problem?')
    const base = { thread_id: t.thread_id, purpose: 'reply', body: 'Thanks for letting me know about the roof, that is not a problem for us. When would you ideally want to sell?' }
    assert.equal((await text(gateway, cred, { ...base, client_request_id: 'at-ans-0001' })).code, 'IN_REPLY_TO_REQUIRED')
    const [ourOut] = await sel(env.owner, `select id from public.message_events where provider_message_sid = 'SMfu1'`)
    assert.equal((await text(gateway, cred, { ...base, client_request_id: 'at-ans-0002', in_reply_to_message_id: String(ourOut.id) })).code, 'IN_REPLY_TO_NOT_LATEST_INBOUND')
    assert.equal((await text(gateway, cred, { client_request_id: 'at-ans-0003', thread_id: t.thread_id, purpose: 'nurture', body: 'Hi Dana, just checking in on the house.' })).code, 'UNANSWERED_SELLER_MESSAGE')
    const ok = await text(gateway, cred, { ...base, client_request_id: 'at-ans-0004', in_reply_to_message_id: String(inb) })
    assert.equal(ok.code, 'HANDOFF_QUEUED', JSON.stringify(ok))
    // while the first answer is being prepared, nothing else goes to this seller (per-lead serialization)
    const racing = await text(gateway, cred, { ...base, client_request_id: 'at-ans-0005', in_reply_to_message_id: String(inb), body: 'Got it, the roof is fine with us. What timeline works for you?' })
    assert.equal(racing.code, 'LEAD_SEND_IN_FLIGHT', JSON.stringify(racing))
    await w.tick()
    assert.equal((await receipt(env, ok.intent_id)).code, 'AGENT_TEXT_ENQUEUED', JSON.stringify(await receipt(env, ok.intent_id)))
    // a second answer to the same inbound (the first is queued, not sent yet): refused at the handoff — one answer per inbound
    const second = await text(gateway, cred, { ...base, client_request_id: 'at-ans-0006', in_reply_to_message_id: String(inb), body: 'Got it, the roof is fine with us. What timeline works for you?' })
    assert.equal(second.code, 'INBOUND_ALREADY_ANSWERED', JSON.stringify(second))
    const [row] = await sel(env.owner, 'select * from public.send_queue where queue_key = $1', [`agent_text:${ok.intent_id}`])
    assert.deepEqual([row.from_phone_number, row.agent_name, row.metadata.agent_text.in_reply_to_message_id], [OURS, 'Nova', String(inb)])
    const [rec] = await sel(env.owner, 'select inbound_message_id, authorization_scope from public.ai_generated_messages where queue_key = $1', [`agent_text:${ok.intent_id}`])
    assert.deepEqual([rec.inbound_message_id, rec.authorization_scope.category], [String(inb), 'reply'])
    // the inbound's ONE reply reservation is this answer's (the reply engines' shared scope)
    assert.equal((await sel(env.owner, `select claim_token::text t, status from public.idempotency_ledger where scope = 'inbound_reply' and key = $1`, [String(inb)]))[0].t, ok.intent_id)
    const sim = simProvider()
    await dispatchQueued(env, w, row.id, sim)
    assert.deepEqual(sim.sent.map((s) => s.body), [base.body])
  } finally { await env.db.drop() }
})

test('PG agent text: the content validator names every rule — money without authority (MONEY_NOT_AUTHORIZED), a human claim, an unanswered bot question, two questions, a link, an invented acknowledgement (CONTENT_REJECTED + reasons[]); the honest disclosure passes', { skip }, async () => {
  const { env, cred, gateway } = await world()
  try {
    const t = await seedQuietThread(env)
    assert.equal((await assign(gateway, cred, { thread_id: t.thread_id })).code, 'LEAD_ASSIGNED')
    const bot = await inboundNow(env, LEAD_T, 'Are you a bot or a real person?')
    const ask = (k, body, purpose = 'reply') => text(gateway, cred, { client_request_id: k, thread_id: t.thread_id, purpose, in_reply_to_message_id: String(bot), body })
    const money = await ask('at-c-00001', 'We could pay $150,000 cash for it. Would that work?', 'negotiation')
    assert.deepEqual([money.state, money.code], ['refused', 'MONEY_NOT_AUTHORIZED'], JSON.stringify(money))
    assert.ok(money.result.reasons.includes('money:no_negotiation_authority_for_this_lead'))
    for (const [k, body, reason] of [
      ['at-c-00002', 'I am a real person, not a bot. Would you consider selling?', 'persona:denies_automation'],
      ['at-c-00003', 'Good question. Would you consider selling the house?', 'identity:automation_question_unanswered'],
      ['at-c-00004', 'I am an AI assistant. Would you sell? What price?', 'content:more_than_one_question'],
      ['at-c-00005', 'I am an AI assistant, see https://example.com. Would you sell?', 'content:contains_link'],
    ]) {
      const r = await ask(k, body)
      assert.deepEqual([r.state, r.code], ['refused', 'CONTENT_REJECTED'], `${body}: ${JSON.stringify(r)}`)
      assert.ok(r.result.reasons.includes(reason), `${body}: ${r.result.reasons}`)
    }
    const honest = await ask('at-c-00006', 'I am an AI assistant with Reivesti Home Buyers, writing for Nova. Would you consider selling the house?')
    assert.equal(honest.code, 'HANDOFF_QUEUED', JSON.stringify(honest))
  } finally { await env.db.drop() }
})

test('PG agent text: every compliance gate refuses before anything is queued — suppression, a Spanish STOP, wrong number, renter, hold, the first-touch opener rule, outside 08:00–21:00 (with next_permitted_at), a STOP in the latest inbound of a held thread', { skip }, async () => {
  const phones = { sup: '+13125550191', stop: '+13125550192', wrong: '+13125550193', renter: '+13125550194', held: '+13125550195', contacted: '+13125550196' }
  const { env, cred, gateway } = await world()
  try {
    const L = {}
    let n = 0
    for (const [k, phone] of Object.entries(phones)) L[k] = await seedLead(env, { phone, pid: `pg${n}`, prospect: `prg${n++}`, first: 'Sam' })
    await env.owner.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [phones.sup])
    const st = crypto.randomUUID()
    await env.owner.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id) values ($1, $2, $2, 'pg1')`, [st, phones.stop])
    await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, created_at, property_id) values ($1, 'SMalto', 'inbound', $2::text, $2::text, $3::text, 'ALTO', now() - interval '2 days', 'pg1')`, [crypto.randomUUID(), phones.stop, OURS])
    await env.owner.query(`insert into public.phones (phone_id, canonical_e164, phone_contact_status) values ('ph-wrong', $1, 'wrong_number')`, [phones.wrong])
    await env.owner.query(`update public.prospects set likely_renting = true, likely_owner = false where prospect_id = $1`, [L.renter.prospect])
    await env.owner.query(`insert into public.automation_holds (hold_key, hold_type, property_id, reason, set_by, approval_ref) values ('h-at', 'operator_hold', $1, 'operator reviewing', 'owner', 'test')`, [L.held.pid])
    await env.owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, created_at, sent_at, metadata) values ('prior-1', 'sent', 'Hi Sam, do you still own it?', $1::text, $2::text, $1::text, now() - interval '30 days', now() - interval '30 days', '{}'::jsonb)`, [phones.contacted, OURS])
    const expect = { sup: /CONTACT_SUPPRESSED|CONTACT_NOT_ELIGIBLE|STOP_REQUESTED|CONTACT_NOT_PERMITTED/, stop: /STOP_REQUESTED|CONTACT_NOT_ELIGIBLE|CONTACT_NOT_PERMITTED|UNANSWERED_SELLER_MESSAGE/, wrong: /CONTACT_NOT_ELIGIBLE/, renter: /PRESEND_INELIGIBLE/, held: /AUTOMATION_HOLD/, contacted: /ALREADY_CONTACTED/ }
    for (const [k, rx] of Object.entries(expect)) {
      assert.equal((await assign(gateway, cred, { campaign_target_id: L[k].campaign_target_id })).code, 'LEAD_ASSIGNED', k)
      const r = await text(gateway, cred, { client_request_id: `at-gate-${k}`, campaign_target_id: L[k].campaign_target_id, body: 'Hi Sam, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house?' })
      assert.equal(r.state, 'refused', `${k}: ${JSON.stringify(r)}`)
      assert.match(r.code, rx, `${k}: ${r.code} ${JSON.stringify(r.result)}`)
    }
    // the recipient window: REFUSED with the next permitted time, never scheduled
    const lead = await seedLead(env, { phone: LEAD_A, pid: 'pw', prospect: 'prw' })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const { gateway: night } = makeGateway(env, { now: () => NIGHT, legacyComposer: false })
    const r = await text(night, cred, { client_request_id: 'at-gate-night', campaign_target_id: lead.campaign_target_id })
    assert.equal(r.code, 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(r))
    assert.ok(Date.parse(r.result.next_permitted_at) > NIGHT)
    // a STOP as the latest message of a thread the agent holds: the answer is refused STOP_REQUESTED
    const t = await seedQuietThread(env)
    assert.equal((await assign(gateway, cred, { thread_id: t.thread_id })).code, 'LEAD_ASSIGNED')
    const stopId = await inboundNow(env, LEAD_T, 'STOP')
    const s = await text(gateway, cred, { client_request_id: 'at-gate-stop2', thread_id: t.thread_id, purpose: 'reply', in_reply_to_message_id: String(stopId), body: 'Understood. Thanks for letting me know.' })
    assert.match(s.code, /STOP_REQUESTED|CONTACT_NOT_ELIGIBLE/, JSON.stringify(s))
    assert.equal((await agentRows(env)).length, 0)
  } finally { await env.db.drop() }
})

test('PG agent text: ONE holder per lead — NOT_LEAD_OWNER; a supervisor transfers the lead (lead_transferred on the feed, the old holder refused, its queued text cancelled at dispatch); a target that cannot text or is no agent is refused; replay-safe', { skip }, async () => {
  const { env, creds, lead, gateway, w } = await world({ agents: ['agt_nova', 'agt_beta'], supervisor: true })
  try {
    const [N, B, S] = [creds.agt_nova, creds.agt_beta, creds.agt_sterling]
    assert.equal((await text(gateway, B, { client_request_id: 'at-own-0001', campaign_target_id: lead.campaign_target_id })).code, 'NOT_LEAD_OWNER')
    assert.equal((await assign(gateway, N, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    assert.equal((await assign(gateway, B, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_OWNED_BY_ANOTHER_AGENT')
    // nova queues a text …
    const q = await text(gateway, N, { client_request_id: 'at-own-0002', campaign_target_id: lead.campaign_target_id })
    assert.equal(q.code, 'HANDOFF_QUEUED', JSON.stringify(q))
    await w.tick()
    const [row] = await agentRows(env)
    assert.ok(row, JSON.stringify(await receipt(env, q.intent_id)))
    // … the head of acquisitions moves the lead to beta (beta holds conversation.queue_agent_text)
    const tr = { campaign_target_id: lead.campaign_target_id, to_agent_id: 'agt_beta', reason: 'reassigning to the closer of this market' }
    assert.equal((await call(gateway, N, 'transfer_lead', { client_request_id: 'at-tr-00001', ...tr })).error?.code, 'CAPABILITY_NOT_GRANTED', 'only a supervisor transfers')
    assert.equal((await call(gateway, S, 'transfer_lead', { client_request_id: 'at-tr-00002', ...tr, to_agent_id: 'agt_sterling' })).code, 'TRANSFER_TARGET_CANNOT_TEXT')
    assert.equal((await call(gateway, S, 'transfer_lead', { client_request_id: 'at-tr-00003', ...tr, to_agent_id: 'agt_nobody' })).code, 'TRANSFER_TARGET_NOT_AN_AGENT')
    const moved = await call(gateway, S, 'transfer_lead', { client_request_id: 'at-tr-00004', ...tr })
    assert.deepEqual([moved.code, moved.result.from_agent_id, moved.result.to_agent_id], ['LEAD_TRANSFERRED', 'agt_nova', 'agt_beta'], JSON.stringify(moved))
    assert.equal((await call(gateway, S, 'transfer_lead', { client_request_id: 'at-tr-00004', ...tr })).status, 'replayed')
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.lead_assignments where released_at is null`))[0].n, 1, 'exactly one holder')
    // the old holder: refused on any send; what it queued is cancelled at dispatch, never sent
    assert.equal((await text(gateway, N, { client_request_id: 'at-own-0003', campaign_target_id: lead.campaign_target_id })).code, 'NOT_LEAD_OWNER')
    const sim = simProvider()
    const d = await dispatchQueued(env, w, row.id, sim)
    assert.equal(sim.sent.length, 0)
    assert.equal(d.out?.reason, 'agent_text_author_no_longer_holds_lead', JSON.stringify(d.out))
    await settle()
    const ev = (await call(gateway, S, 'events_since', { cursor: 0 })).result.events.filter((e) => e.kind === 'lead_transferred')
    assert.deepEqual(ev.map((e) => [e.payload.from_agent_id, e.payload.to_agent_id, e.payload.requested_by, e.payload.campaign_target_id]), [['agt_nova', 'agt_beta', 'agt_sterling', lead.campaign_target_id]])
    assert.equal((await call(gateway, B, 'get_lead_assignment', { campaign_target_id: lead.campaign_target_id })).result.owner_agent_id, 'agt_beta')
  } finally { await env.db.drop() }
})

test('PG agent text: two concurrent texts to ONE seller ⇒ exactly one handed off (LEAD_SEND_IN_FLIGHT); the global day cap is BOUND by the worker\'s reservation', { skip }, async () => {
  const L2 = '+13125550172'
  const { env, cred, lead, gateway, w } = await world({ sw: switches({ ai_agent_text_policy: JSON.stringify({ max_per_day_global: 1 }) }) })
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const [x, y] = await Promise.all([
      text(gateway, cred, { client_request_id: 'at-conc-0001', campaign_target_id: lead.campaign_target_id }),
      text(makeGateway(env, { now: clockMs, worker: 'gw-2', legacyComposer: false }).gateway, cred, { client_request_id: 'at-conc-0002', campaign_target_id: lead.campaign_target_id }),
    ])
    assert.deepEqual([x.code, y.code].sort(), ['HANDOFF_QUEUED', 'LEAD_SEND_IN_FLIGHT'], JSON.stringify([x, y]))
    const lead2 = await seedLead(env, { phone: L2, pid: 'p201', prospect: 'pr4', first: 'Ana' })
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead2.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const b = await text(gateway, cred, { client_request_id: 'at-cap-0001', campaign_target_id: lead2.campaign_target_id })
    assert.equal(b.code, 'HANDOFF_QUEUED', 'both pass the gateway before any reservation exists')
    await w.tick()
    const codes = [(await receipt(env, (x.code === 'HANDOFF_QUEUED' ? x : y).intent_id)).code, (await receipt(env, b.intent_id)).code].sort()
    assert.deepEqual(codes, ['AGENT_TEXT_ENQUEUED', 'DAILY_GLOBAL_CAP_REACHED'])
    assert.equal((await agentRows(env)).length, 1)
    const scopes = await sel(env.owner, `select scope, count(*)::int n from public.idempotency_ledger where scope like 'agent_text_%' and status in ('processing', 'completed') group by scope order by scope`)
    assert.deepEqual(scopes.map((s) => [s.scope, s.n]), [['agent_text_global_day', 1], ['agent_text_initiated_day', 1], ['agent_text_lead_day', 1]])
  } finally { await env.db.drop() }
})

test('PG agent text: both emergency stops refuse at request time (EMERGENCY_STOP_ACTIVE) and, with the switch, cancel at dispatch; a revoked grant stops it at LeadCommand\'s worker; the database confines the standing flag', { skip }, async () => {
  const { env, cred, lead, gateway, w } = await world()
  try {
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    await env.owner.query('update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now() where id = 1')
    assert.equal((await text(gateway, cred, { client_request_id: 'at-stop-0001', campaign_target_id: lead.campaign_target_id })).error?.code, 'EMERGENCY_STOP_ACTIVE')
    await env.owner.query('update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null where id = 1')
    await setControls(env.owner, { queue_emergency_stop_at: new Date().toISOString() })
    assert.equal((await text(gateway, cred, { client_request_id: 'at-stop-0002', campaign_target_id: lead.campaign_target_id })).error?.code, 'EMERGENCY_STOP_ACTIVE')
    await setControls(env.owner, { queue_emergency_stop_at: null })
    const ok = await text(gateway, cred, { client_request_id: 'at-stop-0003', campaign_target_id: lead.campaign_target_id })
    assert.equal(ok.code, 'HANDOFF_QUEUED', JSON.stringify(ok))
    await w.tick()
    const [row] = await agentRows(env)
    assert.ok(row, JSON.stringify(await receipt(env, ok.intent_id)))
    await setControls(env.owner, { ai_agent_text_enabled: 'false' })
    const sim = simProvider()
    const d = await dispatchQueued(env, w, row.id, sim)
    assert.equal(sim.sent.length, 0)
    assert.equal(d.out?.reason, 'agent_text_unavailable_at_send:agent_text_kill_switch_off')
    assert.equal((await sel(env.owner, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
    // a grant revoked after the authorization
    await setControls(env.owner, switches())
    const L3 = await seedLead(env, { phone: '+13125550173', pid: 'p203', prospect: 'pr5', first: 'Lee' })
    assert.equal((await assign(gateway, cred, { campaign_target_id: L3.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await text(gateway, cred, { client_request_id: 'at-rev-0001', campaign_target_id: L3.campaign_target_id, body: 'Hi Lee, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Elm St?' })
    assert.equal(r.code, 'HANDOFF_QUEUED')
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await w.tick()
    assert.deepEqual([(await receipt(env, r.intent_id)).state, (await receipt(env, r.intent_id)).code], ['refused', 'NO_PER_USE_AUTHORITY'])
    await assert.rejects(mintStanding(env.owner, { capability: 'leads.assign_lead', tier: 2 }), /capability_grants_standing_seller_facing_chk/)
    await assert.rejects(mintStanding(env.owner, { basis: null }), /capability_grants_standing_seller_facing_chk/)
  } finally { await env.db.drop() }
})

test('PG agent text: the composer paths are RETIRED for agents — queue_agent_message and queue_authorized_reply answer AGENT_COMPOSES_TEXT at the gateway, and the database\'s handoff refuses them too', { skip }, async () => {
  const { env, cred, lead, gateway } = await world()
  try {
    const t = await seedThread(env.owner, { phone: SELLER, inboundBody: 'Yes I still own it. Is the roof a problem?' })
    const replier = await agent(env, { agent_id: 'agt_reply', grants: [], tier_ceiling: 3 })
    await mintStanding(env.owner, { agent_id: 'agt_reply', capability: 'conversation.queue_reply' })
    const am = await call(gateway, cred, 'queue_agent_message', { client_request_id: 'at-ret-0001', campaign_target_id: lead.campaign_target_id, purpose: 'first_touch', brief: 'absentee owner, likely open to sell' })
    assert.deepEqual([am.error?.code, am.error?.details?.use], ['AGENT_COMPOSES_TEXT', 'sms_send_agent_text'], JSON.stringify(am))
    const rp = await call(gateway, replier, 'queue_authorized_reply', { client_request_id: 'at-ret-0002', thread_id: t.thread_id })
    assert.equal(rp.error?.code, 'AGENT_COMPOSES_TEXT', JSON.stringify(rp))
    // an agent that sends its own texts may not have LeadCommand's writer draft one (it could send the draft as its own)
    const dr = await call(gateway, cred, 'draft_seller_reply', { client_request_id: 'at-ret-draft', thread_id: t.thread_id })
    assert.deepEqual([dr.error?.code, dr.error?.details?.use], ['AGENT_COMPOSES_TEXT', 'sms_send_agent_text'], JSON.stringify(dr))
    // the database refuses the handoff even for a gateway that would still run the retired path
    await setControls(env.owner, { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [SELLER] } }) })
    const { gateway: legacy } = makeGateway(env, { now: clockMs, legacyComposer: true })
    const db = await call(legacy, replier, 'queue_authorized_reply', { client_request_id: 'at-ret-0003', thread_id: t.thread_id })
    assert.deepEqual([db.state, db.code], ['refused', 'AGENT_COMPOSES_TEXT'], JSON.stringify(db))
    assert.equal((await sel(env.owner, `select action_gateway.t34_capability_refusal('queue_agent_message') c`))[0].c, 'AGENT_COMPOSES_TEXT')
  } finally { await env.db.drop() }
})

test('PG agent text: NO SECOND AI ENGINE — on a lead an agent holds, LeadCommand\'s turn decider makes no model decision and its queued AI reply is cancelled at dispatch; a lead nobody holds is unchanged', { skip }, async () => {
  const { env, cred, gateway, w } = await world()
  try {
    const t = await seedThread(env.owner, { phone: SELLER, inboundBody: 'Yes I still own it. Is the roof a problem?' })
    let modelCalls = 0
    const prov = fakeProvider(() => { modelCalls += 1; return {} })
    const decide = createCanonicalTurnDecider({ supabase: w.sb, env: { AI_CONVERSATION_SHADOW_ENABLED: 'true' }, provider: prov, tracker: createSpendTracker({ capUsd: 0.05 }), readSwitch: w.readSwitch, now: () => CLOCK })
    assert.equal((await assign(gateway, cred, { thread_id: t.thread_id })).code, 'LEAD_ASSIGNED')
    const d = await decide({ latest_inbound_id: t.inbound_id, inbound_ids: [t.inbound_id], thread_key: SELLER })
    assert.deepEqual([d.code, d.reply, modelCalls], [AGENT_HELD_STAND_DOWN, null, 0], JSON.stringify(d))
    // an AI reply LeadCommand queued on that thread (e.g. before the agent took it): cancelled, never sent
    const body = 'Good to know. Would you consider an offer on it?'
    const qk = `ai_conversation:${t.inbound_id}`
    const recId = (await env.owner.query(`insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version)
      values ($1, $2, $3, $4, $5, $6, encode(sha256(convert_to($6, 'UTF8')), 'hex'), 'd', 'AI_GENERATED_REPLY', 'm', 'p', 'p', 'c', '{"status":"validated"}', $7, '{"policy_hash":"x","scope_match":"thread_keys","category":"next_missing_fact"}', 'policy_authorized', now(), 'v') returning id`,
    [qk, `inbound_reply:${t.inbound_id}`, t.inbound_id, `tr:${crypto.createHash('sha256').update(SELLER).digest('hex')}`, `ph:${crypto.createHash('sha256').update(SELLER.slice(-10)).digest('hex')}`, body, 'c'.repeat(64)])).rows[0].id
    await setControls(env.owner, { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [SELLER] } }) })
    const rowId = (await env.owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, message_origin, source, inbound_message_id, created_at, metadata)
      values ($1, 'queued', $2, $3::text, $4::text, $3::text, 'ai_generated', 'ai_conversation', $5, now(), $6::jsonb) returning id`,
    [qk, body, SELLER, OURS, t.inbound_id, JSON.stringify({ source: 'ai_conversation', message_origin: 'ai_generated', ai_message_id: recId, ai_message_body_sha256: crypto.createHash('sha256').update(body).digest('hex'), inbound_message_event_id: t.inbound_id })])).rows[0].id
    const sim = simProvider()
    const out = await dispatchQueued(env, w, rowId, sim)
    assert.equal(sim.sent.length, 0)
    assert.equal(out.out?.reason, 'ai_reply_agent_holds_lead', JSON.stringify(out.out))
    // released: the engine decides again (the model is called)
    assert.equal((await call(gateway, cred, 'release_lead', { client_request_id: 'at-sd-rel-1', thread_id: t.thread_id })).code, 'LEAD_RELEASED')
    await decide({ latest_inbound_id: t.inbound_id, inbound_ids: [t.inbound_id], thread_key: SELLER }).catch(() => null)
    assert.ok(modelCalls > 0, 'a lead nobody holds is LeadCommand\'s again')
  } finally { await env.db.drop() }
})

test('PG agent text: the ledger keeps every reply invariant; the rollbacks refuse while a live grant / agent-text evidence exists, then restore the chain', { skip }, async () => {
  const { env, cred, lead, gateway, w } = await world()
  try {
    // an agent-text record (evidence): the ledger's rollback refuses under it
    assert.equal((await assign(gateway, cred, { campaign_target_id: lead.campaign_target_id })).code, 'LEAD_ASSIGNED')
    const r = await text(gateway, cred, { client_request_id: 'at-rb-00001', campaign_target_id: lead.campaign_target_id })
    assert.equal(r.code, 'HANDOFF_QUEUED')
    await w.tick()
    await assert.rejects(applyInTransaction(env.owner, AM_ROLLBACK), /live grant carries standing_seller_facing/)
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await assert.rejects(applyInTransaction(env.owner, AM_ROLLBACK), /agent-message receipts exist/)
    await assert.rejects(applyInTransaction(env.owner, LEDGER_ROLLBACK), /agent_outbound \/ agent_text records exist/)
  } finally { await env.db.drop() }
})

test('PG agent text: with no evidence the rollbacks restore the chain (#32 then the ledger kinds)', { skip }, async () => {
  const { env } = await world()
  try {
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await applyInTransaction(env.owner, AM_ROLLBACK)
    assert.equal((await sel(env.owner, `select count(*)::int n from pg_proc where proname in ('agent_text_refusal', 'lc_agent_text_reserve', 'action_gateway_agent_text_submit', 'lc_agent_lead_holder')`))[0].n, 0)
    assert.equal((await sel(env.owner, `select action_gateway.t34_handoff_kind('queue_agent_text') k`))[0].k, null)
    assert.equal((await sel(env.owner, `select (action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean ok`))[0].ok, true)
    await applyInTransaction(env.owner, LEDGER_ROLLBACK)
    assert.equal((await sel(env.owner, `select count(*)::int n from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname in ('record_kind', 'author_employee') and not attisdropped`))[0].n, 0)
  } finally { await env.db.drop() }
})

// ── the agents' lead pool and the send controls ──────────────────────────────
const PID = (n) => String(227876840 + n) // numeric property ids: the feed carries them encoded (pid_ + g..p)
const ref = (id) => `pid_${[...String(id)].map((d) => 'ghijklmnop'[Number(d)]).join('')}`

test('PG agent text: the lead pool — the agent-text path\'s OWN verdicts (codes queue_agent_text returns); ids and codes only; keyset pages', { skip }, async () => {
  const phones = { ok: '+13125550201', sup: '+13125550202', contacted: '+13125550203', renter: '+13125550204', held: '+13125550205' }
  const { env, cred, gateway } = await world()
  try {
    await env.owner.query(`delete from public.campaign_targets`)
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
    assert.equal(all.result.rows.length, 6)
    assert.deepEqual([by(L.ok.campaign_target_id).eligible, by(L.ok.campaign_target_id).next_purpose, by(L.ok.campaign_target_id).owner, by(L.ok.campaign_target_id).property_ref], [true, 'first_touch', 'self', ref(PID(0))])
    assert.match(by(L.sup.campaign_target_id).ineligible_reason, /CONTACT_NOT_ELIGIBLE/)
    assert.equal(by(L.contacted.campaign_target_id).ineligible_reason, 'ALREADY_CONTACTED')
    assert.equal(by(L.renter.campaign_target_id).ineligible_reason, 'PRESEND_INELIGIBLE')
    assert.equal(by(L.held.campaign_target_id).ineligible_reason, 'AUTOMATION_HOLD')
    const quiet = by(t.thread_id)
    assert.deepEqual([quiet.has_conversation, quiet.next_purpose, quiet.eligible], [true, 'reengage', true], JSON.stringify(quiet))
    assert.equal(all.result.agent_texts_available, true)
    for (const k of ['contacted', 'held', 'renter']) {
      assert.equal((await assign(gateway, cred, { campaign_target_id: L[k].campaign_target_id })).code, 'LEAD_ASSIGNED')
      assert.equal((await text(gateway, cred, { client_request_id: `at-pool-${k}`, campaign_target_id: L[k].campaign_target_id })).code, by(L[k].campaign_target_id).ineligible_reason, k)
    }
    const s = JSON.stringify(all.result)
    for (const p of [...Object.values(phones), LEAD_T]) assert.ok(!s.includes(p.slice(2)), p)
    const seen = []
    let cursor
    do {
      const page = await call(gateway, cred, 'agent_lead_pool', { market: 'Chicago, IL', limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.result.rows.map((r) => r.campaign_target_id || r.thread_id))
      cursor = page.result.next_cursor
    } while (cursor)
    assert.deepEqual(seen, all.result.rows.map((r) => r.campaign_target_id || r.thread_id))
  } finally { await env.db.drop() }
})

test('PG agent text: send controls — the R2 stop, the queue stop and the agent-text switch as an agent sees them (no identities)', { skip }, async () => {
  const { env, cred, lead, gateway } = await world()
  try {
    const c0 = await call(gateway, cred, 'send_controls', {})
    assert.deepEqual([c0.result.runtime_emergency_stop.on, c0.result.send_emergency_stop.on, c0.result.agent_text_enabled, c0.result.agent_text_refusal, c0.result.seller_sends], [false, false, true, null, 'enabled'], JSON.stringify(c0))
    const stop = (await env.owner.query(`select agent.runtime_emergency_stop($1, 'reviewing a misfire') r`, [OPERATOR])).rows[0].r
    assert.equal(stop.ok, true)
    const c1 = await call(gateway, cred, 'send_controls', {})
    assert.deepEqual([c1.result.runtime_emergency_stop.on, c1.result.agent_text_refusal, c1.result.seller_sends], [true, 'EMERGENCY_STOP_ACTIVE', 'stopped'])
    assert.ok(!JSON.stringify(c1).includes(OPERATOR) && !JSON.stringify(c1).includes('misfire'))
    assert.equal((await text(gateway, cred, { client_request_id: 'at-ctl-0001', campaign_target_id: lead.campaign_target_id })).error?.code, 'EMERGENCY_STOP_ACTIVE')
    await env.owner.query(`update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null where id = 1`)
    await setControls(env.owner, { ai_agent_text_enabled: null })
    assert.deepEqual([(await call(gateway, cred, 'send_controls', {})).result.agent_text_refusal, (await call(gateway, cred, 'send_controls', {})).result.seller_sends], ['AGENT_TEXT_KILL_SWITCH_OFF', 'disabled'])
  } finally { await env.db.drop() }
})

test('PG agent text: the event feed — idempotent ids, cursor order, settled rows only, never a phone', { skip }, async () => {
  const { env, cred, gateway } = await world()
  try {
    const app = (k, k2) => env.owner.query(`select public.lc_lead_event_append($1, $2, $3, null, $4::jsonb, now()) r`, [k, k2, LEAD_A, JSON.stringify({ message_id: k2 })])
    assert.equal((await app('inbound_message', 'm-1')).rows[0].r.appended, true)
    assert.equal((await app('inbound_message', 'm-1')).rows[0].r.appended, false, 'a webhook retry appends nothing')
    await app('opt_out', 'm-2')
    assert.equal((await call(gateway, cred, 'events_since', { cursor: 0 })).result.events.length, 0, 'unsettled rows are not served yet')
    await settle()
    const ev = await call(gateway, cred, 'events_since', { cursor: 0, limit: 1 })
    assert.deepEqual(ev.result.events.map((e) => e.kind), ['inbound_message'])
    const next = await call(gateway, cred, 'events_since', { cursor: ev.result.next_cursor })
    assert.deepEqual(next.result.events.map((e) => e.kind), ['opt_out'])
    assert.ok(!JSON.stringify([ev, next]).includes('3125550171'))
    await assert.rejects(env.owner.query(`update action_gateway.lead_events set kind = 'opt_out'`), /append-only/)
  } finally { await env.db.drop() }
})
