// 8.5.21-b — the valuation refresh queue: owner priority order, exclusions, one entry per
// property; the dry run calls the EXISTING engine entry point (ensurePropertyAcquisitionDecision)
// and NEVER writes property_acquisition_scores / snapshots; the runtime job records agent-owned
// findings, resumes across ticks, and reports the coverage gain; write mode is gated off.
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildValuationQueue, classifyValuationCandidate, valuationNeed, VALUATION_PRIORITY_CLASSES } from '../../src/lib/domain/valuation-refresh/valuation-queue.js'
import { runValuationRefresh, createWriteRefusingClient, summarizeEngineRow, valuationWriteEnabled } from '../../src/lib/domain/valuation-refresh/dry-run.js'
import { ensurePropertyAcquisitionDecision } from '../../src/lib/acquisition/decisionAuthority.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createValuationRefreshHandler, VALUATION_REFRESH_KIND, recoveryValuationCandidates } from '../../src/lib/agent/missions/valuation-refresh-handler.js'
import { buildMissionHandlers, createMissionMemoryReads } from '../../src/lib/agent/missions/index.js'
import { encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'
import { score } from '../helpers/property-research-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const T0 = Date.parse('2026-10-16T15:00:00.000Z')
const day = (n) => new Date(T0 - n * 864e5).toISOString()
const row = (o) => ({ status: 'active', stage: 'ownership_confirmation', updated_at: day(1), last_activity_at: day(1), intents: [], score_computed_at: null, ...o })

test('priority order (binding): active negotiation → offer request → motivated plausible ask → recoverable conversation → INVESTIGATE / missing financials', () => {
  assert.deepEqual(VALUATION_PRIORITY_CLASSES, ['active_negotiation', 'offer_request', 'motivated_plausible_ask', 'recoverable_conversation', 'investigate_missing_financials'])
  const q = buildValuationQueue([
    row({ property_id: 'p5', last_activity_at: day(0) }),
    row({ property_id: 'p4', status: 'dead', recovery_class: 'research_worthy' }),
    row({ property_id: 'p3', asking_price: 185000, intents: ['seller_interested'] }),
    row({ property_id: 'p2', intents: ['asks_offer'] }),
    row({ property_id: 'p1', stage: 'offer', offers_sent: 1 }),
  ], { now: T0 })
  assert.deepEqual(q.entries.map((e) => [e.property_id, e.class]), [['p1', 'active_negotiation'], ['p2', 'offer_request'], ['p3', 'motivated_plausible_ask'], ['p4', 'recoverable_conversation'], ['p5', 'investigate_missing_financials']])
  assert.deepEqual(q.by_class, { active_negotiation: 1, offer_request: 1, motivated_plausible_ask: 1, recoverable_conversation: 1, investigate_missing_financials: 1 })
})

test('needs + exclusions: a current engine row is never re-queued; stop / wrong number / denial / dead-without-recovery are excluded; one entry per property (best class)', () => {
  assert.equal(valuationNeed({ score_computed_at: day(3) }, { now: T0 }).needs, false)
  assert.equal(valuationNeed({ score_computed_at: day(31) }, { now: T0 }).reason, 'engine_row_stale_30d')
  assert.equal(valuationNeed({ score_computed_at: '2026-09-01T00:00:00Z' }, { now: T0 }).reason, 'engine_row_predates_offer_policy')
  assert.equal(valuationNeed({ score_computed_at: day(5), asking_price: 150000, updated_at: day(1) }, { now: T0 }).reason, 'ask_newer_than_engine_row')
  assert.equal(classifyValuationCandidate(row({ property_id: 'x', is_suppressed: true }), { now: T0 }).reason, 'excluded:suppressed')
  assert.equal(classifyValuationCandidate(row({ property_id: 'x', intents: ['wrong_number'] }), { now: T0 }).reason, 'excluded:wrong_number')
  assert.equal(classifyValuationCandidate(row({ property_id: 'x', intents: ['property_specific_non_owner'] }), { now: T0 }).reason, 'excluded:ownership_denied')
  assert.equal(classifyValuationCandidate(row({ property_id: 'x', status: 'dead' }), { now: T0 }).reason, 'excluded:not_live_no_recovery_finding')
  assert.equal(classifyValuationCandidate(row({ property_id: 'x', asking_price: 7, intents: ['seller_interested'] }), { now: T0 }).class, 'investigate_missing_financials', 'an implausible ask is not "motivated plausible"')
  const q = buildValuationQueue([row({ property_id: 'p1' }), row({ property_id: 'p1', intents: ['asks_offer'] }), row({ property_id: 'p9', score_computed_at: day(2) })], { now: T0, limit: 10 })
  assert.deepEqual(q.entries.map((e) => [e.property_id, e.class]), [['p1', 'offer_request']])
  assert.equal(q.excluded['current:engine_row_current'], 1)
  assert.equal(buildValuationQueue(Array.from({ length: 300 }, (_, i) => row({ property_id: `p${i}` })), { now: T0, limit: 999 }).entries.length, 200, 'bounded')
})

// a supabase-shaped fake that records every call (reads answer from tables; any write is recorded)
function fakeClient(tables = {}) {
  const calls = []
  const builder = (table) => {
    const q = { table, filters: [] }
    const self = {
      select: () => self, eq: (k, v) => { q.filters.push([k, v]); return self }, in: () => self, order: () => self, limit: () => self, gte: () => self, not: () => self,
      maybeSingle: async () => { calls.push(['read', table]); const rows = (tables[table] || []).filter((r) => q.filters.every(([k, v]) => String(r[k]) === String(v))); return { data: rows[0] || null, error: null } },
      then: (res, rej) => { calls.push(['read', table]); return Promise.resolve({ data: tables[table] || [], error: null }).then(res, rej) },
      insert: () => { calls.push(['WRITE', table, 'insert']); return self }, upsert: () => { calls.push(['WRITE', table, 'upsert']); return self },
      update: () => { calls.push(['WRITE', table, 'update']); return self }, delete: () => { calls.push(['WRITE', table, 'delete']); return self },
    }
    return self
  }
  return { calls, from: builder, rpc: async (name) => { calls.push(['rpc', name]); return { data: [], error: null } } }
}

test('write-refusing client: insert / upsert / update / delete and a non-allowlisted RPC throw; reads pass through', async () => {
  const c = fakeClient({ properties: [{ property_id: '1' }] })
  const { client, stats } = createWriteRefusingClient(c)
  for (const m of ['insert', 'upsert', 'update', 'delete']) assert.throws(() => client.from('property_acquisition_scores')[m]({}), /VALUATION_DRY_RUN_WRITE_REFUSED/)
  assert.throws(() => client.from('properties').select('*').eq('property_id', '1').upsert({}), /VALUATION_DRY_RUN_WRITE_REFUSED/, 'a chained builder stays guarded')
  assert.throws(() => client.rpc('persist_something', {}), /VALUATION_DRY_RUN_WRITE_REFUSED/)
  assert.deepEqual((await client.from('properties').select('*').eq('property_id', '1').maybeSingle()).data, { property_id: '1' })
  await client.rpc('get_comp_candidates_for_subject', {})
  assert.equal(stats.refused, 6)
  assert.equal(c.calls.filter((x) => x[0] === 'WRITE').length, 0, 'no write ever reached the client')
})

test('dry run: the EXISTING entry point runs the engine; the row is captured unwritten; no snapshot; production tables untouched', async () => {
  const c = fakeClient({ properties: [{ property_id: '42', estimated_value: 200000, property_type: 'Single Family Residential', units_count: 1 }], property_acquisition_scores: [] })
  let engineCalls = 0
  const scoreProperty = async (id, deps) => {
    engineCalls += 1
    assert.equal(typeof deps.persistAcquisitionScore, 'function')
    const row = { ...score({ repairs: 9000 }), property_id: id, computed_at: new Date(T0).toISOString() }
    const saved = await deps.persistAcquisitionScore(row, deps)
    const snap = await deps.persistImmutableScoreSnapshot(row, null, deps, 'snap-x')
    assert.equal(snap, null, 'no immutable snapshot in a dry run')
    return { ok: true, score: saved, snapshot_id: null }
  }
  const r = await runValuationRefresh({ property_id: '42', client: c, ensure: ensurePropertyAcquisitionDecision, now: new Date(T0), engineDeps: { scoreProperty } })
  assert.equal(engineCalls, 1)
  assert.deepEqual([r.ok, r.mode, r.status, r.ran, r.writes], [true, 'dry_run', 'recomputed', true, 0])
  assert.deepEqual([r.before.present, r.after.present, r.after.offer_ready, r.after.decision_tier], [false, true, true, 'AUTO_HARD_OFFER'])
  assert.equal(r.after.mao, 150000)
  assert.equal(r.after.owner_question, 'sfr_engine_subtracts_repairs_owner_lane_says_no_repairs', 'SFR row with engine repairs: the unresolved owner question is FLAGGED (formula untouched)')
  assert.equal(c.calls.filter((x) => x[0] === 'WRITE').length, 0, 'production tables never written')
  // a current row is reused, not recomputed
  const cur = fakeClient({ properties: [{ property_id: '42' }], property_acquisition_scores: [{ ...score(), property_id: '42', computed_at: new Date(T0 - 864e5).toISOString() }] })
  const r2 = await runValuationRefresh({ property_id: '42', client: cur, now: new Date(T0), engineDeps: { scoreProperty } })
  assert.equal(engineCalls, 1 + (r2.ran ? 1 : 0))
  assert.equal(cur.calls.filter((x) => x[0] === 'WRITE').length, 0)
})

test('dry run: the V3 comp loader client (deps.db) is the SAME write-refusing client — no fallback to the default service-role client', async () => {
  let seen = null
  const ensure = async (id, o) => { seen = o.deps; return { status: 'decision_engine_not_run_for_current_state', ran: false, decision: null } }
  await runValuationRefresh({ property_id: '7', client: fakeClient(), ensure, now: new Date(T0) })
  assert.ok(seen.db && seen.db === seen.supabase, 'deps.db is the guarded client')
  assert.throws(() => seen.db.from('property_acquisition_scores').upsert({}), /VALUATION_DRY_RUN_WRITE_REFUSED/)
})

test('write mode is gated: flag OFF by default; flag without an owner approval ref or a write client ⇒ refused', async () => {
  assert.equal(valuationWriteEnabled({}), false)
  assert.equal((await runValuationRefresh({ property_id: '1', client: fakeClient(), write: true, env: {} })).error, 'VALUATION_WRITE_DISABLED')
  assert.equal((await runValuationRefresh({ property_id: '1', client: fakeClient(), write: true, env: { VALUATION_REFRESH_WRITE_ENABLED: '1' } })).error, 'VALUATION_WRITE_NOT_APPROVED')
  assert.equal((await runValuationRefresh({ property_id: '1', client: fakeClient(), write: true, env: { VALUATION_REFRESH_WRITE_ENABLED: '1' }, writeAuthority: { approval_ref: 'apr_00000000-0000-4000-8000-000000000001' } })).error, 'VALUATION_WRITE_CLIENT_NOT_CONFIGURED')
  assert.deepEqual(summarizeEngineRow(null), { present: false })
})

function harness({ candidates, runDecision, extraCandidates = null, input = {} }) {
  let t = T0
  const store = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 1, tick_max_jobs: 1, lease_seconds: 120, backoff_base_seconds: 5, kind_limits: { [VALUATION_REFRESH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const handler = createValuationRefreshHandler({ source: { candidates: async () => candidates }, runDecision, extraCandidates, env: {}, now: () => t })
  const tick = (budgetMs = 25_000) => runRuntimeTick({ store, handlers: { [VALUATION_REFRESH_KIND]: handler }, workerId: 'w', budgetMs, now: () => t })
  return { store, tick, advance: (ms) => { t += ms }, enqueue: () => store.enqueue({ kind: VALUATION_REFRESH_KIND, idempotency_key: 'b'.repeat(64), input, requested_by: OP }) }
}

test('runtime job: processes the queue in priority order, one property per step; records agent-owned dry-run findings + the coverage gain; yields and resumes when the tick runs low', async () => {
  const order = []
  let clock = null
  const runDecision = async ({ property_id, write }) => {
    assert.equal(write, false)
    order.push(property_id)
    clock(2_000) // one engine run ≈ 2 s of the tick
    return { ok: true, ran: true, status: 'recomputed', before: { present: false }, after: { present: true, offer_ready: property_id !== 'p3', decision_tier: property_id !== 'p3' ? 'AUTO_RANGE_OFFER' : 'CREATIVE_TERMS', valuation_mid: 210000, mao: 150000 } }
  }
  const extra = async () => [{ property_id: 'p4', recovery_class: 'research_worthy', status: 'recovery' }]
  const h = harness({ candidates: [row({ property_id: 'p3', asking_price: 185000, intents: ['seller_interested'] }), row({ property_id: 'p1', stage: 'offer' }), row({ property_id: 'p2', intents: ['asks_offer'] })], runDecision, extraCandidates: extra })
  clock = h.advance
  const { job_id } = await h.enqueue()
  const s1 = await h.tick(9_000) // one property fits (per_property_min_ms 8 s), the second does not ⇒ yield
  assert.equal(s1.jobs[0].outcome, 'yield', JSON.stringify(s1))
  assert.equal(h.store._state.jobs.get(job_id).checkpoint.i, 1, 'the cursor is checkpointed after every property')
  assert.equal(h.store._state.jobs.get(job_id).attempt, 0, 'a yield burns no attempt')
  h.advance(6_000)
  const s2 = await h.tick(60_000)
  assert.equal(s2.jobs[0].outcome, 'completed', JSON.stringify(s2))
  assert.deepEqual(order, ['p1', 'p2', 'p3', 'p4'])
  const fs = [...h.store._state.findings.values()].filter((f) => f.job_id === job_id)
  const dry = fs.filter((f) => f.finding_type === 'valuation.dry_run')
  assert.equal(dry.length, 4)
  assert.ok(dry.every((f) => f.value.mode === 'dry_run' && f.value.writes === 0 && f.source_id === 'decision_engine.dry_run'))
  assert.ok(dry.every((f) => !JSON.stringify(f).includes('"p1"') || f.key.startsWith('property.pid_')), 'keys carry encoded refs')
  const batch = fs.find((f) => f.finding_type === 'valuation.refresh_batch').value
  assert.deepEqual([batch.queued, batch.gained_valuation, batch.gained_offer_ready, batch.after_offer_ready, batch.production_writes], [4, 4, 3, 3, 0])
  assert.deepEqual(batch.by_class, { active_negotiation: 1, offer_request: 1, motivated_plausible_ask: 1, recoverable_conversation: 1 })
})

test('runtime job: write input is refused (flag off / no approval) — never a production write from this kind by default; the wiring is absent without VALUATION_REFRESH_ENABLED', async () => {
  const h = harness({ candidates: [], runDecision: async () => ({ ok: true }), input: { write: true } })
  const { job_id } = await h.enqueue()
  await h.tick()
  assert.deepEqual([h.store._state.jobs.get(job_id).state, h.store._state.jobs.get(job_id).last_error.code], ['failed', 'VALUATION_WRITE_DISABLED'])
  const store = createRuntimeMemoryStore({ now: () => T0 })
  const reads = createMissionMemoryReads(store, { members: [], now: () => T0 })
  assert.equal(buildMissionHandlers({ env: {}, runtimeStore: store, reads })[VALUATION_REFRESH_KIND], undefined)
  assert.ok(buildMissionHandlers({ env: {}, runtimeStore: store, reads, valuationRefresh: { source: { candidates: async () => [] }, runDecision: async () => ({}) } })[VALUATION_REFRESH_KIND])
  // recovery linkage → valuation candidates (encoded refs decoded)
  const c = await recoveryValuationCandidates({ latestFinding: async () => ({ value: { valuation_requests: [{ property_ref: encodePropertyRef('2127709832'), recovery_class: 'research_worthy' }] } }) })
  assert.deepEqual(c, [{ property_id: '2127709832', recovery_class: 'research_worthy', status: 'recovery' }])
})
