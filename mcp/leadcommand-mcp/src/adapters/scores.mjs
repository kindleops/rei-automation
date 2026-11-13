// Acquisition score: public.property_acquisition_scores (THE canonical Decision
// Engine output; one row per property, written only when the engine runs — a
// low row count is the lifecycle, not missing coverage).
//
// REUSED: the freshness contract of decisionAuthority.js (now in the pure
// module decisionFreshness.js, re-exported unchanged by decisionAuthority):
// evaluateDecisionFreshness, buildDecisionInputStamp, MATERIAL_PROPERTY_FIELDS,
// resolveEconomicsDisplayState. The engine itself (a write path) is NOT imported.
//
// A missing row is "decision_engine_not_run": every number is null and the
// provenance says missing. It is never 0.
import { evaluateDecisionFreshness, buildDecisionInputStamp, MATERIAL_PROPERTY_FIELDS, resolveEconomicsDisplayState, DEFAULT_MAX_AGE_DAYS, DECISION_STATUS } from '@/lib/acquisition/decisionFreshness.js'
import { prov, missing } from '../provenance.mjs'
import { num, clean, isoOrNull, read } from './common.mjs'

// explicit projection. NOT returned in 1.0: minimum_acceptable_offer, expected_assignment_fee
// (negotiation floor), owner_situation_* and recommended_conversation_angle / offer_stack
// (inferences about the owner's personal situation and negotiation tactics), evidence (raw).
export const SCORE_COLUMNS = 'property_id,valuation_low,valuation_mid,valuation_high,valuation_confidence,comp_count,investor_ceiling_low,investor_ceiling_mid,investor_ceiling_high,recommended_cash_offer,estimated_repairs,buyer_demand_score,liquidity_score,aos_score,confidence,decision_tier,best_strategy,transaction_probability_90,transaction_probability_180,transaction_probability_365,seller_financial_pressure_score,forced_sale_pressure_score,foreclosure_risk_score,tax_pain_score,debt_pressure_score,equity_unlock_score,repair_burden_score,computed_at,created_at,evidence'
const FRESHNESS_COLUMNS = ['property_id', ...MATERIAL_PROPERTY_FIELDS].join(',')

export async function getAcquisitionScore(input, svc, { now }) {
  const id = input.property_id
  const [scoreRes, propRes] = await Promise.all([
    read(svc.db.from('property_acquisition_scores').select(SCORE_COLUMNS).eq('property_id', id).limit(1), 'property_acquisition_scores'),
    read(svc.db.from('properties').select(FRESHNESS_COLUMNS).eq('property_id', id).limit(1), 'properties').catch(() => ({ rows: [], failed: true })),
  ])
  const score = scoreRes.rows[0] || null
  const property = propRes.rows[0] || null

  if (!score) {
    const display = resolveEconomicsDisplayState({ score: null })
    return {
      property_id: id,
      available: false,
      status: DECISION_STATUS.NOT_RUN,
      display_state: display.state,
      property_record_found: Boolean(property),
      valuation: null, investor_ceiling: null, offer: null, scores: null,
      freshness: null,
      provenance: missing('property_acquisition_scores', 'decision_engine_not_run (absence is not a score of 0)'),
      note: 'The Decision Engine has not produced a result for this property. Absence means "not run", never a value of 0.',
    }
  }

  // Property-input drift check: the stamp is rebuilt from the CURRENT property row with the
  // seller-stated facts the engine recorded (seller facts are not re-read here), so a STALE
  // verdict names property inputs that moved; seller-fact drift is out of scope for this read.
  const recordedSeller = score.evidence?.decision_inputs?.inputs?.seller || {}
  const stamp = property ? buildDecisionInputStamp(property, recordedSeller, now) : null
  const freshness = evaluateDecisionFreshness({ score, stamp, now, maxAgeDays: DEFAULT_MAX_AGE_DAYS })
  const display = resolveEconomicsDisplayState({ score, freshness })
  const stale = freshness.status !== DECISION_STATUS.CURRENT
  const kind = stale ? 'stale' : 'derived'
  const p = (extra = {}) => ({ ...prov({ kind: 'derived', source: 'property_acquisition_scores (Decision Engine output)', as_of: score.computed_at, rule: 'acquisitionDecisionEngine v2 (persisted run)', now }), ...(stale ? { kind, reason: freshness.reason } : {}), ...extra })
  const band = (lo, mid, hi) => (lo == null && mid == null && hi == null ? null : { low: num(lo), mid: num(mid), high: num(hi) })
  return {
    property_id: id,
    available: true,
    status: freshness.status,
    display_state: display.state,
    property_record_found: Boolean(property),
    valuation: { band: band(score.valuation_low, score.valuation_mid, score.valuation_high), confidence: num(score.valuation_confidence), comp_count: num(score.comp_count), lane: null, lane_note: 'The engine row carries no valuation-lane label; treat as a reference, not the binding lane value.', provenance: p() },
    investor_ceiling: { band: band(score.investor_ceiling_low, score.investor_ceiling_mid, score.investor_ceiling_high), provenance: p() },
    offer: { recommended_cash_offer: num(score.recommended_cash_offer), estimated_repairs: num(score.estimated_repairs), provenance: p({ reason: stale ? freshness.reason : 'engine recommendation, not a sent offer' }) },
    scores: {
      aos_score: num(score.aos_score), decision_tier: clean(score.decision_tier), confidence: num(score.confidence), best_strategy: clean(score.best_strategy),
      buyer_demand: num(score.buyer_demand_score), liquidity: num(score.liquidity_score),
      transaction_probability: { d90: num(score.transaction_probability_90), d180: num(score.transaction_probability_180), d365: num(score.transaction_probability_365) },
      pressure: { seller_financial: num(score.seller_financial_pressure_score), forced_sale: num(score.forced_sale_pressure_score), foreclosure_risk: num(score.foreclosure_risk_score), tax_pain: num(score.tax_pain_score), debt: num(score.debt_pressure_score), equity_unlock: num(score.equity_unlock_score), repair_burden: num(score.repair_burden_score) },
      provenance: p(),
    },
    freshness: {
      status: freshness.status, reason: freshness.reason, age_days: freshness.age_days == null ? null : Math.round(freshness.age_days * 10) / 10,
      max_age_days: DEFAULT_MAX_AGE_DAYS,
      changed_inputs: (freshness.changed_inputs || []).slice(0, 12).map((c) => ({ scope: c.scope, field: c.field })), // field names only
      seller_facts_rechecked: false,
      computed_at: isoOrNull(score.computed_at),
      rule: 'decisionFreshness#evaluateDecisionFreshness',
    },
    provenance: p(),
    withheld: ['minimum_acceptable_offer', 'expected_assignment_fee', 'owner_situation_primary', 'owner_situation_scores', 'recommended_conversation_angle', 'recommended_offer_stack', 'evidence'],
  }
}
