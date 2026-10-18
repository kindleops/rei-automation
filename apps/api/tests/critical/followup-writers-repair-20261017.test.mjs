// P0 2026-10-17 — the seven follow-up writers (W1–W7, followup-reconciliation.md §3) each either create a
// durable intent through the ONE lifecycle API or record a documented non-executable / held outcome while
// system_control.followup_execution_mode = live; with the mode absent every writer is byte-for-byte the
// old behaviour (born OFF). W3 (the 53-cancel race) has its own regression suite in
// not-interested-nurture-stored-rule-20261007.test.mjs; the DB-level guarantees in followup-lifecycle-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { buildSellerFlowDecision, decisionToUniversalLeadStatePatch } from '../../src/lib/domain/seller-flow/seller-flow-decision-contract.js'
import { transitionNurtureFollowUpIntent } from '../../src/lib/domain/seller-flow/process-seller-inbound-message.js'
import { applyNewRepliesCleanupPlan } from '../../src/lib/domain/inbox/new-replies-cleanup-apply.js'
import { createBulkLeadStateService, parseBulkLeadStateRequest } from '../../src/lib/domain/lead-state/bulk-lead-state-service.js'
import { scheduleFollowUp } from '../../src/lib/domain/seller-flow/seller-followup-scheduler.js'

const src = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

test('W1: in lifecycle mode the decision state patch never writes follow_up_at (the projection owns it); legacy unchanged', () => {
  const transition = { follow_up: { create: true, due_at: '2026-11-16T00:00:00.000Z' } }
  const legacy = buildSellerFlowDecision({ transition })
  assert.equal(legacy.follow_up_at, '2026-11-16T00:00:00.000Z')
  assert.equal(decisionToUniversalLeadStatePatch(legacy).follow_up_at, '2026-11-16T00:00:00.000Z', 'OFF: the old plan date, as before')
  const live = buildSellerFlowDecision({ transition, follow_up: { ok: true, lifecycle: true, scheduled_for: '2026-11-16T00:00:00.000Z' }, follow_up_lifecycle: true })
  assert.equal(live.follow_up_at, '2026-11-16T00:00:00.000Z', 'the date the intent actually holds')
  assert.equal('follow_up_at' in decisionToUniversalLeadStatePatch(live), false)
  const unplanned = buildSellerFlowDecision({ transition, follow_up: { ok: false, skipped: true }, follow_up_lifecycle: true })
  assert.equal(unplanned.follow_up_at, null, 'a plan with no intent is never a date')
  // the ownership-probe patch path is gated too
  assert.match(src('src/lib/domain/seller-flow/process-seller-inbound-message.js'), /if \(!followup_lifecycle_live\) patch\.follow_up_at = contract\.ownership_probe_transition\.follow_up_at/)
})

test('W2: a deal-nurture transition whose deferred follow-up was skipped (an immediate reply was queued) gets an intent pinned to its own due date', () => {
  assert.equal(transitionNurtureFollowUpIntent({ reasoning_code: 'S1_NEED_TIME_NURTURE_30D' }), 'seller_callback')
  assert.equal(transitionNurtureFollowUpIntent({ reasoning_code: 'S4_TENANT_OCCUPIED_NURTURE_21D' }), 'tenant_or_occupancy')
  assert.equal(transitionNurtureFollowUpIntent({ reasoning_code: 'S2_NOT_INTERESTED_NURTURE_30D' }), 'not_interested')
  assert.equal(transitionNurtureFollowUpIntent({ reasoning_code: 'S1_LISTED_OR_UNAVAILABLE_NURTURE_45D' }), 'listed_or_unavailable')
  assert.equal(transitionNurtureFollowUpIntent({ reasoning_code: 'S3_SOMETHING_ELSE' }), null)
  const s = src('src/lib/domain/seller-flow/process-seller-inbound-message.js')
  const i = s.indexOf('// W2 (P0 2026-10-17): a deal-nurture transition')
  const block = s.slice(i, i + 3000)
  assert.match(block, /followup_lifecycle_live &&\s+!should_schedule_followup &&\s+!decline_no_followup &&\s+transition_follow_up\?\.create === true/)
  assert.match(block, /scheduled_for_at: transition_follow_up\.due_at/)
  assert.match(block, /recordNonExecutableFollowUp\(/, 'an unmapped kind is a documented non-executable outcome')
})

test('the canonical writer (scheduleFollowUp, every caller incl. W3 schedule_follow_up, W4, W6, workflows, no-response) plans an intent in live mode and writes NO row; OFF = the legacy row', async () => {
  const rpcs = []; const inserts = []
  const sb = (mode) => ({
    from(t) {
      const b = { select() { return b }, eq() { return b }, in() { return b }, limit() { return b }, order() { return b }, maybeSingle: async () => ({ data: t === 'system_control' ? (mode ? { value: mode } : null) : null, error: null }),
        insert(row) { inserts.push({ t, row }); return { select: () => ({ maybeSingle: async () => ({ data: { id: 'q-legacy', ...row }, error: null }) }) } },
        then: (res) => res({ data: [], error: null }) }
      return b
    },
    rpc: async (fn, args) => { rpcs.push({ fn, args }); return { data: { ok: true, replay: false, intent: { id: 'i1', state: 'planned', due_at: args.p.due_at } }, error: null } },
  })
  const ctx = { source: 'automation_action', master_owner_id: 'm1', property_id: 'p1', skip_email_lane: true, skip_render_context: true, language: 'English', seller_first_name: 'Dana', property_address: '12 Oak St', from_phone_number: '+13125550199', agent_name: 'Helen' }
  const live = await scheduleFollowUp('not_interested', '+13125550101', ctx, sb('live'))
  assert.deepEqual([live.ok, live.lifecycle, live.followup_intent_id], [true, true, 'i1'])
  assert.equal(rpcs.length, 1)
  assert.equal(inserts.filter((x) => x.t === 'send_queue').length, 0, 'no body-less row in lifecycle mode')
  const off = await scheduleFollowUp('not_interested', '+13125550101', ctx, sb(null))
  assert.equal(off.lifecycle, undefined)
})

test('W4: the cleanup never writes a bare nurture date in lifecycle mode; a vendor-DNC hold is a HELD intent with its reason', async () => {
  const patches = []; const planned = []
  const deps = (live) => ({
    cohort: { thread_keys: new Set(['+13125550101']) }, supabase: {}, now: '2026-10-17T12:00:00.000Z',
    followUpLifecycleLive: async () => live,
    patchUniversalLeadState: async (a) => { patches.push(a.patch); return { ok: true } },
    loadVendorDnc: async () => ({ dnc: null, basis: 'unconfirmed' }),
    planFollowUpIntent: async (input) => { planned.push(input); return { ok: true, intent: { id: 'i9' } } },
    scheduleFollowUp: async () => { throw new Error('must not schedule while held') },
  })
  const thread = { thread_key: '+13125550101', id: 't1', property_id: 'p1', master_owner_id: 'm1' }
  const res = await applyNewRepliesCleanupPlan({ category: 'nurture', apply: ['set_not_interested_nurture', 'schedule_nurture_followup'] }, { thread }, deps(true))
  assert.equal('follow_up_at' in patches[0], false)
  assert.equal(planned.length, 1)
  assert.deepEqual([planned[0].state, planned[0].kind], ['held', 'not_interested_nurture'])
  assert.match(planned[0].reason, /^cleanup_hold:/)
  assert.ok(res.steps.some((s) => s.held === true))
  patches.length = 0; planned.length = 0
  await applyNewRepliesCleanupPlan({ category: 'nurture', apply: ['set_not_interested_nurture', 'schedule_nurture_followup'] }, { thread }, deps(false))
  assert.ok(patches[0].follow_up_at, 'OFF: unchanged legacy behaviour')
  assert.equal(planned.length, 0)
})

test('W5: the applied hygiene SQL can never run again once the lifecycle exists (it wrote bare nurture dates)', () => {
  const sql = src('../../supabase/migrations/PROPOSED_20261010130000_inbox_pipeline_hygiene_cleanup.sql')
  const guard = sql.indexOf("IF to_regclass('public.followup_intents') IS NOT NULL THEN")
  assert.ok(guard > 0 && guard < sql.indexOf('UPDATE inbox_thread_state'), 'the guard precedes every write')
})

test('W6: the rc71 re-arm moves follow_up_at WITH the row it re-armed (legacy), or relies on the intent projection (live)', () => {
  const s = src('scripts/repair-not-interested-nurture.mjs')
  assert.match(s, /if \(out\.follow_up\?\.ok && !out\.follow_up\.lifecycle && out\.follow_up\.scheduled_for\)/)
  assert.match(s, /update\(\{ follow_up_at: out\.follow_up\.scheduled_for/)
})

test('W7: an operator bulk follow-up date is a durable HELD operator_reminder (no automated message) in lifecycle mode; OFF unchanged', async () => {
  const calls = { patch: [], plan: [] }
  const ports = (live) => ({
    followUpLifecycleLive: async () => live,
    planFollowUpIntent: async (i) => { calls.plan.push(i); return { ok: true, intent: { id: 'i7' } } },
    patchLeadState: async (a) => { calls.patch.push(a.patch); return { ok: true } },
  })
  const parsed = parseBulkLeadStateRequest({ action: 'follow_up', ids: ['+13125550101'], value: new Date(Date.now() + 86_400_000).toISOString() })
  const out = await createBulkLeadStateService(ports(true)).run(parsed, 'op-1')
  assert.equal(out.summary.changed, 1)
  assert.equal(calls.patch.length, 0, 'never a bare follow_up_at')
  assert.deepEqual([calls.plan[0].kind, calls.plan[0].state, calls.plan[0].reason], ['operator_reminder', 'held', 'operator_reminder_no_automated_message'])
  await createBulkLeadStateService(ports(false)).run(parsed, 'op-1')
  assert.ok(calls.patch[0].follow_up_at, 'OFF: the old patch')
})

test('cancellation from ANY path reconciles the intent: the scheduler cancel (:607) goes through cancelSupabasePendingOutbound, which closes the thread intents; the DB trigger closes bound rows', () => {
  const sched = src('src/lib/domain/seller-flow/seller-followup-scheduler.js')
  assert.match(sched, /export async function cancelPendingFollowUpsForThread[\s\S]*cancelSupabasePendingOutbound\(/)
  const cancel = src('src/lib/domain/queue/cancel-supabase-pending-outbound.js')
  assert.match(cancel, /closeLifecycleIntents\(\{/)
  assert.match(cancel, /state: compliance \? "cancelled" : "superseded"/)
  const sql = src('../../supabase/migrations/PROPOSED_20261017120000_followup_intent_lifecycle.sql')
  assert.match(sql, /create trigger zz_followup_intent_sync after update of queue_status/)
})
