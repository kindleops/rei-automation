/**
 * Projection: canonical Supabase rows → ClosingCase aggregate.
 *
 * THE AUTHORITY IS `public.closing_cases` — one row per transaction, written by
 * apps/api/src/lib/domain/closings/* (create-closing-case-from-acceptance,
 * reconcile-closing-case-from-envelope, advance-closing-workflow,
 * sync-closing-milestones). It carries the deep title/escrow/disposition/
 * funding/revenue state and every closing deadline.
 *
 * This file previously projected `acquisition_opportunities` and hardcoded
 * EVERY deep field to null/'unknown'/'absent' with the note "lives in Podio".
 * Podio is dead (2026-08-28) and that projection now exists in Supabase, so the
 * absent-everything posture understated what the system can answer.
 *
 * HONESTY CONTRACT is unchanged: a column the writers never populate stays
 * `absent`. We read real values; we never invent them, and we never coerce a
 * null into a zero or into 'unknown' when the distinction matters.
 */
import type {
  ClosingCase,
  ClosingDataSource,
  ClosingDates,
  ClosingFinancials,
  ClosingIssue,
  ClosingMilestone,
  ClosingProvenance,
  ClosingReadiness,
} from './closing-desk.types'
import { computeClosingHealth } from './closing-health'
import { deriveBoardColumn } from './closing-board'
import { createMilestone, dedupeMilestones } from './closing-milestones'

const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL PROJECTION — public.closing_cases
// ─────────────────────────────────────────────────────────────────────────────

/** Raw shape of a public.closing_cases row (see CLOSING_CASE_COLUMNS server-side). */
export interface RawClosingCaseRow {
  closing_case_id?: string | null
  opportunity_id?: string | null
  property_id?: string | null
  property_address?: string | null
  master_owner_id?: string | null
  prospect_id?: string | null
  thread_key?: string | null
  buyer_id?: string | null
  title_company_id?: string | null
  universal_stage?: string | null
  closing_status?: string | null
  closing_substage?: string | null
  contract_status?: string | null
  disposition_status?: string | null
  title_status?: string | null
  escrow_status?: string | null
  funding_status?: string | null
  revenue_status?: string | null
  health_band?: string | null
  risk_level?: string | null
  docusign_status?: string | null
  docusign_envelope_id?: string | null
  envelope_sent_at?: string | null
  contract_signed_date?: string | null
  effective_date?: string | null
  emd_due_date?: string | null
  inspection_deadline?: string | null
  title_opened_date?: string | null
  title_commitment_date?: string | null
  cure_deadline?: string | null
  scheduled_closing_date?: string | null
  signing_date?: string | null
  funding_date?: string | null
  recording_date?: string | null
  revenue_confirmed_date?: string | null
  seller_contract_price?: number | string | null
  earnest_money?: number | string | null
  buyer_price?: number | string | null
  assignment_fee?: number | string | null
  expected_gross_revenue?: number | string | null
  confirmed_gross_revenue?: number | string | null
  net_revenue?: number | string | null
  title_company_name?: string | null
  title_route_status?: string | null
  readiness?: Record<string, unknown> | null
  health_score?: number | null
  data_completeness_score?: number | null
  provenance?: Record<string, unknown> | null
  last_activity_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

/**
 * Numeric columns arrive from PostgREST as strings for numeric/decimal types,
 * so a bare `typeof v === 'number'` check would silently null every price.
 * Only genuine numbers and numeric strings convert — `null`, `''`, `[]` and
 * booleans do not, because Number(null) and Number([]) are both 0.
 */
const money = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Read a value only when it is one of the vocabulary the writers produce. */
function enumOr<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(v)?.toLowerCase()
  return s && (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}

/**
 * readiness is a jsonb map written by the closing workflow. Production's single
 * case holds `{}`, so every gate reads null — genuinely unknown, not false.
 * A missing gate must stay null: `false` would assert the gate was CHECKED and
 * FAILED, which would put the case in the wrong board lane.
 */
function readReadiness(raw: Record<string, unknown> | null | undefined): ClosingReadiness {
  const map = raw && typeof raw === 'object' ? raw : {}
  const gate = (key: string): boolean | null => {
    const v = (map as Record<string, unknown>)[key]
    return typeof v === 'boolean' ? v : null
  }
  return {
    contractComplete: gate('contract_complete'),
    allSignersVerified: gate('all_signers_verified'),
    ownershipVerified: gate('ownership_verified'),
    authorityVerified: gate('authority_verified'),
    emdReceived: gate('emd_received'),
    buyerSecured: gate('buyer_secured'),
    buyerFundsVerified: gate('buyer_funds_verified'),
    titleOpened: gate('title_opened'),
    titleCommitmentReceived: gate('title_commitment_received'),
    liensResolved: gate('liens_resolved'),
    probateResolved: gate('probate_resolved'),
    payoffReceived: gate('payoff_received'),
    municipalIssuesResolved: gate('municipal_issues_resolved'),
    settlementStatementApproved: gate('settlement_statement_approved'),
    sellerReady: gate('seller_ready'),
    buyerReady: gate('buyer_ready'),
    signingScheduled: gate('signing_scheduled'),
    clearToClose: gate('clear_to_close'),
    funded: gate('funded'),
    recorded: gate('recorded'),
    closed: gate('closed'),
  }
}

const UNIVERSAL_STAGES = ['formal_contract', 'under_contract', 'disposition', 'prepared_to_close', 'closed'] as const
const CONTRACT_STATUSES = ['draft', 'sent_for_signature', 'viewed', 'seller_signed', 'buyer_signed', 'fully_executed', 'declined', 'cancelled', 'unknown'] as const
const CLOSING_STATUSES = ['not_scheduled', 'title_pending', 'in_title', 'scheduled', 'confirmed', 'rescheduled', 'completed', 'closed', 'cancelled', 'unknown'] as const
const TITLE_STATUSES = ['not_opened', 'opened', 'commitment_received', 'issues_open', 'cleared', 'unknown'] as const
const ESCROW_STATUSES = ['not_opened', 'opened', 'funded', 'disbursed', 'unknown'] as const
const FUNDING_STATUSES = ['not_funded', 'pending', 'funded', 'recorded', 'unknown'] as const
const DISPOSITION_STATUSES = ['not_started', 'matching', 'buyer_selected', 'assignment_out', 'assignment_signed', 'emd_received', 'funds_verified', 'not_applicable', 'unknown'] as const
const REVENUE_STATUSES = ['projected', 'expected_soon', 'confirmed', 'wire_received', 'reconciled', 'unknown'] as const

/** True when the correction pathway voided this case (independent of status). */
export function isVoidedCase(row: RawClosingCaseRow): boolean {
  const p = row.provenance
  return !!(p && typeof p === 'object' && (p as Record<string, unknown>).voided === true)
}

/** §31 — terminal contract states end a transaction, whatever progress preceded. */
export function isTerminalCase(row: RawClosingCaseRow): boolean {
  const s = str(row.contract_status)?.toLowerCase()
  return s === 'cancelled' || s === 'declined' || isVoidedCase(row)
}

/**
 * Project a closing_cases row. Every field is either read from a real column or
 * left null/'unknown' with its provenance recorded as 'absent'.
 */
export function projectClosingCaseFromCase(row: RawClosingCaseRow): ClosingCase {
  const closingCaseId = str(row.closing_case_id) ?? str(row.opportunity_id) ?? `unknown:${str(row.thread_key) ?? 'na'}`
  const stage = enumOr(row.universal_stage, UNIVERSAL_STAGES, 'formal_contract')
  const contractStatus = enumOr(row.contract_status, CONTRACT_STATUSES, 'unknown')
  const closingStatus = enumOr(row.closing_status, CLOSING_STATUSES, 'unknown')
  const titleStatus = enumOr(row.title_status, TITLE_STATUSES, 'unknown')
  const voided = isVoidedCase(row)

  const dates: ClosingDates = {
    contractSignedDate: str(row.contract_signed_date),
    effectiveDate: str(row.effective_date),
    emdDueDate: str(row.emd_due_date),
    inspectionDeadline: str(row.inspection_deadline),
    titleOpenedDate: str(row.title_opened_date),
    titleCommitmentDate: str(row.title_commitment_date),
    cureDeadline: str(row.cure_deadline),
    scheduledClosingDate: str(row.scheduled_closing_date),
    signingDate: str(row.signing_date),
    fundingDate: str(row.funding_date),
    recordingDate: str(row.recording_date),
    revenueConfirmedDate: str(row.revenue_confirmed_date),
  }

  const readiness = readReadiness(row.readiness)

  const financials: ClosingFinancials = {
    sellerContractPrice: money(row.seller_contract_price),
    buyerPrice: money(row.buyer_price),
    assignmentFee: money(row.assignment_fee),
    doubleCloseSpread: null,
    buyerEmd: money(row.earnest_money),
    sellerCredits: null,
    closingCosts: null,
    titleFees: null,
    expectedGrossRevenue: money(row.expected_gross_revenue),
    confirmedGrossRevenue: money(row.confirmed_gross_revenue),
    netRevenue: money(row.net_revenue),
    fundingSource: null,
    revenueStatus: enumOr(row.revenue_status, REVENUE_STATUSES, 'unknown'),
  }

  // A voided case carries exactly one issue: the void itself, stated plainly.
  const issues: ClosingIssue[] = []
  if (voided) {
    const p = (row.provenance ?? {}) as Record<string, unknown>
    const correction = (p.monetary_correction ?? {}) as Record<string, unknown>
    issues.push({
      issueId: `${closingCaseId}:voided`,
      closingCaseId,
      category: 'contract_issue',
      title: str(correction.truth) ?? 'This closing case was voided by an authorized correction.',
      severity: 'blocker',
      status: 'resolved',
      owner: str(correction.authorized_by),
      openedAt: str(row.created_at),
      dueAt: null,
      slaHours: null,
      resolutionRequirements: [],
      evidence: [],
      dependencies: [],
      blockingMilestones: [],
      resolvedAt: str(correction.applied_at) ?? str(row.updated_at),
      resolutionNote: str(correction.containment),
      source: 'closing_cases',
    })
  }

  const milestones: ClosingMilestone[] = dedupeMilestones([
    createMilestone({
      closingCaseId,
      type: 'closing_case_created',
      sourceSystem: 'closing_cases',
      sourceEntityId: closingCaseId,
      occurredAt: str(row.created_at),
      recordedAt: str(row.created_at) ?? new Date().toISOString(),
      actor: str((row.provenance as Record<string, unknown>)?.source as string) ?? 'system',
      resultingState: stage,
      snapshot: { universal_stage: stage, contract_status: contractStatus },
    }),
  ])

  const health = computeClosingHealth({ universalStage: stage, dates, readiness, issues, milestones })

  // §31 — a terminal case belongs in the Cancelled lane, never in a live lane.
  const boardColumn: ClosingCase['boardColumn'] =
    contractStatus === 'cancelled' || contractStatus === 'declined' || voided
      ? 'cancelled'
      : deriveBoardColumn({
          universalStage: stage,
          closingStatus,
          contractStatus,
          titleStatus,
          dispositionStatus: enumOr(row.disposition_status, DISPOSITION_STATUSES, 'unknown'),
          fundingStatus: enumOr(row.funding_status, FUNDING_STATUSES, 'unknown'),
          clearToClose: readiness.clearToClose,
          hasActiveBlockingIssue: issues.some((i) => i.status === 'open' && (i.severity === 'blocker' || i.severity === 'high')),
          scheduledClosingDate: dates.scheduledClosingDate,
        })

  /** A column is 'closing_cases' when it actually held a value, else 'absent'. */
  const srcOf = (v: unknown): ClosingDataSource => (v === null || v === undefined || v === '' ? 'absent' : 'closing_cases')

  const degraded: string[] = []
  if (!str(row.title_status)) degraded.push('title_status is not set on this case — title state is unknown, not clear.')
  if (!str(row.disposition_status)) degraded.push('disposition_status is not set — buyer-side progress is unknown.')
  if (money(row.expected_gross_revenue) === null) degraded.push('expected_gross_revenue is not set — revenue is unknown, not $0.')
  if (voided) degraded.push('This case was VOIDED by an authorized correction and is not live work.')

  const fields: ClosingProvenance['fields'] = {
    identity: 'closing_cases',
    universal_stage: srcOf(row.universal_stage),
    contract_status: srcOf(row.contract_status),
    closing_status: srcOf(row.closing_status),
    title_status: srcOf(row.title_status),
    escrow_status: srcOf(row.escrow_status),
    funding_status: srcOf(row.funding_status),
    disposition_status: srcOf(row.disposition_status),
    revenue_status: srcOf(row.revenue_status),
    seller_contract_price: srcOf(row.seller_contract_price),
    buyer_price: srcOf(row.buyer_price),
    expected_gross_revenue: srcOf(row.expected_gross_revenue),
    confirmed_revenue: srcOf(row.confirmed_gross_revenue),
    emd: srcOf(row.earnest_money),
    closing_dates: dates.scheduledClosingDate ? 'closing_cases' : 'absent',
    readiness_checklist: Object.values(readiness).some((v) => v !== null) ? 'closing_cases' : 'absent',
    buyer: srcOf(row.buyer_id),
    title_company: srcOf(row.title_company_id),
  }

  return {
    identity: {
      closingCaseId,
      primaryThreadKey: str(row.thread_key),
      propertyId: str(row.property_id),
      masterOwnerId: str(row.master_owner_id),
      prospectId: str(row.prospect_id),
      opportunityId: str(row.opportunity_id),
      offerId: null,
      contractId: str(row.docusign_envelope_id),
      buyerId: str(row.buyer_id),
      assignmentId: null,
      titleCompanyId: str(row.title_company_id),
      escrowFileNumber: null,
    },
    displayName: str(row.property_address) ?? str(row.property_id) ?? closingCaseId,
    propertyAddress: str(row.property_address),
    market: null, // closing_cases carries no market column; resolving it needs a property join.
    sellerName: null, // ditto — the owner name lives on master_owners.
    universalStage: stage,
    boardColumn,
    closingStatus,
    contractStatus,
    dispositionStatus: enumOr(row.disposition_status, DISPOSITION_STATUSES, 'unknown'),
    titleStatus,
    escrowStatus: enumOr(row.escrow_status, ESCROW_STATUSES, 'unknown'),
    fundingStatus: enumOr(row.funding_status, FUNDING_STATUSES, 'unknown'),
    riskLevel:
      health.band === 'critical' ? 'severe' : health.band === 'at_risk' ? 'high' : health.band === 'watch' ? 'medium' : 'low',
    dates,
    financials,
    parties: [],
    readiness,
    milestones,
    issues,
    tasks: [],
    documents: [],
    health,
    provenance: { fullyBacked: degraded.length === 0, fields, degraded },
    lastActivityAt: str(row.last_activity_at),
  }
}
