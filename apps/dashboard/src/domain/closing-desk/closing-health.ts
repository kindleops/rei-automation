/**
 * Deterministic closing health engine.
 *
 * NO fake AI confidence. The score starts at a fixed base and every delta is
 * a named rule with the concrete fact that triggered it (`factors`), so the UI
 * can render an exhaustive "why is this score what it is" explanation. Given
 * identical inputs the output is byte-stable.
 */
import type {
  ClosingDates,
  ClosingHealth,
  ClosingHealthBand,
  ClosingHealthFactor,
  ClosingIssue,
  ClosingMilestone,
  ClosingMilestoneType,
  ClosingReadiness,
  ClosingUniversalStage,
} from './closing-desk.types'
import { highestSeverityBlocker, isActivelyBlocking } from './closing-issues'
import { CLOSING_MILESTONE_CATALOG, milestoneLabel } from './closing-milestones'

const BASE_SCORE = 100
const MS_PER_DAY = 86_400_000

export interface HealthInput {
  universalStage: ClosingUniversalStage
  dates: ClosingDates
  readiness: ClosingReadiness
  issues: ClosingIssue[]
  milestones: ClosingMilestone[]
  /** Injectable clock for deterministic tests. Defaults to Date.now(). */
  now?: number
}

function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / MS_PER_DAY)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Milestone types that are expected to have occurred by a given stage. Used to
 * count "overdue" gates without inventing dates the system does not have.
 */
const STAGE_EXPECTED_GATES: Record<ClosingUniversalStage, ClosingMilestoneType[]> = {
  formal_contract: ['accepted_offer_locked'],
  under_contract: ['contract_fully_executed', 'closing_case_created', 'title_opened'],
  disposition: ['contract_fully_executed', 'title_opened', 'buyer_selected'],
  prepared_to_close: ['title_opened', 'buyer_selected', 'closing_scheduled'],
  closed: ['clear_to_close', 'funded', 'recorded'],
}

function countOverdueMilestones(input: HealthInput): { count: number; missing: ClosingMilestoneType[] } {
  const achieved = new Set(input.milestones.map((m) => m.type))
  const expected = STAGE_EXPECTED_GATES[input.universalStage] ?? []
  const missing = expected.filter((type) => !achieved.has(type))
  return { count: missing.length, missing }
}

/**
 * Data completeness: fraction of readiness flags + key dates that are actually
 * known (non-null). A low completeness score is surfaced so operators never
 * mistake "unknown" for "healthy".
 */
export function computeDataCompleteness(
  readiness: ClosingReadiness,
  dates: ClosingDates,
): number {
  const readinessValues = Object.values(readiness)
  const dateValues = Object.values(dates)
  const total = readinessValues.length + dateValues.length
  if (total === 0) return 0
  const known =
    readinessValues.filter((v) => v !== null).length +
    dateValues.filter((v) => v !== null).length
  return Math.round((known / total) * 100)
}

function bandForScore(score: number): ClosingHealthBand {
  if (score >= 80) return 'on_track'
  if (score >= 60) return 'watch'
  if (score >= 35) return 'at_risk'
  return 'critical'
}

/**
 * On-time close probability. Heuristic but deterministic and fully derived
 * from blockers + schedule pressure. Returns null when there is not enough
 * data (no scheduled date AND no milestones) rather than fabricating a number.
 */
function onTimeProbability(
  score: number,
  daysUntilClosing: number | null,
  blockingIssueCount: number,
  hasSignal: boolean,
): number | null {
  if (!hasSignal) return null
  let p = score / 100
  if (daysUntilClosing !== null) {
    if (daysUntilClosing < 0) p -= 0.4
    else if (daysUntilClosing <= 2) p -= 0.15
    else if (daysUntilClosing <= 7) p -= 0.05
  }
  p -= Math.min(0.4, blockingIssueCount * 0.12)
  return clamp(Number(p.toFixed(2)), 0, 1)
}

function nextRequiredAction(
  input: HealthInput,
  topBlocker: ClosingIssue | null,
): { action: string | null; party: string | null; sla: string | null } {
  if (topBlocker) {
    return {
      action: `Resolve ${topBlocker.title}`,
      party: topBlocker.owner,
      sla: topBlocker.dueAt,
    }
  }
  // Otherwise the next unmet expected gate for the current stage.
  const achieved = new Set(input.milestones.map((m) => m.type))
  for (const def of CLOSING_MILESTONE_CATALOG) {
    if (def.type === 'closing_cancelled') continue
    if (def.stageHint !== input.universalStage) continue
    if (!achieved.has(def.type)) {
      return { action: `Complete: ${def.label}`, party: null, sla: null }
    }
  }
  return { action: null, party: null, sla: null }
}

export function computeClosingHealth(input: HealthInput): ClosingHealth {
  const now = input.now ?? Date.now()
  const factors: ClosingHealthFactor[] = []
  let score = BASE_SCORE

  // 1. Active blocking issues.
  const blockingIssues = input.issues.filter(isActivelyBlocking)
  const topBlocker = highestSeverityBlocker(input.issues)
  for (const issue of blockingIssues) {
    const delta = issue.severity === 'blocker' ? -18 : -10
    score += delta
    factors.push({
      rule: 'blocking_issue',
      label: `Blocking issue: ${issue.title}`,
      delta,
      evidence: `${issue.category} (${issue.severity}) status=${issue.status}`,
    })
  }

  // 2. Overdue / missing expected milestones for the current stage.
  const overdue = countOverdueMilestones(input)
  for (const type of overdue.missing) {
    score -= 8
    factors.push({
      rule: 'overdue_milestone',
      label: `Missing gate: ${milestoneLabel(type)}`,
      delta: -8,
      evidence: `Expected by stage "${input.universalStage}" but not recorded`,
    })
  }

  // 3. Schedule pressure relative to the scheduled closing date.
  let daysUntilClosing: number | null = null
  if (input.dates.scheduledClosingDate) {
    daysUntilClosing = daysBetween(now, new Date(input.dates.scheduledClosingDate).getTime())
    if (daysUntilClosing < 0) {
      score -= 20
      factors.push({
        rule: 'closing_date_passed',
        label: 'Scheduled closing date has passed',
        delta: -20,
        evidence: `Scheduled ${Math.abs(daysUntilClosing)}d ago and not closed`,
      })
    } else if (daysUntilClosing <= 3 && !input.readiness.clearToClose) {
      score -= 12
      factors.push({
        rule: 'closing_imminent_not_clear',
        label: 'Closing imminent but not clear to close',
        delta: -12,
        evidence: `${daysUntilClosing}d to scheduled close, clearToClose=${String(input.readiness.clearToClose)}`,
      })
    }
  }

  // 4. EMD overdue.
  if (input.dates.emdDueDate && input.readiness.emdReceived === false) {
    const emdDays = daysBetween(now, new Date(input.dates.emdDueDate).getTime())
    if (emdDays < 0) {
      score -= 12
      factors.push({
        rule: 'emd_overdue',
        label: 'Earnest money deposit overdue',
        delta: -12,
        evidence: `EMD due ${Math.abs(emdDays)}d ago, not received`,
      })
    }
  }

  // 5. Positive signal: clear-to-close achieved.
  if (input.readiness.clearToClose === true) {
    score += 6
    factors.push({
      rule: 'clear_to_close',
      label: 'Clear to close confirmed',
      delta: 6,
      evidence: 'readiness.clearToClose=true',
    })
  }

  // 6. Data completeness penalty: an under-known case cannot be called healthy.
  const dataCompletenessScore = computeDataCompleteness(input.readiness, input.dates)
  if (dataCompletenessScore < 40) {
    score -= 10
    factors.push({
      rule: 'low_data_completeness',
      label: 'Low data completeness',
      delta: -10,
      evidence: `${dataCompletenessScore}% of readiness/date fields known`,
    })
  }

  score = clamp(Math.round(score), 0, 100)

  const hasSignal =
    input.milestones.length > 0 ||
    input.dates.scheduledClosingDate !== null ||
    input.issues.length > 0
  const next = nextRequiredAction(input, topBlocker)

  return {
    score,
    band: hasSignal ? bandForScore(score) : 'unknown',
    onTimeCloseProbability: onTimeProbability(score, daysUntilClosing, blockingIssues.length, hasSignal),
    daysUntilClosing,
    overdueMilestoneCount: overdue.count,
    blockingIssueCount: blockingIssues.length,
    highestSeverityBlocker: topBlocker,
    nextRequiredAction: next.action,
    responsibleParty: next.party,
    slaDeadline: next.sla,
    dataCompletenessScore,
    factors,
  }
}
