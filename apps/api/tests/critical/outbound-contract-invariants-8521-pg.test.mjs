// rc-8.5.21 FINAL directive, phase 4 — THE OUTBOUND CONTRACT, every invariant in ONE PG suite, on a
// DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Each test
// drives the REAL production path (writer, materializer, send-time guard, AI turn, runner item path, §11
// seam) over a database that carries the hold registry, the follow-up lifecycle, the AI turn runtime and the
// §11 ledger (competing-sources-pg.mjs). The provider is SIMULATED; fetch and TextGrid credentials trapped.
//   I1  one action per inbound turn            I7  no STOP bypass
//   I2  no duplicate provider call after an     I8  no empty body
//       ambiguous accept                         I9  no untraceable budget block
//   I3  no sender substitution                  I10 no acceptance outside authority
//   I4  no cross-property denial leakage        I11 no identity claims (validator)
//   I5  no nurture after an ownership denial    I12 (P0) no selling nurture when the latest reply answers
//   I6  no send on a held thread                    an ownership question (plan AND materialization)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { combinedDb, registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { seed, harness, SELLER as AI_SELLER, ENV, provider as fakeModelProvider } from '../helpers/conversation-e2e-pg.mjs'
import { seedWorld, seedThread, planNurture, materialize, claimRow, dispatchRow, itemDeps, simProvider, trapTransport, intentsOf, rowsOf, sel, lawfulNowIso, claimableEmptyBodies, OURS, FALLBACK_SENDER } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { normalizeSendQueueRow, validateSendQueueRowPreclaim } from '../../src/lib/supabase/sms-engine.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { planFollowUpIntent } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { evaluateAutonomousAcceptance, routeAcceptanceToHumanReview, __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { validateOutbound } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { NO_COMPANY_IDENTITY } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler } from '../../src/lib/ai/conversation-turn-handler.js'
import { runtimeJobTracker } from '../../src/lib/ai/conversation-decide-handler.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(null)
const skip = pgAvailable() ? false : skipReason

async function world({ ai = false } = {}) {
  const env = await combinedDb()
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  if (ai) await seed(env.pool) // the AI conversation (its property / prospect rows first)
  await seedWorld(env.pool)
  return env
}
const fuRow = async (env, phone, opts = {}) => {
  const { inboundId } = await seedThread(env.pool, { phone, ...(opts.thread || {}) })
  const planned = await planNurture(env.sb, phone, { inboundId, ...(opts.plan || {}) })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const m = await materialize(env)
  assert.equal(m.counts.materialized, 1, JSON.stringify(m))
  return (await rowsOf(env.pool, phone))[0]
}
const at = (row) => lawfulNowIso(Date.parse(row.scheduled_for))
const store = (env) => createSellerCommunicationStore({ supabase: env.sb })

test('I1 one action per inbound turn: the same inbound routed 3× and two racing workers ⇒ ONE turn, ONE queued AI reply', { skip }, async () => {
  const env = await world({ ai: true })
  const net = trapTransport()
  try {
    const h = harness(env)
    const codes = []
    for (let i = 0; i < 3; i += 1) codes.push((await h.route()).code)
    assert.equal(codes.filter((c) => c === 'TURN_OPENED').length, 1, JSON.stringify(codes))
    await h.makeDue()
    await Promise.all([h.tick('w1'), h.tick('w2')])
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.conversation_reply_turns'))[0].n, 1)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I2 no duplicate provider call after an AMBIGUOUS accept: a provider timeout leaves the attempt ambiguous; every re-claim / re-dispatch is refused before the wire', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const row = await fuRow(env, '+13125550901')
    const provider = simProvider(['timeout'])
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: store(env) })
    assert.equal(provider.sent.length, 1, 'one provider call')
    const comm = (await sel(env.pool, `select c.delivery_possibility from public.seller_logical_communications c join public.seller_communication_attempts a on a.logical_communication_id = c.id where a.queue_row_id = $1`, [String(row.id)]))[0]
    assert.notEqual(comm?.delivery_possibility, 'definitely_not_sent', JSON.stringify(comm))
    // an operator / sweeper puts the row back in the queue: the seam still refuses a second attempt
    for (let i = 0; i < 2; i += 1) {
      await env.pool.query(`update public.send_queue set queue_status = 'queued', is_locked = false, lock_token = null where id = $1`, [row.id])
      const c = await claimRow(env.pool, row.id)
      if (c) await dispatchRow(env, c, { provider, now: at(row), store: store(env) })
    }
    assert.equal(provider.sent.length, 1, 'never a second provider call after an ambiguous accept')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I3 no sender substitution: the thread sender cooling ⇒ a visible hold (never the healthy fallback); a forged from ⇒ refused', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const row = await fuRow(env, '+13125550902')
    await env.pool.query(`update public.textgrid_numbers set status = 'cooling', health_state = 'cooling' where phone_number = $1`, [OURS])
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: store(env) })
    const after = (await rowsOf(env.pool, '+13125550902'))[0]
    assert.deepEqual([after.queue_status, after.guard_reason, after.from_phone_number], ['blocked_sender_ineligible', 'sender_unavailable', OURS])
    await env.pool.query(`update public.textgrid_numbers set status = 'active', health_state = 'healthy' where phone_number = $1`, [OURS])
    const row2 = await fuRow(env, '+13125550903')
    await env.pool.query(`update public.send_queue set from_phone_number = $2 where id = $1`, [row2.id, FALLBACK_SENDER])
    await dispatchRow(env, await claimRow(env.pool, row2.id), { provider, now: at(row2), store: store(env) })
    assert.equal((await rowsOf(env.pool, '+13125550903'))[0].guard_reason, 'sender_continuity_mismatch')
    assert.equal(provider.sent.length, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I4 no cross-property denial leakage: a denial of 12 Oak St blocks THAT property only; the same seller\'s follow-up on another property still sends', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550904'
    await env.pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name) values ('p9', 'SFR', 'Chicago', 'IL', '60601', '9 Birch Ave', 'Dana Q') on conflict do nothing`)
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, rejection_reason, suppression_scope) values ('p1', $1, 'property_specific_non_owner', now(), 'seller_denied_ownership', 'contact_property_pair')`, [phone])
    const { inboundId } = await seedThread(env.pool, { phone, property: 'p9' })
    // p1: refused (the denial); p9: plans, materializes and sends
    await planNurture(env.sb, phone, { inboundId, property: 'p1' })
    await planNurture(env.sb, phone, { inboundId, property: 'p9', dueAt: new Date(Date.now() - 30_000).toISOString() })
    await materialize(env)
    const intents = await intentsOf(env.pool, phone)
    const p1 = intents.find((i) => i.property_id === 'p1')
    const p9 = intents.find((i) => i.property_id === 'p9')
    assert.equal(p1.state, 'not_executable', JSON.stringify({ s: p1.state, r: p1.reason }))
    assert.match(p1.reason, /property_denial/)
    assert.equal(p9.state, 'ready', JSON.stringify({ s: p9.state, r: p9.reason }))
    const [row] = (await rowsOf(env.pool, phone)).filter((r) => r.property_id === 'p9')
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: store(env) })
    assert.equal(provider.accepted(), 1, 'the other property is not suppressed by the denial')
    assert.equal((await sel(env.pool, `select count(*)::int n from public.sms_suppression_list where phone_e164 = $1`, [phone]))[0].n, 0, 'a property denial is never a contact-wide suppression')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I5 no nurture after an ownership denial: a bare "No" to the ownership question ⇒ the nurture is refused at plan time (not_executable), never materialized', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550905'
    await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, last_inbound_at, our_number) values ($1::text, $1::text, 'p1', 'm1', 'pr1', 'ownership_check', 'ownership_check', now(), $2)`, [phone, OURS])
    const inboundId = crypto.randomUUID()
    await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
      values ($1, 'SMo-i5', 'outbound', $3::text, $4::text, $3::text, 'Hi Dana, this is Helen. Do you still own 12 Oak St?', now() - interval '1 hour', now() - interval '1 hour', 'p1', 'en'),
             ($2, 'SMi-i5', 'inbound', $3::text, $3::text, $4::text, 'No', now() - interval '5 minutes', now() - interval '5 minutes', 'p1', 'en')`, [crypto.randomUUID(), inboundId, phone, OURS])
    await planNurture(env.sb, phone, { inboundId, property: 'p1', intent: 'not_interested', extra: { language: 'English' } })
    const [i] = await intentsOf(env.pool, phone)
    assert.deepEqual([i.state, i.reason], ['not_executable', 'property_denial:bare_no_to_ownership_question'])
    await materialize(env)
    assert.equal((await rowsOf(env.pool, phone)).length, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I6 no send on a held thread: an operator hold ⇒ a due follow-up is HELD at materialization (no row); an already-materialized row can never be claimed (the queue trigger refuses), nor can an automated row be inserted', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550906'
    const row = await fuRow(env, phone)
    const phone2 = '+13125550916'
    const { inboundId } = await seedThread(env.pool, { phone: phone2 })
    await planNurture(env.sb, phone2, { inboundId })
    for (const p of [phone, phone2]) await env.pool.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ($2, 'operator_hold', $1, 'operator review', 'op', 'I6')`, [p, `i6:${p}`])
    await materialize(env)
    assert.equal((await intentsOf(env.pool, phone2))[0].state, 'held', 'held at materialization')
    assert.equal((await rowsOf(env.pool, phone2)).length, 0)
    await assert.rejects(claimRow(env.pool, row.id), /AUTOMATION_HOLD/, 'the held thread\'s row cannot be claimed')
    await assert.rejects(env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata) values ('i6-auto', 'queued', 'Hi there', $1::text, $1::text, 'auto_reply', '{}'::jsonb)`, [phone]), /AUTOMATION_HOLD/)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I7 no STOP bypass: STOP on the contact ⇒ the follow-up, a template auto-reply row and an operator send are all refused before the provider', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550907'
    const row = await fuRow(env, phone)
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type, reason) values ($1, $1, true, 'opt_out', 'STOP')`, [phone])
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: store(env) })
    for (const [k, extra] of [['auto', { type: 'auto_reply', source: 'auto_reply', queue_key: `inbound_auto_reply:x:t:${phone}` }], ['manual', { type: 'outbound', source: 'inbox', message_type: 'manual_reply', metadata: { source: 'manual_inbox', manual_operator_send: true } }]]) {
      const r = (await sel(env.pool, `insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, type, source, message_type, property_id, created_at, metadata)
        values ($1, 'queued', 'Hi Dana, just checking in about 12 Oak St.', $2::text, $3::text, $2::text, $4, $5, $6, 'p1', now(), $7::jsonb) returning *`,
      [extra.queue_key || `i7-${k}`, phone, OURS, extra.type, extra.source, extra.message_type || null, JSON.stringify(extra.metadata || {})]))[0]
      const c = await claimRow(env.pool, r.id)
      await processSendQueueItem(normalizeSendQueueRow({ ...c.row }), { ...itemDeps(env, { provider, now: at(row), store: store(env) }), claimedLockToken: c.token })
    }
    assert.equal(provider.sent.length, 0, 'STOP is absolute: no follow-up, no auto-reply, no operator send')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I8 no empty body: an empty-body row (any writer) is never claimable by the loader and never reaches the provider; materialization never leaves a claimable empty body', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550908'
    await fuRow(env, phone)
    assert.deepEqual(await claimableEmptyBodies(env.pool), [])
    const r = (await sel(env.pool, `insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, type, property_id, created_at, scheduled_for, metadata) values ('i8', 'queued', '', $1::text, $2::text, $1::text, 'outbound', 'p1', now(), now(), '{}'::jsonb) returning *`, [phone, OURS]))[0]
    assert.equal(validateSendQueueRowPreclaim(r, new Date().toISOString()).reason, 'missing_message_body', 'the loader refuses it before any claim')
    const provider = simProvider()
    const c = await claimRow(env.pool, r.id)
    await processSendQueueItem(normalizeSendQueueRow({ ...c.row }), { ...itemDeps(env, { provider, store: store(env) }), claimedLockToken: c.token })
    assert.equal(provider.sent.length, 0, 'an empty body never reaches the provider, even past the loader')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I9 no untraceable budget block: the AI spend guard refuses the turn ⇒ the job parks budget_blocked with a reason AND one operator work item names budget_exhausted; zero sends', { skip }, async () => {
  const env = await world({ ai: true })
  const net = trapTransport()
  try {
    const h = harness(env)
    const items = []
    const model = fakeModelProvider()
    const handler = createConversationTurnHandler({
      env: ENV, store: h.turnStore, supabase: env.sb, runtimeStore: h.store, trackerFor: runtimeJobTracker, provider: model,
      dispatch: async () => { throw new Error('DISPATCH_MUST_NOT_RUN') },
      operatorItems: { syncWorkItems: async (a) => { items.push(...(a.items || [])); return { ok: true } } },
    })
    const tick = () => runRuntimeTick({ store: h.store, handlers: { [CONVERSATION_TURN_KIND]: handler }, workerId: 'i9', budgetMs: 20_000 })
    assert.equal((await h.route()).code, 'TURN_OPENED')
    await h.makeDue()
    assert.equal((await tick()).jobs?.[0]?.outcome, 'budget_blocked')
    const parked = await sel(env.pool, `select last_error from agent.research_job where kind = $1 and state = 'budget_blocked'`, [CONVERSATION_TURN_KIND])
    assert.ok(parked.length === 1 && parked[0].last_error?.code, 'the parked job carries its reason')
    await tick() // the budget-notice job raises the operator item under its own lease
    assert.equal(items.length, 1, JSON.stringify(items))
    assert.match(JSON.stringify(items[0]), /budget_exhausted/)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0)
    void AI_SELLER
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('I10 no acceptance outside authority: a price above the MAO / authorized ceiling, an unverified offer origin or a hold ⇒ never accepted; routed to human review with the evidence recorded', { skip }, async () => {
  const env = await world()
  try {
    const opp = (await sel(env.pool, `insert into public.acquisition_opportunities (dedupe_key, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status) values ('i10', 'p1', '+13125550910', 'offer', 'active') returning id`))[0].id
    await env.pool.query(`insert into public.seller_offers (offer_id, opportunity_id, thread_key, property_id, purchase_price, status, ade_snapshot_id, authorized_ceiling, valuation_mid) values ('off-i10', $1, '+13125550910', 'p1', 150000, 'active', 'ade-1', 120000, 160000)`, [opp])
    await env.pool.query(`insert into public.property_acquisition_scores (property_id, valuation_mid, investor_ceiling_mid, investor_ceiling_high, recommended_cash_offer, minimum_acceptable_offer, computed_at) values ('p1', 160000, 115000, 120000, 110000, 100000, now())`)
    const v = await evaluateAutonomousAcceptance({ opportunity_id: opp, thread_key: '+13125550910', property_id: 'p1', accepted_price: 150000, supabase: env.sb })
    assert.equal(v.allowed, false, JSON.stringify(v.reasons))
    assert.ok(v.reasons.some((r) => /above|ceiling|mao/i.test(r)), JSON.stringify(v.reasons))
    const routed = await routeAcceptanceToHumanReview({ verdict: v, opportunity_id: opp, thread_key: '+13125550910', property_id: 'p1', source: 'i10', supabase: env.sb })
    assert.equal(routed.event_recorded, true)
    assert.equal((await sel(env.pool, `select next_action from public.acquisition_opportunities where id = $1`, [opp]))[0].next_action, 'human_review')
    assert.equal((await sel(env.pool, `select count(*)::int n from public.seller_offers where accepted_at is not null`))[0].n, 0, 'nothing was accepted')
    // under a hold the acceptance is refused for the hold itself
    await env.pool.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('i10', 'operator_hold', '+13125550910', 'review', 'op', 'I10')`)
    const held = await evaluateAutonomousAcceptance({ opportunity_id: opp, thread_key: '+13125550910', property_id: 'p1', accepted_price: 90000, supabase: env.sb })
    assert.equal(held.allowed, false)
    assert.ok(held.reasons.some((r) => /hold/i.test(r)), JSON.stringify(held.reasons))
  } finally { await env.db.drop() }
})

test('I11 no identity claims: the shared outbound validator refuses an unasked company / realtor / automation / colleague claim', () => {
  const ledger = { last_message: { id: 'i1', direction: 'inbound' }, requests: [], facts: {} }
  for (const draft of ['Hi Dana, I am with Prime Realty, a local brokerage. Would you sell?', 'Hi Dana, this is an automated message. Would you sell?', 'Hi Dana, my colleague Alex reached out earlier. Would you sell?']) {
    const v = validateOutbound(draft, { ledger, companyIdentity: NO_COMPANY_IDENTITY, establishedPersona: 'Helen' })
    assert.ok(v.content_reasons.some((r) => r.startsWith('identity:')), `${draft} ⇒ ${JSON.stringify(v.content_reasons)}`)
  }
})

test('I12 (P0) no selling nurture when the latest reply answers an ownership question — single bare "No", "No thanks", two SEPARATE questions — refused at PLAN and, forced past the planner, at MATERIALIZATION; a reply to the SELLING question keeps its 30-day nurture', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const cases = [
      { phone: '+13125550921', outs: ['Hi Dana, this is Helen. Do you still own 12 Oak St?'], reply: 'No', want: /property_denial|not_owner/ },
      { phone: '+13125550922', outs: ['Hi Dana, this is Helen. Do you still own 12 Oak St?'], reply: 'No thanks', want: /declined_unverified/ },
      { phone: '+13125550923', outs: ['Hi Dana, this is Helen. Do you still own 12 Oak St?', 'And how about 456 Pine St?'], reply: 'No', want: /ownership_denial_property_unresolved/ },
      { phone: '+13125550924', outs: ['Hi Dana, this is Helen. Do you still own 12 Oak St?'], reply: 'Yes I do', want: /selling_nurture_requires_selling_intent_answer/ },
      { phone: '+13125550925', outs: ['Thanks Dana. Would you consider selling 12 Oak St?'], reply: 'Not interested', want: null },
    ]
    for (const c of cases) {
      await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, last_inbound_at, our_number) values ($1::text, $1::text, 'p1', 'm1', 'pr1', 'ownership_check', 'ownership_check', now(), $2)`, [c.phone, OURS])
      for (const [i, body] of c.outs.entries()) {
        await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language) values ($1, $2, 'outbound', $3::text, $4::text, $3::text, $5::text, now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), $7, 'en')`,
          [crypto.randomUUID(), `SMo-${c.phone}-${i}`, c.phone, OURS, body, 60 - i * 3, i === 0 ? 'p1' : 'p2'])
      }
      // the seller-seen outbound row (the persona + name source the renderer reads)
      await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name, property_id, property_address, created_at, sent_at, delivered_at, type, metadata)
        values ($1, 'delivered', $2::text, $3::text, $4::text, $3::text, 'ownership_check', 'Helen', 'Dana', 'p1', '12 Oak St', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', 'outbound', '{}'::jsonb)`, [`seed:${c.phone}`, c.outs[0], c.phone, OURS])
      const inboundId = crypto.randomUUID()
      await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language) values ($1, $2, 'inbound', $3::text, $3::text, $4::text, $5::text, now() - interval '5 minutes', now() - interval '5 minutes', 'p1', 'en')`, [inboundId, `SMi-${c.phone}`, c.phone, OURS, c.reply])
      const planned = await planNurture(env.sb, c.phone, { inboundId, property: 'p1', intent: 'not_interested', dueAt: new Date(Date.now() - 60_000).toISOString(), extra: { language: 'English' } })
      const [i] = await intentsOf(env.pool, c.phone)
      if (c.want) {
        assert.notEqual(planned.followup_created, true, `${c.reply}: never planned executable`)
        assert.ok(['held', 'not_executable'].includes(i.state), `${c.phone} ${c.reply}: ${i.state} ${i.reason}`)
        assert.match(i.reason, c.want)
        // a writer that bypasses the planner guard: the materializer refuses the same intent
        const forced = await planFollowUpIntent({ thread_key: c.phone, property_id: 'p1', master_owner_id: 'm1', kind: 'not_interested_nurture', intent: 'not_interested', due_at: new Date(Date.now() - 30_000).toISOString(), writer: 'test_forced', cause: `forced:${c.phone}`, row_spec: { ...i.row_spec } }, { supabase: env.sb })
        assert.equal(forced.ok, true, JSON.stringify(forced))
        await materialize(env)
        const f = (await intentsOf(env.pool, c.phone)).find((x) => x.writer === 'test_forced')
        assert.ok(['held', 'not_executable'].includes(f.state), `materializer: ${f.state} ${f.reason}`)
        assert.match(f.reason, c.want)
        assert.equal((await rowsOf(env.pool, c.phone)).filter((r) => !String(r.queue_key).startsWith('seed:')).length, 0, `${c.reply}: no row`)
      } else {
        assert.equal(i.state, 'planned', `the selling answer keeps its nurture: ${i.state} ${i.reason}`)
        const m = await materialize(env)
        const [after] = await intentsOf(env.pool, c.phone)
        assert.equal((await rowsOf(env.pool, c.phone)).length, 1, `the 30-day nurture materializes: ${after.state} ${after.reason} ${JSON.stringify(m.results)}`)
      }
    }
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
