/**
 * DEAL DECISION — one property's underwriting, as the operator must read it.
 *
 * Read-only. Nothing here runs the engine, writes a score, sends an offer or
 * moves a stage. It assembles what already exists:
 *
 *   property_acquisition_scores   the canonical decision projection (engine 2.0.0)
 *   acquisition_score_snapshots   immutable lineage (what the engine saw, when)
 *   acquisition_opportunities     stage + metadata.negotiation_state / seller_facts
 *   seller_offers                 BINDING offers (a recommendation is not one)
 *   entity_graph_property_records mortgages · liens · sales · foreclosure · parcel
 *   buyer_match_candidates        demand (counts / grades / types — never names)
 *   closing_cases                 actuals, only with settlement evidence
 *
 * Three rules the payload enforces:
 *   1. ESTIMATED vs ACTUAL are different fields. Nothing estimated is ever
 *      labelled actual; actuals exist only when a closing carries evidence.
 *   2. PROVENANCE travels with every seller fact: what the seller SAID, what
 *      the RECORD says, what the SYSTEM derived. They are never merged.
 *   3. RISKS are concrete and sourced (a lien, a gap, a thin comp set) —
 *      there is no generic "deal score" and no invented commentary.
 *
 * Legacy Podio-era fields (properties.cash_offer, final_acquisition_score,
 * ai_score, structured_motivation_score, deal_strength_score) are not read.
 */
import { describeQuote } from '@/lib/domain/seller-flow/negotiation-quotes.js'
import { isNegotiationEngineV3Enabled } from '@/lib/domain/negotiation-v3/flags.js'
import { buildNegotiationDeskView } from '@/lib/domain/negotiation-v3/view.js'
import { latestRunCandidates } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { UNIVERSAL_STAGE_LABELS } from '@/lib/domain/opportunity/universal-pipeline-registry.js'
import { offerSensitivity, replayStoredOffer, computeScenarioOffer } from './deal-scenario-model.js'
import { getConversationSignal } from './conversation-signal-service.js'
import { getMarketDemand } from './market-demand-service.js'
import { REASON_LABELS } from '../comp-intelligence/comps-reason-labels.js'
import { canonicalFlag, canonicalPropertyIds } from '../comp-intelligence/canonical-property-ids.js'
import { COMP_DETAIL_COLUMNS, enrichComp, ownerSections, parcelSections, prospectCards } from './deal-record-sections.js'
import { classifyLienDocuments, classifyMortgages, summarizeLienDocuments } from './deal-record-documents.js'
// Namespace import on purpose: "who has the move" must read exactly as the
// Pipeline reads it, and a namespace import cannot fail at load time if that
// module is reshaped — the lane is simply omitted until it is wired again.
import * as pipelineCommand from '../opportunity/pipeline-command-service.js'

const DAY = 86_400_000
const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v) => (Array.isArray(v) ? v : [])
const ts = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null }
const humanize = (v) => {
  const s = clean(v)
  if (!s) return null
  return s.replace(/[_-]+/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}
const money = (n) => {
  const v = num(n)
  if (v === null) return null
  const a = Math.abs(v)
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`
  return v < 0 ? `−${s}` : s
}

const TERMINAL_STATUSES = new Set(['dead', 'closed', 'suppressed', 'lost', 'archived', 'cancelled'])

export const TIER_META = Object.freeze({
  AUTO_HARD_OFFER: { label: 'Hard offer authorized', tone: 'go' },
  AUTO_RANGE_OFFER: { label: 'Range offer authorized', tone: 'go' },
  REVIEW_REQUIRED: { label: 'Review required', tone: 'hold' },
  CREATIVE_TERMS: { label: 'Creative terms', tone: 'alt' },
  NURTURE: { label: 'Nurture', tone: 'wait' },
  PASS: { label: 'Pass', tone: 'stop' },
  REJECT: { label: 'Pass', tone: 'stop' },
})

const GATE_LABELS = Object.freeze({
  aos_at_least_780: 'Acquisition score ≥ 780',
  comp_count_at_least_4: '4+ qualified comps',
  confidence_at_least_85: 'Confidence ≥ 85',
  valuation_confidence_at_least_80: 'Valuation confidence ≥ 80',
  assignment_fee_meets_minimum_economics: 'Assignment fee clears minimum',
  recommended_offer_available: 'Offer computed',
  // Rows written before the engine split "target" from "minimum economics"
  // (151 of 170 at 2026-10-01) carry this key; it compared the fee to the
  // target margin. Same gate family, different rule — labelled as such.
  assignment_fee_meets_target: 'Assignment fee meets target (earlier rule)',
})

/**
 * The hard gates exactly as determineDecisionTier() in
 * acquisitionDecisionEngine.js applies them, so the screen can show the
 * threshold and the value the engine compared — not a mystery checkmark.
 */
const GATE_ORDER = ['comp_count_at_least_4', 'valuation_confidence_at_least_80', 'confidence_at_least_85', 'assignment_fee_meets_minimum_economics', 'assignment_fee_meets_target', 'recommended_offer_available', 'aos_at_least_780']

export function decisionGates(score) {
  if (!score) return []
  const ev = obj(score.evidence)
  const oc = obj(ev.offer_calculation)
  const checks = obj(obj(ev.decision_tier_reasoning).hard_gate_checks)
  const fee = num(score.expected_assignment_fee)
  const minimumMargin = num(oc.assignment_margin_floor) ?? num(oc.assignment_margin_policy?.minimum_margin)
  const target = num(oc.target_assignment_fee) ?? num(ev.engine?.target_assignment_fee)
  const comps = num(obj(ev.comp_data_status).selected_comp_count) ?? num(score.comp_count) ?? arr(ev.selected_comps).length
  const spec = {
    aos_at_least_780: { metric: 'aos', current: num(score.aos_score), threshold: 780, comparator: '>=', unit: 'score', source: 'property_acquisition_scores.aos_score' },
    comp_count_at_least_4: { metric: 'comps', current: comps, threshold: 4, comparator: '>=', unit: 'count', source: 'evidence.comp_data_status.selected_comp_count' },
    confidence_at_least_85: { metric: 'confidence', current: num(score.confidence), threshold: 85, comparator: '>=', unit: 'score', source: 'property_acquisition_scores.confidence' },
    valuation_confidence_at_least_80: { metric: 'valuationConfidence', current: num(score.valuation_confidence), threshold: 80, comparator: '>=', unit: 'score', source: 'property_acquisition_scores.valuation_confidence' },
    assignment_fee_meets_minimum_economics: { metric: 'fee', current: fee, threshold: minimumMargin, comparator: '>=', unit: 'usd', source: 'expected_assignment_fee vs offer_calculation.assignment_margin_floor' },
    assignment_fee_meets_target: { metric: 'fee', current: fee, threshold: target, comparator: '>=', unit: 'usd', source: 'expected_assignment_fee vs offer_calculation.target_assignment_fee', legacy: true, canonicalKey: 'assignment_fee_meets_minimum_economics' },
    recommended_offer_available: { metric: 'offer', current: num(score.recommended_cash_offer), threshold: 0, comparator: '>', unit: 'usd', source: 'property_acquisition_scores.recommended_cash_offer' },
  }
  return Object.entries(checks)
    .map(([key, pass]) => {
      const s = spec[key] || {}
      return {
        key,
        canonicalKey: s.canonicalKey || key,
        label: GATE_LABELS[key] || humanize(key),
        pass: pass === true,
        legacy: s.legacy === true,
        metric: s.metric || null,
        current: s.current ?? null,
        threshold: s.threshold ?? null,
        comparator: s.comparator || null,
        unit: s.unit || null,
        source: s.source || 'evidence.decision_tier_reasoning.hard_gate_checks',
      }
    })
    .sort((a, b) => (GATE_ORDER.indexOf(a.key) + 1 || 99) - (GATE_ORDER.indexOf(b.key) + 1 || 99))
}

/** AOS composition as the engine sums it (acquisitionOpportunityScore): each term's ceiling is fixed by its multiplier. */
const AOS_COMPONENTS = Object.freeze([
  ['assignment_margin', 'Assignment margin', 250, 'fee ÷ deal target, ×2.5'],
  ['valuation_strength', 'Valuation strength', 150, 'valuation confidence ×1.5'],
  ['buyer_demand', 'Buyer demand', 150, 'buyer demand score ×1.5'],
  ['distress_motivation', 'Distress & motivation', 150, 'recorded distress factors ×1.5'],
  ['liquidity', 'Liquidity', 100, 'liquidity score'],
  ['equity_finance', 'Equity / finance', 100, 'equity band or creative-finance fit'],
  ['strategy_optionality', 'Strategy optionality', 100, 'best creative strategy score'],
])

export function aosComposition(score) {
  const b = obj(obj(score?.evidence).aos_breakdown)
  const comps = obj(b.components)
  if (!Object.keys(comps).length) return null
  return {
    score: num(b.score) ?? num(score?.aos_score),
    max: 1000,
    components: AOS_COMPONENTS.map(([key, label, max, basis]) => ({ key, label, points: num(comps[key]), max, basis })).filter((c) => c.points !== null),
    motivation: b.motivation ? { score: num(b.motivation.score), reasons: arr(b.motivation.reasons).map((r) => ({ reason: humanize(r.reason), points: num(r.points) })).filter((r) => r.reason) } : null,
  }
}

/** Observed investor purchases behind buyer-behavior confidence (counts only; sample prices stay out). */
export function investorEvidence(score) {
  const s = obj(obj(score?.evidence).investor_ceiling_summary)
  if (!Object.keys(s).length) return null
  return {
    method: humanize(s.method),
    eligible: num(s.eligible_purchase_count),
    local: num(s.local_purchase_count),
    recent: num(s.recent_purchase_count),
    distinctBuyers: num(s.distinct_buyer_count),
    cashProxy: num(s.cash_investor_proxy_count),
    demandScore: num(s.buyer_demand_score),
    liquidityScore: num(s.liquidity_score),
    confidence: num(s.confidence),
  }
}

/**
 * Why the engine's best strategy is what it is — the same rule the engine
 * runs: cash is viable when the fee reaches 75% of the minimum margin and
 * valuation confidence is at least 60; a creative strategy wins only when
 * cash is not viable and its score is ≥ 68.
 */
export function strategyBasis(score) {
  if (!score) return null
  const oc = obj(obj(score.evidence).offer_calculation)
  const fee = num(score.expected_assignment_fee)
  const minimumMargin = num(oc.assignment_margin_floor) ?? num(oc.assignment_margin_policy?.minimum_margin) ?? num(oc.target_assignment_fee)
  const vconf = num(score.valuation_confidence)
  const creative = [['SELLER_FINANCE', num(score.seller_finance_score)], ['SUBJECT_TO', num(score.subject_to_score)], ['LEASE_OPTION', num(score.lease_option_score)], ['NOVATION', num(score.novation_score)]]
    .filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1])[0] || null
  const cashViable = fee !== null && minimumMargin !== null && vconf !== null ? fee >= minimumMargin * 0.75 && vconf >= 60 : null
  return {
    cashViable,
    fee,
    feeNeeded: minimumMargin !== null ? Math.round(minimumMargin * 0.75) : null,
    valuationConfidence: vconf,
    creativeBest: creative ? STRATEGY_LABELS[creative[0]] || humanize(creative[0]) : null,
    creativeBestScore: creative ? creative[1] : null,
  }
}

const STRATEGY_LABELS = Object.freeze({
  CASH_ASSIGNMENT: 'Cash assignment',
  SELLER_FINANCE: 'Seller finance',
  SUBJECT_TO: 'Subject-to',
  LEASE_OPTION: 'Lease option',
  NOVATION: 'Novation',
  NURTURE: 'Nurture',
})

const WITHHELD_REASONS = Object.freeze({
  valuation_tier_not_offer_authoritative: 'Valuation tier is not offer-authoritative — the engine priced it, but policy does not let the automation present that number yet.',
  ask_out_of_band: 'Seller ask is outside the authorized band.',
  valuation_absent: 'No offer-authoritative valuation exists yet — the automation will not name a number.',
})

// The engine's own reason codes (shared with Comps Intelligence).
const REJECTION_LABELS = REASON_LABELS

/* ── pure builders (exported for tests) ─────────────────────────────────── */

/** Evidence quality from measurable facts about the selected comp set. */
export function compEvidenceQuality(evidence) {
  const ev = obj(evidence)
  const status = obj(ev.comp_data_status)
  const selected = arr(ev.selected_comps)
  const vs = obj(ev.valuation_calculation_summary)
  const now = Date.now()
  const distances = selected.map((c) => num(c.distance_miles)).filter((v) => v !== null)
  const ages = selected.map((c) => ts(c.sale_date || c.sold_date)).filter(Boolean).map((t) => (now - t) / (30.44 * DAY)).sort((a, b) => a - b)
  const sources = {}
  for (const c of selected) { const s = clean(c.source) || 'unknown'; sources[s] = (sources[s] || 0) + 1 }
  const breakdown = Object.entries(obj(status.rejection_breakdown))
    .map(([reason, count]) => ({ reason, label: REJECTION_LABELS[reason] || humanize(reason), count: num(count) || 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  const adjusted = selected.map((c) => num(c.adjusted_value ?? c.adjusted_price)).filter((v) => v !== null && v > 0)
  return {
    status: clean(status.status) || (selected.length ? 'comps_selected' : 'no_comps'),
    message: clean(status.message) || null,
    raw: num(status.raw_candidate_count),
    eligible: num(status.eligible_candidate_count),
    selected: num(status.selected_comp_count) ?? selected.length,
    rejected: num(status.rejected_comp_count),
    rejectionBreakdown: breakdown.slice(0, 6),
    dispersion: num(vs.dispersion_ratio),
    avgDistanceMiles: distances.length ? Math.round((distances.reduce((a, b) => a + b, 0) / distances.length) * 100) / 100 : null,
    medianAgeMonths: ages.length ? Math.round(ages[Math.floor(ages.length / 2)] * 10) / 10 : null,
    sources,
    avgScore: selected.length ? Math.round((selected.reduce((a, c) => a + (num(c.score ?? c.comp_score) || 0), 0) / selected.length) * 10) / 10 : null,
    completeness: selected.length ? Math.round(selected.reduce((a, c) => a + (num(c.data_completeness) || 0), 0) / selected.length) : null,
    adjustedLow: adjusted.length ? Math.min(...adjusted) : null,
    adjustedHigh: adjusted.length ? Math.max(...adjusted) : null,
  }
}

/**
 * Mark each comp canonicalProperty true / false (null when the check failed) with
 * ONE batched existence read for the whole decision (shared helper with Comps).
 */
export async function markCanonicalComps(client, comps) {
  const list = arr(comps)
  if (!list.length) return list
  const canonical = await canonicalPropertyIds(client, list.map((c) => c.propertyId))
  for (const c of list) c.canonicalProperty = canonicalFlag(canonical, c.propertyId)
  return list
}

/** The selected comps, shaped for a phone, merged with their source record. */
export function topComps(evidence, limit = 12, details = new Map(), subject = {}) {
  return arr(obj(evidence).selected_comps)
    .slice()
    .sort((a, b) => (num(b.weight) || 0) - (num(a.weight) || 0))
    .slice(0, limit)
    .map((c) => {
      const core = arr(obj(obj(c.match_breakdown).core).features)
      const mismatches = core.filter((f) => f.status === 'mismatch').map((f) => ({ feature: humanize(f.feature), subject: f.subject, comp: f.comp }))
      const id = clean(c.comp_id || c.id) || null
      return {
        id,
        propertyId: clean(c.property_id) || null,
        address: clean(c.address) || null,
        salePrice: num(c.sale_price),
        adjustedValue: num(c.adjusted_value ?? c.adjusted_price),
        saleDate: clean(c.sale_date || c.sold_date) || null,
        distanceMiles: num(c.distance_miles),
        score: num(c.score ?? c.comp_score),
        weight: num(c.weight),
        confidence: num(c.comp_confidence),
        source: clean(c.source) || null,
        completeness: num(c.data_completeness),
        mismatches: mismatches.slice(0, 3),
        ...enrichComp(c, details.get(id), subject),
      }
    })
}

/**
 * Everything that has a price, on one axis. Markers carry their provenance;
 * the scale is bounded to the valuation neighbourhood so one absurd number
 * (a $331 ask, a $332M comp) is clamped to the edge and flagged, not allowed
 * to crush the whole spectrum.
 */
export function buildValuationSpectrum({ low, mid, high, avm, compLow, compHigh, ask, recommended, floor, ceiling, mlsList, currentOffer }) {
  const anchor = pos(mid) ?? pos(avm)
  if (!anchor) return null
  const markers = [
    { key: 'floor', label: 'Floor', value: pos(floor), source: 'engine' },
    { key: 'recommended', label: 'Recommended', value: pos(recommended), source: 'engine' },
    { key: 'ceiling', label: 'Buyer ceiling', value: pos(ceiling), source: 'engine' },
    { key: 'current_offer', label: 'Our offer', value: pos(currentOffer), source: 'offer' },
    { key: 'ask', label: 'Seller ask', value: pos(ask), source: 'seller' },
    { key: 'avm', label: 'AVM', value: pos(avm), source: 'record' },
    { key: 'mls', label: 'MLS list', value: pos(mlsList), source: 'mls' },
  ].filter((m) => m.value !== null)
  const inBand = [pos(low), pos(high), anchor, ...markers.map((m) => m.value)].filter((v) => v !== null && v <= anchor * 3 && v >= anchor * 0.1)
  let min = Math.min(...inBand)
  let max = Math.max(...inBand)
  const pad = (max - min) * 0.08 || anchor * 0.1
  min = Math.max(0, min - pad)
  max += pad
  const at = (v) => (v === null ? null : Math.max(0, Math.min(1, (v - min) / (max - min))))
  return {
    min,
    max,
    band: pos(low) && pos(high) ? { low: pos(low), mid: pos(mid), high: pos(high), from: at(pos(low)), to: at(pos(high)), at: at(pos(mid)) } : null,
    comps: pos(compLow) && pos(compHigh) && pos(compHigh) <= anchor * 3 ? { low: pos(compLow), high: pos(compHigh), from: at(pos(compLow)), to: at(pos(compHigh)) } : null,
    markers: markers.map((m) => ({ ...m, at: at(m.value), clamped: m.value < min || m.value > max })),
  }
}

/** Seller facts with provenance — said vs recorded vs derived, never merged. */
export function sellerFactsWithProvenance({ ns, sellerFacts, props, parcel, score }) {
  const n = obj(ns)
  const sf = obj(sellerFacts)
  const p = obj(props)
  const pc = obj(parcel)
  const out = []
  const push = (key, label, value, display, provenance, source, extra = {}) => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return
    out.push({ key, label, value, display: display ?? String(value), provenance, source, ...extra })
  }
  const history = arr(n.asking_price_history)
  const lastAsk = history.length ? history[history.length - 1] : null
  const askVal = pos(n.current_asking_price ?? n.current_ask) ?? pos(sf.asking_price?.value)
  push('asking_price', 'Asking price', askVal, money(askVal), 'seller', 'Seller message', {
    at: lastAsk?.at || sf.asking_price?.captured_at || null,
    quote: clean(lastAsk?.extracted_text || sf.asking_price?.extracted_text) || null,
    confidence: num(lastAsk?.confidence ?? n.asking_price_confidence),
    sourceMessageId: clean(lastAsk?.source_message_id || sf.asking_price?.source_message_id || n.asking_price_source_message_id) || null,
  })
  // What the seller-fact extractor read from the conversation. Interest and a
  // condition disclosure are things the seller SAID; ownership is the system's
  // inference from how they engaged, and is labelled as an inference.
  const extractor = clean(sf.extractor_version) || null
  const interest = clean(sf.interest)
  push('interest_seller', 'Interest', interest || null, humanize(interest), 'seller', 'Seller message (extracted)', { extractor })
  // 'confirmed' = the seller confirmed ownership in the conversation (28 opps);
  // 'inferred' / 'inferred_from_seller_engagement' = the system's inference (43).
  const ownership = clean(sf.ownership_status)
  const ownershipSaid = /^confirmed/i.test(ownership)
  push(ownershipSaid ? 'ownership_seller' : 'ownership_system', 'Ownership', ownership || null,
    ownershipSaid ? 'Confirmed by seller' : humanize(ownership),
    ownershipSaid ? 'seller' : 'system', ownershipSaid ? 'Seller message (extracted)' : 'Seller-fact extractor (inference)',
    { extractor, basis: humanize(sf.ownership_resolution_basis) })
  if (sf.condition_disclosed === true && !clean(n.condition_summary)) {
    // Its own label: it says the seller talked about condition, not WHAT the
    // condition is, so it must not read as disagreeing with the record's grade.
    push('condition_disclosed', 'Condition disclosed', true, 'In conversation — not itemized', 'seller', 'Seller message (extracted)', { extractor })
  }
  const initial = pos(n.initial_asking_price ?? n.initial_ask)
  if (initial && initial !== askVal) push('initial_ask', 'Opening ask', initial, money(initial), 'seller', 'Seller message', { at: history[0]?.at || null })
  push('seller_net', 'Net requirement', pos(n.seller_net_requirement), money(n.seller_net_requirement), 'seller', 'Seller message')
  const occSeller = clean(n.occupancy || sf.occupancy_status)
  push('occupancy_seller', 'Occupancy', occSeller || null, humanize(occSeller), 'seller', 'Seller message')
  const occRecord = clean(pc.owner_status || pc.owner_location)
  push('occupancy_record', 'Occupancy', occRecord || null, occRecord, 'record', 'County / parcel record')
  push('condition_seller', 'Condition', clean(n.condition_summary) || null, clean(n.condition_summary), 'seller', 'Seller message')
  const condRecord = clean(pc.building_condition || p.building_condition)
  push('condition_record', 'Condition', condRecord || null, condRecord, 'record', 'Assessor record')
  const repairFacts = arr(n.repair_facts).map((r) => (typeof r === 'string' ? r : clean(r?.text || r?.item || r?.summary))).filter(Boolean)
  push('repairs_seller', 'Repairs mentioned', repairFacts.length ? repairFacts : null, repairFacts.join(' · '), 'seller', 'Seller message')
  const re = obj(obj(score?.evidence).repair_estimate)
  push('repairs_system', 'Repair estimate', pos(re.amount), money(re.amount), 'system', re.source === 'property_estimated_repair_cost' ? 'Data-provider estimate' : humanize(re.source) || 'Engine', { confidence: num(re.confidence) })
  const payoff = pos(obj(obj(obj(score?.evidence).decision_inputs).inputs).seller?.mortgage_payoff)
  push('payoff_seller', 'Mortgage payoff', payoff, money(payoff), 'seller', 'Seller message')
  const bal = pos(pc.total_loan_balance ?? p.total_loan_balance)
  push('debt_record', 'Loan balance', bal, money(bal), 'record', 'Recorded loans (estimated balance)')
  const rent = pos(p.monthly_rent)
  push('rent_record', 'Monthly rent', rent, rent ? `${money(rent)}/mo` : null, 'record', 'Property record')
  const rentEst = pos(p.rent_estimate)
  if (rentEst && rentEst !== rent) push('rent_estimate', 'Rent estimate', rentEst, `${money(rentEst)}/mo`, 'system', 'Rent model')
  push('timeline', 'Timeline', clean(n.timeline) || null, humanize(n.timeline), 'seller', 'Seller message')
  push('closing_preference', 'Closing preference', clean(n.closing_preference) || null, humanize(n.closing_preference), 'seller', 'Seller message')
  const motives = arr(n.motivation_signals).map((m) => (typeof m === 'string' ? humanize(m) : humanize(m?.signal || m?.type))).filter(Boolean)
  push('motivation', 'Motivation signals', motives.length ? motives : null, motives.join(' · '), 'seller', 'Seller messages')
  return out
}

/** Only strategies the engine scored, best first; the engine's best is marked. */
export function engineStrategies(score) {
  if (!score) return []
  const ev = obj(score.evidence)
  const cf = obj(ev.creative_finance_reasoning)
  const rcs = obj(ev.recommended_conversation_strategy)
  const best = clean(score.best_strategy).toUpperCase()
  const rows = [
    { key: 'CASH_ASSIGNMENT', score: null, viability: num(rcs.cash_offer_confidence), points: [], detail: pos(score.recommended_cash_offer) ? `Engine cash offer ${money(score.recommended_cash_offer)}` : null },
    { key: 'SELLER_FINANCE', score: num(score.seller_finance_score), viability: null, points: arr(cf.seller_finance), detail: rcs.seller_finance_offer_range?.low ? `Terms range ${money(rcs.seller_finance_offer_range.low)}–${money(rcs.seller_finance_offer_range.high)}` : null },
    { key: 'LEASE_OPTION', score: num(score.lease_option_score), viability: num(rcs.lease_option_viability), points: arr(cf.lease_option), detail: null },
    { key: 'NOVATION', score: num(score.novation_score), viability: num(rcs.novation_viability), points: arr(cf.novation), detail: null },
    { key: 'SUBJECT_TO', score: num(score.subject_to_score), viability: num(rcs.subject_to_viability), points: arr(cf.subject_to), detail: null },
  ]
  return rows
    .filter((r) => r.key === best || (r.score ?? r.viability ?? 0) > 0)
    .map((r) => ({
      key: r.key,
      label: STRATEGY_LABELS[r.key] || humanize(r.key),
      score: r.score ?? r.viability,
      isBest: r.key === best,
      points: r.points.map((p) => ({ reason: humanize(p.reason), points: num(p.points) })).filter((p) => p.reason),
      detail: r.detail,
    }))
    .sort((a, b) => Number(b.isBest) - Number(a.isBest) || (b.score ?? 0) - (a.score ?? 0))
}

/** Who bought the pricing comps, and what each group paid — from the comps' own deeds. */
export function compBuyerMix(comps) {
  const med = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
  const by = (pred) => comps.filter(pred).map((c) => num(c.salePrice) || 0)
  const company = comps.filter((c) => c.buyerKind === 'company')
  const individual = comps.filter((c) => c.buyerKind === 'individual')
  const mls = comps.filter((c) => /mls/i.test(c.saleSource || c.source || ''))
  const pr = comps.filter((c) => !/mls/i.test(c.saleSource || c.source || ''))
  return {
    total: comps.length,
    company: company.length,
    individual: individual.length,
    unknown: comps.length - company.length - individual.length,
    companyMedian: med(by((c) => c.buyerKind === 'company')),
    individualMedian: med(by((c) => c.buyerKind === 'individual')),
    mls: mls.length,
    publicRecord: pr.length,
    mlsMedian: med(mls.map((c) => num(c.salePrice) || 0)),
    publicRecordMedian: med(pr.map((c) => num(c.salePrice) || 0)),
    companyPpsf: med(company.map((c) => num(c.ppsf) || 0)),
    individualPpsf: med(individual.map((c) => num(c.ppsf) || 0)),
  }
}

/** Do the comps the offer was priced from share the subject's asset family and unit band? */
export function assetIntegrity(comps, subject) {
  const total = comps.length
  const matched = comps.filter((c) => c.assetMatch).length
  const unknown = comps.filter((c) => !c.propertyType && !c.assetClass).length
  const types = {}
  for (const c of comps) { const k = c.propertyType || 'Unknown'; types[k] = (types[k] || 0) + 1 }
  return {
    subjectType: subject.propertyType || null,
    subjectUnits: subject.units ?? null,
    total,
    matched,
    unknown,
    mismatched: comps.filter((c) => !c.assetMatch && (c.propertyType || c.assetClass)).map((c) => ({ address: c.address, propertyType: c.propertyType, units: c.units })),
    types: Object.entries(types).map(([type, count]) => ({ type, count })),
  }
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * The concrete risk list. Each entry names a fact and where it came from.
 * No aggregate score — the operator reads the list.
 */
export function deriveDealRisks(ctx) {
  const { score, props, parcel, records, ns, replay, quality, thread, propertyId, ask, avm, now = Date.now(), integrity } = ctx
  const risks = []
  const add = (key, severity, title, detail, source) => risks.push({ key, severity, title, detail: detail || null, source })
  const ev = obj(score?.evidence)
  const mid = pos(score?.valuation_mid)

  if (/^canary/i.test(clean(propertyId))) add('canary', 'critical', 'Test property', 'This is a canary/test record, not a real deal.', 'property_id')
  if (!score) add('not_analysed', 'high', 'Not analysed', 'The decision engine has never run on this property — there is no valuation or offer authority.', 'property_acquisition_scores')

  if (mid && avm) {
    const ratio = mid / avm
    if (ratio > 2 || ratio < 0.5) add('valuation_disagreement', 'critical', `Engine value is ${ratio > 1 ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×` : `${Math.round(ratio * 100)}% of`} the AVM`, `Engine ${money(mid)} vs AVM ${money(avm)}. Treat the engine valuation as unverified.`, 'valuation_mid vs properties.estimated_value')
    else if (ratio > 1.35 || ratio < 0.74) add('valuation_disagreement', 'medium', 'Engine value and AVM disagree', `Engine ${money(mid)} vs AVM ${money(avm)} (${Math.round((ratio - 1) * 100)}%).`, 'valuation_mid vs properties.estimated_value')
  }

  const units = num(ev.subject?.units) ?? num(parcel?.units_count) ?? 1
  const outlierCap = Math.max((avm || mid || 0) * 10, 5_000_000)
  const anomalous = arr(ev.selected_comps).filter((c) => (num(c.sale_price) || 0) > outlierCap && units <= 4)
  if (anomalous.length) add('comp_price_anomaly', 'critical', `${anomalous.length === 1 ? 'A selected comp' : `${anomalous.length} selected comps`} sold for ${money(anomalous[0].sale_price)}`, `${clean(anomalous[0].address)} — a portfolio or bulk sale priced as one ${units > 1 ? `${units}-unit` : 'single'} asset. The valuation inherits it.`, 'evidence.selected_comps')

  if (integrity?.mismatched?.length) {
    const m = integrity.mismatched
    add('asset_mismatch_comps', 'critical', `${m.length} pricing comp${m.length === 1 ? ' is' : 's are'} a different asset type`, `Subject is ${integrity.subjectType || 'unknown'}${integrity.subjectUnits > 1 ? ` (${integrity.subjectUnits} units)` : ''}; ${m.slice(0, 2).map((c) => `${c.address} is ${c.propertyType || 'unknown'}${c.units > 1 ? ` (${c.units} units)` : ''}`).join('; ')}. The value mixes asset types.`, 'selected comps vs subject asset family')
  }
  if (score) {
    const sel = quality?.selected ?? 0
    if (sel === 0) add('no_comps', 'critical', 'No qualified comps', `${quality?.raw ?? 0} candidates screened, none qualified — value rests on a fallback.`, 'evidence.comp_data_status')
    else if (sel <= 2) add('thin_comps', 'high', `Only ${sel} qualified comp${sel === 1 ? '' : 's'}`, `${quality?.raw ?? '—'} screened, ${quality?.rejected ?? '—'} rejected. One sale is carrying the valuation.`, 'evidence.comp_data_status')
    else if (sel === 3) add('thin_comps', 'medium', 'Three qualified comps', 'Below the 4-comp hard gate for automated offers.', 'evidence.comp_data_status')
    if ((quality?.dispersion ?? 0) > 0.35) add('wide_dispersion', 'medium', 'Comps disagree', `Price dispersion ${Math.round(quality.dispersion * 100)}% across the selected set.`, 'valuation_calculation_summary.dispersion_ratio')
    if (mid && num(score.recommended_cash_offer) !== null && num(score.recommended_cash_offer) <= 0) add('zero_offer', 'high', 'Engine offer is $0', 'Repairs and margin consume the whole buyer ceiling — there is no cash offer at this value.', 'recommended_cash_offer')
  }

  if (ask) {
    const ref = avm || mid
    if (ask < 5000 || (ref && ask < ref * 0.05)) add('implausible_ask', 'high', `Seller ask ${money(ask)} looks mis-parsed`, 'The captured number is implausible for this property — confirm it in the conversation before relying on it.', 'negotiation_state.current_asking_price')
    else if (pos(score?.valuation_high) && ask > pos(score.valuation_high)) add('ask_above_value', 'medium', 'Ask above supported value', `Ask ${money(ask)} vs supported high ${money(score.valuation_high)}.`, 'ask vs valuation_high')
    else {
      const ceiling = pos(obj(ev.offer_calculation).effective_authorized_ceiling)
      if (ceiling && ask > ceiling) add('ask_above_ceiling', 'low', 'Ask above buyer ceiling', `Gap ${money(ask - ceiling)} to the ${money(ceiling)} ceiling.`, 'ask vs effective_authorized_ceiling')
    }
    const lastAskAt = ts(arr(ns?.asking_price_history).slice(-1)[0]?.at)
    const computedAt = ts(score?.computed_at)
    if (lastAskAt && computedAt && lastAskAt > computedAt) add('ask_changed_after_analysis', 'medium', 'Ask changed after the last analysis', `Seller moved to ${money(ask)} on ${new Date(lastAskAt).toISOString().slice(0, 10)}; the decision predates it.`, 'asking_price_history vs computed_at')
  }

  if (ns && ns.valuation_spendable === false) {
    const reason = clean(ns.recommended_offer_withheld_reason || ns.valuation_non_spendable_reason)
    add('offer_withheld', 'medium', 'Offer not authorized to present', WITHHELD_REASONS[reason] || humanize(reason) || 'Negotiation policy is withholding the engine offer.', 'negotiation_state.valuation_spendable')
  }

  if (replay && !replay.replayable && replay.reason === 'replay_differs_from_stored' && replay.result) {
    add('stale_policy', 'medium', 'Offer predates current engine policy', `Stored ${money(score?.recommended_cash_offer)}; the current offer policy on the same inputs gives ${money(replay.result.recommended_offer)}. Re-analysis would restate it.`, 'offer replay')
  }
  const ageDays = ts(score?.computed_at) ? Math.floor((now - ts(score.computed_at)) / DAY) : null
  if (ageDays !== null && ageDays > 30) add('stale_analysis', ageDays > 90 ? 'medium' : 'low', `Analysis is ${ageDays} days old`, 'Comps and value may have moved since.', 'computed_at')

  const debt = pos(parcel?.total_loan_balance ?? props?.total_loan_balance)
  const offer = pos(score?.recommended_cash_offer)
  if (debt && offer && debt > offer) add('debt_exceeds_offer', 'high', 'Recorded debt exceeds the offer', `Estimated open balance ${money(debt)} vs offer ${money(offer)} — a cash close would not pay off the loans without seller funds or a creative structure.`, 'recorded loans vs recommended_cash_offer')
  const eqPct = num(parcel?.equity_percent ?? props?.equity_percent)
  if (eqPct !== null && eqPct < 0) add('negative_equity', 'high', 'Negative equity on record', `Recorded equity ${Math.round(eqPct)}%.`, 'equity_percent')
  else if (eqPct !== null && eqPct < 20) add('low_equity', 'medium', 'Low recorded equity', `Recorded equity ${Math.round(eqPct)}%.`, 'equity_percent')

  const fcl = arr(records?.foreclosures)
  const auctionAt = ts(parcel?.auction_date) ?? ts(fcl[0]?.auction_date)
  if (clean(parcel?.preforeclosure_status) || fcl.length) {
    const future = auctionAt && auctionAt > now
    add('foreclosure', future ? 'critical' : 'high', future ? `Auction scheduled ${new Date(auctionAt).toISOString().slice(0, 10)}` : 'Pre-foreclosure on record',
      [clean(parcel?.preforeclosure_status) || null, fcl[0]?.doc_type ? clean(fcl[0].doc_type) : null, auctionAt && !future ? `auction date ${new Date(auctionAt).toISOString().slice(0, 10)} has passed — status unverified` : null].filter(Boolean).join(' · ') || null,
      'foreclosure records')
  }
  // Only lien-type instruments count; releases, estate filings, UCC statements
  // and agreements are recorded documents, not debt (deal-record-documents.js).
  const docs = ctx.lienDocs || classifyLienDocuments(records?.liens)
  const liens = docs.filter((d) => d.status === 'lien')
  const conflicts = docs.filter((d) => d.status === 'conflict').length
  if (liens.length) {
    const amount = liens.reduce((a, l) => a + (num(l.amount) || 0), 0)
    const kinds = [...new Set(liens.map((l) => l.kindLabel))].slice(0, 3)
    add('liens', 'medium', `${liens.length} recorded lien${liens.length === 1 ? '' : 's'}`, [kinds.join(' · '), amount ? `${money(amount)} with a stated amount` : null, conflicts ? `${conflicts} more with conflicting descriptions` : null].filter(Boolean).join(' — '), 'lien records')
  } else if (conflicts) {
    add('lien_conflict', 'low', `${conflicts} recorded document${conflicts === 1 ? '' : 's'} with conflicting descriptions`, 'The record describes the same instrument both as a lien and as a release or non-lien document. Not counted as a lien.', 'lien records')
  }
  if (parcel?.tax_delinquent === true || props?.tax_delinquent === true) add('tax_delinquent', 'medium', 'Tax delinquent', props?.tax_delinquent_year ? `Delinquent since ${props.tax_delinquent_year}.` : null, 'tax record')
  if (score && obj(ev.offer_calculation).buyer_ceiling_authoritative === false) add('ceiling_not_behavioral', 'low', 'Buyer ceiling is modelled, not observed', 'Derived from the valuation — not enough defended buyer purchases nearby to confirm it.', 'offer_calculation.buyer_ceiling_reasons')
  if (/tenant/i.test(clean(ns?.occupancy))) add('tenant_occupied', 'low', 'Tenant occupied', 'Access, lease terms and estoppels matter for inspection and close.', 'seller message')
  if (ev.subject?.asset_identity_conflict) add('asset_identity_conflict', 'medium', 'Asset type conflicts across sources', humanize(ev.subject.asset_identity_conflict?.reason || ev.subject.asset_identity_conflict) || null, 'evidence.subject')
  if (thread?.is_suppressed) add('suppressed', 'medium', 'Seller contact suppressed', 'Automation cannot message this seller.', 'inbox_thread_state')

  return risks.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

/** Deterministic plain-language summary: only facts already in the payload. */
export function decisionSummary({ score, tierReasons, gates, ns, ask, replay }) {
  if (!score) return []
  const lines = []
  const tier = clean(score.decision_tier).toUpperCase()
  const failed = gates.filter((g) => g.pass === false).map((g) => g.label)
  if (TIER_META[tier]) lines.push(`${TIER_META[tier].label}${failed.length ? ` — ${failed.length} hard gate${failed.length === 1 ? '' : 's'} not met: ${failed.join(', ')}` : ' — all hard gates met'}.`)
  const strongest = tierReasons.find((r) => /strongest_viable_path/.test(r))
  if (strongest) lines.push(`${humanize(strongest.replace(/_is_strongest_viable_path$/, ''))} is the strongest viable path.`)
  const offer = pos(score.recommended_cash_offer)
  if (offer) lines.push(`Engine cash offer ${money(offer)}, floor ${money(score.minimum_acceptable_offer)}, on a ${money(score.valuation_mid)} value.`)
  if (ns?.valuation_spendable === false) lines.push('The negotiation policy is withholding that number from the seller.')
  if (ask && offer) lines.push(`Seller asks ${money(ask)} — ${ask > offer ? `${money(ask - offer)} above` : `${money(offer - ask)} below`} the engine offer.`)
  if (replay && !replay.replayable && replay.result) lines.push(`Current offer policy would restate it at ${money(replay.result.recommended_offer)}.`)
  return lines
}

/* ── loader ─────────────────────────────────────────────────────────────── */

const PROPERTY_COLUMNS = [
  'property_id', 'property_address_full', 'property_address_city', 'property_address_state', 'property_address_zip',
  'master_owner_id', 'property_type', 'units_count', 'total_bedrooms', 'total_baths', 'year_built', 'latitude', 'longitude', 'market',
  'estimated_value', 'equity_amount', 'equity_percent', 'total_loan_balance', 'total_loan_amt', 'total_loan_payment',
  'estimated_repair_cost', 'building_condition', 'mls_current_listing_price', 'mls_market_status', 'mls_sold_price',
  'mls_sold_date', 'monthly_rent', 'rent_estimate', 'tax_amt', 'tax_year', 'tax_delinquent', 'tax_delinquent_year',
].join(',')

const SCORE_COLUMNS = [
  'property_id', 'aos_score', 'confidence', 'decision_tier', 'best_strategy', 'computed_at',
  'valuation_low', 'valuation_mid', 'valuation_high', 'valuation_confidence', 'comp_count',
  'investor_ceiling_low', 'investor_ceiling_mid', 'investor_ceiling_high', 'buyer_demand_score', 'liquidity_score',
  'estimated_repairs', 'recommended_cash_offer', 'minimum_acceptable_offer', 'expected_assignment_fee',
  'subject_to_score', 'seller_finance_score', 'lease_option_score', 'novation_score',
  // Only the evidence branches the surface reads — the full blob carries up to
  // 100 rejected comps with per-feature breakdowns.
  'oc:evidence->offer_calculation', 'cds:evidence->comp_data_status', 'vcs:evidence->valuation_calculation_summary',
  'sel:evidence->selected_comps', 'dtr:evidence->decision_tier_reasoning', 'cb:evidence->confidence_breakdown',
  'cfr:evidence->creative_finance_reasoning', 'rcs:evidence->recommended_conversation_strategy',
  're:evidence->repair_estimate', 'subj:evidence->subject', 'eng:evidence->engine', 'isid:evidence->immutable_snapshot_id',
  'di:evidence->decision_inputs', 'aosb:evidence->aos_breakdown', 'ics:evidence->investor_ceiling_summary',
].join(',')

function reassembleScore(row) {
  if (!row) return null
  const { oc, cds, vcs, sel, dtr, cb, cfr, rcs, re, subj, eng, isid, di, aosb, ics, ...rest } = row
  // The investor summary carries up to 20 sample purchases (incl. portfolio
  // deals priced in the tens of millions); only its counts are ever shown.
  const icsCounts = ics && typeof ics === 'object' ? { ...ics, sample_purchases: undefined } : ics
  return {
    ...rest,
    evidence: {
      offer_calculation: oc, comp_data_status: cds, valuation_calculation_summary: vcs, selected_comps: sel,
      decision_tier_reasoning: dtr, confidence_breakdown: cb, creative_finance_reasoning: cfr,
      recommended_conversation_strategy: rcs, repair_estimate: re, subject: subj, engine: eng,
      immutable_snapshot_id: isid, decision_inputs: di, aos_breakdown: aosb, investor_ceiling_summary: icsCounts,
    },
  }
}

const THREAD_COLUMNS = [
  'thread_key', 'canonical_e164', 'property_id', 'seller_display_name', 'is_suppressed', 'suppressed_at', 'inbox_bucket',
  'operational_status', 'lifecycle_stage', 'lead_temperature', 'seller_stage', 'conversation_status', 'contactability_status',
  'automation_state', 'automation_status', 'automation_lane', 'next_action', 'next_action_at', 'next_scheduled_for',
  'follow_up_at', 'pending_queue_count', 'failed_queue_count', 'blocked_queue_count', 'paused_reason', 'snoozed_until',
  'last_intent', 'disposition', 'latest_direction', 'last_inbound_at', 'last_outbound_at', 'message_count',
].join(',')

/** The conversation's own state — contactability, temperature, automation. */
export function contactFromThread(thread) {
  if (!thread) return null
  const key = clean(thread.thread_key)
  const phone = clean(thread.canonical_e164) || (/^\+?\d{10,15}$/.test(key) ? key : '') || null
  return {
    threadKey: key || null,
    phone,
    sellerName: clean(thread.seller_display_name) || null,
    contactability: clean(thread.contactability_status) || null,
    suppressed: thread.is_suppressed === true,
    temperature: clean(thread.lead_temperature) || null,
    lifecycleStage: clean(thread.lifecycle_stage) || null,
    operationalStatus: clean(thread.operational_status) || null,
    conversationStatus: clean(thread.conversation_status) || null,
    disposition: clean(thread.disposition) || null,
    lastIntent: clean(thread.last_intent) || null,
    lastInboundAt: thread.last_inbound_at || null,
    lastOutboundAt: thread.last_outbound_at || null,
    latestDirection: clean(thread.latest_direction) || null,
    messageCount: num(thread.message_count),
  }
}

/**
 * Who has the move, and what the machine will do next. The lane is the
 * Pipeline's own derivation (deriveLane / deriveStall) over the same
 * evidence, so Deal Intelligence and Pipeline can never disagree about it.
 */
export function automationState({ opp, thread, execution, closing, ns, now = Date.now() }) {
  const n = obj(ns)
  let lane = null
  let stall = null
  if (opp && typeof pipelineCommand.deriveLane === 'function') {
    try {
      lane = pipelineCommand.deriveLane(opp, { thread, execution, closing, now })
      if (lane && typeof pipelineCommand.deriveStall === 'function') stall = pipelineCommand.deriveStall(opp, lane, { thread, now })
    } catch (error) {
      console.warn('deal_decision.lane_unavailable', error?.message)
    }
  }
  const unresolved = arr(n.unresolved_contract_fields).map((f) => ({ key: clean(f), label: humanize(f) })).filter((f) => f.key)
  return {
    lane: lane ? { key: lane.key, label: lane.label, detail: lane.detail || null, since: lane.since || null, reason: lane.reason || null } : null,
    stall: stall ? { key: stall.key, label: stall.label } : null,
    thread: thread ? {
      state: clean(thread.automation_state) || null,
      status: clean(thread.automation_status) || null,
      lane: clean(thread.automation_lane) || null,
      nextAction: clean(thread.next_action) || null,
      nextActionAt: thread.next_action_at || null,
      nextScheduledFor: thread.next_scheduled_for || null,
      followUpAt: thread.follow_up_at || null,
      pendingQueue: num(thread.pending_queue_count) ?? 0,
      failedQueue: num(thread.failed_queue_count) ?? 0,
      blockedQueue: num(thread.blocked_queue_count) ?? 0,
      pausedReason: clean(thread.paused_reason) || null,
      snoozedUntil: thread.snoozed_until || null,
    } : null,
    execution: execution ? {
      status: clean(execution.status) || null,
      reason: clean(execution.reason) || null,
      reasonLabel: humanize(execution.reason),
      stage: clean(execution.stage) || null,
      mode: clean(execution.mode) || null,
      at: execution.created_at || null,
    } : null,
    negotiation: ns ? {
      nextMove: clean(n.next_move) || null,
      nextMoveLabel: humanize(n.next_move),
      nextActionDueAt: n.next_action_due_at || null,
      lastAction: humanize(n.last_action),
      strategy: humanize(n.current_strategy || n.strategy),
      humanReviewReason: humanize(n.human_review_reason),
      contractReadiness: humanize(n.contract_readiness),
      unresolvedContractFields: unresolved,
      sellerSentiment: humanize(n.last_seller_sentiment || n.seller_sentiment),
      round: num(n.negotiation_round),
      // seller_counters / offers_made are empty on every opportunity (0 of all,
      // 2026-10-01); counters live in seller_offers and the ask history.
      minimumAssignmentMargin: pos(n.minimum_assignment_margin),
    } : null,
  }
}

async function resolveOpportunity(client, { opportunityId, propertyId, threadKey }) {
  // The lane columns (next_action … last_contact_at) are the inputs the
  // Pipeline's deriveLane reads; metadata carries negotiation_state.
  const cols = 'id, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, asking_price, current_offer, seller_counter, recommended_offer, last_activity_at, stage_entered_at, metadata, updated_at, next_action, next_action_due, latest_intent, blocker, conversation_state, last_contact_at, temperature, seller_display_name'
  if (opportunityId) {
    const { data } = await client.from('acquisition_opportunities').select(cols).eq('id', opportunityId).maybeSingle()
    return data || null
  }
  let q = client.from('acquisition_opportunities').select(cols).order('updated_at', { ascending: false }).limit(10)
  if (propertyId) q = q.eq('primary_property_id', propertyId)
  else if (threadKey) q = q.eq('primary_thread_key', threadKey)
  else return null
  const { data } = await q
  const rows = arr(data)
  return rows.find((r) => !TERMINAL_STATUSES.has(clean(r.opportunity_status).toLowerCase())) || rows[0] || null
}

export async function getDealDecision({ propertyId: rawProperty, threadKey: rawThread, opportunityId } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const now = deps.now ?? Date.now()
  let propertyId = clean(rawProperty) || null
  const threadKey = clean(rawThread) || null

  const opp = await resolveOpportunity(client, { opportunityId, propertyId, threadKey })
  propertyId = propertyId || clean(opp?.primary_property_id) || null
  if (!propertyId) return null

  let thread = clean(opp?.primary_thread_key) || threadKey
  const [propRes, scoreRes, snapRes, recRes, offersRes, buyersRes, closingRes, threadRes0] = await Promise.all([
    client.from('properties').select(PROPERTY_COLUMNS).eq('property_id', propertyId).maybeSingle(),
    client.from('property_acquisition_scores').select(SCORE_COLUMNS).eq('property_id', propertyId).order('computed_at', { ascending: false }).limit(1),
    client.from('acquisition_score_snapshots').select('snapshot_id, computed_at, engine_version, policy_version, valuation_low, valuation_mid, valuation_high, recommended_cash_offer, minimum_acceptable_offer, decision_tier, confidence, selected_comp_count').eq('property_id', propertyId).order('computed_at', { ascending: false }).limit(12),
    client.rpc('entity_graph_property_records', { p_property_id: propertyId }),
    client.from('seller_offers').select('offer_id, offer_version, offer_type, direction, purchase_price, status, strategy, ade_snapshot_id, recommended_offer, authorized_ceiling, created_at, sent_at, accepted_at, accepted_price, superseded_at').eq('property_id', propertyId).order('created_at', { ascending: false }).limit(20),
    client.from('buyer_match_candidates').select('buyer_match_run_id, created_at, buyer_display_name, buyer_type, match_grade, match_score, suggested_dispo_price, buyer_response_status, package_sent_at, selected').eq('property_id', propertyId).order('created_at', { ascending: false }).limit(300),
    client.from('closing_cases').select('closing_status, contract_status, seller_contract_price, buyer_price, assignment_fee, net_revenue, confirmed_gross_revenue, revenue_status, revenue_confirmed_date, funding_date, recording_date, scheduled_closing_date, provenance').eq('property_id', propertyId).limit(5),
    thread
      ? client.from('inbox_thread_state').select(THREAD_COLUMNS).eq('thread_key', thread).maybeSingle()
      // A property-only arrival still has a conversation when a thread is
      // linked to THIS property — the same subject, never a different one.
      : client.from('inbox_thread_state').select(THREAD_COLUMNS).eq('property_id', propertyId).order('last_inbound_at', { ascending: false, nullsFirst: false }).limit(1),
  ])
  const threadRow = Array.isArray(threadRes0.data) ? threadRes0.data[0] || null : threadRes0.data || null
  const threadRes = { data: threadRow }
  if (!thread && threadRow?.thread_key) thread = clean(threadRow.thread_key)

  const props = propRes.data || null
  const score = reassembleScore(arr(scoreRes.data)[0])
  const snapshots = arr(snapRes.data)
  const records = obj(recRes.data)
  const parcel = obj(records.parcel)
  if (!props && !score && !Object.keys(parcel).length) return null

  /* second wave: comp source rows, owner, people — all keyed off the first */
  const compIds = arr(score?.evidence?.selected_comps).map((c) => clean(c.comp_id || c.id)).filter(Boolean)
  const ownerId = clean(props?.master_owner_id) || null
  // Side reads never sink the decision: a failure here renders as "unavailable".
  const soft = (p) => Promise.resolve(p).catch((error) => { console.warn('deal_decision.side_read_failed', error?.message); return null })
  const [compRes, ownerRes, prospectRes, conversation, market, execRes, quotesRes] = await Promise.all([
    compIds.length ? client.from('v_recent_sold_comps').select(COMP_DETAIL_COLUMNS).in('id', compIds) : Promise.resolve({ data: [] }),
    ownerId ? client.from('master_owners').select('*').eq('master_owner_id', ownerId).maybeSingle() : Promise.resolve({ data: null }),
    ownerId ? client.from('prospects').select('prospect_id, full_name, first_name, gender, marital_status, education_model, occupation_group, est_household_income, net_asset_value, buying_power, language_preference, likely_owner, likely_renting, best_phone, best_email, contact_window, timezone, sms_eligible, email_eligible, contact_score_final, person_flags_text, is_primary_prospect, rank_position').eq('master_owner_id', ownerId).order('rank_position', { ascending: true }).limit(8) : Promise.resolve({ data: [] }),
    thread ? soft(getConversationSignal({ threadKey: thread, now }, { supabase: client })) : Promise.resolve(null),
    soft(getMarketDemand({ propertyId, radiusMiles: 1.5, months: 18 }, { supabase: client })),
    // The latest seller-automation execution — the same evidence the Pipeline
    // lane reads (status + block_reason), indexed on (thread_id, started_at).
    thread ? soft(client.from('seller_automation_executions').select('status, lifecycle_stage, metadata, created_at, started_at').eq('thread_id', thread).order('started_at', { ascending: false }).limit(1)) : Promise.resolve(null),
    // Every number quoted to the seller (negotiation_quotes — PROPOSED table):
    // anchors shown APART from formal offers. A missing table reads as "not captured".
    soft(client.from('negotiation_quotes').select('quote_type, amount, max_offer_at_quote, rule_branch, language, template_id, quoted_at, comp_ids, score_snapshot_id, seller_offer_id').eq('property_id', propertyId).order('quoted_at', { ascending: false }).limit(20)),
  ])
  const quotes = quotesRes && !quotesRes.error ? arr(quotesRes.data) : null
  const execRow = arr(execRes?.data)[0] || null
  const execution = execRow ? { status: clean(execRow.status), reason: clean(execRow.metadata?.block_reason) || null, created_at: execRow.created_at || execRow.started_at, stage: execRow.lifecycle_stage || null, mode: clean(execRow.metadata?.execution_mode) || null } : null
  const compDetails = new Map(arr(compRes.data).map((r) => [clean(r.id), r]))
  const subjectForComps = { propertyType: clean(parcel.property_type || props?.property_type), units: num(parcel.units_count ?? props?.units_count) }

  const meta = obj(opp?.metadata)
  const ns = meta.negotiation_state && typeof meta.negotiation_state === 'object' ? meta.negotiation_state : null
  const ask = pos(ns?.current_asking_price ?? ns?.current_ask) ?? pos(opp?.asking_price)
  const avm = pos(props?.estimated_value) ?? pos(parcel.estimated_value)
  // §82 Negotiation v3 desk (operator-only, NEGOTIATION_ENGINE_V3 default OFF): ask, anchor,
  // current position, target, autonomous limit, ceiling + why. Never seller text.
  const negotiationV3 = isNegotiationEngineV3Enabled() && score
    ? (() => {
        try {
          return buildNegotiationDeskView({
            ade_snapshot: score,
            property: { property_id: propertyId, property_type: clean(parcel.property_type || props?.property_type), units_count: num(parcel.units_count ?? props?.units_count) },
            seller: { asking_price: ask, condition: clean(obj(meta.seller_facts).property_condition?.value ?? obj(meta.seller_facts).property_condition) || null, occupancy: clean(obj(meta.seller_facts).occupancy_status?.value ?? obj(meta.seller_facts).occupancy_status) || null },
            quotes,
            now,
          })
        } catch (error) {
          console.warn('deal_decision.negotiation_v3_failed', error?.message)
          return null
        }
      })()
    : null
  const oc = obj(score?.evidence?.offer_calculation)
  const quality = score ? compEvidenceQuality(score.evidence) : null
  const replay = score ? replayStoredOffer(score) : null
  const dtr = obj(score?.evidence?.decision_tier_reasoning)
  const gates = decisionGates(score)
  const tierReasons = arr(dtr.reasons).map(clean).filter(Boolean)
  const tier = clean(score?.decision_tier).toUpperCase() || null
  const computedAt = score?.computed_at || null
  const offers = arr(offersRes.data)
  const binding = offers.find((o) => !o.superseded_at && ['sent', 'accepted', 'countered', 'pending', 'presented'].includes(clean(o.status).toLowerCase())) || null
  const currentOffer = pos(binding?.purchase_price) ?? pos(opp?.current_offer)

  const spectrum = buildValuationSpectrum({
    low: score?.valuation_low, mid: score?.valuation_mid, high: score?.valuation_high, avm,
    compLow: quality?.adjustedLow, compHigh: quality?.adjustedHigh, ask,
    recommended: score?.recommended_cash_offer, floor: score?.minimum_acceptable_offer,
    ceiling: oc.effective_authorized_ceiling, mlsList: props?.mls_current_listing_price, currentOffer,
  })

  /* economics — estimates, labelled as such; never a netted "payoff" */
  // Current loans only (mtg1–4, empty provider slots dropped); prior and
  // purchase-money loans are history, not open debt.
  const loanBook = classifyMortgages(records.mortgages)
  const mortgages = loanBook.current
  // Recorded instruments, classified: only lien-type rows are liens.
  const lienDocs = classifyLienDocuments(records.liens)
  const liens = lienDocs.filter((d) => d.status === 'lien').map((d) => ({
    type: d.kindLabel, holder: d.claimant, amount: d.amount, at: d.at,
    kind: d.kind, title: d.title, parties: d.parties, updatedAt: d.updatedAt,
  }))
  const estOpenBalance = pos(parcel.total_loan_balance ?? props?.total_loan_balance)
  const economics = {
    avm,
    avmRange: pos(parcel.value_low) && pos(parcel.value_high) ? { low: pos(parcel.value_low), high: pos(parcel.value_high), confidence: num(parcel.value_confidence) } : null,
    equityEstimate: num(parcel.estimated_equity ?? props?.equity_amount),
    equityPercent: num(parcel.equity_percent ?? props?.equity_percent),
    debt: {
      estOpenBalance,
      openMortgageCount: num(parcel.open_mortgage_count),
      monthlyPayment: pos(parcel.total_loan_payment ?? props?.total_loan_payment),
      originalTotal: pos(parcel.total_loan_amount ?? props?.total_loan_amt),
      mortgages,
      priorMortgages: loanBook.prior,
      // A balance of 0 on a recorded modification is the provider's unknown,
      // not a paid-off loan — say so instead of summing it as zero. Counted
      // over REAL current loans only (empty slots used to count here).
      unknownBalances: mortgages.filter((m) => !m.balanceKnown).length,
    },
    liens,
    recordedDocuments: lienDocs,
    lienSummary: summarizeLienDocuments(lienDocs),
    foreclosure: arr(records.foreclosures)[0] ? {
      status: clean(parcel.preforeclosure_status) || null,
      docType: clean(records.foreclosures[0].doc_type) || null,
      defaultAt: clean(records.foreclosures[0].default_date) || null,
      auctionAt: clean(records.foreclosures[0].auction_date || parcel.auction_date) || null,
      recordedAt: clean(records.foreclosures[0].recording_date) || null,
    } : clean(parcel.preforeclosure_status) ? { status: clean(parcel.preforeclosure_status), auctionAt: clean(parcel.auction_date) || null } : null,
    tax: { annual: pos(parcel.tax_amount ?? props?.tax_amt), year: num(parcel.tax_year ?? props?.tax_year), delinquent: (parcel.tax_delinquent ?? props?.tax_delinquent) === true, delinquentYear: num(props?.tax_delinquent_year) },
    atOffer: pos(score?.recommended_cash_offer) ? {
      offer: pos(score.recommended_cash_offer),
      ceilingSpread: pos(oc.effective_authorized_ceiling) ? pos(oc.effective_authorized_ceiling) - pos(score.recommended_cash_offer) : null,
      debtCovered: estOpenBalance ? pos(score.recommended_cash_offer) >= estOpenBalance : null,
    } : null,
  }

  /* history — recorded events + what the seller said + every analysis */
  const history = []
  for (const s of arr(records.sales)) history.push({ at: s.event_date, kind: 'sale', title: s.slot === 'current' ? 'Last sale' : 'Prior sale', amount: pos(s.price), detail: [clean(s.doc_type), s.is_arms_length === false ? 'non-arm’s-length' : null, s.is_cash_purchase ? 'cash' : null].filter(Boolean).join(' · ') || null })
  for (const m of mortgages) if (m.recordedAt) history.push({ at: m.recordedAt, kind: 'mortgage', title: `${m.type || 'Mortgage'} recorded`, amount: m.amount, detail: m.lender })
  for (const m of loanBook.prior) if (m.recordedAt) history.push({ at: m.recordedAt, kind: 'mortgage', title: `${m.kind === 'purchase' ? 'Purchase loan' : 'Prior loan'} recorded`, amount: m.amount, detail: [m.lender, m.type].filter(Boolean).join(' · ') || null })
  for (const d of lienDocs) {
    if (!d.at || d.status === 'document') continue
    history.push({ at: d.at, kind: 'lien', title: d.status === 'release' ? `Release · ${d.title}` : d.status === 'conflict' ? `${d.title} (descriptions conflict)` : d.kindLabel, amount: d.amount, detail: d.claimant || (d.parties.length ? d.parties.join(' · ') : null) })
  }
  if (economics.foreclosure?.recordedAt) history.push({ at: economics.foreclosure.recordedAt, kind: 'foreclosure', title: economics.foreclosure.docType || 'Foreclosure filing', amount: null, detail: economics.foreclosure.auctionAt ? `Auction ${economics.foreclosure.auctionAt}` : null })
  for (const h of arr(ns?.asking_price_history)) history.push({ at: h.at, kind: 'ask', title: h.kind === 'initial' ? 'Seller named a price' : 'Seller moved price', amount: pos(h.value), detail: clean(h.extracted_text) ? `“${clean(h.extracted_text)}”` : null })
  for (const s of snapshots) history.push({ at: s.computed_at, kind: 'analysis', title: 'Engine analysis', amount: pos(s.recommended_cash_offer), detail: [TIER_META[clean(s.decision_tier)]?.label || humanize(s.decision_tier), pos(s.valuation_mid) ? `value ${money(s.valuation_mid)}` : null].filter(Boolean).join(' · ') })
  for (const o of offers) history.push({ at: o.sent_at || o.created_at, kind: 'offer', title: `${o.direction === 'inbound' ? 'Seller counter' : 'Offer'} ${humanize(o.status) || ''}`.trim(), amount: pos(o.purchase_price), detail: o.ade_snapshot_id ? 'linked to engine snapshot' : null })
  history.sort((a, b) => (ts(b.at) || 0) - (ts(a.at) || 0))

  /* buyers — demand shape only; buyer identities stay in Buyer Match */
  const cands = latestRunCandidates(arr(buyersRes.data))
  const grades = {}
  const types = {}
  const dispo = []
  for (const c of cands) {
    const g = clean(c.match_grade) || '—'
    grades[g] = (grades[g] || 0) + 1
    const t = humanize(c.buyer_type) || 'Unknown'
    types[t] = (types[t] || 0) + 1
    if (pos(c.suggested_dispo_price)) dispo.push(pos(c.suggested_dispo_price))
  }
  dispo.sort((a, b) => a - b)
  const buyers = cands.length ? {
    candidates: cands.length,
    grades,
    types: Object.entries(types).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count).slice(0, 4),
    medianDispo: dispo.length ? dispo[Math.floor(dispo.length / 2)] : null,
    topScore: num(cands[0]?.match_score),
    packagesSent: cands.filter((c) => c.package_sent_at).length,
    interested: cands.filter((c) => /interest|yes|accept/i.test(clean(c.buyer_response_status))).length,
    selected: cands.some((c) => c.selected === true),
  } : null

  /* actuals — only a closing with settlement evidence */
  const closing = arr(closingRes.data).find((c) => !c.provenance?.voided && /closed|funded|recorded/i.test(clean(c.closing_status))
    && (c.funding_date || c.recording_date || c.revenue_confirmed_date)) || null
  const actuals = closing ? {
    status: clean(closing.closing_status),
    contractPrice: pos(closing.seller_contract_price),
    buyerPrice: pos(closing.buyer_price),
    assignmentFee: pos(closing.assignment_fee),
    netRevenue: pos(closing.net_revenue),
    confirmedRevenue: pos(closing.confirmed_gross_revenue),
    closedAt: closing.recording_date || closing.funding_date || closing.revenue_confirmed_date,
    evidence: [closing.funding_date && 'funded', closing.recording_date && 'recorded', closing.revenue_confirmed_date && 'revenue confirmed'].filter(Boolean),
  } : null

  const compsTop = score ? topComps(score.evidence, 12, compDetails, subjectForComps) : []
  // Comp-only parcels (sold, never entered `properties`) have no property surface to
  // open; one batched existence read per decision marks them (null = check failed).
  await markCanonicalComps(client, compsTop)
  const integrity = score ? assetIntegrity(compsTop, subjectForComps) : null
  const risks = deriveDealRisks({ score, props, parcel, records, ns, replay, quality, thread: threadRes.data, propertyId, ask, avm, now, integrity, lienDocs })
  const latestSnap = snapshots[0] || null
  const stage = clean(opp?.acquisition_stage) || null
  const closingRow = arr(closingRes.data).find((c) => !c.provenance?.voided) || null
  const automation = automationState({ opp, thread: threadRes.data, execution, closing: closingRow, ns, now })
  const cbRaw = obj(score?.evidence?.confidence_breakdown)
  const subjectMissing = arr(cbRaw.subject_data_completeness?.missing).map(humanize).filter(Boolean)
  const financeMissing = arr(cbRaw.finance_distress_completeness?.missing).map(humanize).filter(Boolean)
  const compDates = compsTop.map((c) => ts(c.saleDate)).filter(Boolean)

  return {
    generatedAt: new Date(now).toISOString(),
    subject: {
      propertyId,
      address: clean(props?.property_address_full || parcel.address_full) || null,
      city: clean(props?.property_address_city || parcel.city) || null,
      state: clean(props?.property_address_state || parcel.state) || null,
      zip: clean(props?.property_address_zip || parcel.zip5) || null,
      market: clean(props?.market) || null,
      propertyType: clean(parcel.property_type || props?.property_type) || null,
      units: num(parcel.units_count ?? props?.units_count),
      beds: num(parcel.bedrooms ?? props?.total_bedrooms),
      baths: num(parcel.baths ?? props?.total_baths),
      sqft: num(parcel.building_sqft),
      yearBuilt: num(parcel.year_built ?? props?.year_built),
      lat: num(props?.latitude ?? parcel.latitude),
      lng: num(props?.longitude ?? parcel.longitude),
      mls: pos(props?.mls_current_listing_price) || clean(props?.mls_market_status) ? { listPrice: pos(props?.mls_current_listing_price), status: clean(props?.mls_market_status) || null, soldPrice: pos(props?.mls_sold_price), soldAt: clean(props?.mls_sold_date) || null } : null,
      isCanary: /^canary/i.test(propertyId),
    },
    pipeline: opp ? {
      opportunityId: opp.id,
      stage,
      stageLabel: UNIVERSAL_STAGE_LABELS[stage] || humanize(stage),
      status: clean(opp.opportunity_status) || null,
      threadKey: thread || null,
      lastActivityAt: opp.last_activity_at || opp.updated_at || null,
      stageEnteredAt: opp.stage_entered_at || null,
    } : null,
    decision: score ? {
      status: 'available',
      tier,
      tierLabel: TIER_META[tier]?.label || humanize(tier),
      tierTone: TIER_META[tier]?.tone || 'hold',
      tierReasons: tierReasons.map((r) => humanize(r.replace(/^hard_gate_failed:/, 'gate not met: '))),
      gates,
      aos: num(score.aos_score),
      confidence: num(score.confidence),
      valuationConfidence: num(score.valuation_confidence),
      confidenceBreakdown: score.evidence.confidence_breakdown ? {
        formula: clean(score.evidence.confidence_breakdown.formula) || null,
        valuation: num(score.evidence.confidence_breakdown.valuation_confidence),
        subject: num(score.evidence.confidence_breakdown.subject_data_completeness?.score),
        buyer: num(score.evidence.confidence_breakdown.buyer_behavior_confidence),
        finance: num(score.evidence.confidence_breakdown.finance_distress_completeness?.score),
        // The two completeness lists overlap (ownership years is in both); once each.
        missing: [...new Set([...subjectMissing, ...financeMissing])],
        subjectMissing,
        financeMissing,
        uncapped: num(cbRaw.uncapped_overall),
        cap: num(cbRaw.confidence_cap),
        capReason: humanize(cbRaw.cap_reason),
      } : null,
      aosComposition: aosComposition(score),
      investorEvidence: investorEvidence(score),
      strategyBasis: strategyBasis(score),
      bestStrategy: clean(score.best_strategy) || null,
      bestStrategyLabel: STRATEGY_LABELS[clean(score.best_strategy).toUpperCase()] || humanize(score.best_strategy),
      leadWith: humanize(score.evidence.recommended_conversation_strategy?.primary_offer_to_lead_with),
      conversationAngle: humanize(score.evidence.recommended_conversation_strategy?.conversation_angle),
      why: clean(score.evidence.recommended_conversation_strategy?.why_this_angle) || null,
      computedAt,
      ageDays: ts(computedAt) ? Math.floor((now - ts(computedAt)) / DAY) : null,
      summary: decisionSummary({ score, tierReasons, gates, ns, ask, replay }),
      authorization: ns ? {
        presentable: ns.valuation_spendable === false ? false : ns.valuation_spendable === true ? true : null,
        withheldReason: clean(ns.recommended_offer_withheld_reason || ns.valuation_non_spendable_reason) || null,
        withheldText: WITHHELD_REASONS[clean(ns.recommended_offer_withheld_reason || ns.valuation_non_spendable_reason)] || null,
        economicFit: humanize(ns.economic_fit),
        zone: humanize(ns.negotiation_zone),
        band: humanize(ns.economic_offer_band),
        authorizedFloor: pos(ns.authorized_offer_floor),
        authorizedCeiling: pos(ns.authorized_offer_ceiling),
        directPurchaseMax: pos(ns.direct_purchase_maximum),
        remainingMovement: num(ns.gap_metrics?.remaining_authorized_movement),
        strategy: humanize(ns.current_strategy || ns.strategy),
        nextMove: humanize(ns.next_move),
      } : null,
    } : { status: 'not_run' },
    valuation: score ? {
      low: pos(score.valuation_low), mid: pos(score.valuation_mid), high: pos(score.valuation_high),
      confidence: num(score.valuation_confidence), avm, compLow: quality?.adjustedLow ?? null, compHigh: quality?.adjustedHigh ?? null,
      spectrum,
    } : (avm ? { low: null, mid: null, high: null, confidence: null, avm, compLow: null, compHigh: null, spectrum } : null),
    offer: score ? {
      recommended: num(score.recommended_cash_offer),
      floor: num(score.minimum_acceptable_offer),
      expectedFee: num(score.expected_assignment_fee),
      valuationCeiling: num(oc.valuation_based_ceiling),
      behaviorCeiling: num(oc.behavior_based_ceiling),
      effectiveCeiling: num(oc.effective_authorized_ceiling),
      ceilingBasis: humanize(oc.ceiling_basis),
      buyerCeilingAuthoritative: oc.buyer_ceiling_authoritative === true,
      buyerCeilingReasons: arr(oc.buyer_ceiling_reasons).map(humanize),
      targetMargin: num(oc.target_assignment_fee),
      protectedMargin: num(oc.protected_margin),
      // The fee gate's threshold (minimum economics) and the room above it.
      assignmentMarginFloor: num(oc.assignment_margin_floor) ?? num(oc.assignment_margin_policy?.minimum_margin),
      negotiableMargin: num(oc.negotiable_margin),
      marginPct: num(oc.assignment_margin_policy?.margin_pct),
      marginPolicy: clean(oc.assignment_margin_policy?.policy_version) || null,
      repairs: { amount: num(score.evidence.repair_estimate?.amount ?? score.estimated_repairs), source: score.evidence.repair_estimate?.source === 'property_estimated_repair_cost' ? 'Data-provider estimate' : humanize(score.evidence.repair_estimate?.source), confidence: num(score.evidence.repair_estimate?.confidence) },
      maxArvFactor: num(oc.max_arv_factor),
      terms: { confidenceHaircutPct: num(oc.confidence_haircut_percent), motivationDiscountPct: num(oc.motivation_discount_percent), demandPremiumPct: num(oc.demand_premium_percent) },
      protectedMarginEnforced: oc.protected_margin_enforced === true,
      method: clean(oc.method) || null,
      negotiation: {
        ask, initialAsk: pos(ns?.initial_asking_price ?? ns?.initial_ask), currentOffer, counter: pos(opp?.seller_counter),
        lowestIndication: pos(ns?.lowest_seller_indication), sellerNet: pos(ns?.seller_net_requirement),
        concessions: num(ns?.cumulative_concession_amount),
      },
      offers: offers.map((o) => ({ id: o.offer_id, version: o.offer_version, direction: o.direction, price: pos(o.purchase_price), status: o.status, strategy: humanize(o.strategy), snapshotId: o.ade_snapshot_id || null, sentAt: o.sent_at, acceptedAt: o.accepted_at, supersededAt: o.superseded_at })),
      // Anchors are NOT offers: "Anchor $185K quoted 10-06 (rule: above_max)".
      quotes: quotes == null
        ? { status: 'not_captured', anchors: [], formalOffers: [] }
        : {
            status: 'captured',
            anchors: quotes.filter((q) => q.quote_type === 'anchor').map((q) => ({ amount: pos(q.amount), maxOffer: pos(q.max_offer_at_quote), rule: clean(q.rule_branch) || null, language: q.language || null, templateId: q.template_id || null, quotedAt: q.quoted_at, compIds: arr(q.comp_ids), snapshotId: q.score_snapshot_id || null, label: describeQuote(q) })),
            formalOffers: quotes.filter((q) => q.quote_type === 'formal_offer').map((q) => ({ amount: pos(q.amount), offerId: q.seller_offer_id || null, quotedAt: q.quoted_at, label: describeQuote(q) })),
            confirmations: quotes.filter((q) => q.quote_type === 'confirm_basics_no_number').map((q) => ({ quotedAt: q.quoted_at, label: describeQuote(q) })),
          },
      negotiationV3,
      binding: Boolean(binding),
      lineage: {
        snapshotId: clean(score.evidence.immutable_snapshot_id) || latestSnap?.snapshot_id || null,
        negotiationSnapshotId: clean(ns?.ade_snapshot_id) || null,
        negotiationUsesLatest: ns?.ade_snapshot_id ? ns.ade_snapshot_id === (clean(score.evidence.immutable_snapshot_id) || latestSnap?.snapshot_id) : null,
      },
    } : null,
    sellerFacts: sellerFactsWithProvenance({ ns, sellerFacts: meta.seller_facts, props, parcel, score }),
    comps: score ? { ...quality, top: compsTop, assetIntegrity: integrity, buyerMix: compBuyerMix(compsTop), anchor: ns?.selected_comp_anchor ? { address: clean(ns.selected_comp_anchor.address), salePrice: pos(ns.selected_comp_anchor.sale_price), saleDate: ns.selected_comp_anchor.sale_date || null, statement: clean(ns.selected_comp_anchor.authorized_statement) || null, disclosed: ns.selected_comp_anchor.previously_disclosed === true } : null } : null,
    economics,
    conversation,
    market,
    record: {
      sections: parcelSections(parcel),
      owner: ownerRes.data ? { name: clean(ownerRes.data.display_name) || null, sections: ownerSections(ownerRes.data) } : null,
      prospects: prospectCards(prospectRes.data),
    },
    history: history.slice(0, 40),
    valuationHistory: snapshots.map((s) => ({
      at: s.computed_at, low: pos(s.valuation_low), mid: pos(s.valuation_mid), high: pos(s.valuation_high),
      offer: pos(s.recommended_cash_offer), floor: pos(s.minimum_acceptable_offer),
      tier: TIER_META[clean(s.decision_tier)]?.label || humanize(s.decision_tier), comps: num(s.selected_comp_count),
      confidence: num(s.confidence), snapshotId: clean(s.snapshot_id) || null,
      engineVersion: clean(s.engine_version) || null, policyVersion: clean(s.policy_version) || null,
    })).reverse(),
    strategies: engineStrategies(score),
    risks,
    buyers,
    actuals,
    scenario: replay ? {
      replayable: replay.replayable,
      reason: replay.reason,
      delta: replay.delta,
      inputs: replay.inputs,
      current: replay.result,
      sensitivity: offerSensitivity(replay.inputs),
    } : null,
    contact: contactFromThread(threadRes.data),
    automation,
    // When each evidence family was last true — so a stale family can say so.
    freshness: {
      decision: computedAt,
      marketDataThrough: market?.window?.dataThrough ?? null,
      latestCompSale: compDates.length ? new Date(Math.max(...compDates)).toISOString().slice(0, 10) : null,
      lastSellerReply: threadRes.data?.last_inbound_at || conversation?.responsiveness?.lastInboundAt || null,
      buyerMatchRun: arr(buyersRes.data)[0]?.created_at || null,
      latestRecordedLoan: [...mortgages, ...loanBook.prior].map((m) => m.recordedAt).filter(Boolean).sort().slice(-1)[0] || null,
    },
    lineage: {
      engine: clean(score?.evidence?.engine?.name) || 'acquisition_decision_engine',
      engineVersion: clean(score?.evidence?.engine?.version) || latestSnap?.engine_version || null,
      policyVersion: latestSnap?.policy_version || clean(oc.assignment_margin_policy?.policy_version) || null,
      computedAt,
      snapshotCount: snapshots.length,
      latestSnapshotAt: latestSnap?.computed_at || null,
      snapshotMatchesProjection: latestSnap && computedAt ? Math.abs((ts(latestSnap.computed_at) || 0) - (ts(computedAt) || 0)) < 60_000 : null,
    },
  }
}

export { computeScenarioOffer }
