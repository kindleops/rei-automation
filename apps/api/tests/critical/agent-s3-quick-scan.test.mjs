// Agent S3 — Quick Scan planner/dispatcher on the S1 spine: real events with
// registered labels, $0 by structure (no ledger, no gateway), scope-hash
// confirm, mode gate, batch limits, concurrency 2, cancel semantics.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FIXTURE_PII, multiDb } from '../helpers/agent-s3-fake-db.mjs'
import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'
import { getEntityGraphDossier } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import { renderOperationLabel, LABELLED_EVENT_TYPES } from '../../src/lib/agent/contracts/events.js'
import { reduceEvents } from '../../src/lib/agent/contracts/reducer.js'
import { QUICK_SCAN_PLAN } from '../../src/lib/agent/quick-scan/quick-scan-service.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const agentDir = path.resolve(here, '../../src/lib/agent')

function setup({ ids = ['9000000001'], mode = 'read', impl = {}, store = createInMemoryAgentStore() } = {}) {
  const db = multiDb(ids)
  const agent = createLiveAgent({ env: { AGENT_MAX_MODE: mode }, store, createServices: () => createQuickScanServices({ db, impl }) })
  return { agent, db, store }
}

async function scan(agent, ids, operator_id = 'op_1') {
  const pf = await agent.quickScan.preflight({ operator_id, property_ids: ids })
  const c = await agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id })
  return { pf, c }
}

test('preflight: exact scope + hash, nine T0 tools, $0 structural, no approval, cancellation copy, live not fixture; nothing executes', async () => {
  const { agent, db } = setup()
  const pf = await agent.quickScan.preflight({ operator_id: 'op_1', property_ids: ['9000000001', '9000000001'] })
  assert.deepEqual(pf.scope.property_ids, ['9000000001'])
  assert.match(pf.scope_hash, /^[0-9a-f]{64}$/)
  assert.deepEqual([pf.estimate.low_usd, pf.estimate.high_usd, pf.estimate.basis, pf.max_budget_usd], [0, 0, 'structural_zero', 0])
  assert.equal(pf.tools.length, 9)
  assert.ok(pf.tools.every((t) => t.tier === 'T0' && t.billable === false))
  assert.equal(pf.approval.required, false)
  assert.match(pf.cancellation, /Cancel stops/)
  assert.deepEqual([pf.live, pf.fixture, pf.can_run, pf.ai.enabled], [true, false, true, false])
  assert.equal(db.calls.length, 0, 'preflight performs no data reads')
})

test('confirm: scope hash mismatch is refused (a different scope is a new job); mode off refuses before confirming', async () => {
  const { agent } = setup()
  const pf = await agent.quickScan.preflight({ operator_id: 'op_1', property_ids: ['9000000001'] })
  await assert.rejects(agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: 'f'.repeat(64), operator_id: 'op_1' }), (e) => e.code === 'JOB_SCOPE_CHANGED')
  await assert.rejects(agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'someone_else' }), (e) => e.code === 'OPERATOR_MISMATCH')
  const off = setup({ mode: 'off' })
  const pf2 = await off.agent.quickScan.preflight({ operator_id: 'op_1', property_ids: ['9000000001'] })
  assert.equal(pf2.can_run, false)
  assert.equal(pf2.blockers[0].code, 'AGENT_MODE_CEILING')
  await assert.rejects(off.agent.quickScan.confirm({ job_id: pf2.job_id, scope_hash: pf2.scope_hash, operator_id: 'op_1' }), (e) => e.code === 'AGENT_MODE_CEILING')
  assert.equal(off.store.read().researchJobs.get(pf2.job_id).state, 'draft')
})

test('batch limits: test batches ≤ 10; invalid ids refused; empty scope refused', async () => {
  const { agent } = setup()
  await assert.rejects(agent.quickScan.preflight({ operator_id: 'op_1', property_ids: Array.from({ length: 11 }, (_, i) => `p${i}`) }), (e) => e.code === 'TEST_BATCH_LIMIT')
  await assert.rejects(agent.quickScan.preflight({ operator_id: 'op_1', property_ids: ["1; drop table"] }), (e) => e.code === 'PROPERTY_ID_INVALID')
  await assert.rejects(agent.quickScan.preflight({ operator_id: 'op_1', property_ids: [] }), (e) => e.code === 'RESEARCH_EMPTY_SCOPE')
  await assert.rejects(agent.quickScan.preflight({ operator_id: null, property_ids: ['p1'] }), (e) => e.code === 'SESSION_REQUIRED')
})

test('a real run emits registered-label events, findings with source classes, conflicts, brief; gapless; $0; no PII in the log', async () => {
  const { agent, store } = setup({ ids: ['9000000001', '9000000002'] })
  const { pf, c } = await scan(agent, ['9000000001', '9000000002'])
  assert.equal((await c.done).state, 'completed')
  const events = store.read().events.filter((e) => e.run_id === pf.run_id)
  assert.deepEqual(agent.eventLog.gaps(pf.run_id), [])
  assert.ok(events.every((e) => !e.fixture))
  for (const e of events.filter((x) => LABELLED_EVENT_TYPES.includes(x.type))) {
    assert.equal(e.payload.operation, 'research.check')
    assert.match(e.payload.label, /^Checking LeadCommand .+ \(.+\)$/)
  }
  assert.equal(events.filter((e) => e.type === 'plan.task_added').length, 2 * QUICK_SCAN_PLAN.length)
  assert.equal(events.filter((e) => e.type === 'task.completed').length, 2 * QUICK_SCAN_PLAN.length)
  assert.ok(events.some((e) => e.type === 'finding.conflict' && e.payload.resolution_state === 'resolved_by_rule'))
  assert.ok(events.some((e) => e.type === 'brief.section' && e.payload.section_key === 'risks_unresolved'))
  assert.equal(events.filter((e) => e.type === 'job.property_state' && e.payload.state === 'completed').length, 2)
  // $0 by structure
  assert.equal(store.read().ledger.length, 0)
  assert.ok(!events.some((e) => e.type.startsWith('usage.') || e.type === 'budget.stopped'))
  assert.ok(events.filter((e) => e.type === 'task.completed').every((e) => e.payload.cost_usd === 0))
  const snap = agent.quickScan.snapshot(pf.run_id)
  assert.deepEqual([snap.live, snap.fixture, snap.cost.accrued_usd, snap.state], [true, false, 0, 'completed'])
  assert.ok(snap.findings.length > 20)
  assert.ok(snap.findings.every((f) => f.run_id === pf.run_id && f.source_class && f.retrieved_at))
  // reducer: snapshot view == reduce(events)
  assert.deepEqual(snap.view, reduceEvents(events)[pf.run_id])
  assert.equal(snap.view.properties['9000000002'].contact_readiness_class, 'ineligible')
  const text = JSON.stringify(store.read())
  for (const pii of [FIXTURE_PII.ownerName, FIXTURE_PII.prospectName, FIXTURE_PII.phoneDigits, FIXTURE_PII.email, FIXTURE_PII.mailing, 'SECRETKEY123']) assert.ok(!text.includes(pii), `store leaked ${pii}`)
  // property ids survive the sanitizer (identifier keys are not phone-masked)
  assert.ok(snap.findings.every((f) => /^900000000[12]$/.test(f.property_id)))
})

test('$0 structurally: no Quick Scan / live module imports the gateway, ledger, a provider SDK or an HTTP client', () => {
  const files = [...fs.readdirSync(path.join(agentDir, 'quick-scan')).map((f) => path.join(agentDir, 'quick-scan', f)), ...fs.readdirSync(path.join(agentDir, 'live')).map((f) => path.join(agentDir, 'live', f))]
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const i of imports) {
      assert.ok(!/model-gateway|budget\/ledger|price-book|providers\/|openai|anthropic|groq|axios|node:https?$|undici/.test(i), `${path.basename(f)} imports ${i}`)
    }
  }
})

test('no network: a full scan against the fake data service never calls fetch', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('network') }
  try {
    const { agent } = setup()
    const { c } = await scan(agent, ['9000000001'])
    await c.done
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 0)
})

test('concurrency: at most 2 properties are investigated at once', async () => {
  let inFlight = 0
  let peak = 0
  const impl = { getEntityGraphDossier: async (...a) => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight -= 1; return getEntityGraphDossier(...a) } }
  const ids = ['9000000001', '9000000002', '9000000003', '9000000004', '9000000005']
  const { agent } = setup({ ids, impl })
  const { c } = await scan(agent, ids)
  assert.equal((await c.done).state, 'completed')
  assert.ok(peak <= 2 && peak >= 1, `peak ${peak}`)
})

test('a failing read is a task.failed + unavailable findings, the run completes partial, and nothing is invented', async () => {
  const { agent, store } = setup({ impl: { getEntityGraphOutreachState: async () => { const e = new Error('boom'); e.code = 'XX000'; throw e } } })
  const { pf, c } = await scan(agent, ['9000000001'])
  assert.equal((await c.done).state, 'completed_partial')
  const events = store.read().events.filter((e) => e.run_id === pf.run_id)
  assert.equal(events.filter((e) => e.type === 'task.failed').length, 2) // outreach + sms read the same service
  const snap = agent.quickScan.snapshot(pf.run_id)
  for (const k of ['outreach', 'sms']) {
    const f = snap.findings.find((x) => x.key === k)
    assert.deepEqual([f.evidence_status, f.value], ['unavailable', null])
  }
  assert.equal(snap.view.properties['9000000001'].contact_readiness_class, 'unknown')
})

test('cancel while a read is in flight: unstarted reads cancelled now, in-flight abandoned, run.cancelled only after acknowledgement; findings kept', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let dossierCalls = 0
  const impl = { getEntityGraphOutreachState: async () => { await gate; return { states: {}, unavailable: [] } }, getEntityGraphDossier: async (...a) => { dossierCalls += 1; return getEntityGraphDossier(...a) } }
  const ids = ['9000000001', '9000000002', '9000000003']
  const { agent, store } = setup({ ids, impl })
  const { pf, c } = await scan(agent, ids)
  // wait until the outreach read is in flight
  for (let i = 0; i < 200 && !store.read().events.some((e) => e.run_id === pf.run_id && e.type === 'task.started' && e.payload.finding_type === 'outreach_state'); i += 1) await new Promise((r) => setTimeout(r, 5))
  const res = await agent.quickScan.cancel({ run_id: pf.run_id, requested_by: 'op_1' })
  assert.equal(res.ok, true)
  assert.notEqual(store.read().runs.get(pf.run_id).state, 'cancelled', 'not cancelled before the dispatcher acknowledges')
  release()
  assert.equal((await c.done).state, 'cancelled')
  const events = store.read().events.filter((e) => e.run_id === pf.run_id)
  const types = events.map((e) => e.type)
  assert.ok(types.includes('job.cancel_requested') && types.includes('run.cancel_requested'))
  assert.ok(types.indexOf('run.cancelled') > types.indexOf('run.cancel_requested'))
  assert.ok(events.some((e) => e.type === 'task.cancelled' && e.payload.after_cancel === true), 'the in-flight read is reported abandoned')
  assert.ok(events.some((e) => e.type === 'task.cancelled' && e.payload.after_cancel === false), 'unstarted reads are cancelled')
  assert.equal(store.read().runs.get(pf.run_id).state, 'cancelled')
  assert.ok(agent.quickScan.snapshot(pf.run_id).findings.length > 0, 'findings gathered before the cancel are kept')
  assert.ok(dossierCalls < ids.length, 'the third property was never read')
  assert.deepEqual(agent.eventLog.gaps(pf.run_id), [])
})

test('cancel before confirm (draft) cancels immediately with no reads', async () => {
  const { agent, store, db } = setup()
  const pf = await agent.quickScan.preflight({ operator_id: 'op_1', property_ids: ['9000000001'] })
  await agent.quickScan.cancel({ run_id: pf.run_id, requested_by: 'op_1' })
  assert.equal(store.read().runs.get(pf.run_id).state, 'cancelled')
  await assert.rejects(agent.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'op_1' }), (e) => e.code === 'ILLEGAL_JOB_TRANSITION')
  assert.equal(db.calls.length, 0)
})

test('history lists live quick scans only, newest first, labelled live', async () => {
  const { agent } = setup()
  const a = await scan(agent, ['9000000001'])
  await a.c.done
  const rows = agent.quickScan.history()
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].run_id, rows[0].live, rows[0].fixture, rows[0].accrued_usd], [a.pf.run_id, true, false, 0])
  assert.equal(renderOperationLabel('research.check', { jurisdiction: 'LeadCommand', finding_label: 'x', source_name: 'y' }), 'Checking LeadCommand x (y)')
})
