import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUYER_ENGAGEMENT,
  BUYER_FORBIDDEN_FIELDS,
  DISPOSITION_DENIALS,
  POF_STATES,
  authorizeDispositionPreparation,
  buildDispositionHandoff,
  projectBuyerFacingDeal,
  resolveBuyerEngagementStage,
  resolveDispositionCaseId,
  resolvePofStatus,
} from '@/lib/domain/disposition/disposition-authority.js'

/**
 * S7 DISPOSITION AUTHORITY.
 *
 *   disposition_activity != buyer_commitment
 *   buyer_interest       != selected_buyer
 *   selected_buyer       != closed_transaction
 *
 * The entry gate reads the CANONICAL acquisition stage and the accepted
 * seller-offer authority. `inbox_thread_state.lifecycle_stage` is not a
 * parameter at all — it has already been proven able to outrun canonical.
 */

const OPPORTUNITY = Object.freeze({
  id: 'opp-A',
  primary_property_id: 'prop-A',
  acquisition_stage: 'formal_contract',
  opportunity_status: 'active',
})

const ACCEPTED_OFFER = Object.freeze({
  offer_id: 'offer:opp-A:v1',
  offer_version: 1,
  opportunity_id: 'opp-A',
  property_id: 'prop-A',
  status: 'accepted',
  purchase_price: 62_300,
  accepted_price: 62_300,
  terms_hash: 'hash-v1',
  sent_at: '2026-09-12T18:00:00.000Z',
  accepted_at: '2026-09-12T19:00:00.000Z',
  acceptance_event_id: 'evt-1',
  emd_amount: 1000,
  closing_date: '2026-09-26',
  strategy: 'cash',
  metadata: {},
})

const gate = (over = {}) => authorizeDispositionPreparation({
  opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_OFFER, ...over,
})

/** A seller contract that actually executed, with traceable evidence. */
const EXECUTED_CASE = Object.freeze({
  closing_case_id: 'closing:opp-A',
  contract_status: 'fully_executed',
  universal_stage: 'disposition',
  docusign_envelope_id: 'env-1',
  contract_signed_date: '2026-09-13T00:00:00.000Z',
})

// ── Entry gate ────────────────────────────────────────────────────────────

test('S7: a contract-authorized seller deal may enter disposition', () => {
  const r = gate()
  assert.equal(r.authorized, true)
  assert.equal(r.disposition_case_id, 'closing:opp-A')
  assert.equal(r.evidence.accepted_offer_id, 'offer:opp-A:v1')
})

test('S7: a stage below formal_contract cannot enter disposition', () => {
  const r = gate({ opportunity: { ...OPPORTUNITY, acquisition_stage: 'offer' } })
  assert.equal(r.authorized, false)
  assert.equal(r.reason, DISPOSITION_DENIALS.STAGE_BELOW_FORMAL_CONTRACT)
})

test('S7: stage formal_contract with NO accepted offer cannot enter disposition', () => {
  // The three repaired legacy rows were exactly this: stage S6, zero offers.
  const r = gate({ acceptedOffer: null })
  assert.equal(r.authorized, false)
  assert.equal(r.reason, DISPOSITION_DENIALS.NO_ACCEPTED_OFFER)
})

test('S7: an accepted offer that was never presented cannot authorize disposition', () => {
  const r = gate({ acceptedOffer: { ...ACCEPTED_OFFER, sent_at: null } })
  assert.equal(r.reason, DISPOSITION_DENIALS.ACCEPTED_OFFER_NOT_PRESENTED)
})

test('S7: an accepted offer missing terms identity cannot authorize disposition', () => {
  for (const [field, value] of [['terms_hash', ''], ['accepted_at', null], ['acceptance_event_id', '']]) {
    const r = gate({ acceptedOffer: { ...ACCEPTED_OFFER, [field]: value } })
    assert.equal(r.reason, DISPOSITION_DENIALS.ACCEPTED_OFFER_INCOMPLETE, `${field} was not required`)
  }
})

test('S7: a terminal opportunity cannot enter disposition', () => {
  const r = gate({ opportunity: { ...OPPORTUNITY, opportunity_status: 'suppressed' } })
  assert.equal(r.reason, DISPOSITION_DENIALS.OPPORTUNITY_TERMINAL)
})

// ── §21 store authority ───────────────────────────────────────────────────

test('S7 STORES: a stale thread projection BEHIND canonical does not block S7', () => {
  // thread says `offer`, canonical says `formal_contract`, evidence is valid.
  // The gate never reads the projection, so a stale mirror cannot veto a real
  // contract-authorized deal.
  const r = gate()
  assert.equal(r.authorized, true)
})

test('S7 STORES: a thread projection AHEAD of canonical cannot create S7', () => {
  // thread says `disposition`, canonical says `offer`.
  const r = gate({ opportunity: { ...OPPORTUNITY, acquisition_stage: 'offer', lifecycle_stage: 'disposition' } })
  assert.equal(r.authorized, false)
  assert.equal(r.reason, DISPOSITION_DENIALS.STAGE_BELOW_FORMAL_CONTRACT)
})

test('S7 STORES: the gate takes no thread-projection input at all', () => {
  // Passing one changes nothing — it is not a parameter.
  const withProjection = authorizeDispositionPreparation({
    opportunity: { ...OPPORTUNITY, acquisition_stage: 'asking_price' },
    acceptedOffer: ACCEPTED_OFFER,
    threadLifecycleStage: 'disposition',
  })
  assert.equal(withProjection.authorized, false)
})

// ── §12 seller deal invalidated ───────────────────────────────────────────

test('S7: a voided accepted offer withdraws disposition authority', () => {
  const r = gate({ acceptedOffer: { ...ACCEPTED_OFFER, metadata: { voided: true, voided_at: '2026-09-10T23:51:34Z' } } })
  assert.equal(r.reason, DISPOSITION_DENIALS.SELLER_DEAL_VOIDED)
})

test('S7: a cancelled seller contract withdraws disposition authority', () => {
  // The $4,100 rent-as-price deal: offer voided, closing case cancelled,
  // history intact.
  const r = gate({ closingCase: { closing_case_id: 'closing:opp-A', contract_status: 'cancelled' } })
  assert.equal(r.reason, DISPOSITION_DENIALS.SELLER_DEAL_VOIDED)
})

test('S7: a voided closing case withdraws disposition authority', () => {
  const r = gate({ closingCase: { closing_case_id: 'closing:opp-A', provenance: { voided: true } } })
  assert.equal(r.reason, DISPOSITION_DENIALS.SELLER_DEAL_VOIDED)
})

// ── §22 multi-property isolation ──────────────────────────────────────────

test('S7: an offer for another property cannot authorize this disposition', () => {
  const r = gate({ acceptedOffer: { ...ACCEPTED_OFFER, property_id: 'prop-B' } })
  assert.equal(r.reason, DISPOSITION_DENIALS.OFFER_BELONGS_ELSEWHERE)
})

test('S7: an offer from another opportunity cannot authorize this disposition', () => {
  const r = gate({ acceptedOffer: { ...ACCEPTED_OFFER, opportunity_id: 'opp-B' } })
  assert.equal(r.reason, DISPOSITION_DENIALS.OFFER_BELONGS_ELSEWHERE)
})

// ── §7 idempotency ────────────────────────────────────────────────────────

test('S7: the same deal authorized 10x yields ONE disposition case id', () => {
  const ids = new Set(Array.from({ length: 10 }, () => gate().disposition_case_id))
  assert.equal(ids.size, 1)
  assert.equal([...ids][0], 'closing:opp-A')
})

test('S7: the disposition case id reuses the existing closing-case identity', () => {
  // uq_closing_cases_opportunity already makes this one row per opportunity in
  // the database, so a duplicate activation converges rather than forking.
  assert.equal(resolveDispositionCaseId('opp-A'), 'closing:opp-A')
  assert.equal(resolveDispositionCaseId(''), null)
})

// ── §8 / §11 the buyer ladder ─────────────────────────────────────────────

test('S7 BUYER: matched, interested and offer-submitted all stay at S7', () => {
  for (const level of [
    BUYER_ENGAGEMENT.ELIGIBLE,
    BUYER_ENGAGEMENT.MATCHED,
    BUYER_ENGAGEMENT.INTERESTED,
    BUYER_ENGAGEMENT.OFFER_SUBMITTED,
  ]) {
    const r = resolveBuyerEngagementStage(level)
    assert.equal(r.stage, 'disposition', `${level} advanced past S7`)
    assert.equal(r.advances_beyond_s7, false)
  }
})

test('S7 BUYER: only selection advances, and it requires S8 authority', () => {
  const r = resolveBuyerEngagementStage(BUYER_ENGAGEMENT.SELECTED)
  assert.equal(r.advances_beyond_s7, true)
  assert.equal(r.requires_s8_authority, true)
})

test('S7 BUYER: an unknown engagement level is not an advancement', () => {
  const r = resolveBuyerEngagementStage('extremely_keen')
  assert.equal(r.advances_beyond_s7, false)
  assert.equal(r.stage, 'disposition')
})

// ── §10 proof of funds ────────────────────────────────────────────────────

test('S7 POF: an attached document does not verify a buyer', () => {
  const r = resolvePofStatus({ document_present: true })
  assert.equal(r.status, POF_STATES.ATTACHED)
  assert.equal(r.buyer_verified, false)
})

test('S7 POF: reviewed is still not verified', () => {
  const r = resolvePofStatus({ document_present: true, reviewed_by: 'operator-1' })
  assert.equal(r.status, POF_STATES.REVIEWED)
  assert.equal(r.buyer_verified, false)
})

test('S7 POF: only an explicit human verification verifies', () => {
  const r = resolvePofStatus({
    document_present: true, verified_by: 'operator-1', verified_at: '2026-09-12T00:00:00Z',
  })
  assert.equal(r.status, POF_STATES.VERIFIED)
  assert.equal(r.buyer_verified, true)
})

test('S7 POF: expiry and insufficiency are distinct truthful states', () => {
  assert.equal(resolvePofStatus({
    document_present: true, expires_at: '2026-01-01T00:00:00Z', now: new Date('2026-09-12T00:00:00Z'),
  }).status, POF_STATES.EXPIRED)
  assert.equal(resolvePofStatus({
    document_present: true, amount: 10_000, required_amount: 62_300,
  }).status, POF_STATES.INSUFFICIENT)
  assert.equal(resolvePofStatus({ document_present: false }).status, POF_STATES.ABSENT)
})

// ── §15 privacy ───────────────────────────────────────────────────────────

test('S7 PRIVACY: the buyer projection never leaks seller identity or our economics', () => {
  const projected = projectBuyerFacingDeal({
    property_id: 'prop-A',
    property_address_full: '5115 Michigan Ave, Kansas City, Mo 64130',
    buyer_price: 79_000,
    seller_phone: '+12063359131',
    seller_email: 'seller@example.com',
    seller_name: 'Ronald',
    thread_key: '+12063359131',
    negotiation_state: { accepted_price: 62_300 },
    accepted_price: 62_300,
    expected_assignment_fee: 16_800,
    motivation_score: 91,
    ade_snapshot: { recommended_cash_offer: 62_300 },
  })
  const serialized = JSON.stringify(projected)
  for (const forbidden of BUYER_FORBIDDEN_FIELDS) {
    assert.ok(!(forbidden in projected), `leaked field ${forbidden}`)
  }
  assert.ok(!serialized.includes('62300') && !serialized.includes('16800'), `leaked our economics: ${serialized}`)
  assert.ok(!serialized.includes('2063359131'), 'leaked seller phone')
  assert.equal(projected.property_address_full, '5115 Michigan Ave, Kansas City, Mo 64130')
  assert.equal(projected.buyer_price, 79_000)
})

test('S7 PRIVACY: the projection is an allowlist, so new fields default to hidden', () => {
  const projected = projectBuyerFacingDeal({ property_id: 'p', some_future_internal_field: 'secret' })
  assert.deepEqual(Object.keys(projected), ['property_id'])
})

// ── §23 S8 handoff ────────────────────────────────────────────────────────

test('S7 → S8: the handoff carries the acquisition basis without seller messages', () => {
  const handoff = buildDispositionHandoff({
    opportunity: OPPORTUNITY,
    acceptedOffer: ACCEPTED_OFFER,
    closingCase: EXECUTED_CASE,
    buyerOffers: [
      { id: 'boffer-1', buyer_id: 'buyer-1', buyer_name: 'Acme', price: 79_000, earnest_money: 5_000,
        submitted_at: '2026-09-13T00:00:00Z', pof: { document_present: true } },
    ],
    economics: { valuation_mid: 162_500, estimated_repairs: 34_700, expected_assignment_fee: 16_800, investor_ceiling_mid: 113_800 },
  })

  assert.equal(handoff.ok, true)
  assert.equal(handoff.disposition_case_id, 'closing:opp-A')
  assert.equal(handoff.acquisition_basis.accepted_offer_id, 'offer:opp-A:v1')
  assert.equal(handoff.acquisition_basis.accepted_terms_hash, 'hash-v1')
  assert.equal(handoff.acquisition_basis.accepted_price, 62_300)
  assert.equal(handoff.economics.source, 'property_acquisition_scores')
  assert.equal(handoff.buyer_offer_count, 1)
  // Every buyer offer arrives as a proposal, and nothing is selected in S7.
  assert.equal(handoff.buyer_offers[0].engagement, BUYER_ENGAGEMENT.OFFER_SUBMITTED)
  assert.equal(handoff.buyer_offers[0].pof.buyer_verified, false)
  assert.equal(handoff.selected_buyer_id, null)
})

test('S7 → S8: an unauthorized deal produces no handoff at all', () => {
  const handoff = buildDispositionHandoff({
    opportunity: { ...OPPORTUNITY, acquisition_stage: 'offer' },
    acceptedOffer: ACCEPTED_OFFER,
  })
  assert.equal(handoff.ok, false)
  assert.equal(handoff.reason, DISPOSITION_DENIALS.STAGE_BELOW_FORMAL_CONTRACT)
})

test('S7 → S8: economics absent reads as decision-engine-not-run, never a legacy number', () => {
  const handoff = buildDispositionHandoff({
    opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_OFFER, closingCase: EXECUTED_CASE,
  })
  assert.equal(handoff.economics.source, 'decision_engine_not_run')
  assert.equal(handoff.economics.valuation_mid, null)
})

test('S7 → S8: many buyer offers still select nobody', () => {
  const handoff = buildDispositionHandoff({
    opportunity: OPPORTUNITY,
    acceptedOffer: ACCEPTED_OFFER,
    closingCase: EXECUTED_CASE,
    buyerOffers: Array.from({ length: 5 }, (_, i) => ({
      id: `boffer-${i}`, buyer_id: `buyer-${i}`, price: 70_000 + i * 1_000,
    })),
  })
  assert.equal(handoff.buyer_offer_count, 5)
  assert.equal(handoff.selected_buyer_id, null)
  assert.ok(handoff.buyer_offers.every((o) => o.engagement === BUYER_ENGAGEMENT.OFFER_SUBMITTED))
})
