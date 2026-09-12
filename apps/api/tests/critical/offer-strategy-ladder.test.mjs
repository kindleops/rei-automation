import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceStrategyLadder,
  evaluateCashEligibility,
  evaluateCreativeEligibility,
  evaluateNovationEligibility,
  evaluateStructureSufficiency,
  evaluateFavorableSpread,
  isStrategyClosed,
  S5_STRATEGY,
  STRATEGY_STATUS,
  STRATEGY_RESPONSE,
  RESOLUTION_REASON,
  STRATEGY_ORDER,
} from '@/lib/domain/seller-flow/offer-strategy-ladder.js'
import { STAGE3_ROUTES } from '@/lib/domain/seller-flow/stage3-asking-price-engine.js'

/**
 * V2-3 — S5 strategy ladder.
 *
 * The invariant carried through every test: economics may open a door, and
 * only seller evidence may walk through it.
 */

const NOW = '2026-09-12T12:00:00.000Z'
const UW = { executable_offer: 175_000 }
const NOVATION_OK = {
  expected_retail_value: 400_000, selling_costs: 24_000,
  closing_costs: 8_000, required_spread: 30_000, repair_costs: 20_000,
}

// ── §1 Permanent invariants ────────────────────────────────────────────────

test('§1 favourable economics are NOT seller acceptance', () => {
  const r = evaluateFavorableSpread({ seller_ask: 150_000, executable_offer: 175_000 })
  assert.equal(r.favorable_spread, true)
  assert.equal(r.spread, 25_000)
  assert.equal(r.seller_acceptance, false)
  assert.equal(r.accepted_price, null)
  assert.equal(r.contract_ready, false)
  assert.equal(r.requires_offer_presentation, true)
})

test('§25 golden ticket: ask 150 vs ceiling 175 still requires presentation', () => {
  const r = evaluateFavorableSpread({ seller_ask: 150_000, executable_offer: 175_000 })
  assert.equal(r.favorable_spread, true)
  assert.equal(r.seller_acceptance, false)
})

test('§1 every ladder decision reports seller_acceptance false', () => {
  for (const response of Object.values(STRATEGY_RESPONSE)) {
    const r = advanceStrategyLadder({ response, underwriting: UW, economics: NOVATION_OK, now: NOW })
    assert.equal(r.seller_acceptance, false, `${response} claimed acceptance`)
    assert.equal(r.contract_eligible, false, `${response} claimed contract eligibility`)
  }
})

test('§20 even an ACCEPTED response does not self-certify contract eligibility', () => {
  const r = advanceStrategyLadder({ response: STRATEGY_RESPONSE.ACCEPTED, now: NOW })
  assert.equal(r.strategy_status, STRATEGY_STATUS.ACCEPTED)
  assert.equal(r.contract_eligible, false)
  assert.equal(r.requires_acceptance_authority_confirmation, true)
})

// ── §4 Cash is first ───────────────────────────────────────────────────────

test('§4 cash is the default strategy', () => {
  assert.equal(STRATEGY_ORDER[0], S5_STRATEGY.CASH)
  const r = advanceStrategyLadder({ response: STRATEGY_RESPONSE.NO_RESPONSE, now: NOW })
  assert.equal(r.strategy, S5_STRATEGY.CASH)
})

test('§4 cash needs a real executable offer, never the seller ask', () => {
  assert.equal(evaluateCashEligibility({ underwriting: {} }).eligible, false)
  assert.equal(evaluateCashEligibility({ underwriting: {} }).reason, RESOLUTION_REASON.NO_EXECUTABLE_OFFER)
  assert.equal(evaluateCashEligibility({ underwriting: UW }).eligible, true)
})

// ── §5 Cash response ontology ──────────────────────────────────────────────

test('§5/§25 a counter is neither acceptance nor rejection of selling', () => {
  const r = advanceStrategyLadder({ response: STRATEGY_RESPONSE.COUNTER, now: NOW })
  assert.equal(r.strategy, S5_STRATEGY.CASH)
  assert.equal(r.strategy_status, STRATEGY_STATUS.ACTIVE)
  assert.equal(r.seller_acceptance, false)
  assert.equal(r.cash_rejected_at, null)
})

// ── §7 Cash rejection → creative (THE core V2-3 change) ────────────────────

test('§7 cash rejection evaluates creative, it does NOT nurture', () => {
  const r = advanceStrategyLadder({
    response: STRATEGY_RESPONSE.REJECTED, underwriting: UW, economics: NOVATION_OK, now: NOW,
  })
  assert.equal(r.strategy, S5_STRATEGY.CREATIVE)
  assert.equal(r.next_objective, 'creative_interest')
  assert.ok(r.cash_rejected_at)
  assert.notEqual(r.strategy, S5_STRATEGY.EXHAUSTED)
})

test('§7 creative evaluation does NOT require a prior seller signal', () => {
  // Cash rejection is itself the trigger to ASK about terms. Requiring a
  // signal first is what previously sent these sellers to nurture.
  assert.equal(evaluateCreativeEligibility({ facts: {} }).eligible, true)
})

test('§7 "cash only" is the one hard stop for creative', () => {
  const e = evaluateCreativeEligibility({ facts: { seller_requires_cash: true } })
  assert.equal(e.eligible, false)
  assert.equal(e.reason, RESOLUTION_REASON.SELLER_REQUIRES_CASH)
})

test('§7 cash rejected + cash-only seller skips creative to novation', () => {
  const r = advanceStrategyLadder({
    response: STRATEGY_RESPONSE.REJECTED,
    facts: { seller_requires_cash: true }, economics: NOVATION_OK, now: NOW,
  })
  assert.equal(r.strategy, S5_STRATEGY.NOVATION)
  assert.equal(r.creative_ineligible_reason, RESOLUTION_REASON.SELLER_REQUIRES_CASH)
})

// ── §10 Structure sufficiency ──────────────────────────────────────────────

test('§10 free and clear does not need a mortgage payment it does not have', () => {
  const r = evaluateStructureSufficiency('seller_finance', {
    free_and_clear: true, desired_down_payment: 20_000, desired_monthly_payment: 1_500,
  })
  assert.equal(r.eligible, true)
  assert.equal(r.free_and_clear, true)
})

test('§10 subject-to requires real debt facts', () => {
  const r = evaluateStructureSufficiency('subject_to', { mortgage_balance: 120_000 })
  assert.equal(r.eligible, false)
  assert.deepEqual(r.missing, ['monthly_payment', 'interest_rate'])
})

test('§10 unknown debt is MISSING, never fabricated as zero', () => {
  const r = evaluateStructureSufficiency('subject_to', {})
  assert.equal(r.eligible, false)
  assert.equal(r.free_and_clear, false, 'absent debt must not read as free and clear')
  assert.ok(r.missing.includes('mortgage_balance'))
})

test('§11 an unknown structure is never eligible by name', () => {
  assert.equal(evaluateStructureSufficiency('rent_to_own_deluxe', {}).eligible, false)
})

// ── §12 Creative interest ≠ accepted terms ─────────────────────────────────

test('§12 creative interest keeps the strategy active and accepts nothing', () => {
  const r = advanceStrategyLadder({
    ladder: { strategy: S5_STRATEGY.CREATIVE }, response: STRATEGY_RESPONSE.INTEREST, now: NOW,
  })
  assert.equal(r.strategy, S5_STRATEGY.CREATIVE)
  assert.equal(r.strategy_status, STRATEGY_STATUS.ACTIVE)
  assert.equal(r.seller_acceptance, false)
  assert.equal(r.contract_eligible, false)
})

// ── §13/§14 Creative rejection → novation ──────────────────────────────────

test('§13 creative rejection advances to novation, not nurture', () => {
  const r = advanceStrategyLadder({
    ladder: { strategy: S5_STRATEGY.CREATIVE, cash_rejected_at: NOW },
    response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW,
  })
  assert.equal(r.strategy, S5_STRATEGY.NOVATION)
  assert.ok(r.creative_rejected_at)
})

test('§14 novation requires enough economics to estimate proceeds', () => {
  const r = evaluateNovationEligibility({ economics: { expected_retail_value: 400_000 } })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, 'missing_required_facts')
  assert.equal(r.review_only, true)
})

test('§14 novation proceeds are an ESTIMATE and never a promise of retail', () => {
  const r = evaluateNovationEligibility({ economics: NOVATION_OK })
  assert.equal(r.eligible, true)
  assert.equal(r.is_estimate, true)
  assert.equal(r.guarantees_retail, false)
  assert.equal(r.estimated_seller_proceeds, 318_000)
})

test('§14 infeasible novation economics are refused', () => {
  const r = evaluateNovationEligibility({
    economics: { expected_retail_value: 100_000, selling_costs: 60_000, closing_costs: 30_000, required_spread: 40_000 },
  })
  assert.equal(r.eligible, false)
  assert.equal(r.reason, RESOLUTION_REASON.ECONOMICS_INFEASIBLE)
})

test('§15 unresolved legal/role policy keeps novation review-only', () => {
  const r = evaluateNovationEligibility({
    economics: NOVATION_OK, policy: { novation_legal_policy_resolved: false },
  })
  assert.equal(r.eligible, false)
  assert.equal(r.review_only, true)
  assert.equal(r.reason, RESOLUTION_REASON.POLICY_UNRESOLVED)
})

test('§15 an unresolved-policy ladder HOLDS instead of declaring exhaustion', () => {
  const r = advanceStrategyLadder({
    ladder: { strategy: S5_STRATEGY.CREATIVE },
    response: STRATEGY_RESPONSE.REJECTED,
    economics: NOVATION_OK, policy: { novation_legal_policy_resolved: false }, now: NOW,
  })
  assert.equal(r.strategy_status, STRATEGY_STATUS.HOLD)
  assert.equal(r.requires_review, true)
  assert.notEqual(r.strategy, S5_STRATEGY.EXHAUSTED)
})

// ── §17 Exhaustion ─────────────────────────────────────────────────────────

test('§17 exhaustion needs ALL three rungs resolved', () => {
  const r = advanceStrategyLadder({
    ladder: { strategy: S5_STRATEGY.NOVATION, cash_rejected_at: NOW, creative_rejected_at: NOW },
    response: STRATEGY_RESPONSE.REJECTED, now: NOW,
  })
  assert.equal(r.strategy, S5_STRATEGY.EXHAUSTED)
  assert.equal(r.nurture_reason, 'strategy_exhausted')
})

test('§17 strategy rejection is NOT seller disinterest', () => {
  const r = advanceStrategyLadder({
    ladder: { strategy: S5_STRATEGY.NOVATION, cash_rejected_at: NOW, creative_rejected_at: NOW },
    response: STRATEGY_RESPONSE.REJECTED, now: NOW,
  })
  assert.equal(r.seller_not_interested, false)
  assert.equal(r.nurture_reason, 'strategy_exhausted')
})

test('§7 the ladder never bounces backwards', () => {
  const closed = { cash_rejected_at: NOW, creative_rejected_at: NOW }
  assert.equal(isStrategyClosed(closed, S5_STRATEGY.CASH), true)
  assert.equal(isStrategyClosed(closed, S5_STRATEGY.CREATIVE), true)
  assert.equal(isStrategyClosed(closed, S5_STRATEGY.NOVATION), false)
})

// ── §18 The wide-gap defect ────────────────────────────────────────────────

test('§18 a very wide gap no longer drips straight to nurture', () => {
  const route = STAGE3_ROUTES.VERY_WIDE_GAP_STRATEGY_LADDER
  assert.equal(route.route, 'strategy_ladder')
  assert.equal(route.acquisition_action, 'evaluate_strategy_ladder')
  assert.equal(route.nurture_requires_ladder_exhaustion, true)
  assert.notEqual(route.acquisition_action, 'enter_nurture_drip')
})

test('§18/§22 the ladder route starts no timer for an unasked question', () => {
  // V2-2: a cadence begins only after its actual outbound.
  assert.equal(STAGE3_ROUTES.VERY_WIDE_GAP_STRATEGY_LADDER.follow_up_policy.schedule, false)
})

// ── §26 Journeys ───────────────────────────────────────────────────────────

test('Journey C: cash rejected → creative interest → terms accepted', () => {
  const afterCash = advanceStrategyLadder({
    response: STRATEGY_RESPONSE.REJECTED, underwriting: UW, economics: NOVATION_OK, now: NOW,
  })
  assert.equal(afterCash.strategy, S5_STRATEGY.CREATIVE)

  const interested = advanceStrategyLadder({ ladder: afterCash, response: STRATEGY_RESPONSE.INTEREST, now: NOW })
  assert.equal(interested.seller_acceptance, false)

  const accepted = advanceStrategyLadder({ ladder: interested, response: STRATEGY_RESPONSE.ACCEPTED, now: NOW })
  assert.equal(accepted.strategy_status, STRATEGY_STATUS.ACCEPTED)
  assert.equal(accepted.requires_acceptance_authority_confirmation, true)
})

test('Journey D: cash → creative → novation, full ladder', () => {
  const a = advanceStrategyLadder({ response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW })
  assert.equal(a.strategy, S5_STRATEGY.CREATIVE)
  const b = advanceStrategyLadder({ ladder: a, response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW })
  assert.equal(b.strategy, S5_STRATEGY.NOVATION)
  assert.ok(b.cash_rejected_at && b.creative_rejected_at)
})

test('Journey E: all three rejected → strategy_exhausted nurture', () => {
  const a = advanceStrategyLadder({ response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW })
  const b = advanceStrategyLadder({ ladder: a, response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW })
  const c = advanceStrategyLadder({ ladder: b, response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW })
  assert.equal(c.strategy, S5_STRATEGY.EXHAUSTED)
  assert.equal(c.nurture_reason, 'strategy_exhausted')
  assert.equal(c.seller_not_interested, false)
})

test('Journey G: a huge ask gap reaches creative, not nurture', () => {
  // The defect this increment exists to fix, asserted end to end.
  const r = advanceStrategyLadder({
    response: STRATEGY_RESPONSE.REJECTED,
    underwriting: { executable_offer: 175_000 },
    economics: NOVATION_OK,
    facts: {},
    now: NOW,
  })
  assert.equal(r.strategy, S5_STRATEGY.CREATIVE)
  assert.notEqual(r.nurture_reason, 'strategy_exhausted')
})

test('§3 every transition records WHY, not just that it happened', () => {
  const r = advanceStrategyLadder({ response: STRATEGY_RESPONSE.REJECTED, economics: NOVATION_OK, now: NOW })
  assert.ok(r.strategy_resolution_reason)
  assert.ok(Array.isArray(r.transitions))
  assert.ok(r.transitions.length >= 1)
})
