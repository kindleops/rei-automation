// P0 2026-10-17 — the FOLLOW-UP EXECUTION LIFECYCLE on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL;
// skipped — reported, never vacuous — without it). Real SQL end to end: the REAL writer
// (scheduleFollowUp, lifecycle mode) → public.followup_intents (followup_intent_plan, projection) →
// materialization (claim lease, the real send-time contact guard, the real hold registry, the real
// deferred resolver over sms_templates, the shared validator) → ONE nonempty send_queue row through the
// canonical writer (enqueueSendQueueItem; the live baseline triggers + the hold trigger + the lifecycle
// bind trigger) → the real queue runner item path (processSendQueueItem) with a SIMULATED provider →
// the send_queue sync trigger → delivery callbacks. Live transport and TextGrid credentials are trapped.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import {
  lifecycleDb, seedWorld, seedThread, planNurture, materialize, trapTransport, simProvider, claimRow, dispatchRow,
  intentsOf, rowsOf, eventsOf, followUpAt, claimableEmptyBodies, sel, OURS,
} from '../helpers/followup-lifecycle-pg.mjs'

const skip = pgAvailable() ? false : skipReason
// the REAL automation-hold registry answers here (critical-test-environment installs a no-holds seam)
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
__setAutomationHoldResolverForTests(null)

test('PG lifecycle: happy path — plan (real writer) → materialize (rendered, nonempty) → claim → simulated provider accepts ONCE → delivered callback', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550101'
    const { inboundId } = await seedThread(env.pool, { phone })
    const planned = await planNurture(env.sb, phone, { inboundId })
    assert.equal(planned.ok, true, JSON.stringify(planned))
    assert.equal(planned.lifecycle, true)
    let [intent] = await intentsOf(env.pool, phone)
    assert.equal(intent.state, 'planned')
    assert.equal(intent.kind, 'not_interested_nurture')
    assert.equal((await rowsOf(env.pool, phone)).length, 0, 'the writer never writes a body-less row in lifecycle mode')
    assert.equal(new Date(await followUpAt(env.pool, phone)).toISOString(), new Date(intent.due_at).toISOString(), 'follow_up_at is the projection, same transaction')

    const m = await materialize(env)
    assert.equal(m.counts.materialized, 1, JSON.stringify(m))
    ;[intent] = await intentsOf(env.pool, phone)
    assert.equal(intent.state, 'ready', JSON.stringify(intent))
    const [row] = await rowsOf(env.pool, phone)
    assert.ok(row.message_body.trim().length > 10)
    assert.match(row.message_body, /Dana/)
    assert.ok(!/[{}]|—|–/.test(row.message_body), row.message_body)
    assert.equal(row.template_source, 'sms_templates')
    assert.ok(row.template_id)
    assert.equal(row.metadata.followup_intent_id, intent.id)
    assert.equal(row.metadata.deferred_message_resolution, false)
    assert.equal(row.metadata.follow_up_id, `followup_intent:${intent.id}`)
    assert.equal(intent.send_queue_id, row.id)
    assert.deepEqual(await claimableEmptyBodies(env.pool), [])

    const provider = simProvider()
    const claimed = await claimRow(env.pool, row.id)
    const out = await dispatchRow(env, claimed, { provider })
    assert.equal(provider.accepted(), 1, `exactly one simulated provider acceptance (${JSON.stringify(out).slice(0, 400)})`)
    assert.equal(provider.sent[0].body || provider.sent[0].message_body || provider.sent[0].message, row.message_body)
    ;[intent] = await intentsOf(env.pool, phone)
    assert.equal(intent.state, 'provider_accepted', JSON.stringify(intent))
    // delivery callback (the columns the status callback writes)
    await env.pool.query(`update public.send_queue set queue_status = 'delivered', delivered_at = now(), delivery_confirmed = 'true' where id = $1`, [row.id])
    ;[intent] = await intentsOf(env.pool, phone)
    assert.deepEqual([intent.state, intent.outcome, intent.next_action], ['delivered', 'delivered', 'await_reply'])
    assert.equal(await followUpAt(env.pool, phone), null, 'a delivered follow-up is no longer a scheduled date')
    const ev = (await eventsOf(env.pool, intent.id)).map((e) => e.to_state)
    assert.deepEqual(ev, ['planned', 'materializing', 'ready', 'dispatched', 'provider_accepted', 'delivered'])
    assert.deepEqual(net.hits, [])
    assert.deepEqual(net.credReads, [])
  } finally { net.restore(); await env.db.drop() }
})

// ── helpers for the matrix ──────────────────────────────────────────────────
import crypto from 'node:crypto'
import { isoPool, pgSupabase } from '../helpers/pg-supabase.mjs'
import { createMemoryS11Store } from '../helpers/s11-memory-store.mjs'
import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from '../../src/lib/domain/queue/cancel-supabase-pending-outbound.js'
import { cancelPendingFollowUpsForThread } from '../../src/lib/domain/seller-flow/seller-followup-scheduler.js'
import { shouldRunSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { runFollowUpReconcile, createFollowUpDeps } from '../../src/lib/domain/followups/followup-execution.js'
import { FALLBACK_SENDER } from '../helpers/followup-lifecycle-pg.mjs'

async function readyRow(env, phone, opts = {}) {
  const { inboundId } = await seedThread(env.pool, { phone, ...(opts.thread || {}) })
  const planned = await planNurture(env.sb, phone, { inboundId, ...(opts.plan || {}) })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const m = await materialize(env, opts.materialize || {})
  assert.equal(m.counts.materialized, 1, JSON.stringify(m))
  const [row] = await rowsOf(env.pool, phone)
  return row
}
const one = async (pool, phone) => (await intentsOf(pool, phone))[0]
const sentCount = async (pool, phone) => Number((await sel(pool, `select count(*)::int n from public.send_queue where thread_key = $1 and type = 'followup' and (sent_at is not null or provider_message_id is not null)`, [phone]))[0].n)

test('PG lifecycle: 2 and 4 CONCURRENT materializers over the same due intents ⇒ every intent exactly ONE row; 2 and 4 concurrent dispatchers on one row ⇒ ONE provider acceptance', { skip }, async () => {
  for (const workers of [2, 4]) {
    const env = await lifecycleDb()
    const net = trapTransport()
    try {
      await seedWorld(env.pool)
      const phones = Array.from({ length: 6 }, (_, i) => `+1312555${String(1100 + workers * 10 + i).padStart(4, '0')}`)
      for (const p of phones) { const { inboundId } = await seedThread(env.pool, { phone: p }); assert.equal((await planNurture(env.sb, p, { inboundId })).ok, true) }
      const pools = Array.from({ length: workers }, () => env.db.trackPool(isoPool(env.db.url, 2)))
      const results = await Promise.all(pools.map((pl, i) => materialize({ ...env, sb: pgSupabase(pl) }, { worker: `w${i}` })))
      const total = results.reduce((a, r) => a + (r.counts?.materialized || 0), 0)
      assert.equal(total, phones.length, JSON.stringify(results.map((r) => r.counts)))
      for (const p of phones) {
        assert.equal((await rowsOf(env.pool, p)).length, 1, `${workers} workers: exactly one row for ${p}`)
        assert.equal((await one(env.pool, p)).state, 'ready')
      }
      // concurrent dispatchers race the same row: one claim wins, one acceptance
      const [row] = await rowsOf(env.pool, phones[0])
      const provider = simProvider()
      const store = createMemoryS11Store()
      const claims = await Promise.all(pools.map((pl) => claimRow(pl, row.id)))
      const winners = claims.filter(Boolean)
      assert.equal(winners.length, 1, `${workers} racing claims: exactly one wins`)
      await Promise.all(winners.map((c) => dispatchRow(env, c, { provider, store })))
      assert.equal(provider.accepted(), 1)
      assert.equal((await one(env.pool, phones[0])).state, 'provider_accepted')
      assert.deepEqual(net.hits, [])
    } finally { net.restore(); await env.db.drop() }
  }
})

test('PG lifecycle: CRASH between materialize and enqueue ⇒ the lease expires, one reclaim, ONE row; crash AFTER the insert ⇒ already ready, nothing doubles', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550131'
    const { inboundId } = await seedThread(env.pool, { phone })
    await planNurture(env.sb, phone, { inboundId })
    // worker A claims, renders, then dies before the write (no transition at all)
    const claimed = (await env.sb.rpc('followup_intent_claim', { p_worker: 'A', p_limit: 5, p_lead_seconds: 1800, p_lease_seconds: 60, p_intent_id: null })).data
    assert.equal(claimed.length, 1)
    assert.equal((await one(env.pool, phone)).state, 'materializing')
    assert.equal((await materialize(env, { worker: 'B' })).counts.claimed, 0, 'a live lease is never stolen')
    await env.pool.query(`update public.followup_intents set lease_until = now() - interval '1 second' where thread_key = $1`, [phone])
    const m = await materialize(env, { worker: 'B' })
    assert.equal(m.counts.materialized, 1, JSON.stringify(m))
    const i = await one(env.pool, phone)
    assert.equal(i.state, 'ready')
    assert.equal(i.attempts, 2)
    assert.ok((await eventsOf(env.pool, i.id)).some((e) => e.reason === 'lease_expired_reclaimed'))
    assert.equal((await rowsOf(env.pool, phone)).length, 1)
    // the dead worker's late write with its old lease is refused by the DB
    const late = await env.sb.from('send_queue').insert({ queue_key: 'late:A', queue_status: 'scheduled', message_body: 'late body from a dead worker', to_phone_number: phone, thread_key: phone, type: 'followup', message_type: 'followup',
      metadata: { followup_intent_id: i.id, followup_materialize_token: claimed[0].lease_token } }).select('id').single()
    // refused twice over: the lease token is stale (bind trigger) and the intent already has its one live row (unique index)
    assert.match(String(late.error?.message), /FOLLOWUP_INTENT: .*not materializing|uq_send_queue_followup_intent_live/, JSON.stringify(late))
    await env.pool.query(`update public.send_queue set queue_status = 'cancelled' where id = (select send_queue_id from public.followup_intents where id = $1)`, [i.id])
    const late2 = await env.sb.from('send_queue').insert({ queue_key: 'late:A2', queue_status: 'scheduled', message_body: 'late body from a dead worker', to_phone_number: phone, thread_key: phone, type: 'followup', message_type: 'followup',
      metadata: { followup_intent_id: i.id, followup_materialize_token: claimed[0].lease_token } }).select('id').single()
    assert.match(String(late2.error?.message), /FOLLOWUP_INTENT: .*not materializing/, JSON.stringify(late2))
  } finally { await env.db.drop() }
  // crash after the insert: the bind trigger already made the intent ready in the insert's transaction
  const env2 = await lifecycleDb()
  try {
    await seedWorld(env2.pool)
    const phone = '+13125550132'
    const { inboundId } = await seedThread(env2.pool, { phone })
    await planNurture(env2.sb, phone, { inboundId })
    const { enqueueSendQueueItem } = await import('../../src/lib/supabase/sms-engine.js')
    const r = await materialize(env2, { enqueue: async (row) => { await enqueueSendQueueItem(row, { supabase: env2.sb }); throw new Error('WORKER_DIED_AFTER_INSERT') } })
    assert.equal(r.counts.lease_lost + r.counts.retry, 1, JSON.stringify(r))
    assert.equal((await one(env2.pool, phone)).state, 'ready')
    assert.equal((await materialize(env2)).counts.claimed, 0)
    assert.equal((await rowsOf(env2.pool, phone)).length, 1)
  } finally { await env2.db.drop() }
})

test('PG lifecycle: CRASH between claim and provider call ⇒ the row stays fenced (dispatched, visible); a released retry sends exactly ONCE', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550141'
    const row = await readyRow(env, phone)
    const c1 = await claimRow(env.pool, row.id)
    assert.ok(c1)
    // the worker dies here: no provider call
    assert.equal((await one(env.pool, phone)).state, 'dispatched')
    assert.equal(await claimRow(env.pool, row.id), null, 'a fenced row cannot be claimed twice')
    const h = (await sel(env.pool, `select dispatched from public.v_followup_intent_health`))[0]
    assert.equal(Number(h.dispatched), 1)
    // recovery releases the lease (no provider evidence on the row)
    await env.pool.query(`update public.send_queue set queue_status = 'queued', is_locked = false, lock_token = null, locked_at = null where id = $1 and sent_at is null and provider_message_id is null`, [row.id])
    assert.equal((await one(env.pool, phone)).state, 'ready')
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider })
    assert.equal(provider.accepted(), 1)
    assert.equal(await sentCount(env.pool, phone), 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: provider TIMEOUT / ambiguous accept ⇒ never retried; the intent is failed_ambiguous → human review; reconcile does not re-plan it', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550151'
    const row = await readyRow(env, phone)
    const store = createMemoryS11Store()
    const provider = simProvider(['timeout', 'accept'])
    const out = await dispatchRow(env, await claimRow(env.pool, row.id), { provider, store })
    assert.equal(provider.sent.length, 1, JSON.stringify(out).slice(0, 300))
    const after = (await sel(env.pool, 'select queue_status, failed_reason, metadata from public.send_queue where id = $1', [row.id]))[0]
    // a second dispatch (if the row were ever claimable again) must not reach the provider
    const again = await claimRow(env.pool, row.id)
    if (again) await dispatchRow(env, again, { provider, store })
    assert.equal(provider.sent.length, 1, `ambiguous: never a second provider call (row ${after.queue_status} ${after.failed_reason})`)
    const i = await one(env.pool, phone)
    assert.ok(['failed', 'dispatched', 'held'].includes(i.state), JSON.stringify(i))
    if (i.state === 'failed') assert.deepEqual([i.outcome, i.next_action], ['failed_ambiguous', 'human_review_no_resend'])
    const deps = await createFollowUpDeps({ supabase: env.sb, readSwitch: async (k) => (await sel(env.pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null })
    const rec = await runFollowUpReconcile(deps, { apply: true })
    assert.equal(rec.counts.retried, 0)
    assert.equal(provider.sent.length, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: TRANSPORT failure before accept ⇒ bounded retry, exactly ONE acceptance', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550161'
    const row = await readyRow(env, phone)
    const store = createMemoryS11Store()
    const provider = simProvider(['connect_refused', 'accept', 'accept'])
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, store })
    let r = (await sel(env.pool, 'select queue_status, retry_count, next_retry_at, failed_reason from public.send_queue where id = $1', [row.id]))[0]
    const intent1 = await one(env.pool, phone)
    // the processor's own bounded retry requeues the row; the next pass sends it
    for (let k = 0; k < 3 && provider.accepted() === 0; k += 1) {
      await env.pool.query(`update public.send_queue set next_retry_at = now() - interval '1 second' where id = $1`, [row.id])
      const c = await claimRow(env.pool, row.id)
      if (!c) break
      await dispatchRow(env, c, { provider, store })
    }
    r = (await sel(env.pool, 'select queue_status, retry_count from public.send_queue where id = $1', [row.id]))[0]
    if (provider.accepted() === 0) {
      // the transport path finalized the row instead: the reconcile re-plans ONE new materialization
      const i = await one(env.pool, phone)
      assert.deepEqual([i.state, i.outcome], ['failed', 'failed_before_accept'], JSON.stringify({ i, r, intent1 }))
      const deps = await createFollowUpDeps({ supabase: env.sb, readSwitch: async (k) => (await sel(env.pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null })
      assert.equal((await runFollowUpReconcile(deps, { apply: true })).counts.retried, 1)
      assert.equal((await runFollowUpReconcile(deps, { apply: true })).counts.retried, 0, 'bounded: one reconcile retry')
      // re-planned AFTER the dispatcher's 24 h identical-body duplicate window; let that day pass
      assert.ok(Date.parse((await one(env.pool, phone)).next_attempt_at) > Date.now() + 23 * 3_600_000)
      assert.equal((await materialize(env)).counts.claimed, 0, 'not before the duplicate window clears')
      await env.pool.query(`update public.message_events set created_at = created_at - interval '25 hours' where to_phone_number = $1`, [phone])
      await env.pool.query(`update public.followup_intents set next_attempt_at = now() where thread_key = $1`, [phone])
      const m2 = await materialize(env)
      assert.equal(m2.counts.materialized, 1, JSON.stringify(m2))
      const rows = await rowsOf(env.pool, phone)
      const fresh = rows.find((x) => x.id !== row.id)
      assert.equal(fresh.queue_key, `fui:${i.id}:m2`)
      const out2 = await dispatchRow(env, await claimRow(env.pool, fresh.id), { provider, store })
      if (process.env.FU_DEBUG) console.error('OUT2', JSON.stringify(out2).slice(0, 600))
    }
    assert.equal(provider.accepted(), 1, JSON.stringify(provider.sent.map((s) => s.step)))
    assert.equal((await one(env.pool, phone)).state, 'provider_accepted')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: STOP between materialize and dispatch ⇒ the real compliance cancel closes the row AND the intent in one pass; a suppression with no cancel is blocked at dispatch; zero sends', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550171'
    const row = await readyRow(env, phone)
    await env.pool.query(`insert into public.message_events (direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, detected_intent, is_opt_out) values ('inbound', $1::text, $1::text, $2::text, 'STOP', now(), now(), 'opt_out', true)`, [phone, OURS])
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type, suppression_reason) values ($1, $1, true, 'opt_out', 'stop')`, [phone])
    const c = await cancelSupabasePendingOutbound({ thread_key: phone, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: 'opt_out_stop', cancelled_by: 'compliance_guard' }, { supabase: env.sb })
    assert.equal(c.ok, true, JSON.stringify(c))
    const i = await one(env.pool, phone)
    assert.equal(i.state, 'cancelled', JSON.stringify(i))
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
    assert.equal(await claimRow(env.pool, row.id), null)
    assert.equal(await followUpAt(env.pool, phone), null)
    // a NEW plan for this phone is refused at materialization (STOP is contact-wide)
    assert.equal((await planNurture(env.sb, phone, { inboundId: crypto.randomUUID() })).ok, true)
    const m = await materialize(env)
    assert.equal(m.counts.not_executable, 1, JSON.stringify(m))
    assert.match((await intentsOf(env.pool, phone)).at(-1).reason, /send_time_guard:(sms_suppression_list_active|opt_out_reply|thread_opted_out)/)
  } finally { net.restore(); await env.db.drop() }
  const env2 = await lifecycleDb()
  const net2 = trapTransport()
  try {
    await seedWorld(env2.pool)
    const phone = '+13125550172'
    const row = await readyRow(env2, phone)
    await env2.pool.query(`insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type, suppression_reason) values ($1, $1, true, 'opt_out', 'stop')`, [phone])
    const provider = simProvider()
    const out = await dispatchRow(env2, await claimRow(env2.pool, row.id), { provider })
    assert.equal(provider.sent.length, 0, JSON.stringify(out).slice(0, 300))
    const i = await one(env2.pool, phone)
    assert.ok(['cancelled', 'held', 'failed'].includes(i.state) && i.reason, JSON.stringify(i))
    assert.deepEqual(net2.hits, [])
  } finally { net2.restore(); await env2.db.drop() }
})

test('PG lifecycle: a PROPERTY DENIAL (contact_property_resolution) ⇒ not_executable with its reason; no row', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550181'
    const { inboundId } = await seedThread(env.pool, { phone })
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, rejection_reason, suppression_scope) values ('p1', $1, 'not_owner', now(), 'not_owner', 'contact_property_pair')`, [phone])
    // caught at PLAN time: a documented non-executable outcome, never an executable intent
    const planned = await planNurture(env.sb, phone, { inboundId })
    assert.deepEqual([planned.ok, planned.reason], [false, 'property_denial:contact_property_resolution'])
    assert.equal((await materialize(env)).counts.claimed, 0)
    const i = await one(env.pool, phone)
    assert.deepEqual([i.state, i.reason], ['not_executable', 'property_denial:contact_property_resolution'])
    // recorded AFTER planning: the materializer's send-time guard blocks it with the same verdict
    const p2 = '+13125550182'
    const s2 = await seedThread(env.pool, { phone: p2 })
    assert.equal((await planNurture(env.sb, p2, { inboundId: s2.inboundId })).ok, true)
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, rejection_reason, suppression_scope) values ('p1', $1, 'not_owner', now(), 'not_owner', 'contact_property_pair')`, [p2])
    assert.equal((await materialize(env)).counts.not_executable, 1)
    assert.equal((await one(env.pool, p2)).reason, 'send_time_guard:prior_reply_not_owner')
    assert.equal((await rowsOf(env.pool, p2)).length, 0)
    assert.equal((await rowsOf(env.pool, phone)).length, 0)
    assert.equal(await followUpAt(env.pool, phone), null, 'a non-executable date is never projected as scheduled')
    const h = (await sel(env.pool, 'select scheduled_executable, not_executable from public.v_followup_intent_health'))[0]
    assert.deepEqual([Number(h.scheduled_executable), Number(h.not_executable)], [0, 2])
    // the ops supervisor's source: counts + reason codes, no thread keys
    const { loadFollowUpLifecycleHealth } = await import('../../src/lib/domain/followups/followup-lifecycle.js')
    const health = await loadFollowUpLifecycleHealth({ supabase: env.sb })
    assert.equal(Number(health.not_executable), 2)
    assert.deepEqual(health.reasons.map((r) => [r.state, r.reason]).sort(), [['not_executable', 'property_denial:contact_property_resolution'], ['not_executable', 'send_time_guard:prior_reply_not_owner']])
    assert.ok(!JSON.stringify(health).includes(phone.slice(-7)))
  } finally { await env.db.drop() }
})

test('PG lifecycle: an OPERATOR HOLD, HARTFORD (registry hold) and MAXWELL (static exclusion, 3746 Baltimore) ⇒ held, never a row; a hold set after materialization blocks the dispatch', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const op = '+13125550191'; const hartford = '+18605550192'; const maxwell = '+12155550193'
    for (const [p, prop] of [[op, 'p1'], [hartford, 'p1'], [maxwell, '251027062']]) {
      const { inboundId } = await seedThread(env.pool, { phone: p, property: prop })
      assert.equal((await planNurture(env.sb, p, { inboundId, property: prop })).ok, true)
    }
    await env.pool.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values
      ('mt:operator', 'operator_hold', $1, 'operator review', 'op', 'MT-OP'), ('owner_hold_20261016:hartford', 'permanent_exclusion', $2, 'Hartford owner-handled', 'owner', 'P0-HARTFORD')`, [op, hartford])
    const m = await materialize(env)
    assert.equal(m.counts.held, 3, JSON.stringify(m))
    for (const p of [op, hartford, maxwell]) {
      const i = await one(env.pool, p)
      assert.equal(i.state, 'held', p)
      assert.match(i.reason, /^automation_hold:/)
      assert.equal((await rowsOf(env.pool, p)).length, 0)
    }
    // hold arriving AFTER materialization: the dispatch is refused
    const late = '+13125550194'
    const row = await readyRow(env, late)
    await env.pool.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('mt:late', 'operator_hold', $1, 'late hold', 'op', 'MT-LATE')`, [late])
    const provider = simProvider()
    let out = null
    try { out = await dispatchRow(env, await claimRow(env.pool, row.id).catch(() => null) || { row, token: 'x' }, { provider }) } catch (e) { out = { error: e.message } }
    assert.equal(provider.sent.length, 0, JSON.stringify(out).slice(0, 300))
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: the thread sender is COOLING ⇒ materialized with its health recorded; the dispatcher never sends from the cooling number', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    await env.pool.query(`update public.textgrid_numbers set status = 'cooling', health_state = 'cooling' where phone_number = $1`, [OURS])
    const phone = '+13125550201'
    const row = await readyRow(env, phone)
    assert.equal(row.metadata.followup_sender_health, 'cooling')
    assert.equal(row.metadata.followup_sender_needs_reroute, true)
    const provider = simProvider()
    const out = await dispatchRow(env, await claimRow(env.pool, row.id), { provider })
    assert.ok(provider.sent.every((s) => !JSON.stringify(s).includes(OURS.slice(-10))), 'never from the cooling sender')
    if (provider.accepted() === 1) assert.ok(JSON.stringify(provider.sent[0]).includes(FALLBACK_SENDER.slice(-10)))
    else {
      // no eligible sender for the thread: a VISIBLE hold on the intent (a routing fix), zero sends
      const i = await one(env.pool, phone)
      assert.equal(provider.sent.length, 0)
      assert.deepEqual([i.state, i.next_action], ['held', 'operator_review'], JSON.stringify({ i, out: JSON.stringify(out).slice(0, 200) }))
      assert.ok(i.reason)
    }
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: OUTSIDE the contact window ⇒ scheduled at the next lawful local instant (not runnable before it, sent once after); UNKNOWN timezone ⇒ held', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550211'
    // 03:00 Chicago today (CDT, UTC-5): 08:00 UTC
    const day = new Date().toISOString().slice(0, 10)
    const at3 = `${day}T08:00:00.000Z`
    const row = await readyRow(env, phone, { materialize: { now: () => at3 } })
    const lawful = Date.parse(row.scheduled_for)
    assert.ok(lawful >= Date.parse(`${day}T13:00:00.000Z`), `not before 08:00 Chicago: ${row.scheduled_for}`)
    assert.equal(shouldRunSendQueueRow(row, at3).reason, 'scheduled_for_in_future')
    const provider = simProvider()
    const sendAt = new Date(lawful + 5 * 60_000).toISOString()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: sendAt })
    assert.equal(provider.accepted(), 1)
    // unknown timezone: no property geography, no stored zone
    const p2 = '+13125550212'
    const { inboundId } = await seedThread(env.pool, { phone: p2, property: 'p-nogeo' })
    await planNurture(env.sb, p2, { inboundId, property: 'p-nogeo' })
    const m = await materialize(env)
    assert.equal(m.counts.held, 1, JSON.stringify(m))
    assert.deepEqual([(await one(env.pool, p2)).state, (await one(env.pool, p2)).reason], ['held', 'recipient_timezone_unresolved'])
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: a FRESH INBOUND supersedes a ready AND a planned follow-up (row cancelled, intents superseded, follow_up_at cleared)', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550221'
    const row = await readyRow(env, phone)
    // a second, later follow-up (different kind) still only planned
    await planNurture(env.sb, phone, { intent: 'seller_callback', dueAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), inboundId: crypto.randomUUID() })
    assert.equal((await intentsOf(env.pool, phone)).length, 2)
    await env.pool.query(`update public.inbox_thread_state set last_inbound_at = now() where thread_key = $1`, [phone])
    const r = await cancelPendingFollowUpsForThread({ thread_key: phone, inbound_received_at: new Date().toISOString(), supabase: env.sb })
    assert.equal(r.ok, true, JSON.stringify(r))
    const states = (await intentsOf(env.pool, phone)).map((i) => i.state).sort()
    assert.deepEqual(states, ['superseded', 'superseded'])
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'cancelled')
    assert.equal(await followUpAt(env.pool, phone), null)
  } finally { await env.db.drop() }
})

test('PG lifecycle: the TEMPLATE is REVOKED mid-flight ⇒ the dispatch gate cancels the row and re-materializes from the currently approved template (audited); ONE send', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550231'
    const row = await readyRow(env, phone)
    await env.pool.query(`update public.sms_templates set is_active = false where template_id = $1`, [row.template_id])
    const provider = simProvider()
    const out = await dispatchRow(env, await claimRow(env.pool, row.id), { provider })
    assert.equal(provider.sent.length, 0)
    assert.equal(out.reason, 'template_revoked_rematerialize')
    let i = await one(env.pool, phone)
    assert.deepEqual([i.state, i.materialize_seq], ['planned', 2])
    assert.ok((await eventsOf(env.pool, i.id)).some((e) => e.reason === 'template_revoked_rematerialize'))
    assert.equal((await materialize(env)).counts.materialized, 1)
    const fresh = (await rowsOf(env.pool, phone)).find((x) => x.id !== row.id)
    assert.notEqual(fresh.template_id, row.template_id)
    assert.equal(fresh.queue_key, `fui:${i.id}:m2`)
    await dispatchRow(env, await claimRow(env.pool, fresh.id), { provider })
    assert.equal(provider.accepted(), 1)
    i = await one(env.pool, phone)
    assert.equal(i.state, 'provider_accepted')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: an UNFILLABLE PLACEHOLDER (no seller name anywhere) and NO APPROVED TEMPLATE ⇒ not_executable with an actionable reason; never a row', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550241'
    await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, disposition, last_inbound_at, our_number) values ($1, $1, 'p1', 'm9', 'not_interested', now() - interval '1 day', $2)`, [phone, OURS])
    await env.pool.query(`insert into public.message_events (direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, language) values ('inbound', $1::text, $1::text, $2::text, 'not interested', now() - interval '1 day', now() - interval '1 day', 'en')`, [phone, OURS])
    const { scheduleFollowUp } = await import('../../src/lib/domain/seller-flow/seller-followup-scheduler.js')
    const r = await scheduleFollowUp('not_interested', phone, { source: 't', master_owner_id: 'm9', property_id: 'p1', scheduled_for_at: new Date(Date.now() - 60_000).toISOString(), language: 'English', skip_email_lane: true }, env.sb)
    assert.equal(r.ok, true)
    const m = await materialize(env)
    assert.equal(m.counts.not_executable, 1, JSON.stringify(m))
    assert.equal((await one(env.pool, phone)).reason, 'unfillable_placeholder')
    assert.equal((await rowsOf(env.pool, phone)).length, 0)
    // no approved template in the seller's language
    const p2 = '+13125550242'
    const { inboundId } = await seedThread(env.pool, { phone: p2 })
    await env.pool.query(`update public.sms_templates set is_active = false`)
    await planNurture(env.sb, p2, { inboundId })
    const m2 = await materialize(env)
    assert.equal(m2.counts.not_executable, 1, JSON.stringify(m2))
    assert.match((await one(env.pool, p2)).reason, /^no_approved_template:/)
  } finally { await env.db.drop() }
})

test('PG lifecycle: CAMPAIGN COLLISION — two texts in the last 24 h ⇒ the follow-up is scheduled after the window clears (≤ 2 per rolling 24 h); the dispatch gate re-checks', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550251'
    const { inboundId } = await seedThread(env.pool, { phone })
    const t1 = Date.now() - 3 * 3_600_000; const t2 = Date.now() - 2 * 3_600_000
    for (const [k, t] of [['c1', t1], ['c2', t2]]) {
      await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, sent_at, created_at, campaign_id) values ($1, 'sent', 'campaign touch body', $2::text, $2::text, 'outbound', $3::timestamptz, $3::timestamptz, gen_random_uuid())`, [`camp:${k}:${phone}`, phone, new Date(t).toISOString()])
    }
    await planNurture(env.sb, phone, { inboundId })
    await materialize(env)
    const [row] = await rowsOf(env.pool, phone)
    assert.ok(Date.parse(row.scheduled_for) >= t1 + 24 * 3_600_000, `scheduled ${row.scheduled_for} after the window clears`)
    assert.equal(row.metadata.followup_send_deferred, true)
    // dispatch attempted early (e.g. an operator forces it): the gate defers, nothing is sent
    await env.pool.query(`update public.send_queue set scheduled_for = now() - interval '1 minute', scheduled_for_utc = now() - interval '1 minute' where id = $1`, [row.id])
    const provider = simProvider()
    const out = await dispatchRow(env, await claimRow(env.pool, row.id), { provider })
    assert.equal(provider.sent.length, 0)
    assert.equal(out.reason, 'collision_max_texts_per_24h')
    assert.ok(Date.parse((await sel(env.pool, 'select scheduled_for from public.send_queue where id = $1', [row.id]))[0].scheduled_for) >= t1 + 24 * 3_600_000)
    assert.equal((await one(env.pool, phone)).state, 'ready')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: DELIVERY callbacks reconcile — failed AFTER accept ⇒ failed_after_accept / human review, never re-planned; a late delivered after a terminal state is recorded, not applied', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550261'
    const row = await readyRow(env, phone)
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider })
    assert.equal(provider.accepted(), 1)
    await env.pool.query(`update public.send_queue set queue_status = 'failed', failed_reason = 'carrier_undelivered_30007' where id = $1`, [row.id])
    const i = await one(env.pool, phone)
    assert.deepEqual([i.state, i.outcome, i.next_action], ['failed', 'failed_after_accept', 'human_review_no_resend'])
    const deps = await createFollowUpDeps({ supabase: env.sb, readSwitch: async (k) => (await sel(env.pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null })
    assert.equal((await runFollowUpReconcile(deps, { apply: true })).counts.retried, 0)
    await assert.rejects(env.pool.query(`update public.followup_intents set state = 'planned' where id = $1`, [i.id]), /FOLLOWUP_INTENT_TRANSITION/)
    assert.equal(provider.sent.length, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: NO path produces a claimable empty-body follow-up — every writer intent in live mode, the DB refuses an empty lifecycle body and any empty sendable follow-up row; the loader still pauses an empty body', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550271'
    const { inboundId } = await seedThread(env.pool, { phone })
    const { scheduleFollowUp } = await import('../../src/lib/domain/seller-flow/seller-followup-scheduler.js')
    // every scheduler intent family (+ the stage / no-response shapes) through the ONE writer
    for (const [intent, extra] of [
      ['not_interested', {}], ['seller_callback', {}], ['tenant_or_occupancy', {}], ['listed_or_unavailable', {}], ['asking_price_value', {}], ['unclear', {}],
      ['stage_no_reply', { stage: 'offer_interest', stage_no_reply_hours: 24, followup_use_case: 'consider_selling_follow_up', followup_dedupe_scope: 'nr:root:1', no_response_followup: { kind: 's2_interest', step: 0 } }],
    ]) {
      const r = await scheduleFollowUp(intent, phone, { source: 'all_writers', inbound_message_event_id: `${inboundId}:${intent}`, master_owner_id: 'm1', property_id: 'p1', skip_email_lane: true, ...extra }, env.sb)
      assert.equal(r.ok, true, `${intent}: ${JSON.stringify(r)}`)
      assert.equal(r.lifecycle, true, intent)
    }
    assert.deepEqual(await claimableEmptyBodies(env.pool), [], 'no body-less row from any writer')
    assert.equal((await rowsOf(env.pool, phone)).length, 0)
    // the DB refuses a body-less sendable follow-up row from ANY writer while live
    const bad = await env.sb.from('send_queue').insert({ queue_key: 'legacy:bodyless', queue_status: 'scheduled', message_body: '', to_phone_number: phone, thread_key: phone, type: 'followup', message_type: 'followup', metadata: { deferred_message_resolution: true } }).select('id').single()
    assert.match(String(bad.error?.message), /FOLLOWUP_EMPTY_BODY/)
    // and an empty-body lifecycle row even from the lease holder
    const [claimed] = (await env.sb.rpc('followup_intent_claim', { p_worker: 'X', p_limit: 1, p_lead_seconds: 365 * 86400, p_lease_seconds: 60, p_intent_id: null })).data
    const empty = await env.sb.from('send_queue').insert({ queue_key: 'fui:empty', queue_status: 'paused_operator_review', message_body: ' ', to_phone_number: phone, thread_key: phone, type: 'followup', message_type: 'followup', metadata: { followup_intent_id: claimed.id, followup_materialize_token: claimed.lease_token } }).select('id').single()
    assert.match(String(empty.error?.message), /FOLLOWUP_INTENT: an empty message body is refused/)
    // the retained dispatch-time prohibition: an empty body is never runnable
    assert.equal(shouldRunSendQueueRow({ id: 'x', queue_status: 'scheduled', message_body: '', to_phone_number: phone, scheduled_for: new Date(Date.now() - 1000).toISOString(), metadata: { deferred_message_resolution: true } }).reason, 'missing_message_body')
  } finally { await env.db.drop() }
})

test('PG lifecycle: BORN OFF — mode absent ⇒ the writer is unchanged (legacy row), no intent, no trigger effect; the thread-state guard is inert', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool, { mode: null })
    const phone = '+13125550281'
    const { inboundId } = await seedThread(env.pool, { phone })
    const r = await planNurture(env.sb, phone, { inboundId })
    assert.equal(r.lifecycle, undefined)
    assert.equal((await intentsOf(env.pool, phone)).length, 0)
    const [row] = await rowsOf(env.pool, phone)
    assert.equal(row.metadata.deferred_message_resolution, true, 'legacy behaviour exactly as before (OFF)')
    await env.pool.query(`update public.inbox_thread_state set follow_up_at = now() + interval '30 days' where thread_key = $1`, [phone])
    assert.ok(await followUpAt(env.pool, phone), 'off: a bare follow_up_at write is untouched')
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.followup_intents'))[0].n, 0)
    assert.equal((await materialize(env)).code, 'LIFECYCLE_OFF')
  } finally { await env.db.drop() }
})

test('PG lifecycle: live ⇒ a BARE follow_up_at write (an unrepaired writer) is recorded as a documented not_executable intent and follow_up_at stays the projection', { skip }, async () => {
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550291'
    await seedThread(env.pool, { phone })
    await env.pool.query(`update public.inbox_thread_state set follow_up_at = now() + interval '30 days' where thread_key = $1`, [phone])
    assert.equal(await followUpAt(env.pool, phone), null)
    const [i] = await intentsOf(env.pool, phone)
    assert.deepEqual([i.state, i.reason, i.writer], ['not_executable', 'bare_follow_up_at_write_without_intent', 'unattributed_thread_state_write'])
  } finally { await env.db.drop() }
})

test('PG lifecycle (owner rules 2026-10-17): "No thanks" to ownership = ownership_declined_unverified, a PROPERTY-SCOPED no-recontact hold — no executable intent at plan, blocked at materialization AND dispatch, never recorded as non-ownership; another property of the same contact still runs; "No" to selling still nurtures', { skip }, async () => {
  const { OWNERSHIP_DECLINED_UNVERIFIED } = await import('../../src/lib/domain/followups/followup-lifecycle.js')
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    await env.pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name) values ('p2', 'SFR', 'Chicago', 'IL', '60602', '40 Pine St', 'Dana Q')`)
    // (a) plan time: the thread's state says declined-unverified for p1 ⇒ a documented non-executable, not an intent to run
    const phone = '+13125550401'
    const { inboundId } = await seedThread(env.pool, { phone, inboundBody: 'No thanks', disposition: OWNERSHIP_DECLINED_UNVERIFIED })
    const r = await planNurture(env.sb, phone, { inboundId })
    assert.deepEqual([r.ok, r.lifecycle, r.reason], [false, true, `${OWNERSHIP_DECLINED_UNVERIFIED}:no_recontact_hold`])
    const [i] = await intentsOf(env.pool, phone)
    assert.deepEqual([i.state, i.reason], ['held', `${OWNERSHIP_DECLINED_UNVERIFIED}:no_recontact_hold`], 'deferred / held, never a nurture')
    assert.ok(!/not_owner|non_owner|denial/.test(i.reason), 'never recorded as non-ownership')
    assert.equal(await followUpAt(env.pool, phone), null)
    assert.equal((await materialize(env)).counts.claimed, 0)
    // (b) the same contact, ANOTHER property (property-scoped, never contact-wide): runs normally
    await env.pool.query(`update public.inbox_thread_state set property_id = 'p1' where thread_key = $1`, [phone])
    const other = await planNurture(env.sb, phone, { inboundId: crypto.randomUUID(), property: 'p2' })
    assert.equal(other.ok, true, JSON.stringify(other))
    // (c) recorded in the resolution store AFTER planning: blocked at materialization
    const p3 = '+13125550402'
    const s3 = await seedThread(env.pool, { phone: p3 })
    assert.equal((await planNurture(env.sb, p3, { inboundId: s3.inboundId })).ok, true)
    // the rc-8.5.21 resolution contract: role ownership_declined_unverified, rejected_at NULL, scope contact_property_pair
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope) values ('p1', $1, $2, null, 'contact_property_pair')`, [p3, OWNERSHIP_DECLINED_UNVERIFIED])
    const m = await materialize(env)
    assert.ok(m.counts.materialized >= 1, 'the other-property follow-up materializes')
    const i3 = (await intentsOf(env.pool, p3))[0]
    assert.ok(['held'].includes(i3.state) && /ownership_declined_unverified/.test(i3.reason), JSON.stringify([i3.state, i3.reason]))
    assert.ok(!/not_owner|prior_reply_not_owner|denial/.test(i3.reason), 'never recorded as not_owner')
    assert.equal((await rowsOf(env.pool, p3)).length, 0)
    // (d) recorded AFTER materialization: the dispatch gate cancels, zero sends
    const p4 = '+13125550403'
    const s4 = await seedThread(env.pool, { phone: p4 })
    await planNurture(env.sb, p4, { inboundId: s4.inboundId })
    await materialize(env)
    const [row4] = await rowsOf(env.pool, p4)
    await env.pool.query(`update public.inbox_thread_state set disposition = $2 where thread_key = $1`, [p4, OWNERSHIP_DECLINED_UNVERIFIED])
    const provider = simProvider()
    const out = await dispatchRow(env, await claimRow(env.pool, row4.id), { provider })
    assert.equal(provider.sent.length, 0)
    assert.equal(out.reason, `${OWNERSHIP_DECLINED_UNVERIFIED}:no_recontact_hold`)
    assert.equal((await intentsOf(env.pool, p4))[0].state, 'held', 'the row is paused, the intent held (deferred)')
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row4.id]))[0].queue_status, 'paused_automation_hold')
    // (e) a bare "No" to ownership (property denial, recorded pair) blocks too; "No" to SELLING still nurtures
    const p5 = '+13125550404'
    const s5 = await seedThread(env.pool, { phone: p5, inboundBody: 'No' })
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, rejection_reason) values ('p1', $1, 'not_owner', now(), 'ownership_denied')`, [p5])
    const d5 = await planNurture(env.sb, p5, { inboundId: s5.inboundId })
    assert.deepEqual([d5.ok, d5.reason], [false, 'property_denial:contact_property_resolution'])
    const p6 = '+13125550405'
    const s6 = await seedThread(env.pool, { phone: p6, inboundBody: 'No, not selling' })
    assert.equal((await planNurture(env.sb, p6, { inboundId: s6.inboundId })).ok, true, 'a "No" to selling is the 30-day nurture')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG lifecycle: the QUEUE RUNNER drives materialization before it selects rows (live only): one runSendQueue pass turns a due intent into a nonempty row; OFF it does nothing', { skip }, async () => {
  const { runSendQueue } = await import('../../src/lib/domain/queue/run-send-queue.js')
  const env = await lifecycleDb()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550501'
    const { inboundId } = await seedThread(env.pool, { phone })
    await planNurture(env.sb, phone, { inboundId })
    let seen = null
    const deps = {
      supabaseClient: env.sb, getSystemFlag: async () => true, getSystemValue: async (k) => ({ queue_execution_mode: 'normal', queue_processor_mode: 'live' })[k] ?? null, info: () => {}, warn: () => {}, error: () => {},
      runFollowUpMaterialization: async (d) => { seen = await (await import('../../src/lib/domain/followups/followup-lifecycle.js')).runFollowUpMaterialization({ ...d, holdCheck: async () => ({ held: false }) }); return seen },
    }
    const first = await runSendQueue({ limit: 1 }, deps).catch((e) => ({ thrown: e.message }))
    assert.equal(seen?.counts?.materialized, 1, JSON.stringify({ seen, first }).slice(0, 600))
    const [row] = await rowsOf(env.pool, phone)
    assert.ok(row.message_body.trim().length > 10)
    await setSwitchesOff(env.pool)
    seen = null
    await runSendQueue({ limit: 1 }, deps).catch(() => null)
    assert.equal(seen, null, 'OFF: the runner never materializes')
  } finally { await env.db.drop() }
})
async function setSwitchesOff(pool) { await pool.query(`delete from public.system_control where key = 'followup_execution_mode'`) }
