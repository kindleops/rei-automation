// rc-8.5.21 blind-eval F1 — delivery-confirmed SILENCE follow-ups (S2 interest, S3 asking price, offer;
// all 24 h) must be SENDABLE. On a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported,
// never vacuous — without it):
//   delivered anchor (send_queue + message_events) → the REAL delivery trigger
//   (maybeScheduleNoResponseFollowUp, which builds its context with buildNoResponseScheduleContext and
//   writes through scheduleFollowUp in lifecycle mode) → ONE planned intent → materialization (the
//   thread's ESTABLISHED sender resolved through the persona + sender continuity resolver) → ONE
//   nonempty row whose from_phone_number IS the thread's sender → the loader's preclaim validity
//   check → claim → the REAL queue runner item path (processSendQueueItem) with a SIMULATED provider ⇒
//   exactly ONE send. And: nothing establishes a sender ⇒ the intent is HELD with a durable reason
//   (visible), never a sender-less row the loader pauses; a spec sender that disagrees with the
//   thread's sender is held, never switched.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, materialize, trapTransport, simProvider, claimRow, dispatchRow, itemDeps, materializerDeps, intentsOf, rowsOf, eventsOf, sel, OURS, lawfulNowIso, applyS11Ledger, applyQueueExecutionLock } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { maybeScheduleNoResponseFollowUp } from '../../src/lib/domain/seller-flow/delivery-triggered-followup.js'
import { validateSendQueueRowPreclaim } from '../../src/lib/supabase/sms-engine.js'
import { resolveFollowUpSender, runFollowUpMaterialization } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { runSendQueue } from '../../src/lib/domain/queue/run-send-queue.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(null)
const skip = pgAvailable() ? false : skipReason

const KINDS = {
  s2_interest: {
    stage: 'offer_interest', use_case: 'consider_selling', fu: 's2_no_response_fu1',
    anchor: 'Thanks Rosa. Would you consider an offer on 12 Oak St?',
    template: 'Hi {{seller_first_name}}, just following up. Would you be open to an offer on {{property_address}}?',
    expect: /^Hi Rosa, just following up\. Would you be open to an offer on 12 Oak St\?$/,
  },
  s3_asking_price: {
    stage: 'asking_price', use_case: 'seller_asking_price', fu: 's3_no_response_fu1',
    anchor: 'Thanks Rosa. Do you have an asking price in mind for 12 Oak St?',
    template: 'Hi {{seller_first_name}}, just following up. Did you have a price in mind for {{property_address}}?',
    expect: /^Hi Rosa, just following up\. Did you have a price in mind for 12 Oak St\?$/,
  },
  offer: {
    stage: 'offer', use_case: 'manual_reply', fu: 'offer_no_response_fu1',
    anchor: 'Thanks Rosa. Based on the condition we could offer $104,500 cash for 12 Oak St.',
    template: 'Hi {{seller_first_name}}, just following up. Would {{offer_price}} work for you, or is there a number you had in mind?',
    expect: /^Hi Rosa, just following up\. Would \$104,500 work for you, or is there a number you had in mind\?$/,
  },
}

async function world(env) {
  // the REAL §11 ledger: the follow-up's identity must be accepted by the production schema (follow_up_id uuid)
  await applyS11Ledger(env.pool)
  await seedWorld(env.pool)
  const enabledAt = new Date(Date.now() - 7 * 864e5).toISOString()
  for (const [k, v] of Object.entries({ followup_no_response_mode: 'live', followup_no_response_enabled_at: enabledAt })) {
    await env.pool.query('insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v])
  }
  for (const [kind, k] of Object.entries(KINDS)) {
    await env.pool.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body) values ($1, $2, 'English', true, true, $3)`, [`t-${kind}-fu1`, k.fu, k.template])
  }
}

/**
 * A delivered silence anchor: the seller answered once (before the anchor), then we asked / offered and
 * the provider confirmed delivery 25 h ago; nothing since. `ourNumber` is the thread's sticky sender.
 */
async function seedSilence(env, { phone, kind, ourNumber = OURS, anchorFrom = ourNumber, stickyNumber = ourNumber }) {
  const k = KINDS[kind]
  const anchorEventId = crypto.randomUUID()
  const sentAt = new Date(Date.now() - 25 * 3_600_000).toISOString()
  const inboundAt = new Date(Date.parse(sentAt) - 3_600_000).toISOString()
  await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, last_inbound_at, our_number)
                        values ($1::text, $1::text, 'p1', 'm1', 'pr1', $2, $2, $3, $4)`, [phone, k.stage, inboundAt, stickyNumber])
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                        values ($1, $2, 'inbound', $3::text, $3::text, $4::text, 'Yes I still own it, it is a rental right now', $5, $5, 'p1', 'en'),
                               ($6, $7, 'outbound', $3::text, $8::text, $3::text, $9::text, $10, $10, 'p1', 'en')`,
  [crypto.randomUUID(), `SMi${anchorEventId.slice(0, 8)}`, phone, ourNumber, inboundAt, anchorEventId, `SMo${anchorEventId.slice(0, 8)}`, anchorFrom, k.anchor, sentAt])
  const anchorRow = (await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name,
                        property_id, master_owner_id, property_address, created_at, sent_at, delivered_at, type, language, metadata)
                      values ($1, 'delivered', $2, $3::text, $4::text, $3::text, $5, 'Helen', 'Rosa', 'p1', 'm1', '12 Oak St', $6, $6, $6, 'outbound', 'English', '{}'::jsonb) returning id`,
  [`anchor:${anchorEventId}`, k.anchor, phone, anchorFrom, k.use_case, sentAt])).rows[0]
  return { anchorEventId, anchorRowId: anchorRow.id, sentAt }
}

/** The REAL delivery trigger for the anchor (the leg the delivered callback runs). */
async function deliveryTrigger(env, { phone, anchorEventId, anchorRowId, sentAt }) {
  return maybeScheduleNoResponseFollowUp({
    supabase: env.sb,
    outbound: { id: anchorEventId, queue_id: anchorRowId, thread_key: phone },
    sid: `SMo${anchorEventId.slice(0, 8)}`,
    mode: 'full_live',
    sent_at: sentAt,
    getSystemValueImpl: async (key) => (await sel(env.pool, 'select value from public.system_control where key = $1', [key]))[0]?.value ?? null,
    isInternalTestPhoneImpl: () => false,
  })
}

for (const kind of Object.keys(KINDS)) {
  test(`PG F1 (${kind}): delivered anchor → planned intent → materialized WITH the thread's sender → loader preclaim passes → the real runner sends EXACTLY ONCE (simulated provider)`, { skip }, async () => {
    const env = await lifecycleDb()
    const net = trapTransport()
    try {
      await world(env)
      const phone = { s2_interest: '+13125550601', s3_asking_price: '+13125550602', offer: '+13125550603' }[kind]
      const anchor = await seedSilence(env, { phone, kind })
      const trig = await deliveryTrigger(env, { phone, ...anchor })
      assert.equal(trig.handled, true, JSON.stringify(trig))
      assert.equal(trig.result.no_response_kind, kind, JSON.stringify(trig))
      let [intent] = await intentsOf(env.pool, phone)
      assert.equal(intent?.state, 'planned', JSON.stringify({ trig, intent }))
      assert.equal(intent.row_spec.from_phone_number ?? null, null, 'the delivery trigger knows no sender (the F1 shape): materialization must resolve it')
      assert.equal((await rowsOf(env.pool, phone)).length, 0)

      const m = await materialize(env)
      assert.equal(m.counts.materialized, 1, JSON.stringify(m))
      ;[intent] = await intentsOf(env.pool, phone)
      assert.equal(intent.state, 'ready', JSON.stringify(intent))
      const [row] = await rowsOf(env.pool, phone)
      assert.equal(row.from_phone_number, OURS, 'the thread\'s established (sticky) sender, never a new number')
      assert.equal(row.metadata.followup_sender_source, 'thread_sticky')
      assert.equal(row.agent_name, 'Helen', 'the thread persona is kept')
      assert.match(row.message_body, KINDS[kind].expect)
      assert.ok(!/[—–]/.test(row.message_body))

      // the loader's preclaim validity check (where the eval saw paused_invalid_queue_row / missing_from_phone_number)
      const pre = validateSendQueueRowPreclaim(row, lawfulNowIso(Date.parse(row.scheduled_for)))
      assert.notEqual(pre.reason, 'missing_from_phone_number')
      assert.equal(pre.ok, true, JSON.stringify(pre.reason))

      const provider = simProvider()
      const out = await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: lawfulNowIso(Date.parse(row.scheduled_for)), store: createSellerCommunicationStore({ supabase: env.sb }) })
      assert.equal(provider.accepted(), 1, `exactly one simulated provider send (${JSON.stringify(out).slice(0, 400)})`)
      const wire = JSON.stringify(provider.sent[0])
      assert.ok(wire.includes(OURS.slice(-10)) && wire.includes(phone.slice(-10)), 'from the thread sender, to the seller')
      ;[intent] = await intentsOf(env.pool, phone)
      assert.equal(intent.state, 'provider_accepted', JSON.stringify(intent))
      const comm = await sel(env.pool, `select c.follow_up_id, a.provider_message_id from public.seller_logical_communications c join public.seller_communication_attempts a on a.logical_communication_id = c.id where a.queue_row_id = $1`, [String(row.id)])
      assert.deepEqual(comm.map((c) => [c.follow_up_id, Boolean(c.provider_message_id)]), [[intent.id, true]], 'ONE §11 attempt, anchored on the intent UUID')
      // a replayed runner pass / re-claim never sends again
      assert.equal(await claimRow(env.pool, row.id), null, 'the sent row is not claimable again')
      assert.equal(provider.sent.length, 1)
      assert.deepEqual(net.hits, [])
      assert.deepEqual(net.credReads, [])
    } finally { net.restore(); await env.db.drop() }
  })
}

test('PG F1 (WHOLE RUNNER): delivered offer anchor → the REAL delivery trigger → runSendQueue (materialization → loader → preclaim → REAL global lock + atomic claim + dispatch authorization → item path) with a simulated provider; TextGrid / any network throws ⇒ ONE send from the thread\'s sender; a second runner pass sends nothing', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await world(env)
    await applyQueueExecutionLock(env.pool)
    const phone = '+13125550621'
    const anchor = await seedSilence(env, { phone, kind: 'offer' })
    const trig = await deliveryTrigger(env, { phone, ...anchor })
    assert.equal(trig.handled, true, JSON.stringify(trig))
    let [intent] = await intentsOf(env.pool, phone)
    assert.equal(intent?.state, 'planned')
    assert.equal(intent.row_spec.from_phone_number ?? null, null, 'the F1 shape: the trigger knows no sender')
    const provider = simProvider()
    const store = createSellerCommunicationStore({ supabase: env.sb })
    const passes = []
    const runnerDeps = (now) => ({
      ...itemDeps(env, { provider, now, store }),
      // the REAL dispatch authorization over the REAL atomic claim (no lifecycle stand-in on this path)
      verifyDispatchAuthorization: undefined,
      supabaseClient: env.sb,
      getSystemFlag: async () => true,
      getSystemValue: async (k) => (await sel(env.pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? ({ queue_execution_mode: 'normal', queue_processor_mode: 'live' })[k] ?? null,
      // the runner's OWN materialization step, over the same disposable-DB lifecycle deps the suite uses
      runFollowUpMaterialization: async () => { const r = await runFollowUpMaterialization(await materializerDeps(env)); passes.push(r); return r },
      info: () => {}, warn: () => {}, error: () => {},
    })
    // pass 1: the runner materializes the intent (sender resolved from the thread) and, at a lawful
    // instant for the recipient, dispatches it
    const first = await runSendQueue({ limit: 10, now: lawfulNowIso() }, runnerDeps(lawfulNowIso()))
    assert.equal(passes[0]?.counts?.materialized, 1, JSON.stringify(passes[0]))
    let [row] = await rowsOf(env.pool, phone)
    assert.equal(row.from_phone_number, OURS, 'materialized WITH the thread\'s established sender')
    if (provider.sent.length === 0) {
      // the row was planned for the next lawful window: the runner at that instant sends it
      const at = lawfulNowIso(Date.parse(row.scheduled_for))
      await runSendQueue({ limit: 10, now: at }, runnerDeps(at))
    }
    assert.equal(provider.accepted(), 1, `exactly one simulated provider send (${JSON.stringify(first).slice(0, 600)})`)
    const wire = JSON.stringify(provider.sent[0])
    assert.ok(wire.includes(OURS.slice(-10)) && wire.includes(phone.slice(-10)), 'from the thread sender, to the seller')
    assert.match(wire, /Would \$104,500 work for you/)
    ;[row] = await rowsOf(env.pool, phone)
    assert.ok(['sent', 'delivered'].includes(row.queue_status), row.queue_status)
    assert.notEqual(row.failed_reason, 'missing_from_phone_number')
    ;[intent] = await intentsOf(env.pool, phone)
    assert.equal(intent.state, 'provider_accepted', JSON.stringify(intent))
    // replay: another full runner pass sends nothing
    await runSendQueue({ limit: 10, now: lawfulNowIso() }, runnerDeps(lawfulNowIso()))
    assert.equal(provider.sent.length, 1)
    assert.deepEqual(net.hits, [], 'no network / TextGrid call: the trapped fetch throws on any')
    assert.deepEqual(net.credReads, [], 'no TextGrid / Twilio credential is read')
  } finally { net.restore(); await env.db.drop() }
})

test('PG F1: NO healthy established sender (no sticky number, no seller-visible outbound number) ⇒ the intent is HELD with a durable reason, never a sender-less row; zero sends', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await world(env)
    const phone = '+13125550611'
    const anchor = await seedSilence(env, { phone, kind: 's2_interest', stickyNumber: null })
    // the only shown outbound carries no number either
    await env.pool.query(`update public.send_queue set from_phone_number = null where thread_key = $1`, [phone])
    const trig = await deliveryTrigger(env, { phone, ...anchor })
    assert.equal(trig.handled, true, JSON.stringify(trig))
    const m = await materialize(env)
    assert.equal(m.counts.held, 1, JSON.stringify(m))
    const [intent] = await intentsOf(env.pool, phone)
    assert.equal(intent.state, 'held')
    assert.match(intent.state_reason || intent.reason || JSON.stringify(intent), /sender_unresolved:sender_number_unresolved/)
    assert.ok((await eventsOf(env.pool, intent.id)).some((e) => e.to_state === 'held' && /sender_unresolved/.test(e.reason)), 'the hold is audited')
    assert.equal((await rowsOf(env.pool, phone)).length, 0, 'never a sender-less row for the loader to pause')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('F1 (pure): resolveFollowUpSender keeps the thread sender, never switches it silently', async () => {
  const shown = [{ queue_status: 'delivered', from_phone_number: '+13125550199', agent_name: 'Helen', created_at: '2026-10-10T00:00:00Z' }]
  const deps = { threadSentRows: async () => shown }
  // no spec sender ⇒ the sticky sender (persona kept)
  assert.deepEqual(await resolveFollowUpSender({ row_spec: {} }, deps, { thread: { our_number: '+13125550199' } }), { ok: true, from: '+13125550199', source: 'thread_sticky', persona_name: 'Helen' })
  // no sticky ⇒ the last seller-visible outbound's number
  assert.equal((await resolveFollowUpSender({ row_spec: {} }, deps, { thread: {} })).from, '+13125550199')
  // spec sender equal to the thread's ⇒ kept
  assert.equal((await resolveFollowUpSender({ row_spec: { from_phone_number: '3125550199' } }, deps, { thread: { our_number: '+13125550199' } })).from, '+13125550199')
  // spec sender that DISAGREES with the thread's established sender ⇒ held for a person, never switched
  const conflict = await resolveFollowUpSender({ row_spec: { from_phone_number: '+13125550177' } }, deps, { thread: { our_number: '+13125550199' } })
  assert.deepEqual([conflict.ok, conflict.reason], [false, 'sender_continuity_conflict'])
  // nothing at all ⇒ held (durable reason)
  assert.deepEqual(await resolveFollowUpSender({ row_spec: {} }, { threadSentRows: async () => [] }, { thread: null }), { ok: false, reason: 'sender_unresolved:sender_number_unresolved' })
  // an unreadable history is transient (retried), never "no sender"
  const t = await resolveFollowUpSender({ row_spec: {} }, { threadSentRows: async () => { throw new Error('boom') } }, { thread: { our_number: '+13125550199' } })
  assert.deepEqual([t.ok, t.transient, t.reason], [false, true, 'sender_lookup_failed'])
})
