// ─── NEGOTIATION JUDGMENT (8.5.20-b, owner directive Phase 7 — analysis only) ──
// Two pure assessments attached to every opportunity-economics result:
//
// 1. IMPOSSIBLE-ASK JUDGMENT  (the owner's example: a $500K ask on a lot where finished
//    homes sell ~$360K). ORDER IS BINDING:
//      a. investigate zoning / density FIRST — an ask above finished-home value is only
//         workable if the lot can carry several units;
//      b. if the zoning cannot carry the units the ask needs → unworkable:
//           seller flexibility shown  → NURTURE with a realistic (internal) price band
//           no flexibility            → PASS
//      c. if the zoning may carry enough units → a realistic DEVELOPMENT path for an
//         operator (land comps + entitlement check), never an automated offer.
//    For built assets with a price gap the same shape applies (nurture vs pass vs negotiate).
//
// 2. EXECUTION FRICTION — measurable signals that a deal will be hard to close
//    (re-trades, refused access, demands for money up front, unresolved decision makers,
//    title / lien issues, listed with an agent). LEGITIMATE DILIGENCE IS NEVER PENALISED:
//    questions about closing dates, earnest money / deposit, the contract, title / escrow,
//    proof of funds, closing costs or who we are carry ZERO weight and are recorded as such.
//
// Property + market + conversation evidence only; protected attributes never reach here
// (the caller strips them) and tone / reply speed are not inputs.
import { inferPotentialUnits, zoningClass } from './zoning-density.js'

export const JUDGMENT_VERSION = 'negotiation-judgment.v1'
export const JUDGMENT_RULES = Object.freeze({
  /** a raw lot ≈ this share of a finished home's value (typical residual land value band) */
  lot_share_low: 0.2,
  lot_share_high: 0.35,
  friction_medium: 3,
  friction_high: 6,
})
export const JUDGMENT_PATHS = Object.freeze(['investigate_zoning_density_first', 'development_feasibility_review', 'nurture_realistic_price', 'pass', 'negotiate', 'nurture_price_gap', 'investigate'])

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const r0 = (n) => (n == null ? null : Math.round(n))

/**
 * @param {object} a
 * @param {string} a.lane                    economics lane
 * @param {string} a.economics_class         HOT | NEGOTIATE | NURTURE | PASS | INVESTIGATE
 * @param {number|null} a.ask
 * @param {object} [a.property]              zoning, lot_square_feet / lot_acreage, units_count
 * @param {object|null} [a.market]           { completed_home_median }
 * @param {{ score:number, signals:string[] }} [a.flexibility]  sellerFlexibilitySignals()
 * @param {number|null} [a.mao]
 * @param {number|null} [a.value_mid]
 */
export function assessImpossibleAsk({ lane = 'unknown', economics_class = 'INVESTIGATE', ask = null, property = {}, market = null, flexibility = { score: 0, signals: [] }, mao = null, value_mid = null } = {}) {
  const A = pos(ask)
  const flex = Number(flexibility?.score || 0) > 0
  if (!A) return { version: JUDGMENT_VERSION, path: 'investigate', steps: ['obtain_seller_asking_price'], evidence: {}, realistic_price_band: null }

  if (lane === 'land') {
    const finished = pos(market?.completed_home_median)
    const lotSqft = pos(property?.lot_square_feet) ?? (pos(property?.lot_acreage) ? pos(property.lot_acreage) * 43_560 : null)
    const zc = zoningClass(property?.zoning)
    const potential = inferPotentialUnits({ zoning: property?.zoning, lot_sqft: lotSqft, units: property?.units_count })
    const perUnitLand = finished ? finished * JUDGMENT_RULES.lot_share_high : null
    const unitsNeeded = perUnitLand ? Math.ceil(A / perUnitLand) : null
    const evidence = { finished_home_median: r0(finished), ask_to_finished_home: finished ? Math.round((A / finished) * 1000) / 1000 : null, zoning: property?.zoning ?? null, zoning_class: zc, lot_sqft: r0(lotSqft), potential_units: potential.value, units_needed_at_typical_lot_share: unitsNeeded, development_flag: property?.is_development_land ?? null }
    const band = finished ? [r0(finished * JUDGMENT_RULES.lot_share_low), r0(finished * JUDGMENT_RULES.lot_share_high)] : null
    if (!finished) return { version: JUDGMENT_VERSION, path: 'investigate', steps: ['obtain_finished_home_sales_near_the_lot', 'verify_zoning_and_entitled_density'], evidence, realistic_price_band: null }
    // an ask a single finished home's lot share supports is not an impossible ask
    if (unitsNeeded <= 1) return { version: JUDGMENT_VERSION, path: economics_class === 'PASS' ? 'pass' : 'investigate', steps: ['land_comps_for_value'], evidence, realistic_price_band: band }
    // (a) zoning / density FIRST
    if (zc === 'unknown' || zc === 'unclassified') return { version: JUDGMENT_VERSION, path: 'investigate_zoning_density_first', steps: ['verify_zoning_and_entitled_density_with_the_jurisdiction', `ask_needs_about_${unitsNeeded}_units_at_typical_lot_share`, 'then_land_comps'], evidence, realistic_price_band: band }
    const maxUnits = num(potential.value?.max)
    if (zc === 'density_permitting' && (property?.is_development_land === true || (maxUnits != null && maxUnits >= unitsNeeded))) {
      return { version: JUDGMENT_VERSION, path: 'development_feasibility_review', steps: ['confirm_entitled_density_and_setbacks', 'land_comps_per_buildable_unit', 'operator_review_development_economics'], evidence, realistic_price_band: band, operator_only: true }
    }
    if (zc === 'density_permitting') return { version: JUDGMENT_VERSION, path: 'investigate_zoning_density_first', steps: ['density_permitting_zone_but_lot_area_band_below_units_needed', 'confirm_entitled_density'], evidence, realistic_price_band: band }
    // (b) single-family zoning: unworkable at this ask
    return flex
      ? { version: JUDGMENT_VERSION, path: 'nurture_realistic_price', steps: ['unworkable_at_current_ask_single_family_zoning', 'seller_shows_flexibility_keep_warm', 'operator_may_discuss_lot_value_band'], evidence, realistic_price_band: band }
      : { version: JUDGMENT_VERSION, path: 'pass', steps: ['unworkable_at_current_ask_single_family_zoning', 'no_flexibility_signals'], evidence, realistic_price_band: band }
  }

  // built assets
  const M = pos(mao)
  const evidence = { ask: r0(A), mao: r0(M), value_mid: r0(pos(value_mid)), ask_vs_mao_pct: M ? Math.round((A / M - 1) * 1000) / 1000 : null }
  if (economics_class === 'PASS') return { version: JUDGMENT_VERSION, path: flex ? 'nurture_realistic_price' : 'pass', steps: flex ? ['economically_impossible_at_current_ask', 'seller_shows_flexibility_keep_warm'] : ['economically_impossible_at_current_ask'], evidence, realistic_price_band: M ? [r0(M * 0.85), r0(M)] : null }
  if (economics_class === 'NURTURE') return { version: JUDGMENT_VERSION, path: 'nurture_price_gap', steps: flex ? ['price_gap', 'flexibility_shown_follow_up_on_schedule'] : ['price_gap', 'thirty_day_follow_up'], evidence, realistic_price_band: M ? [r0(M * 0.85), r0(M)] : null }
  if (economics_class === 'HOT' || economics_class === 'NEGOTIATE') return { version: JUDGMENT_VERSION, path: 'negotiate', steps: ['within_or_near_authority'], evidence, realistic_price_band: null }
  return { version: JUDGMENT_VERSION, path: 'investigate', steps: ['complete_missing_evidence'], evidence, realistic_price_band: null }
}

// ── execution friction ──────────────────────────────────────────────────────
const LEGIT_RE = Object.freeze({
  closing_timeline: /\b(clos(e|ing)( date)?|how (soon|fast|long)|when (can|could|would) (we|you) close|timeline)\b/i,
  earnest_money_or_deposit: /\b(earnest( money)?|deposit|emd|escrow deposit)\b/i,
  contract_terms: /\b(contract|purchase agreement|paperwork|in writing|terms|contingenc(y|ies)|inspection period)\b/i,
  title_or_escrow: /\b(title (company|co\.?)|escrow|attorney|lawyer)\b/i,
  proof_of_funds: /\b(proof of funds|pof|bank statement|can you (actually )?(pay|afford))\b/i,
  closing_costs: /\b(closing costs?|who pays|fees)\b/i,
  who_we_are: /\b(legit|real company|licensed|who (is this|are you)|reviews?|website|scam)\b/i,
})
const FRICTION = Object.freeze({
  refuses_access_or_inspection: { re: /\b(no (inspection|inspections|walk ?-?throughs?|showings?)|(won'?t|will not|not) (let|allow) (anyone|you|nobody) (in|inside|see)|can'?t (go|come) inside)\b/i, weight: 2 },
  upfront_money_demand: { re: /\b(send|pay|wire|give) (me|us)\b[^.?!]{0,30}\b(upfront|up front|before (closing|we sign|signing)|right now|today)\b/i, weight: 3 },
})

/**
 * @param {object} a
 * @param {object} [a.facts]        conversation-ai factSummary
 * @param {Array<{amount:number}>} [a.ask_history]
 * @param {number|null} [a.our_last_offer]  last amount we put to the seller (ledger)
 * @param {string[]} [a.seller_messages]   the seller's inbound texts (masked)
 * @param {object} [a.complexity]   { owners_count, liens, foreclosure, title_issue }
 * @returns {{ score:number, level:'low'|'medium'|'high', factors:Array<{code:string,weight:number}>, legitimate_questions:string[], not_penalized:true }}
 */
export function executionFriction({ facts = {}, ask_history = [], our_last_offer = null, seller_messages = [], complexity = {} } = {}) {
  const factors = []
  const add = (code, weight) => { if (!factors.some((f) => f.code === code)) factors.push({ code, weight }) }
  const asks = (ask_history || []).map((h) => pos(h?.amount)).filter(Boolean)
  if (asks.length >= 2 && asks[asks.length - 1] > asks[asks.length - 2]) add(pos(our_last_offer) ? 'retrade_ask_raised_after_our_offer' : 'ask_raised_in_conversation', pos(our_last_offer) ? 2 : 1)
  const v = (k) => facts?.[k]?.value
  const role = JSON.stringify(v('identity_role') ?? '')
  if (/family_member|agent/.test(role) && !/confirmed/.test(JSON.stringify(v('ownership') ?? ''))) add('decision_maker_unresolved', 1)
  if (num(complexity?.owners_count) > 1) add('multiple_owners', 1)
  if (complexity?.title_issue) add('title_issue', 2)
  if (complexity?.liens || complexity?.foreclosure) add('liens_or_foreclosure', 1)
  if (/list|agent|realtor|mls|on the market/i.test(JSON.stringify(v('listing_status') ?? ''))) add('listed_with_agent', 1)
  const legit = new Set()
  for (const raw of seller_messages || []) {
    const m = String(raw || '')
    for (const [code, re] of Object.entries(LEGIT_RE)) if (re.test(m)) legit.add(code)
    for (const [code, f] of Object.entries(FRICTION)) if (f.re.test(m)) add(code, f.weight)
  }
  const score = factors.reduce((s, f) => s + f.weight, 0)
  const level = score >= JUDGMENT_RULES.friction_high ? 'high' : score >= JUDGMENT_RULES.friction_medium ? 'medium' : 'low'
  return { version: JUDGMENT_VERSION, score, level, factors, legitimate_questions: [...legit].sort(), not_penalized: true }
}
