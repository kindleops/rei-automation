import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUYER_COMMITMENT_STATUS,
  BUYER_DENIALS,
  BUYER_OFFER_STATUS,
  BUYER_POF_STATUS,
  COMMITMENT_TYPES,
  EMD_STATUS,
  authorizeBuyerCommitment,
  buildBuyerCommitmentHandoff,
  buildBuyerOfferId,
  buildBuyerTermsHash,
  compareBuyerOffers,
  resolveBuyerFailure,
  resolveBuyerOfferCompleteness,
  resolveBuyerPof,
  resolveDispositionEconomics,
  resolveEmdPosition,
  selectBuyerOffer,
} from '@/lib/domain/disposition/buyer-commitment-authority.js'
import {
  BUYER_ENGAGEMENT,
  buildDispositionHandoff,
  resolveBuyerEngagementStage,
} from '@/lib/domain/disposition/disposition-authority.js'

/**
 * S8 — BUYER SELECTION + BUYER COMMITMENT AUTHORITY.
 *
 * `under_contract` means THIS DEAL HAS ONE CANONICALLY COMMITTED BUYER.
 *
 * SELECTED != COMMITTED. Choosing a buyer is our decision; being bound is
 * theirs. A selected buyer who can still walk away is not "under contract",
 * so selection stays at S7 with commitment_status `agreement_required`.
 */

const OPPORTUNITY = Object.freeze({
  id: 'opp-A', primary_property_id: 'prop-A',
  acquisition_stage: 'formal_contract', opportunity_status: 'active',
})

const DISPOSITION_ACTIVE = Object.freeze({
  authorized: true,
  external_activity_permitted: true,
  disposition_state: 'active',
  disposition_case_id: 'closing:opp-A',
})

const DISPOSITION_PREPARATION = Object.freeze({
  authorized: false, external_activity_permitted: false, disposition_state: 'preparation',
})

const SUBMITTED_OFFER = Object.freeze({
  buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1',
  offer_version: 1,
  opportunity_id: 'opp-A',
  disposition_case_id: 'closing:opp-A',
  property_id: 'prop-A',
  buyer_id: 'buyer-1',
  offer_price: 80_000,
  strategy: 'assignment',
  emd_amount: 5_000,
  emd_status: EMD_STATUS.PROMISED,
  closing_window_days: 14,
  pof_status: BUYER_POF_STATUS.ATTACHED,
  terms_hash: 'bhash-1',
  status: BUYER_OFFER_STATUS.SUBMITTED,
})

const SELECTED_OFFER = Object.freeze({ ...SUBMITTED_OFFER, status: BUYER_OFFER_STATUS.SELECTED })

const COMMITMENT_EVIDENCE = Object.freeze({
  commitment_event_id: 'commit-evt-1',
  agreement_id: 'assignment-agreement-1',
  commitment_type: COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT,
  executed_at: '2026-09-13T12:00:00.000Z',
  buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1',
  terms_hash: 'bhash-1',
})

const select = (over = {}) => selectBuyerOffer({
  dispositionAuthorization: DISPOSITION_ACTIVE,
  buyerOffer: SUBMITTED_OFFER,
  opportunity: OPPORTUNITY,
  actor: 'operator-1',
  ...over,
})

const commit = (over = {}) => authorizeBuyerCommitment({
  dispositionAuthorization: DISPOSITION_ACTIVE,
  buyerOffer: SELECTED_OFFER,
  opportunity: OPPORTUNITY,
  commitmentEvidence: COMMITMENT_EVIDENCE,
  ...over,
})

// ── §29 nothing below commitment reaches S8 ───────────────────────────────

test('S8: a buyer MATCH cannot create an offer, a selection or S8', () => {
  // buyer_match_candidates is read-only intelligence.
  assert.equal(resolveBuyerEngagementStage(BUYER_ENGAGEMENT.MATCHED).advances_beyond_s7, false)
  const c = commit({ buyerOffer: null })
  assert.equal(c.committed, false)
  assert.equal(c.reason, BUYER_DENIALS.NO_BUYER_OFFER)
})

test('S8: buyer INTEREST is not an offer', () => {
  assert.equal(resolveBuyerEngagementStage(BUYER_ENGAGEMENT.INTERESTED).advances_beyond_s7, false)
  // "I'm interested" carries no price, no timing, no buyer binding.
  const completeness = resolveBuyerOfferCompleteness({ buyer_id: 'buyer-1' })
  assert.equal(completeness.ok, false)
  assert.ok(completeness.missing.includes('offer_price'))
})

test('S8: a SUBMITTED offer stays at S7', () => {
  const c = commit({ buyerOffer: SUBMITTED_OFFER })
  assert.equal(c.committed, false)
  assert.equal(c.reason, BUYER_DENIALS.NOT_SELECTED)
  assert.equal(c.stage, 'disposition')
})

test('S8: the HIGHEST offer does not win by itself', () => {
  const comparison = compareBuyerOffers([
    { ...SUBMITTED_OFFER, buyer_offer_id: 'b1', buyer_id: 'buyer-1', offer_price: 95_000, pof_status: BUYER_POF_STATUS.NOT_PROVIDED },
    { ...SUBMITTED_OFFER, buyer_offer_id: 'b2', buyer_id: 'buyer-2', offer_price: 80_000,
      pof_status: BUYER_POF_STATUS.VERIFIED, pof_verified_by: 'op-1', pof_verified_at: '2026-09-12T00:00:00Z' },
  ])
  // A verified-funds buyer at 80k outranks an unverified one at 95k.
  assert.equal(comparison.ranked[0].buyer_offer_id, 'b2')
  // And critically: a comparison never selects.
  assert.equal(comparison.selects, false)
  assert.equal(comparison.requires_selection_authority, true)
})

test('S8: POF attached and POF verified both stay at S7', () => {
  assert.equal(resolveBuyerPof({ pof_status: BUYER_POF_STATUS.ATTACHED }).buyer_committed, false)
  const verified = resolveBuyerPof({
    pof_status: BUYER_POF_STATUS.VERIFIED, pof_verified_by: 'op-1', pof_verified_at: '2026-09-12T00:00:00Z',
  })
  assert.equal(verified.qualified, true)
  assert.equal(verified.buyer_committed, false, 'POF verification is qualification, never commitment')
})

test('S8: an expired POF is not verified however it is labelled', () => {
  const r = resolveBuyerPof({
    pof_status: BUYER_POF_STATUS.VERIFIED, pof_verified_by: 'op-1',
    pof_verified_at: '2026-01-01T00:00:00Z', pof_expires_at: '2026-02-01T00:00:00Z',
  }, new Date('2026-09-13T00:00:00Z'))
  assert.equal(r.status, BUYER_POF_STATUS.EXPIRED)
  assert.equal(r.qualified, false)
})

// ── §3 / §16 selection is not commitment ──────────────────────────────────

test('S8: SELECTION succeeds and stays at S7, pending a buyer agreement', () => {
  const s = select()
  assert.equal(s.selected, true)
  assert.equal(s.stage, 'disposition', 'selection must not advance the stage')
  assert.equal(s.commitment_status, BUYER_COMMITMENT_STATUS.AGREEMENT_REQUIRED)
  assert.equal(s.required_commitment_type, COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT)
})

test('S8: a selected buyer with no agreement is NOT committed', () => {
  const c = commit({ commitmentEvidence: null })
  assert.equal(c.committed, false)
  assert.equal(c.reason, BUYER_DENIALS.NO_COMMITMENT_EVIDENCE)
  assert.equal(c.commitment_status, BUYER_COMMITMENT_STATUS.AGREEMENT_REQUIRED)
  assert.equal(c.stage, 'disposition')
})

test('S8: partial commitment evidence is not commitment', () => {
  for (const drop of ['commitment_event_id', 'agreement_id', 'executed_at', 'commitment_type']) {
    const evidence = { ...COMMITMENT_EVIDENCE, [drop]: null }
    assert.equal(commit({ commitmentEvidence: evidence }).committed, false, `missing ${drop} still committed`)
  }
})

test('S8: a durable buyer agreement IS commitment and authorizes under_contract', () => {
  const c = commit()
  assert.equal(c.committed, true)
  assert.equal(c.stage, 'under_contract')
  assert.equal(c.commitment_status, BUYER_COMMITMENT_STATUS.COMMITTED)
  assert.equal(c.commitment_event_id, 'commit-evt-1')
})

test('S8: an agreement binding a DIFFERENT offer or terms hash is refused', () => {
  assert.equal(commit({
    commitmentEvidence: { ...COMMITMENT_EVIDENCE, buyer_offer_id: 'buyer_offer:opp-A:buyer-2:v1' },
  }).reason, BUYER_DENIALS.COMMITMENT_EVIDENCE_MISMATCH)
  assert.equal(commit({
    commitmentEvidence: { ...COMMITMENT_EVIDENCE, terms_hash: 'bhash-OTHER' },
  }).reason, BUYER_DENIALS.COMMITMENT_EVIDENCE_MISMATCH)
})

// ── §13 who may select ────────────────────────────────────────────────────

test('S8: selection requires a named actor — automation may not award a deal', () => {
  const s = select({ actor: null })
  assert.equal(s.selected, false)
  assert.equal(s.reason, BUYER_DENIALS.NO_SELECTION_ACTOR)
})

// ── §12 selection preconditions ───────────────────────────────────────────

test('S8: selection requires ACTIVE disposition', () => {
  const s = select({ dispositionAuthorization: DISPOSITION_PREPARATION })
  assert.equal(s.selected, false)
  assert.equal(s.reason, BUYER_DENIALS.DISPOSITION_NOT_ACTIVE)
})

test('S8: a withdrawn, rejected or superseded offer cannot be selected', () => {
  for (const [status, reason] of [
    [BUYER_OFFER_STATUS.WITHDRAWN, BUYER_DENIALS.OFFER_WITHDRAWN],
    [BUYER_OFFER_STATUS.REJECTED, BUYER_DENIALS.OFFER_REJECTED],
    [BUYER_OFFER_STATUS.SUPERSEDED, BUYER_DENIALS.OFFER_SUPERSEDED],
  ]) {
    assert.equal(select({ buyerOffer: { ...SUBMITTED_OFFER, status } }).reason, reason)
  }
})

test('S8: an incomplete offer cannot be selected', () => {
  const s = select({ buyerOffer: { ...SUBMITTED_OFFER, closing_window_days: null, closing_date: null } })
  assert.equal(s.selected, false)
  assert.ok(s.evidence.missing_terms.includes('closing_timing'))
})

// ── §7 / §29 multi-property and binding ───────────────────────────────────

test('S8: an offer bound to another property cannot be selected or committed', () => {
  assert.equal(select({ buyerOffer: { ...SUBMITTED_OFFER, property_id: 'prop-B' } }).reason, BUYER_DENIALS.BINDING_MISMATCH)
  assert.equal(commit({ buyerOffer: { ...SELECTED_OFFER, property_id: 'prop-B' } }).reason, BUYER_DENIALS.BINDING_MISMATCH)
})

test('S8: an offer bound to another opportunity cannot commit', () => {
  assert.equal(commit({ buyerOffer: { ...SELECTED_OFFER, opportunity_id: 'opp-B' } }).reason, BUYER_DENIALS.BINDING_MISMATCH)
})

test('S8: a multi-property buyer commits only on the addressed deal', () => {
  const dealB = { ...SELECTED_OFFER, opportunity_id: 'opp-B', property_id: 'prop-B',
    buyer_offer_id: 'buyer_offer:opp-B:buyer-1:v1' }
  assert.equal(commit().committed, true)
  assert.equal(commit({ buyerOffer: dealB }).committed, false)
})

// ── §22 seller contract invalidation ──────────────────────────────────────

test('S8: an invalid seller deal blocks selection and commitment', () => {
  const dead = { authorized: false, external_activity_permitted: false, disposition_state: 'cancelled' }
  assert.equal(select({ dispositionAuthorization: dead }).selected, false)
  assert.equal(commit({ dispositionAuthorization: dead }).committed, false)
})

// ── §27 closing_case cannot fabricate S8 ──────────────────────────────────

test('S8: closing_case buyer fields cannot fabricate commitment', () => {
  // A buyer_id, buyer_price, assignment_id or buyer_emd appearing on a closing
  // case is a PROJECTION of the selected offer. None of them is evidence.
  const c = authorizeBuyerCommitment({
    dispositionAuthorization: DISPOSITION_ACTIVE,
    buyerOffer: null,
    opportunity: OPPORTUNITY,
    dispositionCase: {
      closing_case_id: 'closing:opp-A',
      buyer_id: 'buyer-1', buyer_price: 80_000, assignment_id: 'asg-1', buyer_emd: 5_000,
    },
  })
  assert.equal(c.committed, false)
  assert.equal(c.reason, BUYER_DENIALS.NO_BUYER_OFFER)
})

test('S8: selection PROJECTS onto the closing case rather than reading from it', () => {
  const s = select()
  assert.deepEqual(s.closing_case_projection, {
    buyer_id: 'buyer-1', buyer_price: 80_000, buyer_emd: 5_000, disposition_status: 'buyer_selected',
  })
})

// ── §24 idempotency ───────────────────────────────────────────────────────

test('S8: the same submission yields one deterministic offer identity', () => {
  const ids = new Set(Array.from({ length: 10 }, () =>
    buildBuyerOfferId({ opportunity_id: 'opp-A', buyer_id: 'buyer-1', offer_version: 1 })))
  assert.equal(ids.size, 1)
  assert.equal([...ids][0], 'buyer_offer:opp-A:buyer-1:v1')
})

test('S8: the same selection processed 10x yields one selected buyer', () => {
  const results = Array.from({ length: 10 }, () => select())
  assert.equal(new Set(results.map((r) => r.buyer_offer_id)).size, 1)
  assert.equal(new Set(results.map((r) => r.commitment_status)).size, 1)
})

test('S8: the same commitment event processed 10x yields one S8 transition', () => {
  const results = Array.from({ length: 10 }, () => commit())
  assert.equal(new Set(results.map((r) => r.commitment_event_id)).size, 1)
  assert.equal(new Set(results.map((r) => r.stage)).size, 1)
  assert.equal(results[0].stage, 'under_contract')
})

// ── §23 terms hash ────────────────────────────────────────────────────────

test('S8 HASH: identical buyer terms hash identically', () => {
  const terms = { opportunity_id: 'opp-A', buyer_id: 'buyer-1', offer_price: 80_000, strategy: 'assignment', emd_amount: 5_000, closing_window_days: 14 }
  assert.equal(buildBuyerTermsHash(terms), buildBuyerTermsHash({ ...terms }))
})

test('S8 HASH: every material buyer change produces a new hash', () => {
  const base = { opportunity_id: 'opp-A', buyer_id: 'buyer-1', offer_price: 80_000, strategy: 'assignment', emd_amount: 5_000, closing_window_days: 14 }
  const h = buildBuyerTermsHash(base)
  assert.notEqual(h, buildBuyerTermsHash({ ...base, offer_price: 85_000 }))
  assert.notEqual(h, buildBuyerTermsHash({ ...base, emd_amount: 10_000 }))
  assert.notEqual(h, buildBuyerTermsHash({ ...base, closing_window_days: 30 }))
  assert.notEqual(h, buildBuyerTermsHash({ ...base, strategy: 'double_close' }))
})

test('S8 HASH: non-material metadata does not perturb the hash', () => {
  const base = { opportunity_id: 'opp-A', buyer_id: 'buyer-1', offer_price: 80_000 }
  assert.equal(
    buildBuyerTermsHash({ ...base, source: 'email', metadata: { a: 1 } }),
    buildBuyerTermsHash({ ...base, source: 'portal', metadata: { b: 2 } }),
  )
})

// ── §20 EMD ───────────────────────────────────────────────────────────────

test('S8 EMD: an amount is terms, not receipt', () => {
  const promised = resolveEmdPosition({ emd_amount: 5_000, emd_status: EMD_STATUS.PROMISED })
  assert.equal(promised.amount_terms, 5_000)
  assert.equal(promised.received, false)
  assert.equal(promised.buyer_committed, false)
})

test('S8 EMD: received and verified are receipt; neither is commitment', () => {
  for (const status of [EMD_STATUS.RECEIVED, EMD_STATUS.VERIFIED]) {
    const r = resolveEmdPosition({ emd_amount: 5_000, emd_status: status, emd_received_at: '2026-09-13T00:00:00Z' })
    assert.equal(r.received, true)
    assert.equal(r.buyer_committed, false, 'money arriving is not a signed agreement')
  }
})

// ── §17 strategy-aware commitment ─────────────────────────────────────────

test('S8: the required agreement varies by disposition structure', () => {
  assert.equal(select().required_commitment_type, COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT)
  assert.equal(
    select({ buyerOffer: { ...SUBMITTED_OFFER, strategy: 'double_close', assignment_price: 80_000 } }).required_commitment_type,
    COMMITMENT_TYPES.PURCHASE_AGREEMENT,
  )
  assert.equal(
    select({ buyerOffer: { ...SUBMITTED_OFFER, strategy: 'novation' } }).required_commitment_type,
    COMMITMENT_TYPES.NOVATION_AGREEMENT,
  )
})

// ── §19 economics ─────────────────────────────────────────────────────────

test('S8 ECONOMICS: the spread is deterministic and net proceeds are not fabricated', () => {
  const e = resolveDispositionEconomics({ acceptedSellerPrice: 62_300, buyerOffer: SUBMITTED_OFFER })
  assert.equal(e.seller_acquisition_price, 62_300)
  assert.equal(e.buyer_price, 80_000)
  assert.equal(e.gross_spread, 17_700)
  assert.equal(e.net_proceeds, null)
  assert.equal(e.net_proceeds_reason, 'closing_costs_unknown')
})

// ── §21 failure ───────────────────────────────────────────────────────────

test('S8: a selected buyer withdrawing before commitment stays at S7', () => {
  const r = resolveBuyerFailure({ buyerOffer: SELECTED_OFFER, failure: 'withdrawn' })
  assert.equal(r.stage, 'disposition')
  assert.equal(r.selection_released, true)
  assert.equal(r.stage_regressed, false)
})

test('S8: a committed buyer defaulting does not casually rewind the stage', () => {
  const r = resolveBuyerFailure({
    buyerOffer: { ...SELECTED_OFFER, status: BUYER_OFFER_STATUS.COMMITTED }, failure: 'defaulted',
  })
  assert.equal(r.stage, 'under_contract')
  assert.equal(r.stage_regressed, false)
  assert.equal(r.commitment_status, BUYER_COMMITMENT_STATUS.REPLACEMENT_REQUIRED)
  // The gap is reported rather than silently assumed handled.
  assert.equal(r.replacement_workflow_implemented, false)
})

// ── §31 S9 handoff ────────────────────────────────────────────────────────

const EXECUTED_CASE = Object.freeze({
  closing_case_id: 'closing:opp-A', contract_status: 'fully_executed',
  docusign_envelope_id: 'env-1', contract_signed_date: '2026-09-13T00:00:00.000Z',
})

const ACCEPTED_SELLER_OFFER = Object.freeze({
  offer_id: 'offer:opp-A:v1', offer_version: 1, opportunity_id: 'opp-A', property_id: 'prop-A',
  status: 'accepted', purchase_price: 62_300, accepted_price: 62_300, terms_hash: 'hash-v1',
  sent_at: '2026-09-12T18:00:00.000Z', accepted_at: '2026-09-12T19:00:00.000Z',
  acceptance_event_id: 'evt-1', emd_amount: 1000, closing_date: '2026-09-26', strategy: 'cash', metadata: {},
})

test('S8 → S9: the handoff carries seller, buyer, economics and contract truth', () => {
  const dispositionHandoff = buildDispositionHandoff({
    opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_SELLER_OFFER, closingCase: EXECUTED_CASE,
  })
  assert.equal(dispositionHandoff.ok, true)

  const handoff = buildBuyerCommitmentHandoff({
    dispositionHandoff, buyerOffer: SELECTED_OFFER, commitment: commit(),
  })

  assert.equal(handoff.ok, true)
  assert.equal(handoff.stage, 'under_contract')
  assert.equal(handoff.seller.accepted_offer_id, 'offer:opp-A:v1')
  assert.equal(handoff.seller.seller_contract_status, 'fully_executed')
  assert.equal(handoff.buyer.selected_buyer_id, 'buyer-1')
  assert.equal(handoff.buyer.buyer_commitment_status, BUYER_COMMITMENT_STATUS.COMMITTED)
  assert.equal(handoff.buyer.buyer_terms_hash, 'bhash-1')
  // EMD terms are carried WITHOUT claiming receipt.
  assert.equal(handoff.buyer.emd_terms, 5_000)
  assert.equal(handoff.buyer.emd_received, false)
  assert.equal(handoff.economics.gross_spread, 17_700)
  assert.equal(handoff.contract.agreement_id, 'assignment-agreement-1')
})

test('S8 → S9: no handoff exists without commitment', () => {
  const dispositionHandoff = buildDispositionHandoff({
    opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_SELLER_OFFER, closingCase: EXECUTED_CASE,
  })
  const handoff = buildBuyerCommitmentHandoff({
    dispositionHandoff, buyerOffer: SELECTED_OFFER, commitment: commit({ commitmentEvidence: null }),
  })
  assert.equal(handoff.ok, false)
  assert.equal(handoff.reason, BUYER_DENIALS.NO_COMMITMENT_EVIDENCE)
})
