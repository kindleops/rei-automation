// Playbooks (docs/WORKFORCE.md §5): intent → a step DAG of CATALOG capabilities with assignee roles.
// Phase A fully implements opportunity_triage (the first demonstration):
//   1. intel.active_opportunities                         (head of acquisitions)        'opps'
//   2. per candidate intel.conversation_state + intel.acquisition_decision           'conv.cNN' 'dec.cNN'
//   3. research.property where evidence is missing / stale (within budget)            'res.cNN'
//   4. finance.review_opportunity                         (CFO)                         'fin.cNN'
//   5. acq.rank_opportunities                             (head of acquisitions)        'rank'
//   6. acq.next_action per top N                          (the market's agent / head)   'next.NN'
//   7. work.assign per next action                        (head of acquisitions)        'assign.NN'
//   8. memory.assert of the ranking as an interpretation  (COO)                         'memory'
// The candidates are not known when the plan is written, so the DAG grows in two recorded expansions
// (plan_version + 1 each): after 'opps' (steps 2–5) and after 'rank' (steps 6–8). Every step key and
// dependency is deterministic, so a replayed expansion is idempotent (assignment_create is idempotent
// on (mission, step_key)).
// The other intents get plans with the steps that exist, and list the ones that don't as unavailable.
import { WORKFORCE_LIMITS } from '../config.js'

export const PLAN_VERSION = 'wf.plan.v1'
export const PLAYBOOK_KEYS = Object.freeze(['opportunity_triage', 'market_diagnosis', 'conversation_revival', 'offer_activity', 'status_review'])
const C = Object.freeze({ OPPS: 'intel.active_opportunities', CONV: 'intel.conversation_state', DEC: 'intel.acquisition_decision', FIN: 'finance.review_opportunity', RES: 'research.property', RANK: 'acq.rank_opportunities', NEXT: 'acq.next_action', ASSIGN: 'work.assign', MEMORY: 'memory.assert' })
/** The capabilities Phase A does NOT have, named honestly in the plans that would need them. */
export const UNAVAILABLE = Object.freeze({
  campaign_analysis: Object.freeze({ capability: 'campaign.analysis', reason: 'phase_b_not_connected' }),
  followup_drafts: Object.freeze({ capability: 'followup.prepare_draft', reason: 'phase_b_not_connected' }),
  seller_contact: Object.freeze({ capability: 'seller.contact', reason: 'not_reachable_in_phase_a' }),
  offer_send: Object.freeze({ capability: 'offer.prepare_or_send', reason: 'not_reachable_in_phase_a; offer recommendations go to the CEO queue' }),
  underwriting_refresh: Object.freeze({ capability: 'underwriting.refresh', reason: 'phase_b_not_connected' }),
})

const pad = (i) => String(i).padStart(2, '0')
export const slotKey = (i) => `c${pad(i)}`

export function triageParams(interpretation = {}) {
  const n = Math.min(Math.max(Number(interpretation.count) || WORKFORCE_LIMITS.triage_default_n, 1), WORKFORCE_LIMITS.triage_max_n)
  return { n, pool: Math.min(n * 2, WORKFORCE_LIMITS.triage_pool_max), markets: interpretation.markets || [], horizon: interpretation.horizon || null, focus: interpretation.focus || [] }
}

// plan steps are jsonb: no key may end in _key (agent.payload_is_clean's credential-key rule), so a step says
// step / capability / resource; the assignment COLUMNS keep step_key / capability_key / resource_key
const step = (o) => ({ depends_on: [], input: {}, critical: false, resource_type: null, resource: null, ...o })

/**
 * @param {{ intent: string, interpretation: object }} o
 * @returns {object} plan (stored in workforce.mission.plan)
 */
export function buildPlan({ intent, interpretation = {} }) {
  const params = triageParams(interpretation)
  const base = { version: PLAN_VERSION, intent, playbook: intent, params, expansions: {} }
  switch (intent) {
    case 'opportunity_triage':
      return { ...base, variant: { decision: true, research: true, finance: true }, stages: ['opps', 'per_candidate(conv, dec, res, fin)', 'rank', 'next×N', 'assign×N', 'memory'], unavailable: [UNAVAILABLE.seller_contact, UNAVAILABLE.offer_send], expansions: { after_opps: 'pending', after_rank: 'pending' }, steps: [step({ step: 'opps', capability: C.OPPS, role: 'head_acquisitions', critical: true, expand: 'triage_candidates', input: { markets: params.markets, pool: params.pool } })] }
    case 'offer_activity':
      return { ...base, variant: { decision: true, research: true, finance: true }, stages: ['opps', 'per_candidate(conv, dec, res, fin)', 'rank', 'next×N', 'assign×N', 'memory'], unavailable: [UNAVAILABLE.offer_send, UNAVAILABLE.seller_contact], expansions: { after_opps: 'pending', after_rank: 'pending' }, steps: [step({ step: 'opps', capability: C.OPPS, role: 'head_acquisitions', critical: true, expand: 'triage_candidates', input: { markets: params.markets, pool: params.pool } })] }
    case 'conversation_revival':
      return { ...base, variant: { decision: false, research: false, finance: false }, stages: ['opps', 'per_candidate(conv)', 'rank', 'next×N', 'assign×N', 'memory'], unavailable: [UNAVAILABLE.followup_drafts, UNAVAILABLE.seller_contact], expansions: { after_opps: 'pending', after_rank: 'pending' }, steps: [step({ step: 'opps', capability: C.OPPS, role: 'head_acquisitions', critical: true, expand: 'triage_candidates', input: { markets: params.markets, pool: params.pool } })] }
    case 'market_diagnosis':
      return {
        ...base, stages: ['pipeline', 'opps', 'memory'], unavailable: [UNAVAILABLE.campaign_analysis, UNAVAILABLE.seller_contact],
        steps: [
          step({ step: 'pipeline', capability: C.OPPS, role: 'head_marketing', input: { mode: 'pipeline_overview', markets: params.markets } }),
          step({ step: 'opps', capability: C.OPPS, role: 'head_acquisitions', input: { markets: params.markets, pool: params.pool } }),
          step({ step: 'memory', capability: C.MEMORY, role: 'coo', depends_on: ['pipeline', 'opps'], input: { scope: 'mission', fact: 'market_diagnosis_inputs', epistemic: 'interpretation', from_steps: ['pipeline', 'opps'] } }),
        ],
      }
    case 'status_review':
      return { ...base, stages: [], unavailable: [], steps: [] }
    default:
      return null
  }
}

/** Expansion A (after 'opps'): the per-candidate steps and 'rank'. */
export function expandCandidates(plan, oppsOutput) {
  const v = plan.variant || { decision: true, research: true, finance: true }
  const candidates = (oppsOutput?.candidates || []).slice(0, plan.params.pool)
  const steps = []
  const slots = []
  candidates.forEach((c, idx) => {
    const k = slotKey(idx + 1)
    const ids = { property_ref: c.property_ref, opportunity_id: c.opportunity_id ?? null, conversation_id: c.conversation_id ?? null, market: c.market ?? null }
    const slot = { property_ref: c.property_ref, conv: `conv.${k}`, dec: null, res: null, fin: null }
    steps.push(step({ step: `conv.${k}`, capability: C.CONV, role: 'acquisition_agent', market: c.market ?? null, depends_on: ['opps'], input: { ...ids } }))
    if (v.decision) {
      slot.dec = `dec.${k}`
      steps.push(step({ step: `dec.${k}`, capability: C.DEC, role: 'acquisition_agent', market: c.market ?? null, depends_on: ['opps'], input: { ...ids } }))
    }
    if (v.decision && v.research) {
      slot.res = `res.${k}`
      steps.push(step({ step: `res.${k}`, capability: C.RES, role: 'research_analyst', depends_on: [`dec.${k}`], input: { ...ids, decision_step: `dec.${k}` } }))
    }
    if (v.decision && v.finance) {
      slot.fin = `fin.${k}`
      steps.push(step({ step: `fin.${k}`, capability: C.FIN, role: 'cfo', depends_on: [`dec.${k}`, ...(slot.res ? [slot.res] : [])], input: { ...ids, decision_step: `dec.${k}`, ...(slot.res ? { research_step: slot.res } : {}) } }))
    }
    slots.push(slot)
  })
  const rankDeps = ['opps', ...slots.flatMap((s) => [s.conv, s.fin || s.dec].filter(Boolean))]
  steps.push(step({ step: 'rank', capability: C.RANK, role: 'head_acquisitions', critical: true, expand: 'triage_next', depends_on: [...new Set(rankDeps)], input: { opps_step: 'opps', slots, n: plan.params.n } }))
  return { steps, slots }
}

/** Expansion B (after 'rank'): next action + delegation per top-N position, then the memory step. */
export function expandNext(plan, rankOutput, slots = []) {
  const bySlot = new Map(slots.map((s) => [s.property_ref, s]))
  const top = (rankOutput?.ranked || []).slice(0, plan.params.n)
  const steps = []
  top.forEach((r) => {
    const k = pad(r.rank)
    const s = bySlot.get(r.property_ref) || {}
    const ids = { property_ref: r.property_ref, opportunity_id: r.opportunity_id ?? null, conversation_id: r.conversation_id ?? null, market: r.market ?? null }
    steps.push(step({
      step: `next.${k}`, capability: C.NEXT, role: 'acquisition_agent', market: r.market ?? null, depends_on: ['rank'],
      input: { ...ids, rank_step: 'rank', position: r.rank, conv_step: s.conv ?? null, dec_step: s.dec ?? null, fin_step: s.fin ?? null, res_step: s.res ?? null },
      resource_type: r.conversation_id ? 'thread' : 'property', resource: r.conversation_id || r.property_ref,
    }))
    steps.push(step({ step: `assign.${k}`, capability: C.ASSIGN, role: 'head_acquisitions', depends_on: [`next.${k}`], input: { ...ids, next_step: `next.${k}`, position: r.rank } }))
  })
  const nexts = steps.filter((x) => x.capability === C.NEXT).map((x) => x.step)
  const assigns = steps.filter((x) => x.capability === C.ASSIGN).map((x) => x.step)
  steps.push(step({ step: 'memory', capability: C.MEMORY, role: 'coo', depends_on: assigns.length ? assigns : ['rank'], input: { scope: 'mission', fact: 'triage_ranking', epistemic: 'interpretation', from_rank_step: 'rank', from_next_steps: nexts } }))
  return { steps }
}

/** Plan → the honest one-paragraph description (respond.js uses it). */
export function describePlan(plan) {
  if (!plan) return null
  return { intent: plan.intent, params: plan.params, stages: plan.stages, steps: plan.steps.length, unavailable: plan.unavailable }
}
