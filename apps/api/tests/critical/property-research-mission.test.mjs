// 8.5.20-b — mission kind property.research on the R2 runtime (memory twin): OFF by
// default (code flag + DB arming), event + sweep enqueue with de-dupe, the internal-first
// pipeline, the optional web step through the research ask machinery (citations
// required; listings stay listings; a resumed attempt never re-spends), findings that are
// contact-free and store-encoded, and nothing sent or granted.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { buildMissionHandlers, createMissionMemoryReads, MISSION_HANDLER_KINDS, OPERATOR_MISSION_KINDS, PROPERTY_RESEARCH_KIND } from '../../src/lib/agent/missions/index.js'
import { createPropertyResearchHandler } from '../../src/lib/agent/missions/property-research-handler.js'
import { enqueuePropertyResearch, sweepPropertyResearch, propertyResearchEventKey, PROPERTY_RESEARCH_TRIGGERS, PROPERTY_RESEARCH_SWEEP } from '../../src/lib/agent/missions/property-research-triggers.js'
import { encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'
import { decodeFromStore } from '../../src/lib/agent/research/pii.js'
import { PID, SECRET_NAME, SECRET_PHONE, memorySource } from '../helpers/property-research-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const T0 = Date.parse('2026-10-15T15:00:00.000Z')
const ON = { PROPERTY_RESEARCH_ENABLED: '1' }

function harness({ armed = true, env = ON, buildAsk = null, eventBudget = 0.05, source = memorySource({ inbound: [{ id: 'in-1', body: `I'd take 185000. text ${SECRET_PHONE}`, at: '2026-10-14T10:00:00Z' }] }) } = {}) {
  let t = T0
  const now = () => t
  const store = createRuntimeMemoryStore({ now, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 3, lease_seconds: 60, backoff_base_seconds: 5, kind_limits: armed ? { [PROPERTY_RESEARCH_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP, event_budget_cap_usd: eventBudget } } : {} }, research: { enabled: true, day_usd: 5, run_usd: 1 } })
  const reads = createMissionMemoryReads(store, { members: [{ org_id: 'org', user_id: OP, role: 'owner' }], now })
  const handlers = buildHandlers({ store, reads, env, buildAsk, source, now })
  const tick = () => runRuntimeTick({ store, handlers, workerId: 'w1', budgetMs: 30_000, now, concurrent: false })
  return { store, reads, handlers, tick, now, advance: (ms) => { t += ms } }
}
function buildHandlers({ store, reads, env, buildAsk, source, now }) {
  if (!buildAsk) return buildMissionHandlers({ env, runtimeStore: store, reads, propertyResearchSource: source, now })
  return { [PROPERTY_RESEARCH_KIND]: createPropertyResearchHandler({ source, reads, buildAsk, env, now, minAskMs: 0, limits: { web_call_reserve_usd: 0.02 } }) }
}
const findingsOf = (h, id) => [...h.store._state.findings.values()].filter((f) => f.job_id === id)

test('property.research is a handler kind, never operator-creatable; absent from the wiring unless a research source is given', () => {
  assert.ok(MISSION_HANDLER_KINDS.includes('property.research'))
  assert.ok(!OPERATOR_MISSION_KINDS.includes('property.research'))
  const store = createRuntimeMemoryStore({ now: () => T0 })
  const reads = createMissionMemoryReads(store, { members: [], now: () => T0 })
  assert.equal(buildMissionHandlers({ env: {}, runtimeStore: store, reads })[PROPERTY_RESEARCH_KIND], undefined)
  assert.deepEqual([...PROPERTY_RESEARCH_TRIGGERS], ['opportunity_entered', 'asking_price_revealed', 'valuation_stale_or_missing', 'new_comp_evidence', 'market_shift', 'recovery_finding', 'seller_interest', 'offer_request', 'counteroffer'])
})

test('OFF by default: no flag ⇒ nothing enqueued; flag but kind not armed ⇒ refused by the runtime', async () => {
  const off = harness({ env: {} })
  assert.deepEqual(await enqueuePropertyResearch({ store: off.store, env: {}, trigger: 'asking_price_revealed', property_id: PID }), { ok: false, reason: 'PROPERTY_RESEARCH_DISABLED' })
  assert.equal(off.store._state.jobs.size, 0)
  const sweptOff = await sweepPropertyResearch({ store: off.store, env: {}, sweepSource: { candidates: async () => { throw new Error('must not be read') } } })
  assert.equal(sweptOff.skipped, 'PROPERTY_RESEARCH_DISABLED')
  const unarmed = harness({ armed: false })
  const r = await enqueuePropertyResearch({ store: unarmed.store, env: ON, trigger: 'asking_price_revealed', property_id: PID })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'kind_not_armed')
  assert.equal((await enqueuePropertyResearch({ store: unarmed.store, env: ON, trigger: 'because', property_id: PID })).reason, 'TRIGGER_INVALID')
})

test('event enqueue dedupes on (trigger, property, discriminator); the stored input carries an encoded property ref, never the raw id', async () => {
  const h = harness()
  const a = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:185000' })
  const b = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:185000' })
  const c = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:175000' })
  assert.ok(a.ok && !a.deduped)
  assert.ok(b.ok && b.deduped && b.job_id === a.job_id)
  assert.ok(c.ok && !c.deduped && c.job_id !== a.job_id)
  const j = h.store._state.jobs.get(a.job_id)
  assert.equal(j.kind, 'property.research')
  assert.equal(j.requested_by, OP, 'event jobs run as the operator who armed the kind')
  assert.equal(j.input.property_ref, encodePropertyRef(PID))
  assert.ok(!JSON.stringify(j.input).includes(PID))
  assert.match(propertyResearchEventKey({ trigger: 'market_shift', property_id: PID, now: T0 }), /^[0-9a-f]{64}$/)
  const sw = await sweepPropertyResearch({ store: h.store, env: ON, sweepSource: { candidates: async () => [{ property_id: PID, trigger: 'valuation_stale_or_missing', discriminator: 'score:none' }, { property_id: PID, trigger: 'asking_price_revealed', discriminator: 'ask:185000' }] } })
  assert.deepEqual({ enqueued: sw.enqueued, deduped: sw.deduped }, { enqueued: 1, deduped: 1 })
})

test('run: internal-first research completes at $0 without web; findings are typed, contact-free and the offer plan is internal-only', async () => {
  const h = harness()
  const { job_id } = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'asking_price_revealed', property_id: PID, discriminator: 'ask:185000' })
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  const j = h.store._state.jobs.get(job_id)
  assert.equal(j.result.mission, 'property_research')
  assert.equal(j.result.web.status, 'skipped_no_ask_service')
  assert.equal(j.result.cost_usd, 0)
  assert.equal(j.result.offer_plan.visibility, 'internal_only')
  assert.equal(j.result.offer_plan.available, true)
  const fs = findingsOf(h, job_id)
  assert.deepEqual(fs.map((f) => f.finding_type).sort(), ['property.comps_area', 'property.dossier', 'property.economics', 'property.offer_plan', 'property.research'])
  const raw = JSON.stringify(fs)
  for (const bad of [SECRET_PHONE, '2145550147', SECRET_NAME, 'owner@example.com']) assert.ok(!raw.includes(bad), `leaked ${bad}`)
  assert.ok(!raw.includes(`"${PID}"`), 'no raw property id')
  const plan = JSON.parse(decodeFromStore(fs.find((f) => f.finding_type === 'property.offer_plan').value.payload_v1))
  assert.equal(plan.visibility, 'internal_only')
  assert.ok(plan.opening.recommended < plan.mao.amount)
  const dossier = JSON.parse(decodeFromStore(fs.find((f) => f.finding_type === 'property.dossier').value.payload_v1))
  assert.equal(dossier.contract.ok, true)
  assert.equal(dossier.sections.identity.location, undefined, 'coordinates are not stored in findings')
  assert.equal(h.store._state.ledger.length, 0, 'no model spend')
})

test('web step: runs only when enabled with gaps; only server-cited items are kept; listings stay listings; a resumed attempt never re-asks', async () => {
  let asks = 0
  const answer = '```json\n{"items":[{"topic":"subject_listing","status":"active","list_price":259900,"days_on_market":30,"url":"https://listings.example.com/subject"},{"topic":"nearby_listing","status":"active","list_price":999000,"url":"https://not-cited.example.com/x"}]}\n```'
  const buildAsk = () => ({
    ask: async ({ question, context }) => { asks += 1; assert.match(question, /Listings are NOT sales/); assert.ok(!question.includes(SECRET_NAME)); assert.deepEqual(context.property_ids, [PID]); return { run_id: 'r1', done: Promise.resolve({ state: 'completed', answer_md: answer, cost_usd: 0.02, result: { evidence: { public_web: [{ url: 'https://listings.example.com/subject', retrieved_at: '2026-10-15T15:00:00Z' }] } } }) } },
    cancel() {},
  })
  const h = harness({ env: { ...ON, AGENT_WEB_RESEARCH_ENABLED: '1' }, buildAsk })
  const { job_id } = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'opportunity_entered', property_id: PID })
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  const j = h.store._state.jobs.get(job_id)
  assert.equal(asks, 1)
  assert.equal(j.result.web.status, 'completed')
  assert.equal(j.result.web.listings, 1, 'the uncited listing is dropped')
  const web = JSON.parse(decodeFromStore(findingsOf(h, job_id).find((f) => f.finding_type === 'property.web_evidence').value.payload_v1))
  assert.equal(web.listings[0].evidence_kind, 'listing')
  const comps = JSON.parse(decodeFromStore(findingsOf(h, job_id).find((f) => f.finding_type === 'property.comps_area').value.payload_v1))
  assert.equal(comps.sections.listings.subject_listing.value.list_price, 259900)
  assert.ok(comps.sections.comps.sold_median_price.value == null || comps.sections.comps.sold_median_price.value < 300000, 'the listing never became a sale')
  // resume: the checkpoint marks the web step done ⇒ no second ask
  const job = h.store._state.jobs.get(job_id)
  const ctx = { job: { ...job, checkpoint: { ...job.checkpoint, findings: undefined } }, step: async () => {}, recordFinding: async () => 'f', remainingMs: () => 30_000, yield: () => {}, signal: new AbortController().signal }
  await createPropertyResearchHandler({ source: memorySource(), reads: h.reads, buildAsk, env: { AGENT_WEB_RESEARCH_ENABLED: '1' }, now: h.now, minAskMs: 0 }).run(ctx)
  assert.equal(asks, 1, 'a resumed attempt never re-spends the web step')
  // web disabled ⇒ the ask service is never called
  const off = harness({ env: ON, buildAsk })
  const r = await enqueuePropertyResearch({ store: off.store, env: ON, trigger: 'opportunity_entered', property_id: PID })
  await off.tick()
  assert.equal(off.store._state.jobs.get(r.job_id).result.web.status, 'skipped_web_disabled')
  assert.equal(asks, 1)
})

test('an unknown property is a permanent failure, not a retry loop', async () => {
  const h = harness()
  const r = await enqueuePropertyResearch({ store: h.store, env: ON, trigger: 'recovery_finding', property_id: '999999999' })
  const s = await h.tick()
  assert.equal(h.store._state.jobs.get(r.job_id).state, 'failed', JSON.stringify(s))
  assert.equal(h.store._state.jobs.get(r.job_id).last_error.code, 'PROPERTY_NOT_FOUND')
})

test('sweep kind: a scheduled sweep enqueues one property.research event per stale / re-priced pipeline property (deduped), only when wired + enabled', async () => {
  const h = harness()
  const sweepSource = { candidates: async ({ limit }) => [{ property_id: PID, trigger: 'valuation_stale_or_missing', discriminator: 'score:none' }].slice(0, limit) }
  const handlers = buildMissionHandlers({ env: ON, runtimeStore: h.store, reads: h.reads, propertyResearchSource: memorySource(), propertyResearchSweepSource: sweepSource, now: h.now })
  assert.ok(handlers['property.research_sweep'])
  assert.equal(buildMissionHandlers({ env: ON, runtimeStore: h.store, reads: h.reads, propertyResearchSweepSource: sweepSource })['property.research_sweep'], undefined, 'no sweep without the research source')
  const ctx = { job: { job_id: 'j', input: {}, checkpoint: {} }, step: async () => {} }
  const r1 = await handlers['property.research_sweep'].run(ctx)
  const r2 = await handlers['property.research_sweep'].run(ctx)
  assert.equal(r1.result.enqueued, 1)
  assert.equal(r2.result.deduped, 1)
  assert.equal([...h.store._state.jobs.values()].filter((j) => j.kind === 'property.research').length, 1)
})

test('drift: the property-research-sweep seed mirrors PROPERTY_RESEARCH_SWEEP, born disabled, $0; its posttest runs the same statement', async () => {
  const fs = await import('node:fs')
  const sql = fs.readFileSync(new URL('../../../../supabase/migrations/PROPOSED_20261016100100_property_research_schedules.sql', import.meta.url), 'utf8')
  const calls = [...sql.matchAll(/runtime_upsert_schedule\('([a-z-]+)', '([a-z._]+)', (\d+), :'owner_id', '([^']+)'::jsonb, (false|true), null, ([0-9.]+)\);/g)]
  assert.deepEqual(calls.map((m) => [m[1], m[2], Number(m[3]), JSON.parse(m[4]), m[5], Number(m[6])]),
    [[PROPERTY_RESEARCH_SWEEP.name, PROPERTY_RESEARCH_SWEEP.kind, PROPERTY_RESEARCH_SWEEP.interval_seconds, { limit: PROPERTY_RESEARCH_SWEEP.max_per_sweep }, 'false', 0]])
  const posttest = fs.readFileSync(new URL('../../../../supabase/migrations/PROPOSED_20261016100100_property_research_schedules_posttest.sql', import.meta.url), 'utf8')
  assert.match(posttest, /runtime_upsert_schedule\('property-research-sweep', 'property\.research_sweep', 21600, op, '\{"limit": 25\}'::jsonb, false, null, 0\);/)
})
