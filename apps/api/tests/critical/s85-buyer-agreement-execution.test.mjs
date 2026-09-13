import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGREEMENT_DENIALS,
  AGREEMENT_PAYLOAD_FORBIDDEN,
  AGREEMENT_STATUS,
  assertSellerSideStillValid,
  authorizeBuyerAgreementGeneration,
  buildAgreementPayload,
  buildBuyerAgreementId,
  buildBuyerCommitmentEvent,
  buildClosingCaseProjection,
  resolveAgreementExecution,
  resolveAgreementStatusTransition,
  resolveRequiredAgreementType,
  resolveRequiredSigners,
} from '@/lib/domain/disposition/buyer-agreement-authority.js'
import {
  BUYER_COMMITMENT_STATUS,
  BUYER_OFFER_STATUS,
  COMMITMENT_TYPES,
  authorizeBuyerCommitment,
} from '@/lib/domain/disposition/buyer-commitment-authority.js'

/**
 * S8.5 — BUYER AGREEMENT EXECUTION AUTHORITY.
 *
 * The chain that makes S8 reachable:
 *   buyer_offer -> buyer_agreement -> buyer commitment -> S8 under_contract
 *
 * A provider webhook never writes S8. It reconciles an agreement; the agreement
 * emits one commitment event; S8's existing authority verifies it against the
 * offer. Generated, sent, viewed and partially signed are all still S7.
 */

const OPPORTUNITY = Object.freeze({
  id: 'opp-A', primary_property_id: 'prop-A',
  acquisition_stage: 'formal_contract', opportunity_status: 'active',
})

const DISPOSITION_ACTIVE = Object.freeze({
  authorized: true, external_activity_permitted: true,
  disposition_state: 'active', disposition_case_id: 'closing:opp-A',
})

const DISPOSITION_DEAD = Object.freeze({
  authorized: false, external_activity_permitted: false, disposition_state: 'cancelled',
})

const SELECTED_OFFER = Object.freeze({
  buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1',
  offer_version: 1,
  opportunity_id: 'opp-A',
  property_id: 'prop-A',
  buyer_id: 'buyer-1',
  offer_price: 80_000,
  strategy: 'assignment',
  emd_amount: 5_000,
  emd_status: 'promised',
  closing_window_days: 14,
  terms_hash: 'bhash-1',
  status: BUYER_OFFER_STATUS.SELECTED,
})

const generate = (over = {}) => authorizeBuyerAgreementGeneration({
  dispositionAuthorization: DISPOSITION_ACTIVE,
  buyerOffer: SELECTED_OFFER,
  opportunity: OPPORTUNITY,
  templateId: 'tmpl-assignment-v3',
  templateVersion: 'v3',
  ...over,
})

/** An agreement whose provider envelope has completed, both parties signed. */
const executedAgreement = (over = {}) => ({
  ...generate().agreement,
  provider_envelope_id: 'env-buyer-1',
  status: AGREEMENT_STATUS.FULLY_EXECUTED,
  executed_at: '2026-09-13T12:00:00.000Z',
  ...over,
})

const ENVELOPE_COMPLETE = Object.freeze({
  envelope_id: 'env-buyer-1',
  normalized_status: 'Completed',
  completed_at: '2026-09-13T12:00:00.000Z',
  completed_signers: [{ role: 'assignor' }, { role: 'assignee' }],
})

// ── §23 generation gate ───────────────────────────────────────────────────

test('S8.5: a SELECTED offer may generate an agreement, and stays at S7', () => {
  const r = generate()
  assert.equal(r.authorized, true)
  assert.equal(r.stage, 'disposition', 'generating a document must not advance the stage')
  assert.equal(r.agreement.agreement_type, COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT)
  assert.equal(r.agreement.buyer_terms_hash, 'bhash-1')
  assert.equal(r.agreement.status, AGREEMENT_STATUS.DRAFT)
})

test('S8.5: a merely SUBMITTED offer cannot generate an authoritative agreement', () => {
  const r = generate({ buyerOffer: { ...SELECTED_OFFER, status: BUYER_OFFER_STATUS.SUBMITTED } })
  assert.equal(r.authorized, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.OFFER_NOT_SELECTED)
})

test('S8.5: generation requires active disposition', () => {
  assert.equal(generate({ dispositionAuthorization: DISPOSITION_DEAD }).reason, AGREEMENT_DENIALS.DISPOSITION_NOT_ACTIVE)
})

test('S8.5: generation requires a template — no template, no document', () => {
  assert.equal(generate({ templateId: null }).reason, AGREEMENT_DENIALS.MISSING_TEMPLATE)
})

test('S8.5: an unsupported strategy returns buyer_agreement_unsupported and stays S7', () => {
  const r = generate({ buyerOffer: { ...SELECTED_OFFER, strategy: 'lease_option' } })
  assert.equal(r.authorized, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.UNSUPPORTED_STRATEGY)
  assert.equal(r.stage, 'disposition')
  // The wrong template is never substituted to let a deal advance.
  assert.equal(resolveRequiredAgreementType('lease_option'), null)
})

test('S8.5: a mis-bound offer cannot generate an agreement', () => {
  assert.equal(generate({ buyerOffer: { ...SELECTED_OFFER, property_id: 'prop-B' } }).reason, AGREEMENT_DENIALS.BINDING_MISMATCH)
  assert.equal(generate({ buyerOffer: { ...SELECTED_OFFER, opportunity_id: 'opp-B' } }).reason, AGREEMENT_DENIALS.BINDING_MISMATCH)
})

// ── §3 strategy → agreement type ──────────────────────────────────────────

test('S8.5: each supported strategy maps to its own agreement type', () => {
  assert.equal(resolveRequiredAgreementType('assignment'), COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT)
  assert.equal(resolveRequiredAgreementType('double_close'), COMMITMENT_TYPES.PURCHASE_AGREEMENT)
  assert.equal(resolveRequiredAgreementType('novation'), COMMITMENT_TYPES.NOVATION_AGREEMENT)
})

// ── §8 idempotent generation ──────────────────────────────────────────────

test('S8.5: the same selected offer yields one deterministic agreement id', () => {
  const ids = new Set(Array.from({ length: 10 }, () => generate().agreement.agreement_id))
  assert.equal(ids.size, 1)
  assert.equal([...ids][0], 'buyer_agreement:buyer_offer:opp-A:buyer-1:v1:v1')
})

test('S8.5: an ACTIVE agreement blocks a second one for the same offer', () => {
  for (const status of [AGREEMENT_STATUS.DRAFT, AGREEMENT_STATUS.SENT, AGREEMENT_STATUS.BUYER_SIGNED, AGREEMENT_STATUS.FULLY_EXECUTED]) {
    const r = generate({ existingAgreement: { agreement_id: 'a1', agreement_version: 1, status } })
    assert.equal(r.authorized, false, `${status} allowed a second envelope`)
    assert.equal(r.reason, AGREEMENT_DENIALS.ACTIVE_AGREEMENT_EXISTS)
  }
})

test('S8.5: a terminal prior agreement produces a NEW version, preserving history', () => {
  for (const status of [AGREEMENT_STATUS.DECLINED, AGREEMENT_STATUS.VOIDED, AGREEMENT_STATUS.EXPIRED, AGREEMENT_STATUS.SUPERSEDED]) {
    const r = generate({ existingAgreement: { agreement_id: 'a1', agreement_version: 1, status } })
    assert.equal(r.authorized, true, `${status} blocked regeneration`)
    assert.equal(r.agreement.agreement_version, 2)
  }
})

// ── §10 signers ───────────────────────────────────────────────────────────

test('S8.5: one buyer email is not all required signatures', () => {
  const assignment = resolveRequiredSigners({ agreementType: COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT, buyerOffer: SELECTED_OFFER })
  assert.deepEqual(assignment.map((s) => s.role), ['assignor', 'assignee'])
  const novation = resolveRequiredSigners({ agreementType: COMMITMENT_TYPES.NOVATION_AGREEMENT, buyerOffer: SELECTED_OFFER })
  assert.deepEqual(novation.map((s) => s.role), ['assignor', 'buyer', 'original_seller'])
})

test('S8.5: the buyer signing alone is NOT execution', () => {
  const agreement = executedAgreement({ status: AGREEMENT_STATUS.BUYER_SIGNED, executed_at: null })
  const r = resolveAgreementExecution({
    agreement,
    envelope: { envelope_id: 'env-buyer-1', normalized_status: 'Delivered', completed_signers: [{ role: 'assignee' }] },
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.NOT_FULLY_EXECUTED)
})

test('S8.5: provider completion with a missing required signer is NOT execution', () => {
  const r = resolveAgreementExecution({
    agreement: executedAgreement({ status: AGREEMENT_STATUS.BUYER_SIGNED }),
    envelope: { ...ENVELOPE_COMPLETE, completed_signers: [{ role: 'assignee' }] },
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.SIGNERS_INCOMPLETE)
  assert.deepEqual(r.outstanding_signers, ['assignor'])
})

test('S8.5: provider completion with every required signer IS execution', () => {
  const r = resolveAgreementExecution({ agreement: executedAgreement(), envelope: ENVELOPE_COMPLETE })
  assert.equal(r.executed, true)
  assert.equal(r.provider_envelope_id, 'env-buyer-1')
})

// ── §11 status ladder ─────────────────────────────────────────────────────

test('S8.5: agreement status is monotonic — a late lower event is a no-op', () => {
  const forward = resolveAgreementStatusTransition({ normalized_status: 'Completed', current_status: AGREEMENT_STATUS.BUYER_SIGNED })
  assert.equal(forward.apply, true)
  const backward = resolveAgreementStatusTransition({ normalized_status: 'Sent', current_status: AGREEMENT_STATUS.FULLY_EXECUTED })
  assert.equal(backward.apply, false)
})

test('S8.5: a terminal agreement ignores further provider events', () => {
  const r = resolveAgreementStatusTransition({ normalized_status: 'Completed', current_status: AGREEMENT_STATUS.VOIDED })
  assert.equal(r.apply, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.AGREEMENT_TERMINAL)
})

// ── §5 exact-offer binding ────────────────────────────────────────────────

test('S8.5: an envelope belonging to another agreement cannot execute this one', () => {
  const r = resolveAgreementExecution({
    agreement: executedAgreement(),
    envelope: { ...ENVELOPE_COMPLETE, envelope_id: 'env-OTHER' },
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.ENVELOPE_MISMATCH)
})

test('S8.5: terms drift after generation blocks the commitment event', () => {
  const event = buildBuyerCommitmentEvent({
    agreement: executedAgreement(),
    execution: resolveAgreementExecution({ agreement: executedAgreement(), envelope: ENVELOPE_COMPLETE }),
    buyerOffer: { ...SELECTED_OFFER, terms_hash: 'bhash-CHANGED' },
  })
  assert.equal(event.ok, false)
  assert.equal(event.reason, AGREEMENT_DENIALS.TERMS_DRIFTED)
})

test('S8.5: an agreement bound to another buyer offer cannot commit this one', () => {
  const event = buildBuyerCommitmentEvent({
    agreement: executedAgreement({ buyer_offer_id: 'buyer_offer:opp-A:buyer-2:v1' }),
    execution: resolveAgreementExecution({ agreement: executedAgreement(), envelope: ENVELOPE_COMPLETE }),
    buyerOffer: SELECTED_OFFER,
  })
  assert.equal(event.ok, false)
  assert.equal(event.reason, AGREEMENT_DENIALS.BINDING_MISMATCH)
})

test('S8.5: a SUPERSEDED agreement completing late cannot steal the deal back', () => {
  const r = resolveAgreementExecution({
    agreement: executedAgreement({ status: AGREEMENT_STATUS.SUPERSEDED }),
    envelope: ENVELOPE_COMPLETE,
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, AGREEMENT_DENIALS.AGREEMENT_SUPERSEDED)
})

// ── §13 / §23 the full chain into S8 ──────────────────────────────────────

function commitmentFrom(agreementOver = {}, envelope = ENVELOPE_COMPLETE) {
  const agreement = executedAgreement(agreementOver)
  const execution = resolveAgreementExecution({ agreement, envelope })
  const event = buildBuyerCommitmentEvent({ agreement, execution, buyerOffer: SELECTED_OFFER })
  if (!event.ok) return { event, commitment: null }
  const commitment = authorizeBuyerCommitment({
    dispositionAuthorization: DISPOSITION_ACTIVE,
    buyerOffer: SELECTED_OFFER,
    opportunity: OPPORTUNITY,
    commitmentEvidence: {
      commitment_event_id: event.commitment_event_id,
      agreement_id: event.agreement_id,
      commitment_type: event.commitment_type,
      executed_at: event.executed_at,
      buyer_offer_id: event.buyer_offer_id,
      terms_hash: event.terms_hash,
    },
  })
  return { event, commitment }
}

test('S8.5 → S8: a correctly executed agreement produces commitment and under_contract', () => {
  const { event, commitment } = commitmentFrom()
  assert.equal(event.ok, true)
  assert.equal(commitment.committed, true)
  assert.equal(commitment.stage, 'under_contract')
  assert.equal(commitment.commitment_status, BUYER_COMMITMENT_STATUS.COMMITTED)
})

test('S8.5 → S8: the commitment event is deterministic, so 10 webhooks give one', () => {
  const ids = new Set(Array.from({ length: 10 }, () => commitmentFrom().event.commitment_event_id))
  assert.equal(ids.size, 1)
  const stages = new Set(Array.from({ length: 10 }, () => commitmentFrom().commitment.stage))
  assert.equal(stages.size, 1)
})

test('S8.5 → S8: S8 never inspects provider payloads — it receives domain evidence', () => {
  const { event } = commitmentFrom()
  // The provider detail is normalized into an evidence envelope, not passed raw.
  assert.equal(event.provider_execution_evidence.provider, 'docusign')
  assert.equal(event.provider_execution_evidence.provider_envelope_id, 'env-buyer-1')
  assert.equal(event.commitment_type, COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT)
})

// ── §16 seller invalidation ───────────────────────────────────────────────

test('S8.5: a late completion cannot commit when the seller contract died meanwhile', () => {
  const validity = assertSellerSideStillValid({ dispositionAuthorization: DISPOSITION_DEAD })
  assert.equal(validity.valid, false)
  assert.equal(validity.reason, AGREEMENT_DENIALS.SELLER_CONTRACT_INVALIDATED)

  const commitment = authorizeBuyerCommitment({
    dispositionAuthorization: DISPOSITION_DEAD,
    buyerOffer: SELECTED_OFFER,
    opportunity: OPPORTUNITY,
    commitmentEvidence: { commitment_event_id: 'e', agreement_id: 'a', commitment_type: 'assignment_agreement', executed_at: '2026-09-13T12:00:00Z' },
  })
  assert.equal(commitment.committed, false)
})

// ── §17 EMD terms vs receipt ──────────────────────────────────────────────

test('S8.5 EMD: an agreement creates the obligation, never the receipt', () => {
  const { event } = commitmentFrom()
  assert.equal(event.emd_terms, 5_000)
  assert.equal(event.emd_received, false, 'a signature is not a wire')
})

test('S8.5 EMD: the closing-case projection carries terms and no receipt field', () => {
  const projection = buildClosingCaseProjection({ agreement: executedAgreement(), buyerOffer: SELECTED_OFFER })
  assert.equal(projection.buyer_emd, 5_000)
  assert.ok(!('emd_received' in projection))
  assert.ok(!('emd_received_at' in projection))
})

// ── §18 projection is derivative ──────────────────────────────────────────

test('S8.5: a manually populated closing-case assignment_id cannot commit anyone', () => {
  const commitment = authorizeBuyerCommitment({
    dispositionAuthorization: DISPOSITION_ACTIVE,
    buyerOffer: SELECTED_OFFER,
    opportunity: OPPORTUNITY,
    dispositionCase: { closing_case_id: 'closing:opp-A', assignment_id: 'manually-typed', buyer_id: 'buyer-1' },
  })
  assert.equal(commitment.committed, false)
})

test('S8.5: the projection derives FROM the agreement', () => {
  const projection = buildClosingCaseProjection({ agreement: executedAgreement() })
  assert.equal(projection.assignment_id, 'buyer_agreement:buyer_offer:opp-A:buyer-1:v1:v1')
  assert.equal(projection.buyer_price, 80_000)
  assert.equal(projection.disposition_status, 'buyer_committed')
})

// ── §20 template provenance ───────────────────────────────────────────────

test('S8.5: every agreement records the template and version it was built from', () => {
  const a = generate().agreement
  assert.equal(a.template_id, 'tmpl-assignment-v3')
  assert.equal(a.template_version, 'v3')
})

// ── §21 privacy ───────────────────────────────────────────────────────────

test('S8.5 PRIVACY: the document payload is an allowlist and leaks nothing internal', () => {
  const payload = buildAgreementPayload({
    buyerOffer: SELECTED_OFFER,
    property: { property_address_full: '5115 Michigan Ave, Kansas City, Mo 64130' },
    buyer: { buyer_name: 'Acme Holdings', email: 'buyer@example.com' },
    agreementType: COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT,
    sellerAcquisitionPrice: 62_300,
  })
  for (const forbidden of AGREEMENT_PAYLOAD_FORBIDDEN) {
    assert.ok(!(forbidden in payload), `leaked ${forbidden}`)
  }
  const serialized = JSON.stringify(payload)
  // Our acquisition basis is not in an ASSIGNMENT agreement payload.
  assert.ok(!serialized.includes('62300'), `leaked the seller basis: ${serialized}`)
  assert.equal(payload.buyer_price, 80_000)
  assert.equal(payload.emd_terms, 5_000)
})

test('S8.5 PRIVACY: structures that legally reference the basis get it, others do not', () => {
  const novation = buildAgreementPayload({
    buyerOffer: { ...SELECTED_OFFER, strategy: 'novation' },
    agreementType: COMMITMENT_TYPES.NOVATION_AGREEMENT,
    sellerAcquisitionPrice: 62_300,
  })
  assert.equal(novation.seller_acquisition_price, 62_300)
  const assignment = buildAgreementPayload({
    buyerOffer: SELECTED_OFFER,
    agreementType: COMMITMENT_TYPES.ASSIGNMENT_AGREEMENT,
    sellerAcquisitionPrice: 62_300,
  })
  assert.equal(assignment.seller_acquisition_price, undefined)
})

test('S8.5: agreement ids are deterministic per offer version', () => {
  assert.equal(
    buildBuyerAgreementId({ buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1', agreement_version: 2 }),
    'buyer_agreement:buyer_offer:opp-A:buyer-1:v1:v2',
  )
  assert.equal(buildBuyerAgreementId({ buyer_offer_id: '' }), null)
})
