import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACCEPTANCE_VERDICTS,
  ACCEPTANCE_REASONS,
  authorizeFormalContract,
  resolveMaterialTerms,
  resolveSellerAcceptance,
} from '@/lib/domain/seller-flow/seller-acceptance-authority.js'
import { applyNegotiationTurn, hasRevealedOffer } from '@/lib/domain/seller-flow/negotiation-state.js'
import { classifyStage5Negotiation } from '@/lib/domain/seller-flow/stage5-offer-negotiation-engine.js'
import { buildOfferTermsHash } from '@/lib/domain/seller-flow/seller-offer-authority.js'

/**
 * S6 FORMAL CONTRACT AUTHORITY.
 *
 * S6 means the seller accepted identifiable terms we actually presented.
 *
 * PRODUCTION EVIDENCE THIS EXISTS TO PREVENT. All three opportunities sitting
 * at `formal_contract` carry basis `we_accepted_seller_ask` with
 * `offers_made: 0` and `latest_offer: null` — no offer was ever presented to
 * any of them — and `seller_offers` contains one row total, 0 accepted. One of
 * the three froze accepted_price = 331, a known corrupt extraction, as an
 * agreed contract price.
 *
 *   favorable economics != seller acceptance
 *   asking price        != seller acceptance
 *   contract request    != accepted contract terms
 *   counter             != acceptance
 *   lexical positivity  != acceptance
 */

const OPPORTUNITY = Object.freeze({ id: 'opp-A', primary_property_id: 'prop-A' })

const PRESENTED_OFFER = Object.freeze({
  offer_id: 'offer:opp-A:v1',
  offer_version: 1,
  opportunity_id: 'opp-A',
  property_id: 'prop-A',
  thread_key: '+12063359131',
  purchase_price: 62_300,
  closing_date: '2026-09-26',
  closing_term: '14 days',
  emd_amount: 1000,
  emd_term: '3 business days',
  closing_window_days: 14,
  emd_due_business_days: 3,
  emd_due_date: '2026-09-17',
  strategy: 'cash',
  status: 'active',
  sent_at: '2026-09-12T18:00:00.000Z',
  created_at: '2026-09-12T17:59:00.000Z',
  terms_hash: 'hash-v1',
})

const msg = (body, at = '2026-09-12T19:00:00.000Z', id = 'evt-1') => ({
  body, received_at: at, message_event_id: id,
})

const resolve = (body, { offer = PRESENTED_OFFER, context = {}, at, id } = {}) =>
  resolveSellerAcceptance({
    opportunity: OPPORTUNITY,
    message: msg(body, at, id),
    activePresentedOffer: offer,
    conversationContext: context,
  })

// ── The matrix ────────────────────────────────────────────────────────────

test('S6: a presented cash offer plus clear acceptance is accepted', () => {
  const v = resolve('Deal.')
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.ACCEPTED)
  assert.equal(v.accepted, true)
  assert.equal(v.accepted_price, 62_300)
  assert.equal(v.offer_id, 'offer:opp-A:v1')
  assert.equal(v.terms_hash, 'hash-v1')
})

test('S6: "Deal." with NO presented offer accepts nothing', () => {
  // The single gate all three production S6 rows failed.
  const v = resolve('Deal.', { offer: null })
  assert.equal(v.accepted, false)
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE)
  assert.equal(v.reason, ACCEPTANCE_REASONS.NO_PRESENTED_OFFER)
  assert.equal(v.accepted_price, null)
})

test('S6: a contract request alone is not acceptance and stays S5', () => {
  const v = resolve('Send me the contract so I can review it.')
  assert.equal(v.accepted, false)
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.CONTRACT_REQUEST_ONLY)
  assert.equal(v.contract_request, true)
})

test('S6: acceptance AND a contract request both resolve, and authorize', () => {
  const v = resolve('62,300 works. Send the contract.')
  assert.equal(v.accepted, true)
  assert.equal(v.contract_request, true)
  assert.equal(v.accepted_price, 62_300)
})

test('S6: a counter is not acceptance', () => {
  const v = resolve("I'll take 80.", { context: { counter_price: 80_000 } })
  assert.equal(v.accepted, false)
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.COUNTER)
})

test('S6: acceptance words plus a different number is a HOLD, never agreement', () => {
  const v = resolve("Deal, but I need 80,000.")
  assert.equal(v.accepted, false)
  assert.ok([ACCEPTANCE_VERDICTS.AMBIGUOUS_HOLD, ACCEPTANCE_VERDICTS.COUNTER].includes(v.verdict))
})

test('S6: a superseded offer reference holds rather than accepting the active one', () => {
  const v = resolve('Deal.', { context: { referenced_offer_id: 'offer:opp-A:v0' } })
  assert.equal(v.accepted, false)
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.AMBIGUOUS_HOLD)
  assert.equal(v.reason, ACCEPTANCE_REASONS.STALE_OFFER_REFERENCE)
})

test('S6: acceptance of a superseding offer B binds to B, not to A', () => {
  const offerB = { ...PRESENTED_OFFER, offer_id: 'offer:opp-A:v2', offer_version: 2, purchase_price: 70_000, terms_hash: 'hash-v2' }
  const v = resolve('Okay, I will take it.', { offer: offerB })
  assert.equal(v.accepted, true)
  assert.equal(v.offer_id, 'offer:opp-A:v2')
  assert.equal(v.accepted_price, 70_000)
  assert.equal(v.terms_hash, 'hash-v2')
})

test('S6: an acceptance that predates the offer accepts nothing', () => {
  const v = resolve('Deal.', { at: '2026-09-12T17:00:00.000Z' })
  assert.equal(v.accepted, false)
  assert.equal(v.reason, ACCEPTANCE_REASONS.ACCEPTANCE_PREDATES_OFFER)
})

test('S6: an offer that was never sent cannot be accepted', () => {
  const v = resolve('Deal.', { offer: { ...PRESENTED_OFFER, sent_at: null } })
  assert.equal(v.accepted, false)
  assert.equal(v.reason, ACCEPTANCE_REASONS.OFFER_NOT_PRESENTED_TO_SELLER)
})

// ── §24 false-positive audit ──────────────────────────────────────────────

test('S6 FALSE POSITIVE: "sounds good, what would you offer?" is not acceptance', () => {
  const v = resolve('Sounds good, what would you offer?')
  assert.equal(v.accepted, false)
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.AMBIGUOUS_HOLD)
  assert.equal(v.reason, ACCEPTANCE_REASONS.INTERROGATIVE_ACCEPTANCE)
})

test('S6 FALSE POSITIVE: "deal with it" is not acceptance', () => {
  assert.equal(resolve('Just deal with it.').accepted, false)
})

test('S6 FALSE POSITIVE: "I accepted another offer" is not acceptance of ours', () => {
  const v = resolve('I accepted another offer, sorry.')
  assert.equal(v.accepted, false)
  assert.equal(v.reason, ACCEPTANCE_REASONS.THIRD_PARTY_ACCEPTANCE)
})

test('S6 FALSE POSITIVE: "no deal" is not acceptance', () => {
  const v = resolve('No deal.')
  assert.equal(v.accepted, false)
  assert.equal(v.reason, ACCEPTANCE_REASONS.NEGATED_ACCEPTANCE)
})

test('S6 FALSE POSITIVE: "yes but" is deferred, not agreed', () => {
  const v = resolve('Yes but I need to talk to my wife first.')
  assert.equal(v.accepted, false)
  assert.equal(v.reason, ACCEPTANCE_REASONS.DEFERRED_ACCEPTANCE)
})

test('S6 FALSE POSITIVE: "send something over" is not acceptance', () => {
  assert.equal(resolve('Send something over.').accepted, false)
})

test('S6 FALSE POSITIVE: a seller reporting the property is SOLD is not acceptance', () => {
  // Found by replaying 1,200 production inbound messages: `\bsold\b` as an
  // acceptance token classified 10 messages as acceptance, and every one was a
  // seller reporting a completed sale to someone else.
  for (const body of [
    "It's SOLD",
    'Sold',
    'It was...sold a few weeks ago',
    'I sold 123 Main, but I own 456 Oak and might sell that one',
    "It's being sold on time",
  ]) {
    assert.equal(resolve(body).accepted, false, `"${body}" read as acceptance`)
  }
})

test('S6 FALSE POSITIVE: "okay thanks" is not acceptance', () => {
  assert.equal(resolve('Okay thanks.').accepted, false)
})

test('S6: naming our exact price disambiguates an otherwise ambiguous reply', () => {
  // "Send the contract for the $62,300." — a question-shaped reply that names
  // the presented number is attachable.
  const v = resolve('Send the contract for the 62,300.')
  assert.equal(v.accepted, true)
  assert.equal(v.evidence.named_offer_price, true)
})

// ── §6 material terms per strategy ────────────────────────────────────────

test('S6: a cash offer missing contract-bearing terms cannot be accepted', () => {
  const incomplete = { ...PRESENTED_OFFER, emd_amount: null }
  const v = resolve('Deal.', { offer: incomplete })
  assert.equal(v.accepted, false)
  assert.equal(v.verdict, ACCEPTANCE_VERDICTS.INSUFFICIENT_TERMS)
  assert.ok(v.evidence.missing_terms.includes('emd_amount'))
})

test('S6: creative and novation need their structure, not just a price', () => {
  const creative = resolveMaterialTerms({ ...PRESENTED_OFFER, strategy: 'seller_finance' })
  assert.equal(creative.ok, false)
  assert.ok(creative.missing.includes('creative_payment_structure'))

  const novation = resolveMaterialTerms({ ...PRESENTED_OFFER, strategy: 'novation' })
  assert.equal(novation.ok, false)
  assert.ok(novation.missing.includes('novation_consideration'))
})

test('S6: a fully specified creative offer is acceptable', () => {
  const offer = {
    ...PRESENTED_OFFER,
    strategy: 'seller_finance',
    metadata: { creative_terms: { down_payment: 10_000, monthly_payment: 900 } },
  }
  assert.equal(resolveMaterialTerms(offer).ok, true)
  assert.equal(resolve('Deal.', { offer }).accepted, true)
})

// ── §14 the S5 → S6 gate ─────────────────────────────────────────────────

const ACCEPTED_OFFER = Object.freeze({ ...PRESENTED_OFFER, status: 'accepted', accepted_at: '2026-09-12T19:00:00.000Z' })

test('S6 GATE: acceptance of presented terms authorizes formal contract', () => {
  const acceptance = resolve('Deal.')
  const gate = authorizeFormalContract({
    currentStageIndex: 4, acceptance, acceptedOffer: ACCEPTED_OFFER, opportunity: OPPORTUNITY,
  })
  assert.equal(gate.authorized, true)
  assert.equal(gate.contract.accepted_price, 62_300)
  // `draft` is the repo-native closing_cases status; the authorization state is
  // separate and is not a persisted status.
  assert.equal(gate.contract.contract_status, 'draft')
  assert.equal(gate.contract.contract_authorization, 'contract_preparation_required')
})

test('S6 GATE: no acceptance means no authorization, whatever the economics', () => {
  const gate = authorizeFormalContract({
    currentStageIndex: 4,
    acceptance: resolve('Sounds good, what would you offer?'),
    acceptedOffer: ACCEPTED_OFFER,
    opportunity: OPPORTUNITY,
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, 'no_accepted_offer')
})

test('S6 GATE: a stage below S5 cannot jump to formal contract', () => {
  // One production row carries promotion_reason S1_TO_S6_OWNERSHIP_CONFIRMED.
  const gate = authorizeFormalContract({
    currentStageIndex: 0, acceptance: resolve('Deal.'), acceptedOffer: ACCEPTED_OFFER, opportunity: OPPORTUNITY,
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, 'stage_below_offer')
})

test('S6 GATE: an accepted offer with no terms hash is not authoritative', () => {
  const gate = authorizeFormalContract({
    currentStageIndex: 4, acceptance: resolve('Deal.'),
    acceptedOffer: { ...ACCEPTED_OFFER, terms_hash: '' }, opportunity: OPPORTUNITY,
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, 'accepted_offer_has_no_terms_hash')
})

// ── §18 multi-property / cross-context isolation ──────────────────────────

test('S6: an offer for another property cannot be accepted in this thread', () => {
  const gate = authorizeFormalContract({
    currentStageIndex: 4,
    acceptance: resolve('Deal.'),
    acceptedOffer: { ...ACCEPTED_OFFER, property_id: 'prop-B' },
    opportunity: OPPORTUNITY,
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, 'offer_belongs_to_other_property')
})

test('S6: an offer from another opportunity cannot be accepted here', () => {
  const gate = authorizeFormalContract({
    currentStageIndex: 4,
    acceptance: resolve('Deal.'),
    acceptedOffer: { ...ACCEPTED_OFFER, opportunity_id: 'opp-B' },
    opportunity: OPPORTUNITY,
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, 'offer_belongs_to_other_opportunity')
})

test('S6: same owner, two properties — only the addressed deal advances', () => {
  const offerB = { ...PRESENTED_OFFER, offer_id: 'offer:opp-B:v1', opportunity_id: 'opp-B', property_id: 'prop-B' }
  const acceptanceInA = resolveSellerAcceptance({
    opportunity: OPPORTUNITY, message: msg('Deal.'), activePresentedOffer: PRESENTED_OFFER,
  })
  assert.equal(acceptanceInA.accepted, true)
  assert.equal(acceptanceInA.property_id, 'prop-A')
  // Property B's offer is untouched by A's acceptance.
  const crossGate = authorizeFormalContract({
    currentStageIndex: 4, acceptance: acceptanceInA, acceptedOffer: offerB, opportunity: OPPORTUNITY,
  })
  assert.equal(crossGate.authorized, false)
})

// ── §11 replay / idempotency ─────────────────────────────────────────────

test('S6: the same acceptance resolved 10x yields one identical verdict', () => {
  const verdicts = Array.from({ length: 10 }, () => resolve('Deal.', { id: 'evt-same' }))
  const keys = new Set(verdicts.map((v) => `${v.accepted}:${v.offer_id}:${v.accepted_price}:${v.message_event_id}`))
  assert.equal(keys.size, 1)
  assert.equal(verdicts[0].message_event_id, 'evt-same')
})

// ── §12 terms hash ───────────────────────────────────────────────────────

test('S6 HASH: identical terms hash identically', () => {
  const terms = { opportunity_id: 'opp-A', purchase_price: 62_300, closing_date: '2026-09-26', emd_amount: 1000, closing_window_days: 14, emd_due_business_days: 3 }
  assert.equal(buildOfferTermsHash(terms), buildOfferTermsHash({ ...terms }))
})

test('S6 HASH: every material change produces a different hash', () => {
  const base = { opportunity_id: 'opp-A', purchase_price: 62_300, closing_date: '2026-09-26', emd_amount: 1000, closing_window_days: 14, emd_due_business_days: 3 }
  const h = buildOfferTermsHash(base)
  assert.notEqual(h, buildOfferTermsHash({ ...base, purchase_price: 70_000 }))
  assert.notEqual(h, buildOfferTermsHash({ ...base, emd_amount: 2500 }))
  assert.notEqual(h, buildOfferTermsHash({ ...base, closing_window_days: 21 }))
  assert.notEqual(h, buildOfferTermsHash({ ...base, emd_due_business_days: 5 }))
  assert.notEqual(h, buildOfferTermsHash({ ...base, closing_date: '2026-10-10' }))
})

test('S6 HASH: non-material metadata does not perturb the hash', () => {
  const base = { opportunity_id: 'opp-A', purchase_price: 62_300, emd_amount: 1000 }
  assert.equal(
    buildOfferTermsHash({ ...base, metadata: { a: 1 }, sent_at: 'x' }),
    buildOfferTermsHash({ ...base, metadata: { b: 2 }, sent_at: 'y' }),
  )
})

// ── §2 / §20 / §21 economics cannot fabricate acceptance ─────────────────

test('S6 ECONOMICS: our decision to accept their ask is NOT seller acceptance', () => {
  // The exact production shape: ask affordable, nothing presented, router
  // selects accept_seller_terms. This used to set terms_accepted = true and
  // freeze accepted_price from the ask.
  const next = applyNegotiationTurn(
    { current_asking_price: 70_000, authorized_offer_ceiling: 80_000, offers_made: [], latest_offer: null },
    { strategy_decision: { strategy: 'accept_seller_terms' }, now: '2026-09-12T19:00:00.000Z' },
  )
  assert.notEqual(next.terms_accepted, true)
  assert.equal(next.accepted_price ?? null, null)
  assert.equal(next.ask_within_authority_acknowledged, true)
})

test('S6 ECONOMICS: an acceptance signal with nothing presented is blocked', () => {
  const next = applyNegotiationTurn(
    { current_asking_price: 331, offers_made: [], latest_offer: null },
    { engine_decision: { outcome: 'seller_accepts_offer' }, now: '2026-09-12T19:00:00.000Z' },
  )
  assert.notEqual(next.terms_accepted, true)
  assert.equal(next.acceptance_blocked_reason, 'no_presented_offer')
  // The corrupt 331 never becomes a frozen contract price.
  assert.notEqual(next.accepted_price, 331)
})

test('S6 ECONOMICS: with an offer presented, acceptance locks the PRESENTED price', () => {
  const next = applyNegotiationTurn(
    {
      current_asking_price: 150_000,
      authorized_offer_ceiling: 79_100,
      latest_offer: 62_300,
      offers_made: [{ amount: 62_300, at: '2026-09-12T18:00:00.000Z' }],
    },
    { engine_decision: { outcome: 'seller_accepts_offer' }, now: '2026-09-12T19:00:00.000Z' },
  )
  assert.equal(next.terms_accepted, true)
  assert.equal(next.accepted_price, 62_300, 'the presented offer is the agreed price, never the ask')
})

test('S6: hasRevealedOffer is the shared presented-offer predicate', () => {
  assert.equal(hasRevealedOffer({ offers_made: [], latest_offer: null }), false)
  assert.equal(hasRevealedOffer({ offers_made: [{ amount: 1 }] }), true)
  assert.equal(hasRevealedOffer({ latest_offer: 62_300 }), true)
})

// ── Stage-5 routing no longer reaches S6 without a presented offer ───────

test('S6 ROUTING: lexical acceptance with nothing presented stays at S5', () => {
  const decision = classifyStage5Negotiation({
    message: 'Sounds good.',
    recommended_cash_offer: 62_300,
    offer_presented: false,
  })
  assert.equal(decision.stage_code, 'S5')
  assert.deepEqual(decision.events.map((e) => e.type).filter((t) => t === 'SELLER_ACCEPTED_OFFER'), [])
})

test('S6 ROUTING: a contract request with nothing presented stays at S5', () => {
  const decision = classifyStage5Negotiation({
    message: 'Send me the contract.',
    recommended_cash_offer: 62_300,
    offer_presented: false,
  })
  assert.equal(decision.stage_code, 'S5')
})

test('S6 ROUTING: with an offer presented, acceptance reaches the S6 route', () => {
  const decision = classifyStage5Negotiation({
    message: 'Deal.',
    recommended_cash_offer: 62_300,
    offer_presented: true,
  })
  assert.equal(decision.stage_code, 'S6')
})

// ── §19 suppression does not erase transaction truth ─────────────────────

test('S6: a STOP after acceptance does not undo the accepted offer', () => {
  const acceptance = resolve('Deal.')
  assert.equal(acceptance.accepted, true)
  // A later STOP is a communication permission change, not a transaction event.
  const stop = resolve('STOP')
  assert.equal(stop.accepted, false)
  assert.equal(stop.verdict, ACCEPTANCE_VERDICTS.NOT_ACCEPTANCE)
  // The earlier acceptance is a separate immutable fact.
  assert.equal(acceptance.accepted_price, 62_300)
})

test('S6: STOP is neither acceptance nor rejection of terms', () => {
  const v = resolve('STOP')
  assert.equal(v.reason, ACCEPTANCE_REASONS.NO_ACCEPTANCE_LANGUAGE)
})

// ── §15 monotonicity ─────────────────────────────────────────────────────

test('S6 MONOTONIC: a deal at S6 never returns to S5', async () => {
  const { resolveSellerStageTransition } = await import('@/lib/domain/seller-flow/resolve-seller-stage-transition.js')
  const base = {
    stage_before: 'formal_contract',
    known_facts: { asking_price: { value: 500_000 }, ownership_status: 'confirmed', interest: 'interested' },
    negotiation_state: { terms_accepted: true, latest_offer: 62_300, offers_made: [{ amount: 62_300 }] },
    ade_result: { recommended_offer: 62_300, max_allowable_offer: 79_100, sufficient_facts: true, underwriting_ready: true },
  }
  // Renegotiation, loss of interest and new facts are all CONTRACT state, not
  // reasons to walk the acquisition stage backward.
  for (const [label, extra] of [
    ['very wide gap counter', { intent: 'counter_offer', new_facts: { asking_price: 500_000 } }],
    ['not interested', { intent: 'not_interested', new_facts: {} }],
    ['condition disclosed', { intent: 'condition_disclosed', new_facts: { condition_disclosed: true } }],
    ['asks offer again', { intent: 'asks_offer', new_facts: {} }],
  ]) {
    const t = resolveSellerStageTransition({ ...base, ...extra })
    assert.equal(t.stage_after, 'formal_contract', `${label} regressed to ${t.stage_after}`)
  }
})

// ── §27 downstream contract for S7 ───────────────────────────────────────

test('S6 → S7: the authorized contract carries everything S7 needs', () => {
  const gate = authorizeFormalContract({
    currentStageIndex: 4, acceptance: resolve('Deal.'), acceptedOffer: ACCEPTED_OFFER, opportunity: OPPORTUNITY,
  })
  for (const key of [
    'accepted_offer_id', 'accepted_offer_version', 'accepted_terms_hash', 'accepted_price',
    'accepted_at', 'acceptance_event_id', 'strategy', 'opportunity_id', 'property_id',
    'thread_key', 'contract_status',
  ]) {
    assert.ok(gate.contract[key] !== undefined && gate.contract[key] !== null, `missing ${key}`)
  }
  // S7 never has to read a seller message to learn any of this.
})
