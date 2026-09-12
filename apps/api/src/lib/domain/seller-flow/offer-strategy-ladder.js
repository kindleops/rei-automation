/**
 * V2-3 — OFFER STRATEGY LADDER (substates of canonical S5 `offer`).
 *
 * There is NO new top-level stage. S5 remains one lifecycle stage; this module
 * owns which strategy we are pursuing inside it:
 *
 *     CASH → CREATIVE → NOVATION → EXHAUSTED
 *
 * THE INVARIANT THIS MODULE EXISTS TO PROTECT:
 *
 *     favourable economics  ≠  seller acceptance
 *
 * A seller asking 150 when our executable ceiling is 175 means we have ROOM,
 * not agreement. Nothing here may set accepted_price, accepted terms, or
 * contract eligibility — those come only from the canonical acceptance
 * authority (seller-offer-authority.js / finalize-seller-acceptance.js)
 * reading real inbound seller evidence against specific presented terms.
 * Every decision returned carries `seller_acceptance: false` so a caller can
 * assert that from the return value alone.
 *
 * WHY THIS REPLACES A REAL DEFECT. stage3-asking-price-engine routed
 * VERY_WIDE_GAP straight to `enter_nurture_drip` on a 60-day schedule,
 * skipping creative and novation entirely. A seller asking far above our cash
 * ceiling is precisely the seller for whom terms or a retail-oriented
 * structure might work, so "the cash number is far apart" was being treated as
 * "there is no deal here". The ladder now requires each strategy to be
 * REJECTED or deterministically INELIGIBLE before the next is skipped, and
 * nurture only after all three resolve.
 *
 * SKIPPING IS ALLOWED, GUESSING IS NOT. A strategy may be bypassed only when a
 * deterministic eligibility rule says so, and the reason is persisted. Absence
 * of facts is `missing_required_facts`, which is a HOLD, never an implicit
 * "this cannot work".
 */

const clean = (value) => String(value ?? '').trim()

export const S5_STRATEGY = Object.freeze({
  CASH: 'cash',
  CREATIVE: 'creative',
  NOVATION: 'novation',
  EXHAUSTED: 'exhausted',
})

/** Canonical order. The ladder never moves backwards. */
export const STRATEGY_ORDER = Object.freeze([
  S5_STRATEGY.CASH,
  S5_STRATEGY.CREATIVE,
  S5_STRATEGY.NOVATION,
  S5_STRATEGY.EXHAUSTED,
])

export const STRATEGY_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  INELIGIBLE: 'ineligible',
  HOLD: 'hold',
})

/** Why a strategy ended. Persisted — never inferred later from message text. */
export const RESOLUTION_REASON = Object.freeze({
  SELLER_REJECTED: 'seller_rejected_terms',
  SELLER_REQUIRES_CASH: 'seller_requires_cash',
  DEBT_STRUCTURE_INELIGIBLE: 'debt_structure_ineligible',
  ECONOMICS_INFEASIBLE: 'economics_infeasible',
  MISSING_FACTS_EXHAUSTED: 'missing_required_facts_after_exhaustion',
  POLICY_UNRESOLVED: 'product_or_legal_policy_unresolved',
  NO_EXECUTABLE_OFFER: 'no_executable_offer_available',
  SELLER_ACCEPTED: 'seller_accepted_terms',
})

/** Seller responses to a presented strategy. Evidence, never sentiment. */
export const STRATEGY_RESPONSE = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  COUNTER: 'counter',
  INTEREST: 'interest',
  CLARIFICATION: 'clarification',
  NO_RESPONSE: 'no_response',
})

function emptyLadder() {
  return {
    strategy: S5_STRATEGY.CASH,
    strategy_status: STRATEGY_STATUS.PENDING,
    cash_attempted_at: null, cash_rejected_at: null,
    creative_attempted_at: null, creative_rejected_at: null,
    novation_attempted_at: null, novation_rejected_at: null,
    strategy_resolution_reason: null,
  }
}

/**
 * Is a strategy still available to try?
 *
 * A strategy that was attempted and rejected is closed permanently — the
 * ladder must not bounce back to cash after creative, which would let a
 * conversation loop indefinitely between structures.
 */
export function isStrategyClosed(ladder = {}, strategy) {
  if (strategy === S5_STRATEGY.CASH) return Boolean(ladder.cash_rejected_at)
  if (strategy === S5_STRATEGY.CREATIVE) return Boolean(ladder.creative_rejected_at)
  if (strategy === S5_STRATEGY.NOVATION) return Boolean(ladder.novation_rejected_at)
  return false
}

/**
 * CASH eligibility. Cash is the default and is only unavailable when there is
 * no executable offer to present — we never manufacture one from the seller's
 * ask, and never simply echo their number back.
 */
export function evaluateCashEligibility({ underwriting = {} } = {}) {
  const executable = Number(
    underwriting.executable_offer ?? underwriting.max_allowable_offer ?? underwriting.recommended_offer
  )
  if (!Number.isFinite(executable) || executable <= 0) {
    return { eligible: false, reason: RESOLUTION_REASON.NO_EXECUTABLE_OFFER, missing_facts: ['executable_offer'] }
  }
  return { eligible: true, reason: null, executable_offer: executable }
}

/**
 * CREATIVE eligibility.
 *
 * Deliberately does NOT require a seller signal to be EVALUATED — that is the
 * point of the ladder. Cash rejection is itself the trigger to ask whether
 * terms could work. A seller signal is required before a specific STRUCTURE is
 * proposed, which is a later gate, not this one.
 *
 * `seller_requires_cash` is the one hard stop: a seller who said "cash only"
 * has already answered the creative question.
 */
export function evaluateCreativeEligibility({ facts = {}, policy = {} } = {}) {
  if (facts.seller_requires_cash === true) {
    return { eligible: false, reason: RESOLUTION_REASON.SELLER_REQUIRES_CASH }
  }
  if (policy.creative_enabled === false) {
    return { eligible: false, reason: RESOLUTION_REASON.POLICY_UNRESOLVED }
  }
  return { eligible: true, reason: null, next_objective: 'creative_interest' }
}

/**
 * Structure-specific sufficiency.
 *
 * Requirements differ per structure, so a free-and-clear seller finance deal is
 * not blocked for lacking a mortgage payment it does not have. Unknown debt is
 * MISSING, never zero — fabricating a zero balance would make every unknown
 * property look free and clear and wildly inflate what we could offer.
 */
export const STRUCTURE_REQUIREMENTS = Object.freeze({
  seller_finance: ['desired_down_payment', 'desired_monthly_payment'],
  subject_to: ['mortgage_balance', 'monthly_payment', 'interest_rate'],
  hybrid: ['mortgage_balance', 'monthly_payment', 'desired_down_payment'],
  lease_option: ['desired_monthly_payment', 'desired_term'],
})

export function evaluateStructureSufficiency(structure, facts = {}) {
  const required = STRUCTURE_REQUIREMENTS[clean(structure)] || null
  if (!required) return { structure, eligible: false, reason: 'unknown_structure', missing: [] }

  // Free and clear removes the debt requirements entirely — they describe a
  // loan that does not exist.
  const freeAndClear = facts.free_and_clear === true || Number(facts.mortgage_balance) === 0
  const effective = freeAndClear
    ? required.filter((f) => !['mortgage_balance', 'monthly_payment', 'interest_rate'].includes(f))
    : required

  const missing = effective.filter((f) => facts[f] === undefined || facts[f] === null || facts[f] === '')
  return {
    structure,
    eligible: missing.length === 0,
    missing,
    free_and_clear: freeAndClear,
    // A missing fact is a HOLD, not a refusal: we ask for it.
    reason: missing.length ? 'missing_required_facts' : null,
  }
}

/**
 * NOVATION eligibility — economics-driven, never aspirational.
 *
 * Requires enough to ESTIMATE seller proceeds. Without a retail value and the
 * cost stack there is no honest number to discuss, and a novation conversation
 * without one is a promise of retail value we have not underwritten.
 */
export function evaluateNovationEligibility({ economics = {}, policy = {} } = {}) {
  if (policy.novation_legal_policy_resolved === false) {
    // Role/agency semantics unresolved: novation stays review-only rather than
    // risking a misrepresentation about who owns the property or who is acting
    // as an agent.
    return { eligible: false, reason: RESOLUTION_REASON.POLICY_UNRESOLVED, review_only: true }
  }

  const required = ['expected_retail_value', 'selling_costs', 'closing_costs', 'required_spread']
  const missing = required.filter((k) => !Number.isFinite(Number(economics[k])))
  if (missing.length) {
    return { eligible: false, reason: 'missing_required_facts', missing, review_only: true }
  }

  const retail = Number(economics.expected_retail_value)
  const costs = Number(economics.selling_costs) + Number(economics.closing_costs) +
    Number(economics.repair_costs || 0) + Number(economics.holding_costs || 0)
  const spread = Number(economics.required_spread)
  const estimatedProceeds = retail - costs - spread

  if (!Number.isFinite(estimatedProceeds) || estimatedProceeds <= 0) {
    return { eligible: false, reason: RESOLUTION_REASON.ECONOMICS_INFEASIBLE, estimated_seller_proceeds: estimatedProceeds }
  }

  return {
    eligible: true,
    reason: null,
    // ESTIMATED. Never presented as a guarantee, and never promised before
    // underwriting — the caller must carry this framing into any messaging.
    estimated_seller_proceeds: estimatedProceeds,
    is_estimate: true,
    guarantees_retail: false,
  }
}

/**
 * Advance the ladder from a seller response to the CURRENT strategy.
 *
 * Pure. Returns the next ladder state plus the reason, so the transition is
 * auditable rather than reconstructed from message history later.
 */
export function advanceStrategyLadder({
  ladder = null,
  response,
  facts = {},
  policy = {},
  underwriting = {},
  economics = {},
  now = null,
} = {}) {
  const state = { ...emptyLadder(), ...(ladder || {}) }
  const at = now || new Date().toISOString()
  const current = clean(state.strategy) || S5_STRATEGY.CASH
  const base = {
    previous_strategy: current,
    // Restated on every return: the ladder can never create acceptance.
    seller_acceptance: false,
    contract_eligible: false,
  }

  // ── Acceptance is the ONLY exit to S6, and it is not decided here. ───────
  // A caller passes ACCEPTED only after the canonical acceptance authority has
  // matched real seller evidence to specific presented terms.
  if (response === STRATEGY_RESPONSE.ACCEPTED) {
    return {
      ...base,
      ...state,
      strategy: current,
      strategy_status: STRATEGY_STATUS.ACCEPTED,
      strategy_resolved_at: at,
      strategy_resolution_reason: RESOLUTION_REASON.SELLER_ACCEPTED,
      // Still false here: eligibility is asserted by the acceptance authority,
      // not by the ladder observing an "accepted" label.
      contract_eligible: false,
      requires_acceptance_authority_confirmation: true,
    }
  }

  // A counter keeps the strategy alive. It is neither acceptance nor a
  // rejection of selling.
  if (response === STRATEGY_RESPONSE.COUNTER) {
    return {
      ...base, ...state,
      strategy: current,
      strategy_status: STRATEGY_STATUS.ACTIVE,
      counter_received_at: at,
      strategy_resolution_reason: null,
    }
  }

  if (response === STRATEGY_RESPONSE.INTEREST || response === STRATEGY_RESPONSE.CLARIFICATION) {
    return { ...base, ...state, strategy: current, strategy_status: STRATEGY_STATUS.ACTIVE, interest_recorded_at: at }
  }

  if (response !== STRATEGY_RESPONSE.REJECTED) {
    return { ...base, ...state, strategy: current, strategy_status: state.strategy_status || STRATEGY_STATUS.ACTIVE }
  }

  // ── Rejection: close this strategy and evaluate the next rung ────────────
  const next = { ...state }
  if (current === S5_STRATEGY.CASH) next.cash_rejected_at = at
  if (current === S5_STRATEGY.CREATIVE) next.creative_rejected_at = at
  if (current === S5_STRATEGY.NOVATION) next.novation_rejected_at = at

  const transitions = []

  if (current === S5_STRATEGY.CASH) {
    const creative = evaluateCreativeEligibility({ facts, policy })
    transitions.push({ strategy: S5_STRATEGY.CREATIVE, ...creative })
    if (creative.eligible) {
      return {
        ...base, ...next,
        strategy: S5_STRATEGY.CREATIVE,
        strategy_status: STRATEGY_STATUS.PENDING,
        creative_attempted_at: at,
        strategy_started_at: at,
        strategy_resolution_reason: RESOLUTION_REASON.SELLER_REJECTED,
        next_objective: 'creative_interest',
        transitions,
      }
    }
    next.creative_rejected_at = at
    next.creative_ineligible_reason = creative.reason
  }

  if (current === S5_STRATEGY.CASH || current === S5_STRATEGY.CREATIVE) {
    const novation = evaluateNovationEligibility({ economics, policy })
    transitions.push({ strategy: S5_STRATEGY.NOVATION, ...novation })
    if (novation.eligible) {
      return {
        ...base, ...next,
        strategy: S5_STRATEGY.NOVATION,
        strategy_status: STRATEGY_STATUS.PENDING,
        novation_attempted_at: at,
        strategy_started_at: at,
        strategy_resolution_reason: RESOLUTION_REASON.SELLER_REJECTED,
        next_objective: 'novation_interest',
        transitions,
      }
    }
    if (novation.review_only) {
      // Cannot proceed and cannot honestly rule it out: HOLD for review rather
      // than silently declaring the ladder exhausted.
      return {
        ...base, ...next,
        strategy: S5_STRATEGY.NOVATION,
        strategy_status: STRATEGY_STATUS.HOLD,
        strategy_resolution_reason: novation.reason,
        requires_review: true,
        transitions,
      }
    }
    next.novation_rejected_at = at
    next.novation_ineligible_reason = novation.reason
  }

  // ── Exhausted ────────────────────────────────────────────────────────────
  return {
    ...base, ...next,
    strategy: S5_STRATEGY.EXHAUSTED,
    strategy_status: STRATEGY_STATUS.REJECTED,
    strategy_resolved_at: at,
    strategy_resolution_reason: RESOLUTION_REASON.SELLER_REJECTED,
    // Distinct from seller disinterest. The seller rejected our STRUCTURES;
    // they never said they do not want to sell, and recording that would be a
    // fact they did not state.
    nurture_reason: 'strategy_exhausted',
    seller_not_interested: false,
    transitions,
  }
}

/**
 * Favourable-spread flag. Internal only.
 *
 * Named `favorable_spread` rather than anything resembling acceptance, and
 * returned alongside an explicit `seller_acceptance: false`, because this
 * condition is exactly where a "golden ticket" has previously been mistaken
 * for a closed deal.
 */
export function evaluateFavorableSpread({ seller_ask = null, executable_offer = null } = {}) {
  const ask = Number(seller_ask)
  const offer = Number(executable_offer)
  if (!Number.isFinite(ask) || !Number.isFinite(offer)) {
    return { favorable_spread: false, seller_acceptance: false, reason: 'insufficient_economics' }
  }
  return {
    favorable_spread: ask <= offer,
    spread: offer - ask,
    seller_acceptance: false,
    accepted_price: null,
    contract_ready: false,
    // The offer must still be PRESENTED and ACCEPTED.
    requires_offer_presentation: true,
  }
}

export default advanceStrategyLadder
