// ─── NEGOTIATION PATHWAY (8.5.21-b, owner directive Phase 8) ──────────────────
// One INTERNAL view per opportunity that an operator (or the envelope proposal) reads:
//   class                HOT | NEGOTIATE | NURTURE | INVESTIGATE | PASS  (opportunity economics)
//   mao                  the engine's authoritative ceiling — a CEILING, never the opening
//   opening_range        strictly below the MAO (offer plan), or null without an engine MAO
//   justification        why (economics reasons + strategy factors)
//   concessions          the ordered ladder of what may be given INSIDE authority (terms first,
//                        then price steps toward — never above — the ceiling)
//   flexibility          seller flexibility signals (fact ledger only)
//   closing_requirements what must be true before a contract (title, decision makers, liens …)
//   buyer_liquidity      engine demand + area investor activity + the ZIP prior liquidity
//   complexity / friction / margin
//   land_zoning_first    for land with an ask the lot cannot carry: zoning / density FIRST
//   next_action          one evidence-backed next step (an operator act or a read — never a send)
// Reuses classifyOpportunityEconomics + planOffer + assessImpossibleAsk; adds no new valuation.
// visibility: internal_only — nothing here is seller-facing (composerView / checkSellerFacingText).
import { stripProtectedAttributes } from '../opportunity-economics/classify-opportunity.js'

export const PATHWAY_VERSION = 'negotiation-pathway.v1'
export const PATHWAY_CLASSES = Object.freeze(['HOT', 'NEGOTIATE', 'NURTURE', 'INVESTIGATE', 'PASS'])

const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const r0 = (n) => (n == null ? null : Math.round(n))

const MISSING_ACTION = Object.freeze({
  asking_price: 'ask_seller_for_asking_price',
  plausible_asking_price: 'confirm_asking_price',
  confirm_asking_price: 'confirm_asking_price',
  decision_engine_run: 'run_decision_engine_valuation_refresh',
  current_decision_engine_run: 'rerun_decision_engine_valuation_refresh',
  credible_valuation: 'research_comps_then_rerun_engine',
  authoritative_mao: 'rerun_decision_engine_or_operator_price',
  asset_classification: 'verify_asset_type_and_units',
  zoning: 'verify_zoning_and_entitled_density',
  zoning_interpretation: 'verify_zoning_and_entitled_density',
  entitled_density_and_land_comps: 'verify_entitled_density_then_land_comps',
  finished_home_value_near_lot: 'pull_finished_home_sales_near_the_lot',
  land_comps: 'pull_land_comps',
  buyer_demand: 'confirm_buyer_demand_in_area',
  unit_count_for_per_door_price: 'verify_unit_count',
})

function concessionLadder({ plan, envelopeTerms = null }) {
  const out = []
  // terms first (no money): closing speed, as-is, who pays closing costs — inside the grant only
  out.push({ step: 1, kind: 'terms', give: 'closing_timeline_flexibility', within: envelopeTerms ? `closing ${envelopeTerms.closing_window_days?.join('-')} days` : 'requires_envelope_terms' })
  out.push({ step: 2, kind: 'terms', give: 'buy_as_is_no_repairs', within: 'policy_default' })
  out.push({ step: 3, kind: 'terms', give: 'buyer_pays_customary_closing_costs', within: envelopeTerms ? `closing costs: ${envelopeTerms.closing_costs_paid_by}` : 'requires_envelope_terms' })
  if (plan?.available) {
    const open = num(plan.opening?.recommended)
    const mao = num(plan.mao?.amount)
    const room = mao && open ? mao - open : null
    if (room > 0) {
      // price steps: half the room, then a final move AT MOST to the ceiling (never above)
      out.push({ step: 4, kind: 'price', give: 'counter_half_way_toward_seller', max_step_usd: r0(room / 2), ceiling_respected: true })
      out.push({ step: 5, kind: 'price', give: 'final_move_up_to_ceiling', max_amount_role: 'ceiling_not_disclosed', ceiling_respected: true })
    }
  }
  return out
}

function closingRequirements({ economics, facts = {}, complexity = {} }) {
  const req = []
  const factors = new Set(economics?.metrics?.execution?.factors || [])
  const friction = new Set((economics?.execution_friction?.factors || []).map((f) => f.code))
  req.push({ code: 'clear_title', status: complexity.title_issue || friction.has('title_issue') ? 'issue_on_record' : 'title_search_at_contract' })
  if (factors.has('probate_or_heirs')) req.push({ code: 'probate_authority_or_heirs_signatures', status: 'required' })
  if (factors.has('multiple_owners') || friction.has('multiple_owners')) req.push({ code: 'all_owners_sign', status: 'required' })
  if (friction.has('decision_maker_unresolved')) req.push({ code: 'decision_maker_confirmed', status: 'unresolved' })
  if (factors.has('liens_or_foreclosure') || friction.has('liens_or_foreclosure')) req.push({ code: 'payoff_statements_liens_foreclosure', status: 'required' })
  if (factors.has('tenant_occupied')) req.push({ code: 'tenant_and_lease_terms', status: 'required' })
  if (factors.has('listed_with_agent') || friction.has('listed_with_agent')) req.push({ code: 'listing_agreement_status', status: 'verify' })
  if (factors.has('land_entitlement_analysis')) req.push({ code: 'zoning_and_entitlement_verified', status: 'required' })
  if (factors.has('small_multifamily_rent_verification') || factors.has('income_asset_underwriting')) req.push({ code: 'rent_roll_and_leases', status: 'required' })
  return req
}

/**
 * @param {object} a
 * @param {object} a.economics       classifyOpportunityEconomics() result
 * @param {object|null} [a.offer_plan]  planOffer() result (internal)
 * @param {object} [a.facts]         fact summary (closing requirements)
 * @param {object} [a.complexity]
 * @param {object|null} [a.envelope_terms] allowed terms of a live envelope (concession ladder)
 * @param {object|null} [a.hold]  consultHold() verdict for the thread / property (owner P0)
 */
export function buildNegotiationPathway(input = {}) {
  const { value: a, stripped } = stripProtectedAttributes(input || {})
  const e = a.economics || null
  if (!e?.class) return { version: PATHWAY_VERSION, visibility: 'internal_only', class: 'INVESTIGATE', reason: 'economics_unavailable', mao: null, opening_range: null, next_action: 'run_opportunity_economics', ignored: { protected_attributes_stripped: stripped } }
  const plan = a.offer_plan || null
  const m = e.metrics || {}
  const judgment = e.judgment || null
  const lane = m.lane || null
  const mao = num(plan?.mao?.amount) ?? num(m.mao)
  const opening = plan?.available && plan.opening ? { recommended: plan.opening.recommended, range: plan.opening.range, discount_from_target: plan.opening.discount_from_target } : null
  if (opening && mao != null && !(opening.recommended < mao && opening.range.every((x) => x < mao))) throw new Error('INVARIANT_OPENING_NOT_BELOW_MAO')

  // land: zoning / density FIRST for an ask the lot cannot carry as one home
  const landFirst = lane === 'land' && judgment && ['investigate_zoning_density_first', 'development_feasibility_review', 'nurture_realistic_price', 'pass'].includes(judgment.path)
    ? { path: judgment.path, steps: judgment.steps, evidence: judgment.evidence, realistic_price_band: judgment.realistic_price_band, operator_only: true }
    : null

  let next
  const missing = e.uncertainty?.missing || []
  // owner P0: a thread / property under an automation hold is REPORTED, never worked
  if (a.hold?.held) next = `held:${a.hold.hold_type || 'unknown'}`
  else if (landFirst?.path === 'investigate_zoning_density_first') next = 'verify_zoning_and_entitled_density'
  else if (landFirst?.path === 'development_feasibility_review') next = 'operator_development_feasibility_review'
  else if (e.class === 'PASS') next = judgment?.path === 'nurture_realistic_price' ? 'nurture_with_realistic_band_operator_only' : 'no_offer_keep_record'
  else if (e.class === 'NURTURE') next = 'thirty_day_follow_up_inside_approved_program'
  else if (e.class === 'INVESTIGATE') next = MISSING_ACTION[missing.find((x) => MISSING_ACTION[x])] || 'complete_missing_evidence'
  else if (!plan?.available) next = 'rerun_decision_engine_or_operator_price'
  else next = e.class === 'HOT' ? 'operator_grant_envelope_then_send_authorization' : 'operator_review_envelope_proposal'

  return {
    version: PATHWAY_VERSION,
    visibility: 'internal_only',
    seller_facing: false,
    class: e.class,
    lane,
    mao: mao != null ? { amount: r0(mao), role: 'ceiling_not_opening', source: plan?.mao?.source || 'engine:evidence.offer_calculation.effective_authorized_ceiling' } : null,
    opening_range: opening,
    ask: m.ask ?? null,
    justification: [...(e.reasons || []), ...((plan?.opening?.factors || []).map((f) => `strategy:${f.factor}`))],
    concessions: concessionLadder({ plan, envelopeTerms: a.envelope_terms || null }),
    flexibility: m.seller_flexibility || { score: 0, signals: [] },
    closing_requirements: closingRequirements({ economics: e, facts: a.facts || {}, complexity: a.complexity || {} }),
    buyer_liquidity: { demand: m.buyer_demand?.level ?? 'unknown', evidence: m.buyer_demand?.evidence || [], market_prior: plan?.market_prior?.available ? { label: plan.market_prior.label, precision: plan.market_prior.precision, liquidity: plan.market_prior.liquidity ?? null } : null },
    complexity: m.execution || null,
    margin: { at_ask: m.assignment_margin?.at_ask ?? null, minimum_required: m.assignment_margin?.minimum_required ?? null, target: num(plan?.costs?.investor_margin_target?.value) },
    friction: e.execution_friction ? { level: e.execution_friction.level, factors: e.execution_friction.factors, legitimate_questions_not_penalized: e.execution_friction.legitimate_questions } : null,
    land_zoning_first: landFirst,
    uncertainty: e.uncertainty || null,
    next_action: next,
    hold: a.hold?.held ? { hold_type: a.hold.hold_type || null, hold_id: a.hold.hold_id || null, action: 'report_only' } : null,
    sends: 'never_from_this_view',
    ignored: { protected_attributes_stripped: stripped },
  }
}
