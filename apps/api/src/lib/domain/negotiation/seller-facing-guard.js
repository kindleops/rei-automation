// ─── SELLER-FACING GUARD (8.5.20-b) ──────────────────────────────────────────
// The ceiling (MAO / envelope max), the target, margins, comps and the offer plan are
// INTERNAL reasoning. Two enforcement points on the negotiation interface output:
//
//   composerView(position)   the ONLY projection of a position the conversation composer
//                            may read: status, the authorised move kind + amount, allowed
//                            terms and forbidden claims. No proposed envelope, no economics
//                            metrics, no justification, no plan, no envelope max.
//
//   checkSellerFacingText(text, { position, internal })
//                            refuses a draft that states any internal number (ceiling,
//                            envelope max, target, value, margin) other than the authorised
//                            move amount, any dollar amount without authority, ceiling
//                            language ("our max", "the most we can pay", "MAO" …) or comp detail.
//
// A refusal is a hold for a human, never a rewrite.
import { FORBIDDEN_CLAIMS } from './position.js'

export const SELLER_GUARD_VERSION = 'seller-facing-guard.v1'

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Dollar amounts stated in free text: "$150,000", "150k", "$1.2M", "150 thousand", "$150K". */
export function extractMoneyAmounts(text) {
  const s = String(text || '')
  const out = []
  const re = /\$?\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k|thousand|m|mil|million)?\b/gi
  for (const m of s.matchAll(re)) {
    const hasDollar = m[0].trim().startsWith('$')
    const unit = String(m[2] || '').toLowerCase()
    let n = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(n)) continue
    if (unit === 'k' || unit === 'thousand') n *= 1_000
    else if (unit === 'm' || unit === 'mil' || unit === 'million') n *= 1_000_000
    // bare small numbers (days, beds, years) are not money unless marked
    if (!hasDollar && !unit && n < 10_000) continue
    if (!hasDollar && !unit && n >= 1900 && n <= 2100) continue
    out.push(Math.round(n))
  }
  return out
}

const CEILING_LANGUAGE_RE = /\b(mao|max(imum)? allowable|our (ceiling|cap|max(imum)?|limit|top (dollar|number|price))|(the )?(most|highest|max(imum)?) (we|i) (can|could|would|will|are able to) (go|pay|do|offer)|walk[- ]?away (price|number)|absolute (top|max)|budget (is|of|tops out))\b/i
const COMP_DETAIL_RE = /\b(comps?|comparables?|comparable sales|(houses?|homes?|propert(y|ies)|ones?|places?) (down the street |nearby |next door |around here |in the area )?(sold|went|closed) for|recent(ly)? sold (at|for))\b/i

/** Internal numbers a position / plan / economics carry (never seller-facing). */
export function internalNumbers({ position = null, plan = null, economics = null, envelope = null } = {}) {
  const out = new Map()
  const add = (k, v) => { const n = num(v); if (n != null && n > 0) out.set(`${k}`, Math.round(n)) }
  add('envelope_max', envelope?.max_price)
  add('proposed_max', position?.proposed_envelope?.proposal?.max_price)
  add('engine_mao', economics?.metrics?.mao ?? position?.economics?.metrics?.mao)
  add('engine_target', economics?.metrics?.recommended_offer)
  add('value_mid', economics?.metrics?.realistic_value?.mid)
  add('buyer_exit', economics?.metrics?.assignment_margin?.buyer_exit)
  add('plan_ceiling', plan?.mao?.amount)
  add('plan_target', plan?.target?.amount)
  add('plan_review_above', plan?.escalation?.review_above)
  add('plan_as_is', plan?.reconciliation?.as_is_value)
  return out
}

/**
 * @param {string} text  the draft the composer wants to send
 * @param {{ position?: object, plan?: object, economics?: object, envelope?: object, tolerance_usd?: number }} ctx
 * @returns {{ ok: boolean, violations: string[], amounts: number[] }}
 */
export function checkSellerFacingText(text, { position = null, plan = null, economics = null, envelope = null, tolerance_usd = 500 } = {}) {
  const violations = []
  const amounts = extractMoneyAmounts(text)
  const allowed = position?.status === 'within_authority' ? num(position?.move?.amount) : null
  const internal = internalNumbers({ position, plan, economics, envelope })
  for (const amt of amounts) {
    if (allowed != null && Math.abs(amt - allowed) < 1) continue
    if (allowed == null) violations.push('amount_without_authority')
    else violations.push('amount_other_than_authorised_move')
    for (const [k, v] of internal) if (Math.abs(amt - v) <= tolerance_usd) violations.push(`internal_number_disclosed:${k}`)
  }
  if (CEILING_LANGUAGE_RE.test(String(text || ''))) violations.push('ceiling_language')
  if (COMP_DETAIL_RE.test(String(text || ''))) violations.push('comparable_sales_detail')
  return { ok: violations.length === 0, violations: [...new Set(violations)], amounts }
}

/** The composer's projection of a position (no internal reasoning). */
export function composerView(position = null) {
  const p = position || {}
  const amount = p.status === 'within_authority' ? num(p.move?.amount) : null
  return Object.freeze({
    contract_version: SELLER_GUARD_VERSION,
    status: p.status || 'escalate',
    may_state_amount: amount != null,
    move: p.status === 'within_authority' && p.move ? Object.freeze({ kind: p.move.kind, amount }) : null,
    allowed_terms: p.status === 'within_authority' ? p.allowed_terms || null : null,
    forbidden_claims: [...new Set([...(p.forbidden_claims || []), ...FORBIDDEN_CLAIMS, 'ceiling_or_max_price', 'internal_valuation_or_margin'])],
  })
}
