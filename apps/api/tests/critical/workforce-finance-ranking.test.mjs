// Workforce Phase A — the CFO's independent review (never a rubber stamp), the ranking hierarchy
// (contact/identity → pressure → deal quality; unknown stays unknown; EV only from calibrated inputs,
// no fixed spread), the next-action derivation, and the decision read through the REAL predicates.
import test from 'node:test'
import assert from 'node:assert/strict'

import { reviewOpportunity } from '../../src/lib/workforce/finance/cfo-review.js'
import { rankOpportunities, expectedValue, dealQualityScore, contactIdentityScore } from '../../src/lib/workforce/acquisitions/ranking.js'
import { deriveNextAction, NEXT_ACTIONS } from '../../src/lib/workforce/acquisitions/next-action.js'
import { readAcquisitionDecision } from '../../src/lib/workforce/capabilities/acquisition-decision.js'
import { capability as financeReview } from '../../src/lib/workforce/capabilities/finance-review.js'
import { T0, makeScore, makeServices, opp } from '../helpers/workforce-fixtures.mjs'

const decisionFor = async (score, ask = 190_000) => readAcquisitionDecision({ loadAcquisitionScore: async () => score, getDealDecision: async () => ({ decision: score ? { status: 'available' } : { status: 'not_run' }, offer: { negotiation: { ask } } }) }, { property_id: '700000001', now: T0 })

test('the decision read uses the real predicates (authoritativeMaxOffer / evaluateOfferReadiness / resolveValuationSpendability)', async () => {
  const d = await decisionFor(makeScore({ property_id: '700000001' }))
  assert.equal(d.status, 'available')
  assert.equal(d.mao, 175_000, 'the effective authorized ceiling')
  assert.equal(d.offer_ready.ready, true)
  assert.equal(d.spendability.spendable, true)
  assert.equal(d.comps.selected, 6)
  assert.equal(d.ask, 190_000)
  const none = await decisionFor(null)
  assert.equal(none.status, 'not_run')
  assert.equal(none.mao, null)
  assert.equal(none.offer_ready.reason, 'not_scored')
  const insane = await decisionFor(makeScore({ property_id: '700000001', offer: 40_000, mao: 50_000 }))
  assert.equal(insane.offer_ready.ready, false)
  assert.equal(insane.spendability.reason, 'valuation_offer_sanity_failed')
  assert.equal(insane.valuation_uncertain, true)
})

test('CFO: supported only with positive evidence on every check', async () => {
  const ok = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: '700000001' }), 180_000) })
  assert.equal(ok.verdict, 'supported')
  for (const s of ['AUTHORITATIVE_MAO', 'VALUATION_SPENDABLE', 'OFFER_READY', 'DECISION_FRESH', 'COMP_COUNT_OK', 'COMPS_RECENT', 'CONFIDENCE_OK']) assert.ok(ok.supports.includes(s), s)
  assert.equal(reviewOpportunity({}).verdict, 'insufficient_evidence')
  assert.deepEqual(reviewOpportunity({ decision: null }).reasons, ['NO_DECISION'])
})

test('CFO: challenges — no MAO, thin or stale comps, ask far above MAO, low confidence, stale row, not spendable', async () => {
  const id = '700000001'
  const noMao = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: id, mao: null })) })
  assert.equal(noMao.verdict, 'insufficient_evidence')
  assert.ok(noMao.reasons.includes('NO_AUTHORITATIVE_MAO'))
  const thin = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: id, comps: 3 })) })
  assert.equal(thin.verdict, 'challenge')
  assert.ok(thin.reasons.includes('THIN_COMP_EVIDENCE'))
  assert.ok(thin.reasons.some((r) => r.startsWith('VALUATION_NOT_SPENDABLE')), 'below the MAD threshold without a contamination defense')
  const stale = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: id, compAgeMonths: 20 })) })
  assert.ok(stale.reasons.includes('STALE_COMP_EVIDENCE'))
  assert.equal(stale.verdict, 'challenge')
  const ask = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: id }), 320_000) })
  assert.equal(ask.verdict, 'challenge')
  assert.ok(ask.reasons.includes('ASK_FAR_ABOVE_MAO'))
  assert.equal(ask.figures.ask_vs_mao, 0.829)
  const low = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: id, confidence: 0.4 })) })
  assert.ok(low.reasons.includes('LOW_CONFIDENCE'))
  const old = reviewOpportunity({ decision: { ...(await decisionFor(makeScore({ property_id: id }))), age_days: 60 } })
  assert.ok(old.reasons.includes('STALE_DECISION'))
  const tier = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: id, tier: 'MANUAL_REVIEW' })) })
  assert.ok(tier.reasons.includes('VALUATION_NOT_SPENDABLE:valuation_tier_not_offer_authoritative'))
  assert.notEqual(tier.verdict, 'supported')
})

test('CFO disagrees with an optimistic acquisitions input (it checks the claim, never adopts it)', async () => {
  const d = await decisionFor(makeScore({ property_id: '700000001' }), 180_000)
  const rosy = reviewOpportunity({ decision: d, acquisitions: { claimed_mao: 230_000, proposed_offer: 210_000, claimed_spread_usd: 60_000, claimed_confidence: 0.95, thesis: 'strong' } })
  assert.equal(rosy.verdict, 'challenge', 'the engine supports the deal, the optimistic acquisitions view is still challenged')
  for (const r of ['ACQ_MAO_DISAGREES_WITH_ENGINE', 'ACQ_PROPOSAL_ABOVE_MAO', 'ACQ_SPREAD_NOT_BACKED_BY_ENGINE', 'ACQ_CONFIDENCE_OVERSTATED']) assert.ok(rosy.reasons.includes(r), r)
  assert.equal(rosy.figures.mao, 175_000, 'the CFO keeps the engine number')
  const noEngine = reviewOpportunity({ decision: await decisionFor(makeScore({ property_id: '700000001', mao: null })), acquisitions: { claimed_mao: 200_000, proposed_offer: 190_000, thesis: 'great' } })
  assert.equal(noEngine.verdict, 'insufficient_evidence')
  assert.ok(noEngine.reasons.includes('ACQ_MAO_WITHOUT_ENGINE_AUTHORITY'))
  assert.ok(noEngine.notes.includes('ACQ_THESIS_NOT_SUPPORTED_BY_EVIDENCE'))
  // the capability re-reads the engine itself: an upstream acquisitions output claiming a higher MAO is overruled
  const x = opp(1)
  const services = makeServices([x])
  const upstream = { assignment_id: 'wfa_up', status: 'completed', outcome_class: 'verified', output: { ...d, mao: 260_000, ask: 180_000 } }
  const out = await financeReview.run({ services, now: T0, deps: { 'dec.c01': upstream } }, { property_ref: x.property_ref, decision_step: 'dec.c01' })
  assert.equal(out.output.basis, 'cfo_reread')
  assert.equal(out.output.figures.mao, 175_000)
  assert.equal(out.output.verdict, 'challenge')
  assert.ok(out.output.reasons.includes('ACQ_MAO_DISAGREES_WITH_ENGINE'))
  assert.ok(out.output.notes.includes('ENGINE_MAO_CHANGED_SINCE_ACQ_READ'))
})

const conv = (o = {}) => ({ contact_permitted: true, suppressed: false, held: false, action: { verified_stage: 'asking_price', stage_verified: true }, last_inbound_at: new Date(T0 - 3_600_000).toISOString(), seller_spoke_last: true, ...o })
const dec = (o = {}) => ({ status: 'available', confidence: 0.8, expected_assignment_fee: 15_000, mao: 175_000, offer_ready: { ready: true }, valuation_mid: 250_000, ask: 190_000, ...o })

test('ranking: contact/identity outranks pressure, pressure outranks deal quality (lexicographic)', () => {
  const items = [
    { property_ref: 'pid_a', conv: conv({ last_inbound_at: null, seller_spoke_last: false, action: { verified_stage: null, stage_verified: false } }), decision: dec(), cfo: { verdict: 'supported' }, candidate: { intent: 'asks_offer' } }, // great deal, weak contact
    { property_ref: 'pid_b', conv: conv({ seller_spoke_last: false }), decision: dec(), cfo: { verdict: 'insufficient_evidence' }, candidate: {} }, // strong contact, low pressure, bad deal
    { property_ref: 'pid_c', conv: conv(), decision: dec(), cfo: { verdict: 'challenge' }, candidate: { intent: 'asks_offer' } }, // strong contact, high pressure
    { property_ref: 'pid_d', conv: conv(), decision: dec(), cfo: { verdict: 'supported' }, candidate: { intent: 'asks_offer' } }, // strong contact, high pressure, good deal
  ]
  const r = rankOpportunities(items, { now: T0 })
  assert.deepEqual(r.ranked.map((x) => x.property_ref), ['pid_d', 'pid_c', 'pid_b', 'pid_a'])
  assert.ok(r.ranked[0].components.contact_identity.value > r.ranked[3].components.contact_identity.value)
})

test('ranking: unknown stays unknown (never 0 or 100); known beats unknown within a level; not-permitted is excluded', () => {
  assert.deepEqual(contactIdentityScore(null), { value: null, status: 'unknown', basis: ['no_conversation_read'] })
  assert.equal(dealQualityScore(dec(), null).status, 'unknown')
  assert.equal(dealQualityScore(dec(), null).value, null)
  const r = rankOpportunities([
    { property_ref: 'pid_u', conv: null, decision: null, cfo: null },
    { property_ref: 'pid_k', conv: conv(), decision: dec(), cfo: { verdict: 'insufficient_evidence' } },
    { property_ref: 'pid_x', conv: conv({ contact_permitted: false }), decision: dec(), cfo: { verdict: 'supported' } },
  ], { now: T0 })
  assert.deepEqual(r.ranked.map((x) => x.property_ref), ['pid_k', 'pid_u'])
  const u = r.ranked[1]
  assert.equal(u.components.contact_identity.value, null)
  assert.equal(u.components.deal_quality.value, null)
  assert.equal(u.ev.status, 'unknown')
  assert.deepEqual(r.excluded, [{ property_ref: 'pid_x', reason: 'contact_not_permitted' }])
})

test('EV: P(close) × risk-adjusted net only with calibrated inputs; otherwise unknown — no fixed spread', () => {
  assert.deepEqual(expectedValue({ decision: dec(), calibration: null }), { value: null, status: 'unknown', missing: ['calibrated_p_close'] })
  // uncalibrated / thin sample / out of range ⇒ unknown
  for (const cal of [{ calibrated: false, p_close: 0.2, sample: 500 }, { calibrated: true, p_close: 0.2, sample: 10 }, { calibrated: true, p_close: 1.4, sample: 500 }]) assert.equal(expectedValue({ decision: dec(), calibration: cal }).status, 'unknown')
  // NO FIXED SPREAD: value and ask are known, the engine has no expected net ⇒ still unknown (no ARV × % − ask)
  const noNet = expectedValue({ decision: dec({ expected_assignment_fee: null }), calibration: { calibrated: true, p_close: 0.25, sample: 200 } })
  assert.equal(noNet.status, 'unknown')
  assert.equal(noNet.value, null)
  assert.deepEqual(noNet.missing, ['engine_expected_net'])
  // a non-authoritative row never prices
  assert.deepEqual(expectedValue({ decision: dec({ offer_ready: { ready: false } }), calibration: { calibrated: true, p_close: 0.25, sample: 200 } }).missing, ['authoritative_decision_row'])
  const known = expectedValue({ decision: dec(), calibration: { calibrated: true, p_close: 0.25, sample: 200, risk_haircut: 0.2, source: 'close_rate.v1' } })
  assert.equal(known.status, 'known')
  assert.equal(known.value, Math.round(0.25 * 15_000 * 0.8))
  assert.equal(known.basis.net_source, 'engine.expected_assignment_fee')
  // EV never re-orders the hierarchy
  const r = rankOpportunities([
    { property_ref: 'pid_rich', conv: conv({ seller_spoke_last: false, last_inbound_at: null }), decision: dec({ expected_assignment_fee: 90_000 }), cfo: { verdict: 'supported' }, calibration: { calibrated: true, p_close: 0.9, sample: 999 } },
    { property_ref: 'pid_lead', conv: conv(), decision: dec({ expected_assignment_fee: 5_000 }), cfo: { verdict: 'supported' }, calibration: { calibrated: true, p_close: 0.1, sample: 999 } },
  ], { now: T0 })
  assert.equal(r.ranked[0].property_ref, 'pid_lead')
})

test('next action: one of the closed set, derived from stage + action state + holds + CFO; never seller-facing', () => {
  const na = (o) => deriveNextAction(o)
  assert.equal(na({ conv: conv({ held: true }) }).action, 'hold')
  assert.equal(na({ conv: conv({ excluded: 'PERMANENT_EXCLUSION' }) }).action, 'none')
  assert.equal(na({ conv: conv({ suppressed: true }) }).action, 'none')
  assert.equal(na({ conv: conv({ action_state: 'needs_attention' }) }).action, 'operator_review', 'a waiting seller needs a person')
  assert.equal(na({ conv: conv({ action_state: 'awaiting_operator_decision' }) }).action, 'operator_review')
  assert.equal(na({ conv: conv({ action_state: 'waiting_on_seller' }), decision: dec(), cfo: { verdict: 'supported', reasons: [] } }).action, 'await_seller')
  assert.equal(na({ conv: conv({ action_state: null }), decision: null }).action, 'research')
  assert.equal(na({ conv: conv({ action_state: null }), decision: dec(), cfo: { verdict: 'insufficient_evidence' }, research: { needed: false } }).action, 'underwrite')
  assert.equal(na({ conv: conv({ action_state: null }), decision: dec(), cfo: { verdict: 'challenge', reasons: ['ASK_FAR_ABOVE_MAO'] } }).action, 'operator_review')
  assert.equal(na({ conv: conv({ action_state: null }), decision: dec(), cfo: { verdict: 'challenge', reasons: ['THIN_COMP_EVIDENCE'] } }).action, 'underwrite')
  assert.equal(na({ conv: conv({ action_state: null }), decision: dec(), cfo: { verdict: 'supported', reasons: [] } }).action, 'prepare_offer_recommendation')
  assert.equal(na({ conv: conv({ action_state: null }), decision: dec(), cfo: { verdict: 'supported' }, escalated: true }).action, 'operator_review')
  for (const o of [{}, { conv: conv() }, { decision: dec() }]) assert.ok(NEXT_ACTIONS.includes(na(o).action))
  assert.equal(NEXT_ACTIONS.some((a) => /send|text|offer_send|contact|stage/.test(a)), false)
})
