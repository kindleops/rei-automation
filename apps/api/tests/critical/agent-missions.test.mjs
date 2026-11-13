// 8.5.18 — persistent missions + autonomous operations on the R2 runtime (memory twin).
// The PostgreSQL proofs are in agent-missions-pg.test.mjs. No network: the model
// provider, the data service and the domain services are fakes.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createModelResolver } from '../../src/lib/agent/research/models.js'
import { toApiName as researchApi } from '../../src/lib/agent/research/research-tools.js'
import { buildMissionHandlers, createMissionMemoryReads, createMissionsService, SCHEDULE_DEFINITIONS, MISSION_RESEARCH_KIND, MISSION_SUPERVISOR_KIND, DISCOVERY_KIND, REVIEW_DIGEST_KIND, missionIdentity } from '../../src/lib/agent/missions/index.js'
import { createMissionCapabilityHook, missionOfferable } from '../../src/lib/agent/missions/mission-capability-hook.js'
import { screenProperty } from '../../src/lib/agent/missions/discovery-screen.js'
import { parseRanking } from '../../src/lib/agent/missions/discovery-handler.js'
import { encodeQuestion, decodeText, encodePropertyRef, decodeStored } from '../../src/lib/agent/missions/mission-codec.js'
import { handleMissionsList, handleMissionGet, handleMissionCreate, handleMissionCancel } from '../../src/lib/agent/missions/missions-routes.js'
import { runLimits } from '../../src/lib/agent/research/ask-service.js'
import { makeWorld, makePlane, OP, OTHER, ORG, ENV as CAP_ENV } from '../helpers/agent-capabilities-fake.mjs'
import { fakeDb, fakeServices, makeTables, LISTED_MODELS, toolUse, reply, answer, usage } from '../helpers/agent-research-fake.mjs'

const ENV = Object.freeze({ ...CAP_ENV, AGENT_RESEARCH_ENABLED: '1', AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '10', AGENT_SPEND_CYCLE_USD: '150', AGENT_MISSIONS_ENABLED: '1' })
const PID = '2124415662'
const T0 = Date.parse('2026-10-14T12:00:00Z')

function provider(step, { listed = LISTED_MODELS } = {}) {
  const calls = []
  let inflight = 0
  let peak = 0
  return {
    calls,
    get peak() { return peak },
    async listModels() { return listed.map((m) => ({ ...m })) },
    async createMessage(body, opts = {}) {
      calls.push(JSON.parse(JSON.stringify(body)))
      inflight += 1
      peak = Math.max(peak, inflight)
      try {
        return await step(body, calls.length, opts)
      } finally {
        inflight -= 1
      }
    },
  }
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms)
  signal?.addEventListener?.('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { code: 'PROVIDER_ABORTED', billed: 'unknown' })) }, { once: true })
})

/** A research ask script: one distress read, then a cited answer. */
const researchScript = (body) => {
  const last = body.messages[body.messages.length - 1]
  if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) return answer(`Property ${PID} is tax delinquent per campaign_target_graph; equity 64 % (vendor estimate). Gaps: no recorded lien detail.`)
  return reply([toolUse(researchApi('eg.distress_signals'), { property_id: PID })])
}

function harness({ step = researchScript, kinds = null, spend = {}, global = 4, tickMax = 5, discoverySource = null, research = {}, world = makeWorld(), members = [{ org_id: ORG, user_id: OP, role: 'owner' }] } = {}) {
  let t = T0
  const now = () => t
  const kl = kinds || { [MISSION_RESEARCH_KIND]: 3, [MISSION_SUPERVISOR_KIND]: 1, [DISCOVERY_KIND]: 1, [REVIEW_DIGEST_KIND]: 1 }
  const store = createRuntimeMemoryStore({
    now,
    limits: { runtime_enabled: true, max_concurrency_global: global, tick_max_jobs: tickMax, lease_seconds: 60, backoff_base_seconds: 5, kind_limits: Object.fromEntries(Object.entries(kl).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: OP }])) },
    research: { enabled: true, day_usd: 10, run_usd: 2.5, ...spend },
  })
  world.services.missions = { enqueue: (o) => store.enqueue(o), events: (id) => store.jobEvents(id) }
  const { plane, store: capStore } = makePlane({ env: ENV, world, members, now })
  const reads = createMissionMemoryReads(store, { members, now, approvals: () => [...capStore._approvals.values()] })
  const prov = provider(step)
  const resolver = createModelResolver({ provider: prov, env: ENV, now })
  const db = fakeDb(makeTables())
  const handlers = buildMissionHandlers({ env: ENV, runtimeStore: store, reads, provider: prov, resolver, getPlane: async () => plane, createServices: () => fakeServices(db), discoverySource, now, research })
  const tick = (o = {}) => runRuntimeTick({ store: o.store || store, handlers, workerId: 'w1', budgetMs: 30_000, now, concurrent: true, ...o })
  const service = createMissionsService({ runtimeStore: store, reads, getPlane: async () => plane })
  return { store, reads, plane, capStore, world, prov, handlers, tick, service, advance: (ms) => { t += ms }, now }
}

const IDENT = Object.freeze({ verified: true, named: true, user_id: OP, method: 'test' })
const job = (h, id) => h.store._state.jobs.get(id)
const findingsOf = (h, id) => [...h.store._state.findings.values()].filter((f) => f.job_id === id)
const ledgerOf = (h, id) => h.store._state.ledger.filter((r) => r.job_id === id)
async function create(h, body) {
  const r = await h.service.create({ identity: IDENT, body })
  assert.ok(r.ok, JSON.stringify(r))
  return r.mission_id
}

/** A store that "dies" (every call rejects, as after a container kill) once `when(method, args)` is true after a call. */
function crashable(store) {
  let dead = false
  let when = null
  const proxy = new Proxy(store, {
    get(target, key) {
      const v = target[key]
      if (typeof v !== 'function') return v
      return (...args) => {
        if (dead) return Promise.reject(Object.assign(new Error('connection terminated'), { code: 'AGENT_RUNTIME_DB_UNAVAILABLE' }))
        const r = v.apply(target, args)
        if (when && when(key, args[0])) dead = true
        return r
      }
    },
  })
  return { proxy, crashWhen: (fn) => { when = fn }, get dead() { return dead } }
}

// ── research missions ───────────────────────────────────────────────────────

test('mission.research: created through missions.create, run headlessly by the tick as the requesting operator; answer, typed result, findings with evidence; job-owned spend', async () => {
  const h = harness()
  const id = await create(h, { kind: 'mission.research', question: `Research the distress and equity evidence for property ${PID} and cite the sources.`, context: { property_ids: [PID] }, budget_usd: 0.5 })
  const j0 = job(h, id)
  assert.equal(j0.kind, 'mission.research')
  assert.equal(j0.requested_by, OP)
  assert.equal(j0.budget_cap_usd, 0.5)
  assert.ok(!JSON.stringify(j0.input).includes(PID), 'the stored input never holds a raw property id (pid_ / ~e~ encoded)')
  assert.match(decodeText(j0.input.question_v1), new RegExp(PID), 'decodes back exactly')
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  const j = job(h, id)
  assert.equal(j.state, 'completed')
  assert.equal(h.prov.calls.length, 2)
  assert.match(decodeText(j.result.answer_v1), /tax delinquent/)
  const env = JSON.parse(decodeText(j.result.result_v1))
  assert.equal(env.schema, 'lc.ask.result')
  assert.ok(env.evidence.internal.tools.includes('eg.distress_signals'))
  // spend: one job-owned reserve per model call, settled at the provider-reported usage
  const led = ledgerOf(h, id)
  assert.equal(led.length, 2)
  assert.ok(led.every((r) => r.state === 'settled' && r.operator_id === OP && r.job_id === id))
  assert.ok(Math.abs(j.result.cost_usd - led.reduce((a, r) => a + r.actual_usd, 0)) < 1e-9)
  // findings carry their evidence
  const f = findingsOf(h, id)
  const byType = Object.groupBy(f, (x) => x.finding_type)
  assert.equal(byType['mission.answer'].length, 1)
  assert.deepEqual(byType['mission.answer'][0].value.tools, ['eg.distress_signals'])
  assert.equal(byType['mission.property_evidence'][0].value.property_ref, encodePropertyRef(PID))
  assert.ok(f.every((x) => x.actor_user_id === OP && x.source_id))
  // the model saw the research tools + only offerable capability tools (never missions.*, never a policy-tier write)
  const tools = h.prov.calls[0].tools.map((x) => x.name)
  assert.ok(tools.includes(researchApi('eg.distress_signals')))
  assert.ok(tools.includes('cap__campaigns__create_draft') && tools.includes('cap__inbox__prepare_reply'))
  assert.ok(!tools.some((x) => x.startsWith('cap__missions__')))
  assert.equal(h.world.called('inbox.sendNow').length, 0)
})

test('crash after the ask step: the resumed attempt never re-runs the ask (no second model call, no second reserve) and findings are not duplicated', async () => {
  const h = harness()
  const id = await create(h, { kind: 'mission.research', question: `Research distress evidence for property ${PID}.`, context: { property_ids: [PID] } })
  const c = crashable(h.store)
  c.crashWhen((k, a) => k === 'checkpoint' && a?.event_payload?.step === 'ask.done')
  const s1 = await h.tick({ store: c.proxy })
  assert.ok(c.dead)
  assert.equal(s1.jobs[0].ok, false, 'the attempt never finished (process gone)')
  assert.equal(job(h, id).state, 'running', 'left leased, exactly as after a container kill')
  assert.equal(h.prov.calls.length, 2)
  assert.equal(ledgerOf(h, id).length, 2)
  // restart: the lease expires, the reaper hands it back, the next tick resumes from the checkpoint
  h.advance(61_000)
  await h.tick()
  assert.equal(job(h, id).state, 'retrying')
  h.advance(6_000)
  const s3 = await h.tick()
  assert.equal(s3.jobs[0].outcome, 'completed', JSON.stringify(s3))
  assert.equal(h.prov.calls.length, 2, 'the completed ask step is not re-spent')
  assert.equal(ledgerOf(h, id).length, 2, 'no new reserve')
  const keys = findingsOf(h, id).map((f) => `${f.finding_type}|${f.key}`)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(h.store._state.events.some((e) => e.job_id === id && e.type === 'job.lease_expired'))
})

test('crash in the middle of the findings step: the resumed attempt rewrites (upserts) — never a duplicate finding, never a model call', async () => {
  const h = harness()
  const id = await create(h, { kind: 'mission.research', question: `Research distress evidence for property ${PID}.`, context: { property_ids: [PID] } })
  const c = crashable(h.store)
  let n = 0
  c.crashWhen((k) => k === 'recordFinding' && ++n === 1)
  await h.tick({ store: c.proxy })
  assert.equal(findingsOf(h, id).length, 1)
  h.advance(61_000); await h.tick(); h.advance(6_000)
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'completed')
  const f = findingsOf(h, id)
  assert.equal(f.length, 2, 'answer + property evidence, once each')
  assert.equal(h.prov.calls.length, 2)
})

test('cancel: queued → immediate; mid-ask → the heartbeat sees it, the in-flight model call is aborted, its reserve stays counted (unknown), no findings', async () => {
  const h = harness({ step: async (_b, _n, o) => { await sleep(3000, o.signal); return answer('late') }, research: { heartbeatMs: 20 } })
  const q = await create(h, { kind: 'mission.research', question: 'Research distress signals for the Dallas campaign audience in detail.', budget_usd: 0.5 })
  const c = await h.service.cancel({ identity: IDENT, mission_id: q })
  assert.deepEqual([c.ok, c.state, c.pending], [true, 'cancelled', false])

  const id = await create(h, { kind: 'mission.research', question: 'Research tax delinquency evidence across the Minneapolis audience.', budget_usd: 0.5 })
  const running = h.tick()
  await sleep(150)
  assert.equal(job(h, id).state, 'running')
  const pc = await h.service.cancel({ identity: IDENT, mission_id: id })
  assert.equal(pc.pending, true, 'running ⇒ cooperative')
  const s = await running
  assert.equal(s.jobs[0].outcome, 'cancelled', JSON.stringify(s))
  assert.equal(job(h, id).state, 'cancelled')
  assert.deepEqual(ledgerOf(h, id).map((r) => r.state), ['unknown'], 'never released on a guess')
  assert.equal(findingsOf(h, id).length, 0)
})

test('budget_blocked: a reserve above the mission ceiling is refused by the spend guard; the job parks budget_blocked, no model call; requeue is the only way back', async () => {
  const h = harness()
  const id = (await h.store.enqueue({ kind: MISSION_RESEARCH_KIND, idempotency_key: 'a'.repeat(64), input: { question_v1: encodeQuestion('Research distress evidence for the Dallas audience.') }, requested_by: OP, budget_cap_usd: 0.0001 })).job_id
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'budget_blocked', JSON.stringify(s))
  const j = job(h, id)
  assert.equal(j.state, 'budget_blocked')
  assert.equal(j.last_error.code, 'AGENT_SPEND_CAP_JOB')
  assert.equal(h.prov.calls.length, 0)
  assert.equal(ledgerOf(h, id).length, 0)
  assert.equal((await h.store.requeue({ job_id: id, by: OP })).state, 'queued')
  // the day cap binds every mission too (the existing $10/day guard)
  const h2 = harness({ spend: { day_usd: 0.000001 } })
  const id2 = await create(h2, { kind: 'mission.research', question: 'Research distress evidence for the Dallas audience.' })
  await h2.tick()
  assert.equal(job(h2, id2).state, 'failed', 'code-level cap (env ∧ DB) refuses before any reserve')
  assert.equal(job(h2, id2).last_error.code, 'MISSION_AGENT_SPEND_CAP_DAY')
  assert.equal(h2.prov.calls.length, 0)
})

test('the mission principal: a non-named requested_by never runs; the delegated identity is the requesting operator only', () => {
  assert.equal(missionIdentity('principal:system').verified, false)
  assert.equal(missionIdentity(OP).user_id, OP)
  assert.deepEqual(runLimits({ max_model_calls: 99, run_timeout_ms: 1 }).max_model_calls, 10, 'a caller can only lower ask limits')
  assert.equal(runLimits({ run_timeout_ms: 1000 }).run_timeout_ms, 1000)
})

// ── supervisor ──────────────────────────────────────────────────────────────

const subStep = async (body, _n, o) => {
  const sys = JSON.stringify(body.system || '')
  if (sys.includes('consolidate')) return answer('Consolidated: all three markets show tax-delinquent, never-contacted SFRs. Gaps: lien detail.')
  await sleep(300, o.signal)
  return answer(`Sub-answer for ${String(body.messages[0].content).slice(-40)}`)
}

test('mission.supervisor: ≤ 3 sub-missions run CONCURRENTLY on the runtime (bounded by kind max_concurrency), the supervisor waits on job state (no model call while waiting), then consolidates', async () => {
  const h = harness({ step: subStep })
  const id = await create(h, { kind: 'mission.supervisor', question: 'Compare acquisition evidence across Dallas, Minneapolis and Houston audiences.', sub_questions: ['Dallas audience evidence summary.', 'Minneapolis audience evidence summary.', 'Houston audience evidence summary.'], per_mission_budget_usd: 0.4 })
  await h.tick() // split (operator-supplied) + enqueue + first wait → yield
  const sup = job(h, id)
  assert.equal(sup.state, 'retrying', 'yielded, not failed')
  assert.equal(sup.last_error, null)
  assert.equal(sup.checkpoint.children.length, 3)
  assert.equal(h.prov.calls.length, 0, 'no split call when the operator supplied the sub-questions')
  const kids = sup.checkpoint.children.map((c) => job(h, c.job_id))
  assert.ok(kids.every((k) => k.kind === MISSION_RESEARCH_KIND && k.requested_by === OP && k.budget_cap_usd === 0.4 && k.input.parent_job_id === id))
  h.advance(6_000)
  await h.tick() // the three children run in parallel; the supervisor re-checks and yields again
  assert.equal(h.prov.peak, 3, 'real concurrency: three model calls in flight at once')
  assert.ok(kids.every((k) => job(h, k.job_id).state === 'completed'))
  const callsBefore = h.prov.calls.length
  h.advance(6_000)
  const s = await h.tick()
  assert.ok(s.jobs.some((x) => x.job_id === id && x.outcome === 'completed'), JSON.stringify(s))
  assert.equal(h.prov.calls.length, callsBefore + 1, 'exactly one consolidation call')
  const r = job(h, id).result
  assert.equal(r.outcome, 'COMPLETED')
  assert.equal(r.method, 'model')
  assert.match(decodeText(r.answer_v1), /Consolidated/)
  assert.equal(r.children.length, 3)
  assert.ok(r.total_cost_usd > r.cost_usd)
  // re-running a waiting tick never re-enqueues a child (idempotent per index)
  assert.equal([...h.store._state.jobs.values()].filter((j) => j.kind === MISSION_RESEARCH_KIND).length, 3)
  assert.ok(findingsOf(h, id).some((f) => f.finding_type === 'mission.consolidated'))
})

test('supervisor concurrency bound: kind max_concurrency 2 ⇒ never more than 2 sub-missions in flight; global limit binds too', async () => {
  const h = harness({ step: subStep, kinds: { [MISSION_RESEARCH_KIND]: 2, [MISSION_SUPERVISOR_KIND]: 1 } })
  const id = await create(h, { kind: 'mission.supervisor', question: 'Compare three markets.', sub_questions: ['Dallas evidence.', 'Minneapolis evidence.', 'Houston evidence.'] })
  for (let i = 0; i < 6 && job(h, id).state !== 'completed'; i += 1) { await h.tick(); h.advance(6_000) }
  assert.equal(job(h, id).state, 'completed')
  assert.equal(h.prov.peak, 2)
  const g = harness({ step: subStep, global: 1 })
  const gid = await create(g, { kind: 'mission.supervisor', question: 'Compare two markets.', sub_questions: ['Dallas evidence.', 'Houston evidence.'] })
  for (let i = 0; i < 10 && job(g, gid).state !== 'completed'; i += 1) { await g.tick(); g.advance(6_000) }
  assert.equal(job(g, gid).state, 'completed')
  assert.equal(g.prov.peak, 1)
})

test('supervisor cancel cascades to every open child (API), and a cancelled supervisor never consolidates', async () => {
  const h = harness({ step: subStep })
  const id = await create(h, { kind: 'mission.supervisor', question: 'Compare two markets.', sub_questions: ['Dallas evidence.', 'Houston evidence.'] })
  await h.tick()
  const r = await h.service.cancel({ identity: IDENT, mission_id: id })
  assert.equal(r.state, 'cancelled')
  assert.deepEqual(r.children.map((c) => c.state), ['cancelled', 'cancelled'])
  h.advance(6_000)
  await h.tick()
  assert.equal(h.prov.calls.length, 0)
})

// ── discovery ───────────────────────────────────────────────────────────────

const GEN = '2026-10-11T04:05:02.695Z'
const fact = (id, over = {}) => ({ property_id: id, market: 'Dallas, TX', property_address_state: 'TX', zip_code: '75216', asset_type: 'sfr', property_type: 'Single Family', units_count: 1, estimated_value: 185000, equity_known_pct: 55, equity_percent: 60, ownership_years: 21, is_corporate_owner: false, out_of_state_owner: false, tax_delinquent: true, tax_delinquent_year: 2023, active_lien: false, is_hot_preforeclosure: false, rec_has_probate: false, rec_has_lis_pendens: false, rec_has_default_notice: false, rec_has_tax_lien: false, rec_has_judgment: false, rec_foreclosure_stage: null, rec_has_death_record: false, distress_signal_count: 1, signal_labels: ['Tax Delinquent', 'Senior Owner'], sms_status: 'eligible', contact_identity: 'verified', contact_candidate_phones: 1, last_contact_at: null, campaign_count: 0, pipeline_stage: null, conversation_stage: null, scores_aos_score: 70, refreshed_at: GEN, ...over })
const contact = (id, over = {}) => ({ property_id: id, identity_alignment: 'verified', sms_eligible: true, wrong_number: false, true_post_contact_suppression: false, pending_prior_touch: false, active_queue_item: false, last_outbound_at: null, latest_contact_at: null, touch_count: 0, ...over })

function fakeSource() {
  const facts = [
    fact('300000001'), // A: passes
    fact('300000002', { sms_status: 'suppressed' }), // B: suppressed
    fact('300000003', { rec_has_death_record: true }), // C: death record, no living DM audit
    fact('300000004', { last_contact_at: '2026-09-01T00:00:00Z' }), // D: prior touch
    fact('300000005'), // E: already in a campaign
    fact('300000006', { tax_delinquent: false, equity_known_pct: 20, distress_signal_count: 0 }), // F: no credible evidence
    fact('300000007', { contact_identity: 'probable' }), // G: unverified contact
    fact('300000008', { rec_has_death_record: true, rec_has_probate: true }), // H: probate, living heir reachable → passes
    fact('300000009', { equity_known_pct: null, tax_delinquent: false, distress_signal_count: 0, equity_percent: 90 }), // I: vendor equity only → excluded
  ]
  const contacts = facts.map((f) => contact(f.property_id))
  contacts.push(contact('300000004', { last_outbound_at: '2026-09-01T00:00:00Z', touch_count: 1 }))
  const calls = []
  return {
    calls,
    async generation() { calls.push('generation'); return GEN },
    async scan({ after, limit }) { calls.push(`scan:${after}:${limit}`); return facts.filter((f) => f.property_id > (after || '')).slice(0, limit) },
    async contacts(ids) { return contacts.filter((c) => ids.includes(c.property_id)) },
    async probate(ids) { return [{ property_id: '300000003', has_death_record: true, only_deceased_reachable: true, exclude_targeting: true, reachable_living_dm: false }, { property_id: '300000008', has_death_record: true, only_deceased_reachable: false, exclude_targeting: false, reachable_living_dm: true }].filter((p) => ids.includes(p.property_id)) },
    async campaignMembers(ids) { return new Set(ids.filter((x) => x === '300000005')) },
  }
}

const rankStep = (body) => {
  const cards = JSON.parse(body.messages[0].content).candidates
  return answer(JSON.stringify({ ranking: cards.map((c, i) => ({ c: c.c, score: 90 - i * 10, why: ['tax_delinquent', 'not_a_code'] })) }), usage(800, 120))
}

test('discovery screening runs BEFORE any model call: suppressed / deceased-only / prior-touch / in-campaign / unverified / no-evidence / vendor-equity-only are excluded; the model sees only screened cards (no ids, no protected labels)', async () => {
  const src = fakeSource()
  const h = harness({ step: rankStep, discoverySource: src })
  const id = (await h.store.enqueue({ kind: DISCOVERY_KIND, idempotency_key: 'd'.repeat(64), input: { scan_limit: 50, rank_top_n: 10, draft: false }, requested_by: OP, budget_cap_usd: 0.25 })).job_id
  const s = await h.tick()
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  const r = job(h, id).result
  assert.equal(r.scanned, 9)
  assert.deepEqual(r.excluded, { no_verified_contact: 1, suppressed: 1, deceased_only_or_unverified: 1, prior_touch: 2, no_credible_evidence: 2, already_surfaced: 0 })
  assert.equal(r.screened, 2)
  assert.equal(h.prov.calls.length, 1, 'one ranking call, after screening')
  const sent = JSON.stringify(h.prov.calls[0].messages)
  assert.equal(JSON.parse(h.prov.calls[0].messages[0].content).candidates.length, 2)
  for (const pid of ['300000001', '300000002', '300000003', '300000008']) assert.ok(!sent.includes(pid), 'no property id reaches the model')
  assert.ok(!/senior/i.test(sent), 'protected labels never reach the model')
  // deterministic order first (probate + living heir + tax + equity outranks tax + equity), then the model's scores
  assert.deepEqual(r.candidates.map((c) => decodeStored(c, 'x').property_ref), ['300000008', '300000001'])
  // pure screen: each exclusion is a named reason
  assert.deepEqual(screenProperty(fact('1', { sms_status: 'suppressed' }), [contact('1')]).reasons, ['suppressed'])
  assert.deepEqual(screenProperty(fact('1'), [contact('1')], { only_deceased_reachable: true }).reasons, ['deceased_only_or_unverified'])
  assert.ok(screenProperty(fact('1'), [contact('1', { pending_prior_touch: true })]).reasons.includes('prior_touch'))
  assert.deepEqual([...parseRanking('{"ranking":[{"c":"C1","score":140,"why":["tax_delinquent","x"]},{"c":"C9","score":1}]}', new Map([['C1', 'a']])).entries()], [['C1', { model_score: 100, why: ['tax_delinquent'] }]])
})

test('discovery findings carry traceable evidence; the draft is a NEW draft (never launched), the launch is only a pending approval; no existing campaign changes; the watermark advances only after the batch', async () => {
  const src = fakeSource()
  const world = makeWorld()
  world.campaigns.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').status = 'active'
  const before = JSON.stringify([...world.campaigns.values()])
  const h = harness({ step: rankStep, discoverySource: src, world })
  const sched = await h.store.upsertSchedule({ name: 'acquisition-discovery', kind: DISCOVERY_KIND, interval_seconds: 21600, created_by: OP, input: { scan_limit: 50, rank_top_n: 10 }, enabled: true, budget_cap_usd: 0.25 })
  const s = await h.tick()
  const jid = s.jobs[0].job_id
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  const f = findingsOf(h, jid)
  const cands = f.filter((x) => x.finding_type === 'discovery.candidate')
  assert.equal(cands.length, 2)
  for (const c of cands) {
    assert.match(c.key, /^property\.pid_[g-p]+$/)
    assert.ok(c.value.evidence.length >= 4 && c.value.evidence.every((e) => e.source && e.field))
    assert.ok(c.value.evidence.some((e) => e.source === 'campaign_target_graph' && e.field === 'identity_alignment'))
    assert.deepEqual(c.value.screening, { verified_contact: true, suppressed: false, deceased_only: false, prior_touch: false, credible_evidence: true })
    assert.equal(c.source_id, 'public.eg_property_facts')
    assert.equal(typeof c.value.model_score, 'number')
  }
  const batch = f.find((x) => x.finding_type === 'discovery.batch')
  assert.equal(batch.value.scanned, 9)
  // draft: one new draft, pinned to the candidates, never active; launch only as a pending approval
  const r = job(h, jid).result
  assert.equal(r.draft.status, 'draft')
  assert.ok(r.draft.approval.approval_id)
  assert.equal(world.called('campaigns.saveDraft').length, 1)
  const saved = world.called('campaigns.saveDraft')[0].args.composition
  assert.deepEqual(saved.target_filters.properties, [{ field_key: 'property_id', operator: 'is_any_of', value: ['300000008', '300000001'] }])
  assert.equal(saved.template_use_case, 'ownership_check')
  assert.equal(world.called('campaigns.launch').length, 0, 'never launched')
  assert.equal(world.called('campaigns.prepare').length, 0, 'no targets built')
  assert.equal(world.called('inbox.sendNow').length, 0)
  const draft = world.campaigns.get(r.draft.campaign_id)
  assert.equal(draft.status, 'draft')
  assert.equal(JSON.stringify([...world.campaigns.values()].filter((c) => c.id !== r.draft.campaign_id)), before, 'every existing campaign (incl. the active one) unchanged')
  const appr = await h.plane.approvals.get({ org_id: ORG, identity: IDENT, approval_id: r.draft.approval.approval_id })
  assert.equal(appr.approval.state, 'pending')
  assert.equal(appr.approval.capability_id, 'campaigns.prepare_launch_approval')
  // watermark: the cursor is the last scanned id; the pass is done; the same build idles next slot ($0, no scan)
  const wm = h.store._state.schedules.get(sched.schedule_id).watermark
  assert.deepEqual([wm.generation, wm.pass_done, decodeStored(wm, 'x').after], [GEN, true, '300000009'])
  h.advance(21600_000)
  const s2 = await h.tick()
  const r2 = job(h, s2.jobs[0].job_id).result
  assert.equal(r2.idle, true)
  assert.equal(h.prov.calls.length, 1, 'an idle slot never calls the model')
  assert.equal(world.called('campaigns.saveDraft').length, 1)
})

test('discovery de-dupe: a property surfaced by a discovery finding in the last 30 days is not surfaced again', async () => {
  const src = fakeSource()
  const h = harness({ step: rankStep, discoverySource: src })
  const a = (await h.store.enqueue({ kind: DISCOVERY_KIND, idempotency_key: '1'.repeat(64), input: { scan_limit: 50, draft: false }, requested_by: OP, budget_cap_usd: 0.25 })).job_id
  await h.tick()
  const b = (await h.store.enqueue({ kind: DISCOVERY_KIND, idempotency_key: '2'.repeat(64), input: { scan_limit: 50, draft: false }, requested_by: OP, budget_cap_usd: 0.25 })).job_id
  await h.tick()
  assert.equal(job(h, a).result.screened, 2)
  assert.equal(job(h, b).result.excluded.already_surfaced, 2)
  assert.equal(job(h, b).result.screened, 0)
  assert.equal(h.prov.calls.length, 1, 'nothing left to rank ⇒ no model call')
})

// ── schedules, digest, tool plane ───────────────────────────────────────────

test('schedules: discovery 6 h, health check 15 m, morning digest 24 h — definitions only, every one born disabled (migration seed passes enabled=false)', async () => {
  assert.deepEqual(SCHEDULE_DEFINITIONS.map((s) => [s.name, s.kind, s.interval_seconds]), [['acquisition-discovery', 'acquisition.discovery', 21600], ['ops-health-check', 'ops.health_check', 900], ['conversation-review-digest', 'conversation.review_digest', 86400]])
  const fs = await import('node:fs')
  const sql = fs.readFileSync(new URL('../../../../supabase/migrations/PROPOSED_20261014120100_persistent_missions_schedules.sql', import.meta.url), 'utf8')
  const calls = [...sql.matchAll(/runtime_upsert_schedule\(([\s\S]*?)\);/g)].map((m) => m[1])
  assert.equal(calls.length, 3)
  for (const c of calls) assert.match(c, /,\s*false,/, 'p_enabled = false')
  const h = harness()
  await h.store.upsertSchedule({ name: 'conversation-review-digest', kind: REVIEW_DIGEST_KIND, interval_seconds: 86400, created_by: OP, input: { window_hours: 24 }, enabled: false })
  const s = await h.tick()
  assert.equal(s.claimed, 0, 'a disabled schedule enqueues nothing')
})

test('conversation.review_digest: summarizes real completed work (missions, findings, approvals waiting; shadow unavailable is reported, never 0) as one finding, $0', async () => {
  const h = harness()
  const id = await create(h, { kind: 'mission.research', question: `Research distress evidence for property ${PID}.`, context: { property_ids: [PID] } })
  await h.tick()
  await h.plane.invoker.invoke({ capability_id: 'campaigns.prepare_launch_approval', input: { campaign_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', start: 'now' }, ctx: { org_id: ORG, identity: IDENT, source: 'operator', session: { tainted: false } } })
  const dj = (await h.store.enqueue({ kind: REVIEW_DIGEST_KIND, idempotency_key: 'e'.repeat(64), input: { window_hours: 24 }, requested_by: OP })).job_id
  const callsBefore = h.prov.calls.length
  await h.tick()
  const r = job(h, dj).result
  assert.equal(r.missions.total, 1)
  assert.equal(r.missions.completed, 1)
  assert.ok(r.missions.by_kind['mission.research'].cost_usd > 0)
  assert.ok(r.findings.by_type['mission.answer'] >= 1)
  assert.deepEqual(r.shadow_decisions, { available: false, code: 'SOURCE_NOT_CONFIGURED' })
  assert.equal(h.prov.calls.length, callsBefore, 'no model call')
  assert.ok(findingsOf(h, dj).some((f) => f.finding_type === 'digest.morning' && f.key.startsWith('digest.2026-10-14')))
  void id
})

test('mission tool plane: offered = autonomous_internal + approval-tier capabilities, never missions.* or a policy-tier write; a not-offered call is refused without invoking', async () => {
  const { plane, world } = makePlane({ env: ENV })
  const hook = createMissionCapabilityHook({ plane })
  const offered = hook.offered()
  assert.ok(offered.includes('campaigns.create_draft') && offered.includes('campaigns.prepare_launch_approval') && offered.includes('inbox.prepare_reply'))
  assert.ok(!offered.includes('missions.create'))
  assert.equal(missionOfferable({ id: 'x.y', tier: 'within_approved_policy' }), false)
  const r = await hook.run({ apiName: 'cap__missions__create', input: { kind: 'ops.health_check' }, run: { identity: IDENT } })
  assert.equal(JSON.parse(r.content).error, 'CAPABILITY_NOT_OFFERED')
  assert.equal(world.called('missions.enqueue').length, 0)
})

// ── API shapes ──────────────────────────────────────────────────────────────

function apiOpts(h, { env = ENV, user = OP } = {}) {
  return { env, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { ...IDENT, user_id: user } }) }, limiter: { check: () => ({ ok: true }), limits: {} }, service: h.service, headers: {} }
}
const req = (path, init = {}) => new Request(`http://local/api/cockpit/agent/missions${path}`, init)
const post = (path, body) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const keys = (o) => Object.keys(o).sort()

test('Missions API: 404 (empty) while gated off; create → 201 { mission_id }; list / get / cancel shapes match docs/agent-missions-api.md; another operator sees 404', async () => {
  const h = harness()
  const off = await handleMissionsList(req(''), { ...apiOpts(h), env: { ...ENV, AGENT_MISSIONS_ENABLED: '0' } })
  assert.equal(off.status, 404)
  assert.equal(await off.text(), '')
  const bad = await handleMissionCreate(post('', { kind: 'ops.health_check' }), apiOpts(h))
  assert.equal(bad.status, 422)
  const cr = await handleMissionCreate(post('', { kind: 'mission.research', question: `Research distress evidence for property ${PID}.`, context: { property_ids: [PID] }, budget_usd: 0.5 }), apiOpts(h))
  assert.equal(cr.status, 201)
  const c = await cr.json()
  assert.deepEqual(keys(c), ['deduped', 'mission_id', 'ok', 'state', 'status'])
  assert.match(c.mission_id, /^mjob_/)
  const again = await (await handleMissionCreate(post('', { kind: 'mission.research', question: `Research distress evidence for property ${PID}.`, context: { property_ids: [PID] }, budget_usd: 0.5 }), apiOpts(h))).json()
  assert.equal(again.mission_id, c.mission_id, 'idempotent within the hour')
  await h.tick()
  const list = await (await handleMissionsList(req('?limit=10'), apiOpts(h))).json()
  assert.deepEqual(keys(list), ['missions', 'next_cursor', 'ok', 'scope'])
  assert.deepEqual(keys(list.missions[0]), ['attempt', 'budget_cap_usd', 'cancel_requested', 'cost_usd', 'created_at', 'display_state', 'ended_at', 'kind', 'last_error', 'max_attempts', 'mission_id', 'next_attempt_at', 'parent_mission_id', 'progress', 'requested_by', 'state', 'title', 'trigger', 'updated_at'])
  assert.match(list.missions[0].title, new RegExp(PID))
  const g = await (await handleMissionGet(req(`/${c.mission_id}`), c.mission_id, apiOpts(h))).json()
  assert.equal(g.ok, true)
  const m = g.mission
  for (const k of ['input', 'result', 'cost', 'children', 'events', 'events_cursor', 'findings']) assert.ok(k in m, k)
  assert.equal(m.state, 'completed')
  assert.deepEqual(m.input.context, { property_ids: [PID] })
  assert.match(m.result.answer, /tax delinquent/)
  assert.equal(m.result.envelope.schema, 'lc.ask.result')
  assert.deepEqual(keys(m.cost), ['budget_cap_usd', 'children_committed_usd', 'committed_usd', 'model_calls', 'open_reserved_usd', 'settled_usd', 'total_committed_usd', 'unknown_usd'])
  assert.ok(m.events.some((e) => e.type === 'job.completed'))
  assert.deepEqual(keys(m.events[0]), ['actor', 'at', 'attempt', 'id', 'payload', 'state', 'type'])
  assert.ok(m.findings.some((f) => f.finding_type === 'mission.property_evidence' && f.key === `property.${PID}` && f.value.property_ref === PID))
  assert.deepEqual(keys(m.findings[0]), ['citation', 'confidence', 'evidence_status', 'finding_id', 'finding_type', 'key', 'retrieved_at', 'source_id', 'value'])
  const other = await handleMissionGet(req(`/${c.mission_id}`), c.mission_id, apiOpts(h, { user: OTHER }))
  assert.equal(other.status, 404, 'not a member of the org: the mission does not exist for them')
  const cancel = await (await handleMissionCancel(post(`/${c.mission_id}/cancel`, {}), c.mission_id, apiOpts(h))).json()
  assert.deepEqual(keys(cancel), ['children', 'mission_id', 'noop', 'ok', 'pending', 'state'])
  assert.equal(cancel.noop, true)
})
