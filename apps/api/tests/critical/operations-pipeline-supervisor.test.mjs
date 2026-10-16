// 8.5.20 part C — pipeline reconciliation (projection checks → findings + PENDING stage-change
// approvals, never a direct write) and the operations supervisor (deterministic checks,
// unavailable ≠ ok, retry safety, remediation + escalation work items, $0).
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeOpportunityFacts, reconcileOpportunity, projectedStage } from '../../src/lib/agent/operations/pipeline-reconciler.js'
import { evaluateSupervisor } from '../../src/lib/agent/operations/supervisor-checks.js'
import { createPipelineReconcileHandler, createOpsSupervisorHandler } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { PIPELINE_RECONCILE_KIND, OPS_SUPERVISOR_KIND } from '../../src/lib/agent/operations/operations-kinds.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads } from '../../src/lib/agent/missions/mission-reads.js'
import { makePlane, makeWorld, OPP_ID, OP, ENV as CAP_ENV } from '../helpers/agent-capabilities-fake.mjs'
import { opp, snapshot, health, uuid, T0, H, D, at } from '../helpers/operations-fixtures.mjs'

const rec = (o) => reconcileOpportunity(normalizeOpportunityFacts(opp(o)), { now: T0 })
const codes = (r) => r.issues.map((i) => i.code).sort()

test('pipeline: a consistent, owned opportunity passes every check', () => {
  const r = rec({})
  assert.equal(r.ok, true, JSON.stringify(r.issues))
  assert.equal(r.proposal, null)
})

test('pipeline projection: offer without a valid offer event and contract stages without a live closing case → critical + a proposed move to the supported stage', () => {
  const offer = rec({ acquisition_stage: 'offer' })
  assert.ok(codes(offer).includes('stage_not_projection_consistent'))
  assert.deepEqual([offer.proposal.to_stage, offer.issues.find((i) => i.code === 'stage_not_projection_consistent').detail.rule], ['property_condition', 'OFFER_EVENT_REQUIRED'])
  // a parsed figure is not an offer event: a row without source / engine version fails validateOfferEvent
  const parsed = rec({ acquisition_stage: 'offer', offer_rows: [{ offer_id: uuid(), status: 'sent', sent_at: at(T0 - D), purchase_price: 4100, offer_event: {} }] })
  assert.equal(parsed.proposal?.to_stage, 'property_condition')
  // a recorded engine offer event (plausible, within the authority) makes "offer" consistent
  const engineOffer = { offer_id: uuid(), status: 'sent', sent_at: at(T0 - D), purchase_price: 150000, policy_version: 'ade.v3', valuation_mid: 240000, authorized_ceiling: 170000, offer_event: { source: 'engine', engine_version: 'ade.v3', quote_type: 'FORMAL_OFFER' } }
  assert.equal(projectedStage(normalizeOpportunityFacts(opp({ acquisition_stage: 'offer', offer_rows: [engineOffer] }))).consistent, true)
  assert.ok(!codes(rec({ acquisition_stage: 'offer', offer_rows: [engineOffer] })).includes('stage_not_projection_consistent'))
  const contract = rec({ acquisition_stage: 'under_contract' })
  assert.deepEqual([contract.proposal.to_stage, contract.issues[0].detail.rule], ['property_condition', 'CONTRACT_EVENT_REQUIRED'])
  assert.equal(rec({ acquisition_stage: 'under_contract', live_closing_case: true }).proposal, null)
})

test('pipeline: next action, due date, priority reason, stagnation, valuation, contact-blocked; evidence ahead of the stage is proposed BELOW offer only', () => {
  const r = rec({ next_action: null, next_action_due: null, promotion_reason: null, priority: null, temperature: null, stage_entered_at: at(T0 - 30 * D), pas_id: null, thread_suppressed: true })
  assert.deepEqual(codes(r), ['contact_blocked_on_live_opportunity', 'missing_due_date', 'missing_next_action', 'missing_priority_reason', 'missing_valuation', 'stagnant_stage'])
  assert.ok(codes(rec({ next_action_due: at(T0 - 3 * D) })).includes('overdue_next_action'))
  const ahead = rec({ acquisition_stage: 'offer_interest', thread_stage: 'property_condition' })
  assert.deepEqual([ahead.proposal.to_stage, codes(ahead).includes('evidence_ahead_of_stage')], ['property_condition', true])
  assert.equal(rec({ acquisition_stage: 'property_condition', thread_stage: 'offer' }).proposal, null, 'a parsed reply never proposes offer')
  assert.equal(rec({ acquisition_stage: 'property_condition', thread_stage: 'closed' }).proposal, null, 'closed is the closing authority alone')
})

test('pipeline.reconcile job: findings, work items and PENDING approvals through pipeline.propose_stage_change — the stage itself is never written', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [PIPELINE_RECONCILE_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const world = makeWorld()
  world.state.opportunity = { ...world.state.opportunity, acquisition_stage: 'offer', opportunity_status: 'active' }
  const { plane, store: capStore } = makePlane({ env: CAP_ENV, world, now: () => t })
  const source = createOperationsMemorySource({ opportunities: [opp({ opportunity_id: OPP_ID, acquisition_stage: 'offer' }), opp({}), opp({ opportunity_status: 'dead' })] })
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const handler = createPipelineReconcileHandler({ source, store, getPlane: async () => plane, now: () => t })
  await runtime.enqueue({ kind: PIPELINE_RECONCILE_KIND, idempotency_key: 'f'.repeat(64), input: { max_proposals: 5 }, requested_by: OP })
  await runRuntimeTick({ store: runtime, handlers: { [PIPELINE_RECONCILE_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t })
  const job = [...runtime._state.jobs.values()][0]
  assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
  assert.equal(job.result.scanned, 2, 'only live (active | nurture) opportunities')
  assert.equal(job.result.stage_writes, 0)
  assert.equal(job.result.proposals.length, 1)
  assert.equal(job.result.proposals[0].status, 'approval_pending', JSON.stringify(job.result.proposals[0]))
  const pending = [...capStore._approvals.values()].filter((a) => a.state === 'pending')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].capability_id, 'pipeline.propose_stage_change')
  assert.equal(world.called('pipeline.transition').length, 0, 'no stage write without a human approval')
  assert.equal(store._items.get(`pipeline:opp:${OPP_ID}`).severity, 'critical')
  assert.ok([...runtime._state.findings.values()].some((f) => f.finding_type === 'pipeline.mismatch' && f.key === `opp.${OPP_ID}`))
  // propose:false → findings and items only
  await runtime.enqueue({ kind: PIPELINE_RECONCILE_KIND, idempotency_key: 'e'.repeat(64), input: { propose: false }, requested_by: OP })
  t += H
  await runRuntimeTick({ store: runtime, handlers: { [PIPELINE_RECONCILE_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t })
  const j2 = [...runtime._state.jobs.values()].find((j) => j.job_id !== job.job_id)
  assert.equal(j2.state, 'completed')
  assert.equal(j2.result.proposals.length, 0)
})

// ── supervisor ──────────────────────────────────────────────────────────────
const AC = { counts: { needs_attention: 0 }, lost: 0, active_queue: 0, total: 50, computed_at: at(T0 - 10 * 60_000) }
const RUNTIME = { jobs: [{ kind: 'ops.health_check', state: 'completed' }, { kind: 'property.research', state: 'completed' }, { kind: 'valuation.refresh', state: 'completed' }] }
// 8.5.21-b: the research / valuation read (agent.ops_research_valuation_snapshot) of a healthy pipeline
const RV = { valuation: { live: 10, with_score: 10, offer_ready: 8, missing: 0, stale_30d: 0, by_tier: { AUTO_HARD_OFFER: 8, CREATIVE_TERMS: 2 } }, offers: { sent_30d: 4, overdue_no_reply_72h: 0, overdue_opportunity_ids: [] }, negotiations: { envelopes: 2, live_envelopes: 1, ledger_events_7d: 3, send_authorizations: 0, in_negotiation_stage: 3 } }
const SPEND = { day_usd: 0.1, cycle_usd: 2, limits: { day_usd: 5, cycle_usd: 150 } }
const full = (o = {}) => evaluateSupervisor({ snapshot: snapshot(o.snap), health: health(), actionCenter: AC, recovery: { by_class: { research_worthy: 1 } }, runtime: RUNTIME, spend: SPEND, approvals: [], researchValuation: RV, valuationBatch: { at: at(T0 - 2 * H), queued: 5, gained_offer_ready: 2, gained_valuation: 3, mode: 'dry_run' }, now: T0, ...o })

test('supervisor: a healthy fixture is all clear — and all clear REQUIRES every check to have been read', () => {
  const ev = full()
  assert.equal(ev.counts.unavailable, 1, 'profitability: no closed revenue records yet')
  assert.equal(ev.all_clear, false, 'one unread check ⇒ never "all clear"')
  assert.deepEqual(ev.checks.find((c) => c.id === 'profitability'), { id: 'profitability', status: 'unavailable', code: 'NO_CLOSED_REVENUE_RECORDS', value: { closing_cases: 0 }, source: 'public.closing_cases' })
  const withRevenue = full({ snap: { revenue: { closings_with_revenue: 2, closing_cases: 2, confirmed_gross_revenue: 41000 } } })
  assert.equal(withRevenue.all_clear, true)
  assert.equal(withRevenue.issues.length, 0)
})

test('supervisor: unavailable sources are "unavailable", never ok and never 0', () => {
  const ev = evaluateSupervisor({ snapshot: { unavailable: 'SOURCE_NOT_APPLIED' }, now: T0 })
  assert.equal(ev.counts.ok, 0)
  for (const c of ev.checks) assert.equal(c.status, 'unavailable', c.id)
  assert.equal(ev.checks.find((c) => c.id === 'failed_scheduled_messages').code, 'SOURCE_NOT_APPLIED')
  // a stale action center is unavailable, not "no unhandled inbounds"
  const stale = full({ actionCenter: { ...AC, computed_at: at(T0 - 30 * H) } })
  assert.equal(stale.checks.find((c) => c.id === 'unhandled_inbounds').status, 'unavailable')
  // a small sample is not a delivery rate
  assert.equal(full({ snap: { delivery: { sent_24h: 3, delivered_24h: 0, sent_7d: 10, delivered_7d: 1 } } }).checks.find((c) => c.id === 'delivery_rate').status, 'unavailable')
})

test('supervisor RETRY SAFETY: an internal failure is a remediation (re-queue after review); a provider-accepted failure escalates and is never re-sent automatically', () => {
  const ev = full({ snap: { queue: { failed: 5, failed_internal: 3, failed_provider: 2 } } })
  const internal = ev.issues.find((i) => i.dedupe_key === 'supervisor:failed_internal_sends')
  const provider = ev.issues.find((i) => i.dedupe_key === 'supervisor:failed_provider_accepted_sends')
  assert.deepEqual([internal.kind, internal.remediation.retry_safe, internal.escalate], ['remediation', true, false])
  assert.deepEqual([provider.kind, provider.remediation.retry_safe, provider.escalate, provider.severity], ['escalation', false, true, 'critical'])
})

test('supervisor checks with fixtures: lost inbounds, HOT without action, delivery, opt-out trend, sender health, zero-qualified campaigns, heartbeats, spend, approval backlog', () => {
  const ev = full({
    actionCenter: { ...AC, lost: 12, counts: { needs_attention: 15 }, active_queue: 15 },
    snap: { pipeline: { hot_without_current_action: 2, negotiations_stalled_7d: 3, missing_valuation: 4, stagnant_14d: 5 }, delivery: { sent_24h: 200, delivered_24h: 120 }, inbound: { opt_out_7d: 90, opt_out_prev_7d: 10 }, senders: { rates_7d: [{ sender_id: uuid(), sent_7d: 100, failed_7d: 40 }], spam_flagged: 1 }, followups: { expired_followup_dates: 4 } },
    health: health({ keys: { queue_processor_heartbeat_at: at(T0 - 2 * H) } }),
    spend: { day_usd: 4.5, cycle_usd: 10, limits: { day_usd: 5, cycle_usd: 150 } },
    approvals: [{ approval_id: 'apr_x', capability_id: 'pipeline.propose_stage_change', created_at: at(T0 - 20 * H) }],
    snapshot: undefined,
  })
  const st = Object.fromEntries(ev.checks.map((c) => [c.id, c.status]))
  assert.equal(st.unhandled_inbounds, 'critical')
  assert.equal(st.worker_heartbeats, 'critical')
  assert.equal(st.ai_spend, 'warn')
  assert.equal(st.approval_backlog, 'warn')
  const ev2 = full({ snap: { pipeline: { hot_without_current_action: 2, negotiations_stalled_7d: 3, missing_valuation: 4, stagnant_14d: 5 }, delivery: { sent_24h: 200, delivered_24h: 120 }, inbound: { opt_out_7d: 90, opt_out_prev_7d: 10 }, senders: { rates_7d: [{ sender_id: uuid(), sent_7d: 100, failed_7d: 40 }], spam_flagged: 1 }, followups: { expired_followup_dates: 4 }, campaigns_30d: [{ campaign_id: uuid(), status: 'active', delivered: 500, threads: 480, replied_threads: 20, qualified_threads: 0 }] } })
  const s2 = Object.fromEntries(ev2.checks.map((c) => [c.id, c.status]))
  assert.deepEqual([s2.hot_opportunities, s2.delivery_rate, s2.opt_out_rate, s2.sender_health, s2.campaign_reply_rates, s2.followups_due_failed, s2.negotiations_progress, s2.missing_valuations, s2.stage_stagnation], ['critical', 'critical', 'critical', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn'])
  assert.ok(ev2.escalations >= 3)
  for (const i of ev2.issues) assert.match(i.dedupe_key, /^supervisor:[a-z_]+$/)
})

test('ops.supervisor job: $0, findings + work items; a cleared issue auto-resolves, an unread check never "clears" its open item', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [OPS_SUPERVISOR_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } }, research: { enabled: true }, health: async () => health() })
  let snap = snapshot({ pipeline: { hot_without_current_action: 2 }, queue: { failed: 1, failed_provider: 1 } })
  const source = { supervisorSnapshot: async () => snap }
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const reads = createMissionMemoryReads(runtime, { now: () => t })
  const handler = createOpsSupervisorHandler({ source, store, reads, now: () => t })
  const run = async (k) => { await runtime.enqueue({ kind: OPS_SUPERVISOR_KIND, idempotency_key: k.repeat(64), input: {}, requested_by: OP }); await runRuntimeTick({ store: runtime, handlers: { [OPS_SUPERVISOR_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t }) }
  await run('a')
  const job = [...runtime._state.jobs.values()][0]
  assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
  assert.equal(job.result.model_calls, 0)
  assert.ok(!runtime._state.ledger.length)
  assert.equal(store._items.get('supervisor:hot_without_action').escalated, true)
  assert.equal(store._items.get('supervisor:failed_provider_accepted_sends').kind, 'escalation')
  assert.ok([...runtime._state.findings.values()].some((f) => f.finding_type === 'supervisor.escalation'))
  assert.ok([...runtime._state.findings.values()].some((f) => f.finding_type === 'supervisor.summary'))
  // the HOT issue is fixed; the queue snapshot becomes unreadable
  snap = { ...snapshot(), queue: undefined }
  const failing = { supervisorSnapshot: async () => { throw Object.assign(new Error('x'), { code: 'SOURCE_TIMEOUT' }) } }
  const h2 = createOpsSupervisorHandler({ source: failing, store, reads, now: () => t })
  t += H
  await runtime.enqueue({ kind: OPS_SUPERVISOR_KIND, idempotency_key: 'b'.repeat(64), input: {}, requested_by: OP })
  await runRuntimeTick({ store: runtime, handlers: { [OPS_SUPERVISOR_KIND]: h2 }, workerId: 'w', budgetMs: 20_000, now: () => t })
  assert.equal(store._items.get('supervisor:hot_without_action').state, 'open', 'an unread check never clears its item')
  t += H
  source.supervisorSnapshot = async () => snapshot()
  await run('c')
  assert.equal(store._items.get('supervisor:hot_without_action').state, 'resolved', 'read and cleared ⇒ auto-resolved')
  assert.equal(store._items.get('supervisor:hot_without_action').resolved_by, 'auto:condition_cleared')
})
