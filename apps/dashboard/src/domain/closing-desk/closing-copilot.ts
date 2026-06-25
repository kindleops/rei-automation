/**
 * Closing Copilot — READ-ONLY reasoning contract.
 *
 * The copilot may summarize state, explain blockers, identify missing
 * information, prioritize tasks, surface risk, and PROPOSE next steps. It may
 * NOT execute anything. Every recommendation is paired with the concrete facts
 * that produced it (so the UI can cite them), and any action it suggests is a
 * `ProposedClosingAction` with `requiresApproval: true` / `executed: false`.
 */
import type {
  ClosingCase,
  ProposedClosingAction,
} from './closing-desk.types'
import { orderIssues } from './closing-issues'
import { nextExpectedMilestone } from './closing-milestones'

export interface CopilotInsight {
  kind: 'summary' | 'blocker' | 'missing_info' | 'risk' | 'next_milestone' | 'timeline'
  headline: string
  detail: string
  /** Facts backing this insight; rendered verbatim in the UI. */
  citedFacts: string[]
}

export interface CopilotReadout {
  insights: CopilotInsight[]
  proposedActions: ProposedClosingAction[]
}

function fmtMoney(v: number | null): string {
  return v === null ? '—' : `$${v.toLocaleString()}`
}

/** Deterministic read-only analysis. No model calls, no side effects. */
export function buildCopilotReadout(c: ClosingCase, now: number = Date.now()): CopilotReadout {
  void now // reserved for future time-relative reasoning; kept for a stable signature
  const insights: CopilotInsight[] = []
  const proposedActions: ProposedClosingAction[] = []

  // 1. State summary.
  insights.push({
    kind: 'summary',
    headline: `Stage: ${c.universalStage.replace(/_/g, ' ')} · Health ${c.health.score}/100 (${c.health.band})`,
    detail: `${c.displayName} in ${c.market ?? 'unknown market'}. Seller contract ${fmtMoney(c.financials.sellerContractPrice)}, expected gross ${fmtMoney(c.financials.expectedGrossRevenue)}.`,
    citedFacts: [
      `universalStage=${c.universalStage}`,
      `healthScore=${c.health.score}`,
      `dataCompleteness=${c.health.dataCompletenessScore}%`,
    ],
  })

  // 2. Blockers (highest first).
  const blockers = orderIssues(c.issues).filter(
    (i) => i.status !== 'resolved' && i.status !== 'waived',
  )
  for (const issue of blockers.slice(0, 3)) {
    insights.push({
      kind: 'blocker',
      headline: `Blocker: ${issue.title}`,
      detail: `${issue.severity.toUpperCase()} · owner ${issue.owner ?? 'unassigned'} · due ${issue.dueAt ?? 'no SLA'}.`,
      citedFacts: [`category=${issue.category}`, `severity=${issue.severity}`, `status=${issue.status}`],
    })
  }

  // 3. Missing information (from health factors + provenance).
  if (c.health.dataCompletenessScore < 60) {
    insights.push({
      kind: 'missing_info',
      headline: 'Incomplete closing record',
      detail: `Only ${c.health.dataCompletenessScore}% of readiness and date fields are known. ${c.provenance.degraded[0] ?? ''}`,
      citedFacts: c.provenance.degraded,
    })
  }

  // 4. Risk explanation from the deterministic factors.
  const negatives = c.health.factors.filter((f) => f.delta < 0)
  if (negatives.length > 0) {
    insights.push({
      kind: 'risk',
      headline: `${negatives.length} factor(s) reducing health`,
      detail: negatives.map((f) => `${f.label} (${f.delta})`).join('; '),
      citedFacts: negatives.map((f) => `${f.rule}: ${f.evidence}`),
    })
  }

  // 5. Next milestone.
  const next = nextExpectedMilestone(c.milestones.map((m) => m.type))
  if (next) {
    insights.push({
      kind: 'next_milestone',
      headline: `Next milestone: ${next.label}`,
      detail: c.health.nextRequiredAction ?? `Advance toward ${next.label}.`,
      citedFacts: [`nextRequiredAction=${c.health.nextRequiredAction ?? 'derived from catalog'}`],
    })
  }

  // 6. Proposed actions — never executed.
  if (c.health.highestSeverityBlocker) {
    const b = c.health.highestSeverityBlocker
    if (b.category === 'mortgage_payoff' && c.readiness.payoffReceived === false) {
      proposedActions.push({
        kind: 'request_payoff',
        closingCaseId: c.identity.closingCaseId,
        label: 'Request payoff statement',
        rationale: 'Mortgage payoff is the highest-severity open blocker and payoff has not been received.',
        citedFacts: [`issue=${b.category}`, 'readiness.payoffReceived=false'],
        requiresApproval: true,
        executed: false,
      })
    }
    if (b.category === 'buyer_emd' && c.readiness.emdReceived === false) {
      proposedActions.push({
        kind: 'notify_buyer',
        closingCaseId: c.identity.closingCaseId,
        label: 'Notify buyer: EMD overdue',
        rationale: 'Buyer EMD is overdue and is the top blocker to clearing the deal.',
        citedFacts: ['readiness.emdReceived=false', `emdDueDate=${c.dates.emdDueDate ?? 'unknown'}`],
        requiresApproval: true,
        executed: false,
      })
    }
  }
  if (
    c.readiness.clearToClose === true &&
    c.readiness.funded !== true &&
    c.dates.scheduledClosingDate
  ) {
    proposedActions.push({
      kind: 'schedule_closing',
      closingCaseId: c.identity.closingCaseId,
      label: 'Confirm signing appointment',
      rationale: 'Deal is clear to close with a scheduled closing date but funding has not occurred.',
      citedFacts: ['readiness.clearToClose=true', `scheduledClosingDate=${c.dates.scheduledClosingDate}`],
      requiresApproval: true,
      executed: false,
    })
  }

  return { insights, proposedActions }
}
