// Agent S1 — cost accounting: reserve before every billable op, settle/reconcile,
// hard caps, Quick Scan structurally $0, one shared org pool.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createInMemoryAgentStore } from '../../src/lib/agent/runtime/store.js'
import { createRunService } from '../../src/lib/agent/runtime/run-service.js'
import { createBudgetLedger } from '../../src/lib/agent/budget/ledger.js'
import { DEFAULT_BUDGET_CONFIG, resolveBudgetConfig } from '../../src/lib/agent/budget/budget-config.js'
import { worstCaseUsd, actualUsd, DEFAULT_PRICE_BOOK } from '../../src/lib/agent/budget/price-book.js'
import { resolveSpendCaps } from '../../src/lib/agent/budget/spend-guard.js'

// Gate B: these S1 ledger tests exercise the cap ladder, so they run with the
// spend guard at its CODE CEILINGS (the owner has set nothing; production
// default is $0 — see agent-gate-b.test.mjs) and with verified named operators.
const CEILING_CAPS = resolveSpendCaps({ AGENT_SPEND_USER_DAILY_USD: '50', AGENT_SPEND_GLOBAL_DAILY_USD: '50', AGENT_TOKENS_USER_DAILY: '100000000', AGENT_TOKENS_GLOBAL_DAILY: '100000000' })
const verified = (user_id) => ({ verified: true, named: true, user_id, method: 'test' })

const T0 = Date.parse('2026-10-08T15:00:00Z')
function clock() {
  let t = T0
  return { now: () => new Date(t), advance: (ms) => { t += ms } }
}

// Haiku: 1/5 per MTok. 10k in + 1k out = 0.01 + 0.005 = 0.015
const haiku = (inTok = 10_000, outTok = 1_000) => ({ op_type: 'model', provider: 'anthropic', model: 'claude-haiku-4-5', max_input_tokens: inTok, max_tokens: outTok })

async function setup(cfg = DEFAULT_BUDGET_CONFIG) {
  const c = clock()
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store, budgetConfig: cfg, now: c.now, activeRunLimit: 100 })
  const createRun = runs.createRun
  runs.createRun = (input) => createRun({ identity: verified(input.operator_id), ...input })
  const ledger = createBudgetLedger({ store, config: cfg, now: c.now, spendCaps: CEILING_CAPS })
  return { c, store, runs, ledger }
}

test('owner caps are the configured defaults', () => {
  const c = DEFAULT_BUDGET_CONFIG
  assert.deepEqual({ ...c.research.per_property_usd }, { quick: 0, deep: 0.75, diligence: 2 })
  assert.equal(c.research.per_batch_usd, 25)
  assert.equal(c.research.concurrency, 2)
  assert.equal(c.research.max_queued_per_batch, 50)
  assert.equal(c.conversation.per_response_usd, 0.05)
  assert.equal(c.conversation.per_run_usd, 0.5)
  assert.equal(c.task.per_run_usd, 1)
  assert.deepEqual({ ...c.non_research }, { per_day_usd: 15, per_month_usd: 60 })
  assert.deepEqual({ ...c.org }, { per_day_usd: 50, per_month_usd: 200 })
  assert.equal(c.per_operator_day_usd, null)
})

test('caps can be lowered, never raised; Quick Scan stays 0; test_batch_mode cannot be lifted by config', () => {
  const lowered = resolveBudgetConfig({ org: { per_day_usd: 10 }, research: { per_property_usd: { deep: 0.5 } } })
  assert.equal(lowered.org.per_day_usd, 10)
  assert.equal(lowered.research.per_property_usd.deep, 0.5)
  assert.throws(() => resolveBudgetConfig({ org: { per_day_usd: 51 } }), (e) => e.code === 'BUDGET_CONFIG_RAISE_REFUSED')
  assert.throws(() => resolveBudgetConfig({ research: { per_property_usd: { quick: 0.01 } } }), (e) => e.code === 'BUDGET_CONFIG_RAISE_REFUSED')
  assert.throws(() => resolveBudgetConfig({ research: { test_batch_mode: false } }), (e) => e.code === 'BUDGET_CONFIG_RAISE_REFUSED')
})

test('run caps: lower-only against config', async () => {
  const { runs } = await setup()
  await assert.rejects(runs.createRun({ kind: 'conversation', operator_id: 'o', budget_cap_usd: 0.51 }), (e) => e.code === 'BUDGET_CAP_ABOVE_CONFIG')
  await assert.rejects(runs.createRun({ kind: 'task', operator_id: 'o', budget_cap_usd: 1.01 }), (e) => e.code === 'BUDGET_CAP_ABOVE_CONFIG')
  await assert.rejects(runs.createRun({ kind: 'research', depth: 'quick', operator_id: 'o', budget_cap_usd: 0.01 }), (e) => e.code === 'BUDGET_CAP_ABOVE_CONFIG')
  await assert.rejects(runs.createRun({ kind: 'research', depth: 'deep', property_count: 40, operator_id: 'o', budget_cap_usd: 25.01 }), (e) => e.code === 'BUDGET_CAP_ABOVE_CONFIG')
  const r = await runs.createRun({ kind: 'research', depth: 'diligence', property_count: 5, operator_id: 'o' })
  assert.equal(r.budget_cap_usd, 10)
})

test('price book is config: worst case assumes no cache discount; unpriced ops are refused', () => {
  assert.equal(worstCaseUsd(haiku()).usd, 0.015)
  assert.equal(worstCaseUsd({ ...haiku(), model: 'claude-sonnet-5' }).usd, 0.03)
  assert.equal(worstCaseUsd({ ...haiku(), batch: true }).usd, 0.0075)
  assert.throws(() => worstCaseUsd({ ...haiku(), model: 'gpt-9' }), (e) => e.code === 'UNPRICED_OP')
  assert.throws(() => worstCaseUsd({ op_type: 'model', provider: 'anthropic', model: 'claude-haiku-4-5' }), (e) => e.code === 'UNBOUNDED_OP')
  assert.throws(() => worstCaseUsd({ op_type: 'teleport' }), (e) => e.code === 'UNPRICED_OP')
  // actuals: provider usage × price book (cache read 0.1×)
  assert.equal(actualUsd(haiku(), { input_tokens: 1000, cache_read_input_tokens: 10_000, output_tokens: 200 }, DEFAULT_PRICE_BOOK), 0.003)
})

test('Quick Scan is structurally $0: any reserve on a quick run is refused, whatever the amount', async () => {
  const { runs, ledger, store } = await setup()
  const run = await runs.createRun({ kind: 'research', depth: 'quick', property_count: 10, operator_id: 'o' })
  assert.equal(run.budget_cap_usd, 0)
  const r = await ledger.reserve({ run_id: run.id, property_id: 'p1', op: haiku(1, 1), route: 'research.extract_structured' })
  assert.deepEqual([r.ok, r.code], [false, 'QUICK_SCAN_BILLABLE_REFUSED'])
  assert.equal(store.read().ledger.length, 0, 'no ledger rows for a Quick Scan')
  assert.ok(store.read().events.some((e) => e.type === 'budget.stopped' && e.payload.binding_cap === 'per_property'))
})

test('research per-property cap ($0.75 deep): stops BEFORE the op that would exceed it', async () => {
  const { runs, ledger, store } = await setup()
  const run = await runs.createRun({ kind: 'research', depth: 'deep', property_count: 2, operator_id: 'o' })
  // 0.3 worst-case each (100k in, 40k out on haiku = 0.1 + 0.2)
  const big = haiku(100_000, 40_000)
  assert.equal(worstCaseUsd(big).usd, 0.3)
  assert.equal((await ledger.reserve({ run_id: run.id, property_id: 'p1', op: big, route: 'x' })).ok, true)
  assert.equal((await ledger.reserve({ run_id: run.id, property_id: 'p1', op: big, route: 'x' })).ok, true)
  const third = await ledger.reserve({ run_id: run.id, property_id: 'p1', op: big, route: 'x' })
  assert.deepEqual([third.ok, third.code, third.binding_cap], [false, 'BUDGET_EXCEEDED', 'per_property'])
  // other property still has its own budget
  assert.equal((await ledger.reserve({ run_id: run.id, property_id: 'p2', op: big, route: 'x' })).ok, true)
  const stop = store.read().events.filter((e) => e.type === 'budget.stopped').pop()
  assert.equal(stop.payload.binding_cap, 'per_property')
  assert.equal(store.read().ledger.filter((r) => r.kind === 'reserve').length, 3)
})

test('diligence $2.00 per property and the $25 batch cap', async () => {
  const { runs, ledger } = await setup()
  const run = await runs.createRun({ kind: 'research', depth: 'diligence', property_count: 50, operator_id: 'o' })
  assert.equal(run.budget_cap_usd, 25)
  const op = haiku(300_000, 340_000) // 0.3 + 1.7 = 2.0
  assert.equal(worstCaseUsd(op).usd, 2)
  let ok = 0
  let last
  for (let i = 0; i < 14; i += 1) {
    last = await ledger.reserve({ run_id: run.id, property_id: `p${i}`, op, route: 'x' })
    if (last.ok) ok += 1
  }
  assert.equal(ok, 12) // 12 × $2 = $24; the 13th would exceed $25
  assert.equal(last.binding_cap, 'per_batch')
})

test('non-research: $0.05 per response, $0.50 per conversation task, $1 per background task', async () => {
  const { runs, ledger } = await setup()
  const conv = await runs.createRun({ kind: 'conversation', operator_id: 'o' })
  const tooBig = haiku(40_000, 3_000) // 0.04 + 0.015 = 0.055
  const r = await ledger.reserve({ run_id: conv.id, op: tooBig, route: 'agent.turn' })
  assert.deepEqual([r.ok, r.binding_cap], [false, 'per_response'])
  const op = haiku(40_000, 2_000) // 0.05
  let n = 0
  for (let i = 0; i < 12; i += 1) if ((await ledger.reserve({ run_id: conv.id, op, route: 'agent.turn' })).ok) n += 1
  assert.equal(n, 10) // $0.50
  const task = await runs.createRun({ kind: 'task', operator_id: 'o' })
  let m = 0
  let last
  for (let i = 0; i < 25; i += 1) { last = await ledger.reserve({ run_id: task.id, op, route: 'agent.turn' }); if (last.ok) m += 1 }
  assert.equal(m, 20) // $1.00
  assert.equal(last.binding_cap, 'per_background_task')
})

test('non-research AI shares a $15/day sub-cap; all AI shares $50/day (one pool)', async () => {
  const { runs, ledger, c } = await setup()
  const op = haiku(40_000, 2_000) // 0.05
  let spent = 0
  // 30 background tasks × $0.50 = $15 non-research
  for (let i = 0; i < 31; i += 1) {
    const t = await runs.createRun({ kind: 'task', operator_id: 'o' })
    for (let j = 0; j < 10; j += 1) {
      const r = await ledger.reserve({ run_id: t.id, op, route: 'agent.turn' })
      if (r.ok) spent += 0.05
      else { assert.equal(r.binding_cap, 'non_research_day'); break }
    }
  }
  assert.equal(Math.round(spent * 100) / 100, 15)
  // research still has room under the org $50/day
  const rr = await runs.createRun({ kind: 'research', depth: 'diligence', property_count: 50, operator_id: 'o' })
  const big = haiku(300_000, 340_000) // $2
  let research = 0
  for (let i = 0; i < 20; i += 1) if ((await ledger.reserve({ run_id: rr.id, property_id: `p${i}`, op: big, route: 'x' })).ok) research += 2
  assert.equal(research, 24) // batch cap binds first
  const rr2 = await runs.createRun({ kind: 'research', depth: 'diligence', property_count: 50, operator_id: 'o' })
  let r2 = 0
  let last
  for (let i = 0; i < 20; i += 1) { last = await ledger.reserve({ run_id: rr2.id, property_id: `q${i}`, op: big, route: 'x' }); if (last.ok) r2 += 2 }
  assert.equal(15 + 24 + r2 <= 50, true)
  assert.equal(last.binding_cap, 'org_day')
  // next day the day caps reset; month keeps counting
  c.advance(24 * 3600 * 1000)
  const t = await runs.createRun({ kind: 'task', operator_id: 'o' })
  assert.equal((await ledger.reserve({ run_id: t.id, op, route: 'agent.turn' })).ok, true)
})

test('settle records actuals; over-reserve flags cost_not_precisely_bounded; double settle refused', async () => {
  const { runs, ledger, store } = await setup()
  const run = await runs.createRun({ kind: 'conversation', operator_id: 'o' })
  const r = await ledger.reserve({ run_id: run.id, op: haiku(10_000, 1_000), route: 'agent.turn' })
  const s = await ledger.settle({ reserve_id: r.reserve_id, usage: { input_tokens: 2_000, cache_read_input_tokens: 8_000, output_tokens: 300 } })
  assert.equal(s.actual_usd, 0.0043) // 0.002 + 0.0008 + 0.0015
  assert.equal(runs.getRun(run.id).accrued_usd, 0.0043)
  assert.equal(runs.getRun(run.id).open_reserve_usd, 0)
  await assert.rejects(ledger.settle({ reserve_id: r.reserve_id, usage: {} }), (e) => e.code === 'ALREADY_SETTLED')
  const r2 = await ledger.reserve({ run_id: run.id, op: haiku(10_000, 1_000), route: 'agent.turn' })
  await ledger.settle({ reserve_id: r2.reserve_id, usage: { input_tokens: 20_000, output_tokens: 1_000 } }) // more than reserved
  assert.equal(runs.getRun(run.id).cost_not_precisely_bounded, true)
  const types = store.read().events.filter((e) => e.run_id === run.id).map((e) => e.type)
  assert.ok(types.includes('usage.reserved') && types.includes('usage.settled'))
  const display = ledger.costDisplay(run.id)
  assert.equal(display.models_enabled, false)
  assert.equal(display.flags.cost_not_precisely_bounded, true)
  assert.ok(display.caps.some((c) => c.cap_key === 'org_day'))
})

test('crash sweep settles open reserves AT RESERVE VALUE (never under-records)', async () => {
  const { runs, ledger, c } = await setup()
  const run = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const r = await ledger.reserve({ run_id: run.id, op: haiku(), route: 'agent.turn' })
  assert.deepEqual(await ledger.sweep({ max_age_ms: 60_000 }), [])
  c.advance(61_000)
  assert.deepEqual(await ledger.sweep({ max_age_ms: 60_000 }), [r.reserve_id])
  assert.equal(runs.getRun(run.id).accrued_usd, 0.015)
})

test('allowance sources: reserve allowance, late_settle, flag; unbounded sources are refused', async () => {
  const { runs, ledger } = await setup()
  const run = await runs.createRun({ kind: 'research', depth: 'deep', operator_id: 'o' })
  const u = await ledger.reserve({ run_id: run.id, property_id: 'p', op: { op_type: 'paid_lookup', provider: 'licensed', fee_usd: 0.1 }, route: 'x', cost_bound: 'unbounded' })
  assert.equal(u.code, 'UNBOUNDED_SOURCE_DISABLED')
  const a = await ledger.reserve({ run_id: run.id, property_id: 'p', op: { op_type: 'provider_fee', provider: 'licensed' }, route: 'x', cost_bound: 'allowance', allowance_usd: 0.2 })
  assert.equal(a.ok, true)
  assert.equal(runs.getRun(run.id).cost_not_precisely_bounded, true)
  await assert.rejects(ledger.settle({ reserve_id: a.reserve_id }), (e) => e.code === 'ALLOWANCE_REQUIRES_LATE_SETTLE')
  assert.equal(ledger.costDisplay(run.id).actual.pending_late_usd, 0.2)
  await ledger.lateSettle({ reserve_id: a.reserve_id, actual_usd: 0.12 })
  assert.equal(runs.getRun(run.id).accrued_usd, 0.12)
})

test('unpriced op → refused before any call, with budget.stopped', async () => {
  const { runs, ledger, store } = await setup()
  const run = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const r = await ledger.reserve({ run_id: run.id, op: { ...haiku(), model: 'unknown-model' }, route: 'x' })
  assert.equal(r.code, 'UNPRICED_OP')
  assert.equal(store.read().ledger.length, 0)
})

test('reconcile records the discrepancy (never absorbed) and it counts toward committed', async () => {
  const { runs, ledger, store } = await setup()
  const run = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const r = await ledger.reserve({ run_id: run.id, op: haiku(), route: 'agent.turn' })
  await ledger.settle({ reserve_id: r.reserve_id, usage: { input_tokens: 10_000, output_tokens: 1_000 } })
  const rec = await ledger.reconcile({ provider: 'anthropic', day: '2026-10-08', provider_total_usd: 0.02, run_id_for_attribution: run.id })
  assert.equal(rec.discrepancy_usd, 0.005)
  const row = store.read().ledger.find((x) => x.kind === 'reconcile')
  assert.equal(row.discrepancy_usd, 0.005)
})
