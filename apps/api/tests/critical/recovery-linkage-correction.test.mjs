// 8.5.21-b — recovery → research + valuation linkage (an evidence-backed next action, never a send),
// misclassified counteroffers and failed automated replies, and the PROPOSED (dry-run, reversible,
// audited) state-correction plan for deals closed "dead" after a not-interested reply.
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConversationFacts } from '../../src/lib/agent/operations/conversation-facts.js'
import { classifyRecoveryCandidate } from '../../src/lib/agent/operations/recovery-classifier.js'
import { recoveryNextAction, recoveryLinkRequests, detectMisclassifiedCounteroffer } from '../../src/lib/agent/operations/recovery-linkage.js'
import { buildNotInterestedCorrectionPlan, renderCorrectionSql, CORRECTION_NEXT_ACTION } from '../../src/lib/agent/operations/dead-deal-correction.js'
import { createRecoverySweepHandler } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { RECOVERY_SWEEP_KIND } from '../../src/lib/agent/operations/operations-kinds.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { recoveryValuationCandidates } from '../../src/lib/agent/missions/valuation-refresh-handler.js'
import { buildValuationQueue } from '../../src/lib/domain/valuation-refresh/valuation-queue.js'
import { conv, waiting, uuid, T0, H, D, at } from '../helpers/operations-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const cls = (row) => classifyRecoveryCandidate(normalizeConversationFacts(row), { now: T0 })
const researchWorthy = (o = {}) => conv({ last_outbound_at: at(T0 - 20 * D), inbound_intents: ['seller_interested'], last_inbound_at: at(T0 - 21 * D), last_meaningful_at: at(T0 - 21 * D), ...o })
const closedNotInterested = (o = {}) => waiting({ opportunity_id: uuid(), opp_stage: 'closed', opp_status: 'dead', opp_stage_entered_at: at(T0 - 10 * D), opp_last_activity_at: at(T0 - 10 * D), last_meaningful_intent: 'not_interested', inbound_intents: ['not_interested'], last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D), ...o })

test('next action per class: evidence-backed, permission-aware, never a send', () => {
  const rw = cls(researchWorthy())
  assert.equal(rw.class, 'research_worthy')
  assert.deepEqual([recoveryNextAction({ ...rw, property_id: '2124415662' }).action, recoveryNextAction({ ...rw }).research], ['research_and_value_before_any_recontact', true])
  assert.equal(recoveryNextAction(cls(conv({ any_opt_out: true }))).action, 'none_suppressed_no_contact')
  assert.equal(recoveryNextAction(cls(waiting({ inbound_intents: ['wrong_number'] }))).action, 'none_wrong_number_no_owner_outreach')
  assert.equal(recoveryNextAction(cls(waiting({ inbound_intents: ['property_specific_non_owner'] }))).action, 'none_ownership_denied_for_this_property')
  assert.equal(recoveryNextAction(cls(closedNotInterested())).action, 'propose_state_correction_to_30_day_follow_up')
  const failedProvider = cls(waiting({ inbound_intents: ['seller_interested'], outbound_after_inbound: 1, failed_after_inbound: 1, delivered_after_inbound: 0 }))
  assert.equal(recoveryNextAction(failedProvider).action, 'human_review_failed_send_never_resend_automatically')
  for (const c of [rw, failedProvider, cls(conv({ any_opt_out: true }))]) assert.equal(recoveryNextAction(c).sends, 0)
})

test('linkage: research_worthy (+ viable human-review) conversations with a property feed property.research AND the valuation queue; suppressed / wrong-number never do', () => {
  const rows = [researchWorthy({ property_id: '1001' }), conv({ any_opt_out: true, property_id: '1002' }), waiting({ inbound_intents: ['wrong_number'], property_id: '1003' }), waiting({ inbound_intents: ['asks_offer'], last_meaningful_intent: 'asks_offer', property_id: '1004' })]
  const cands = rows.map((r) => { const f = normalizeConversationFacts(r); return { ...classifyRecoveryCandidate(f, { now: T0 }), property_id: f.property_id } })
  const links = recoveryLinkRequests(cands)
  assert.deepEqual(links.research.map((r) => [r.property_id, r.trigger]), [['1001', 'recovery_finding'], ['1004', 'recovery_finding']])
  assert.deepEqual(links.valuation.map((v) => [v.property_id, v.recovery_class]), [['1001', 'research_worthy'], ['1004', 'needs_human_review']])
  const q = buildValuationQueue(links.valuation, { now: T0 })
  assert.deepEqual(q.entries.map((e) => [e.property_id, e.class]), [['1001', 'recoverable_conversation'], ['1004', 'recoverable_conversation']])
})

test('recovery.sweep (runtime) → research enqueue (linkage) + recovery.linkage finding → valuation.refresh candidates; sends 0', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [RECOVERY_SWEEP_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const rows = [researchWorthy({ property_id: '2001', cursor_at: '2026-10-15 01:00:00.000001+00' }), conv({ any_opt_out: true, property_id: '2002', cursor_at: '2026-10-15 01:00:00.000002+00' })]
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const requested = []
  const handler = createRecoverySweepHandler({ source: createOperationsMemorySource({ conversations: rows }), store, now: () => t, linkage: { enqueueResearch: async (req) => { requested.push(req); return { ok: true, deduped: false } } } })
  await runtime.enqueue({ kind: RECOVERY_SWEEP_KIND, idempotency_key: 'c'.repeat(64), input: {}, requested_by: OP })
  await runRuntimeTick({ store: runtime, handlers: { [RECOVERY_SWEEP_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t })
  const job = [...runtime._state.jobs.values()][0]
  assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
  assert.deepEqual(requested.map((r) => [r.property_id, r.trigger]), [['2001', 'recovery_finding']])
  assert.deepEqual([job.result.research_requests.enqueued, job.result.valuation_requests, job.result.sends], [1, 1, 0])
  const fs = [...runtime._state.findings.values()]
  const cand = fs.find((f) => f.finding_type === 'recovery.candidate')
  assert.equal(cand.value.next_action.action, 'research_and_value_before_any_recontact')
  const link = fs.find((f) => f.finding_type === 'recovery.linkage')
  assert.ok(!JSON.stringify(link.value).includes('"2001"'), 'refs are encoded in findings')
  assert.deepEqual(await recoveryValuationCandidates(store), [{ property_id: '2001', recovery_class: 'research_worthy', status: 'recovery' }])
  // without linkage wiring the requests are counted as not configured — never silently dropped
  const h2 = createRecoverySweepHandler({ source: createOperationsMemorySource({ conversations: rows }), store, now: () => t })
  await runtime.enqueue({ kind: RECOVERY_SWEEP_KIND, idempotency_key: 'd'.repeat(64), input: {}, requested_by: OP })
  await runRuntimeTick({ store: runtime, handlers: { [RECOVERY_SWEEP_KIND]: h2 }, workerId: 'w', budgetMs: 20_000, now: () => t })
  const j2 = [...runtime._state.jobs.values()].find((j) => j.job_id !== job.job_id)
  assert.equal(j2.result.research_requests.refused.LINKAGE_NOT_CONFIGURED, 1)
})

test('misclassified counteroffer: a stated price on a thread that ended former_owner / unclear is flagged (ids only); a classified price is not', () => {
  const msgs = [
    { id: 'm1', direction: 'outbound', body: 'Would you sell 123 Example St?' },
    { id: 'm2', direction: 'inbound', body: "I'd take 185,000 for it", intent: 'unclear' },
  ]
  const r = detectMisclassifiedCounteroffer({ messages: msgs, final_intent: 'former_owner_respondent' })
  assert.deepEqual([r.misclassified, r.priced_messages, r.priced_messages_not_classified_as_price, r.message_ids, r.next_action], [true, 1, 1, ['m2'], 'operator_review_counteroffer_and_reclassify'])
  assert.ok(!JSON.stringify(r).includes('185'), 'no message text or amount leaves it')
  assert.equal(detectMisclassifiedCounteroffer({ messages: msgs, final_intent: 'asking_price_provided' }).misclassified, false)
  assert.equal(detectMisclassifiedCounteroffer({ messages: [{ id: 'm3', direction: 'inbound', body: 'built in 1985, 3 beds' }], final_intent: 'unclear' }).misclassified, false, 'a year / bed count is not a price')
})

test('failed automated replies are detected (provider-accepted vs internal) and never resent automatically', () => {
  const provider = cls(waiting({ inbound_intents: ['seller_interested'], outbound_after_inbound: 1, failed_after_inbound: 1, delivered_after_inbound: 0 }))
  const internal = cls(waiting({ inbound_intents: ['seller_interested'], failed_internal_after_inbound: 1 }))
  assert.ok(provider.detections.some((d) => d.code === 'failed_automated_response' && d.provider_accepted))
  assert.ok(internal.detections.some((d) => d.code === 'failed_automated_response' && d.internal_only))
  assert.equal(recoveryNextAction(internal).action, 'review_then_requeue_internal_failure_through_send_queue')
})

test('dead-deal correction: a PROPOSED DRY-RUN plan (ids + exact change) for "dead after not interested" only; permission blocks / reopened deals excluded; nothing applied', () => {
  const a = closedNotInterested({ seller_stage: 'offer_interest' })
  const b = closedNotInterested({ opp_stage: 'asking_price', last_meaningful_at: at(T0 - 40 * D), last_inbound_at: at(T0 - 40 * D) })
  const reopened = closedNotInterested({ last_meaningful_intent: 'asks_offer', inbound_intents: ['asks_offer'] })
  const suppressed = closedNotInterested({ any_opt_out: true })
  const facts = [a, b, reopened, suppressed].map(normalizeConversationFacts)
  const plan = buildNotInterestedCorrectionPlan(facts, { now: T0 })
  assert.equal(plan.status, 'PROPOSED_DRY_RUN_NOT_APPLIED')
  assert.equal(plan.count, 2)
  const [e1, e2] = plan.entries
  assert.deepEqual([e1.opportunity_id, e1.before.opportunity_status, e1.before.acquisition_stage], [a.opportunity_id, 'dead', 'closed'])
  assert.deepEqual([e1.after.opportunity_status, e1.after.acquisition_stage, e1.after.next_action], ['nurture', 'offer_interest', CORRECTION_NEXT_ACTION])
  assert.equal(e1.after.next_action_due, at(T0 - 2 * D + 30 * D), 'due 30 days after the not-interested reply')
  assert.deepEqual([e2.after.acquisition_stage, e2.due_now], ['asking_price', true], 'a non-closed stage is kept; a past due date is "now"')
  assert.equal(e1.followup_send, 'none_by_this_plan:follow_up_engine_inside_approved_program_only')
  assert.ok(e1.evidence_refs.some((r) => r.source === 'public.acquisition_opportunities'))
  const sql = renderCorrectionSql(plan, { tag: '20261016' })
  assert.match(sql.apply_sql, /v_commit boolean := false; -- DRY RUN/)
  assert.match(sql.apply_sql, /raise exception 'DRY RUN/)
  assert.match(sql.apply_sql, /o\.opportunity_status is not distinct from p\.from_status and o\.acquisition_stage is not distinct from p\.from_stage/, 'only rows still in their planned BEFORE state')
  assert.match(sql.apply_sql, /insert into public\._state_correction_not_interested_20261016 \(opportunity_id, before\)/, 'audited snapshot first')
  assert.match(sql.rollback_sql, /a\.applied_after is not null/)
  assert.ok(sql.apply_sql.includes(a.opportunity_id) && !sql.apply_sql.includes('+1'), 'ids only, no phone')
  assert.throws(() => renderCorrectionSql(plan, { tag: 'x' }))
})
