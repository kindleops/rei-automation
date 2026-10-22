// The CFO's independent review (docs/WORKFORCE.md §4.1 finance.review_opportunity). Pure.
//
// Input: the Decision Engine read (intel.acquisition_decision output shape, re-read by the CFO itself
// when it can) and, optionally, the acquisitions view of the same opportunity (an upstream output or a
// proposal: a claimed MAO, a proposed number, a thesis). Output: a verdict
//   supported | challenge | insufficient_evidence
// with machine reasons. "supported" requires POSITIVE evidence on every check (authoritative MAO,
// spendable valuation, offer-ready row, enough fresh comps, confidence) — it is never the default.
// The CFO never adopts a number it cannot trace to the engine: an acquisitions figure the engine
// does not back is a challenge, not an input.

export const CFO_REVIEW_VERSION = 'cfo-review.v1'
export const CFO_THRESHOLDS = Object.freeze({
  min_comps: 5, // = MAD_MIN_COMP_COUNT: below it the valuation needs a contamination defense
  max_median_comp_age_months: 12,
  max_dispersion: 0.35,
  max_decision_age_days: 30,
  min_confidence: 0.6,
  ask_above_mao_note: 0.10,
  ask_far_above_mao: 0.25,
  claimed_mao_tolerance: 0.02,
})
export const CFO_VERDICTS = Object.freeze(['supported', 'challenge', 'insufficient_evidence'])

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const p = (v) => { const x = n(v); return x != null && x > 0 ? x : null }

/**
 * @param {{ decision: object|null, acquisitions?: object|null, thresholds?: object }} o
 * @returns {{ version, verdict, reasons: string[], supports: string[], notes: string[], figures: object }}
 */
export function reviewOpportunity({ decision = null, acquisitions = null, thresholds = CFO_THRESHOLDS } = {}) {
  const T = { ...CFO_THRESHOLDS, ...thresholds }
  const insufficient = []
  const challenge = []
  const supports = []
  const notes = []
  const d = decision && typeof decision === 'object' ? decision : null
  const figures = { mao: null, ask: null, ask_vs_mao: null, comps: null, confidence: null, decision_age_days: null }

  if (!d || d.status === 'not_run') {
    insufficient.push('NO_DECISION')
    return finish()
  }
  const mao = p(d.mao)
  figures.mao = mao
  if (mao == null) insufficient.push('NO_AUTHORITATIVE_MAO')
  else supports.push('AUTHORITATIVE_MAO')

  if (d.spendability?.spendable === true) supports.push('VALUATION_SPENDABLE')
  else challenge.push(`VALUATION_NOT_SPENDABLE:${d.spendability?.reason || 'unknown'}`)

  if (d.offer_ready?.ready === true) supports.push('OFFER_READY')
  else (['score_stale', 'score_predates_current_policy'].includes(d.offer_ready?.reason) ? challenge : notes).push(`OFFER_NOT_READY:${d.offer_ready?.reason || 'unknown'}`)

  const age = n(d.age_days)
  figures.decision_age_days = age
  if (age == null) insufficient.push('DECISION_AGE_UNKNOWN')
  else if (age > T.max_decision_age_days) challenge.push('STALE_DECISION')
  else supports.push('DECISION_FRESH')

  const comps = d.comps || {}
  const count = n(comps.selected)
  figures.comps = { selected: count, median_age_months: n(comps.median_age_months), dispersion: n(comps.dispersion) }
  if (count == null) insufficient.push('COMP_EVIDENCE_UNKNOWN')
  else if (count === 0) insufficient.push('NO_COMP_EVIDENCE')
  else if (count < T.min_comps) challenge.push('THIN_COMP_EVIDENCE')
  else supports.push('COMP_COUNT_OK')
  const age_m = n(comps.median_age_months)
  if (count && age_m == null) notes.push('COMP_RECENCY_UNKNOWN')
  else if (age_m != null && age_m > T.max_median_comp_age_months) challenge.push('STALE_COMP_EVIDENCE')
  else if (age_m != null) supports.push('COMPS_RECENT')
  const disp = n(comps.dispersion)
  if (disp != null && disp > T.max_dispersion) challenge.push('WIDE_COMP_DISPERSION')

  const conf = n(d.confidence)
  figures.confidence = conf
  if (conf == null) insufficient.push('CONFIDENCE_UNKNOWN')
  else if (conf < T.min_confidence) challenge.push('LOW_CONFIDENCE')
  else supports.push('CONFIDENCE_OK')

  if (d.asset_identity_conflict) challenge.push('ASSET_IDENTITY_CONFLICT')

  const ask = p(d.ask ?? acquisitions?.ask)
  figures.ask = ask
  if (ask != null && mao != null) {
    const gap = Math.round(((ask - mao) / mao) * 1000) / 1000
    figures.ask_vs_mao = gap
    if (gap > T.ask_far_above_mao) challenge.push('ASK_FAR_ABOVE_MAO')
    else if (gap > T.ask_above_mao_note) notes.push('ASK_ABOVE_MAO')
    else supports.push('ASK_WITHIN_MAO_RANGE')
  } else if (ask == null) notes.push('ASK_UNKNOWN')

  // the acquisitions view is checked, never adopted
  const acq = acquisitions && typeof acquisitions === 'object' ? acquisitions : null
  if (acq) {
    const claimed = p(acq.claimed_mao)
    if (claimed != null && mao == null) challenge.push('ACQ_MAO_WITHOUT_ENGINE_AUTHORITY')
    else if (claimed != null && Math.abs(claimed - mao) / mao > T.claimed_mao_tolerance) challenge.push('ACQ_MAO_DISAGREES_WITH_ENGINE')
    const proposed = p(acq.proposed_offer)
    if (proposed != null && mao == null) challenge.push('ACQ_NUMBER_WITHOUT_AUTHORITATIVE_MAO')
    else if (proposed != null && proposed > mao) challenge.push('ACQ_PROPOSAL_ABOVE_MAO')
    const spread = n(acq.claimed_spread_usd)
    if (spread != null && (d.expected_assignment_fee == null || spread > d.expected_assignment_fee)) challenge.push('ACQ_SPREAD_NOT_BACKED_BY_ENGINE')
    if (acq.claimed_confidence != null && conf != null && Number(acq.claimed_confidence) > conf + 0.1) challenge.push('ACQ_CONFIDENCE_OVERSTATED')
    if (['strong', 'high', 'excellent', 'hot', 'great'].includes(String(acq.thesis || '').toLowerCase()) && (insufficient.length || challenge.length)) notes.push('ACQ_THESIS_NOT_SUPPORTED_BY_EVIDENCE')
  }
  return finish()

  function finish() {
    const verdict = insufficient.includes('NO_DECISION') || insufficient.includes('NO_AUTHORITATIVE_MAO') || insufficient.includes('NO_COMP_EVIDENCE')
      ? 'insufficient_evidence'
      : challenge.length ? 'challenge' : insufficient.length ? 'insufficient_evidence' : 'supported'
    return Object.freeze({ version: CFO_REVIEW_VERSION, verdict, reasons: [...insufficient, ...challenge], supports, notes, figures })
  }
}
