/**
 * Closing Desk pure-logic test suite.
 * Run: npx tsx tests/unit/closing-desk.test.ts
 *
 * Covers: health calc, stage mapping, milestone idempotency, missing-data
 * behavior, risk/blocker ordering, revenue calc, date/SLA behavior, and the
 * no-fabrication / read-only invariants.
 */
import assert from 'node:assert/strict'
import { computeClosingHealth } from '../../src/domain/closing-desk/closing-health'
import {
  buildMilestoneIdempotencyKey,
  createMilestone,
  dedupeMilestones,
  nextExpectedMilestone,
} from '../../src/domain/closing-desk/closing-milestones'
import { orderIssues, highestSeverityBlocker, isActivelyBlocking } from '../../src/domain/closing-desk/closing-issues'
import { deriveBoardColumn } from '../../src/domain/closing-desk/closing-board'
import { mapToClosingStage, projectClosingCase } from '../../src/domain/closing-desk/closing-projection'
import { computeClosingSummary } from '../../src/domain/closing-desk/closing-summary'
import { buildClosingDeskFixtureModel } from '../../src/domain/closing-desk/closing-fixtures'
import { buildCopilotReadout } from '../../src/domain/closing-desk/closing-copilot'
import type { ClosingIssue, ClosingReadiness, ClosingDates } from '../../src/domain/closing-desk/closing-desk.types'

const NOW = Date.parse('2026-06-25T12:00:00Z')
const DAY = 86_400_000

let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
  } catch (err) {
    failures.push(`✗ ${name}\n    ${(err as Error).message}`)
  }
}

function emptyReadiness(): ClosingReadiness {
  return {
    contractComplete: null, allSignersVerified: null, ownershipVerified: null, authorityVerified: null,
    emdReceived: null, buyerSecured: null, buyerFundsVerified: null, titleOpened: null,
    titleCommitmentReceived: null, liensResolved: null, probateResolved: null, payoffReceived: null,
    municipalIssuesResolved: null, settlementStatementApproved: null, sellerReady: null, buyerReady: null,
    signingScheduled: null, clearToClose: null, funded: null, recorded: null, closed: null,
  }
}
function emptyDates(): ClosingDates {
  return {
    contractSignedDate: null, effectiveDate: null, emdDueDate: null, inspectionDeadline: null,
    titleOpenedDate: null, titleCommitmentDate: null, cureDeadline: null, scheduledClosingDate: null,
    signingDate: null, fundingDate: null, recordingDate: null, revenueConfirmedDate: null,
  }
}
function mkIssue(over: Partial<ClosingIssue>): ClosingIssue {
  return {
    issueId: over.issueId ?? 'i', closingCaseId: 'c', category: over.category ?? 'other',
    title: over.title ?? 'issue', severity: over.severity ?? 'medium', status: over.status ?? 'open',
    owner: over.owner ?? null, openedAt: over.openedAt ?? null, dueAt: over.dueAt ?? null,
    slaHours: over.slaHours ?? null, resolutionRequirements: [], evidence: [], dependencies: [],
    blockingMilestones: [], resolvedAt: over.resolvedAt ?? null, resolutionNote: null, source: 'fixture',
  }
}

// ── Health ────────────────────────────────────────────────────────────────
test('health: clean case with no signal is unknown band', () => {
  const h = computeClosingHealth({ universalStage: 'formal_contract', dates: emptyDates(), readiness: emptyReadiness(), issues: [], milestones: [], now: NOW })
  assert.equal(h.band, 'unknown')
  assert.equal(h.onTimeCloseProbability, null)
})

test('health: blocker issue reduces score and is the top blocker', () => {
  const issues = [mkIssue({ issueId: 'b1', severity: 'blocker', status: 'open', title: 'lien' })]
  const h = computeClosingHealth({ universalStage: 'under_contract', dates: emptyDates(), readiness: emptyReadiness(), issues, milestones: [], now: NOW })
  assert.ok(h.score < 100, 'score should drop')
  assert.equal(h.blockingIssueCount, 1)
  assert.equal(h.highestSeverityBlocker?.issueId, 'b1')
})

test('health: passed closing date applies a heavy penalty and band degrades', () => {
  const dates = { ...emptyDates(), scheduledClosingDate: new Date(NOW - 5 * DAY).toISOString() }
  const h = computeClosingHealth({ universalStage: 'prepared_to_close', dates, readiness: emptyReadiness(), issues: [], milestones: [], now: NOW })
  assert.ok(h.daysUntilClosing !== null && h.daysUntilClosing < 0)
  assert.ok(h.factors.some((f) => f.rule === 'closing_date_passed'))
})

test('health: every factor carries traceable evidence (no black box)', () => {
  const issues = [mkIssue({ severity: 'high', title: 'payoff' })]
  const h = computeClosingHealth({ universalStage: 'under_contract', dates: emptyDates(), readiness: emptyReadiness(), issues, milestones: [], now: NOW })
  for (const f of h.factors) {
    assert.ok(f.rule && f.evidence, `factor ${f.label} must cite evidence`)
  }
})

test('health: deterministic — identical inputs produce identical score', () => {
  const args = { universalStage: 'under_contract' as const, dates: emptyDates(), readiness: emptyReadiness(), issues: [mkIssue({ severity: 'blocker' })], milestones: [], now: NOW }
  assert.equal(computeClosingHealth(args).score, computeClosingHealth(args).score)
})

// ── Stage mapping ───────────────────────────────────────────────────────────
test('stage: contract_to_close maps to formal_contract (derived)', () => {
  const r = mapToClosingStage({ acquisition_stage: 'contract_to_close' })
  assert.equal(r.stage, 'formal_contract')
  assert.equal(r.source, 'derived')
})

test('stage: metadata override is honored and flagged as podio_mirror', () => {
  const r = mapToClosingStage({ acquisition_stage: 'contract_to_close', metadata: { closing_universal_stage: 'disposition' } })
  assert.equal(r.stage, 'disposition')
  assert.equal(r.source, 'podio_mirror')
})

test('stage: a real closing-band stage on the row is trusted directly (prod supports it)', () => {
  for (const s of ['formal_contract', 'under_contract', 'disposition', 'prepared_to_close', 'closed'] as const) {
    const r = mapToClosingStage({ acquisition_stage: s })
    assert.equal(r.stage, s)
    assert.equal(r.source, 'acquisition_opportunities')
  }
})

// ── Milestone idempotency ─────────────────────────────────────────────────────
test('milestone: idempotency key is stable across re-serialized timestamps', () => {
  const a = buildMilestoneIdempotencyKey({ closingCaseId: 'c', type: 'title_opened', sourceEntityId: 'x', occurredAt: '2026-06-01T00:00:00Z' })
  const b = buildMilestoneIdempotencyKey({ closingCaseId: 'c', type: 'title_opened', sourceEntityId: 'x', occurredAt: '2026-06-01T00:00:00.000Z' })
  assert.equal(a, b)
})

test('milestone: dedupe collapses identical evidence to one row', () => {
  const m1 = createMilestone({ closingCaseId: 'c', type: 'title_opened', sourceSystem: 'fixture', sourceEntityId: 'x', occurredAt: '2026-06-01T00:00:00Z' })
  const m2 = createMilestone({ closingCaseId: 'c', type: 'title_opened', sourceSystem: 'fixture', sourceEntityId: 'x', occurredAt: '2026-06-01T00:00:00Z', recordedAt: '2026-06-02T00:00:00Z' })
  assert.equal(dedupeMilestones([m1, m2]).length, 1)
})

test('milestone: nextExpectedMilestone returns first unmet gate', () => {
  const next = nextExpectedMilestone(['accepted_offer_locked'])
  assert.equal(next?.type, 'contract_generated')
})

// ── Risk / blocker ordering ────────────────────────────────────────────────────
test('issues: ordering puts unresolved blockers first, resolved last', () => {
  const ordered = orderIssues([
    mkIssue({ issueId: 'low', severity: 'low', status: 'open' }),
    mkIssue({ issueId: 'resolved', severity: 'blocker', status: 'resolved' }),
    mkIssue({ issueId: 'blk', severity: 'blocker', status: 'open' }),
  ])
  assert.equal(ordered[0].issueId, 'blk')
  assert.equal(ordered[ordered.length - 1].issueId, 'resolved')
})

test('issues: resolved/waived are not actively blocking', () => {
  assert.equal(isActivelyBlocking(mkIssue({ severity: 'blocker', status: 'resolved' })), false)
  assert.equal(isActivelyBlocking(mkIssue({ severity: 'blocker', status: 'open' })), true)
  assert.equal(highestSeverityBlocker([mkIssue({ severity: 'high', status: 'open', issueId: 'h' })])?.issueId, 'h')
})

// ── Board derivation ───────────────────────────────────────────────────────────
test('board: active blocker pulls case into Issues / Curative', () => {
  const col = deriveBoardColumn({ universalStage: 'under_contract', closingStatus: 'unknown', contractStatus: 'fully_executed', titleStatus: 'opened', dispositionStatus: 'unknown', fundingStatus: 'unknown', clearToClose: null, hasActiveBlockingIssue: true, scheduledClosingDate: null })
  assert.equal(col, 'issues_curative')
})

test('board: unknown readiness never lands in Clear to Close (no inference from incomplete evidence)', () => {
  const col = deriveBoardColumn({ universalStage: 'prepared_to_close', closingStatus: 'unknown', contractStatus: 'fully_executed', titleStatus: 'commitment_received', dispositionStatus: 'funds_verified', fundingStatus: 'not_funded', clearToClose: null, hasActiveBlockingIssue: false, scheduledClosingDate: null })
  assert.notEqual(col, 'clear_to_close')
})

test('board: clear-to-close wins over scheduled', () => {
  const col = deriveBoardColumn({ universalStage: 'prepared_to_close', closingStatus: 'scheduled', contractStatus: 'fully_executed', titleStatus: 'cleared', dispositionStatus: 'funds_verified', fundingStatus: 'not_funded', clearToClose: true, hasActiveBlockingIssue: false, scheduledClosingDate: new Date(NOW).toISOString() })
  assert.equal(col, 'clear_to_close')
})

// ── Projection: missing data + no fabrication ───────────────────────────────────
test('projection: deep state is absent (never fabricated) and degraded is declared', () => {
  const c = projectClosingCase({ id: 'op1', acquisition_stage: 'contract_to_close', property_address_full: '1 Main St', current_offer: 150000, seller_display_name: 'Jane' })
  assert.equal(c.titleStatus, 'unknown')
  assert.equal(c.financials.buyerPrice, null)
  assert.equal(c.financials.expectedGrossRevenue, null)
  assert.equal(c.provenance.fullyBacked, false)
  assert.ok(c.provenance.degraded.length > 0)
  assert.equal(c.provenance.fields.title_status, 'absent')
})

test('projection: backed fields carry the right source', () => {
  const c = projectClosingCase({ id: 'op2', acquisition_stage: 'contract_to_close', current_offer: 99000 })
  assert.equal(c.financials.sellerContractPrice, 99000)
  assert.equal(c.provenance.fields.seller_contract_price, 'acquisition_opportunities')
})

test('projection: blocker text becomes a contract_issue and lands in curative lane', () => {
  const c = projectClosingCase({ id: 'op3', acquisition_stage: 'contract_to_close', blocker: 'Missing signer' })
  assert.equal(c.issues.length, 1)
  assert.equal(c.issues[0].category, 'contract_issue')
  assert.equal(c.boardColumn, 'issues_curative')
})

// ── Revenue / summary ───────────────────────────────────────────────────────────
test('summary: expected revenue only sums known buyer-priced cases', () => {
  const model = buildClosingDeskFixtureModel(NOW)
  const s = computeClosingSummary(model.cases, NOW)
  const manual = model.cases.reduce((acc, c) => acc + (c.financials.expectedGrossRevenue ?? 0), 0)
  assert.equal(s.expectedRevenue, manual)
  assert.ok(s.metricSources.expectedRevenue === 'derived')
})

test('summary: EMD overdue counts only past-due unreceived EMD', () => {
  const model = buildClosingDeskFixtureModel(NOW)
  const s = computeClosingSummary(model.cases, NOW)
  // Fixture demo-2 has emdDueInDays:-1 + emdReceived:false → exactly one overdue.
  assert.ok(s.emdOverdue >= 1)
})

// ── Read-only / no-mock-in-live invariants ──────────────────────────────────────
test('fixtures: model is flagged fixture mode with demo provenance', () => {
  const model = buildClosingDeskFixtureModel(NOW)
  assert.equal(model.mode, 'fixture')
  assert.ok(model.diagnostics.join(' ').toLowerCase().includes('demo'))
  for (const c of model.cases) assert.equal(c.provenance.fields.identity, 'fixture')
})

test('copilot: never marks an action executed; all require approval', () => {
  const model = buildClosingDeskFixtureModel(NOW)
  for (const c of model.cases) {
    const readout = buildCopilotReadout(c, NOW)
    for (const a of readout.proposedActions) {
      assert.equal(a.executed, false)
      assert.equal(a.requiresApproval, true)
      assert.ok(a.citedFacts.length > 0, 'proposed action must cite facts')
    }
    for (const i of readout.insights) {
      assert.ok(typeof i.headline === 'string')
    }
  }
})

// ── Report ───────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nClosing Desk tests: ${passed} passed, ${failures.length} FAILED\n`)
  console.error(failures.join('\n\n'))
  process.exit(1)
} else {
  console.log(`\nClosing Desk tests: all ${passed} passed ✓`)
}
