// 8.5.21-b owner P0 — every acting path consults the automation-hold registry first
// (checkAutomationHold({ threadKey, threadId, propertyId, opportunityId, masterOwnerId, capability }) →
// { held, hold_type, reason, hold_id }); a lookup error = held; held items are reported, never acted on.
import test from 'node:test'
import assert from 'node:assert/strict'

import { consultHold, failClosedHoldCheck, heldLabel, HOLD_CAPABILITIES } from '../../src/lib/agent/operations/automation-hold-gate.js'
import { createRecoverySweepHandler } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { RECOVERY_SWEEP_KIND } from '../../src/lib/agent/operations/operations-kinds.js'
import { evaluateSupervisor } from '../../src/lib/agent/operations/supervisor-checks.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createValuationRefreshHandler, VALUATION_REFRESH_KIND } from '../../src/lib/agent/missions/valuation-refresh-handler.js'
import { enqueueResearchForTurn } from '../../src/lib/agent/missions/research-trigger-hook.js'
import { composeNegotiationReply } from '../../src/lib/domain/negotiation/negotiation-composer.js'
import { createMemoryNegotiationStore } from '../../src/lib/domain/negotiation/store.js'
import { buildNegotiationPathway } from '../../src/lib/domain/negotiation/negotiation-pathway.js'
import { conv, waiting, uuid, T0, D, at } from '../helpers/operations-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const HELD = async () => ({ held: true, hold_type: 'operator_review', reason: 'operator review', hold_id: 'hold-1' })
const FREE = async () => ({ held: false, hold_type: null, reason: null, hold_id: null })

test('fail closed: a lookup error or a verdict without held:boolean is a hold; the integration placeholder holds everything', async () => {
  assert.deepEqual((await consultHold(async () => { throw Object.assign(new Error('x'), { code: 'HOLDS_DB_DOWN' }) }, { capability: 'x' })).hold_type, 'hold_lookup_error')
  assert.equal((await consultHold(async () => ({}), { capability: 'x' })).held, true)
  assert.equal((await consultHold(failClosedHoldCheck, { capability: 'x' })).held, true)
  assert.equal((await consultHold(FREE, { capability: 'x' })).held, false)
  assert.equal(heldLabel({ hold_type: 'operator_review' }), 'held: operator review')
  let args = null
  await consultHold(async (a) => { args = a; return { held: false } }, { threadId: 't', propertyId: 'p', capability: HOLD_CAPABILITIES.recovery_research })
  assert.deepEqual(args, { threadId: 't', propertyId: 'p', capability: 'recovery.research_enqueue' })
})

test('recovery.sweep: a held thread gets NO research enqueue and NO nurture intent; the hold is reported in the batch', async () => {
  const runtime = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [RECOVERY_SWEEP_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const rw = conv({ conversation_id: uuid(), last_outbound_at: at(T0 - 20 * D), inbound_intents: ['seller_interested'], last_inbound_at: at(T0 - 21 * D), last_meaningful_at: at(T0 - 21 * D), property_id: '3001', cursor_at: '2026-10-15 01:00:00.000001+00' })
  const ni = waiting({ conversation_id: uuid(), last_meaningful_intent: 'not_interested', inbound_intents: ['not_interested'], last_inbound_at: at(T0 - 1 * D), last_meaningful_at: at(T0 - 1 * D), property_id: '3002', cursor_at: '2026-10-15 01:00:00.000002+00' })
  const store = createOperationsMemoryStore({ runtime, now: () => T0 })
  const research = []
  const intents = []
  const handler = createRecoverySweepHandler({ source: createOperationsMemorySource({ conversations: [rw, ni] }), store, now: () => T0, linkage: { checkAutomationHold: HELD, enqueueResearch: async (r) => { research.push(r); return { ok: true } }, enqueueFollowupIntent: async (i) => { intents.push(i); return { ok: true } } } })
  await runtime.enqueue({ kind: RECOVERY_SWEEP_KIND, idempotency_key: 'f'.repeat(64), input: {}, requested_by: OP })
  await runRuntimeTick({ store: runtime, handlers: { [RECOVERY_SWEEP_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => T0 })
  const job = [...runtime._state.jobs.values()][0]
  assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
  assert.deepEqual([research.length, intents.length], [0, 0], 'held ⇒ nothing acted on')
  assert.equal(job.result.research_requests.refused.AUTOMATION_HOLD, 1)
  assert.equal(job.result.nurture_intents.refused.AUTOMATION_HOLD, 1)
  assert.deepEqual(job.result.held, { count: 2, by_type: { operator_review: 2 } })
  const batch = [...runtime._state.findings.values()].find((f) => f.finding_type === 'recovery.batch').value
  assert.equal(batch.held.items[0].label, 'held: operator review')
  // the supervisor REPORTS it, never acts
  const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, recovery: { ...batch, at: at(T0) }, now: T0 })
  const h = ev.checks.find((c) => c.id === 'automation_holds')
  assert.deepEqual([h.status, h.value.held_items, h.value.action], ['ok', 2, 'report_only_never_act'])
  assert.ok(!ev.issues.some((i) => i.check_id === 'automation_holds'), 'no remediation / escalation generated from a hold')
})

test('valuation.refresh: a held property is recorded "held" and never valued', async () => {
  const store = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, max_concurrency_global: 1, tick_max_jobs: 1, lease_seconds: 120, kind_limits: { [VALUATION_REFRESH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  let runs = 0
  const handler = createValuationRefreshHandler({ source: { candidates: async () => [{ property_id: 'p1', status: 'active', stage: 'offer', intents: [], score_computed_at: null }] }, runDecision: async () => { runs += 1; return { ok: true } }, checkAutomationHold: HELD, env: {}, now: () => T0 })
  const { job_id } = await store.enqueue({ kind: VALUATION_REFRESH_KIND, idempotency_key: 'a'.repeat(64), input: {}, requested_by: OP })
  await runRuntimeTick({ store, handlers: { [VALUATION_REFRESH_KIND]: handler }, workerId: 'w', budgetMs: 25_000, now: () => T0 })
  assert.equal(runs, 0)
  const f = [...store._state.findings.values()].find((x) => x.job_id === job_id && x.finding_type === 'valuation.dry_run')
  assert.deepEqual([f.value.status, f.value.label], ['held', 'held: operator review'])
  assert.equal(store._state.jobs.get(job_id).result.held, 1)
})

test('research hook, negotiation composer, pathway: held ⇒ no enqueue, no draft, next action "held:…"', async () => {
  const rs = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, kind_limits: { 'property.research': { enabled: true, armed_by: OP } } } })
  const r = await enqueueResearchForTurn({ property_id: '2127709832', intents: ['asks_offer'], now: T0 }, { store: rs, env: { PROPERTY_RESEARCH_ENABLED: '1' }, checkAutomationHold: HELD })
  assert.deepEqual([r.ok, r.reason, r.hold_type], [false, 'AUTOMATION_HOLD', 'operator_review'])
  assert.equal(rs._state.jobs.size, 0)
  const c = await composeNegotiationReply({ outcome: 'PREPARE_OFFER', context: { thread_key: '+15555550123', property_id: '227876842', now: T0 }, deps: { store: createMemoryNegotiationStore() }, env: { NEGOTIATION_COMPOSER_ENABLED: '1' }, checkAutomationHold: async () => { throw new Error('down') } })
  assert.deepEqual([c.action, c.reason, c.rendered_text], ['ESCALATE_TO_OPERATOR', 'automation_hold:hold_lookup_error', null])
  const p = buildNegotiationPathway({ economics: { class: 'NEGOTIATE', reasons: [], metrics: {}, uncertainty: { missing: [] } }, hold: { held: true, hold_type: 'operator_review', hold_id: 'h' } })
  assert.deepEqual([p.next_action, p.hold.action], ['held:operator_review', 'report_only'])
})
