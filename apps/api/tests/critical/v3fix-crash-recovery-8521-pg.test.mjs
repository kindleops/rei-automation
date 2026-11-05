// rc-8.5.21 v3 fix pass — CRASH RECOVERY with REAL SIGKILLs on a DISPOSABLE PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Written from the defect
// descriptions (v3-defect-queue.md), never from the blind cases. Every interrupted workflow ends in a
// durable terminal state or a visible recoverable hold:
//   A  (RT-12) inbound persisted, decide job never enqueued ⇒ the sweep creates EXACTLY ONE durable job
//   B  (RT-15) the provider ACCEPTED, the worker died before the row was finalized ⇒ reconciled to sent from
//      the §11 attempt's provider id, no second submission; ambiguous ⇒ manual review, surfaced
//   RT-14      the worker died after the §11 attempt allocation, before the provider-start marker ⇒ the
//      attempt is resolved as provably unsent and the row is sent EXACTLY ONCE (it used to be held for
//      manual review forever: the RUN-09 reaper treated the allocated-but-unstarted attempt as ambiguous)
//   C  (RT-16) a message was delivered, the worker died before the next silence follow-up was planned ⇒
//      the sweep plans it EXACTLY ONCE, no extra seller message
//   Ops supervisor: its auto-recovery detects and recovers a stranded inbound and a missed follow-up, and
//      escalates what it cannot recover (an ambiguous crash)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, API_DIR } from '../pg/agent-pg-harness.mjs'
import { combinedDb, registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { seedWorld, seedThread, planNurture, materialize, claimRow, dispatchRow, simProvider, trapTransport, rowsOf, sel, lawfulNowIso, OURS } from '../helpers/followup-lifecycle-pg.mjs'
import { OP } from '../helpers/conversation-e2e-pg.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { reconcileCanonicalQueueLifecycle } from '../../src/lib/supabase/sms-engine.js'
import { recoverExpiredProcessingLeases, LEASE_MANUAL_REVIEW_REASON } from '../../src/lib/domain/queue/processing-lease-recovery.js'
import { recoverStrandedInbounds } from '../../src/lib/ai/conversation-inbound-sweep.js'
import { recoverMissedDeliveryFollowUps } from '../../src/lib/domain/seller-flow/recover-missed-delivery-followups.js'
import { createAutoRecoverySource } from '../../src/lib/agent/operations/auto-recovery.js'
import { evaluateSupervisor } from '../../src/lib/agent/operations/supervisor-checks.js'
import { CONVERSATION_DECIDE_KIND } from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(() => null)
const skip = pgAvailable() ? false : skipReason
const ENV = { AI_CONVERSATION_SHADOW_ENABLED: 'true' }

async function world() {
  const env = await combinedDb()
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  await seedWorld(env.pool)
  // the decide kind armed (as an operator would): the hook and the sweep can enqueue it
  await env.pool.query(`update agent.runtime_limits set kind_limits = $1::jsonb where id = 1`, [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP }, [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  await env.pool.query(`alter table public.message_events add column if not exists delivery_status text`)
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
const reconcile = (env) => reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test' })
const store = (env) => createSellerCommunicationStore({ supabase: env.sb })

async function claimedFollowUp(env, phone) {
  const { inboundId } = await seedThread(env.pool, { phone })
  assert.equal((await planNurture(env.sb, phone, { inboundId })).ok, true)
  assert.equal((await materialize(env)).counts.materialized, 1)
  const [row] = await rowsOf(env.pool, phone)
  const claimed = await claimRow(env.pool, row.id)
  assert.ok(claimed)
  return claimed
}
const leaseCrash = (env, claimed, point) => child(['tests/helpers/lease-crash-child.mjs', env.db.url, claimed.row.id, claimed.token, point, lawfulNowIso(Date.parse(claimed.row.scheduled_for))], point)

test('A (RT-12, REAL SIGKILL): the inbound is persisted, the worker dies before the decide job is enqueued ⇒ the sweep creates EXACTLY ONE durable job (twice-run, and a duplicate webhook, still one)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const sid = `SMv3${crypto.randomUUID().slice(0, 8)}`
    assert.match(child(['tests/helpers/v3fix-crash-child.mjs', 'inbound_before_enqueue', env.db.url, sid, '+13125550701', 'Yes I still own it, what would you offer?'], 'A'), /KILL_BEFORE_DECIDE_ENQUEUE/)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.message_events where provider_message_sid = $1`, [sid]))[0].n, 1, 'the inbound is durable')
    assert.deepEqual(await decideJobs(env), [], 'the crash left NO job (the turn was lost before this fix)')
    const runtimeStore = createRuntimePgStore({ pool: env.db.api })
    const r1 = await recoverStrandedInbounds({ supabase: env.sb, runtimeStore, env: ENV })
    assert.equal(r1.ok, true, JSON.stringify(r1))
    assert.equal(r1.enqueued, 1)
    const r2 = await recoverStrandedInbounds({ supabase: env.sb, runtimeStore, env: ENV })
    assert.equal(r2.enqueued, 0)
    assert.equal(r2.already_present, 1)
    // the live hook firing again (a duplicate webhook) dedupes onto the SAME job
    const { scheduleConversationAiShadow } = await import('../../src/lib/ai/conversation-ai-shadow-hook.js')
    await new Promise((resolve) => scheduleConversationAiShadow({ providerMessageSid: sid, messageBody: 'Yes I still own it, what would you offer?' }, { env: ENV, gate: async () => ({ enabled: true }), getStore: async () => runtimeStore, defer: (fn) => fn().then(resolve) }))
    const jobs = await decideJobs(env)
    assert.equal(jobs.length, 1, JSON.stringify(jobs))
    assert.equal(jobs[0].state, 'queued', 'a durable, claimable job')
    // the sweep is born off: without the AI shadow flag it does nothing
    assert.equal((await recoverStrandedInbounds({ supabase: env.sb, runtimeStore, env: {} })).skipped, 'SHADOW_ENV_OFF')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('RT-14 (REAL SIGKILL): the worker dies right after the §11 attempt allocation, before the provider-start marker ⇒ provably unsent: the attempt is resolved and the row is sent EXACTLY ONCE (never parked in manual review)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const claimed = await claimedFollowUp(env, '+13125550702')
    assert.match(leaseCrash(env, claimed, 'after_allocate'), /KILL_AFTER_ALLOCATE/)
    const [att] = await sel(env.pool, 'select * from public.seller_communication_attempts where queue_row_id = $1', [String(claimed.row.id)])
    assert.ok(att && !att.completed_at && !att.provider_request_started_at, 'an allocated, never-started attempt (the RT-14 shape)')
    await expireLease(env, claimed.row.id)
    const rec = await reconcile(env)
    assert.equal(rec.ok, true, JSON.stringify(rec))
    const after = await rowOf(env, claimed.row.id)
    assert.equal(after.queue_status, 'queued', `re-dispatched, not manual review: ${after.queue_status} ${after.failed_reason}`)
    const [resolved] = await sel(env.pool, 'select * from public.seller_communication_attempts where id = $1', [att.id])
    assert.equal(resolved.delivery_possibility, 'definitely_not_sent')
    assert.ok(resolved.completed_at)
    // the ONE send
    const provider = simProvider()
    const again = await claimRow(env.pool, claimed.row.id)
    await dispatchRow(env, again, { provider, now: lawfulNowIso(Date.parse(claimed.row.scheduled_for)), store: store(env) })
    assert.equal(provider.accepted(), 1, `exactly one provider acceptance (${provider.sent.length} calls)`)
    assert.ok(['sent', 'delivered'].includes((await rowOf(env, claimed.row.id)).queue_status))
    assert.equal(await claimRow(env.pool, claimed.row.id), null, 'never claimable again')
    // a resolved attempt can never be started by a stalled worker
    const late = await store(env).markProviderRequestStarted({ attempt_id: att.id, at: new Date().toISOString() })
    assert.equal(late.ok, false)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('B (RT-15, REAL SIGKILL): the provider ACCEPTED, the worker died before the row was finalized ⇒ reconciled to sent from the §11 attempt\'s provider id, ZERO second submissions (both reapers)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    for (const [phone, reaper] of [['+13125550703', 'reconcile'], ['+13125550704', 'tick']]) {
      const claimed = await claimedFollowUp(env, phone)
      assert.match(leaseCrash(env, claimed, 'after_accept'), /KILL_AFTER_ACCEPT/)
      const stuck = await rowOf(env, claimed.row.id)
      assert.equal(stuck.queue_status, 'processing', 'the dead worker left it processing (the RT-15 shape)')
      await expireLease(env, claimed.row.id)
      if (reaper === 'reconcile') assert.equal((await reconcile(env)).ok, true)
      else {
        const out = await recoverExpiredProcessingLeases(env.sb, [await rowOf(env, claimed.row.id)])
        assert.deepEqual(out.reconciled_sent, [claimed.row.id], JSON.stringify(out))
      }
      const after = await rowOf(env, claimed.row.id)
      assert.equal(after.queue_status, 'sent', `${reaper}: ${after.queue_status} ${after.failed_reason}`)
      assert.equal(after.provider_message_id, `SMchild${String(claimed.row.id).replace(/-/g, '').slice(0, 10)}`, 'the provider id comes from the attempt')
      assert.equal(after.metadata?.lease_recovery?.action, 'reconciled_sent_from_attempt')
      const provider = simProvider()
      const again = await claimRow(env.pool, claimed.row.id)
      assert.equal(again, null, 'never claimable: no second submission')
      assert.equal(provider.sent.length, 0)
    }
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('B ambiguous (REAL SIGKILL inside the provider call) ⇒ manual review WITH an operator-review escalation on the row, and the supervisor surfaces it as unrecoverable', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const claimed = await claimedFollowUp(env, '+13125550705')
    assert.match(leaseCrash(env, claimed, 'in_provider'), /KILL_IN_PROVIDER/)
    await expireLease(env, claimed.row.id)
    assert.equal((await reconcile(env)).ok, true)
    const after = await rowOf(env, claimed.row.id)
    assert.equal(after.queue_status, 'expired')
    assert.equal(after.failed_reason, LEASE_MANUAL_REVIEW_REASON)
    assert.equal(after.metadata?.lease_recovery?.operator_review_required, true, 'a visible recoverable hold, never silent')
    assert.ok((after.metadata?.lease_recovery?.blockers || []).includes('attempt_provider_request_started'))
    const auto = await createAutoRecoverySource({ supabase: env.sb, runtimeStore: createRuntimePgStore({ pool: env.db.api }), env: ENV }).run()
    assert.equal(auto.lease_manual_review, 1)
    assert.ok(auto.unrecoverable.some((u) => u.kind === 'lease_manual_review' && u.ref === String(claimed.row.id)))
    const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, autoRecovery: auto })
    const issue = ev.issues.find((i) => i.check_id === 'auto_recovery')
    assert.ok(issue && issue.escalate === true && issue.recoverable === false, JSON.stringify(ev.issues))
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

async function deliveredAnchor(env, phone) {
  const sid = `SMd${crypto.randomUUID().slice(0, 8)}`
  await env.pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, stage, lifecycle_stage, our_number) values ($1, $1, 'p1', 'm1', 'pr1', 'ownership', 'ownership', $2) on conflict (thread_key) do nothing`, [phone, OURS])
  await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name, property_id, master_owner_id, prospect_id, property_address, provider_message_id, sent_at, created_at, type, metadata)
                        values ($1, 'sent', 'Hi Dana, this is Helen. Do you still own 12 Oak St?', $2::text, $3::text, $2::text, 'ownership_check', 'Helen', 'Dana', 'p1', 'm1', 'pr1', '12 Oak St', $4, now() - interval '50 minutes', now() - interval '50 minutes', 'campaign', '{}'::jsonb)`, [`anchor:${sid}`, phone, OURS, sid])
  await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, sent_at, property_id, master_owner_id, metadata)
                        values ($1, $2, 'outbound', $3::text, $4::text, $3::text, 'Hi Dana, this is Helen. Do you still own 12 Oak St?', now() - interval '50 minutes', now() - interval '50 minutes', now() - interval '50 minutes', 'p1', 'm1', $5::jsonb)`,
  [crypto.randomUUID(), sid, phone, OURS, JSON.stringify({ agent_name: 'Helen', automation_provenance: { template_use_case: 'ownership_check' } })])
  const wh = (await env.pool.query(`insert into public.webhook_log (provider, event_type, payload) values ('textgrid', 'delivery', $1::jsonb) returning id`, [JSON.stringify({ provider_message_sid: sid, message_id: sid, MessageSid: sid, status: 'delivered', MessageStatus: 'delivered' })])).rows[0].id
  return { sid, wh }
}
const followUpsOf = (env, phone) => sel(env.pool, `select id, state, kind from public.followup_intents where thread_key = $1`, [phone])

test('C (RT-16, REAL SIGKILL): a message was delivered, the worker died before the next silence follow-up was planned ⇒ the sweep plans it EXACTLY ONCE, no extra seller message', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    await env.pool.query(`alter table public.message_events add column if not exists sent_at timestamptz, add column if not exists metadata jsonb, add column if not exists queue_id text`)
    const phone = '+13125550706'
    const { sid, wh } = await deliveredAnchor(env, phone)
    assert.match(child(['tests/helpers/v3fix-crash-child.mjs', 'delivery_before_followup', env.db.url, sid, wh], 'C'), /KILL_BEFORE_FOLLOWUP_SCHEDULE/)
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where provider_message_id = $1', [sid]))[0].queue_status, 'delivered')
    assert.deepEqual(await followUpsOf(env, phone), [], 'the crash lost the next action (before this fix nothing re-read the anchor)')
    const r1 = await recoverMissedDeliveryFollowUps({ supabase: env.sb })
    assert.equal(r1.ok, true, JSON.stringify(r1))
    const r2 = await recoverMissedDeliveryFollowUps({ supabase: env.sb })
    assert.equal(r2.ok, true, JSON.stringify(r2))
    const intents = await followUpsOf(env, phone)
    assert.equal(intents.length, 1, `exactly one next action ${JSON.stringify({ intents, r1, r2 })}`)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where thread_key = $1 and queue_status in ('queued','scheduled','pending','approved','ready','processing','sending')`, [phone]))[0].n, 0, 'nothing is sent or queued by the recovery itself')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('ops supervisor (PG): auto-recovery detects AND recovers a stranded inbound and a missed follow-up in one run; a second run finds nothing to do', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    await env.pool.query(`alter table public.message_events add column if not exists sent_at timestamptz, add column if not exists metadata jsonb, add column if not exists queue_id text`)
    // a stranded inbound (persisted, no job) and a delivered anchor whose follow-up was never planned
    const sid = `SMs${crypto.randomUUID().slice(0, 8)}`
    await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id) values ($1, $2, 'inbound', '+13125550707', '+13125550707', $3, 'call me about it', now() - interval '20 minutes', now() - interval '20 minutes', 'p1')`, [crypto.randomUUID(), sid, OURS])
    const phone = '+13125550708'
    const anchor = await deliveredAnchor(env, phone)
    await env.pool.query(`update public.send_queue set queue_status = 'delivered', delivered_at = now() - interval '30 minutes' where provider_message_id = $1`, [anchor.sid])
    const source = createAutoRecoverySource({ supabase: env.sb, runtimeStore: createRuntimePgStore({ pool: env.db.api }), env: ENV })
    const run1 = await source.run()
    assert.equal(run1.inbound.enqueued, 1, JSON.stringify(run1))
    assert.equal(run1.followups.scheduled, 1, JSON.stringify(run1))
    assert.deepEqual(run1.unrecoverable, [])
    const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, autoRecovery: run1 })
    const c = ev.checks.find((x) => x.id === 'auto_recovery')
    assert.equal(c.status, 'ok')
    assert.equal(c.value.stranded_inbounds_recovered, 1)
    assert.equal(c.value.missed_followups_recovered, 1)
    assert.equal((await decideJobs(env)).length, 1)
    assert.equal((await followUpsOf(env, phone)).length, 1)
    const run2 = await source.run()
    assert.equal(run2.inbound.enqueued, 0)
    assert.equal((await decideJobs(env)).length, 1, 'idempotent')
    assert.equal((await followUpsOf(env, phone)).length, 1, 'idempotent')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
