// ─── NEGOTIATION POSITION (8.5.19 Phase 8) ───────────────────────────────────
// decidePosition() — pure. Given the economics, the envelope (or none), the
// ledger state and what the seller just asked for, return exactly one of:
//
//   needs_envelope    no live authority for this scope (none / expired / revoked /
//                     superseded). Carries a PROPOSED envelope + underwriting for the
//                     operator (operator_only). move is null: NO amount to the seller.
//   within_authority  the allowed next move (open / counter / final / agree at the
//                     seller's price / hold) with its amount ≤ envelope.max_price and
//                     its justification (internal only — never comps to the seller).
//   escalate          the seller asks for terms outside authority, the scope does not
//                     match, the underwriting moved since the grant, the move budget is
//                     spent, the seller accepted (a contract is an operator act), …
//
// INVARIANTS (tests/critical/negotiation-authority.test.mjs):
//   • no envelope ⇒ no amount;  • amount ≤ envelope.max_price, always;
//   • scope mismatch ⇒ escalate; • expiry ⇒ needs_envelope;
//   • protected attributes are stripped before anything is read;
//   • an 'open' move is strictly below the envelope max and the engine MAO (8.5.20-b);
//   • cash availability, proof of funds and closing dates are never asserted
//     (forbidden_claims) — only the operator-granted terms may be stated.
import { stripProtectedAttributes } from '../opportunity-economics/classify-opportunity.js'
import { buildProposedEnvelope, envelopeStatus, envelopeTerms, scopeKey, termsWithinEnvelope, underwritingHash } from './envelope.js'

export const POSITION_CONTRACT_VERSION = 'negotiation.position.v1'
export const POSITION_STATUSES = Object.freeze(['needs_envelope', 'within_authority', 'escalate'])
export const MOVE_KINDS = Object.freeze(['open', 'counter', 'final', 'agree_at_seller_price', 'hold'])
/** Claims the composer may never make, whatever the envelope says. */
export const FORBIDDEN_CLAIMS = Object.freeze(['cash_on_hand_or_funds_available', 'proof_of_funds', 'guaranteed_closing_date', 'guaranteed_close_in_days', 'final_contract_terms', 'comparable_sales_detail'])
/** A remaining gap this small (fraction of max) is closed at the seller's number. */
export const CLOSE_GAP_FRACTION = 0.01
export const CLOSE_GAP_MIN_USD = 1_000
const STEP = 500

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const floorTo = (v, step = STEP) => Math.floor(v / step) * step
const usd = (n) => (n == null ? 'n/a' : `$${Math.round(n).toLocaleString('en-US')}`)

function base(status, extra = {}) {
  return {
    contract_version: POSITION_CONTRACT_VERSION,
    status,
    move: null,
    envelope_ref: null,
    proposed_envelope: null,
    escalation: null,
    forbidden_claims: [...FORBIDDEN_CLAIMS],
    ...extra,
  }
}

function escalate(reasons, extra = {}) {
  return base('escalate', { escalation: { reasons: [...new Set(reasons)], operator_action: extra.operator_action || 'review_and_decide' }, ...extra })
}

/**
 * @param {object} a
 * @param {{ thread_key: string, property_id: string, opportunity_id?: string|null }} a.scope
 * @param {object|null} a.economics          classifyOpportunityEconomics() result for the SAME property
 * @param {object|null} a.envelope           latest envelope row for the scope (or null)
 * @param {{ revoked?: boolean, latest_version?: number|null }} [a.envelope_meta]
 * @param {object} a.ledger                  ledger state (replayLedger + reconcileWithSellerOffers)
 * @param {{ kind?: string, amount?: number|null, terms?: object }} [a.seller_request]
 *        what the seller is asking for in THIS turn (from the 8.5.16 understanding step)
 * @param {number|string} [a.now]
 */
export function decidePosition(input = {}) {
  const { value: a, stripped } = stripProtectedAttributes(input)
  const now = typeof a.now === 'number' ? a.now : Date.parse(a.now || '') || Date.now()
  const scope = a.scope || {}
  const ledger = a.ledger || {}
  const economics = a.economics || null
  const req = a.seller_request || {}
  const ignored = { protected_attributes_stripped: stripped }
  let sk
  try { sk = scopeKey(scope.thread_key, scope.property_id) } catch { return escalate(['scope_missing'], { ignored }) }

  const env = a.envelope || null
  const meta = a.envelope_meta || {}
  if (env && env.scope_key !== sk) return escalate(['scope_mismatch'], { ignored, operator_action: 'grant_an_envelope_for_this_thread_and_property' })
  if (ledger.scope_key && ledger.scope_key !== sk) return escalate(['ledger_scope_mismatch'], { ignored })

  const st = envelopeStatus(env, { scope_key: sk, now, revoked: meta.revoked, latest_version: meta.latest_version })
  if (!st.live) {
    return base('needs_envelope', { reason: st.reason, ignored, proposed_envelope: buildProposedEnvelope({ economics, ...scope, now, offer_plan: a.offer_plan || null }), economics_class: economics?.class ?? null })
  }

  const t = envelopeTerms(env)
  const max = t.max_price
  const envelope_ref = { envelope_id: env.envelope_id, version: env.version, expires_at: env.expires_at }
  const allowed_terms = { closing_window_days: [t.closing_window_min_days, t.closing_window_max_days], earnest_money: [t.earnest_money_min, t.earnest_money_max], as_is: t.as_is, closing_costs_paid_by: t.closing_costs_paid_by }

  // non-price terms first: anything outside the grant is the operator's call
  const terms = termsWithinEnvelope(req.terms || {}, env)
  if (!terms.ok) return escalate(terms.violations.map((v) => `seller_terms:${v}`), { envelope_ref, ignored, operator_action: 'decide_terms_or_grant_a_new_envelope_version' })
  if (req.kind === 'creative_terms' || req.kind === 'financing') return escalate(['seller_requests_non_cash_structure'], { envelope_ref, ignored })

  // the grant must still describe the deal
  if (!economics) return escalate(['economics_unavailable'], { envelope_ref, ignored })
  if (env.underwriting_hash && env.underwriting_hash !== underwritingHash(economics)) return escalate(['underwriting_changed_since_grant'], { envelope_ref, ignored, operator_action: 'review_new_underwriting_and_regrant' })
  if (economics.class === 'PASS') return escalate(['economics_now_pass'], { envelope_ref, ignored })
  const mao = num(economics.metrics?.mao)
  if (mao != null && max > mao) return escalate(['envelope_max_above_current_engine_mao'], { envelope_ref, ignored })

  if (ledger.status === 'agreed') return escalate(['seller_accepted_contract_is_an_operator_act'], { envelope_ref, ignored, operator_action: 'prepare_contract_in_closing_desk' })
  if (ledger.status === 'withdrawn' || ledger.status === 'expired') return escalate([`ledger_${ledger.status}`], { envelope_ref, ignored })
  for (const f of ledger.flags || []) if (f.code === 'formal_offer_without_ledger_authority' && num(f.amount) > max) return escalate(['prior_offer_on_record_above_envelope'], { envelope_ref, ignored })

  const ourLast = num(ledger.last_our_amount)
  if (ourLast != null && ourLast > max) return escalate(['prior_offer_on_record_above_envelope'], { envelope_ref, ignored })
  const freshAmount = num(req.amount)
  const sellerAmount = freshAmount ?? num(ledger.last_seller_amount) ?? num(economics.metrics?.ask)
  const used = Number(ledger.engine_moves_by_envelope?.[env.envelope_id] || 0)
  const left = t.max_moves - used
  const just = []
  const within = (kind, amount, quote_type = 'FORMAL_OFFER', event_type = null) => {
    const amt = amount == null ? null : Math.min(floorTo(amount, 1), max)
    if (amt != null && (amt > max || amt <= 0)) throw new Error('INVARIANT_AMOUNT_ABOVE_MAX')
    return base('within_authority', {
      envelope_ref, ignored, allowed_terms,
      move: { kind, amount: amt, quote_type: amt == null ? null : quote_type, ledger_event_type: event_type, moves_left_after: amt == null ? left : left - 1, justification: just, justification_visibility: 'internal_only' },
    })
  }

  // every priced move spends one of the envelope's moves; with none left only a hold is possible
  if (left <= 0) {
    if (ourLast != null && freshAmount == null && ledger.status === 'offer_out') { just.push(`our ${usd(ourLast)} stands; no moves left under this envelope`); return within('hold', null) }
    return escalate(['envelope_move_budget_exhausted'], { envelope_ref, ignored, operator_action: 'grant_a_new_envelope_version_or_hold' })
  }

  // seller at or under our number → agree at THEIR number (never pay more than asked)
  if (ourLast != null && sellerAmount != null && sellerAmount <= ourLast && (freshAmount != null || ledger.status !== 'offer_out')) {
    just.push(`seller at ${usd(sellerAmount)} ≤ our last ${usd(ourLast)}: agree at the seller's number`)
    return within('agree_at_seller_price', sellerAmount, 'FORMAL_OFFER', 'our_counter')
  }

  if (ourLast == null) {
    const opening = num(t.opening_price) ?? num(economics.metrics?.recommended_offer)
    if (opening == null) return escalate(['no_opening_price_in_authority'], { envelope_ref, ignored, operator_action: 'set_an_opening_price' })
    const open = Math.min(opening, max)
    if (sellerAmount != null && sellerAmount <= open) {
      just.push(`seller at ${usd(sellerAmount)} ≤ opening ${usd(open)}: agree at the seller's number`)
      return within('agree_at_seller_price', sellerAmount, 'FORMAL_OFFER', 'our_offer')
    }
    // 8.5.20-b: the ceiling is never the opening — an opening at (or above) the envelope max
    // or the engine MAO is not opened by the engine; the operator sets one below it.
    if (open >= max || (mao != null && open >= mao)) return escalate(['opening_not_below_ceiling'], { envelope_ref, ignored, operator_action: 'set_an_opening_price_below_the_ceiling' })
    just.push(`open at the operator-granted opening ${usd(open)} (≤ max); open below range`)
    if (sellerAmount != null) just.push(`seller asks ${usd(sellerAmount)}`)
    return within('open', open, 'FORMAL_OFFER', 'our_offer')
  }

  // we have a number out
  if (freshAmount == null && (sellerAmount == null || ledger.status === 'offer_out')) {
    just.push(`our ${usd(ourLast)} stands; no new seller number`)
    return within('hold', null)
  }
  if (ourLast >= max) return escalate(['seller_above_authority_at_max'], { envelope_ref, ignored, operator_action: 'raise_envelope_or_hold' })
  const gap = sellerAmount - ourLast
  if (sellerAmount <= max && gap <= Math.max(CLOSE_GAP_MIN_USD, max * CLOSE_GAP_FRACTION)) {
    just.push(`gap ${usd(gap)} is within the close band: agree at the seller's ${usd(sellerAmount)} (≤ max)`)
    return within('agree_at_seller_price', sellerAmount, 'FORMAL_OFFER', 'our_counter')
  }
  if (left === 1) {
    const fin = Math.min(max, sellerAmount)
    just.push(`last move under this envelope: final at ${usd(fin)} (≤ max)`)
    return within('final', fin, 'FORMAL_OFFER', 'our_final')
  }
  const target = Math.min(sellerAmount, max)
  let next = floorTo(ourLast + (target - ourLast) / 2)
  if (next <= ourLast) next = Math.min(ourLast + STEP, target)
  just.push(`seller at ${usd(sellerAmount)}; move half-way from our ${usd(ourLast)} toward ${sellerAmount > max ? 'the authority limit' : "the seller's number"}`)
  return within('counter', Math.min(next, max), 'FORMAL_OFFER', 'our_counter')
}

export default decidePosition
