// 8.5.21-b — event-triggered research: the pure turn-engine hook, and a property.research job
// split into checkpointed steps that each fit the runtime tick (yield + resume), a bounded web
// step (≤ 20 s per model call, resumed on timeout), the per-job budget (skip, never park),
// provenance on every finding, and listings that never become sales.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionMemoryReads, PROPERTY_RESEARCH_KIND } from '../../src/lib/agent/missions/index.js'
import { createPropertyResearchHandler, PROPERTY_RESEARCH_LIMITS } from '../../src/lib/agent/missions/property-research-handler.js'
import { researchTriggerFromTurn, enqueueResearchForTurn, TURN_RESEARCH_TRIGGERS } from '../../src/lib/agent/missions/research-trigger-hook.js'
import { enqueuePropertyResearch } from '../../src/lib/agent/missions/property-research-triggers.js'
import { decodeFromStore } from '../../src/lib/agent/research/pii.js'
import { PID, memorySource, score } from '../helpers/property-research-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const T0 = Date.parse('2026-10-16T15:00:00.000Z')
const ON = { PROPERTY_RESEARCH_ENABLED: '1' }
// paid calls are DEFAULT-DENY (owner decision 3): the web tests run with an explicit (test) approval
const APPROVED = { RESEARCH_PAID_CALLS_APPROVED: '1', RESEARCH_PAID_APPROVAL_REF: 'apr_00000000-0000-4000-8000-0000000000aa' }
const WEB_ON = { ...ON, AGENT_WEB_RESEARCH_ENABLED: '1', ...APPROVED }
const ledgerWithAsk = (amount) => ({ asking_price: { current: { value: { amount }, origin: 'seller_stated', source_message_id: 'm1' }, history: [{ value: { amount }, origin: 'seller_stated', source_message_id: 'm1', at: '2026-10-16T14:00:00Z' }] } })

// ── the pure hook ───────────────────────────────────────────────────────────
test('hook: one trigger per meaningful inbound, strongest first; pure (same input ⇒ same output)', () => {
  const base = { property_id: PID, now: T0 }
  assert.equal(researchTriggerFromTurn({ ...base, intents: ['seller_interested'] }).trigger, 'seller_interest')
  assert.equal(researchTriggerFromTurn({ ...base, intents: ['asking_price_provided'], ledger_after: ledgerWithAsk(185000) }).trigger, 'asking_price_revealed')
  assert.equal(researchTriggerFromTurn({ ...base, intents: ['asking_price_provided'], ledger_before: ledgerWithAsk(185000), ledger_after: ledgerWithAsk(185000) }).trigger, null, 'an unchanged ask is not a new event')
  assert.equal(researchTriggerFromTurn({ ...base, intents: ['asks_offer', 'seller_interested'] }).trigger, 'offer_request')
  assert.equal(researchTriggerFromTurn({ ...base, decision_outcome: 'PREPARE_OFFER' }).trigger, 'offer_request')
  const counter = researchTriggerFromTurn({ ...base, intents: ['asking_price_provided', 'asks_offer'], seller_request: { kind: 'counter', amount: 172000 }, our_last_offer: 150000 })
  assert.deepEqual([counter.trigger, counter.discriminator, counter.priority], ['counteroffer', 'counter:172000', 100])
  assert.equal(researchTriggerFromTurn({ ...base, ledger_before: ledgerWithAsk(190000), ledger_after: ledgerWithAsk(180000), our_last_offer: 150000 }).trigger, 'counteroffer', 'a new seller number after our offer is a counter')
  assert.deepEqual(TURN_RESEARCH_TRIGGERS, ['counteroffer', 'offer_request', 'asking_price_revealed', 'seller_interest'])
  const e = { ...base, intents: ['seller_interested'] }
  assert.deepEqual(researchTriggerFromTurn(e), researchTriggerFromTurn(e))
  // the day bucket comes from the turn clock, never the wall clock
  assert.equal(researchTriggerFromTurn(e).discriminator, 'interest:2026-10-16')
})

test('hook: stop, wrong number, ownership denial, hostile, a suppressing plan or no property ⇒ never a trigger', () => {
  for (const i of ['opt_out', 'wrong_number', 'property_specific_non_owner', 'former_owner_respondent', 'hostile_or_legal']) {
    assert.equal(researchTriggerFromTurn({ property_id: PID, intents: ['seller_interested', i], now: T0 }).trigger, null, i)
  }
  assert.equal(researchTriggerFromTurn({ property_id: PID, intents: ['asks_offer'], actions: [{ type: 'SUPPRESS' }], now: T0 }).reason, 'plan_suppresses')
  assert.equal(researchTriggerFromTurn({ property_id: null, intents: ['asks_offer'], now: T0 }).reason, 'no_property_in_scope')
  assert.equal(researchTriggerFromTurn({ property_id: PID, intents: ['acknowledgement'], now: T0 }).trigger, null)
})

test('hook enqueue: OFF without PROPERTY_RESEARCH_ENABLED; refused until the kind is armed; deduped per (trigger, property, discriminator)', async () => {
  const store = createRuntimeMemoryStore({ now: () => T0, limits: { runtime_enabled: true, kind_limits: {} } })
  const ev = { property_id: PID, intents: ['asks_offer'], now: T0 }
  assert.deepEqual(await enqueueResearchForTurn(ev, { store, env: {} }), { ok: false, reason: 'PROPERTY_RESEARCH_DISABLED' })
  assert.equal((await enqueueResearchForTurn(ev, { store, env: ON })).reason, 'kind_not_armed')
  store.setLimits({ kind_limits: { [PROPERTY_RESEARCH_KIND]: { enabled: false, armed_by: OP } } })
  const a = await enqueueResearchForTurn(ev, { store, env: ON })
  const b = await enqueueResearchForTurn(ev, { store, env: ON })
  assert.ok(a.ok && !a.deduped && a.trigger === 'offer_request')
  assert.ok(b.ok && b.deduped && b.job_id === a.job_id)
  const j = store._state.jobs.get(a.job_id)
  assert.equal(j.priority, 105)
  assert.ok(!JSON.stringify(j.input).includes(PID), 'the job input carries the encoded ref only')
  assert.deepEqual(await enqueueResearchForTurn({ ...ev, intents: ['opt_out'] }, { store, env: ON }), { ok: false, reason: 'NO_TRIGGER', detail: 'blocking_intent:opt_out' })
})

// ── the resumable job ───────────────────────────────────────────────────────
function harness({ budget = 0.30, ceiling = 0.30, limits = {}, buildAsk = null, env = WEB_ON, minAskMs = null, source = memorySource() } = {}) {
  let t = T0
  const now = () => t
  const store = createRuntimeMemoryStore({ now, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 1, lease_seconds: 120, backoff_base_seconds: 5, event_budget_ceilings: { [PROPERTY_RESEARCH_KIND]: ceiling }, kind_limits: { [PROPERTY_RESEARCH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP, event_budget_cap_usd: budget } } }, research: { enabled: true, day_usd: 5, run_usd: 2.5 } })
  const reads = createMissionMemoryReads(store, { members: [{ org_id: 'org', user_id: OP, role: 'owner' }], now })
  const handler = createPropertyResearchHandler({ source, reads, buildAsk, env, now, minAskMs, limits })
  const tick = (budgetMs = 25_000) => runRuntimeTick({ store, handlers: { [PROPERTY_RESEARCH_KIND]: handler }, workerId: 'w1', budgetMs, now, concurrent: false })
  return { store, reads, tick, advance: (ms) => { t += ms } }
}
const fakeAsk = ({ answer = null, hang = false, reserveUsd = 0, onAsk = () => {} } = {}) => {
  const calls = []
  return {
    calls,
    buildAsk: ({ store }) => ({
      async ask(args) {
        calls.push({ ...args, run_cap_seen: (await store.limits()).run_usd })
        onAsk(args)
        if (reserveUsd) await store.reserve({ model: 'claude-haiku-test', purpose: 'default', reserved_usd: reserveUsd })
        if (hang) return { run_id: `r${calls.length}`, done: new Promise(() => {}) }
        return { run_id: `r${calls.length}`, done: Promise.resolve({ state: 'completed', answer_md: answer, cost_usd: 0.02, result: { evidence: { public_web: [{ url: 'https://listings.example.com/subject', retrieved_at: '2026-10-16T15:00:00Z' }] } } }) }
      },
      cancel() {},
    }),
  }
}
const ANSWER = '```json\n{"items":[{"topic":"subject_listing","status":"active","list_price":259900,"days_on_market":30,"url":"https://listings.example.com/subject"}]}\n```'
const job = (h, id) => h.store._state.jobs.get(id)
const findings = (h, id) => [...h.store._state.findings.values()].filter((f) => f.job_id === id)

test('resumable: the web step does not fit this tick ⇒ the job YIELDS after the internal step (no attempt burned) and finishes web + findings in the next tick', async () => {
  const ask = fakeAsk({ answer: ANSWER })
  const h = harness({ buildAsk: ask.buildAsk, limits: { web_call_reserve_usd: 0.02 } })
  const { job_id } = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'offer_request', property_id: PID, discriminator: 'offer_request:2026-10-16' })
  assert.equal(job(h, job_id).budget_cap_usd, 0.30, 'event job budget = armed amount clamped by the per-kind ceiling')
  const s1 = await h.tick(15_000) // < web_step_min_ms (21 s)
  assert.equal(s1.jobs[0].outcome, 'yield', JSON.stringify(s1))
  assert.equal(job(h, job_id).attempt, 0, 'a yield burns no attempt')
  assert.equal(job(h, job_id).checkpoint.phase, 'web')
  assert.equal(ask.calls.length, 0)
  assert.equal(findings(h, job_id).length, 0)
  h.advance(6_000)
  const s2 = await h.tick(25_000)
  assert.equal(s2.jobs[0].outcome, 'completed', JSON.stringify(s2))
  assert.equal(ask.calls.length, 1)
  // the per-model-call timeout never exceeds 20 s; the step never exceeds 22 s
  assert.ok(ask.calls[0].limits.model_timeout_ms <= PROPERTY_RESEARCH_LIMITS.model_call_timeout_ms)
  assert.ok(ask.calls[0].limits.run_timeout_ms <= PROPERTY_RESEARCH_LIMITS.web_step_max_ms)
  assert.equal(ask.calls[0].limits.max_model_calls, 2, 'search + answer (the ask service answers without tools on its last call)')
  assert.equal(ask.calls[0].run_cap_seen, 0.30, "the ask service's per-run cap is the job budget (refused before reserving, never parked)")
  const r = job(h, job_id).result
  assert.deepEqual([r.web.status, r.yields, r.sends], ['completed', 1, 0])
})

test('resumable: a timed-out web step is cancelled, checkpointed and RESUMED next tick; after web_attempts_max the job completes on internal evidence', async () => {
  const ask = fakeAsk({ hang: true })
  const h = harness({ buildAsk: ask.buildAsk, limits: { web_call_reserve_usd: 0.02, web_step_max_ms: 40 }, minAskMs: 0 })
  const { job_id } = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'counteroffer', property_id: PID, discriminator: 'counter:172000' })
  const s1 = await h.tick()
  assert.equal(s1.jobs[0].outcome, 'yield', JSON.stringify(s1))
  assert.equal(job(h, job_id).checkpoint.web_attempts, 1)
  assert.equal(job(h, job_id).checkpoint.web_last_timeout, 'WEB_STEP_TIMEOUT')
  h.advance(6_000)
  const s2 = await h.tick()
  assert.equal(s2.jobs[0].outcome, 'completed', JSON.stringify(s2))
  assert.equal(ask.calls.length, 2, 'exactly web_attempts_max attempts')
  const r = job(h, job_id).result
  assert.equal(r.web.status, 'timed_out')
  assert.equal(r.web.attempts, 2)
  assert.deepEqual(findings(h, job_id).map((f) => f.finding_type).sort(), ['property.comps_area', 'property.dossier', 'property.economics', 'property.offer_plan', 'property.research', 'research.usage'], 'internal findings are never lost to a web timeout')
})

test('budget: at the 0.05 default ceiling one web call (0.26 reserve) does not fit ⇒ skipped_budget, internal findings recorded, never budget_blocked', async () => {
  const ask = fakeAsk({ answer: ANSWER })
  const h = harness({ buildAsk: ask.buildAsk, ceiling: 0.05, minAskMs: 0 })
  const { job_id } = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:185000' })
  assert.equal(job(h, job_id).budget_cap_usd, 0.05)
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  assert.equal(ask.calls.length, 0)
  const r = job(h, job_id).result
  assert.equal(r.web.status, 'skipped_budget')
  assert.equal(job(h, job_id).checkpoint.web.budget.cap_usd, 0.05)
  assert.equal(findings(h, job_id).length, 6)
  assert.notEqual(job(h, job_id).state, 'budget_blocked')
})

test('budget: a timed-out attempt that reserved 0.26 of a 0.30 job budget leaves no room ⇒ the resume skips the second web call (spend counted across attempts)', async () => {
  const ask = fakeAsk({ hang: true, reserveUsd: 0.26 })
  const h = harness({ buildAsk: ask.buildAsk, limits: { web_step_max_ms: 40 }, minAskMs: 0 })
  const { job_id } = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'offer_request', property_id: PID, discriminator: 'offer_request:x' })
  await h.tick()
  assert.equal(ask.calls.length, 1)
  assert.ok(h.store._state.ledger.some((l) => l.job_id === job_id && l.state === 'unknown'), 'the unsettled reserve counts (unknown)')
  h.advance(6_000)
  const s2 = await h.tick()
  assert.equal(s2.jobs[0].outcome, 'completed', JSON.stringify(s2))
  assert.equal(ask.calls.length, 1, 'no second call past the job budget')
  assert.equal(job(h, job_id).result.web.status, 'skipped_budget')
  const committed = h.store._state.ledger.filter((l) => l.job_id === job_id).reduce((a, l) => a + l.reserved_usd, 0)
  assert.ok(committed <= job(h, job_id).budget_cap_usd, 'never above the job cap')
})

test('provenance + listings ≠ sales: every finding names its source; the web listing stays a listing; the offer plan stays internal; the ZIP prior is labelled', async () => {
  const ask = fakeAsk({ answer: ANSWER })
  const zipPriorFor = async ({ lane }) => ({ version: 'zip-prior.v1', available: true, level: 'county', label: 'fallback:county', precision: 'indicative_band', investor_discount_band: [0.1, 0.2], sample_size: 140, confidence: 0.5, last_update: '2026-10-15T00:00:00Z', source: 'public.zip_acquisition_economics (pooled)', cell: { property_type: lane === 'sfr' ? 'sfr' : lane } })
  let t = T0
  const store = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 1, tick_max_jobs: 1, lease_seconds: 120, backoff_base_seconds: 5, event_budget_ceilings: { [PROPERTY_RESEARCH_KIND]: 0.3 }, kind_limits: { [PROPERTY_RESEARCH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP, event_budget_cap_usd: 0.3 } } }, research: { enabled: true, day_usd: 5, run_usd: 2.5 } })
  const reads = createMissionMemoryReads(store, { members: [], now: () => t })
  const handler = createPropertyResearchHandler({ source: memorySource(), reads, buildAsk: ask.buildAsk, env: WEB_ON, now: () => t, minAskMs: 0, zipPriorFor, limits: { web_call_reserve_usd: 0.02 } })
  const { job_id } = await enqueuePropertyResearch({ store, env: ON, trigger: 'seller_interest', property_id: PID, discriminator: 'interest:2026-10-16' })
  await runRuntimeTick({ store, handlers: { [PROPERTY_RESEARCH_KIND]: handler }, workerId: 'w', budgetMs: 25_000, now: () => t })
  const fs = [...store._state.findings.values()].filter((f) => f.job_id === job_id)
  for (const f of fs) assert.match(f.source_id, /^(property_research\.|public_web$|agent\.spend_ledger$)/, f.finding_type)
  const web = JSON.parse(decodeFromStore(fs.find((f) => f.finding_type === 'property.web_evidence').value.payload_v1))
  assert.equal(web.listings[0].evidence_kind, 'listing')
  const comps = JSON.parse(decodeFromStore(fs.find((f) => f.finding_type === 'property.comps_area').value.payload_v1))
  assert.ok(!(comps.sections.comps.sold_median_price.value >= 259900), 'the list price never became a sale')
  const plan = JSON.parse(decodeFromStore(fs.find((f) => f.finding_type === 'property.offer_plan').value.payload_v1))
  assert.equal(plan.visibility, 'internal_only')
  assert.equal(plan.market_prior.label, 'fallback:county')
  assert.equal(plan.market_prior.role, 'context_not_an_offer')
  assert.ok(plan.opening.recommended < plan.mao.amount, 'MAO is a ceiling; the opening is below it')
  assert.ok(plan.market_prior.indicative.value_reference.source.startsWith('public.property_acquisition_scores'), 'the band is applied to a SOURCED value')
  // the owner question on the SFR repairs formula is flagged, the formula is untouched
  const repairsPlan = (await import('../../src/lib/domain/property-research/offer-plan.js')).planOffer({ valuation: score({ repairs: 12000 }), property: { property_type: 'Single Family Residential', units_count: 1 }, now: T0 })
  assert.ok(repairsPlan.notes.includes('owner_question:sfr_repairs_in_engine_formula_unresolved'))
})
