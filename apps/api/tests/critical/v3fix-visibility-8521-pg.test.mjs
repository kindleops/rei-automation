// rc-8.5.21 v3 fix pass — VISIBILITY on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped —
// reported, never vacuous — without it). Every held action records a reason, the originating event and
// resource, the next eligible action or review requirement, an operator item when intervention is needed,
// and an audited transition. Written from the defect descriptions (v3-defect-queue.md):
//   RT-44  a hold added AFTER scheduling blocked the send but recorded no reason
//   RT-45 / RT-46  Spanish / Creole follow-ups were held with no record or operator item
//   RT-33  an ambiguous manual offer got no follow-up of any kind (now: a declared plan or a visible hold)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, seedThread, planNurture, materialize, claimRow, dispatchRow, simProvider, trapTransport, rowsOf, sel, setSwitches, lawfulNowIso, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { maybeScheduleFollowUpAfterDelivery } from '../../src/lib/domain/seller-flow/delivery-triggered-followup.js'
import { loadFollowUpLifecycleHealth } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { evaluateSupervisor } from '../../src/lib/agent/operations/supervisor-checks.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(() => null)
const skip = pgAvailable() ? false : skipReason
async function world() {
  const env = await lifecycleDb()
  await seedWorld(env.pool)
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  await env.pool.query(`alter table public.message_events add column if not exists sent_at timestamptz, add column if not exists metadata jsonb, add column if not exists queue_id text, add column if not exists master_owner_id text`)
  return env
}
const done = async (env) => { __setAutomationHoldResolverForTests(() => ({ held: false, fail_closed: false, holds: [], hold_ids: [], reason: null })); await env.db.drop() }
const readSwitch = (env) => async (k) => (await sel(env.pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null

test('RT-44 (PG): a hold added AFTER scheduling defers the send AND records the reason, the originating event, the resource, the next eligible action and the review requirement on the row, with ONE audited transition', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550801'
    const { inboundId } = await seedThread(env.pool, { phone })
    assert.equal((await planNurture(env.sb, phone, { inboundId })).ok, true)
    assert.equal((await materialize(env)).counts.materialized, 1)
    const [row] = await rowsOf(env.pool, phone)
    // the hold lands after the row was scheduled
    await env.pool.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('h-rt44', 'operator_hold', $1, 'operator reviewing the thread', 'operator:test', 'test-approval')`, [phone])
    const provider = simProvider()
    for (let i = 0; i < 2; i += 1) {
      // the runner reads the row fresh each time
      const claimed = { row: (await sel(env.pool, 'select * from public.send_queue where id = $1', [row.id]))[0], token: null }
      const r = await dispatchRow(env, claimed, { provider, now: lawfulNowIso(Date.parse(row.scheduled_for)) })
      assert.equal(r.status, 423, JSON.stringify(r))
      assert.equal(r.diagnostics?.held_recorded, true)
    }
    assert.equal(provider.sent.length, 0)
    const after = (await sel(env.pool, 'select queue_status, metadata from public.send_queue where id = $1', [row.id]))[0]
    assert.equal(after.queue_status, row.queue_status, 'a hold is reversible: the row status is untouched')
    const h = after.metadata.held_action
    assert.equal(h.reason, 'automation_hold')
    assert.equal(h.hold_type, 'operator_hold')
    assert.match(h.originating_event, /^followup_intent:/)
    assert.equal(h.resource.queue_row_id, row.id)
    assert.equal(h.next_eligible_action, 'dispatch_when_hold_released')
    assert.ok(h.review_required)
    assert.equal(h.count, 2)
    const events = await sel(env.pool, `select event_type, evidence from public.automation_hold_events where evidence->>'kind' = 'send_deferred'`)
    assert.equal(events.length, 1, 'one audited transition per new hold set')
    assert.equal(events[0].evidence.queue_row_id, row.id)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await done(env) }
})

test('RT-45 / RT-46 (PG): a Spanish and a Creole follow-up with no approved copy in their language are HELD (recorded with the reason), and the supervisor raises an operator item — never English, never silent', { skip }, async () => {
  const env = await world()
  try {
    for (const [phone, language] of [['+13125550802', 'Spanish'], ['+13125550803', 'Haitian Creole']]) {
      const { inboundId } = await seedThread(env.pool, { phone })
      assert.equal((await planNurture(env.sb, phone, { inboundId, extra: { language } })).ok, true)
    }
    await materialize(env)
    const intents = await sel(env.pool, `select thread_key, state, reason from public.followup_intents order by thread_key`)
    assert.deepEqual(intents.map((i) => i.state), ['held', 'held'], JSON.stringify(intents))
    assert.match(intents[0].reason, /^language_template_missing:Spanish/)
    assert.match(intents[1].reason, /^language_template_missing:Haitian Creole/)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where type = 'followup'`))[0].n, 0, 'never an English fallback row')
    const health = await loadFollowUpLifecycleHealth({ supabase: env.sb })
    const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, followups: health })
    assert.ok(ev.issues.some((i) => i.dedupe_key === 'supervisor:followup_held'), JSON.stringify(ev.issues))
  } finally { await done(env) }
})

async function deliveredOutbound(env, phone, body, { use_case = null, language = 'en', minutes = 30 } = {}) {
  const sid = `SMv${crypto.randomUUID().slice(0, 8)}`
  const q = (await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, property_id, master_owner_id, provider_message_id, sent_at, delivered_at, created_at, type, metadata)
                         values ($1, 'delivered', $2, $3::text, $4::text, $3::text, $5, 'Helen', 'p1', 'm1', $6, now() - make_interval(mins => $7::int), now() - make_interval(mins => $7::int - 1), now() - make_interval(mins => $7::int), 'outbound', $8::jsonb) returning id`,
  [`v:${sid}`, body, phone, OURS, use_case, sid, minutes, JSON.stringify(use_case ? {} : { manual_operator_send: true })])).rows[0]
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, sent_at, property_id, master_owner_id, queue_id, language, metadata)
                        values ($1, $2, 'outbound', $3::text, $4::text, $3::text, $5, now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), 'p1', 'm1', $7, $8, $9::jsonb)`,
  [crypto.randomUUID(), sid, phone, OURS, body, minutes, String(q.id), language, JSON.stringify(use_case ? { automation_provenance: { template_use_case: use_case } } : {})])
  return sid
}

test('RT-33 (PG): an AMBIGUOUS manual offer ("somewhere between 80 and 90") gets a visible HELD offer-silence follow-up for a person to declare — never no follow-up of any kind, never an invented number', { skip }, async () => {
  const env = await world()
  try {
    const phone = '+13125550804'
    await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, our_number) values ($1, $1, 'p1', 'm1', $2)`, [phone, OURS])
    const sid = await deliveredOutbound(env, phone, 'Somewhere between 80 and 90 depending on the inspection')
    const r = await maybeScheduleFollowUpAfterDelivery({ provider_message_sid: sid, final_delivery_status: 'delivered', supabase: env.sb, getSystemValueImpl: readSwitch(env) })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.match(r.reason, /^offer_followup_plan_undeclared:/)
    assert.equal(r.held_recorded, true)
    const [intent] = await sel(env.pool, `select state, kind, reason, row_spec from public.followup_intents where thread_key = $1`, [phone])
    assert.equal(intent.state, 'held')
    assert.equal(intent.kind, 'offer_silence')
    assert.equal(intent.row_spec.held_visibility.originating_event, `delivered:${sid}`)
    assert.equal(intent.row_spec.held_visibility.review_required, true)
    // replay (a duplicate webhook / the recovery sweep) is the SAME record
    await maybeScheduleFollowUpAfterDelivery({ provider_message_sid: sid, final_delivery_status: 'delivered', supabase: env.sb, getSystemValueImpl: readSwitch(env) })
    assert.equal((await sel(env.pool, `select count(*)::int n from public.followup_intents where thread_key = $1`, [phone]))[0].n, 1)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where thread_key = $1 and queue_status in ('queued','scheduled')`, [phone]))[0].n, 0, 'nothing sendable was invented')
  } finally { await done(env) }
})

test('RT-46 (PG): the no-response chain on a thread whose seller writes Haitian Creole records a HELD follow-up (language) instead of a silent skip', { skip }, async () => {
  const env = await world()
  try {
    await setSwitches(env.pool, { followup_no_response_mode: 'live', followup_no_response_enabled_at: new Date(Date.now() - 86_400_000).toISOString() })
    const phone = '+13125550805'
    await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, our_number, lifecycle_stage) values ($1, $1, 'p1', 'm1', $2, 'offer_interest')`, [phone, OURS])
    await env.pool.query(`insert into public.message_events (direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at) values ('inbound', $1::text, $1::text, $2::text, 'Wi se mwen ki mèt kay la, men mwen pa konnen si m vle vann li', now() - interval '3 hours', now() - interval '3 hours')`, [phone, OURS])
    const sid = await deliveredOutbound(env, phone, 'Hi Dana, this is Helen. Would you consider selling 12 Oak St?', { use_case: 'consider_selling', minutes: 60 })
    const r = await maybeScheduleFollowUpAfterDelivery({ provider_message_sid: sid, final_delivery_status: 'delivered', supabase: env.sb, getSystemValueImpl: readSwitch(env) })
    assert.match(String(r.reason), /^language_/, JSON.stringify(r))
    assert.equal(r.held_recorded, true, JSON.stringify(r))
    const [intent] = await sel(env.pool, `select state, reason from public.followup_intents where thread_key = $1`, [phone])
    assert.equal(intent.state, 'held')
    assert.match(intent.reason, /^language_/)
  } finally { await done(env) }
})

test('RT-46 (unit): Haitian Creole is identified as Haitian Creole — never Spanish (it shares "se", "si", "la")', async () => {
  const { identifyReplyLanguage } = await import('../../src/lib/domain/classification/seller-reply-language.js')
  assert.equal(identifyReplyLanguage('Wi se mwen ki mèt kay la, men mwen pa konnen si m vle vann li'), 'Haitian Creole')
  assert.equal(identifyReplyLanguage('Mwen pa vle vann kay la kounye a, mèsi'), 'Haitian Creole')
  assert.equal(identifyReplyLanguage('Si, estoy interesado en vender la casa'), 'Spanish')
  assert.equal(identifyReplyLanguage('No se si quiero vender'), 'Spanish')
})
