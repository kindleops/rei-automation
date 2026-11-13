// rc-8.5.21 v4 fix pass — RUNTIME recovery on the REAL runner paths, DISPOSABLE PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Written from the defect
// DESCRIPTIONS (v4 report), never from the blind cases:
//   cr-01  an inbound persisted, the process died before the decide job was enqueued, and NO optional
//          schedule is enabled (the shipped posture) ⇒ the RUNTIME TICK itself recovers exactly one job
//   cr-05  a send crashed after the provider-start marker (outcome genuinely unknown) ⇒ never re-sent, and
//          never silent: ONE operator item per row
//   cr-06  the provider ACCEPTED, the worker died before anything recorded the answer (no provider id on the
//          row or the attempt), the carrier callback arrives with the SID ⇒ the row is reconciled to sent /
//          delivered from that SID through the REAL live delivery lane, the outbound event exists, nothing is
//          sent again; unauthenticated / ambiguous callbacks adopt nothing
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, API_DIR } from '../pg/agent-pg-harness.mjs'
import { combinedDb, registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { seedWorld, seedThread, planNurture, materialize, claimRow, simProvider, trapTransport, rowsOf, sel, lawfulNowIso, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { OP } from '../helpers/conversation-e2e-pg.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { reconcileCanonicalQueueLifecycle } from '../../src/lib/supabase/sms-engine.js'
import { LEASE_MANUAL_REVIEW_REASON } from '../../src/lib/domain/queue/processing-lease-recovery.js'
import { processDeliveryWebhookLive } from '../../src/lib/domain/webhooks/webhook-event-processor.js'
import { adoptOrphanProviderCallback, ORPHAN_CALLBACK_RECONCILED_REASON } from '../../src/lib/domain/communications/adopt-orphan-provider-callback.js'
import { conversationRuntimeMaintenance, __resetConversationMaintenanceThrottleForTests } from '../../src/lib/ai/conversation-decide-handler.js'
import { CONVERSATION_DECIDE_KIND } from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(() => null)
const skip = pgAvailable() ? false : skipReason
const ENV = { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' }
const VERIFIED = { ok: true, verified: true, required: true, signature_verification_mode: 'strict', signature_bypassed: false }

async function world() {
  const env = await combinedDb()
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  await seedWorld(env.pool)
  await env.pool.query(`update agent.runtime_limits set runtime_enabled = true, kind_limits = $1::jsonb where id = 1`, [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP }, [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  // the delivery projection's prod columns (the live delivery lane writes them)
  await env.pool.query(`alter table public.message_events add column if not exists delivery_status text, add column if not exists sent_at timestamptz, add column if not exists delivered_at timestamptz, add column if not exists metadata jsonb, add column if not exists queue_id text,
    add column if not exists provider_delivery_status text, add column if not exists raw_carrier_status text, add column if not exists failed_at timestamptz, add column if not exists error_message text, add column if not exists failure_reason text,
    add column if not exists failure_bucket text, add column if not exists updated_at timestamptz, add column if not exists message_event_key text`)
  await env.pool.query(`create unique index if not exists v4_message_events_key on public.message_events (message_event_key)`)
  await env.pool.query(`alter table public.send_queue add column if not exists delivery_status text, add column if not exists provider_delivery_status text, add column if not exists failed_at timestamptz, add column if not exists queue_status_terminal text,
    add column if not exists textgrid_message_id text, add column if not exists delivered_at timestamptz, add column if not exists delivery_confirmed text`)
  await env.pool.query(`create table if not exists public.webhook_log (id uuid primary key default gen_random_uuid(), provider text, event_type text, payload jsonb, processed boolean default false, processed_at timestamptz,
    error_message text, processor_version text, deployed_sha text, reconciliation_execution_id text, processing_result jsonb, matched_record_id text, processing_error_code text, created_at timestamptz default now(), updated_at timestamptz default now())`)
  return env
}
const child = (args, label) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', ...args], { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.signal, 'SIGKILL', `${label}: ${r.status} ${r.stdout} ${String(r.stderr).slice(-1500)}`)
  return r.stdout
}
const decideJobs = (env) => sel(env.pool, `select job_id, state from agent.research_job where kind = $1`, [CONVERSATION_DECIDE_KIND])
const expireLease = (env, id) => env.pool.query(`update public.send_queue set locked_at = now() - interval '11 minutes', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('processing_timeout_at', (now() - interval '1 minute')::text) where id = $1`, [id])
const rowOf = async (env, id) => (await sel(env.pool, 'select * from public.send_queue where id = $1', [id]))[0]
const attemptsOf = (env, id) => sel(env.pool, 'select * from public.seller_communication_attempts where queue_row_id = $1', [String(id)])

async function claimedFollowUp(env, phone) {
  const { inboundId } = await seedThread(env.pool, { phone })
  assert.equal((await planNurture(env.sb, phone, { inboundId })).ok, true)
  assert.equal((await materialize(env)).counts.materialized, 1)
  const [row] = await rowsOf(env.pool, phone)
  const claimed = await claimRow(env.pool, row.id)
  assert.ok(claimed)
  return claimed
}
// the crash INSIDE the provider call: the §11 attempt is started, nothing recorded its answer — from the
// durable evidence this is exactly "the provider accepted, then the worker died before the ledger write"
const crashInProvider = async (env, claimed) => {
  assert.match(child(['tests/helpers/lease-crash-child.mjs', env.db.url, claimed.row.id, claimed.token, 'in_provider', lawfulNowIso(Date.parse(claimed.row.scheduled_for))], 'in_provider'), /KILL_IN_PROVIDER/)
  const [att] = await attemptsOf(env, claimed.row.id)
  assert.ok(att?.provider_request_started_at && !att.provider_message_id && !att.completed_at, 'started, unanswered, unrecorded')
  const row = await rowOf(env, claimed.row.id)
  assert.equal(row.queue_status, 'processing')
  assert.equal(row.provider_message_id, null)
  return att
}
async function callback(env, { sid, to, from, status = 'delivered', verification = VERIFIED }) {
  const log = (await env.pool.query(`insert into public.webhook_log (provider, event_type, payload) values ('textgrid', 'delivery', $1::jsonb) returning *`,
    [JSON.stringify({ provider_message_sid: sid, message_id: sid, status, to, from, webhook_verification: verification, raw: { MessageSid: sid, MessageStatus: status, To: to, From: from } })])).rows[0]
  return processDeliveryWebhookLive(log, { force_local_delivery_reconcile: true }, { supabase: env.sb, maybeScheduleFollowUpAfterDelivery: async () => ({ ok: true, scheduled: false, reason: 'test' }) })
}

test('cr-01 (REAL SIGKILL, no schedule enabled): the inbound is persisted, the process dies before the decide job ⇒ the RUNTIME TICK recovers EXACTLY ONE job; repeated ticks stay one; born off without the conversation flag', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    __resetConversationMaintenanceThrottleForTests()
    const sid = `SMv4${crypto.randomUUID().slice(0, 8)}`
    assert.match(child(['tests/helpers/v3fix-crash-child.mjs', 'inbound_before_enqueue', env.db.url, sid, '+13125550801', 'yes I would sell, what do you need from me'], 'cr-01'), /KILL_BEFORE_DECIDE_ENQUEUE/)
    assert.deepEqual(await decideJobs(env), [], 'the crash left no job')
    assert.equal((await sel(env.pool, `select count(*)::int n from agent.runtime_schedule where enabled`))[0].n, 0, 'no optional schedule armed (the shipped posture)')
    const store = createRuntimePgStore({ pool: env.db.api })
    const maintenance = conversationRuntimeMaintenance(ENV, { supabase: env.sb, intervalMs: 0 })
    assert.equal(maintenance.length, 1)
    // the tick with NO handlers at all still recovers (maintenance runs before the claim)
    const t1 = await runRuntimeTick({ store, handlers: {}, workerId: 'v4-tick', budgetMs: 10_000, maintenance })
    assert.equal(t1.maintenance?.[0]?.enqueued, 1, JSON.stringify(t1))
    const t2 = await runRuntimeTick({ store, handlers: {}, workerId: 'v4-tick', budgetMs: 10_000, maintenance })
    assert.equal(t2.maintenance?.[0]?.enqueued, 0)
    assert.equal(t2.maintenance?.[0]?.already_present >= 1, true)
    const jobs = await decideJobs(env)
    assert.equal(jobs.length, 1, JSON.stringify(jobs))
    assert.equal(jobs[0].state, 'queued', 'a durable, claimable decide job')
    // born off: no conversation flag ⇒ no maintenance task at all; the per-process throttle bounds the reads
    assert.deepEqual(conversationRuntimeMaintenance({}), [])
    const throttled = conversationRuntimeMaintenance(ENV, { supabase: env.sb })
    __resetConversationMaintenanceThrottleForTests()
    assert.notEqual((await throttled[0].run({ store })).skipped, 'throttled')
    assert.equal((await throttled[0].run({ store })).skipped, 'throttled')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('cr-06 (REAL SIGKILL + the REAL live delivery lane): the provider accepted, the worker died before any ledger write, the carrier callback carries the SID ⇒ reconciled to sent/delivered from that SID, outbound event written, ZERO second submissions', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    for (const [phone, reaperFirst] of [['+13125550802', false], ['+13125550803', true]]) {
      const claimed = await claimedFollowUp(env, phone)
      const att = await crashInProvider(env, claimed)
      if (reaperFirst) {
        // the lease reaper ran before the callback: the ambiguous row is in manual review
        await expireLease(env, claimed.row.id)
        assert.equal((await reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test', recordLaunchCriticalAlert: async () => ({ ok: true }) })).ok, true)
        assert.equal((await rowOf(env, claimed.row.id)).failed_reason, LEASE_MANUAL_REVIEW_REASON)
      }
      const sid = `SMorph${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
      const r = await callback(env, { sid, to: claimed.row.to_phone_number, from: claimed.row.from_phone_number })
      assert.equal(r.ok !== false, true, JSON.stringify(r))
      const after = await rowOf(env, claimed.row.id)
      assert.ok(['sent', 'delivered'].includes(after.queue_status), `${reaperFirst ? 'reaper first' : 'callback first'}: ${after.queue_status} ${after.failed_reason}`)
      assert.equal(after.provider_message_id, sid, 'the provider id comes from the callback')
      assert.equal(after.metadata?.lease_recovery?.reason, ORPHAN_CALLBACK_RECONCILED_REASON)
      const [att2] = await sel(env.pool, 'select * from public.seller_communication_attempts where id = $1', [att.id])
      assert.equal(att2.provider_message_id, sid)
      assert.equal(att2.delivery_possibility, 'provider_accepted')
      assert.equal((await sel(env.pool, `select count(*)::int n from public.message_events where provider_message_sid = $1 and direction = 'outbound'`, [sid]))[0].n, 1, 'the outbound event exists (the projection matches the SID now)')
      // a replayed callback matches by SID — never adopts twice, never resends
      const again = await callback(env, { sid, to: claimed.row.to_phone_number, from: claimed.row.from_phone_number })
      assert.equal(again.ok !== false, true)
      assert.equal(await claimRow(env.pool, claimed.row.id), null, 'never claimable again: no second submission')
    }
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('cr-06 controls: an UNAUTHENTICATED callback, a callback for another sender, and TWO crashed candidates adopt NOTHING (the rows stay held, no guess)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const claimed = await claimedFollowUp(env, '+13125550804')
    await crashInProvider(env, claimed)
    const to = claimed.row.to_phone_number
    const from = claimed.row.from_phone_number
    const unauth = await adoptOrphanProviderCallback({ supabase: env.sb, provider_message_sid: 'SMx1', to, from, verification: { ok: true, verified: false, signature_bypassed: true, signature_verification_mode: 'off' } })
    assert.equal(unauth.adopted, false)
    assert.equal(unauth.reason, 'orphan_adoption_requires_authenticated_receipt')
    const other = await adoptOrphanProviderCallback({ supabase: env.sb, provider_message_sid: 'SMx2', to, from: '+13125550111', verification: VERIFIED })
    assert.equal(other.adopted, false)
    assert.equal(other.reason, 'orphan_zero_candidates')
    // a second crashed send to the same seller from the same number ⇒ ambiguous
    const { inboundId } = await seedThread(env.pool, { phone: to, inboundMinutesAgo: 30 })
    await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, created_at, metadata) values ($1, 'processing', 'x', $2::text, $3::text, $2::text, now(), '{}'::jsonb)`, [`dup:${inboundId}`, to, from])
    const [dup] = await sel(env.pool, `select id from public.send_queue where queue_key = $1`, [`dup:${inboundId}`])
    const [att] = await attemptsOf(env, claimed.row.id)
    await env.pool.query(`insert into public.seller_communication_attempts (logical_communication_id, attempt_number, queue_row_id, provider_request_started_at) values ($1, 2, $2, now())`, [att.logical_communication_id, String(dup.id)])
    const amb = await adoptOrphanProviderCallback({ supabase: env.sb, provider_message_sid: 'SMx3', to, from, verification: VERIFIED })
    assert.equal(amb.adopted, false)
    assert.equal(amb.reason, 'orphan_multiple_candidates')
    assert.equal((await rowOf(env, claimed.row.id)).queue_status, 'processing', 'nothing adopted')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('cr-05 (REAL SIGKILL inside the provider call, no callback ever): the outcome is unknown ⇒ manual review, NEVER re-sent, and ONE operator item per row (deduplicated across reaper passes)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const claimed = await claimedFollowUp(env, '+13125550805')
    await crashInProvider(env, claimed)
    await expireLease(env, claimed.row.id)
    const alerts = []
    const record = async (a) => { alerts.push(a); return { ok: true } }
    assert.equal((await reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test', recordLaunchCriticalAlert: record })).ok, true)
    const after = await rowOf(env, claimed.row.id)
    assert.equal(after.queue_status, 'expired')
    assert.equal(after.failed_reason, LEASE_MANUAL_REVIEW_REASON)
    assert.equal(alerts.length, 1, 'one operator item')
    assert.equal(alerts[0].source_entity_id, String(claimed.row.id))
    assert.match(alerts[0].dedupe_key, new RegExp(String(claimed.row.id)))
    assert.equal(alerts[0].metadata.next_action, 'operator_reconcile_provider_outcome')
    // a second pass does not touch the held row again (no duplicate item, no resend)
    assert.equal((await reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test', recordLaunchCriticalAlert: record })).ok, true)
    assert.equal(alerts.length, 1)
    const provider = simProvider()
    assert.equal(await claimRow(env.pool, claimed.row.id), null, 'never claimable')
    assert.equal(provider.sent.length, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
