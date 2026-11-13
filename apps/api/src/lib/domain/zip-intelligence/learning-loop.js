// ─── ACQUISITION LEARNING LOOP (8.5.20-b) ────────────────────────────────────
// What happened on every deal we worked — asking price, our recommended / opening
// offers, counters, final price, condition, buyer demand, the actual economics, the
// closing outcome, time to close and failure reasons — recorded per opportunity
// (public.acquisition_outcomes in the PROPOSED schema).
//
// ONLY VALIDATED TRANSACTION OUTCOMES FEED A MODEL UPDATE. A row is training-eligible
// when validation_status = 'validated' with a validator (operator) and a closing-grade
// source (closing case, settlement statement, recorded deed, title confirmation). A
// seller's chat claim, a model extraction or an unverified operator note is recorded
// but NEVER trains (acceptForTraining). The DB re-checks this (CHECK + the training view).
//
// Model versions carry their sample size, confidence and the prediction error measured
// on validated outcomes BEFORE the update (no in-sample error).
import { ZIP_MODEL_RULES } from './zip-model.js'

export const LEARNING_VERSION = 'acq-learning.v1'
export const CLOSING_OUTCOMES = Object.freeze(['closed_assigned', 'closed_purchased', 'cancelled_by_seller', 'cancelled_by_us', 'lost_to_competitor', 'no_contract', 'pending'])
export const VALIDATION_STATUSES = Object.freeze(['unverified', 'validated', 'rejected'])
export const VALIDATION_SOURCES = Object.freeze(['closing_case', 'settlement_statement', 'recorded_deed', 'title_company_confirmation'])
export const UNTRUSTED_ORIGINS = Object.freeze(['seller_chat', 'model_extracted', 'operator_note_unverified', 'web'])

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000)

/** Shape check for an outcome record (what may be stored at all). */
export function validateOutcome(o = {}) {
  const errors = []
  if (!String(o.opportunity_id || '').trim() && !String(o.property_id || '').trim()) errors.push('opportunity_or_property_required')
  if (!CLOSING_OUTCOMES.includes(o.closing_outcome)) errors.push('closing_outcome:enum')
  if (!VALIDATION_STATUSES.includes(o.validation_status || 'unverified')) errors.push('validation_status:enum')
  for (const k of ['asking_price', 'recommended_offer', 'opening_offer', 'final_price']) if (o[k] != null && !(pos(o[k]))) errors.push(`${k}:positive_or_null`)
  if (o.counters != null && !Array.isArray(o.counters)) errors.push('counters:array')
  if (o.failure_reasons != null && !Array.isArray(o.failure_reasons)) errors.push('failure_reasons:array')
  if (o.validation_status === 'validated') {
    if (!String(o.validated_by || '').trim()) errors.push('validated_by:required_when_validated')
    if (!VALIDATION_SOURCES.includes(o.validation_source)) errors.push('validation_source:closing_grade_required')
    if (UNTRUSTED_ORIGINS.includes(o.origin)) errors.push('origin:untrusted_cannot_be_validated')
    if (['closed_assigned', 'closed_purchased'].includes(o.closing_outcome) && !pos(o.final_price)) errors.push('final_price:required_for_a_closed_outcome')
  }
  return { ok: errors.length === 0, errors }
}

/** May this outcome update a model? Only validated, closing-grade, trusted-origin rows. */
export function acceptForTraining(o = {}) {
  const v = validateOutcome(o)
  if (!v.ok) return { accepted: false, reason: v.errors[0] }
  if (o.validation_status !== 'validated') return { accepted: false, reason: `not_validated:${o.validation_status || 'unverified'}` }
  if (UNTRUSTED_ORIGINS.includes(o.origin)) return { accepted: false, reason: `untrusted_origin:${o.origin}` }
  if (o.closing_outcome === 'pending') return { accepted: false, reason: 'outcome_pending' }
  return { accepted: true, reason: 'validated_closing_grade' }
}

/**
 * Prediction error of a cell set on validated outcomes (measured BEFORE any update).
 * An outcome contributes when it closed with a final price and carries the retail
 * reference (value at contract) and its cell key.
 * @returns {{ n:number, mae:number|null, bias:number|null }}
 */
export function predictionError(cells = [], outcomes = []) {
  const errs = []
  for (const o of outcomes) {
    if (!acceptForTraining(o).accepted) continue
    const ref = pos(o.retail_reference_value)
    const fin = pos(o.final_price)
    if (!ref || !fin || !['closed_assigned', 'closed_purchased'].includes(o.closing_outcome)) continue
    const c = cells.find((x) => x.zip5 === o.zip5 && x.property_type === o.property_type && x.condition_band === (o.condition_band || 'all') && x.value_band === (o.value_band || 'all'))
    if (!c || c.investor_discount_vs_retail == null) continue
    const actual = 1 - fin / ref
    errs.push(actual - c.investor_discount_vs_retail)
  }
  if (!errs.length) return { n: 0, mae: null, bias: null }
  return { n: errs.length, mae: r4(errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length), bias: r4(errs.reduce((s, e) => s + e, 0) / errs.length) }
}

/**
 * Apply validated outcomes to the cells: each eligible outcome is one observation of
 * the investor discount in its cell (posterior = weighted by the cell's own evidence +
 * the validated outcomes; validated outcomes weigh OUTCOME_WEIGHT observations each).
 * Returns the new cells and the version record (sample size, confidence, error measured
 * on the PRE-update cells).
 */
export const OUTCOME_WEIGHT = 3
export function applyValidatedOutcomes(cells = [], outcomes = [], { prior_version = null, now = Date.now() } = {}) {
  const accepted = []
  const refused = {}
  for (const o of outcomes) {
    const a = acceptForTraining(o)
    if (a.accepted) accepted.push(o)
    else refused[a.reason] = (refused[a.reason] || 0) + 1
  }
  const error = predictionError(cells, accepted)
  const next = cells.map((c) => {
    const mine = accepted.filter((o) => o.zip5 === c.zip5 && o.property_type === c.property_type && (o.condition_band || 'all') === c.condition_band && (o.value_band || 'all') === c.value_band && pos(o.final_price) && pos(o.retail_reference_value))
    if (!mine.length || c.investor_discount_vs_retail == null) return c
    const n0 = Math.max(1, Math.min(num(c.investor_ratio_n) ?? 0, num(c.retail_ratio_n) ?? 0))
    const obs = mine.map((o) => 1 - o.final_price / o.retail_reference_value)
    const w = mine.length * OUTCOME_WEIGHT
    const est = (n0 * c.investor_discount_vs_retail + w * (obs.reduce((s, x) => s + x, 0) / obs.length)) / (n0 + w)
    return { ...c, investor_discount_vs_retail: r4(est), validated_outcomes_n: (num(c.validated_outcomes_n) ?? 0) + mine.length }
  })
  const nowIso = new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString()
  const version = {
    model_version: `${LEARNING_VERSION}@${nowIso.slice(0, 19).replace(/[-:T]/g, '')}`,
    parent_version: prior_version,
    built_at: nowIso,
    sample_size: next.reduce((s, c) => s + (num(c.sample_size) ?? 0), 0),
    validated_outcomes_n: accepted.length,
    refused_outcomes: refused,
    confidence: next.length ? r4(next.reduce((s, c) => s + (num(c.confidence) ?? 0), 0) / next.length) : 0,
    prediction_error: { measured_on: 'validated_outcomes_before_update', ...error },
    rules: { outcome_weight: OUTCOME_WEIGHT, prior_strength: ZIP_MODEL_RULES.prior_strength },
    status: 'shadow',
  }
  return { cells: next, version }
}
