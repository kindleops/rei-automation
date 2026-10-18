// FOLLOW-UP EXECUTION LIFECYCLE — the state machine over in-memory fakes (P0 2026-10-17; supersedes the
// rc-8.5.21-A body-less design, whose PG proof could only ever produce a row the loader pauses).
// The disposable-PostgreSQL end-to-end proofs are tests/critical/followup-lifecycle-pg.test.mjs and
// tests/critical/followup-execution-8521-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  materializeClaimedIntent, runFollowUpMaterialization, planSendInstant, validateMaterializedBody, classifyGuardBlock, backoffMs,
  followUpKindFor, followUpIntentKey, evaluateFollowUpIntentRowGate, reconcileFollowUpLifecycle, planFollowUpFromScheduler, lifecycleLive,
  MATERIALIZE_CODES as M,
} from '../../src/lib/domain/followups/followup-lifecycle.js'
import {
  resolveFollowUpExecutionMode, followUpExecutionRequested, followUpIntentOf, encodeDispatchInput, decodeDispatchInput,
  runFollowUpSweep, runFollowUpDispatch, runFollowUpReconcile, FOLLOWUP_EXECUTION_MODE_KEY,
} from '../../src/lib/domain/followups/followup-execution.js'
import { buildFollowUpHandlers, followupRuntimeHandlers } from '../../src/lib/ai/followup-runtime-wiring.js'
import { evaluateReplyTiming } from '../../src/lib/domain/queue/reply-timing.js'

const NOON_CHI = '2026-10-20T17:00:00.000Z'
const lawful = (at, zones) => evaluateReplyTiming({ purpose: 'outreach', at, zones })
const SPEC = {
  thread_key: '+13125550101', to_phone_number: '+13125550101', from_phone_number: '+13125550199', property_id: 'p1', master_owner_id: 'm1',
  type: 'followup', message_type: 'followup', use_case_template: 'nurture_not_interested', language: 'English', seller_first_name: 'Dana',
  metadata: { intent: 'not_interested', source: 'seller_inbound_orchestrator', followup_reason: 'nurture_followup:not_interested' },
}
const intent = (o = {}) => ({ id: '11111111-1111-4111-8111-111111111111', intent_key: 'fi1.x', thread_key: SPEC.thread_key, property_id: 'p1', master_owner_id: 'm1', kind: 'not_interested_nurture', intent: 'not_interested',
  due_at: '2026-10-20T16:00:00.000Z', created_at: '2026-09-20T16:00:00.000Z', state: 'materializing', lease_token: 'tok', attempts: 1, materialize_seq: 1, row_spec: SPEC, ...o })

function fakes(o = {}) {
  const calls = { transitions: [], enqueued: [] }
  const deps = {
    now: () => NOON_CHI,
    readSwitch: async (k) => (k === FOLLOWUP_EXECUTION_MODE_KEY ? (o.mode === undefined ? 'live' : o.mode) : null),
    claim: async () => o.claimed || [intent()],
    transition: async (t) => { calls.transitions.push(t); return o.transitionResult || { ok: true } },
    loadThread: async () => ({ thread_key: SPEC.thread_key, is_suppressed: false, last_inbound_at: '2026-09-20T15:00:00.000Z', ...(o.thread || {}) }),
    holdCheck: async () => o.hold || { held: false },
    guard: async () => o.guard || { blocked: false },
    alreadySent: async () => o.alreadySent === true,
    languageFor: async () => 'English',
    templateCandidates: () => ['consider_selling_follow_up', 'not_ready'],
    templatesAvailable: async () => o.templatesAvailable ?? true,
    render: async () => o.render || { ok: true, resolved: true, message_body: 'Hi Dana, Helen here again. Any change of plans on 12 Oak St?', template_id: 't1', use_case: 'consider_selling_follow_up', language: 'English' },
    senderStatus: async () => o.senderStatus ?? 'active',
    propertyGeography: async () => ({ state: 'IL', zip: '60601' }),
    resolveRecipientTimezone: () => o.tz || { ok: true, iana: 'America/Chicago' },
    recipientZones: () => ['America/Chicago'],
    lawful,
    otherTexts: async () => o.others || [],
    validate: () => ({ ok: true }),
    enqueue: async (row) => { calls.enqueued.push(row); if (o.enqueueThrows) throw new Error(o.enqueueThrows); return o.enqueueResult || { ok: true, queue_row_id: 'q1' } },
    ...(o.deps || {}),
  }
  return { deps, calls }
}

test('born OFF: no mode key (or an invalid one) = off; no env flag = no handlers; off materializes and writes nothing', async () => {
  for (const raw of [undefined, null, '', 'garbage', 'LIVE!']) assert.equal(resolveFollowUpExecutionMode(raw), 'off')
  assert.equal(resolveFollowUpExecutionMode(' Live '), 'live')
  assert.equal(followUpExecutionRequested({}), false)
  assert.deepEqual(Object.keys(followupRuntimeHandlers({})), [])
  const { deps, calls } = fakes({ mode: null })
  assert.equal((await runFollowUpMaterialization(deps)).code, M.OFF)
  assert.equal((await runFollowUpSweep(deps)).code, 'FOLLOWUP_EXECUTION_OFF')
  assert.equal((await runFollowUpReconcile({ ...deps, loadReconcileSnapshot: async () => { throw new Error('must not read') } })).code, 'FOLLOWUP_EXECUTION_OFF')
  assert.deepEqual(calls.enqueued, [])
  assert.equal(await lifecycleLive({ readSwitch: async () => { throw new Error('unreadable') } }), false, 'an unreadable switch is OFF (legacy path)')
})

test('happy path: ONE nonempty, validated, send-ready row with template + intent identity; the intent is bound by the DB, not by a transition', async () => {
  const { deps, calls } = fakes()
  const r = await materializeClaimedIntent(intent(), deps)
  assert.equal(r.code, M.MATERIALIZED)
  assert.equal(calls.transitions.length, 0, 'the bind trigger moves the intent to ready inside the insert transaction')
  const [row] = calls.enqueued
  assert.ok(row.message_body.length > 10)
  assert.equal(row.queue_status, 'scheduled')
  assert.equal(row.template_source, 'sms_templates')
  assert.equal(row.template_id, 't1')
  assert.equal(row.queue_key, `fui:${intent().id}:m1`)
  assert.deepEqual([row.metadata.followup_intent_id, row.metadata.followup_materialize_token, row.metadata.deferred_message_resolution, row.metadata.follow_up_id],
    [intent().id, 'tok', false, `followup_intent:${intent().id}`])
  assert.equal(row.scheduled_for, NOON_CHI)
})

test('materialization refusals are explicit states with actionable reasons (never completed, never a row)', async () => {
  const cases = [
    [{ thread: { is_suppressed: true } }, 'not_executable', 'thread_suppressed'],
    [{ thread: { last_inbound_at: '2026-10-01T00:00:00.000Z' } }, 'superseded', 'superseded_by_newer_inbound'],
    [{ hold: { held: true, hold_type: 'permanent_exclusion', hold_ids: ['h'] } }, 'held', 'automation_hold:permanent_exclusion'],
    [{ hold: { held: true, fail_closed: true, hold_type: 'lookup_error', reason: 'x' } }, 'planned', /^hold_lookup_failed/],
    [{ guard: { blocked: true, reason: 'sms_suppression_list_active' } }, 'not_executable', 'send_time_guard:sms_suppression_list_active'],
    [{ guard: { blocked: true, reason: 'prior_reply_not_owner' } }, 'not_executable', 'send_time_guard:prior_reply_not_owner'],
    [{ guard: { blocked: true, reason: 'ownership_denial_property_unresolved' } }, 'held', 'send_time_guard:ownership_denial_property_unresolved'],
    [{ guard: { blocked: true, reason: 'automation_hold_active', detail: { hold_type: 'lookup_error' } } }, 'planned', 'send_time_guard:automation_hold_active'],
    [{ guard: { blocked: true, reason: 'send_time_guard_read_failed' } }, 'planned', 'send_time_guard:send_time_guard_read_failed'],
    [{ alreadySent: true }, 'superseded', 'already_sent_by_other_path'],
    [{ templatesAvailable: false }, 'not_executable', /^no_approved_template:/],
    [{ render: { ok: false, resolved: false, reason: 'no_renderable_followup_template' } }, 'not_executable', 'unfillable_placeholder'],
    [{ render: { ok: false, resolved: false, reason: 'template_lookup_failed' } }, 'planned', 'template_lookup_failed'],
    [{ render: { ok: true, resolved: true, message_body: 'Hi Dana {{property_address}} soon', template_id: 't' } }, 'not_executable', 'invalid_body:unfilled_placeholder'],
    [{ render: { ok: true, resolved: true, message_body: 'Hi Dana — checking back on 12 Oak St', template_id: 't' } }, 'not_executable', 'invalid_body:em_or_en_dash'],
    [{ tz: { ok: false } }, 'held', 'recipient_timezone_unresolved'],
    [{ enqueueResult: { ok: false, reason: 'phone_suppressed_21610' } }, 'not_executable', 'phone_suppressed_21610'],
    [{ enqueueResult: { ok: false, reason: 'automation_hold', blocked: true } }, 'held', 'automation_hold:enqueue_chokepoint'],
    [{ enqueueResult: { ok: false, reason: 'entity_name_in_greeting' } }, 'not_executable', 'outbound_validator:entity_name_in_greeting'],
    [{ enqueueThrows: 'connection reset' }, 'planned', /^enqueue_error:/],
  ]
  for (const [o, to, reason] of cases) {
    const { deps, calls } = fakes(o)
    const r = await materializeClaimedIntent(intent(), deps)
    const t = calls.transitions[0]
    assert.ok(t, `${JSON.stringify(o)} → a transition`)
    assert.equal(t.to, to, JSON.stringify(o))
    if (reason instanceof RegExp) assert.match(t.reason, reason); else assert.equal(t.reason, reason)
    if (to === 'planned') { assert.equal(r.code, M.RETRY); assert.ok(Date.parse(t.retry_at) > Date.parse(NOON_CHI), 'bounded backoff') }
    assert.ok(calls.enqueued.length <= 1)
  }
})

test('a write refused because the lease moved on (another worker / a dead worker) is LEASE_LOST, never a second row', async () => {
  const { deps } = fakes({ enqueueThrows: 'FOLLOWUP_INTENT: intent x is not materializing under this lease (state ready)' })
  assert.equal((await materializeClaimedIntent(intent(), deps)).code, M.LEASE_LOST)
  const { deps: d2 } = fakes({ guard: { blocked: true, reason: 'thread_suppressed' }, transitionResult: { ok: false, reason: 'lease_lost' } })
  assert.equal((await materializeClaimedIntent(intent(), d2)).code, M.LEASE_LOST)
})

test('lifecycle turned OFF mid-flight: the intent returns to planned without spending an attempt', async () => {
  let n = 0
  const { deps, calls } = fakes({ deps: { readSwitch: async () => (n++ === 0 ? 'live' : 'off') } })
  await runFollowUpMaterialization(deps)
  assert.deepEqual([calls.transitions[0].to, calls.transitions[0].reason, calls.transitions[0].refund], ['planned', 'deferred:lifecycle_off', true])
  assert.equal(calls.enqueued.length, 0)
})

test('contact window: 03:00 recipient-local ⇒ pinned to 08:00 local; ≤ 2 texts per rolling 24 h defers past the window', async () => {
  const at3 = '2026-10-20T08:00:00.000Z' // 03:00 CDT
  const { deps, calls } = fakes({ deps: { now: () => at3 } })
  await materializeClaimedIntent(intent({ due_at: '2026-10-20T07:00:00.000Z' }), deps)
  assert.equal(calls.enqueued[0].scheduled_for, '2026-10-20T13:00:00.000Z')
  const t1 = Date.parse(NOON_CHI) - 3 * 3_600_000; const t2 = Date.parse(NOON_CHI) - 3_600_000
  const p = planSendInstant({ due: Date.parse(NOON_CHI), now: Date.parse(NOON_CHI), zones: ['America/Chicago'], others: [t1, t2], lawful })
  assert.equal(p.ok, true)
  assert.ok(Date.parse(p.at) >= t1 + 24 * 3_600_000, p.at)
  assert.equal(planSendInstant({ due: Date.parse(NOON_CHI), now: Date.parse(NOON_CHI), zones: ['America/Chicago'], others: [t2], lawful }).at, NOON_CHI, 'one other text is fine')
})

test('body validation, guard classification, backoff, kinds, keys', () => {
  assert.equal(validateMaterializedBody('').reason, 'empty_body')
  assert.equal(validateMaterializedBody('Hi {{first_name}}, checking back').reason, 'unfilled_placeholder')
  assert.equal(validateMaterializedBody('Hi [[name]], checking back').reason, 'unfilled_placeholder')
  assert.equal(validateMaterializedBody('Hi Dana – checking back on 12 Oak St').reason, 'em_or_en_dash')
  assert.equal(validateMaterializedBody('x'.repeat(161 * 4)).reason, 'body_too_long')
  assert.equal(validateMaterializedBody('Hi Dana, checking back on 12 Oak St.').ok, true)
  assert.deepEqual(classifyGuardBlock('send_time_guard_read_failed'), { to: 'planned', transient: true })
  assert.deepEqual(classifyGuardBlock('automation_hold_active'), { to: 'held', transient: false })
  assert.deepEqual(classifyGuardBlock('wrong_number'), { to: 'not_executable', transient: false })
  assert.deepEqual([1, 2, 3, 10].map(backoffMs), [5 * 60_000, 10 * 60_000, 20 * 60_000, 6 * 3_600_000])
  assert.equal(followUpKindFor('not_interested'), 'not_interested_nurture')
  assert.equal(followUpKindFor('seller_callback'), 'seller_requested_callback')
  assert.equal(followUpKindFor('stage_no_reply', { no_response_followup: { kind: 's2_interest' } }), 'no_response_s2_interest')
  assert.equal(followUpKindFor('tenant_or_occupancy'), 'nurture_tenant_or_occupancy')
  const a = followUpIntentKey({ thread_key: 't', property_id: 'p', kind: 'k', due_at: NOON_CHI })
  assert.equal(a, followUpIntentKey({ thread_key: 't', property_id: 'p', kind: 'k', due_at: NOON_CHI }))
  assert.notEqual(a, followUpIntentKey({ thread_key: 't', property_id: 'p2', kind: 'k', due_at: NOON_CHI }))
  assert.equal(followUpIntentKey({ thread_key: 't', kind: 'k', due_at: NOON_CHI, cause: 'in1' }), followUpIntentKey({ thread_key: 't', kind: 'k', due_at: '2027-01-01T00:00:00Z', cause: 'in1' }), 'a replay of the same inbound collapses')
})

test('the scheduler path in lifecycle mode plans an intent from the would-be row (never a body-less row)', async () => {
  let plan = null
  const sb = { rpc: async (fn, args) => { plan = { fn, p: args.p }; return { data: { ok: true, replay: false, intent: { id: 'i1', state: 'planned', due_at: args.p.due_at } }, error: null } } }
  const r = await planFollowUpFromScheduler({ intent: 'not_interested', plan: { reason: 'nurture_followup:not_interested' }, payload: { ...SPEC, scheduled_for: NOON_CHI, queue_status: 'scheduled' }, context: { inbound_message_event_id: 'in1' }, supabase: sb })
  assert.deepEqual([r.ok, r.lifecycle, r.queue_row_id, r.followup_intent_id], [true, true, null, 'i1'])
  assert.equal(plan.fn, 'followup_intent_plan')
  assert.equal(plan.p.kind, 'not_interested_nurture')
  assert.equal(plan.p.row_spec.use_case_template, 'nurture_not_interested')
  const failed = await planFollowUpFromScheduler({ intent: 'not_interested', payload: { ...SPEC, scheduled_for: NOON_CHI }, supabase: { rpc: async () => ({ data: null, error: { message: 'down' } }) } })
  assert.deepEqual([failed.ok, failed.reason], [false, 'followup_intent_plan_failed'], 'a failed plan is an explicit failure, never a silent success')
})

test('dispatch gate: proceed only for a ready intent bound to THIS row with an approved template; otherwise cancel / hold / re-materialize / defer', async () => {
  const row = { id: 'q1', template_id: 't1', message_body: 'Hi Dana, checking back.', to_phone_number: SPEC.thread_key, metadata: { followup_intent_id: 'i1' } }
  const seen = {}
  const base = (o = {}) => ({
    now: () => NOON_CHI,
    loadIntent: async () => ({ id: 'i1', state: 'ready', send_queue_id: 'q1', thread_key: SPEC.thread_key, kind: 'not_interested_nurture', created_at: '2026-09-20T00:00:00Z', ...(o.intent || {}) }),
    loadThread: async () => ({ last_inbound_at: '2026-09-19T00:00:00Z', ...(o.thread || {}) }),
    templateApproved: async () => o.approved ?? true,
    rematerialize: async (a) => { seen.re = a; return { ok: true } },
    closeIntents: async (a) => { seen.closed = a; return { ok: true } },
    sentTexts: async () => o.sent || [],
    holdCheck: async () => o.hold || { held: false },
  })
  assert.deepEqual(await evaluateFollowUpIntentRowGate({ id: 'x', metadata: {} }, base()), { applies: false, action: 'proceed', reason: null })
  assert.equal((await evaluateFollowUpIntentRowGate(row, base())).action, 'proceed')
  assert.equal((await evaluateFollowUpIntentRowGate(row, base({ intent: { state: 'cancelled' } }))).reason, 'followup_intent_cancelled')
  assert.equal((await evaluateFollowUpIntentRowGate(row, base({ intent: { send_queue_id: 'other' } }))).reason, 'followup_intent_not_bound_to_row')
  assert.equal((await evaluateFollowUpIntentRowGate({ ...row, message_body: ' ' }, base())).reason, 'empty_message_body')
  assert.equal((await evaluateFollowUpIntentRowGate(row, base({ thread: { last_inbound_at: '2026-10-19T00:00:00Z' } }))).reason, 'superseded_by_newer_inbound')
  assert.equal(seen.closed.state, 'superseded')
  const rev = await evaluateFollowUpIntentRowGate(row, base({ approved: false }))
  assert.deepEqual([rev.action, rev.reason, rev.rematerialized], ['cancel', 'template_revoked_rematerialize', true])
  assert.deepEqual(seen.re, { id: 'i1', send_queue_id: 'q1', reason: 'template_revoked_rematerialize' })
  const h = await evaluateFollowUpIntentRowGate(row, base({ hold: { held: true, hold_type: 'permanent_exclusion' } }))
  assert.deepEqual([h.action, h.reason], ['hold', 'automation_hold:permanent_exclusion'])
  const c = await evaluateFollowUpIntentRowGate(row, base({ sent: [Date.parse(NOON_CHI) - 3_600_000, Date.parse(NOON_CHI) - 7_200_000] }))
  assert.equal(c.action, 'defer')
  assert.equal(c.defer_until, new Date(Date.parse(NOON_CHI) - 7_200_000 + 24 * 3_600_000 + 60_000).toISOString())
})

test('reconcile (two-way, pure): ready without a live row, orphan rows, legacy body-less rows, unbacked and mis-projected follow_up_at, missing reasons', () => {
  const now = Date.parse(NOON_CHI)
  const r = reconcileFollowUpLifecycle({
    now,
    intents: [
      { id: 'a', state: 'ready', send_queue_id: 'q-gone', thread_key: 't1', due_at: NOON_CHI },
      { id: 'b', state: 'ready', send_queue_id: 'q-sent', thread_key: 't2', due_at: NOON_CHI },
      { id: 'c', state: 'planned', thread_key: 't3', due_at: '2026-10-01T00:00:00Z' },
      { id: 'd', state: 'held', reason: '', thread_key: 't4', due_at: NOON_CHI },
      { id: 'e', state: 'planned', thread_key: 't5', due_at: '2026-10-25T00:00:00Z' },
    ],
    rows: [
      { id: 'q-sent', type: 'followup', queue_status: 'sent', sent_at: NOON_CHI, metadata: { followup_intent_id: 'b' } },
      { id: 'q-orphan', type: 'followup', queue_status: 'scheduled', message_body: 'x', metadata: { followup_intent_id: 'zzz' } },
      { id: 'q-legacy', type: 'followup', queue_status: 'scheduled', message_body: '', metadata: { deferred_message_resolution: true } },
    ],
    threads: [{ thread_key: 't9', follow_up_at: NOON_CHI }, { thread_key: 't5', follow_up_at: '2026-10-30T00:00:00Z' }],
  })
  assert.deepEqual(r.ready_without_row, ['a'])
  assert.deepEqual(r.ready_row_not_live, ['b'])
  assert.deepEqual(r.planned_overdue, ['c'])
  assert.deepEqual(r.no_reason, ['d'])
  assert.deepEqual(r.orphan_rows, ['q-orphan'])
  assert.deepEqual(r.legacy_deferred_rows, ['q-legacy'])
  assert.deepEqual(r.unbacked_follow_up_at, ['t9'])
  assert.deepEqual(r.projection_mismatch, ['t5'])
})

test('reconcile job: REPORT-ONLY by default; apply (live only) adopts legacy rows / bare dates and retries ONLY failed_before_accept, once', async () => {
  const snap = {
    intents: [
      { id: 'f1', state: 'failed', outcome: 'failed_before_accept', row_spec: {}, thread_key: 't1' },
      { id: 'f2', state: 'failed', outcome: 'failed_ambiguous', row_spec: {}, thread_key: 't2' },
      { id: 'f3', state: 'failed', outcome: 'failed_after_accept', row_spec: {}, thread_key: 't3' },
      { id: 'f4', state: 'failed', outcome: 'failed_before_accept', row_spec: { reconcile_retries: 1 }, thread_key: 't4' },
    ],
    rows: [{ id: 'q-legacy', type: 'followup', queue_status: 'scheduled', message_body: '', metadata: { deferred_message_resolution: true, intent: 'not_interested' } }],
    threads: [{ thread_key: 't9', follow_up_at: NOON_CHI, disposition: 'not_interested' }],
  }
  const seen = { adopt: 0, bare: 0, retry: [] }
  const deps = {
    readSwitch: async () => 'live', now: () => NOON_CHI, loadReconcileSnapshot: async () => snap,
    adoptLegacyRow: async () => { seen.adopt += 1; return true }, adoptBareDate: async () => { seen.bare += 1; return true }, requeueFailed: async (i) => { seen.retry.push(i.id); return true },
  }
  const report = await runFollowUpReconcile(deps)
  assert.equal(report.applied, false)
  assert.deepEqual([seen.adopt, seen.bare, seen.retry.length], [0, 0, 0], 'report-only by default')
  assert.equal(report.counts.legacy_deferred_rows, 1)
  assert.equal(report.counts.unbacked_follow_up_at, 1)
  assert.ok(!JSON.stringify(report).includes('q-legacy') && !JSON.stringify(report).includes('t9'), 'refs are encoded')
  const applied = await runFollowUpReconcile(deps, { apply: true })
  assert.equal(applied.applied, true)
  assert.deepEqual([seen.adopt, seen.bare, seen.retry], [1, 1, ['f1']])
  const dry = await runFollowUpReconcile({ ...deps, readSwitch: async () => 'dry_run' }, { apply: true })
  assert.equal(dry.applied, false, 'apply needs live')
})

test('legacy follow_up_at → scheduler intent (reconcile adoption only): kinds; terminal / suppressed / unknown-stage dates are never adopted', () => {
  const at = NOON_CHI
  assert.equal(followUpIntentOf({ follow_up_at: at, disposition: 'not_interested' }).intent, 'not_interested')
  assert.equal(followUpIntentOf({ follow_up_at: at, disposition: 'need_time' }).intent, 'seller_callback')
  assert.equal(followUpIntentOf({ follow_up_at: at, stage: 'offer_interest' }).use_case, 'consider_selling_follow_up')
  assert.equal(followUpIntentOf({ follow_up_at: at, disposition: 'opt_out' }).skip, 'terminal_disposition')
  assert.equal(followUpIntentOf({ follow_up_at: at, is_suppressed: true }).skip, 'thread_suppressed')
  assert.equal(followUpIntentOf({ follow_up_at: at, stage: 'weird' }).skip, 'stage_use_case_unknown')
  assert.equal(followUpIntentOf({ disposition: 'not_interested' }).skip, 'no_follow_up_at')
})

test('runtime input carries identifiers only (letter-encoded) and round-trips; tampering is refused; handlers report codes', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const enc = encodeDispatchInput({ intent_id: id })
  assert.ok(!JSON.stringify(enc).includes(id))
  assert.deepEqual(decodeDispatchInput(enc), { intent_id: id })
  assert.equal(decodeDispatchInput({ intent_ref: 'zz' }), null)
  assert.equal(decodeDispatchInput({}), null)
  const { deps } = fakes({ claimed: [] })
  const handlers = buildFollowUpHandlers({ deps: { ...deps } })
  const ctx = (input) => ({ job: { job_id: 'j', input }, step: async () => {} })
  assert.deepEqual((await handlers['followup.dispatch'].run(ctx({ intent_ref: 'zz' }))).result, { code: 'FOLLOWUP_INPUT_INVALID' })
  assert.equal((await handlers['followup.dispatch'].run(ctx(enc))).result.code, 'NOTHING_CLAIMABLE')
  assert.equal((await handlers['followup.execution_sweep'].run(ctx({}))).result.code, 'SWEPT')
  assert.equal((await runFollowUpDispatch({ intent_id: id }, { ...deps, readSwitch: async () => 'dry_run' })).code, 'DRY_RUN_REPORT')
})

test('ops supervisor: the follow-up lifecycle check — unavailable when unread, warn on stuck intents, CRITICAL escalation (no re-send) on a possibly-delivered failure', async () => {
  const { evaluateSupervisor } = await import('../../src/lib/agent/operations/supervisor-checks.js')
  const pick = (ev) => ev.checks.find((c) => c.id === 'followup_lifecycle')
  assert.equal(pick(evaluateSupervisor({ snapshot: { unavailable: 'X' } })).status, 'unavailable')
  const zero = { scheduled_executable: 3, planned_overdue: 0, materializing_stale: 0, ready_overdue: 0, dispatched_stale: 0, accepted_unconfirmed: 0, failed: 0, failed_after_accept: 0, failed_ambiguous: 0, held: 2, not_executable: 1 }
  assert.equal(pick(evaluateSupervisor({ snapshot: { unavailable: 'X' }, followups: zero })).status, 'ok')
  const stuck = evaluateSupervisor({ snapshot: { unavailable: 'X' }, followups: { ...zero, planned_overdue: 2 } })
  assert.equal(pick(stuck).status, 'warn')
  assert.ok(stuck.issues.some((i) => i.dedupe_key === 'supervisor:followup_stuck' && i.recoverable))
  const review = evaluateSupervisor({ snapshot: { unavailable: 'X' }, followups: { ...zero, failed: 1, failed_ambiguous: 1 } })
  assert.equal(pick(review).status, 'critical')
  const esc = review.issues.find((i) => i.dedupe_key === 'supervisor:followup_review')
  assert.deepEqual([esc.escalate, esc.remediation.retry_safe], [true, false])
})

test('owner rules 2026-10-17: propertyContactBlock — declined-unverified and a recorded denial block THIS property only; never contact-wide; never labelled non-ownership', async () => {
  const { propertyContactBlock, OWNERSHIP_DECLINED_UNVERIFIED: D } = await import('../../src/lib/domain/followups/followup-lifecycle.js')
  const phone = '+13125550101'
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, thread: { disposition: D, property_id: 'p1' } }).reason, `${D}:no_recontact_hold`)
  assert.equal(propertyContactBlock({ property_id: 'p2', phone, thread: { disposition: D, property_id: 'p1' } }).blocked, false, 'another property of the same contact')
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, thread: { last_intent: D } }).blocked, true, 'thread property unknown: conservatively held')
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, resolutions: [{ property_id: 'p1', contact_phone_e164: phone, contact_property_role: D }] }).kind, D)
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, resolutions: [{ property_id: 'p1', contact_phone_e164: phone, contact_property_role: 'not_owner', rejected_at: '2026-10-01' }] }).kind, 'property_denial')
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, resolutions: [{ property_id: 'p1', contact_phone_e164: '+13125559999', contact_property_role: 'not_owner', rejected_at: '2026-10-01' }] }).blocked, false, 'another contact')
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, thread: { disposition: 'not_interested', property_id: 'p1' } }).blocked, false, '"No" to selling is the nurture')
  for (const o of [{ thread: { disposition: D, property_id: 'p1' } }, { resolutions: [{ property_id: 'p1', contact_phone_e164: phone, rejection_reason: D }] }]) {
    assert.ok(!/not_owner|non_owner|denial/.test(propertyContactBlock({ property_id: 'p1', phone, ...o }).reason))
  }
  // materialization blocks it like a denial
  assert.equal(propertyContactBlock({ property_id: 'p1', phone, resolutions: [{ property_id: 'p1', contact_phone_e164: phone, contact_property_role: D, rejected_at: null, suppression_scope: 'contact_property_pair' }] }).state, 'held', 'the rc-8.5.21 resolution row (rejected_at NULL) blocks: HELD')
  const { deps, calls } = fakes({ deps: { propertyBlock: async () => ({ blocked: true, reason: `${D}:no_recontact_hold`, state: 'held' }) } })
  await materializeClaimedIntent(intent(), deps)
  assert.deepEqual([calls.transitions[0].to, calls.transitions[0].reason, calls.enqueued.length], ['held', `${D}:no_recontact_hold`, 0])
  // the send-time guard's deferral for the same state is a HOLD, never a terminal / not_owner record
  const g = fakes({ guard: { blocked: true, reason: 'ownership_declined_unverified_hold' } })
  await materializeClaimedIntent(intent(), g.deps)
  assert.deepEqual([g.calls.transitions[0].to, g.calls.transitions[0].reason], ['held', 'send_time_guard:ownership_declined_unverified_hold'])
})

test('owner 2026-10-17: the previous question decides — "No" / "Not interested" to OWNERSHIP is never a disinterest nurture (bare No ⇒ property denial; polite / not interested ⇒ declined-unverified HELD); to SELLING it is the nurture', async () => {
  const { propertyContactBlock, latestReplyAnsweredOwnershipQuestion } = await import('../../src/lib/domain/followups/followup-lifecycle.js')
  const OWN = { direction: 'outbound', message_body: 'Hi Dana, do you still own 12 Oak St?', created_at: '2026-10-01T00:00:00Z' }
  const SELL = { direction: 'outbound', message_body: 'Would you consider selling 12 Oak St?', created_at: '2026-10-01T00:00:00Z' }
  const r = (b, t = '2026-10-01T00:01:00Z') => ({ direction: 'inbound', message_body: b, created_at: t })
  const k = 'not_interested_nurture'
  assert.deepEqual(propertyContactBlock({ property_id: 'p1', kind: k, messages: [OWN, r('No')] }).state, 'not_executable')
  assert.equal(propertyContactBlock({ property_id: 'p1', kind: k, messages: [OWN, r('No'), r('No', '2026-10-01T00:02:00Z')] }).reason, 'property_denial:bare_no_to_ownership_question', 'the burst')
  for (const b of ['No thanks', 'Not interested']) {
    const v = propertyContactBlock({ property_id: 'p1', kind: k, messages: [OWN, r(b)] })
    assert.deepEqual([v.state, v.kind], ['held', 'ownership_declined_unverified'], b)
  }
  for (const b of ['No', 'Not interested', 'No thanks']) assert.equal(propertyContactBlock({ property_id: 'p1', kind: k, messages: [SELL, r(b)] }).blocked, false, `selling: ${b}`)
  assert.equal(propertyContactBlock({ property_id: 'p1', kind: 'seller_requested_callback', messages: [OWN, r('Not interested')] }).blocked, false, 'only a disinterest nurture is re-read')
  assert.equal(propertyContactBlock({ property_id: 'p1', thread: { disposition: 'declined_unverified', property_id: 'p1' } }).state, 'held', 'the distinct disposition')
  assert.equal(latestReplyAnsweredOwnershipQuestion([r('No')]), false)
})

test('legacy adoption fails CLOSED: declined_unverified (either spelling) and any UNKNOWN disposition never fall through to a stage-silence follow-up (no ownership re-ask); the reconcile records them visibly', async () => {
  const at = NOON_CHI
  for (const d of ['declined_unverified', 'ownership_declined_unverified']) {
    const i = followUpIntentOf({ follow_up_at: at, disposition: d, stage: 'ownership_confirmation' })
    assert.deepEqual([i.kind, i.skip], [null, 'ownership_declined_unverified_hold'], d)
  }
  const u = followUpIntentOf({ follow_up_at: at, disposition: 'some_new_label', stage: 'ownership_confirmation' })
  assert.equal(u.kind, null)
  assert.match(u.skip, /^disposition_not_followup_eligible:/)
  assert.equal(followUpIntentOf({ follow_up_at: at, disposition: null, stage: 'ownership_confirmation' }).kind, 'stage_silence', 'no disposition: the stage follow-up as before')
  assert.equal(followUpIntentOf({ follow_up_at: at, disposition: 'interested', stage: 'offer_interest' }).use_case, 'consider_selling_follow_up')
  const recorded = []
  const deps = {
    readSwitch: async () => 'live', now: () => NOON_CHI,
    loadReconcileSnapshot: async () => ({ intents: [], rows: [], threads: [{ thread_key: 't1', follow_up_at: at, disposition: 'declined_unverified' }, { thread_key: 't2', follow_up_at: at, disposition: 'mystery' }] }),
    adoptBareDate: async () => { throw new Error('must never adopt') }, adoptLegacyRow: async () => false, requeueFailed: async () => false,
    recordUnadoptableDate: async (t, skip) => { recorded.push([t.thread_key, skip]); return true },
  }
  const r = await runFollowUpReconcile(deps, { apply: true })
  assert.equal(r.counts.recorded_not_executable, 2)
  assert.deepEqual(recorded.map((x) => x[0]), ['t1', 't2'])
  assert.equal(recorded[0][1], 'ownership_declined_unverified_hold')
})
