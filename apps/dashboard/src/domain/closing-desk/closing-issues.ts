/**
 * Canonical closing issue catalog + severity ordering.
 *
 * Issues are first-class curative work. Severity + status drive both the
 * "Issues / Curative" board column and the deterministic health engine.
 */
import type {
  ClosingIssue,
  ClosingIssueCategory,
  IssueSeverity,
  IssueStatus,
} from './closing-desk.types'

export interface ClosingIssueDef {
  category: ClosingIssueCategory
  label: string
  /** Default severity floor — a lien blocks; a code violation is high; etc. */
  defaultSeverity: IssueSeverity
  /** Default SLA in hours from open → due. null = no canonical SLA. */
  defaultSlaHours: number | null
  group: 'title' | 'authority' | 'buyer' | 'documents' | 'schedule' | 'contract' | 'other'
}

export const CLOSING_ISSUE_CATALOG: readonly ClosingIssueDef[] = Object.freeze([
  { category: 'title_defect', label: 'Title Defect', defaultSeverity: 'blocker', defaultSlaHours: 120, group: 'title' },
  { category: 'lien', label: 'Lien', defaultSeverity: 'blocker', defaultSlaHours: 120, group: 'title' },
  { category: 'mortgage_payoff', label: 'Mortgage Payoff', defaultSeverity: 'high', defaultSlaHours: 96, group: 'title' },
  { category: 'delinquent_taxes', label: 'Delinquent Taxes', defaultSeverity: 'high', defaultSlaHours: 96, group: 'title' },
  { category: 'municipal_lien', label: 'Municipal Lien', defaultSeverity: 'high', defaultSlaHours: 96, group: 'title' },
  { category: 'code_violation', label: 'Code Violation', defaultSeverity: 'medium', defaultSlaHours: 168, group: 'title' },
  { category: 'probate', label: 'Probate', defaultSeverity: 'blocker', defaultSlaHours: 336, group: 'authority' },
  { category: 'heirship', label: 'Heirship', defaultSeverity: 'blocker', defaultSlaHours: 336, group: 'authority' },
  { category: 'divorce', label: 'Divorce', defaultSeverity: 'high', defaultSlaHours: 240, group: 'authority' },
  { category: 'bankruptcy', label: 'Bankruptcy', defaultSeverity: 'blocker', defaultSlaHours: 336, group: 'authority' },
  { category: 'trust_authority', label: 'Trust Authority', defaultSeverity: 'high', defaultSlaHours: 168, group: 'authority' },
  { category: 'llc_authority', label: 'LLC Authority', defaultSeverity: 'high', defaultSlaHours: 168, group: 'authority' },
  { category: 'missing_signer', label: 'Missing Signer', defaultSeverity: 'blocker', defaultSlaHours: 72, group: 'authority' },
  { category: 'deceased_owner', label: 'Deceased Owner', defaultSeverity: 'blocker', defaultSlaHours: 336, group: 'authority' },
  { category: 'open_permit', label: 'Open Permit', defaultSeverity: 'medium', defaultSlaHours: 168, group: 'title' },
  { category: 'deed_correction', label: 'Deed Correction', defaultSeverity: 'high', defaultSlaHours: 120, group: 'title' },
  { category: 'buyer_funding', label: 'Buyer Funding', defaultSeverity: 'high', defaultSlaHours: 72, group: 'buyer' },
  { category: 'buyer_emd', label: 'Buyer EMD', defaultSeverity: 'high', defaultSlaHours: 48, group: 'buyer' },
  { category: 'seller_documents', label: 'Seller Documents', defaultSeverity: 'medium', defaultSlaHours: 72, group: 'documents' },
  { category: 'buyer_documents', label: 'Buyer Documents', defaultSeverity: 'medium', defaultSlaHours: 72, group: 'documents' },
  { category: 'closing_date_risk', label: 'Closing Date Risk', defaultSeverity: 'high', defaultSlaHours: 48, group: 'schedule' },
  { category: 'contract_issue', label: 'Contract Issue', defaultSeverity: 'high', defaultSlaHours: 48, group: 'contract' },
  { category: 'assignment_issue', label: 'Assignment Issue', defaultSeverity: 'high', defaultSlaHours: 48, group: 'contract' },
  { category: 'occupancy_possession', label: 'Occupancy / Possession', defaultSeverity: 'medium', defaultSlaHours: 168, group: 'other' },
  { category: 'other', label: 'Other', defaultSeverity: 'low', defaultSlaHours: null, group: 'other' },
])

const ISSUE_BY_CATEGORY: ReadonlyMap<ClosingIssueCategory, ClosingIssueDef> = new Map(
  CLOSING_ISSUE_CATALOG.map((def) => [def.category, def]),
)

export function getIssueDef(category: ClosingIssueCategory): ClosingIssueDef | null {
  return ISSUE_BY_CATEGORY.get(category) ?? null
}

export function issueLabel(category: ClosingIssueCategory): string {
  return ISSUE_BY_CATEGORY.get(category)?.label ?? category
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { blocker: 0, high: 1, medium: 2, low: 3 }
const STATUS_RANK: Record<IssueStatus, number> = {
  open: 0,
  in_progress: 1,
  waiting: 2,
  resolved: 3,
  waived: 4,
}

export function severityRank(severity: IssueSeverity): number {
  return SEVERITY_RANK[severity] ?? 99
}

/** An issue actively blocks the deal when it is unresolved and blocker/high. */
export function isActivelyBlocking(issue: ClosingIssue): boolean {
  if (issue.status === 'resolved' || issue.status === 'waived') return false
  return issue.severity === 'blocker' || issue.severity === 'high'
}

/**
 * Canonical ordering: unresolved before resolved, then by severity, then by
 * SLA urgency (soonest due first), then by open date. Deterministic + stable.
 */
export function orderIssues(issues: ClosingIssue[]): ClosingIssue[] {
  return [...issues].sort((a, b) => {
    const aResolved = a.status === 'resolved' || a.status === 'waived' ? 1 : 0
    const bResolved = b.status === 'resolved' || b.status === 'waived' ? 1 : 0
    if (aResolved !== bResolved) return aResolved - bResolved

    if (severityRank(a.severity) !== severityRank(b.severity)) {
      return severityRank(a.severity) - severityRank(b.severity)
    }
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER
    if (aDue !== bDue) return aDue - bDue

    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
      return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    }
    const aOpen = a.openedAt ? new Date(a.openedAt).getTime() : 0
    const bOpen = b.openedAt ? new Date(b.openedAt).getTime() : 0
    return aOpen - bOpen
  })
}

/** Highest-severity, soonest-due unresolved blocker. null when none. */
export function highestSeverityBlocker(issues: ClosingIssue[]): ClosingIssue | null {
  const active = orderIssues(issues.filter(isActivelyBlocking))
  return active[0] ?? null
}
