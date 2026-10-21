// 8.5.21-b — owner decisions (1) and (3): the bounded valuation refresh PLAN (estimated writes, time,
// external usage) and the research budget: paid calls DEFAULT-DENY, an explicit approval + the $10
// testing ceiling, dedupe through recent web evidence, exact usage per property / mission / provider.
import test from 'node:test'
import assert from 'node:assert/strict'

import { paidResearchGate, paidResearchCeiling, webEvidenceIsFresh, usageFinding, summarizeUsage, PROVIDER_COST_ESTIMATES, ceilingCapacity, RESEARCH_TEST_CEILING_USD } from '../../src/lib/agent/research/research-usage.js'
import { buildValuationRefreshPlan, REFRESH_PHASES } from '../../src/lib/domain/valuation-refresh/refresh-plan.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads, PROPERTY_RESEARCH_KIND } from '../../src/lib/agent/missions/index.js'
import { createPropertyResearchHandler } from '../../src/lib/agent/missions/property-research-handler.js'
import { enqueuePropertyResearch } from '../../src/lib/agent/missions/property-research-triggers.js'
import { PID, memorySource } from '../helpers/property-research-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const T0 = Date.parse('2026-10-16T15:00:00.000Z')
const APPROVED = { RESEARCH_PAID_CALLS_APPROVED: '1', RESEARCH_PAID_APPROVAL_REF: 'apr_00000000-0000-4000-8000-0000000000aa' }

test('paid calls are DEFAULT-DENY: no flag, no approval ref, an unreadable spend total or a reached $10 ceiling ⇒ refused', () => {
  assert.equal(RESEARCH_TEST_CEILING_USD, 10)
  assert.equal(paidResearchGate({ env: {}, committed_paid_usd: 0, estimate_usd: 0.26 }).reason, 'paid_calls_not_approved')
  assert.equal(paidResearchGate({ env: { RESEARCH_PAID_CALLS_APPROVED: '1' }, committed_paid_usd: 0, estimate_usd: 0.26 }).reason, 'paid_calls_approval_ref_missing')
  assert.equal(paidResearchGate({ env: APPROVED, committed_paid_usd: null, estimate_usd: 0.26 }).reason, 'paid_spend_total_unavailable')
  assert.equal(paidResearchGate({ env: APPROVED, committed_paid_usd: 9.8, estimate_usd: 0.26 }).reason, 'testing_ceiling_reached')
  assert.equal(paidResearchGate({ env: APPROVED, committed_paid_usd: 1, estimate_usd: 0.26 }).ok, true)
  // Package A (owner 2026-10-20 "a promotional-credit plan of ≤ $200 total"): default $10; the env may raise it to the $200 hard max, never above
  assert.equal(paidResearchCeiling({}), 10, 'default $10')
  assert.equal(paidResearchCeiling({ RESEARCH_PAID_CEILING_USD: '50' }), 50, 'the env may raise the ceiling (owner-approved plan)')
  assert.equal(paidResearchCeiling({ RESEARCH_PAID_CEILING_USD: '500' }), 200, 'never above the $200 hard max')
  assert.equal(paidResearchGate({ env: { ...APPROVED, RESEARCH_PAID_CEILING_USD: '200' }, committed_paid_usd: 199.8, estimate_usd: 0.26 }).reason, 'testing_ceiling_reached')
  assert.equal(paidResearchCeiling({ RESEARCH_PAID_CEILING_USD: '2' }), 2)
})

function harness({ env }) {
  const store = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, max_concurrency_global: 1, tick_max_jobs: 1, lease_seconds: 120, backoff_base_seconds: 1, event_budget_ceilings: { [PROPERTY_RESEARCH_KIND]: 0.3 }, kind_limits: { [PROPERTY_RESEARCH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP, event_budget_cap_usd: 0.3 } } }, research: { enabled: true, day_usd: 5, run_usd: 2.5 } })
  const reads = createMissionMemoryReads(store, { members: [], now: () => T0 })
  const calls = []
  const buildAsk = () => ({ ask: async (a) => { calls.push(a); return { run_id: 'r', done: Promise.resolve({ state: 'completed', answer_md: '```json\n{"items":[{"topic":"subject_listing","status":"active","list_price":259900,"url":"https://listings.example.com/s"}]}\n```', cost_usd: 0.0219, model_calls: 2, web_searches: 1, result: { evidence: { public_web: [{ url: 'https://listings.example.com/s', retrieved_at: '2026-10-16T15:00:00Z' }] } } }) } }, cancel() {} })
  const handler = createPropertyResearchHandler({ source: memorySource(), reads, buildAsk, env, now: () => T0, minAskMs: 0, limits: { web_call_reserve_usd: 0.02 } })
  const run = async (disc) => { const { job_id } = await enqueuePropertyResearch({ store, env: { PROPERTY_RESEARCH_ENABLED: '1' }, trigger: 'offer_request', property_id: PID, discriminator: disc }); await runRuntimeTick({ store, handlers: { [PROPERTY_RESEARCH_KIND]: handler }, workerId: 'w', budgetMs: 25_000, now: () => T0 }); return store._state.jobs.get(job_id) }
  return { store, reads, calls, run }
}

test('handler: with web enabled but NO approval ⇒ no paid call (internal findings still recorded); the usage record says why', async () => {
  const h = harness({ env: { AGENT_WEB_RESEARCH_ENABLED: '1' } })
  const j = await h.run('a')
  assert.equal(j.state, 'completed')
  assert.equal(h.calls.length, 0)
  assert.equal(j.result.web.status, 'skipped_paid_calls_not_approved')
  const usage = [...h.store._state.findings.values()].find((f) => f.job_id === j.job_id && f.finding_type === 'research.usage').value
  assert.deepEqual([usage.paid, usage.usd, usage.model_calls, usage.outcome, usage.mission, usage.provider], [false, 0, 0, 'skipped_paid_calls_not_approved', 'property.research', 'anthropic'])
})

test('handler: approved ⇒ ONE paid run recorded exactly (property, mission, provider, calls, searches, usd); a second trigger inside the TTL is DEDUPED (no call)', async () => {
  const h = harness({ env: { AGENT_WEB_RESEARCH_ENABLED: '1', ...APPROVED } })
  const j1 = await h.run('a')
  assert.equal(j1.result.web.status, 'completed')
  const u1 = [...h.store._state.findings.values()].find((f) => f.job_id === j1.job_id && f.finding_type === 'research.usage').value
  assert.deepEqual([u1.usd, u1.model_calls, u1.web_searches, u1.paid], [0.0219, 2, 1, true])
  const j2 = await h.run('b')
  assert.equal(h.calls.length, 1, 'the second research of the same property reuses the recent web evidence')
  assert.equal(j2.result.web.status, 'skipped_recent_web_evidence')
  const sum = summarizeUsage([...h.store._state.findings.values()].filter((f) => f.finding_type === 'research.usage').map((f) => f.value))
  assert.deepEqual([sum.records, sum.usd, sum.deduped, Object.keys(sum.by_provider)], [2, 0.0219, 1, ['anthropic']])
  assert.deepEqual((await webEvidenceIsFresh({ reads: h.reads, property_ref: u1.property_ref, now: T0 + 15 * 864e5 })).fresh, false, 'after the TTL the property may be researched again')
})

test('provider cost estimates come from the price book / measured runs; the $10 ceiling capacity is explicit', () => {
  const uses = new Set(PROVIDER_COST_ESTIMATES.map((p) => p.use))
  for (const u of ['search', 'property_research', 'valuations', 'background_research']) assert.ok(uses.has(u), u)
  assert.equal(PROVIDER_COST_ESTIMATES.find((p) => p.use === 'valuations').usd, 0)
  assert.deepEqual(ceilingCapacity(10), { ceiling_usd: 10, property_research_at_measured: 456, property_research_at_worst_case: 38, web_searches_fee_only: 1000 })
  assert.equal(usageFinding({ property_ref: 'pid_x', mission: 'property.research', usd: 0 }).value.paid, false)
})

test('valuation refresh PLAN: phased (actionable → historical → remaining), writes / bytes / time estimated, $0 external, reused rows write nothing', () => {
  const r = (cls, o = {}) => ({ ref: `pid_${cls.slice(0, 3)}${Math.random().toString(36).slice(2, 6)}`, class: cls, ok: true, ran: true, ms: 3000, before: { present: false, offer_ready: false }, after: { present: true, offer_ready: false, tier: 'REVIEW_REQUIRED' }, ...o })
  const results = [r('active_negotiation'), r('offer_request', { after: { present: true, offer_ready: true, tier: 'AUTO_RANGE_OFFER' } }), r('recoverable_conversation', { ran: false }), r('investigate_missing_financials'), r('investigate_missing_financials', { ok: false })]
  const plan = buildValuationRefreshPlan(results, { score_row_bytes: 100_000, snapshot_row_bytes: 200_000 })
  assert.deepEqual(REFRESH_PHASES.map((p) => p.name), ['actionable_now', 'historical_candidates', 'remaining_live_missing_financials'])
  assert.equal(plan.status, 'PROPOSED_NOT_APPROVED')
  const [p1, p2, p3] = plan.phases
  assert.deepEqual([p1.properties, p1.engine_runs_that_write, p1.estimated_db_writes.rows, p1.estimated_db_writes.bytes, p1.predicted_outcome.offer_ready_gained], [2, 2, 4, 600_000, 1])
  assert.deepEqual([p2.engine_runs_that_write, p2.reused_current_no_write], [0, 1])
  assert.deepEqual([p3.engine_runs_that_write, p3.failed_in_dry_run], [1, 1])
  assert.deepEqual([plan.totals.engine_runs_that_write, plan.totals.paid_external_calls, plan.totals.usd], [3, 0, 0])
  assert.equal(plan.measurements.median_ms_per_property, 3000)
})
