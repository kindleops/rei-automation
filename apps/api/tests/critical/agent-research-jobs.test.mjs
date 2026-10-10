// Agent S1 — research job interfaces: estimate/confirm/cancel, Quick Scan $0
// structural guards, batch split, test-batch limit, concurrency, evidence rules.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createRunService } from '../../src/lib/agent/runtime/run-service.js'
import { createResearchJobService, defineSourceAdapter, assertDispatchable } from '../../src/lib/agent/research/research-jobs.js'
import { normalizeFinding, computeConfidence } from '../../src/lib/agent/research/evidence-service.js'
import { resolveBudgetConfig } from '../../src/lib/agent/budget/budget-config.js'

function adapter(over = {}) {
  return defineSourceAdapter({
    id: 'supabase.record_summary', name: 'LeadCommand records', version: 1, finding_types: ['ownership'], jurisdictions: ['*'],
    access_mode: 'supabase', hosts: ['internal.invalid'], supports_negative: false, timeout_ms: 5000, billable: false, cost_bound: 'bounded',
    buildRequest: () => ({}), parse: () => [], classifyFailure: () => 'failed', ...over,
  })
}

async function setup(cfg) {
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store, budgetConfig: cfg })
  const jobs = createResearchJobService({ store, runService: runs, config: cfg })
  return { store, runs, jobs }
}

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`)

test('Quick Scan estimate is structural $0; Deep shows a labelled worst case', async () => {
  const { jobs } = await setup()
  const q = await jobs.estimate({ operator_id: 'o', property_ids: ids(5), depth: 'quick' })
  assert.deepEqual([q.estimate.low_usd, q.estimate.high_usd, q.estimate.basis], [0, 0, 'structural_zero'])
  const d = await jobs.estimate({ operator_id: 'o', property_ids: ids(10), depth: 'deep' })
  assert.equal(d.estimate.basis, 'worst_case')
  assert.equal(d.estimate.high_usd, 7.5)
  assert.match(d.scope_sentence, /Research 10 properties · Deep Research · hard cap \$0\.75 each · batch cap \$7\.50 \(≤ \$25\)/)
})

test('test_batch_mode limits batches to 10 properties until the owner lifts it', async () => {
  const { jobs } = await setup()
  await assert.rejects(jobs.estimate({ operator_id: 'o', property_ids: ids(11), depth: 'deep' }), (e) => e.code === 'TEST_BATCH_LIMIT')
})

test('cohorts above 50 split into sequential batches; batch cap never exceeds $25', async () => {
  const cfg = { ...structuredClone(resolveBudgetConfig()), research: { ...structuredClone(resolveBudgetConfig().research), test_batch_mode: false } }
  const { jobs } = await setup(cfg)
  const e = await jobs.estimate({ operator_id: 'o', property_ids: ids(120), depth: 'diligence' })
  assert.deepEqual(e.batches.map((b) => b.property_ids.length), [50, 50, 20])
  assert.equal(e.estimate.high_usd, 25)
})

test('confirm: exact scope hash; cap lower-only; immutable after confirm', async () => {
  const { jobs, store } = await setup()
  const e = await jobs.estimate({ operator_id: 'o', property_ids: ids(4), depth: 'deep' })
  await assert.rejects(jobs.confirm({ job_id: e.job_id, scope_hash: 'x' }), (err) => err.code === 'JOB_SCOPE_CHANGED')
  await assert.rejects(jobs.confirm({ job_id: e.job_id, scope_hash: e.scope_hash, budget_cap_usd: 3.01 }), (err) => err.code === 'BUDGET_CAP_ABOVE_CONFIG')
  const c = await jobs.confirm({ job_id: e.job_id, scope_hash: e.scope_hash, budget_cap_usd: 1 })
  assert.deepEqual([c.state, c.budget_cap_usd], ['queued', 1])
  await assert.rejects(jobs.confirm({ job_id: e.job_id, scope_hash: e.scope_hash }), (err) => err.code === 'ILLEGAL_JOB_TRANSITION')
  const types = store.read().events.filter((x) => x.run_id === e.run_id).map((x) => x.type)
  assert.deepEqual(types, ['run.created', 'job.created', 'job.confirmed'])
})

test('Quick Scan planner refuses any billable or non-supabase adapter', async () => {
  const { jobs } = await setup()
  const e = await jobs.estimate({ operator_id: 'o', property_ids: ids(2), depth: 'quick' })
  const ok = new Map([['supabase.record_summary', adapter()]])
  const planned = await jobs.planTasks({ job_id: e.job_id, adapters: ok, tasks: [{ property_id: 'p1', finding_type: 'ownership', adapter_id: 'supabase.record_summary', jurisdiction: 'Cuyahoga County' }] })
  assert.equal(planned[0].label, 'Checking Cuyahoga County ownership (LeadCommand records)')
  const paid = new Map([['county.tax', adapter({ id: 'county.tax', access_mode: 'open_api', billable: true })]])
  await assert.rejects(jobs.planTasks({ job_id: e.job_id, adapters: paid, tasks: [{ property_id: 'p1', finding_type: 'tax_status', adapter_id: 'county.tax' }] }), (err) => err.code === 'QUICK_SCAN_BILLABLE_REFUSED')
  const freeButExternal = new Map([['county.tax', adapter({ id: 'county.tax', access_mode: 'open_api', billable: false })]])
  await assert.rejects(jobs.planTasks({ job_id: e.job_id, adapters: freeButExternal, tasks: [{ property_id: 'p1', finding_type: 'tax_status', adapter_id: 'county.tax' }] }), (err) => err.code === 'QUICK_SCAN_BILLABLE_REFUSED')
  assert.throws(() => assertDispatchable({ task_id: 't', billable: true }, { depth: 'quick' }, null), (err) => err.code === 'QUICK_SCAN_BILLABLE_REFUSED')
})

test('adapter contract: supabase adapters cannot be billable; unbounded sources are disabled; hosts are plain', () => {
  assert.throws(() => adapter({ billable: true }), (e) => e.code === 'ADAPTER_SPEC_INVALID')
  assert.throws(() => adapter({ access_mode: 'licensed_api', billable: true, cost_bound: 'unbounded' }), (e) => e.code === 'ADAPTER_UNBOUNDED_DISABLED')
  assert.throws(() => adapter({ hosts: ['https://x.com/path'] }), (e) => e.code === 'ADAPTER_SPEC_INVALID')
  assert.throws(() => defineSourceAdapter({ id: 'x' }), (e) => e.code === 'ADAPTER_SPEC_INVALID')
})

test('investigation concurrency is 2 org-wide', async () => {
  const { jobs } = await setup()
  assert.equal(jobs.claimInvestigationSlot('a'), true)
  assert.equal(jobs.claimInvestigationSlot('b'), true)
  assert.equal(jobs.claimInvestigationSlot('c'), false)
  jobs.releaseInvestigationSlot('a')
  assert.equal(jobs.claimInvestigationSlot('c'), true)
})

test('cancel: queued tasks cancel now; with running tasks the job waits (honest pending); events emitted', async () => {
  const { jobs, store } = await setup()
  const e = await jobs.estimate({ operator_id: 'o', property_ids: ids(2), depth: 'quick' })
  await jobs.confirm({ job_id: e.job_id, scope_hash: e.scope_hash })
  await jobs.planTasks({ job_id: e.job_id, adapters: new Map([['supabase.record_summary', adapter()]]), tasks: [{ property_id: 'p1', finding_type: 'ownership', adapter_id: 'supabase.record_summary' }, { property_id: 'p2', finding_type: 'ownership', adapter_id: 'supabase.record_summary' }] })
  const r = await jobs.cancel({ job_id: e.job_id, requested_by: 'o' })
  assert.deepEqual([r.state, r.pending], ['cancelled', false])
  const types = store.read().events.filter((x) => x.run_id === e.run_id).map((x) => x.type)
  assert.ok(types.includes('job.cancel_requested') && types.includes('job.cancelled'))
  assert.equal(types.filter((t) => t === 'task.cancelled').length, 2)

  const e2 = await jobs.estimate({ operator_id: 'o', property_ids: ids(1), depth: 'quick' })
  await jobs.confirm({ job_id: e2.job_id, scope_hash: e2.scope_hash })
  await jobs.markRunning({ job_id: e2.job_id })
  const [t] = await jobs.planTasks({ job_id: e2.job_id, adapters: new Map([['supabase.record_summary', adapter()]]), tasks: [{ property_id: 'p1', finding_type: 'ownership', adapter_id: 'supabase.record_summary' }] })
  await store.transaction((tx) => { const row = tx.researchTasks.get(t.task_id); row.state = 'queued'; row.state = 'running' })
  const r2 = await jobs.cancel({ job_id: e2.job_id })
  assert.deepEqual([r2.state, r2.pending, r2.running], ['running', true, 1])
  assert.ok(!store.read().events.some((x) => x.run_id === e2.run_id && (x.type === 'job.cancelled' || x.type === 'run.cancelled')), 'never claims cancelled while work is running')
  assert.ok(store.read().runs.get(e2.run_id).cancel_requested_at, 'run is cancel-pending')
})

test('pause / resume follow the job state machine', async () => {
  const { jobs } = await setup()
  const e = await jobs.estimate({ operator_id: 'o', property_ids: ids(1), depth: 'deep' })
  await assert.rejects(jobs.pause({ job_id: e.job_id }), (err) => err.code === 'ILLEGAL_JOB_TRANSITION')
  await jobs.confirm({ job_id: e.job_id, scope_hash: e.scope_hash })
  await jobs.markRunning({ job_id: e.job_id })
  assert.equal((await jobs.pause({ job_id: e.job_id })).state, 'paused')
  assert.equal((await jobs.resume({ job_id: e.job_id })).state, 'running')
})

test('evidence: blocked/unavailable carry no value and are never absence; negatives need a covering source', () => {
  const blocked = normalizeFinding({ property_id: 'p', finding_type: 'tax_status', outcome: 'blocked', value: { delinquent: false }, is_negative_claim: true, source: { source_id: 's', supports_negative: true } })
  assert.deepEqual([blocked.evidence_status, blocked.value, blocked.is_negative_claim, blocked.confidence], ['blocked', null, false, 0])
  const down = normalizeFinding({ property_id: 'p', finding_type: 'tax_status', outcome: 'failed', evidence_status: 'county_confirmed', value: 1, source: { source_id: 's', supports_negative: true } })
  assert.equal(down.evidence_status, 'unavailable')
  const notCovering = normalizeFinding({ property_id: 'p', finding_type: 'foreclosure', outcome: 'retrieved', evidence_status: 'recorded', value: { filings: 0 }, is_negative_claim: true, source: { source_id: 's', supports_negative: false } })
  assert.deepEqual([notCovering.evidence_status, notCovering.value], ['unavailable', null])
  const covering = normalizeFinding({ property_id: 'p', finding_type: 'tax_delinquency', outcome: 'retrieved', evidence_status: 'county_confirmed', value: { tax_deed_application: false }, display_value: 'No tax-deed application', is_negative_claim: true, source: { source_id: 's', supports_negative: true } })
  assert.equal(covering.is_negative_claim, true)
  assert.equal(covering.evidence_status, 'county_confirmed')
})

test('confidence is a rule output; model inference is capped at 0.6 and the model’s own confidence is ignored', () => {
  assert.equal(computeConfidence({ evidence_status: 'county_confirmed' }), 1)
  assert.equal(computeConfidence({ evidence_status: 'county_confirmed', match: 'review' }), 0.6)
  const inf = normalizeFinding({ property_id: 'p', finding_type: 'physical_condition', outcome: 'retrieved', evidence_status: 'model_inference', value: 'deferred maintenance', source: { source_id: 's', supports_negative: false }, model_confidence: 0.99 })
  assert.ok(inf.confidence <= 0.6)
  assert.equal(inf.is_inference, true)
  assert.equal(inf.model_confidence, 0.99)
})
