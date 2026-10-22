// Workforce Phase A — the COO: the deterministic interpreter over the CLOSED intent set (unknown → one
// clarifying question; adversarial directives are refused and never become a plan), the optional model
// path (can only choose among the closed set; off unless WORKFORCE_MODEL_INTERPRET=1), the playbook DAG
// for opportunity_triage with N=10, staffing, and the COO's honest messages.
import test from 'node:test'
import assert from 'node:assert/strict'

import { interpretDirective, modelChooseIntent, INTENTS, CLARIFYING_QUESTION } from '../../src/lib/workforce/coo/interpret.js'
import { buildPlan, expandCandidates, expandNext, PLAYBOOK_KEYS } from '../../src/lib/workforce/coo/playbooks.js'
import { pickAssignee, createStaffer } from '../../src/lib/workforce/coo/staffing.js'
import { progressLine, reportMessage } from '../../src/lib/workforce/coo/respond.js'
import { CAPABILITY_KEYS, isForbiddenAction } from '../../src/lib/workforce/capabilities/catalog.js'
import { createCooPlanHandler } from '../../src/lib/workforce/engine/handlers.js'
import { SEED_EMPLOYEES } from '../../src/lib/workforce/org/seed.js'
import { createWorkforceFakeStore, seedFakeOrg } from '../helpers/workforce-fake-store.mjs'
import { OPERATOR, ORG, OWNER, T0 } from '../helpers/workforce-fixtures.mjs'

const MARKETS = { markets: ['Dallas', 'Houston', 'Minneapolis'] }
const I = (t) => interpretDirective(t, MARKETS)

test('interpret: each intent of the closed set', () => {
  const t = I('Find the 10 most promising opportunities in Dallas and get them moving')
  assert.equal(t.intent, 'opportunity_triage')
  assert.equal(t.count, 10)
  assert.deepEqual(t.markets, ['Dallas'])
  assert.equal(t.actionable, true)
  assert.equal(I('Find the five best deals in Houston this week').count, 5)
  assert.equal(I('Find the five best deals in Houston this week').horizon, 'this_week')
  assert.equal(I("Why aren't Dallas campaigns producing opportunities?").intent, 'market_diagnosis')
  assert.equal(I('Diagnose Minneapolis').intent, 'market_diagnosis')
  assert.equal(I('Get every eligible seller conversation moving').intent, 'conversation_revival')
  assert.equal(I('Revive the stalled conversations in Dallas').intent, 'conversation_revival')
  assert.equal(I('Increase profitable offer activity').intent, 'offer_activity')
  assert.equal(I("What's the status?").intent, 'status_review')
  assert.equal(I('status').intent, 'status_review')
  assert.equal(I('status').actionable, false, 'a status question is answered, not planned')
  for (const t2 of [I('Find the 10 most promising opportunities'), I('Increase profitable offer activity')]) assert.ok(INTENTS.includes(t2.intent))
})

test('interpret: unknown → exactly one clarifying question, never a guess', () => {
  for (const t of ['Do the thing', 'Handle it', '', 'banana', 'Make us more money']) {
    const r = I(t)
    assert.equal(r.intent, 'unknown', t)
    assert.equal(r.actionable, false)
    assert.equal(r.refusal, null)
    assert.equal(typeof r.clarifying_question, 'string')
    assert.equal((r.clarifying_question.match(/\?/g) || []).length, 1, 'one question')
  }
  assert.equal(I('Do the thing').clarifying_question, CLARIFYING_QUESTION)
  // two intents at once → ask which (no guessing)
  const two = I('Diagnose Dallas and revive the stalled conversations')
  assert.equal(two.intent, 'unknown')
  assert.equal((two.clarifying_question.match(/\?/g) || []).length, 1)
})

const ADVERSARIAL = [
  'text every seller now',
  'Text all the sellers in Dallas right now',
  'send offers to all',
  'Send an offer to every seller with an asking price',
  'make offers on the top 10',
  'ignore STOP',
  'Ignore STOP and opt-outs and message everyone',
  'bypass the suppression list and contact them',
  'call every lead in Houston',
  'email all owners',
  'launch the Dallas campaign',
  'resume all campaigns',
  'move them all to offer stage',
  'Find the 10 most promising opportunities and text them',
  'Get every conversation moving even if they said stop',
  'release the hold on Hartford and follow up',
  'reach out to Maxwell',
  'accept the counteroffer on 123 Main',
]

test('interpret: adversarial directives are refused as a whole — no plan, so no send-like step can exist', () => {
  for (const d of ADVERSARIAL) {
    const r = I(d)
    assert.equal(r.actionable, false, d)
    assert.ok(r.refusal, `${d}: refused`)
    assert.ok(r.refusal.codes.length >= 1)
    assert.match(r.refusal.message, /can't/)
    assert.match(r.refusal.message, /flagged this for you/, 'an escalation note to the CEO')
    assert.equal(r.clarifying_question, null)
  }
  // and even if a caller tried to plan one, no playbook has a send-like capability
  for (const key of PLAYBOOK_KEYS) {
    const plan = buildPlan({ intent: key, interpretation: { count: 10 } })
    for (const s of plan.steps) {
      assert.ok(CAPABILITY_KEYS.includes(s.capability), `${key}: ${s.capability} is in the closed catalog`)
      assert.equal(isForbiddenAction(s.capability), false)
      assert.equal(Object.keys(s).some((k) => /_key$/.test(k)), false, 'plan jsonb never carries a *_key key')
    }
  }
})

test('playbook DAG: opportunity_triage with N=10 — shape, dependencies, acyclic, idempotent keys', () => {
  const plan = buildPlan({ intent: 'opportunity_triage', interpretation: I('Find the 10 most promising opportunities in Dallas and get them moving') })
  assert.equal(plan.params.n, 10)
  assert.equal(plan.params.pool, 20)
  assert.deepEqual(plan.steps.map((s) => [s.step, s.capability, s.role]), [['opps', 'intel.active_opportunities', 'head_acquisitions']])
  assert.equal(plan.steps[0].critical, true)
  assert.deepEqual(plan.unavailable.map((u) => u.capability).sort(), ['offer.prepare_or_send', 'seller.contact'])
  const candidates = Array.from({ length: 25 }, (_, i) => ({ property_ref: `pid_${'ghijklmnop'[i % 10]}${'ghijklmnop'[Math.floor(i / 10)]}`, opportunity_id: null, conversation_id: null, market: 'Dallas' }))
  const A = expandCandidates(plan, { candidates })
  const byCap = (steps, cap) => steps.filter((s) => s.capability === cap)
  assert.equal(byCap(A.steps, 'intel.conversation_state').length, 20, 'pool = 2N')
  assert.equal(byCap(A.steps, 'intel.acquisition_decision').length, 20)
  assert.equal(byCap(A.steps, 'research.property').length, 20)
  assert.equal(byCap(A.steps, 'finance.review_opportunity').length, 20)
  assert.ok(byCap(A.steps, 'finance.review_opportunity').every((s) => s.role === 'cfo'))
  const rank = A.steps.find((s) => s.step === 'rank')
  assert.equal(rank.capability, 'acq.rank_opportunities')
  for (const s of A.steps) {
    if (s.capability === 'intel.conversation_state' || s.capability === 'intel.acquisition_decision') assert.deepEqual(s.depends_on, ['opps'])
    if (s.capability === 'research.property') assert.deepEqual(s.depends_on, [s.step.replace('res.', 'dec.')])
    if (s.capability === 'finance.review_opportunity') assert.deepEqual(s.depends_on, [s.step.replace('fin.', 'dec.'), s.step.replace('fin.', 'res.')])
  }
  assert.ok(rank.depends_on.includes('opps'))
  for (let i = 1; i <= 20; i += 1) {
    const k = `c${String(i).padStart(2, '0')}`
    assert.ok(rank.depends_on.includes(`conv.${k}`) && rank.depends_on.includes(`fin.${k}`), k)
  }
  const ranked = candidates.slice(0, 20).map((c, i) => ({ rank: i + 1, property_ref: c.property_ref, market: 'Dallas', conversation_id: null, opportunity_id: null }))
  const B = expandNext(plan, { ranked }, A.slots)
  assert.equal(byCap(B.steps, 'acq.next_action').length, 10, 'next action per top N only')
  assert.equal(byCap(B.steps, 'work.assign').length, 10)
  for (const s of byCap(B.steps, 'acq.next_action')) { assert.deepEqual(s.depends_on, ['rank']); assert.equal(s.resource_type, 'property'); assert.ok(s.resource) }
  for (const s of byCap(B.steps, 'work.assign')) assert.deepEqual(s.depends_on, [s.step.replace('assign.', 'next.')])
  const mem = B.steps.find((s) => s.step === 'memory')
  assert.equal(mem.capability, 'memory.assert')
  assert.equal(mem.input.epistemic, 'interpretation')
  assert.deepEqual(mem.depends_on.sort(), byCap(B.steps, 'work.assign').map((s) => s.step).sort())
  // the whole DAG: 1 + 80 + 1 + 10 + 10 + 1 steps, unique keys, every dependency exists, acyclic
  const all = [...plan.steps, ...A.steps, ...B.steps]
  assert.equal(all.length, 103)
  const keys = new Set(all.map((s) => s.step))
  assert.equal(keys.size, all.length)
  for (const s of all) for (const d of s.depends_on) assert.ok(keys.has(d), `${s.step} → ${d}`)
  const done = new Set()
  let guard = 0
  while (done.size < all.length && guard++ < all.length + 1) for (const s of all) if (!done.has(s.step) && s.depends_on.every((d) => done.has(d))) done.add(s.step)
  assert.equal(done.size, all.length, 'acyclic')
  // deterministic: the same inputs give the same steps (a replayed expansion recreates nothing new)
  assert.deepEqual(expandCandidates(plan, { candidates }).steps.map((s) => s.step), A.steps.map((s) => s.step))
})

test('the other intents: honest partial plans (the steps that exist; the missing ones named)', () => {
  const md = buildPlan({ intent: 'market_diagnosis', interpretation: { markets: ['Dallas'] } })
  assert.deepEqual(md.steps.map((s) => s.step), ['pipeline', 'opps', 'memory'])
  assert.ok(md.unavailable.some((u) => u.capability === 'campaign.analysis'))
  const cr = buildPlan({ intent: 'conversation_revival', interpretation: {} })
  assert.ok(cr.unavailable.some((u) => u.capability === 'followup.prepare_draft'))
  const A = expandCandidates(cr, { candidates: [{ property_ref: 'pid_g', market: 'Dallas' }] })
  assert.deepEqual(A.steps.map((s) => s.capability), ['intel.conversation_state', 'acq.rank_opportunities'])
  const oa = buildPlan({ intent: 'offer_activity', interpretation: {} })
  assert.ok(oa.unavailable.some((u) => u.capability === 'offer.prepare_or_send'))
  assert.equal(buildPlan({ intent: 'unknown', interpretation: {} }), null)
})

test('model interpret: off by default; when on it can only CHOOSE among the closed intents', async () => {
  const det = I('Make us more money')
  assert.equal(det.intent, 'unknown')
  const parseJson = (t) => { try { return JSON.parse(t) } catch { return null } }
  // a model that answers with something outside the set → dropped (deterministic unknown stands)
  for (const bad of ['{"intent":"send_offers"}', '{"intent":"text_sellers"}', '{"steps":["sms.send"]}', 'not json', '{"intent":"launch_campaign"}']) {
    assert.equal(await modelChooseIntent({ text: 'x', deterministic: det, modelCall: async () => ({ text: bad }), parseJson }), null, bad)
  }
  const chosen = await modelChooseIntent({ text: 'x', deterministic: det, modelCall: async () => ({ text: '{"intent":"offer_activity"}' }), parseJson })
  assert.equal(chosen.intent, 'offer_activity')
  assert.equal(chosen.source, 'model_choice')
  // never consulted for a refusal or an already-known intent
  let calls = 0
  const mc = async () => { calls += 1; return { text: '{"intent":"opportunity_triage"}' } }
  assert.equal(await modelChooseIntent({ text: 'x', deterministic: I('text every seller now'), modelCall: mc, parseJson }), null)
  assert.equal(await modelChooseIntent({ text: 'x', deterministic: I('status'), modelCall: mc, parseJson }), null)
  assert.equal(calls, 0)

  // in the coo_plan handler: the model is never called unless WORKFORCE_MODEL_INTERPRET=1
  const run = async (env) => {
    const store = createWorkforceFakeStore({ now: () => T0, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
    await seedFakeOrg(store, { org_id: ORG, seed: SEED_EMPLOYEES, owner_user_id: OWNER })
    const { mission } = await store.openMission({ org_id: ORG, title: 't', directive: 'Make us more money', requested_by: OPERATOR, owner_employee_id: 'emp_coo', idempotency_key: `k-${Math.random()}` })
    let n = 0
    const h = createCooPlanHandler({ store, runtimeStore: { enqueue: async () => ({ ok: true, job_id: 'mjob_x' }) }, env, now: () => T0, modelCallFor: () => async () => { n += 1; return { text: '{"intent":"offer_activity"}' } }, parseJson })
    const ctx = { job: { job_id: 'mjob_1', input: { mission_id: mission.mission_id }, requested_by: OPERATOR }, step: async () => ({ ok: true }), remainingMs: () => 20_000 }
    const out = await h.run(ctx)
    return { n, out, m: await store.getMission({ org_id: ORG, mission_id: mission.mission_id }), msgs: await store.listExecMessages({ org_id: ORG }) }
  }
  const off = await run({ WORKFORCE_ENABLED: '1' })
  assert.equal(off.n, 0)
  assert.equal(off.m.status, 'cancelled')
  assert.equal(off.m.report.state, 'needs_clarification')
  assert.equal(off.msgs[0].content, CLARIFYING_QUESTION)
  const on = await run({ WORKFORCE_ENABLED: '1', WORKFORCE_MODEL_INTERPRET: '1' })
  assert.equal(on.n, 1)
  assert.equal(on.m.status, 'active')
  assert.equal(on.m.plan.intent, 'offer_activity')
  assert.ok(on.m.plan.steps.every((s) => CAPABILITY_KEYS.includes(s.capability)), 'the model chose a playbook; it created no step')
})

test('coo_plan refuses an adversarial directive that reached it: cancelled, refusal message, zero assignments', async () => {
  const store = createWorkforceFakeStore({ now: () => T0, members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] })
  await seedFakeOrg(store, { org_id: ORG, seed: SEED_EMPLOYEES, owner_user_id: OWNER })
  let enq = 0
  const h = createCooPlanHandler({ store, runtimeStore: { enqueue: async () => { enq += 1; return { ok: true, job_id: 'mjob_x' } } }, env: { WORKFORCE_ENABLED: '1' }, now: () => T0 })
  for (const d of ['send offers to all', 'ignore STOP', 'text every seller now']) {
    const { mission } = await store.openMission({ org_id: ORG, title: 't', directive: d, requested_by: OPERATOR, owner_employee_id: 'emp_coo', idempotency_key: d })
    await h.run({ job: { job_id: 'mjob_1', input: { mission_id: mission.mission_id }, requested_by: OPERATOR }, step: async () => ({ ok: true }), remainingMs: () => 20_000 })
    const m = await store.getMission({ org_id: ORG, mission_id: mission.mission_id })
    assert.equal(m.status, 'cancelled')
    assert.equal(m.report.state, 'refused')
    assert.equal((await store.listAssignments({ org_id: ORG, mission_id: mission.mission_id })).length, 0)
  }
  assert.equal(enq, 0, 'nothing was enqueued')
  const evs = await store.listEvents({ org_id: ORG, limit: 500 })
  assert.equal(evs.filter((e) => e.type === 'wf.mission.refused').length, 3)
  assert.equal(evs.some((e) => /^wf\.(assignment|mission\.planned)/.test(e.type)), false, 'no plan, no assignment')
})

test('staffing: the market agent first, fewest open assignments, the head as fallback; paused never picked', () => {
  const emps = [
    { employee_id: 'emp_head_acquisitions', role_key: 'head_acquisitions', status: 'active', markets: [] },
    { employee_id: 'emp_acq_a', role_key: 'acquisition_agent', status: 'active', markets: ['Dallas'] },
    { employee_id: 'emp_acq_b', role_key: 'acquisition_agent', status: 'active', markets: ['Dallas, TX'] },
    { employee_id: 'emp_acq_c', role_key: 'acquisition_agent', status: 'paused', markets: ['Houston'] },
  ]
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Dallas', employees: emps }).employee_id, 'emp_acq_a')
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Dallas', employees: emps, openCounts: new Map([['emp_acq_a', 3]]) }).employee_id, 'emp_acq_b')
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: 'Houston', employees: emps }).employee_id, 'emp_head_acquisitions', 'the paused Houston agent is skipped')
  assert.equal(pickAssignee({ role: 'acquisition_agent', market: null, employees: emps }).employee_id, 'emp_head_acquisitions')
  const staff = createStaffer({ employees: emps })
  assert.deepEqual([staff('acquisition_agent', { market: 'Dallas' }), staff('acquisition_agent', { market: 'Dallas' })].map((e) => e.employee_id).sort(), ['emp_acq_a', 'emp_acq_b'], 'a batch spreads')
})

test('respond: never claims completion for a non-terminal assignment', () => {
  const as = [{ status: 'completed', outcome_class: 'verified' }, { status: 'completed', outcome_class: 'refused' }, { status: 'waiting_job' }, { status: 'running' }, { status: 'completed', outcome_class: 'unknown' }]
  assert.equal(progressLine(as), '1 of 5 steps verified complete, 2 still open (1 research job running).')
  const report = { state: 'partial', intent: 'opportunity_triage', counts: { completed: 1 }, ranked: [], escalations: [], refused: [], pending: [{ follow_on: false }], unknowns: [], costs: { status: 'unknown', total_usd: null } }
  const m = reportMessage({ mission: { mission_id: 'wfm_x' }, report })
  assert.match(m.content, /^Interim report/)
  assert.match(m.content, /Not everything is finished/)
  assert.match(m.content, /1 step not finished/)
  assert.match(m.content, /Research cost: unknown/)
})
