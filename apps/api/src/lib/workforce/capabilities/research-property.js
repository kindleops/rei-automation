// research.property (internal) — enqueue the EXISTING property.research runtime kind (its own job,
// its own budget, its own gates: PROPERTY_RESEARCH_ENABLED + the kind armed in kind_limits) and park
// the assignment as waiting_job until agent.research_job says completed / failed. Only where the
// evidence is missing or stale, and only within the mission's research budget. requested_by is the
// named operator who issued the directive (the R2 rule); the employee is attribution only.
import { CapabilityError, arr, clean, decodePropertyRef, depOutput, done, waitJob } from './shared.js'

export const KEY = 'research.property'
const STALE_REASONS = new Set(['not_scored', 'score_stale', 'score_predates_current_policy'])

/** Is research warranted by the decision read? → { needed, reasons } */
export function researchNeed(decisionDep) {
  if (!decisionDep) return { needed: true, reasons: ['decision_unread'] }
  const d = decisionDep.output || {}
  const reasons = []
  if (d.status === 'not_run') reasons.push('no_decision_row')
  if (STALE_REASONS.has(d.offer_ready?.reason)) reasons.push(`decision_${d.offer_ready.reason}`)
  const c = d.comps || {}
  if (c.selected == null) reasons.push('comp_evidence_unknown')
  else if (Number(c.selected) < Number(d.min_comp_count || 5)) reasons.push('thin_comp_evidence')
  if (c.median_age_months != null && Number(c.median_age_months) > 12) reasons.push('stale_comp_evidence')
  return { needed: reasons.length > 0, reasons }
}

export const capability = Object.freeze({
  key: KEY,
  class: 'internal',
  roles: Object.freeze(['research_analyst', 'head_data_intelligence', 'head_acquisitions', 'acquisition_agent']),
  escalates_on: Object.freeze([]),
  resourceOf: (_ctx, input) => ({ property_id: decodePropertyRef(input.property_ref), opportunity_id: input.opportunity_id ?? null, conversation_id: input.conversation_id ?? null, market: input.market ?? null }),
  async run(ctx, input = {}) {
    // the delegated research of an external agent (playbooks.js DELEGATED) is the agent's own work: run here (a handoff to an
    // internal employee), it is not done — an honest unknown, never a silent success
    if (input.mode === 'delegated_review') return done({ mode: 'delegated_review', enqueued: false, skipped: 'delegated_review_is_agent_work', candidates: arr(input.candidates).length }, { outcome_class: 'unknown' })
    const property_id = clean(decodePropertyRef(input.property_ref))
    if (!property_id) throw new CapabilityError('PROPERTY_REF_REQUIRED', { retryable: false })
    const need = input.force === true ? { needed: true, reasons: ['requested'] } : researchNeed(input.decision_step ? depOutput(ctx, input.decision_step) : null)
    const base = { property_ref: input.property_ref, needed: need.needed, reasons: need.reasons }
    if (!need.needed) return done({ ...base, enqueued: false, skipped: 'evidence_current' })
    // the mission's research budget (each enqueued job also has its own runtime budget)
    const limit = Math.max(0, Number(input.budget_limit ?? ctx.limits?.research_per_mission ?? 5))
    const used = arr(ctx.missionAssignments).filter((a) => a.capability_key === KEY && a.assignment_id !== ctx.assignment?.assignment_id && (a.output?.enqueued === true || a.runtime_job_id)).length
    if (used >= limit) return done({ ...base, enqueued: false, skipped: 'research_budget_exhausted', budget: { limit, used } }, { outcome_class: 'unknown' })
    if (typeof ctx.services?.researchEnabled === 'function' && ctx.services.researchEnabled() !== true) return done({ ...base, enqueued: false, skipped: 'property_research_disabled' }, { outcome_class: 'unknown' })
    if (typeof ctx.runtime?.enqueueResearch !== 'function') return done({ ...base, enqueued: false, skipped: 'runtime_unavailable' }, { outcome_class: 'unknown' })
    const r = await ctx.runtime.enqueueResearch({ property_id, requested_by: ctx.requested_by, mission_id: ctx.mission?.mission_id, trigger: 'valuation_stale_or_missing' })
    if (!r?.ok) return done({ ...base, enqueued: false, skipped: `enqueue_refused:${String(r?.reason || 'unknown').slice(0, 40)}` }, { outcome_class: 'unknown' })
    return waitJob(r.job_id, { ...base, enqueued: true, job_id: r.job_id, deduped: r.deduped === true })
  },
})
