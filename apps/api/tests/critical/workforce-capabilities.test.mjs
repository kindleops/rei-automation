// Workforce Phase A — the capability adapters over stubbed services with the wiring's signatures: the
// REAL action-center derivation, fail-closed holds, no contact value in any output, research only where
// the evidence needs it (within budget, as the named operator), memory epistemics, delegation.
import test from 'node:test'
import assert from 'node:assert/strict'

import { CAPABILITIES } from '../../src/lib/workforce/capabilities/catalog.js'
import { contactViolation } from '../helpers/workforce-fake-store.mjs'
import { OPERATOR, T0, makeServices, opp } from '../helpers/workforce-fixtures.mjs'
import { waiting } from '../helpers/operations-fixtures.mjs'

const C = CAPABILITIES
const done = (output, outcome_class = 'verified', extra = {}) => ({ assignment_id: `wfa_${Math.random().toString(16).slice(2)}`, status: 'completed', outcome_class, output, ...extra })

test('intel.active_opportunities: excludes held / suppressed / Hartford / Maxwell / closed; a hold registry outage FAILS CLOSED', async () => {
  const book = [opp(1), opp(2, { held: true }), opp(3, { suppressed: true, suppression_status: 'suppressed' }), opp(4, { status: 'dead' }), opp(5, { property_id: '225438557' }), opp(6, { property_id: '251027062' })]
  const out = await C['intel.active_opportunities'].run({ services: makeServices(book) }, { markets: ['Dallas'], pool: 10 })
  assert.equal(out.outcome_class, 'verified')
  assert.deepEqual(out.output.candidates.map((c) => c.property_ref), [opp(1).property_ref])
  assert.deepEqual(out.output.excluded, { closed: 1, suppressed: 1, held: 1, never_revive: 2, out_of_scope: 0, no_property: 0 })
  assert.equal(contactViolation(out), null, 'no thread key, phone or owner name in the output')
  assert.equal(JSON.stringify(out).includes('Owner '), false)
  await assert.rejects(() => C['intel.active_opportunities'].run({ services: makeServices(book, { holdsFail: true }) }, { markets: ['Dallas'] }), (e) => e.code === 'HOLDS_UNAVAILABLE')
  const ov = await C['intel.active_opportunities'].run({ services: makeServices(book) }, { mode: 'pipeline_overview', markets: ['Dallas'] })
  assert.equal(ov.output.source, 'pipeline-command-service.getPipelineCommandOverview')
  assert.equal(ov.output.totals.opportunities, 6)
})

test('intel.conversation_state: the REAL deriveActionState over normalized facts; holds; suppression; nothing contact-shaped out', async () => {
  const x = opp(1)
  const svc = { ...makeServices([x]), conversationFacts: async () => waiting({ conversation_id: x.conversation_id }) }
  delete svc.storedActionState
  const out = await C['intel.conversation_state'].run({ services: svc, now: Date.parse('2026-10-15T15:00:00Z') }, { property_ref: x.property_ref, conversation_id: x.conversation_id })
  assert.equal(out.output.action_state, 'needs_attention', 'a seller waiting with no next action')
  assert.ok(out.output.sources.includes('action-center.deriveActionState'))
  assert.equal(out.output.contact_permitted, true)
  assert.equal(out.output.message_count, 2)
  assert.equal(contactViolation(out), null, 'the thread context had a phone and a body: neither leaves the adapter')
  assert.equal(JSON.stringify(out).includes('call me'), false)
  const held = await C['intel.conversation_state'].run({ services: makeServices([opp(2, { held: true })]), now: T0 }, { property_ref: opp(2).property_ref })
  assert.equal(held.output.held, true)
  assert.equal(held.output.contact_permitted, false)
  const supp = await C['intel.conversation_state'].run({ services: makeServices([opp(3, { suppressed: true })]), now: T0 }, { property_ref: opp(3).property_ref })
  assert.equal(supp.output.suppressed, true)
  assert.equal(supp.output.contact_permitted, false)
  // Maxwell is matched even by its thread key hash alone (the static exclusion)
  const mx = await C['intel.conversation_state'].run({ services: makeServices([opp(9, { property_id: '251027062' })]), now: T0 }, { property_ref: opp(9, { property_id: '251027062' }).property_ref })
  assert.equal(mx.outcome_class, 'refused')
  assert.equal(mx.output.excluded, 'PERMANENT_EXCLUSION')
})

test('intel.acquisition_decision: reads only (no ensure / on-demand engine run)', async () => {
  const x = opp(1)
  const svc = makeServices([x])
  const out = await C['intel.acquisition_decision'].run({ services: svc, now: T0 }, { property_ref: x.property_ref })
  assert.equal(out.output.mao, 175_000)
  assert.equal(out.output.ask, 190_000)
  assert.deepEqual(Object.keys(svc.calls).sort(), ['getDealDecision', 'loadAcquisitionScore'])
  assert.equal(contactViolation(out), null, 'getDealDecision returned a contact phone: it is not copied')
  const none = await C['intel.acquisition_decision'].run({ services: makeServices([opp(2, { score: null })]), now: T0 }, { property_ref: opp(2).property_ref })
  assert.equal(none.output.status, 'not_run')
  assert.equal(none.output.mao, null)
})

test('research.property: only where evidence is missing / stale, within budget, gated, as the named operator', async () => {
  const x = opp(1)
  const enq = []
  const ctx = (o = {}) => ({ services: makeServices([x]), mission: { mission_id: 'wfm_x', requested_by: OPERATOR }, requested_by: OPERATOR, assignment: { assignment_id: 'wfa_me' }, missionAssignments: [], runtime: { enqueueResearch: async (r) => { enq.push(r); return { ok: true, job_id: 'mjob_1' } } }, limits: { research_per_mission: 2 }, ...o })
  const current = { 'dec.c01': done({ status: 'available', offer_ready: { ready: true, reason: 'offer_ready' }, comps: { selected: 6, median_age_months: 3 }, min_comp_count: 5 }) }
  const r1 = await C['research.property'].run({ ...ctx(), deps: current }, { property_ref: x.property_ref, decision_step: 'dec.c01' })
  assert.equal(r1.output.needed, false)
  assert.equal(enq.length, 0)
  const stale = { 'dec.c01': done({ status: 'available', offer_ready: { ready: false, reason: 'score_stale' }, comps: { selected: 2 }, min_comp_count: 5 }) }
  const r2 = await C['research.property'].run({ ...ctx(), deps: stale }, { property_ref: x.property_ref, decision_step: 'dec.c01' })
  assert.equal(r2.status, 'waiting_job')
  assert.equal(r2.runtime_job_id, 'mjob_1')
  assert.deepEqual(r2.output.reasons, ['decision_score_stale', 'thin_comp_evidence'])
  assert.equal(enq[0].requested_by, OPERATOR)
  const used = [{ capability_key: 'research.property', assignment_id: 'a', runtime_job_id: 'mjob_a' }, { capability_key: 'research.property', assignment_id: 'b', output: { enqueued: true } }]
  const r3 = await C['research.property'].run({ ...ctx({ missionAssignments: used }), deps: stale }, { property_ref: x.property_ref, decision_step: 'dec.c01' })
  assert.equal(r3.output.skipped, 'research_budget_exhausted')
  assert.equal(r3.outcome_class, 'unknown')
  const off = await C['research.property'].run({ ...ctx({ services: makeServices([x], { researchEnabled: false }) }), deps: stale }, { property_ref: x.property_ref, decision_step: 'dec.c01' })
  assert.equal(off.output.skipped, 'property_research_disabled')
  assert.equal(enq.length, 1)
})

test('memory.assert: interpretations for AI; ceo_policy refused; verified needs a source', async () => {
  const facts = []
  const store = { assertMemoryFact: async (f) => { facts.push(f); return { fact_id: 'f1' } } }
  const ctx = { store, org_id: 'o', mission: { mission_id: 'wfm_x' }, employee: { employee_id: 'emp_coo', kind: 'ai' }, deps: { rank: done({ version: 'v', method: 'm', ranked: [{ rank: 1, property_ref: 'pid_g', ev: { status: 'unknown', value: null } }] }) } }
  const ok = await C['memory.assert'].run(ctx, { scope: 'mission', fact_key: 'triage_ranking', epistemic: 'interpretation', from_rank_step: 'rank' })
  assert.equal(ok.output.asserted, true)
  assert.equal(facts[0].epistemic, 'interpretation')
  assert.deepEqual(facts[0].value.ranked, [{ rank: 1, property_ref: 'pid_g', cfo_verdict: null, ev: null, ev_status: 'unknown', next_action: null }])
  assert.equal(facts[0].source_refs.length, 1)
  assert.equal((await C['memory.assert'].run(ctx, { epistemic: 'ceo_policy', value: { x: 1 } })).outcome_class, 'refused')
  assert.equal((await C['memory.assert'].run(ctx, { epistemic: 'verified', value: { x: 1 } })).output.refused, 'verified_needs_a_source_ref')
  assert.equal(facts.length, 1)
})

test('work.assign: delegates per next action (the CEO queue for anything a person decides); a follow-on item is never executed by an AI', async () => {
  const created = []
  const store = { createAssignment: async (a) => { created.push(a); return { assignment: { assignment_id: 'wfa_fo', ...a }, created: true } } }
  const ceo = { employee_id: 'emp_ceo', kind: 'human' }
  const analyst = { employee_id: 'emp_research_01', kind: 'ai' }
  const ctx = (action) => ({ store, org_id: 'o', mission: { mission_id: 'wfm_x' }, assignment: { assignment_id: 'wfa_me', step_key: 'assign.01' }, employee: { employee_id: 'emp_head_acquisitions' }, staff: (role) => (role === 'ceo' ? ceo : role === 'research_analyst' ? analyst : null), deps: { 'next.01': done({ position: 1, property_ref: 'pid_g', action, reasons: ['r'] }) } })
  const rev = await C['work.assign'].run(ctx('prepare_offer_recommendation'), { next_step: 'next.01', position: 1 })
  assert.equal(rev.output.assignee_employee_id, 'emp_ceo')
  assert.equal(rev.output.task, 'review_offer_recommendation')
  assert.equal(created[0].capability_key, 'work.assign')
  assert.equal(created[0].input.follow_on, true)
  const res = await C['work.assign'].run(ctx('research'), { next_step: 'next.01', position: 1 })
  assert.equal(created[1].capability_key, 'research.property')
  assert.equal(created[1].assignee_employee_id, 'emp_research_01')
  assert.equal(res.output.assigned, true)
  for (const a of ['await_seller', 'hold', 'none']) assert.equal((await C['work.assign'].run(ctx(a), { next_step: 'next.01' })).output.assigned, false)
  assert.equal(created.length, 2)
  const fo = await C['work.assign'].run(ctx('operator_review'), { follow_on: true, task: 'operator_review' })
  assert.equal(fo.outcome_class, 'refused')
  for (const c of created) assert.ok(['work.assign', 'research.property'].includes(c.capability_key), 'a follow-on is never a send-like capability')
})
