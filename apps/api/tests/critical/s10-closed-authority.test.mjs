import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPLETION_DENIALS,
  COMPLETION_VERDICT,
  FUNDING_STATUS,
  RECORDING_STATUS,
  SETTLEMENT_STATUS,
  authorizeClosed,
  buildFinalTransactionRecord,
  classifyLegacyClosedRow,
  evaluateClosingCompletion,
  resolveFinalEconomics,
  resolveFundingPosition,
  resolveRecordingPosition,
  resolvePostCloseException,
  resolveStrategyCompletionRequirements,
  settlementBindsTo,
  verifySettlementEvidence,
} from '@/lib/domain/closings/closing-completion-authority.js'

/**
 * S10 — CLOSED AUTHORITY.
 *
 * `closed` means the transaction actually completed.
 *
 *   prepared_to_close       != closed
 *   scheduled closing date  != closed
 *   documents signed        != closed
 *   funds expected          != funds received
 *   funds received          != funds disbursed
 *   closing_status='closed' != closed
 */

const OPPORTUNITY = Object.freeze({
  id: 'opp-A', primary_property_id: 'prop-A', acquisition_stage: 'prepared_to_close',
})

const READY = Object.freeze({ verdict: 'ready', strategy: 'assignment', evidence: { closing_case_id: 'closing:opp-A' } })
const SELLER_CONTRACT = Object.freeze({ contract_status: 'fully_executed' })
const BUYER_COMMITMENT = Object.freeze({ committed: true, buyer_id: 'buyer-1', strategy: 'assignment' })

/** A fully evidenced, disbursed assignment settlement. */
const SETTLED_ASSIGNMENT = Object.freeze({
  settlement_id: 'settlement:opp-A:single',
  opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1',
  closing_case_id: 'closing:opp-A',
  strategy: 'assignment', leg: 'single',
  settlement_status: SETTLEMENT_STATUS.SETTLED,
  funding_status: FUNDING_STATUS.DISBURSED,
  funded_amount: 80_000, disbursed_amount: 16_950,
  recording_status: RECORDING_STATUS.NOT_APPLICABLE,
  settlement_statement_type: 'alta', settlement_statement_reference: 'alta-77123',
  actual_seller_amount: 62_300, actual_buyer_amount: 80_000,
  actual_assignment_fee: 16_950, actual_closing_costs: 750, actual_net_proceeds: 16_200,
  closed_at: '2026-10-01T17:30:00.000Z', closing_provider: 'Acme Title',
  verified_by: 'operator-1', verified_at: '2026-10-01T18:00:00.000Z',
  verification_method: 'title_provider', evidence_reference: 'settlement-pkg-4412',
})

const complete = (over = {}) => evaluateClosingCompletion({
  opportunity: OPPORTUNITY,
  closingReadiness: READY,
  sellerContract: SELLER_CONTRACT,
  buyerCommitment: BUYER_COMMITMENT,
  settlements: [SETTLED_ASSIGNMENT],
  strategy: 'assignment',
  ...over,
})

// ── §26 nothing short of settlement closes ────────────────────────────────

test('S10: S9 readiness with closing merely scheduled does not close', () => {
  const r = complete({ settlements: [] })
  assert.equal(r.verdict, COMPLETION_VERDICT.NOT_CLOSED)
  assert.ok(r.missing_requirements.some((m) => m.startsWith(COMPLETION_DENIALS.LEG_MISSING)))
})

test('S10: all documents signed with no settlement does not close', () => {
  // A pending settlement row is progress, not completion.
  const r = complete({ settlements: [{ ...SETTLED_ASSIGNMENT, settlement_status: SETTLEMENT_STATUS.PENDING }] })
  assert.equal(r.closed, false)
  assert.ok(r.reasons.some((x) => x.includes(COMPLETION_DENIALS.LEG_NOT_SETTLED)))
})

test('S10: funding INITIATED is not funded', () => {
  const f = resolveFundingPosition({ funding_status: FUNDING_STATUS.INITIATED }, { requiresDisbursement: true })
  assert.equal(f.complete, false)
  assert.equal(complete({ settlements: [{ ...SETTLED_ASSIGNMENT, funding_status: FUNDING_STATUS.INITIATED }] }).closed, false)
})

test('S10: funding RECEIVED is not disbursed', () => {
  const r = complete({ settlements: [{ ...SETTLED_ASSIGNMENT, funding_status: FUNDING_STATUS.RECEIVED }] })
  assert.equal(r.closed, false)
  assert.ok(r.missing_requirements.some((m) => m.startsWith(COMPLETION_DENIALS.FUNDING_NOT_COMPLETE)))
})

test('S10: FAILED or REVERSED funding blocks rather than merely missing', () => {
  for (const status of [FUNDING_STATUS.FAILED, FUNDING_STATUS.REVERSED]) {
    const r = complete({ settlements: [{ ...SETTLED_ASSIGNMENT, funding_status: status }] })
    assert.equal(r.verdict, COMPLETION_VERDICT.BLOCKED, `${status} did not block`)
    assert.ok(r.blockers.includes(COMPLETION_DENIALS.FUNDING_FAILED))
  }
})

// ── §4 manual verification burden ─────────────────────────────────────────

test('S10: a naked settled status with no evidence is refused', () => {
  const bare = { ...SETTLED_ASSIGNMENT, closed_at: null, closing_provider: null, verified_by: null, verified_at: null, verification_method: null, evidence_reference: null }
  const v = verifySettlementEvidence(bare)
  assert.equal(v.verified, false)
  assert.equal(v.reason, COMPLETION_DENIALS.EVIDENCE_INCOMPLETE)
  assert.equal(complete({ settlements: [bare] }).closed, false)
})

test('S10: manual verification with no verifier is rejected', () => {
  const v = verifySettlementEvidence({ ...SETTLED_ASSIGNMENT, verified_by: null })
  assert.equal(v.verified, false)
  assert.ok(v.missing_fields.includes('verified_by'))
})

test('S10: manual verification with no evidence reference is rejected', () => {
  const v = verifySettlementEvidence({ ...SETTLED_ASSIGNMENT, evidence_reference: null })
  assert.equal(v.verified, false)
  assert.ok(v.missing_fields.includes('evidence_reference'))
})

test('S10: every provenance field is individually required', () => {
  for (const drop of ['closed_at', 'closing_provider', 'verified_by', 'verified_at', 'verification_method', 'evidence_reference']) {
    const v = verifySettlementEvidence({ ...SETTLED_ASSIGNMENT, [drop]: null })
    assert.equal(v.verified, false, `${drop} was not required`)
    assert.ok(v.missing_fields.includes(drop))
  }
})

// ── §6 strategy-aware completion ──────────────────────────────────────────

test('S10: each structure declares its own legs and requirements', () => {
  const a = resolveStrategyCompletionRequirements('assignment')
  assert.deepEqual(a.legs, ['single'])
  assert.equal(a.requires_recording, false)
  const d = resolveStrategyCompletionRequirements('double_close')
  assert.deepEqual(d.legs, ['a_to_b', 'b_to_c'])
  assert.equal(d.requires_recording, true)
  const n = resolveStrategyCompletionRequirements('novation')
  assert.equal(n.requires_recording, true)
  assert.equal(resolveStrategyCompletionRequirements('lease_option').supported, false)
})

test('S10: an unsupported structure blocks rather than borrowing semantics', () => {
  const r = complete({ strategy: 'lease_option' })
  assert.equal(r.verdict, COMPLETION_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(COMPLETION_DENIALS.UNSUPPORTED_STRATEGY))
})

test('S10 ASSIGNMENT: full evidence with recording not applicable closes', () => {
  const r = complete()
  assert.equal(r.verdict, COMPLETION_VERDICT.CLOSED)
  assert.equal(r.closed_at, '2026-10-01T17:30:00.000Z')
})

test('S10 DOUBLE CLOSE: closing on only the A→B leg does NOT close', () => {
  const aToB = { ...SETTLED_ASSIGNMENT, settlement_id: 's:a_to_b', strategy: 'double_close', leg: 'a_to_b',
    recording_status: RECORDING_STATUS.RECORDED, recording_instrument_id: 'INST-1', recorded_at: '2026-10-01T17:00:00Z' }
  const r = complete({ strategy: 'double_close', settlements: [aToB] })
  assert.equal(r.closed, false)
  assert.ok(r.missing_requirements.includes(`${COMPLETION_DENIALS.LEG_MISSING}:b_to_c`))
})

test('S10 DOUBLE CLOSE: both legs settled and recorded closes', () => {
  const leg = (name, at) => ({
    ...SETTLED_ASSIGNMENT, settlement_id: `s:${name}`, strategy: 'double_close', leg: name,
    recording_status: RECORDING_STATUS.RECORDED, recording_instrument_id: `INST-${name}`,
    recorded_at: at, recording_jurisdiction: 'Jackson County MO', closed_at: at,
  })
  const r = complete({
    strategy: 'double_close',
    settlements: [leg('a_to_b', '2026-10-01T16:00:00.000Z'), leg('b_to_c', '2026-10-01T17:00:00.000Z')],
  })
  assert.equal(r.verdict, COMPLETION_VERDICT.CLOSED)
  // The transaction closed when the LAST required leg settled.
  assert.equal(r.closed_at, '2026-10-01T17:00:00.000Z')
})

test('S10 NOVATION: strategy-specific completion with recording closes', () => {
  const r = complete({
    strategy: 'novation',
    settlements: [{ ...SETTLED_ASSIGNMENT, strategy: 'novation',
      recording_status: RECORDING_STATUS.RECORDED, recording_instrument_id: 'INST-N', recorded_at: '2026-10-01T17:30:00Z' }],
  })
  assert.equal(r.verdict, COMPLETION_VERDICT.CLOSED)
})

// ── §8 recording ──────────────────────────────────────────────────────────

test('S10: recording required but pending does not close', () => {
  const r = complete({
    strategy: 'novation',
    settlements: [{ ...SETTLED_ASSIGNMENT, strategy: 'novation', recording_status: RECORDING_STATUS.PENDING }],
  })
  assert.equal(r.closed, false)
  assert.ok(r.missing_requirements.some((m) => m.startsWith(COMPLETION_DENIALS.RECORDING_PENDING)))
})

test('S10: a REJECTED recording blocks', () => {
  const r = complete({
    strategy: 'novation',
    settlements: [{ ...SETTLED_ASSIGNMENT, strategy: 'novation', recording_status: RECORDING_STATUS.REJECTED }],
  })
  assert.equal(r.verdict, COMPLETION_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(COMPLETION_DENIALS.RECORDING_REJECTED))
})

test('S10: `recorded` without an instrument id is not recording evidence', () => {
  const p = resolveRecordingPosition(
    { recording_status: RECORDING_STATUS.RECORDED, recording_instrument_id: null, recorded_at: null },
    { requiresRecording: true },
  )
  assert.equal(p.complete, false)
  assert.equal(p.reason, COMPLETION_DENIALS.EVIDENCE_INCOMPLETE)
})

test('S10: recording is never fabricated from a closing date', () => {
  // A closed_at on the record says nothing about the county.
  const p = resolveRecordingPosition({ recording_status: RECORDING_STATUS.PENDING, closed_at: '2026-10-01T17:30:00Z' }, { requiresRecording: true })
  assert.equal(p.complete, false)
})

// ── §13/§14 binding and generic fields ────────────────────────────────────

test('S10: settlement evidence for the WRONG PROPERTY cannot close this deal', () => {
  const r = complete({ settlements: [{ ...SETTLED_ASSIGNMENT, property_id: 'prop-B' }] })
  assert.equal(r.verdict, COMPLETION_VERDICT.BLOCKED)
  assert.ok(r.blockers.includes(COMPLETION_DENIALS.BINDING_MISMATCH))
})

test('S10: settlement evidence for the WRONG BUYER cannot close this deal', () => {
  const r = complete({ settlements: [{ ...SETTLED_ASSIGNMENT, buyer_id: 'buyer-2' }] })
  assert.equal(r.verdict, COMPLETION_VERDICT.BLOCKED)
  assert.deepEqual(settlementBindsTo({ ...SETTLED_ASSIGNMENT, buyer_id: 'buyer-2' },
    { opportunity_id: 'opp-A', property_id: 'prop-A', buyer_id: 'buyer-1' }).mismatched, ['buyer'])
})

test('S10: generic closing-case fields cannot fabricate a close', () => {
  // closing_status='closed', a passed scheduled date, populated funding_status,
  // a recording field and an assignment_fee are inputs, never a verdict.
  const r = evaluateClosingCompletion({
    opportunity: OPPORTUNITY,
    closingReadiness: READY,
    sellerContract: SELLER_CONTRACT,
    buyerCommitment: BUYER_COMMITMENT,
    strategy: 'assignment',
    settlements: [],
  })
  assert.equal(r.closed, false)
  const gate = authorizeClosed({ opportunity: { ...OPPORTUNITY, closing_status: 'closed', funding_status: 'funded', recording_date: '2026-10-01', assignment_fee: 16_950 }, completion: r })
  assert.equal(gate.authorized, false)
})

test('S10: an invalidated seller contract or buyer commitment blocks', () => {
  assert.ok(complete({ sellerContract: { contract_status: 'cancelled' } }).blockers.includes(COMPLETION_DENIALS.SELLER_CONTRACT_INVALID))
  assert.ok(complete({ buyerCommitment: { ...BUYER_COMMITMENT, committed: false } }).blockers.includes(COMPLETION_DENIALS.BUYER_COMMITMENT_INVALID))
})

test('S10: S9 readiness must actually have been satisfied', () => {
  const r = complete({ closingReadiness: { verdict: 'not_ready' } })
  assert.equal(r.closed, false)
  assert.ok(r.missing_requirements.includes(COMPLETION_DENIALS.READINESS_NOT_SATISFIED))
})

// ── §13 the gate ──────────────────────────────────────────────────────────

test('S10 GATE: verified settlement authorizes the terminal stage', () => {
  const gate = authorizeClosed({ opportunity: OPPORTUNITY, completion: complete() })
  assert.equal(gate.authorized, true)
  assert.equal(gate.stage, 'closed')
  assert.equal(gate.terminal, true)
  assert.equal(gate.closed_at, '2026-10-01T17:30:00.000Z')
})

test('S10 GATE: a stage below prepared_to_close cannot close', () => {
  const gate = authorizeClosed({
    opportunity: { ...OPPORTUNITY, acquisition_stage: 'under_contract' }, completion: complete(),
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, COMPLETION_DENIALS.STAGE_BELOW_PREPARED_TO_CLOSE)
})

// ── §15 idempotency ───────────────────────────────────────────────────────

test('S10: ten evaluations of the same evidence give one verdict and one closed_at', () => {
  const results = Array.from({ length: 10 }, () => complete())
  assert.equal(new Set(results.map((r) => `${r.verdict}:${r.closed_at}`)).size, 1)
  const gates = Array.from({ length: 10 }, () => authorizeClosed({ opportunity: OPPORTUNITY, completion: complete() }))
  assert.equal(new Set(gates.map((g) => `${g.authorized}:${g.stage}:${g.closed_at}`)).size, 1)
})

// ── §16/§27 terminal stage and post-close exceptions ──────────────────────

test('S10: a post-close reversal records an exception without erasing the close', () => {
  const r = resolvePostCloseException({ currentStage: 'closed', exception: 'funding_reversed', note: 'wire recalled' })
  assert.equal(r.stage, 'closed')
  assert.equal(r.stage_regressed, false)
  assert.equal(r.terminal, true)
  assert.equal(r.post_close_exception, 'funding_reversed')
  assert.equal(r.recovery_workflow_implemented, false)
})

test('S10: with no exception the stage is simply terminal', () => {
  const r = resolvePostCloseException({ currentStage: 'closed' })
  assert.equal(r.post_close_exception, null)
  assert.equal(r.stage_regressed, false)
})

// ── §21/§22 legacy closed rows ────────────────────────────────────────────

test('S10 LEGACY: a backfilled closed row is not V2 closing evidence', () => {
  const c = classifyLegacyClosedRow({ promotion_reason: 'backfill_from_universal_inbox_threads' })
  assert.equal(c.classification, 'legacy_imported')
  assert.equal(c.v2_closing_evidence, false)
})

test('S10 LEGACY: a row with real V2 artifacts classifies as current', () => {
  const c = classifyLegacyClosedRow({ settlement_id: 'settlement:opp-A:single', closing_case_id: 'closing:opp-A' })
  assert.equal(c.classification, 'current_v2')
  assert.equal(c.v2_closing_evidence, true)
})

test('S10 LEGACY: an unexplained closed row is unknown, never assumed valid', () => {
  assert.equal(classifyLegacyClosedRow({}).classification, 'unknown')
})

// ── §9/§10/§20 estimated vs actual ────────────────────────────────────────

const ESTIMATED = Object.freeze({
  seller_acquisition_price: 62_300, buyer_price: 80_000, gross_spread: 17_700, known_closing_costs: null,
})

test('S10 ECONOMICS: estimated and actual both survive, neither derived', () => {
  const e = resolveFinalEconomics({ estimated: ESTIMATED, settlements: [SETTLED_ASSIGNMENT], strategy: 'assignment' })
  assert.equal(e.estimated.gross_spread, 17_700)
  assert.equal(e.actual.assignment_fee, 16_950)
  assert.equal(e.actual.net_proceeds, 16_200)
  assert.equal(e.actual_derived_from_estimate, false)
  // The estimate is not overwritten by the actual, and vice versa.
  assert.notEqual(e.estimated.gross_spread, e.actual.assignment_fee)
})

test('S10 ECONOMICS: actual is never backfilled from estimated', () => {
  const noActuals = { ...SETTLED_ASSIGNMENT, actual_assignment_fee: null, actual_net_proceeds: null, actual_seller_amount: null, actual_buyer_amount: null }
  const e = resolveFinalEconomics({ estimated: ESTIMATED, settlements: [noActuals], strategy: 'assignment' })
  assert.equal(e.actual.assignment_fee, null)
  assert.equal(e.actual.net_proceeds, null)
  assert.equal(e.estimated.gross_spread, 17_700, 'the estimate survives')
  assert.equal(e.net_proceeds_reason, 'net_not_reported_on_settlement_statement')
})

test('S10 ECONOMICS: no settled leg means no actual economics at all', () => {
  const e = resolveFinalEconomics({ estimated: ESTIMATED, settlements: [], strategy: 'assignment' })
  assert.equal(e.actual.net_proceeds, null)
  assert.equal(e.net_proceeds_reason, 'no_settled_leg')
})

test('S10 ECONOMICS: a double close sums actuals across both legs', () => {
  const leg = (name, fee) => ({ ...SETTLED_ASSIGNMENT, leg: name, strategy: 'double_close', actual_assignment_fee: fee, actual_net_proceeds: fee - 100 })
  const e = resolveFinalEconomics({ estimated: ESTIMATED, settlements: [leg('a_to_b', 5_000), leg('b_to_c', 11_950)], strategy: 'double_close' })
  assert.equal(e.actual.assignment_fee, 16_950)
  assert.equal(e.actual.net_proceeds, 16_750)
})

// ── §28 thread projection ─────────────────────────────────────────────────

test('S10: a thread projection saying closed cannot fabricate S10', () => {
  // The gate reads canonical stage + completion evidence; the projection is not
  // a parameter at all.
  const gate = authorizeClosed({
    opportunity: { ...OPPORTUNITY, acquisition_stage: 'under_contract', lifecycle_stage: 'closed' },
    completion: complete(),
  })
  assert.equal(gate.authorized, false)
  assert.equal(gate.reason, COMPLETION_DENIALS.STAGE_BELOW_PREPARED_TO_CLOSE)
})

// ── §29/§30 final transaction record ──────────────────────────────────────

const CLOSING_HANDOFF = Object.freeze({
  ok: true,
  disposition_case_id: 'closing:opp-A',
  acquisition_opportunity_id: 'opp-A',
  property_id: 'prop-A',
  seller: { accepted_offer_id: 'offer:opp-A:v1', seller_contract_status: 'fully_executed',
    seller_contract_execution: { docusign_envelope_id: 'env-1', contract_signed_date: '2026-09-13T00:00:00Z' } },
  buyer: { selected_buyer_id: 'buyer-1', buyer_price: 80_000, buyer_commitment_status: 'committed',
    buyer_commitment_evidence: { agreement_id: 'assignment-agreement-1', executed_at: '2026-09-13T12:00:00Z' } },
  title: { title_company_name: 'Acme Title', title_state: 'title_clear', clear_to_close: true, blocking_issues: [] },
  emd: { required_amount: 5_000, verified_amount: 5_000, status: 'satisfied', satisfied: true },
  closing: { readiness_verdict: 'ready', readiness_evaluated_at: '2026-09-30T00:00:00.000Z' },
})

test('S10 → FRONTEND: the final record answers why we believe this closed', () => {
  const gate = authorizeClosed({ opportunity: OPPORTUNITY, completion: complete() })
  const record = buildFinalTransactionRecord({
    closingHandoff: CLOSING_HANDOFF, authorization: gate,
    settlements: [SETTLED_ASSIGNMENT], estimated: ESTIMATED,
  })

  assert.equal(record.ok, true)
  assert.equal(record.stage, 'closed')
  assert.equal(record.terminal, true)
  assert.equal(record.closed_at, '2026-10-01T17:30:00.000Z')
  assert.equal(record.closing_provider, 'Acme Title')
  assert.equal(record.settlement_evidence_status, 'complete')

  const why = record.why_we_believe_this_closed
  assert.ok(why.seller_contract)
  assert.ok(why.buyer_commitment)
  assert.equal(why.title_readiness.clear_to_close, true)
  assert.equal(why.emd.satisfied, true)
  assert.equal(why.readiness_verdict, 'ready')
  assert.equal(why.verification.verified_by, 'operator-1')
  assert.equal(why.verification.evidence_reference, 'settlement-pkg-4412')

  assert.equal(record.funding.status, FUNDING_STATUS.DISBURSED)
  assert.equal(record.funding.disbursed_amount, 16_950)
  assert.equal(record.recording.required, false)
  assert.equal(record.economics.actual.assignment_fee, 16_950)
  assert.equal(record.economics.estimated.gross_spread, 17_700)
})

test('S10 → FRONTEND: downstream events are identified, never emitted', () => {
  const gate = authorizeClosed({ opportunity: OPPORTUNITY, completion: complete() })
  const record = buildFinalTransactionRecord({ closingHandoff: CLOSING_HANDOFF, authorization: gate, settlements: [SETTLED_ASSIGNMENT] })
  assert.equal(record.downstream_events.operator_notification, 'not_sent')
  assert.equal(record.downstream_events.seller_closing_confirmation, 'not_sent')
  assert.equal(record.downstream_events.revenue_event, 'pending_revenue_authority')
})

test('S10 → FRONTEND: no final record without authorization', () => {
  const gate = authorizeClosed({ opportunity: OPPORTUNITY, completion: complete({ settlements: [] }) })
  const record = buildFinalTransactionRecord({ closingHandoff: CLOSING_HANDOFF, authorization: gate })
  assert.equal(record.ok, false)
  assert.equal(record.reason, 'closing_not_complete')
})
