import type {
  ClosingDataSource,
  ClosingPartyRole,
  ClosingIssueCategory,
  IssueSeverity,
  IssueStatus,
} from '../../domain/closing-desk/closing-desk.types'
import { issueLabel } from '../../domain/closing-desk/closing-issues'

/** Canonical operator-facing formatter — never mutates stored enum values. */
export function humanizeEnum(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value === 'unknown') return 'Unknown'
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

const PARTY_ROLE_LABELS: Record<ClosingPartyRole, string> = {
  seller: 'Seller',
  signer: 'Signer',
  acquisition_owner: 'Acquisition Owner',
  transaction_coordinator: 'Transaction Coordinator',
  disposition_owner: 'Disposition Owner',
  selected_buyer: 'Selected Buyer',
  buyer_representative: 'Buyer Representative',
  title_contact: 'Title Contact',
  attorney: 'Attorney',
  closing_agent: 'Closing Agent',
  blocker_owner: 'Blocker Owner',
}

export function partyRoleLabel(role: ClosingPartyRole): string {
  return PARTY_ROLE_LABELS[role] ?? humanizeEnum(role) ?? role
}

export function formatBool(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value ? 'Yes' : 'No'
}

export function formatDatePresent(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatClosingDate(iso: string | null | undefined): string {
  return formatDatePresent(iso) ?? 'Not Scheduled'
}

export function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatIssueCategory(category: ClosingIssueCategory): string {
  return issueLabel(category)
}

export function formatIssueSeverity(severity: IssueSeverity): string {
  return humanizeEnum(severity) ?? severity
}

export function formatIssueStatus(status: IssueStatus): string {
  return humanizeEnum(status) ?? status
}

export function formatDataSource(source: ClosingDataSource): string {
  const labels: Partial<Record<ClosingDataSource, string>> = {
    acquisition_opportunities: 'Acquisition Opportunities',
    closing_cases: 'Closing Cases',
    podio_mirror: 'Podio Mirror',
    derived: 'Derived',
    fixture: 'Synthetic Fixture',
    absent: 'Not Projected',
  }
  return labels[source] ?? humanizeEnum(source) ?? source
}

export function formatDaysToClose(days: number | null | undefined): string {
  if (days === null || days === undefined) return 'Not Scheduled'
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'Today'
  return `${days}`
}

export function displayEntityName(
  name: string | null | undefined,
  fallback = 'Not projected',
): string {
  if (!name || name.trim() === '') return fallback
  return name
}

/** Operator-safe text — title-cases embedded snake_case tokens without mutating source data. */
export function humanizeOperatorText(text: string): string {
  return text.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) => humanizeEnum(token) ?? token)
}