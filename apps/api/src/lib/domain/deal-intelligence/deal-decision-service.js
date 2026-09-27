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
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { UNIVERSAL_STAGE_LABELS } from '@/lib/domain/opportunity/universal-pipeline-registry.js'
import { offerSensitivity, replayStoredOffer, computeScenarioOffer } from './deal-scenario-model.js'

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
})

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

const REJECTION_LABELS = Object.freeze({
  asset_type_mismatch: 'Different asset type',
  outside_radius: 'Too far away',
  stale_sale: 'Sale too old',
  price_outlier: 'Price outlier',
  missing_price: 'No sale price',
  size_mismatch: 'Size mismatch',
  unit_mismatch: 'Unit-count mismatch',
})

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

/** The top selected comps, shaped for a phone. */
export function topComps(evidence, limit = 5) {
  return arr(obj(evidence).selected_comps)
    .slice()
    .sort((a, b) => (num(b.weight) || 0) - (num(a.weight) || 0))
    .slice(0, limit)
    .map((c) => {
      const core = arr(obj(obj(c.match_breakdown).core).features)
      const mismatches = core.filter((f) => f.status === 'mismatch').map((f) => ({ feature: humanize(f.feature), subject: f.subject, comp: f.comp }))
      return {
        id: clean(c.comp_id || c.id) || null,
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
  })
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

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * The concrete risk list. Each entry names a fact and where it came from.
 * No aggregate score — the operator reads the list.
 */
export function deriveDealRisks(ctx) {
  const { score, props, parcel, records, ns, replay, quality, thread, propertyId, ask, avm, now = Date.now() } = ctx
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
  const liens = arr(records?.liens)
  if (liens.length) {
    const amount = liens.reduce((a, l) => a + (num(l.hoa_lien_amount ?? l.lien_amount ?? l.judgment_amount) || 0), 0)
    const kinds = [...new Set(liens.map((l) => clean(l.doc_category || l.doc_title || l.doc_type || l.lien_type)).filter(Boolean))].slice(0, 3)
    add('liens', 'medium', `${liens.length} recorded lien${liens.length === 1 ? '' : 's'}`, [kinds.map(humanize).join(' · '), amount ? `${money(amount)} with a stated amount` : null].filter(Boolean).join(' — '), 'lien records')
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
  'property_type', 'units_count', 'total_bedrooms', 'total_baths', 'year_built', 'latitude', 'longitude', 'market',
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
  'di:evidence->decision_inputs',
].join(',')

function reassembleScore(row) {
  if (!row) return null
  const { oc, cds, vcs, sel, dtr, cb, cfr, rcs, re, subj, eng, isid, di, ...rest } = row
  return {
    ...rest,
    evidence: {
      offer_calculation: oc, comp_data_status: cds, valuation_calculation_summary: vcs, selected_comps: sel,
      decision_tier_reasoning: dtr, confidence_breakdown: cb, creative_finance_reasoning: cfr,
      recommended_conversation_strategy: rcs, repair_estimate: re, subject: subj, engine: eng,
      immutable_snapshot_id: isid, decision_inputs: di,
    },
  }
}

async function resolveOpportunity(client, { opportunityId, propertyId, threadKey }) {
  const cols = 'id, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, asking_price, current_offer, seller_counter, recommended_offer, last_activity_at, stage_entered_at, metadata, updated_at'
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

  const thread = clean(opp?.primary_thread_key) || threadKey
  const [propRes, scoreRes, snapRes, recRes, offersRes, buyersRes, closingRes, threadRes] = await Promise.all([
    client.from('properties').select(PROPERTY_COLUMNS).eq('property_id', propertyId).maybeSingle(),
    client.from('property_acquisition_scores').select(SCORE_COLUMNS).eq('property_id', propertyId).order('computed_at', { ascending: false }).limit(1),
    client.from('acquisition_score_snapshots').select('snapshot_id, computed_at, engine_version, policy_version, valuation_low, valuation_mid, valuation_high, recommended_cash_offer, minimum_acceptable_offer, decision_tier, confidence, selected_comp_count').eq('property_id', propertyId).order('computed_at', { ascending: false }).limit(12),
    client.rpc('entity_graph_property_records', { p_property_id: propertyId }),
    client.from('seller_offers').select('offer_id, offer_version, offer_type, direction, purchase_price, status, strategy, ade_snapshot_id, recommended_offer, authorized_ceiling, created_at, sent_at, accepted_at, accepted_price, superseded_at').eq('property_id', propertyId).order('created_at', { ascending: false }).limit(20),
    client.from('buyer_match_candidates').select('buyer_type, match_grade, match_score, suggested_dispo_price, buyer_response_status, package_sent_at, selected').eq('property_id', propertyId).order('match_score', { ascending: false }).limit(300),
    client.from('closing_cases').select('closing_status, contract_status, seller_contract_price, buyer_price, assignment_fee, net_revenue, confirmed_gross_revenue, revenue_status, revenue_confirmed_date, funding_date, recording_date, scheduled_closing_date, provenance').eq('property_id', propertyId).limit(5),
    thread ? client.from('inbox_thread_state').select('thread_key, is_suppressed, operational_status').eq('thread_key', thread).maybeSingle() : Promise.resolve({ data: null }),
  ])

  const props = propRes.data || null
  const score = reassembleScore(arr(scoreRes.data)[0])
  const snapshots = arr(snapRes.data)
  const records = obj(recRes.data)
  const parcel = obj(records.parcel)
  if (!props && !score && !Object.keys(parcel).length) return null

  const meta = obj(opp?.metadata)
  const ns = meta.negotiation_state && typeof meta.negotiation_state === 'object' ? meta.negotiation_state : null
  const ask = pos(ns?.current_asking_price ?? ns?.current_ask) ?? pos(opp?.asking_price)
  const avm = pos(props?.estimated_value) ?? pos(parcel.estimated_value)
  const oc = obj(score?.evidence?.offer_calculation)
  const quality = score ? compEvidenceQuality(score.evidence) : null
  const replay = score ? replayStoredOffer(score) : null
  const dtr = obj(score?.evidence?.decision_tier_reasoning)
  const gates = Object.entries(obj(dtr.hard_gate_checks)).map(([key, pass]) => ({ key, label: GATE_LABELS[key] || humanize(key), pass: pass === true }))
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
  const mortgages = arr(records.mortgages).map((m) => ({
    position: num(m.lien_position), lender: clean(m.lender_name) || null, type: clean(m.loan_type) || null,
    amount: num(m.loan_amount), estBalance: num(m.est_balance), rate: pos(m.interest_rate), payment: pos(m.est_payment),
    recordedAt: clean(m.recording_date) || null, dueAt: clean(m.due_date) || null,
  })).sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
  const liens = arr(records.liens).map((l) => ({
    type: humanize(l.doc_category || l.doc_title || l.doc_type || l.lien_type), holder: clean(l.hoa_lien_name || l.party_2_name || l.lienholder_name) || null,
    amount: pos(l.hoa_lien_amount ?? l.lien_amount ?? l.judgment_amount ?? l.nod_default_amount), at: clean(l.recording_date || l.filing_date) || null,
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
      // A balance of 0 on a recorded modification is the provider's unknown,
      // not a paid-off loan — say so instead of summing it as zero.
      unknownBalances: mortgages.filter((m) => m.estBalance === 0 || m.estBalance === null).length,
    },
    liens,
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
  for (const l of liens) if (l.at) history.push({ at: l.at, kind: 'lien', title: l.type || 'Lien', amount: l.amount, detail: l.holder })
  if (economics.foreclosure?.recordedAt) history.push({ at: economics.foreclosure.recordedAt, kind: 'foreclosure', title: economics.foreclosure.docType || 'Foreclosure filing', amount: null, detail: economics.foreclosure.auctionAt ? `Auction ${economics.foreclosure.auctionAt}` : null })
  for (const h of arr(ns?.asking_price_history)) history.push({ at: h.at, kind: 'ask', title: h.kind === 'initial' ? 'Seller named a price' : 'Seller moved price', amount: pos(h.value), detail: clean(h.extracted_text) ? `“${clean(h.extracted_text)}”` : null })
  for (const s of snapshots) history.push({ at: s.computed_at, kind: 'analysis', title: 'Engine analysis', amount: pos(s.recommended_cash_offer), detail: [TIER_META[clean(s.decision_tier)]?.label || humanize(s.decision_tier), pos(s.valuation_mid) ? `value ${money(s.valuation_mid)}` : null].filter(Boolean).join(' · ') })
  for (const o of offers) history.push({ at: o.sent_at || o.created_at, kind: 'offer', title: `${o.direction === 'inbound' ? 'Seller counter' : 'Offer'} ${humanize(o.status) || ''}`.trim(), amount: pos(o.purchase_price), detail: o.ade_snapshot_id ? 'linked to engine snapshot' : null })
  history.sort((a, b) => (ts(b.at) || 0) - (ts(a.at) || 0))

  /* buyers — demand shape only; buyer identities stay in Buyer Match */
  const cands = arr(buyersRes.data)
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

  const risks = deriveDealRisks({ score, props, parcel, records, ns, replay, quality, thread: threadRes.data, propertyId, ask, avm, now })
  const latestSnap = snapshots[0] || null
  const stage = clean(opp?.acquisition_stage) || null

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
        missing: [...arr(score.evidence.confidence_breakdown.subject_data_completeness?.missing), ...arr(score.evidence.confidence_breakdown.finance_distress_completeness?.missing)].map(humanize),
      } : null,
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
      binding: Boolean(binding),
      lineage: {
        snapshotId: clean(score.evidence.immutable_snapshot_id) || latestSnap?.snapshot_id || null,
        negotiationSnapshotId: clean(ns?.ade_snapshot_id) || null,
        negotiationUsesLatest: ns?.ade_snapshot_id ? ns.ade_snapshot_id === (clean(score.evidence.immutable_snapshot_id) || latestSnap?.snapshot_id) : null,
      },
    } : null,
    sellerFacts: sellerFactsWithProvenance({ ns, sellerFacts: meta.seller_facts, props, parcel, score }),
    comps: score ? { ...quality, top: topComps(score.evidence), anchor: ns?.selected_comp_anchor ? { address: clean(ns.selected_comp_anchor.address), salePrice: pos(ns.selected_comp_anchor.sale_price), saleDate: ns.selected_comp_anchor.sale_date || null, statement: clean(ns.selected_comp_anchor.authorized_statement) || null, disclosed: ns.selected_comp_anchor.previously_disclosed === true } : null } : null,
    economics,
    history: history.slice(0, 40),
    valuationHistory: snapshots.map((s) => ({ at: s.computed_at, low: pos(s.valuation_low), mid: pos(s.valuation_mid), high: pos(s.valuation_high), offer: pos(s.recommended_cash_offer), tier: TIER_META[clean(s.decision_tier)]?.label || humanize(s.decision_tier), comps: num(s.selected_comp_count) })).reverse(),
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
