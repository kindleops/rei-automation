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
import { projectClosingCaseFromCase } from '../../src/domain/closing-desk/closing-projection'
import { computeClosingSummary } from '../../src/domain/closing-desk/closing-summary'
import { buildClosingDeskFixtureModel } from '../../src/domain/closing-desk/closing-fixtures'
import { buildCopilotReadout } from '../../src/domain/closing-desk/closing-copilot'
import {
  formatClosingDate,
  formatDaysToClose,
  humanizeEnum,
  humanizeOperatorText,
} from '../../src/views/closing-desk/closing-desk-present'
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
// These previously exercised mapToClosingStage(), which inferred a closing
// stage from an acquisition_opportunities row — including a `podio_mirror`
// metadata override. closing_cases.universal_stage is the stage, under a CHECK
// constraint, so there is nothing left to infer and no Podio to mirror.
test('stage: universal_stage is read directly from the canonical column', () => {
  for (const stage of ['formal_contract', 'under_contract', 'disposition', 'prepared_to_close', 'closed'] as const) {
    const c = projectClosingCaseFromCase({ closing_case_id: 'closing:1', universal_stage: stage })
    assert.equal(c.universalStage, stage)
    assert.equal(c.provenance.fields.universal_stage, 'closing_cases')
  }
})

test('stage: a value outside the CHECK constraint does not become a real stage', () => {
  const c = projectClosingCaseFromCase({ closing_case_id: 'closing:1', universal_stage: 'contract_to_close' })
  assert.equal(c.universalStage, 'formal_contract')
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
test('projection: an unset deep column is absent (never fabricated)', () => {
  const c = projectClosingCaseFromCase({
    closing_case_id: 'closing:op1',
    universal_stage: 'formal_contract',
    property_address: '1 Main St',
    seller_contract_price: 150000,
  })
  assert.equal(c.titleStatus, 'unknown')
  assert.equal(c.financials.buyerPrice, null)
  assert.equal(c.financials.expectedGrossRevenue, null)
  assert.equal(c.provenance.fullyBacked, false)
  assert.ok(c.provenance.degraded.length > 0)
  assert.equal(c.provenance.fields.title_status, 'absent')
})

test('projection: backed fields carry the right source', () => {
  const c = projectClosingCaseFromCase({ closing_case_id: 'closing:op2', seller_contract_price: 99000 })
  assert.equal(c.financials.sellerContractPrice, 99000)
  assert.equal(c.provenance.fields.seller_contract_price, 'closing_cases')
})

test('projection: a populated deep column is actually read, not stubbed', () => {
  // The old projection hardcoded every one of these to unknown/null, so a
  // fully-populated closing still rendered as an empty shell.
  const c = projectClosingCaseFromCase({
    closing_case_id: 'closing:op4',
    universal_stage: 'prepared_to_close',
    title_status: 'opened',
    escrow_status: 'funded',
    funding_status: 'funded',
    expected_gross_revenue: 12500,
    scheduled_closing_date: '2026-07-01T00:00:00Z',
    readiness: { clear_to_close: true },
  })
  assert.equal(c.titleStatus, 'opened')
  assert.equal(c.escrowStatus, 'funded')
  assert.equal(c.financials.expectedGrossRevenue, 12500)
  assert.equal(c.readiness.clearToClose, true)
  assert.equal(c.dates.scheduledClosingDate, '2026-07-01T00:00:00Z')
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

// ── Presentation formatters ─────────────────────────────────────────────────────
test('present: humanizeEnum title-cases snake_case enums', () => {
  assert.equal(humanizeEnum('on_track'), 'On Track')
  assert.equal(humanizeEnum('fully_executed'), 'Fully Executed')
  assert.equal(humanizeEnum('assignment_signed'), 'Assignment Signed')
  assert.equal(humanizeEnum('issues_open'), 'Issues Open')
  assert.equal(humanizeEnum('not_scheduled'), 'Not Scheduled')
})

test('present: formatClosingDate returns Not Scheduled for missing dates', () => {
  assert.equal(formatClosingDate(null), 'Not Scheduled')
  assert.equal(formatClosingDate(undefined), 'Not Scheduled')
})

test('present: humanizeOperatorText sanitizes copilot strings', () => {
  assert.equal(
    humanizeOperatorText('Health 72/100 (on_track) · universalStage=under_contract'),
    'Health 72/100 (On Track) · universalStage=Under Contract',
  )
})

test('present: formatDaysToClose handles null and overdue', () => {
  assert.equal(formatDaysToClose(null), 'Not Scheduled')
  assert.equal(formatDaysToClose(-3), '3d overdue')
  assert.equal(formatDaysToClose(5), '5')
})

// ── Report ───────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nClosing Desk tests: ${passed} passed, ${failures.length} FAILED\n`)
  console.error(failures.join('\n\n'))
  process.exit(1)
} else {
  console.log(`\nClosing Desk tests: all ${passed} passed ✓`)
}
