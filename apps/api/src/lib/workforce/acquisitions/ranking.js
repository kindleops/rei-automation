// Opportunity ranking (acq.rank_opportunities). Pure.
//
// The owner's ranking hierarchy (binding): CONTACT / IDENTITY first, then PRESSURE, then DEAL QUALITY.
// The comparison is lexicographic over the three levels, so no amount of deal quality outranks a
// better contact/identity position. Within a level, a KNOWN value outranks an UNKNOWN one (we prefer
// what we can verify), and an unknown is carried as unknown — it is never coerced to 0 or 100.
//
// Expected value: EV = P(close) × risk-adjusted net, ONLY when calibrated inputs exist:
//   • P(close) from a calibration source (calibrated === true, a real sample behind it), and
//   • the net from the Decision Engine (its expected assignment fee on an authoritative row), with the
//     calibration's own risk haircut when it supplies one.
// Otherwise EV = { value: null, status: 'unknown', missing: [...] }. There is NO fixed-spread fallback
// (no "ARV × 70% − repairs − ask", no assumed fee): an absent input stays absent.

export const RANKING_VERSION = 'acq-ranking.v1'
export const CALIBRATION_MIN_SAMPLE = 30
const STAGES = ['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract']
const INTEREST = new Set(['seller_interested', 'latent_interest', 'asks_offer', 'asking_price_provided', 'condition_disclosed', 'callback_requested', 'contract_requested', 'need_time'])
const OFFER_REQUEST = new Set(['asks_offer', 'contract_requested'])
const VERDICT_SCORE = { supported: 2, challenge: 1, insufficient_evidence: 0 }

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const known = (v) => v !== null && v !== undefined

/**
 * Contact / identity: can we lawfully reach the right person, and do we know it is the owner?
 *   null  = unknown (no conversation read)
 *   0     = not permitted (suppressed / ineligible) — such a row should already be excluded
 *   1..3  = permitted; +1 a verified ownership-or-later stage, +1 the seller has engaged
 */
export function contactIdentityScore(conv) {
  if (!conv) return { value: null, status: 'unknown', basis: ['no_conversation_read'] }
  if (conv.contact_permitted === false || conv.suppressed === true || conv.held === true) return { value: 0, status: 'known', basis: ['contact_not_permitted'] }
  if (conv.contact_permitted == null) return { value: null, status: 'unknown', basis: ['contact_permission_unknown'] }
  const basis = ['contact_permitted']
  let v = 1
  const st = conv.action?.verified_stage
  if (conv.action?.stage_verified && STAGES.indexOf(st) >= 0) { v += 1; basis.push(`verified_stage:${st}`) }
  if (conv.last_inbound_at) { v += 1; basis.push('seller_engaged') }
  return { value: v, status: 'known', basis }
}

/** Pressure: is the seller waiting on us, asking for a number, deep in the funnel, recent? (0..6, null when unknown) */
export function pressureScore(conv, candidate = {}, now = Date.now()) {
  if (!conv && !candidate) return { value: null, status: 'unknown', basis: [] }
  const basis = []
  let v = 0
  let signals = 0
  const waiting = conv?.seller_spoke_last ?? candidate.seller_spoke_last
  if (waiting != null) { signals += 1; if (waiting) { v += 2; basis.push('seller_waiting') } }
  const intent = candidate.intent || null
  if (intent) { signals += 1; if (OFFER_REQUEST.has(intent)) { v += 2; basis.push('offer_requested') } else if (INTEREST.has(intent)) { v += 1; basis.push('interest_on_record') } }
  const stage = conv?.action?.verified_stage || candidate.stage
  if (stage) { signals += 1; const r = STAGES.indexOf(stage); if (r >= 2) { v += 1; basis.push(`stage:${stage}`) } }
  const lastIn = Date.parse(conv?.last_inbound_at || candidate.last_inbound_at || '')
  if (Number.isFinite(lastIn)) { signals += 1; if (now - lastIn < 7 * 86_400_000) { v += 1; basis.push('inbound_within_7d') } }
  if (conv?.action?.lost) basis.push('lost_conversation')
  return signals ? { value: v, status: 'known', basis } : { value: null, status: 'unknown', basis: ['no_pressure_signals'] }
}

/**
 * Deal quality: the CFO verdict (supported > challenge > insufficient_evidence); the engine's confidence
 * only orders within one verdict. No verdict (not reviewed, escalated, refused) ⇒ unknown — never 0.
 */
export function dealQualityScore(decision, cfo) {
  const verdict = cfo?.verdict || null
  const vs = verdict ? VERDICT_SCORE[verdict] : null
  if (vs == null) return { value: null, status: 'unknown', basis: [verdict ? `cfo:${verdict}` : 'cfo:no_verdict'] }
  const conf = n(decision?.confidence)
  const value = vs * 10 + (conf ?? 0)
  return { value: Math.round(value * 1000) / 1000, status: 'known', basis: [`cfo:${verdict}`, conf == null ? 'confidence:unknown' : `confidence:${conf}`] }
}

/** EV only from calibrated inputs; otherwise unknown with what is missing. Never a fixed spread. */
export function expectedValue({ decision = null, calibration = null } = {}) {
  const missing = []
  const cal = calibration && typeof calibration === 'object' ? calibration : null
  const p = n(cal?.p_close)
  if (!cal || cal.calibrated !== true || p == null || p < 0 || p > 1 || !(n(cal.sample) >= CALIBRATION_MIN_SAMPLE)) missing.push('calibrated_p_close')
  const net = n(decision?.expected_assignment_fee)
  const authoritative = decision?.offer_ready?.ready === true && n(decision?.mao) != null
  if (net == null || net <= 0) missing.push('engine_expected_net')
  else if (!authoritative) missing.push('authoritative_decision_row')
  if (missing.length) return { value: null, status: 'unknown', missing }
  const haircut = n(cal.risk_haircut)
  const riskAdjusted = haircut != null && haircut >= 0 && haircut < 1 ? net * (1 - haircut) : net
  return {
    value: Math.round(p * riskAdjusted),
    status: 'known',
    basis: { p_close: p, sample: n(cal.sample), calibration_source: String(cal.source || 'calibration').slice(0, 60), net_source: 'engine.expected_assignment_fee', net, risk_haircut: haircut ?? null },
  }
}

/** -1 when a ranks above b. Known beats unknown; higher beats lower; ties fall to the next level. */
function compareLevel(a, b) {
  if (known(a.value) && !known(b.value)) return -1
  if (!known(a.value) && known(b.value)) return 1
  if (known(a.value) && known(b.value) && a.value !== b.value) return b.value - a.value
  return 0
}

/**
 * @param {Array<{ property_ref, opportunity_id?, conversation_id?, market?, candidate?, conv?, decision?, cfo?, calibration? }>} items
 * @returns {{ version, ranked: object[], excluded: object[] }}
 */
export function rankOpportunities(items = [], { now = Date.now(), n: top = null } = {}) {
  const scored = []
  const excluded = []
  for (const it of items) {
    if (!it?.property_ref) continue
    const ci = contactIdentityScore(it.conv)
    if (ci.status === 'known' && ci.value === 0) { excluded.push({ property_ref: it.property_ref, reason: 'contact_not_permitted' }); continue }
    if (it.conv?.excluded) { excluded.push({ property_ref: it.property_ref, reason: String(it.conv.excluded).toLowerCase() }); continue }
    const pr = pressureScore(it.conv, it.candidate || {}, now)
    const dq = dealQualityScore(it.decision, it.cfo)
    const ev = expectedValue({ decision: it.decision, calibration: it.calibration })
    scored.push({ property_ref: it.property_ref, opportunity_id: it.opportunity_id ?? null, conversation_id: it.conversation_id ?? null, market: it.market ?? null, components: { contact_identity: ci, pressure: pr, deal_quality: dq }, ev, cfo_verdict: it.cfo?.verdict ?? null, refs: it.refs || {} })
  }
  scored.sort((a, b) => compareLevel(a.components.contact_identity, b.components.contact_identity) || compareLevel(a.components.pressure, b.components.pressure) || compareLevel(a.components.deal_quality, b.components.deal_quality) || (a.property_ref < b.property_ref ? -1 : 1))
  const ranked = scored.map((s, i) => ({ rank: i + 1, ...s }))
  return { version: RANKING_VERSION, method: 'lexicographic(contact_identity > pressure > deal_quality); known > unknown within a level', ranked: top ? ranked.slice(0, top) : ranked, considered: scored.length, excluded }
}
