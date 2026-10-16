// ─── NEGOTIATION ENVELOPE (8.5.19, owner directive 2026-10-15 Phase 8) ────────
// The exact, operator-granted authority for ONE scope (thread + property):
//   max_price                 the most the engine may ever put to this seller
//   opening_price             where it opens (≤ max; "open below range")
//   max_moves                 how many priced moves the engine may make under it
//   closing window            [closing_window_min_days, closing_window_max_days]
//   earnest money             [earnest_money_min, earnest_money_max]
//   as_is                     we buy as-is (a seller asking us to repair is outside authority)
//   closing_costs_paid_by     buyer | seller | split
//   expires_at                ≤ 30 days after valid_from
//   granted_by + approval_id  the operator and the agent.approval_request that granted it
//
// IMMUTABLE AND VERSIONED: a change is a new version superseding the last (the
// PROPOSED table refuses UPDATE / DELETE). Nothing here prices: the PROPOSED
// envelope offered to the operator is built from the Decision Engine's own
// authoritative MAO and recommended offer; without them the proposal carries no
// price and says the operator must price it.
import { hashCanonical, sha256Hex } from '../../agent/runtime/canonical.js'
import { SELLER_OFFER_POLICY_V1 } from '../seller-flow/seller-offer-policy.js'
import { roundAnchorDown } from '../seller-flow/seller-autopilot-v2.js'
import { threadRef } from '../conversation-ai/pii.js'

export const ENVELOPE_CONTRACT_VERSION = 'negotiation.envelope.v1'
export const ENVELOPE_MAX_TTL_DAYS = 30
export const ENVELOPE_DEFAULT_TTL_DAYS = 7
export const ENVELOPE_DEFAULT_MAX_MOVES = 3
export const CLOSING_COST_PAYERS = Object.freeze(['buyer', 'seller', 'split'])

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const clean = (v) => String(v ?? '').trim()

/** Scope identity. Thread keys are phone numbers: only this hash and threadRef() are ever stored. */
export function scopeKey(thread_key, property_id) {
  const t = clean(thread_key)
  const p = clean(property_id)
  if (!t || !p) throw Object.assign(new Error('SCOPE_REQUIRED'), { code: 'SCOPE_REQUIRED' })
  return `nscope_${sha256Hex(`${t}|${p}`)}`
}

export function scopeOf({ thread_key, property_id, opportunity_id = null } = {}) {
  return { scope_key: scopeKey(thread_key, property_id), thread_ref: threadRef(thread_key), property_id: clean(property_id), opportunity_id: opportunity_id || null }
}

/** The fields that define what the operator granted (hashed; the hash is shown on approval). */
export function envelopeTerms(e = {}) {
  return {
    max_price: num(e.max_price),
    opening_price: num(e.opening_price),
    max_moves: num(e.max_moves) ?? ENVELOPE_DEFAULT_MAX_MOVES,
    closing_window_min_days: num(e.closing_window_min_days),
    closing_window_max_days: num(e.closing_window_max_days),
    earnest_money_min: num(e.earnest_money_min),
    earnest_money_max: num(e.earnest_money_max),
    as_is: e.as_is !== false,
    closing_costs_paid_by: clean(e.closing_costs_paid_by) || null,
    expires_at: e.expires_at ? new Date(e.expires_at).toISOString() : null,
  }
}

export function envelopeHash(e = {}) {
  return hashCanonical({ v: ENVELOPE_CONTRACT_VERSION, scope_key: e.scope_key || null, terms: envelopeTerms(e) })
}

/** Same rules as the PROPOSED table's CHECKs (the DB re-checks). */
export function validateEnvelope(e = {}, { now = Date.now() } = {}) {
  const errors = []
  const t = envelopeTerms(e)
  if (!(t.max_price > 0 && t.max_price < 1e9)) errors.push('max_price:required_positive')
  if (t.opening_price != null && !(t.opening_price > 0 && t.opening_price <= (t.max_price ?? 0))) errors.push('opening_price:must_be_le_max')
  if (!(Number.isInteger(t.max_moves) && t.max_moves >= 1 && t.max_moves <= 10)) errors.push('max_moves:1_to_10')
  if (!(Number.isInteger(t.closing_window_min_days) && t.closing_window_min_days >= 1 && t.closing_window_min_days <= 365)) errors.push('closing_window_min_days:1_to_365')
  if (!(Number.isInteger(t.closing_window_max_days) && t.closing_window_max_days >= (t.closing_window_min_days ?? 1) && t.closing_window_max_days <= 365)) errors.push('closing_window_max_days:ge_min_le_365')
  if (!(t.earnest_money_min >= 0)) errors.push('earnest_money_min:required')
  if (!(t.earnest_money_max >= (t.earnest_money_min ?? 0) && t.earnest_money_max <= (t.max_price ?? 0))) errors.push('earnest_money_max:ge_min_le_max_price')
  if (!CLOSING_COST_PAYERS.includes(t.closing_costs_paid_by)) errors.push('closing_costs_paid_by:enum')
  const from = Date.parse(e.valid_from || new Date(now).toISOString())
  const exp = Date.parse(t.expires_at || '')
  if (!Number.isFinite(exp) || exp <= from || exp > from + ENVELOPE_MAX_TTL_DAYS * 864e5) errors.push('expires_at:within_30_days')
  return errors.length ? { ok: false, errors } : { ok: true, terms: t }
}

/**
 * Is this envelope live for this scope right now?
 * @returns {{ live: boolean, reason: string }}
 *   reasons: live | no_envelope | scope_mismatch | revoked | superseded | not_yet_valid | expired | invalid
 */
export function envelopeStatus(env, { scope_key, now = Date.now(), revoked = false, latest_version = null } = {}) {
  if (!env) return { live: false, reason: 'no_envelope' }
  if (scope_key && env.scope_key !== scope_key) return { live: false, reason: 'scope_mismatch' }
  if (revoked || env.revoked === true) return { live: false, reason: 'revoked' }
  if (latest_version != null && Number(env.version) < Number(latest_version)) return { live: false, reason: 'superseded' }
  const t = typeof now === 'number' ? now : Date.parse(now)
  if (env.valid_from && t < Date.parse(env.valid_from)) return { live: false, reason: 'not_yet_valid' }
  if (!(t < Date.parse(env.expires_at))) return { live: false, reason: 'expired' }
  if (!(num(env.max_price) > 0)) return { live: false, reason: 'invalid' }
  return { live: true, reason: 'live' }
}

/** Creative / structured terms are never inside a cash envelope. */
const CREATIVE_TERMS = Object.freeze(['seller_financing', 'subject_to', 'lease_option', 'novation', 'owner_carry', 'installments', 'leaseback', 'rent_back'])

/**
 * Seller-requested non-price terms vs the envelope.
 * @param {{ closing_days?: number, earnest_money?: number, as_is?: boolean, repairs_by_buyer_before_close?: boolean,
 *           closing_costs_paid_by?: string, structure?: string, contingencies?: string[] }} req
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function termsWithinEnvelope(req = {}, env = {}) {
  const v = []
  const t = envelopeTerms(env)
  const days = num(req.closing_days)
  if (days != null && (days < t.closing_window_min_days || days > t.closing_window_max_days)) v.push('closing_window_outside_authority')
  const emd = num(req.earnest_money)
  if (emd != null && (emd < t.earnest_money_min || emd > t.earnest_money_max)) v.push('earnest_money_outside_authority')
  if (t.as_is && (req.as_is === false || req.repairs_by_buyer_before_close === true)) v.push('repairs_requested_but_authority_is_as_is')
  const payer = clean(req.closing_costs_paid_by).toLowerCase()
  if (payer && payer !== t.closing_costs_paid_by && !(t.closing_costs_paid_by === 'buyer' && (payer === 'split' || payer === 'seller'))) v.push('closing_costs_outside_authority')
  const structure = clean(req.structure).toLowerCase()
  if (structure && structure !== 'cash') v.push(CREATIVE_TERMS.includes(structure) ? `creative_structure_requested:${structure}` : 'non_cash_structure_requested')
  if (Array.isArray(req.contingencies) && req.contingencies.length) v.push('contingencies_requested')
  return { ok: v.length === 0, violations: v }
}

/** The underwriting a grant is bound to: if any of this moves, the grant no longer speaks for the deal. */
export function underwritingBasis(economics = null) {
  const m = economics?.metrics || {}
  return {
    valuation_snapshot_id: economics?.evidence?.valuation_snapshot_id ?? null,
    computed_at: economics?.evidence?.computed_at ?? null,
    lane: m.lane ?? null,
    realistic_value_mid: m.realistic_value?.mid ?? null,
    mao: m.mao ?? null,
    economics_class: economics?.class ?? null,
  }
}
export function underwritingHash(economics) {
  const b = underwritingBasis(economics)
  // the class is advisory; the hash binds the numbers and the snapshot
  return hashCanonical({ v: 1, valuation_snapshot_id: b.valuation_snapshot_id, computed_at: b.computed_at, lane: b.lane, mid: b.realistic_value_mid, mao: b.mao })
}

/**
 * The envelope PROPOSED to the operator (never a grant). Prices only from the
 * engine's own authority: max = authoritative MAO, opening = the engine's
 * recommended offer floored with the V2 anchor rounding ("open below range").
 * Terms = SELLER_OFFER_POLICY_V1 exactly (no invented values); the operator edits.
 */
export function buildProposedEnvelope({ economics = null, thread_key, property_id, opportunity_id = null, now = Date.now(), recommended_offer = null } = {}) {
  const scope = scopeOf({ thread_key, property_id, opportunity_id })
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  const cls = economics?.class || 'INVESTIGATE'
  const mao = num(economics?.metrics?.mao)
  const rec = num(recommended_offer ?? economics?.metrics?.recommended_offer)
  const opening = mao && rec ? Math.min(roundAnchorDown(Math.min(rec, mao)) ?? null, mao) : null
  const recommendation = cls === 'PASS' ? 'do_not_grant' : !mao ? 'operator_must_price' : cls === 'HOT' || cls === 'NEGOTIATE' ? 'grant' : 'grant_not_recommended'
  const p = SELLER_OFFER_POLICY_V1
  const proposal = {
    contract_version: ENVELOPE_CONTRACT_VERSION,
    ...scope,
    max_price: recommendation === 'do_not_grant' ? null : mao,
    opening_price: recommendation === 'do_not_grant' ? null : opening,
    max_moves: ENVELOPE_DEFAULT_MAX_MOVES,
    closing_window_min_days: p.closing_window_days,
    closing_window_max_days: p.closing_window_days,
    earnest_money_min: p.earnest_money_amount,
    earnest_money_max: p.earnest_money_amount,
    as_is: true,
    closing_costs_paid_by: 'buyer',
    valid_from: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ENVELOPE_DEFAULT_TTL_DAYS * 864e5).toISOString(),
    policy_version: p.policy_version,
  }
  return {
    operator_only: true,
    recommendation,
    proposal,
    underwriting: {
      basis: underwritingBasis(economics),
      hash: underwritingHash(economics),
      economics_class: cls,
      reasons: economics?.reasons || [],
      uncertainty: economics?.uncertainty || null,
      metrics: economics?.metrics ? {
        ask: economics.metrics.ask, mao: economics.metrics.mao, realistic_value: economics.metrics.realistic_value,
        price_gap: economics.metrics.price_gap, assignment_margin: economics.metrics.assignment_margin,
        buyer_demand: economics.metrics.buyer_demand?.level ?? null, execution: economics.metrics.execution,
      } : null,
    },
  }
}

/** Row for public.negotiation_envelopes from an APPROVED grant (approval id + operator required). */
export function buildEnvelopeRow({ grant, scope, version, supersedes_envelope_id = null, approval_id, granted_by, underwriting, underwriting_hash, now = Date.now() }) {
  if (!/^apr_[0-9a-f-]{36}$/.test(String(approval_id || ''))) throw Object.assign(new Error('APPROVAL_ID_REQUIRED'), { code: 'APPROVAL_ID_REQUIRED' })
  if (!clean(granted_by)) throw Object.assign(new Error('GRANTED_BY_REQUIRED'), { code: 'GRANTED_BY_REQUIRED' })
  const row = {
    contract_version: ENVELOPE_CONTRACT_VERSION,
    scope_key: scope.scope_key,
    version,
    thread_ref: scope.thread_ref,
    property_id: scope.property_id,
    opportunity_id: scope.opportunity_id || null,
    ...envelopeTerms(grant),
    valid_from: grant.valid_from || new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString(),
    granted_by: clean(granted_by),
    approval_id,
    supersedes_envelope_id,
    underwriting: underwriting || {},
    underwriting_hash,
  }
  const v = validateEnvelope(row, { now })
  if (!v.ok) throw Object.assign(new Error('ENVELOPE_INVALID'), { code: 'ENVELOPE_INVALID', errors: v.errors })
  return { ...row, envelope_hash: envelopeHash(row) }
}
