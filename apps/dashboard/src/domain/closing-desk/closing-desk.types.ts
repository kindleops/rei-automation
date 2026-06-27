/**
 * Closing Desk canonical domain contract.
 *
 * READ-ONLY / SHADOW-FIRST. These types describe how the post-contract
 * lifecycle (Stages 6–10 of the universal pipeline) is projected for the
 * Closing Desk command center. They do NOT authorize any write, send, or
 * external action — every state-changing intent is represented as a
 * `ProposedClosingAction` that requires explicit operator approval upstream.
 *
 * Canonical lifecycle source: apps/api/src/lib/domain/opportunity/universal-pipeline-registry.js
 * Canonical deep state source: Podio apps (closings / contracts / title-routing /
 * deal-revenue / buyer-match) mirrored into Supabase. See AUDIT.md.
 */

// ── Lifecycle codes (mirror universal-pipeline-registry UNIVERSAL_STAGE_CODES) ──

/** The five universal stages the Closing Desk owns or observes. */
export type ClosingUniversalStage =
  | 'formal_contract' // Stage 6
  | 'under_contract' // Stage 7
  | 'disposition' // Stage 8
  | 'prepared_to_close' // Stage 9
  | 'closed' // Stage 10

/** Operator board lanes. Independent of the universal stage so curative work is first-class. */
export type ClosingBoardColumn =
  | 'contract_intake'
  | 'title_open'
  | 'issues_curative'
  | 'disposition'
  | 'buyer_secured'
  | 'closing_scheduled'
  | 'clear_to_close'
  | 'funded'
  | 'closed'
  | 'cancelled'

export type ClosingStatus =
  | 'not_scheduled'
  | 'scheduled'
  | 'confirmed'
  | 'rescheduled'
  | 'completed'
  | 'cancelled'
  | 'unknown'

export type ContractStatus =
  | 'requested'
  | 'generated'
  | 'sent'
  | 'viewed'
  | 'partially_signed'
  | 'fully_executed'
  | 'closed'
  | 'cancelled'
  | 'unknown'

export type DispositionStatus =
  | 'not_started'
  | 'matching'
  | 'buyer_selected'
  | 'assignment_out'
  | 'assignment_signed'
  | 'emd_received'
  | 'funds_verified'
  | 'not_applicable'
  | 'unknown'

export type TitleStatus =
  | 'not_opened'
  | 'opened'
  | 'commitment_received'
  | 'issues_open'
  | 'cleared'
  | 'unknown'

export type EscrowStatus = 'not_opened' | 'opened' | 'funded' | 'disbursed' | 'unknown'

export type FundingStatus = 'not_funded' | 'pending' | 'funded' | 'recorded' | 'unknown'

export type RevenueStatus =
  | 'projected'
  | 'expected_soon'
  | 'confirmed'
  | 'wire_received'
  | 'reconciled'
  | 'unknown'

export type ClosingHealthBand = 'on_track' | 'watch' | 'at_risk' | 'critical' | 'unknown'

export type ClosingRiskLevel = 'low' | 'medium' | 'high' | 'severe' | 'unknown'

export type IssueSeverity = 'blocker' | 'high' | 'medium' | 'low'

export type IssueStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'waived'

// ── Provenance / degraded-state diagnostics ────────────────────────────────

/** Where a value actually came from. Never silently fabricate — always declare. */
export type ClosingDataSource =
  | 'acquisition_opportunities' // Supabase canonical pipeline row (real)
  | 'closing_cases' // Supabase projection (additive migration, may be absent)
  | 'podio_mirror' // synced from Podio
  | 'derived' // deterministically computed from the above
  | 'fixture' // demo/storybook only — UNMISTAKABLY labeled in UI
  | 'absent' // value is not yet projected into any queryable source

export interface ClosingProvenance {
  /** True only when every field on this case came from real persisted data. */
  fullyBacked: boolean
  /** Field-level source map for the values that matter for trust. */
  fields: Partial<Record<string, ClosingDataSource>>
  /** Human-readable diagnostics for fields that could not be resolved. */
  degraded: string[]
}

// ── Milestones (immutable event records) ────────────────────────────────────

export type ClosingMilestoneType =
  | 'accepted_offer_locked'
  | 'contract_generated'
  | 'contract_sent'
  | 'contract_viewed'
  | 'contract_signed'
  | 'contract_fully_executed'
  | 'closing_case_created'
  | 'title_company_selected'
  | 'title_opened'
  | 'title_commitment_received'
  | 'title_issue_detected'
  | 'payoff_requested'
  | 'payoff_received'
  | 'probate_issue_detected'
  | 'heirship_issue_detected'
  | 'municipal_issue_detected'
  | 'title_issue_resolved'
  | 'buyer_match_started'
  | 'buyer_selected'
  | 'assignment_agreement_generated'
  | 'assignment_agreement_signed'
  | 'emd_due'
  | 'emd_received'
  | 'buyer_funds_verified'
  | 'inspection_deadline'
  | 'inspection_complete'
  | 'closing_scheduled'
  | 'settlement_statement_received'
  | 'settlement_statement_approved'
  | 'clear_to_close'
  | 'seller_signing_complete'
  | 'buyer_signing_complete'
  | 'funded'
  | 'recorded'
  | 'revenue_expected'
  | 'revenue_confirmed'
  | 'closing_completed'
  | 'closing_cancelled'

export interface ClosingMilestone {
  eventId: string
  closingCaseId: string
  type: ClosingMilestoneType
  /** Originating system for the underlying evidence. */
  sourceSystem: ClosingDataSource
  sourceEntityId: string | null
  occurredAt: string | null
  recordedAt: string
  actor: string | null
  priorState: string | null
  resultingState: string | null
  /** Immutable snapshot of the evidence that produced this milestone. */
  snapshot: Record<string, unknown>
  /** Stable de-dup key — identical evidence must never create two milestones. */
  idempotencyKey: string
}

// ── Issues (curative / blocking work) ────────────────────────────────────────

export type ClosingIssueCategory =
  | 'title_defect'
  | 'lien'
  | 'mortgage_payoff'
  | 'delinquent_taxes'
  | 'municipal_lien'
  | 'code_violation'
  | 'probate'
  | 'heirship'
  | 'divorce'
  | 'bankruptcy'
  | 'trust_authority'
  | 'llc_authority'
  | 'missing_signer'
  | 'deceased_owner'
  | 'open_permit'
  | 'deed_correction'
  | 'buyer_funding'
  | 'buyer_emd'
  | 'seller_documents'
  | 'buyer_documents'
  | 'closing_date_risk'
  | 'contract_issue'
  | 'assignment_issue'
  | 'occupancy_possession'
  | 'other'

export interface ClosingIssue {
  issueId: string
  closingCaseId: string
  category: ClosingIssueCategory
  title: string
  severity: IssueSeverity
  status: IssueStatus
  owner: string | null
  openedAt: string | null
  dueAt: string | null
  slaHours: number | null
  resolutionRequirements: string[]
  evidence: ClosingDocumentRef[]
  dependencies: string[]
  /** Milestone types this issue blocks until resolved. */
  blockingMilestones: ClosingMilestoneType[]
  resolvedAt: string | null
  resolutionNote: string | null
  source: ClosingDataSource
}

// ── Tasks / documents / parties ──────────────────────────────────────────────

export interface ClosingTask {
  taskId: string
  closingCaseId: string
  label: string
  owner: string | null
  dueAt: string | null
  slaHours: number | null
  status: 'open' | 'done' | 'blocked' | 'waived'
  blockedByIssueId: string | null
  source: ClosingDataSource
}

export interface ClosingDocumentRef {
  documentId: string
  label: string
  kind: string
  receivedAt: string | null
  approved: boolean | null
  source: ClosingDataSource
}

export type ClosingPartyRole =
  | 'seller'
  | 'signer'
  | 'acquisition_owner'
  | 'transaction_coordinator'
  | 'disposition_owner'
  | 'selected_buyer'
  | 'buyer_representative'
  | 'title_contact'
  | 'attorney'
  | 'closing_agent'
  | 'blocker_owner'

export interface ClosingParty {
  role: ClosingPartyRole
  name: string | null
  authorityType: string | null
  verified: boolean | null
  source: ClosingDataSource
}

// ── Readiness checklist (booleans + null for "unknown / not projected") ───────

export interface ClosingReadiness {
  contractComplete: boolean | null
  allSignersVerified: boolean | null
  ownershipVerified: boolean | null
  authorityVerified: boolean | null
  emdReceived: boolean | null
  buyerSecured: boolean | null
  buyerFundsVerified: boolean | null
  titleOpened: boolean | null
  titleCommitmentReceived: boolean | null
  liensResolved: boolean | null
  probateResolved: boolean | null
  payoffReceived: boolean | null
  municipalIssuesResolved: boolean | null
  settlementStatementApproved: boolean | null
  sellerReady: boolean | null
  buyerReady: boolean | null
  signingScheduled: boolean | null
  clearToClose: boolean | null
  funded: boolean | null
  recorded: boolean | null
  closed: boolean | null
}

// ── Financials ────────────────────────────────────────────────────────────────

export interface ClosingFinancials {
  sellerContractPrice: number | null
  buyerPrice: number | null
  assignmentFee: number | null
  doubleCloseSpread: number | null
  buyerEmd: number | null
  sellerCredits: number | null
  closingCosts: number | null
  titleFees: number | null
  expectedGrossRevenue: number | null
  confirmedGrossRevenue: number | null
  netRevenue: number | null
  fundingSource: string | null
  revenueStatus: RevenueStatus
}

// ── Key dates ──────────────────────────────────────────────────────────────────

export interface ClosingDates {
  contractSignedDate: string | null
  effectiveDate: string | null
  emdDueDate: string | null
  inspectionDeadline: string | null
  titleOpenedDate: string | null
  titleCommitmentDate: string | null
  cureDeadline: string | null
  scheduledClosingDate: string | null
  signingDate: string | null
  fundingDate: string | null
  recordingDate: string | null
  revenueConfirmedDate: string | null
}

// ── Health (deterministic, fact-traceable — never a fake AI confidence) ───────

export interface ClosingHealthFactor {
  /** Stable rule id, e.g. "overdue_milestone". */
  rule: string
  label: string
  /** Signed point contribution applied to the base score. */
  delta: number
  /** The concrete fact that triggered this rule. */
  evidence: string
}

export interface ClosingHealth {
  score: number // 0–100
  band: ClosingHealthBand
  onTimeCloseProbability: number | null // 0–1, null when not enough data
  daysUntilClosing: number | null
  overdueMilestoneCount: number
  blockingIssueCount: number
  highestSeverityBlocker: ClosingIssue | null
  nextRequiredAction: string | null
  responsibleParty: string | null
  slaDeadline: string | null
  dataCompletenessScore: number // 0–100
  /** Every score input, for the "explain this score" UI. No black boxes. */
  factors: ClosingHealthFactor[]
}

// ── Identity ────────────────────────────────────────────────────────────────────

export interface ClosingIdentity {
  closingCaseId: string
  /** Canonical seller thread for universal lead-state patches. */
  primaryThreadKey: string | null
  propertyId: string | null
  masterOwnerId: string | null
  prospectId: string | null
  opportunityId: string | null
  offerId: string | null
  contractId: string | null
  buyerId: string | null
  assignmentId: string | null
  titleCompanyId: string | null
  escrowFileNumber: string | null
}

// ── The aggregate ────────────────────────────────────────────────────────────────

export interface ClosingCase {
  identity: ClosingIdentity
  displayName: string
  propertyAddress: string | null
  market: string | null
  sellerName: string | null

  universalStage: ClosingUniversalStage
  boardColumn: ClosingBoardColumn
  closingStatus: ClosingStatus
  contractStatus: ContractStatus
  dispositionStatus: DispositionStatus
  titleStatus: TitleStatus
  escrowStatus: EscrowStatus
  fundingStatus: FundingStatus
  riskLevel: ClosingRiskLevel

  dates: ClosingDates
  financials: ClosingFinancials
  parties: ClosingParty[]
  readiness: ClosingReadiness
  milestones: ClosingMilestone[]
  issues: ClosingIssue[]
  tasks: ClosingTask[]
  documents: ClosingDocumentRef[]
  health: ClosingHealth

  provenance: ClosingProvenance
  lastActivityAt: string | null
}

// ── Header summary metrics ────────────────────────────────────────────────────

export interface ClosingDeskSummary {
  underContract: number
  closingsThisWeek: number
  clearToClose: number
  titleBlocked: number
  sellerActionRequired: number
  buyerActionRequired: number
  emdOverdue: number
  expectedRevenue: number
  confirmedRevenueThisMonth: number
  /** Named backend source for each metric so nothing is "hardcoded". */
  metricSources: Record<string, ClosingDataSource>
}

// ── Proposed actions (the ONLY representation of any future write/send) ────────

export type ProposedClosingActionKind =
  | 'send_contract'
  | 'request_payoff'
  | 'open_title'
  | 'notify_buyer'
  | 'notify_seller'
  | 'schedule_closing'
  | 'mark_clear_to_close'
  | 'confirm_revenue'
  | 'advance_stage'

export interface ProposedClosingAction {
  kind: ProposedClosingActionKind
  closingCaseId: string
  label: string
  rationale: string
  /** Facts that justify the proposal, surfaced in the approval UI. */
  citedFacts: string[]
  requiresApproval: true
  /** This foundation never executes — always false. */
  executed: false
}

// ── Top-level read model returned to the UI ─────────────────────────────────────

export type ClosingDeskMode = 'live' | 'fixture'

export interface ClosingDeskModel {
  mode: ClosingDeskMode
  summary: ClosingDeskSummary
  cases: ClosingCase[]
  total: number
  provenance: ClosingProvenance
  /** Populated when live data is unavailable or incomplete. */
  diagnostics: string[]
  generatedAt: string
}
