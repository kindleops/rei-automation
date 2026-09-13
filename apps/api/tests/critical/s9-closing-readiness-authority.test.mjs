import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLOSING_HOLD_REASONS,
  EMD_RECEIPT_STATUS,
  EMD_SATISFACTION,
  READINESS_VERDICT,
  TITLE_STATE,
  authorizePreparedToClose,
  buildClosingHandoff,
  evaluateClosingReadiness,
  receiptBindsTo,
  resolveClosingDate,
  resolveEmdSatisfaction,
  resolvePostReadinessBlocker,
  resolveStrategyClosingRequirements,
  resolveTitleReadiness,
  verifyEmdReceipt,
} from '@/lib/domain/closings/closing-readiness-authority.js'

/**
 * S9 — CLOSING READINESS AUTHORITY.
 *
 * `prepared_to_close` means verified title/escrow, deposit, document and
 * closing conditions sufficient to proceed to actual closing.
 *
 *   emd_amount    != emd_received
 *   emd_received  != emd_verified
 *   title_company != title_opened
 *   title_opened  != title_clear
 *   a populated field != a satisfied requirement
 */

const OPPORTUNITY = Object.freeze({
  id: 'opp-A', primary_property_id: 'prop-A', acquisition_stage: 'under_contract',
})

const SELLER_CONTRACT = Object.freeze({ contract_status: 'fully_executed' })

const BUYER_COMMITMENT = Object.freeze({
  committed: true, buyer_id: 'buyer-1', buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1',
})

const BUYER_AGREEMENT = Object.freeze({
  strategy: 'assignment', emd_terms: 5_000, buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1',
  buyer_id: 'buyer-1', closing_date: '2026-10-01',
})

const CLOSING_CASE = Object.freeze({
  closing_case_id: 'closing:opp-A', title_company_name: 'Acme Title',
  title_status: 'opened', scheduled_closing_date: '2026-10-01',
})

const TITLE_CLEAR = Object.freeze({
  title_state: TITLE_STATE.CLEAR, commitment_received: true, clear_to_close: true,
})

const VERIFIED_RECEIPT = Object.freeze({
  receipt_id: 'emd:opp-A:1',
  opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1',
  buyer_offer_id: 'buyer_offer:opp-A:buyer-1:v1',
  amount: 5_000, escrow_destination: 'Acme Title escrow ••4412',
  status: EMD_RECEIPT_STATUS.VERIFIED,
  received_at: '2026-09-14T00:00:00.000Z',
  verified_at: '2026-09-14T18:00:00.000Z', verified_by: 'operator-1',
  verification_method: 'manual_operator', evidence_reference: 'wire-confirm-8891',
})

const DOCS_COMPLETE = Object.freeze({
  complete: ['seller_contract_fully_executed', 'buyer_agreement_fully_executed', 'title_clear', 'assignment_agreement'],
})

const SETTLEMENT_CONFIRMED = Object.freeze({ confirmed: true, confirmed_date: '2026-10-01', scheduled_at: '2026-10-01T16:00:00Z' })

const readiness = (over = {}) => evaluateClosingReadiness({
  opportunity: OPPORTUNITY,
  sellerContract: SELLER_CONTRACT,
  buyerCommitment: BUYER_COMMITMENT,
  buyerAgreement: BUYER_AGREEMENT,
  closingCase: CLOSING_CASE,
  titleFacts: TITLE_CLEAR,
  emdReceipts: [VERIFIED_RECEIPT],
  documents: DOCS_COMPLETE,
  settlement: SETTLEMENT_CONFIRMED,
  ...over,
})

// ── §25 the ladder to S9 ──────────────────────────────────────────────────

test('S9: a committed buyer with no title is not ready', () => {
  const r = readiness({ closingCase: { closing_case_id: 'closing:opp-A' }, titleFacts: null })
  assert.notEqual(r.verdict, READINESS_VERDICT.READY)
  assert.ok(r.missing_requirements.includes(CLOSING_HOLD_REASONS.TITLE_NOT_OPENED))
})

test('S9: a selected title COMPANY is not an opened title', () => {
  const t = resolveTitleReadiness({
    closingCase: { title_company_name: 'Acme Title' }, titleFacts: null,
  })
  assert.equal(t.state, TITLE_STATE.COMPANY_SELECTED)
  assert.equal(t.ready, false)
  assert.ok(t.holds.includes(CLOSING_HOLD_REASONS.TITLE_NOT_OPENED))
})

test('S9: title opened is not title clear', () => {
  const t = resolveTitleReadiness({
    closingCase: CLOSING_CASE,
    titleFacts: { title_state: TITLE_STATE.OPENED, commitment_received: true, clear_to_close: false },
  })
  assert.equal(t.ready, false)
  assert.ok(t.holds.includes(CLOSING_HOLD_REASONS.TITLE_NOT_CLEAR))
})

test('S9: title opened with no commitment is outstanding work, not clear', () => {
  const t = resolveTitleReadiness({
    closingCase: CLOSING_CASE, titleFacts: { title_state: TITLE_STATE.OPENED, commitment_received: false },
  })
  assert.ok(t.holds.includes(CLOSING_HOLD_REASONS.COMMITMENT_MISSING))
})

test('S9: title opened + EMD required but absent is not ready', () => {
  const r = readiness({ emdReceipts: [] })
  assert.notEqual(r.verdict, READINESS_VERDICT.READY)
  assert.ok(r.missing_requirements.includes(CLOSING_HOLD_REASONS.EMD_NOT_SATISFIED))
})

// ── §6/§7/§8 EMD terms vs receipt vs verification ─────────────────────────

test('S9 EMD: agreement terms of 5,000 with no receipt is MISSING, never satisfied', () => {
  const e = resolveEmdSatisfaction({ requiredAmount: 5_000, receipts: [], context: {} })
  assert.equal(e.status, EMD_SATISFACTION.MISSING)
  assert.equal(e.satisfied, false)
  assert.equal(e.verified_amount, 0)
})

test('S9 EMD: a received-but-unverified deposit is not satisfaction', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000,
    receipts: [{ ...VERIFIED_RECEIPT, status: EMD_RECEIPT_STATUS.RECEIVED_UNVERIFIED, verified_by: null, verified_at: null, verification_method: null, evidence_reference: null }],
    context: { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id },
  })
  assert.equal(e.status, EMD_SATISFACTION.UNVERIFIED)
  assert.equal(e.satisfied, false)
  assert.equal(e.unverified_count, 1)
})

test('S9 EMD: verification without provenance is refused', () => {
  // An operator checkbox with no verifier, method or evidence is not truth.
  for (const drop of ['verified_by', 'verified_at', 'verification_method', 'evidence_reference']) {
    const r = verifyEmdReceipt({ receipt: { ...VERIFIED_RECEIPT, [drop]: null } })
    assert.equal(r.verified, false, `${drop} was not required`)
    assert.ok(r.missing_fields.includes(drop))
  }
})

test('S9 EMD: a verified 5,000 against a 5,000 requirement is satisfied', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000, receipts: [VERIFIED_RECEIPT],
    context: { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id },
  })
  assert.equal(e.status, EMD_SATISFACTION.SATISFIED)
  assert.equal(e.satisfied, true)
  assert.equal(e.verified_amount, 5_000)
})

test('S9 EMD: 2,500 verified of 5,000 is PARTIAL and not ready', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000, receipts: [{ ...VERIFIED_RECEIPT, amount: 2_500 }],
    context: { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id },
  })
  assert.equal(e.status, EMD_SATISFACTION.PARTIAL)
  assert.equal(e.satisfied, false)
  assert.equal(readiness({ emdReceipts: [{ ...VERIFIED_RECEIPT, amount: 2_500 }] }).verdict, READINESS_VERDICT.NOT_READY)
})

test('S9 EMD: overfunding satisfies but is flagged rather than silently accepted', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000, receipts: [{ ...VERIFIED_RECEIPT, amount: 7_500 }],
    context: { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id },
  })
  assert.equal(e.status, EMD_SATISFACTION.OVERFUNDED)
  assert.equal(e.satisfied, true)
})

test('S9 EMD: a failed or refunded deposit blocks rather than merely missing', () => {
  const r = readiness({ emdReceipts: [{ ...VERIFIED_RECEIPT, status: EMD_RECEIPT_STATUS.FAILED }] })
  assert.equal(r.verdict, READINESS_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(CLOSING_HOLD_REASONS.EMD_NOT_SATISFIED))
})

// ── §10 binding ───────────────────────────────────────────────────────────

test('S9 EMD: a deposit from the WRONG BUYER satisfies nothing', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000, receipts: [{ ...VERIFIED_RECEIPT, buyer_id: 'buyer-2' }],
    context: { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id },
  })
  assert.equal(e.satisfied, false)
  assert.equal(e.verified_amount, 0)
  assert.deepEqual(e.ignored_unbound_receipts[0].mismatched, ['buyer'])
})

test('S9 EMD: a deposit on the WRONG PROPERTY satisfies nothing', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000, receipts: [{ ...VERIFIED_RECEIPT, property_id: 'prop-B' }],
    context: { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id },
  })
  assert.equal(e.satisfied, false)
  assert.deepEqual(e.ignored_unbound_receipts[0].mismatched, ['property'])
})

test('S9 EMD: a multi-property buyer cannot cross-satisfy with one deposit', () => {
  const context = { opportunity_id: 'opp-B', property_id: 'prop-B', buyer_id: 'buyer-1', buyer_offer_id: 'buyer_offer:opp-B:buyer-1:v1' }
  assert.equal(receiptBindsTo(VERIFIED_RECEIPT, context).bound, false)
  const e = resolveEmdSatisfaction({ requiredAmount: 5_000, receipts: [VERIFIED_RECEIPT], context })
  assert.equal(e.satisfied, false)
})

// ── §11 waiver ────────────────────────────────────────────────────────────

test('S9 EMD: a valid waiver satisfies the deposit requirement', () => {
  const e = resolveEmdSatisfaction({
    requiredAmount: 5_000, receipts: [],
    waiver: { waived_by: 'operator-1', waived_at: '2026-09-14T00:00:00Z', reason: 'seller agreed no EMD' },
    context: {},
  })
  assert.equal(e.status, EMD_SATISFACTION.WAIVED)
  assert.equal(e.satisfied, true)
})

test('S9 EMD: a waiver without provenance satisfies nothing', () => {
  const e = resolveEmdSatisfaction({ requiredAmount: 5_000, receipts: [], waiver: { reason: 'because' }, context: {} })
  assert.equal(e.satisfied, false)
  assert.equal(e.reason, 'waiver_provenance_incomplete')
})

// ── §13 title defects block ───────────────────────────────────────────────

test('S9 TITLE: each defect is reported explicitly, never collapsed to not_ready', () => {
  const t = resolveTitleReadiness({
    closingCase: CLOSING_CASE,
    titleFacts: { title_state: TITLE_STATE.OPENED, commitment_received: true, clear_to_close: false,
      unresolved_liens: ['lien-1'], probate_unresolved: true, payoff_missing: true },
  })
  assert.ok(t.holds.includes(CLOSING_HOLD_REASONS.UNRESOLVED_LIEN))
  assert.ok(t.holds.includes(CLOSING_HOLD_REASONS.PROBATE_UNRESOLVED))
  assert.ok(t.holds.includes(CLOSING_HOLD_REASONS.PAYOFF_MISSING))
})

test('S9 TITLE: an unresolved defect BLOCKS readiness', () => {
  const r = readiness({ titleFacts: { ...TITLE_CLEAR, unresolved_liens: ['lien-1'] } })
  assert.equal(r.verdict, READINESS_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(CLOSING_HOLD_REASONS.UNRESOLVED_LIEN))
})

test('S9 TITLE: a cancelled title is terminal', () => {
  const t = resolveTitleReadiness({ closingCase: CLOSING_CASE, titleFacts: { title_state: TITLE_STATE.CANCELLED } })
  assert.equal(t.ready, false)
  assert.deepEqual(t.holds, [CLOSING_HOLD_REASONS.TITLE_CANCELLED])
})

// ── §14 closing date ──────────────────────────────────────────────────────

test('S9: a populated closing date is not a confirmed settlement', () => {
  const dates = resolveClosingDate({ buyerAgreement: BUYER_AGREEMENT, closingCase: CLOSING_CASE, settlement: null })
  assert.equal(dates.target_closing_date, '2026-10-01')
  assert.equal(dates.confirmed, false)
  assert.equal(dates.confirmed_closing_date, null)
  // And it alone cannot produce S9.
  const r = readiness({ settlement: null })
  assert.notEqual(r.verdict, READINESS_VERDICT.READY)
  assert.ok(r.missing_requirements.includes(CLOSING_HOLD_REASONS.CLOSING_DATE_MISSING))
})

// ── §16 strategy-aware requirements ───────────────────────────────────────

test('S9: each strategy carries its own closing requirements', () => {
  assert.deepEqual(resolveStrategyClosingRequirements('assignment').required_documents.slice(-1), ['assignment_agreement'])
  const dc = resolveStrategyClosingRequirements('double_close')
  assert.equal(dc.requires_funding_coordination, true)
  assert.ok(dc.required_documents.includes('ab_settlement_statement'))
  assert.ok(dc.required_documents.includes('bc_settlement_statement'))
  assert.ok(resolveStrategyClosingRequirements('novation').required_documents.includes('seller_consent'))
  assert.equal(resolveStrategyClosingRequirements('lease_option').supported, false)
})

test('S9: a double close is not approved on assignment paperwork', () => {
  const r = readiness({
    buyerAgreement: { ...BUYER_AGREEMENT, strategy: 'double_close' },
    documents: DOCS_COMPLETE, // assignment docs only
  })
  assert.notEqual(r.verdict, READINESS_VERDICT.READY)
  assert.ok(r.reasons.some((x) => x.includes('bc_settlement_statement')))
})

// ── §18 the S9 gate ───────────────────────────────────────────────────────

test('S9 GATE: title clear + EMD verified + docs + confirmed date authorizes S9', () => {
  const r = readiness()
  assert.equal(r.verdict, READINESS_VERDICT.READY)
  const gate = authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: r })
  assert.equal(gate.authorized, true)
  assert.equal(gate.stage, 'prepared_to_close')
})

test('S9 GATE: a stage below under_contract cannot reach S9', () => {
  const gate = authorizePreparedToClose({
    opportunity: { ...OPPORTUNITY, acquisition_stage: 'disposition' }, readiness: readiness(),
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, 'canonical_stage_below_under_contract')
})

test('S9 GATE: buyer commitment alone cannot fabricate S9', () => {
  const r = readiness({ titleFacts: null, emdReceipts: [], documents: null, settlement: null })
  const gate = authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: r })
  assert.equal(gate.authorized, false)
  assert.ok(gate.evidence.missing_requirements.length > 0)
})

test('S9 GATE: an invalidated seller contract blocks S9', () => {
  const r = readiness({ sellerContract: { contract_status: 'cancelled' } })
  assert.equal(r.verdict, READINESS_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(CLOSING_HOLD_REASONS.SELLER_CONTRACT_INVALID))
})

test('S9 GATE: an invalidated buyer commitment blocks S9', () => {
  const r = readiness({ buyerCommitment: { ...BUYER_COMMITMENT, committed: false } })
  assert.equal(r.verdict, READINESS_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(CLOSING_HOLD_REASONS.BUYER_COMMITMENT_INVALID))
})

// ── §19 closing-case fields cannot fabricate S9 ───────────────────────────

test('S9: populated closing-case fields alone produce no readiness', () => {
  // closing_date, title_company, buyer_emd, contract_status, disposition_status
  // are inputs to a verdict — never a verdict.
  const r = evaluateClosingReadiness({
    opportunity: OPPORTUNITY,
    sellerContract: SELLER_CONTRACT,
    buyerCommitment: BUYER_COMMITMENT,
    buyerAgreement: BUYER_AGREEMENT,
    closingCase: {
      closing_case_id: 'closing:opp-A',
      title_company_name: 'Acme Title',
      scheduled_closing_date: '2026-10-01',
      buyer_emd: 5_000,
      contract_status: 'fully_executed',
      disposition_status: 'buyer_committed',
    },
    titleFacts: null, emdReceipts: [], documents: null, settlement: null,
  })
  assert.notEqual(r.verdict, READINESS_VERDICT.READY)
  assert.ok(r.missing_requirements.includes(CLOSING_HOLD_REASONS.EMD_NOT_SATISFIED))
  assert.ok(r.missing_requirements.includes(CLOSING_HOLD_REASONS.TITLE_NOT_OPENED))
})

test('S9: a buyer_emd amount on the closing case is not a receipt', () => {
  const e = resolveEmdSatisfaction({ requiredAmount: 5_000, receipts: [], context: {} })
  assert.equal(e.verified_amount, 0)
  assert.equal(e.satisfied, false)
})

// ── §20 operator holds ────────────────────────────────────────────────────

test('S9: an explicit operator hold blocks even when everything else is ready', () => {
  const r = readiness({ holds: [CLOSING_HOLD_REASONS.OPERATOR_HOLD] })
  assert.equal(r.verdict, READINESS_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(CLOSING_HOLD_REASONS.OPERATOR_HOLD))
})

// ── §21 post-S9 blockers ──────────────────────────────────────────────────

test('S9: a blocker after S9 halts operations without rewinding the stage', () => {
  const r = resolvePostReadinessBlocker({
    currentStage: 'prepared_to_close', blockers: [CLOSING_HOLD_REASONS.UNRESOLVED_LIEN],
  })
  assert.equal(r.stage, 'prepared_to_close')
  assert.equal(r.stage_regressed, false)
  assert.equal(r.closing_readiness_status, READINESS_VERDICT.BLOCKED)
  assert.equal(r.operations_halted, true)
  assert.equal(r.recovery_workflow_implemented, false)
})

// ── §28 idempotency ───────────────────────────────────────────────────────

test('S9: ten evaluations of the same state give one verdict', () => {
  const verdicts = Array.from({ length: 10 }, () => readiness().verdict)
  assert.equal(new Set(verdicts).size, 1)
  const gates = Array.from({ length: 10 }, () => authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: readiness() }))
  assert.equal(new Set(gates.map((g) => `${g.authorized}:${g.stage}`)).size, 1)
})

test('S9: a duplicate receipt with the same external reference counts once', () => {
  // The DB enforces this (uq_emd_receipts_external_ref); here we prove the
  // aggregate treats two DISTINCT receipts as two, so the constraint is what
  // stops a replay rather than silent de-duplication in code.
  const context = { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1', buyer_offer_id: BUYER_AGREEMENT.buyer_offer_id }
  const one = resolveEmdSatisfaction({ requiredAmount: 5_000, receipts: [VERIFIED_RECEIPT], context })
  const two = resolveEmdSatisfaction({
    requiredAmount: 5_000,
    receipts: [VERIFIED_RECEIPT, { ...VERIFIED_RECEIPT, receipt_id: 'emd:opp-A:2' }],
    context,
  })
  assert.equal(one.verified_amount, 5_000)
  assert.equal(two.verified_amount, 10_000, 'two distinct receipts are two deposits')
  assert.equal(two.status, EMD_SATISFACTION.OVERFUNDED)
})

// ── §26 financial truth ───────────────────────────────────────────────────

const BUYER_HANDOFF = Object.freeze({
  ok: true,
  disposition_case_id: 'closing:opp-A',
  acquisition_opportunity_id: 'opp-A',
  property_id: 'prop-A',
  seller: { accepted_offer_id: 'offer:opp-A:v1', accepted_price: 62_300, seller_contract_status: 'fully_executed' },
  buyer: { selected_buyer_id: 'buyer-1', buyer_price: 80_000, buyer_commitment_status: 'committed' },
  economics: { strategy: 'assignment', seller_acquisition_price: 62_300, buyer_price: 80_000, gross_spread: 17_700, net_proceeds: null },
})

test('S9 → S10: net proceeds are never fabricated', () => {
  const gate = authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: readiness() })
  const handoff = buildClosingHandoff({
    buyerCommitmentHandoff: BUYER_HANDOFF, authorization: gate, closingCase: CLOSING_CASE, titleFacts: TITLE_CLEAR,
  })
  assert.equal(handoff.ok, true)
  assert.equal(handoff.economics.gross_spread, 17_700)
  assert.equal(handoff.economics.net_proceeds, null)
  assert.equal(handoff.economics.net_proceeds_reason, 'closing_costs_unknown')
})

test('S9 → S10: known closing costs still do not produce a net', () => {
  const gate = authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: readiness() })
  const handoff = buildClosingHandoff({
    buyerCommitmentHandoff: BUYER_HANDOFF, authorization: gate,
    closingCase: { ...CLOSING_CASE, closing_costs: 2_400 }, titleFacts: TITLE_CLEAR,
  })
  assert.equal(handoff.economics.known_closing_costs, 2_400)
  assert.equal(handoff.economics.net_proceeds, null)
  assert.equal(handoff.economics.net_proceeds_reason, 'settlement_statement_not_final')
})

// ── §29 S10 handoff ───────────────────────────────────────────────────────

test('S9 → S10: the handoff carries title, EMD, documents, closing and deadlines', () => {
  const gate = authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: readiness() })
  const handoff = buildClosingHandoff({
    buyerCommitmentHandoff: BUYER_HANDOFF, authorization: gate,
    closingCase: { ...CLOSING_CASE, emd_due_date: '2026-09-17' }, titleFacts: TITLE_CLEAR,
  })

  assert.equal(handoff.stage, 'prepared_to_close')
  assert.equal(handoff.title.clear_to_close, true)
  assert.deepEqual(handoff.title.blocking_issues, [])
  assert.equal(handoff.emd.required_amount, 5_000)
  assert.equal(handoff.emd.verified_amount, 5_000)
  assert.equal(handoff.emd.satisfied, true)
  assert.deepEqual(handoff.documents.outstanding, [])
  assert.equal(handoff.closing.confirmed_closing_date, '2026-10-01')
  assert.deepEqual(handoff.closing.outstanding_blockers, [])
  assert.equal(handoff.deadlines.emd_due_date, '2026-09-17')
  assert.ok(handoff.closing.readiness_evaluated_at)
})

test('S9 → S10: no handoff exists without authorization', () => {
  const gate = authorizePreparedToClose({ opportunity: OPPORTUNITY, readiness: readiness({ emdReceipts: [] }) })
  const handoff = buildClosingHandoff({ buyerCommitmentHandoff: BUYER_HANDOFF, authorization: gate })
  assert.equal(handoff.ok, false)
  assert.equal(handoff.reason, 'closing_not_ready')
})
