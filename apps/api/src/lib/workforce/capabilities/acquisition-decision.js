// intel.acquisition_decision (read) — the Decision Engine's current row for one property, judged by
// the SAME predicates the seller paths use: offerReadiness authoritativeMaxOffer / evaluateOfferReadiness
// and valuation-offer-authority resolveValuationSpendability, plus the Deal Intelligence decision read
// (deal-decision-service getDealDecision) for the ask, the comp evidence and the freshness.
// NO WRITES: never ensurePropertyAcquisitionDecision. A property with no row is "not_run", not an error.
import { authoritativeMaxOffer, evaluateOfferReadiness } from '../../acquisition/offerReadiness.js'
import { resolveValuationSpendability, MAD_MIN_COMP_COUNT } from '../../domain/seller-flow/valuation-offer-authority.js'
import { CapabilityError, arr, clean, code, decodePropertyRef, done, iso, ms, num, obj, pos, ref, unit, uuidOrNull } from './shared.js'

export const KEY = 'intel.acquisition_decision'
const DAY = 86_400_000

/** Comp evidence quality from the engine's own evidence (count, recency, distance, dispersion). */
export function compEvidence(score, decision, now = Date.now()) {
  const ev = obj(score?.evidence)
  const selected = arr(ev.selected_comps)
  if (selected.length || num(score?.comp_count) != null) {
    const ages = selected.map((c) => ms(c.sale_date || c.sold_date)).filter((t) => t != null).map((t) => (now - t) / (30.44 * DAY)).sort((a, b) => a - b)
    const dists = selected.map((c) => num(c.distance_miles)).filter((v) => v != null)
    return {
      selected: selected.length || num(score?.comp_count),
      median_age_months: ages.length ? Math.round(ages[Math.floor(ages.length / 2)] * 10) / 10 : null,
      avg_distance_miles: dists.length ? Math.round((dists.reduce((a, b) => a + b, 0) / dists.length) * 100) / 100 : null,
      dispersion: num(obj(ev.valuation_calculation_summary).dispersion_ratio),
      source: 'property_acquisition_scores.evidence',
    }
  }
  const c = obj(decision?.comps)
  if (Object.keys(c).length) return { selected: num(c.selected), median_age_months: num(c.medianAgeMonths), avg_distance_miles: num(c.avgDistanceMiles), dispersion: num(c.dispersion), source: 'deal-decision-service.getDealDecision' }
  return { selected: null, median_age_months: null, avg_distance_miles: null, dispersion: null, source: null }
}

/** The read, shared with the CFO's independent re-read. */
export async function readAcquisitionDecision(services, { property_id, opportunity_id = null, now = Date.now() }) {
  const s = services || {}
  if (typeof s.loadAcquisitionScore !== 'function' && typeof s.getDealDecision !== 'function') throw new CapabilityError('DECISION_READ_UNAVAILABLE', { retryable: false })
  const [score, decision] = await Promise.all([
    typeof s.loadAcquisitionScore === 'function' ? s.loadAcquisitionScore({ property_id }) : null,
    typeof s.getDealDecision === 'function' ? s.getDealDecision({ propertyId: property_id, opportunityId: opportunity_id || undefined }).catch(() => null) : null,
  ])
  const readiness = evaluateOfferReadiness(score || null, { now })
  const mao = authoritativeMaxOffer(score || null)
  const spend = resolveValuationSpendability({ valuation: score || null })
  const d = obj(decision)
  const computed_at = iso(score?.computed_at ?? d?.decision?.computedAt)
  const ask = pos(obj(obj(d.offer).negotiation).ask)
  const comps = compEvidence(score, d, now)
  const identity_conflict = obj(obj(score?.evidence).subject).asset_identity_conflict === true || d?.comps?.assetIntegrity?.conflict === true
  return {
    status: score ? 'available' : d?.decision?.status === 'available' ? 'decision_only' : 'not_run',
    tier: code(score?.decision_tier ?? d?.decision?.tier),
    computed_at,
    age_days: computed_at ? Math.floor((now - ms(computed_at)) / DAY) : null,
    confidence: unit(score?.confidence ?? d?.decision?.confidence),
    valuation_confidence: unit(score?.valuation_confidence ?? d?.decision?.valuationConfidence),
    valuation_mid: pos(score?.valuation_mid ?? d?.valuation?.mid),
    recommended_offer: pos(score?.recommended_cash_offer ?? d?.offer?.recommended),
    expected_assignment_fee: pos(score?.expected_assignment_fee ?? d?.offer?.expectedFee),
    mao, // the engine's effective authorized ceiling, or null: never investor_ceiling_mid
    offer_ready: { ready: readiness.ready === true, reason: code(readiness.reason) },
    spendability: { spendable: spend.spendable === true, reason: code(spend.reason), comp_count: spend.comp_count, contamination_defense: code(spend.contamination_defense) },
    comps,
    ask,
    ask_source: ask ? 'deal-decision-service.offer.negotiation.ask' : null,
    asset_identity_conflict: identity_conflict,
    valuation_uncertain: identity_conflict || ['valuation_offer_sanity_failed', 'valuation_low_comp_count_without_contamination_defense'].includes(spend.reason),
    min_comp_count: MAD_MIN_COMP_COUNT,
    sources: [score ? 'property_acquisition_scores' : null, decision ? 'deal-decision-service.getDealDecision' : null].filter(Boolean),
  }
}

export const capability = Object.freeze({
  key: KEY,
  class: 'read',
  roles: Object.freeze(['head_acquisitions', 'acquisition_agent', 'cfo', 'head_dispositions', 'dispositions_agent']),
  escalates_on: Object.freeze([]),
  resourceOf: (_ctx, input) => ({ property_id: decodePropertyRef(input.property_ref), opportunity_id: input.opportunity_id ?? null, conversation_id: input.conversation_id ?? null, market: input.market ?? null }),
  async run(ctx, input = {}) {
    const property_id = clean(decodePropertyRef(input.property_ref))
    if (!property_id) throw new CapabilityError('PROPERTY_REF_REQUIRED', { retryable: false })
    const r = await readAcquisitionDecision(ctx.services, { property_id, opportunity_id: uuidOrNull(input.opportunity_id), now: ctx.now ?? Date.now() })
    const output = { property_ref: input.property_ref, ...r }
    const outcome_class = r.status === 'available' ? 'verified' : r.status === 'decision_only' ? 'partial' : 'verified' // "not run" is a verified fact, never a number
    return done(output, { outcome_class, evidence: r.sources.map((x) => ref('service', x)) })
  },
})
