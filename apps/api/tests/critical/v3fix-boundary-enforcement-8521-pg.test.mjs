// rc-8.5.21 v3 fix pass — P0-C: contact and property restrictions are enforced at EVERY boundary, on a
// DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Written
// from the defect descriptions (v3-defect-queue.md), never from the blind cases:
//   RT-47  the canonical queue writer ACCEPTED a campaign row for a phone already on the opt-out list
//   •      the writer refuses a precautionary-held phone, a property-denied / declined-unverified /
//          property-do-not-contact property × contact, an ownership thread hold (multi-property
//          ambiguity) — and a property restriction on A never refuses a row about B
//   •      an unreadable restriction read REFUSES (fail closed), never permits
//   •      the campaign plan's bulk insert (it bypasses the writer) applies the same refusal
//   •      the final provider-submission check (§11 seam, every attempt) refuses independently: a STOP that
//          lands after the runner's send-time guard never reaches the provider
//   •      owner rule 2026-10-19: no unsolicited nurture on a hostile thread (a reply to the seller is not one)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, seedThread, planNurture, materialize, rowsOf, applyS11Ledger, claimRow, dispatchRow, simProvider, trapTransport, sel, lawfulNowIso, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { insertSupabaseSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { __setEnqueueContactRestrictionsModeForTests, filterBulkRowsByContactRestrictions, evaluateEnqueueContactRestrictions } from '../../src/lib/domain/queue/enqueue-contact-restrictions.js'
import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from '../../src/lib/domain/queue/cancel-supabase-pending-outbound.js'
import { setSwitches } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(() => null)
const skip = pgAvailable() ? false : skipReason

async function world() {
  const env = await lifecycleDb()
  await seedWorld(env.pool)
  await env.pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name)
                        values ('p2', 'SFR', 'Chicago', 'IL', '60601', '40 Opal St', 'Dana Q') on conflict do nothing`)
  __setEnqueueContactRestrictionsModeForTests('enforce')
  return env
}
const done = async (env) => { __setEnqueueContactRestrictionsModeForTests(null); await env.db.drop() }

const row = (phone, { property = 'p1', type = 'campaign', meta = {}, body = 'Hi Dana, this is Helen. Would you consider an offer on 12 Oak St?' } = {}) => ({
  queue_key: `t:${crypto.randomUUID()}`, queue_status: 'queued', message_body: body, to_phone_number: phone, from_phone_number: OURS, thread_key: phone,
  property_id: property, master_owner_id: 'm1', prospect_id: 'pr1', type, use_case_template: type === 'campaign' ? 'ownership_check' : 'consider_selling_follow_up',
  agent_name: 'Helen', seller_first_name: 'Dana', property_address: property === 'p1' ? '12 Oak St' : '40 Opal St', metadata: { touch_number: 1, ...meta },
})
const write = (env, r) => insertSupabaseSendQueueRow(r, { supabase: env.sb })
const rowsTo = async (env, phone) => sel(env.pool, 'select id, queue_status, property_id from public.send_queue where to_phone_number = $1 and queue_key like $2', [phone, 't:%'])
const inbound = (env, phone, body, { intent = null, property = 'p1', minutesAgo = 30 } = {}) => env.pool.query(
  `insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, detected_intent)
   values ($1, $2, 'inbound', $3, $3, $4, $5, now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), $7, $8)`,
  [crypto.randomUUID(), `SMi${crypto.randomUUID().slice(0, 8)}`, phone, OURS, body, minutesAgo, property, intent])
const outbound = (env, phone, body, { property = 'p1', minutesAgo = 90 } = {}) => env.pool.query(
  `insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id)
   values ($1, $2, 'outbound', $3, $4, $3, $5, now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), $7)`,
  [crypto.randomUUID(), `SMo${crypto.randomUUID().slice(0, 8)}`, phone, OURS, body, minutesAgo, property])

test('RT-47 (PG): the canonical queue writer REFUSES a campaign row for a phone already on the opt-out list; a clean phone is accepted', { skip }, async () => {
  const env = await world()
  try {
    const stopped = '+13125550470'
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type, reason) values ($1, $1, true, 'opt_out', 'STOP')`, [stopped])
    const r = await write(env, row(stopped))
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.equal(r.reason, 'enqueue_contact_restricted:sms_suppression_list_active')
    assert.equal((await rowsTo(env, stopped)).length, 0, 'never written')
    // the 10-digit stored shape matches too
    const ten = '+13125550471'
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type) values (null, '3125550471', true, 'opt_out')`)
    assert.equal((await write(env, row(ten))).ok, false)
    const clean = '+13125550472'
    const ok = await write(env, row(clean))
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal((await rowsTo(env, clean)).length, 1)
  } finally { await done(env) }
})

test('P0-C (PG): precautionary hold, property denial, declined-unverified and property do-not-contact are refused for THAT property only; a restriction on A never refuses B', { skip }, async () => {
  const env = await world()
  try {
    const prec = '+13125550480'
    await env.pool.query(`insert into public.automation_suppressions (phone_e164, status, suppression_type, suppression_reason) values ($1, 'active', 'precautionary_no_contact', 'possible_opt_out_unconfirmed')`, [prec])
    const p = await write(env, row(prec))
    assert.equal(p.reason, 'enqueue_contact_restricted:automation_suppression_active', JSON.stringify(p))
    assert.equal((await write(env, row(prec, { property: 'p2' }))).ok, false, 'a precautionary hold is contact-wide')

    for (const [phone, role, rejected, expected] of [
      ['+13125550481', 'not_owner', true, /property_ownership_denied_no_recontact|prior_reply_not_owner/],
      ['+13125550482', 'ownership_declined_unverified', false, /ownership_declined_unverified_hold/],
      ['+13125550483', 'property_do_not_contact', true, /property_do_not_contact/],
    ]) {
      await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope) values ('p1', $1, $2, $3, 'contact_property_pair')`, [phone, role, rejected ? new Date().toISOString() : null])
      const a = await write(env, row(phone, { property: 'p1' }))
      assert.equal(a.ok, false, `${role}: refused for p1 ${JSON.stringify(a)}`)
      assert.match(a.reason, expected)
      const b = await write(env, row(phone, { property: 'p2' }))
      assert.equal(b.ok, true, `${role}: the restriction on p1 never refuses p2 ${JSON.stringify(b)}`)
    }
  } finally { await done(env) }
})

test('P0-C (PG): multi-property ambiguity — one bare "No" after ownership questions about TWO properties holds the thread at the writer (never a denial of either, never a send)', { skip }, async () => {
  const env = await world()
  try {
    const phone = '+13125550490'
    await outbound(env, phone, 'Hi Dana, this is Helen. Do you still own 12 Oak St?', { property: 'p1', minutesAgo: 120 })
    await outbound(env, phone, 'And how about 40 Opal St, do you own that one too?', { property: 'p2', minutesAgo: 110 })
    await inbound(env, phone, 'No', { property: null, minutesAgo: 100 })
    for (const property of ['p1', 'p2']) {
      const r = await write(env, row(phone, { property, type: 'followup', meta: { followup_kind: 'stage_silence' } }))
      assert.equal(r.ok, false, `${property}: ${JSON.stringify(r)}`)
      assert.equal(r.reason, 'enqueue_contact_restricted:ownership_denial_property_unresolved')
    }
  } finally { await done(env) }
})

test('P0-C (PG): an UNREADABLE restriction fact refuses the row (fail closed), never permits', { skip }, async () => {
  const env = await world()
  try {
    await env.pool.query('alter table public.sms_suppression_list rename to sms_suppression_list_gone')
    const r = await write(env, row('+13125550500'))
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'enqueue_contact_restriction_read_failed')
    assert.equal((await evaluateEnqueueContactRestrictions(row('+13125550500'), { supabase: null })).reason, 'enqueue_contact_restriction_read_failed', 'no client = refused')
    await assert.rejects(filterBulkRowsByContactRestrictions([row('+13125550500')], { supabase: env.sb }), /enqueue_contact_restriction_read_failed/)
  } finally { await done(env) }
})

test('P0-C (PG): the campaign plan bulk path applies the writer\'s refusal row by row (suppressed + property-denied refused, clean kept)', { skip }, async () => {
  const env = await world()
  try {
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ('+13125550510', true, 'opt_out')`)
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope) values ('p1', '+13125550511', 'not_owner', now(), 'contact_property_pair')`)
    const rows = [row('+13125550510'), row('+13125550511'), row('+13125550511', { property: 'p2' }), row('+13125550512')]
    const v = await filterBulkRowsByContactRestrictions(rows, { supabase: env.sb })
    assert.deepEqual(v.kept.map((r) => `${r.to_phone_number}/${r.property_id}`), ['+13125550511/p2', '+13125550512/p1'])
    assert.deepEqual(v.refused.map((r) => r.guard_reason).sort(), ['prior_reply_not_owner', 'sms_suppression_list_active'].sort())
  } finally { await done(env) }
})

test('P0-C (PG): the final provider submission refuses INDEPENDENTLY — a STOP recorded after the runner\'s send-time guard never reaches the provider', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    await applyS11Ledger(env.pool)
    const phone = '+13125550520'
    // a REAL materialized follow-up row (the lifecycle writer → materializer → the canonical writer)
    const { inboundId } = await seedThread(env.pool, { phone })
    assert.equal((await planNurture(env.sb, phone, { inboundId })).ok, true)
    assert.equal((await materialize(env)).counts.materialized, 1)
    const [r] = await rowsOf(env.pool, phone)
    // the STOP lands between the runner's checks and the seam: the runner's send-time guard and canonical
    // contactability are stubbed to PASS (they read before the STOP committed)
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [phone])
    const provider = simProvider()
    const claimed = await claimRow(env.pool, r.id)
    await dispatchRow(env, claimed, { provider, now: lawfulNowIso(Date.parse(r.scheduled_for)), store: createSellerCommunicationStore({ supabase: env.sb }), extraDeps: { runSendTimeContactGuard: async () => ({ blocked: false }), evaluateCanonicalContactability: async () => ({ blocked: false, allowed: true }) } })
    assert.equal(provider.sent.length, 0, 'the provider was never called')
    const after = (await sel(env.pool, 'select queue_status, failed_reason, guard_reason, metadata from public.send_queue where id = $1', [r.id]))[0]
    assert.notEqual(after.queue_status, 'sent', JSON.stringify(after))
    assert.equal(Number(after.metadata?.dispatch_refusal_count), 1, 'the seam refused the attempt (recorded on the row)')
    // the next claim runs the runner's own guard on fresh reads and terminates the row (never sent)
    const again = await claimRow(env.pool, r.id)
    if (again) await dispatchRow(env, again, { provider, now: lawfulNowIso(Date.parse(r.scheduled_for)), store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal(provider.sent.length, 0)
    assert.match((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [r.id]))[0].queue_status, /cancel|block|suppress/)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await done(env) }
})

test('owner rule 2026-10-19 (PG): a hostile reply is not an opt-out, but no unsolicited nurture is written for the thread; a reply to the seller is still accepted', { skip }, async () => {
  const env = await world()
  try {
    const phone = '+13125550530'
    await outbound(env, phone, 'Hi Dana, this is Helen. Would you consider an offer on 12 Oak St?', { minutesAgo: 120 })
    await inbound(env, phone, 'go to hell you clowns', { intent: 'hostile_or_troll', minutesAgo: 60 })
    const nurture = await write(env, row(phone, { type: 'followup', meta: { followup_kind: 'not_interested_nurture' } }))
    assert.equal(nurture.ok, false, JSON.stringify(nurture))
    assert.equal(nurture.reason, 'enqueue_contact_restricted:hostile_thread_no_nurture')
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.sms_suppression_list where phone_e164 = $1', [phone]))[0].n, 0, 'never a global opt-out')
    const reply = await write(env, row(phone, { type: 'auto_reply', meta: { touch_number: 2 }, body: 'Understood, sorry for the bother.' }))
    assert.equal(reply.ok, true, JSON.stringify(reply))
    // a LATER seller re-engagement (asks for an offer) lifts the nurture block
    await inbound(env, phone, 'ok fine what would you offer', { intent: 'asks_offer', minutesAgo: 5 })
    assert.equal((await write(env, row(phone, { type: 'followup', meta: { followup_kind: 'stage_silence' } }))).ok, true)
  } finally { await done(env) }
})

test('owner rule 2026-10-19 (PG): the follow-up lifecycle never PLANS a nurture for a hostile thread (documented non-executable outcome, no row)', { skip }, async () => {
  const env = await world()
  try {
    const phone = '+13125550540'
    const { inboundId } = await seedThread(env.pool, { phone, inboundBody: 'you people are clowns' })
    await env.pool.query(`update public.message_events set detected_intent = 'hostile_or_troll' where id = $1`, [inboundId])
    const planned = await planNurture(env.sb, phone, { inboundId })
    const intents = await sel(env.pool, 'select state, reason from public.followup_intents where thread_key = $1', [phone])
    assert.equal(intents.length, 1, JSON.stringify({ planned, intents }))
    assert.equal(intents[0].state, 'not_executable')
    assert.match(intents[0].reason, /hostile_thread_no_nurture/)
    await materialize(env)
    assert.equal((await rowsOf(env.pool, phone)).length, 0, 'never a row')
  } finally { await done(env) }
})

test('P0-C (PG): a STOP during preparation cancels EVERY pending outbound of the contact — queued campaign rows, follow-up rows AND not-yet-materialized intents (whatever the lifecycle mode) — and nothing new can be written', { skip }, async () => {
  const env = await world()
  try {
    const phone = '+13125550550'
    // a queued campaign row and a planned (not yet materialized) nurture intent
    assert.equal((await write(env, row(phone, { property: 'p2' }))).ok, true)
    const { inboundId } = await seedThread(env.pool, { phone })
    assert.equal((await planNurture(env.sb, phone, { inboundId })).ok, true)
    // the lifecycle is NOT live (dry run): a STOP still closes the intent (it must never become executable later)
    await setSwitches(env.pool, { followup_execution_mode: 'dry_run' })
    // the STOP: the suppression write + the compliance cancel (the inbound path's two steps)
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [phone])
    const c = await cancelSupabasePendingOutbound({ thread_key: phone, to_phone_number: phone, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: 'stop_request' }, { supabase: env.sb })
    assert.equal(c.ok, true, JSON.stringify(c))
    const live = await sel(env.pool, `select id, queue_status from public.send_queue where to_phone_number = $1 and queue_status in ('queued','scheduled','pending','approved','ready')`, [phone])
    assert.deepEqual(live, [], 'no pending row survives the STOP')
    const intents = await sel(env.pool, `select state from public.followup_intents where thread_key = $1`, [phone])
    assert.ok(intents.length >= 1 && intents.every((i) => i.state === 'cancelled'), JSON.stringify(intents))
    // re-check: a campaign / follow-up prepared before the STOP and written after it is refused
    assert.equal((await write(env, row(phone, { property: 'p1' }))).ok, false)
    assert.equal((await write(env, row(phone, { type: 'followup', meta: { followup_kind: 'stage_silence' } }))).ok, false)
  } finally { await done(env) }
})

test('owner rule (PG): "Take me off that one" about an identified property = a PROPERTY-SCOPED do-not-contact — the classifier\'s contact-wide label is relabelled, p1 refused, p2 still contactable; never non-ownership', { skip }, async () => {
  const { classify } = await import('../../src/lib/domain/classification/classify.js')
  const { applyInboundAutomationDecision } = await import('../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js')
  const { recordPropertyDoNotContact } = await import('../../src/lib/domain/seller-flow/property-scoped-removal.js')
  const env = await world()
  try {
    const phone = '+13125550560'
    await outbound(env, phone, 'Hi Dana, this is Helen. Would you consider an offer on 12 Oak St?', { property: 'p1', minutesAgo: 120 })
    const text = 'Take me off that one'
    const c = await classify(text, null, { heuristicOnly: true })
    const d = applyInboundAutomationDecision({ message: text, threadKey: phone, propertyId: 'p1', prospectId: 'pr1', ownerId: 'm1', classification: c })
    assert.equal(d.next_action, 'property_do_not_contact', JSON.stringify(d))
    assert.equal(d.should_suppress_contact, false)
    assert.equal(d.property_do_not_contact.property_id, 'p1')
    // the inbound was persisted with the classifier's label (as the live path does) and the thread with it
    const id = crypto.randomUUID()
    await env.pool.query(`insert into public.message_events (id, direction, thread_key, from_phone_number, to_phone_number, message_body, created_at, event_timestamp, property_id, detected_intent) values ($1, 'inbound', $2, $2, $3, $4, now(), now(), 'p1', 'opt_out')`, [id, phone, OURS, text])
    await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, disposition, last_intent) values ($1, $1, 'p1', 'opt_out', 'opt_out') on conflict (thread_key) do update set disposition = 'opt_out', last_intent = 'opt_out'`, [phone])
    const r = await recordPropertyDoNotContact({ supabase: env.sb, phone, property_id: 'p1', thread_key: phone, inbound_event_id: id })
    assert.deepEqual(r, { ok: true, relabelled: true })
    const p1 = await write(env, row(phone, { property: 'p1', type: 'followup', meta: { followup_kind: 'stage_silence' } }))
    assert.equal(p1.reason, 'enqueue_contact_restricted:property_do_not_contact', JSON.stringify(p1))
    const p2 = await write(env, row(phone, { property: 'p2' }))
    assert.equal(p2.ok, true, `the other property stays contactable ${JSON.stringify(p2)}`)
    const cpr = (await sel(env.pool, 'select contact_property_role, suppression_scope from public.contact_property_resolution where contact_phone_e164 = $1', [phone]))
    assert.deepEqual(cpr, [{ contact_property_role: 'property_do_not_contact', suppression_scope: 'contact_property_pair' }], 'a restriction, never a not-owner role')
    // contact-wide wording keeps the contact-wide opt-out
    const wide = applyInboundAutomationDecision({ message: 'take me off your list', threadKey: phone, propertyId: 'p1', prospectId: 'pr1', ownerId: 'm1', classification: await classify('take me off your list', null, { heuristicOnly: true }) })
    assert.equal(wide.should_suppress_contact, true)
    // a real contact-wide suppression already present is NEVER relabelled
    const other = '+13125550561'
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [other])
    assert.equal((await recordPropertyDoNotContact({ supabase: env.sb, phone: other, property_id: 'p1', thread_key: other })).relabelled, false)
    assert.equal((await write(env, row(other, { property: 'p2' }))).ok, false)
  } finally { await done(env) }
})
