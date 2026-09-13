import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUYER_ENGAGEMENT,
  DISPOSITION_DENIALS,
  DISPOSITION_HOLDS,
  DISPOSITION_STATES,
  SELLER_CONTRACT_STATES,
  authorizeActiveDisposition,
  authorizeDispositionPreparation,
  buildDispositionHandoff,
  resolveBuyerEngagementStage,
  resolveDispositionHolds,
  resolveSellerContractExecution,
} from '@/lib/domain/disposition/disposition-authority.js'
import { CLOSING_WORKFLOW_STEPS, CLOSING_EVENTS } from '@/lib/domain/closings/advance-closing-workflow.js'
import { resolveClosingStatusTransition } from '@/lib/domain/closings/reconcile-closing-case-from-envelope.js'

/**
 * S7.5 — SELLER CONTRACT EXECUTION / DISPOSITION ACTIVATION BOUNDARY.
 *
 * Seller ACCEPTANCE authorizes contract preparation.
 * Seller contract FULLY EXECUTED authorizes ACTIVE buyer disposition.
 *
 * Nothing external happens in between: no buyer SMS, email, publication or
 * campaign. A verbal yes is not a signed contract, and marketing a deal we have
 * not actually secured is the failure this boundary prevents.
 *
 *   seller_contract_fully_executed != buyer_under_contract
 *
 * `under_contract` is S8 — under contract with a SELECTED BUYER.
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

const caseAt = (contract_status, extra = {}) => ({
  closing_case_id: 'closing:opp-A',
  contract_status,
  docusign_envelope_id: 'env-1',
  contract_signed_date: contract_status === 'fully_executed' ? '2026-09-13T00:00:00.000Z' : null,
  ...extra,
})

const active = (over = {}) => authorizeActiveDisposition({
  opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_OFFER, ...over,
})

// ── The ladder: only execution opens external activity ────────────────────

test('S7.5: accepted terms with a draft contract permit preparation, not activation', () => {
  const prep = authorizeDispositionPreparation({
    opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_OFFER, closingCase: caseAt('draft'),
  })
  assert.equal(prep.authorized, true)
  assert.equal(prep.disposition_state, DISPOSITION_STATES.PREPARATION)
  assert.equal(prep.external_activity_permitted, false)

  const act = active({ closingCase: caseAt('draft') })
  assert.equal(act.authorized, false)
  assert.equal(act.reason, DISPOSITION_DENIALS.SELLER_CONTRACT_NOT_EXECUTED)
  assert.equal(act.external_activity_permitted, false)
})

test('S7.5: a contract SENT is not executed', () => {
  const act = active({ closingCase: caseAt('sent_for_signature') })
  assert.equal(act.authorized, false)
  assert.equal(act.disposition_state, DISPOSITION_STATES.PREPARATION)
})

test('S7.5: ONE signer is not a fully executed contract', () => {
  for (const status of ['viewed', 'seller_signed', 'buyer_signed']) {
    const act = active({ closingCase: caseAt(status) })
    assert.equal(act.authorized, false, `${status} activated disposition`)
    assert.equal(act.external_activity_permitted, false)
  }
})

test('S7.5: a fully executed seller contract activates disposition', () => {
  const act = active({ closingCase: caseAt('fully_executed') })
  assert.equal(act.authorized, true)
  assert.equal(act.disposition_state, DISPOSITION_STATES.ACTIVE)
  assert.equal(act.external_activity_permitted, true)
  assert.equal(act.canonical_stage, 'disposition')
})

test('S7.5: activation is AUTOMATIC — no operator step is required', () => {
  // A normal valid deal does not wait on a click.
  const act = active({ closingCase: caseAt('fully_executed') })
  assert.equal(act.authorized, true)
  assert.deepEqual(act.holds, [])
})

// ── §9 execution evidence ────────────────────────────────────────────────

test('S7.5: a closing case alone is not execution evidence', () => {
  const r = resolveSellerContractExecution({ closingCase: caseAt('draft') })
  assert.equal(r.executed, false)
  assert.equal(r.reason, DISPOSITION_DENIALS.SELLER_CONTRACT_NOT_EXECUTED)
})

test('S7.5: no closing case means no execution', () => {
  const r = resolveSellerContractExecution({ closingCase: null })
  assert.equal(r.executed, false)
  assert.equal(r.reason, DISPOSITION_DENIALS.NO_CLOSING_CASE)
})

test('S7.5: fully_executed with no traceable evidence is refused', () => {
  // A bare status flag is not enough — it must trace to an envelope, a signed
  // date, or the execution milestone.
  const r = resolveSellerContractExecution({
    closingCase: { closing_case_id: 'c', contract_status: 'fully_executed' },
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, DISPOSITION_DENIALS.NO_EXECUTION_EVIDENCE)
})

test('S7.5: the execution milestone is acceptable evidence', () => {
  const r = resolveSellerContractExecution({
    closingCase: { closing_case_id: 'c', contract_status: 'fully_executed' },
    executionEvidence: { milestone_type: 'contract_fully_executed' },
  })
  assert.equal(r.executed, true)
})

// ── §3 the under_contract overload is gone ───────────────────────────────

test('S7.5: contract execution writes disposition, NEVER under_contract', () => {
  const step = CLOSING_WORKFLOW_STEPS[CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED]
  assert.equal(step.patch.contract_status, 'fully_executed')
  assert.equal(step.patch.universal_stage, 'disposition')
  assert.notEqual(step.patch.universal_stage, 'under_contract')
})

test('S7.5: a completed DocuSign envelope writes disposition, NEVER under_contract', () => {
  const t = resolveClosingStatusTransition({ normalized_status: 'Completed', current_contract_status: 'seller_signed' })
  assert.equal(t.apply, true)
  assert.equal(t.target.contract_status, 'fully_executed')
  assert.equal(t.target.universal_stage, 'disposition')
})

test('S7.5: no closing workflow step produces under_contract', () => {
  const stages = Object.values(CLOSING_WORKFLOW_STEPS).map((s) => s.patch?.universal_stage).filter(Boolean)
  assert.ok(!stages.includes('under_contract'), `a step still writes under_contract: ${stages.join(',')}`)
})

test('S7.5: under_contract stays reserved for S8 buyer-side commitment', () => {
  const selected = resolveBuyerEngagementStage(BUYER_ENGAGEMENT.SELECTED)
  assert.equal(selected.stage, 'under_contract')
  assert.equal(selected.requires_s8_authority, true)
})

// ── §6 holds ─────────────────────────────────────────────────────────────

test('S7.5: a paused opportunity holds activation without invalidating the deal', () => {
  const act = active({
    opportunity: { ...OPPORTUNITY, opportunity_status: 'paused' },
    closingCase: caseAt('fully_executed'),
  })
  assert.equal(act.authorized, false)
  assert.equal(act.disposition_state, DISPOSITION_STATES.HELD)
  assert.equal(act.external_activity_permitted, false)
  assert.ok(act.holds.includes(DISPOSITION_HOLDS.OPPORTUNITY_PAUSED))
})

test('S7.5: a pending approval holds activation', () => {
  const act = active({
    opportunity: { ...OPPORTUNITY, approval_state: 'pending' },
    closingCase: caseAt('fully_executed'),
  })
  assert.equal(act.disposition_state, DISPOSITION_STATES.HELD)
  assert.ok(act.holds.includes(DISPOSITION_HOLDS.APPROVAL_PENDING))
})

test('S7.5: an approved approval does not hold', () => {
  const act = active({
    opportunity: { ...OPPORTUNITY, approval_state: 'approved' },
    closingCase: caseAt('fully_executed'),
  })
  assert.equal(act.authorized, true)
})

test('S7.5: an explicit operator or legal hold blocks external activity', () => {
  for (const field of ['operator_hold', 'legal_hold']) {
    const act = active({
      opportunity: { ...OPPORTUNITY, [field]: true },
      closingCase: caseAt('fully_executed'),
    })
    assert.equal(act.external_activity_permitted, false, `${field} did not hold`)
    assert.ok(act.holds.includes(DISPOSITION_HOLDS.OPERATOR_HOLD))
  }
})

test('S7.5: holds are computed from existing row vocabulary', () => {
  assert.deepEqual(resolveDispositionHolds({ opportunity: OPPORTUNITY }), [])
  assert.ok(resolveDispositionHolds({
    opportunity: OPPORTUNITY, closingCase: caseAt('declined'),
  }).includes(DISPOSITION_HOLDS.CONTRACT_TERMINAL))
})

// ── §8 void / cancellation ───────────────────────────────────────────────

test('S7.5: a cancelled seller contract stops active disposition', () => {
  const act = active({ closingCase: caseAt('cancelled') })
  assert.equal(act.authorized, false)
  assert.equal(act.external_activity_permitted, false)
})

test('S7.5: a voided accepted offer stops active disposition', () => {
  const act = active({
    acceptedOffer: { ...ACCEPTED_OFFER, metadata: { voided: true } },
    closingCase: caseAt('fully_executed'),
  })
  assert.equal(act.authorized, false)
  assert.equal(act.reason, DISPOSITION_DENIALS.SELLER_DEAL_VOIDED)
})

// ── §7 idempotency ───────────────────────────────────────────────────────

test('S7.5: the same execution processed 10x yields one activation identity', () => {
  const results = Array.from({ length: 10 }, () => active({ closingCase: caseAt('fully_executed') }))
  assert.equal(new Set(results.map((r) => r.disposition_case_id)).size, 1)
  assert.equal(new Set(results.map((r) => r.disposition_state)).size, 1)
  assert.equal(results[0].disposition_state, DISPOSITION_STATES.ACTIVE)
})

// ── §13 pre-execution buyer work ─────────────────────────────────────────

test('S7.5: buyer matching before execution never activates external disposition', () => {
  // Internal matching may be computed at preparation; it changes nothing.
  const act = active({ closingCase: caseAt('draft'), buyerMatches: [{ buyer_id: 'b1' }, { buyer_id: 'b2' }] })
  assert.equal(act.external_activity_permitted, false)
  for (const level of [BUYER_ENGAGEMENT.MATCHED, BUYER_ENGAGEMENT.INTERESTED, BUYER_ENGAGEMENT.OFFER_SUBMITTED]) {
    assert.equal(resolveBuyerEngagementStage(level).advances_beyond_s7, false)
  }
})

test('S7.5: a stale thread projection cannot substitute for execution', () => {
  // thread says disposition; canonical is S6 with only a draft contract.
  const act = active({ closingCase: caseAt('draft'), threadLifecycleStage: 'disposition' })
  assert.equal(act.authorized, false)
  assert.equal(act.reason, DISPOSITION_DENIALS.SELLER_CONTRACT_NOT_EXECUTED)
})

// ── §12 handoff ──────────────────────────────────────────────────────────

test('S7.5 → S8: the handoff exists only after execution and carries its evidence', () => {
  const blocked = buildDispositionHandoff({
    opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_OFFER, closingCase: caseAt('sent_for_signature'),
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.disposition_state, DISPOSITION_STATES.PREPARATION)

  const handoff = buildDispositionHandoff({
    opportunity: OPPORTUNITY, acceptedOffer: ACCEPTED_OFFER, closingCase: caseAt('fully_executed'),
  })
  assert.equal(handoff.ok, true)
  assert.equal(handoff.seller_contract_status, SELLER_CONTRACT_STATES.FULLY_EXECUTED)
  assert.equal(handoff.disposition_status, DISPOSITION_STATES.ACTIVE)
  assert.equal(handoff.seller_contract_execution.docusign_envelope_id, 'env-1')
  assert.equal(handoff.acquisition_basis.accepted_offer_id, 'offer:opp-A:v1')
  assert.equal(handoff.selected_buyer_id, null)
})
