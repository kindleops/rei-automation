// finance.review_opportunity (read) — the CFO's independent verdict (finance/cfo-review.js).
// Independence: the CFO RE-READS the Decision Engine itself (the same read the acquisitions step used)
// and judges the acquisitions view against it; it never takes the acquisitions numbers as inputs.
// If it cannot re-read, it judges the upstream engine read (still the engine's numbers) and says so.
import { reviewOpportunity } from '../finance/cfo-review.js'
import { readAcquisitionDecision } from './acquisition-decision.js'
import { CapabilityError, clean, decodePropertyRef, depOutput, done, obj, ref, usable, uuidOrNull } from './shared.js'

export const KEY = 'finance.review_opportunity'

export const capability = Object.freeze({
  key: KEY,
  class: 'read',
  roles: Object.freeze(['cfo']),
  // a price at/above the executive review threshold goes to the CEO before the CFO opines
  escalates_on: Object.freeze(['price']),
  resourceOf: (_ctx, input) => ({ property_id: decodePropertyRef(input.property_ref), opportunity_id: input.opportunity_id ?? null, conversation_id: input.conversation_id ?? null, market: input.market ?? null }),
  async run(ctx, input = {}) {
    const property_id = clean(decodePropertyRef(input.property_ref))
    if (!property_id) throw new CapabilityError('PROPERTY_REF_REQUIRED', { retryable: false })
    const upstream = input.decision_step ? depOutput(ctx, input.decision_step) : null
    let decision = null
    let basis = null
    const s = ctx.services || {}
    if (typeof s.loadAcquisitionScore === 'function' || typeof s.getDealDecision === 'function') {
      decision = await readAcquisitionDecision(s, { property_id, opportunity_id: uuidOrNull(input.opportunity_id), now: ctx.now ?? Date.now() })
      basis = 'cfo_reread'
    } else if (usable(upstream)) {
      decision = upstream.output
      basis = 'upstream_engine_read'
    }
    // the acquisitions view: an explicit proposal, or what the acquisitions read concluded
    const acqView = input.proposal && typeof input.proposal === 'object' ? input.proposal : upstream ? { ask: upstream.output.ask ?? null, claimed_mao: upstream.output.mao ?? null } : null
    const review = reviewOpportunity({ decision, acquisitions: acqView })
    const research = input.research_step ? depOutput(ctx, input.research_step) : null
    const notes = [...review.notes]
    if (upstream && decision && basis === 'cfo_reread' && upstream.output?.mao != null && decision.mao != null && upstream.output.mao !== decision.mao) notes.push('ENGINE_MAO_CHANGED_SINCE_ACQ_READ')
    if (research?.output?.needed && !research.output.result_received) notes.push('RESEARCH_PENDING_OR_SKIPPED')
    return done({
      property_ref: input.property_ref,
      verdict: review.verdict,
      reasons: review.reasons,
      supports: review.supports,
      notes,
      figures: review.figures,
      basis,
      version: review.version,
      acquisitions_view: acqView ? Object.fromEntries(Object.entries(obj(acqView)).filter(([k]) => ['ask', 'claimed_mao', 'proposed_offer', 'claimed_spread_usd', 'claimed_confidence', 'thesis'].includes(k)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 40) : v])) : null,
    }, { outcome_class: decision ? 'verified' : 'partial', evidence: [upstream ? ref('assignment', upstream.assignment_id) : null, basis === 'cfo_reread' ? ref('service', 'property_acquisition_scores') : null] })
  },
})
