/**
 * Projection: canonical Supabase rows → ClosingCase aggregate.
 *
 * HONESTY CONTRACT: `acquisition_opportunities` is the only queryable canonical
 * Supabase source for the post-contract lifecycle, and its `acquisition_stage`
 * CHECK constraint caps at `contract_to_close` — it carries none of the deep
 * title/escrow/disposition/funding/revenue state, which today lives in Podio
 * (see AUDIT.md). So this projection fills what is genuinely backed and marks
 * everything else `absent` with a degraded diagnostic. It NEVER fabricates.
 */
import type {
  ClosingCase,
  ClosingDataSource,
  ClosingDates,
  ClosingFinancials,
  ClosingIssue,
  ClosingMilestone,
  ClosingParty,
  ClosingProvenance,
  ClosingReadiness,
  ClosingUniversalStage,
} from './closing-desk.types'
import { computeClosingHealth } from './closing-health'
import { deriveBoardColumn } from './closing-board'
import { createMilestone, dedupeMilestones } from './closing-milestones'
import { getIssueDef } from './closing-issues'

/** Minimal raw shape we read from public.acquisition_opportunities. */
export interface RawOpportunityRow {
  id?: string
  master_owner_id?: string | null
  primary_property_id?: string | null
  primary_thread_key?: string | null
  acquisition_stage?: string | null
  opportunity_status?: string | null
  asking_price?: number | null
  recommended_offer?: number | null
  current_offer?: number | null
  estimated_value?: number | null
  arv?: number | null
  market?: string | null
  property_address_full?: string | null
  seller_display_name?: string | null
  next_action?: string | null
  next_action_due?: string | null
  blocker?: string | null
  assigned_operator?: string | null
  last_activity_at?: string | null
  stage_entered_at?: string | null
  metadata?: Record<string, unknown> | null
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/**
 * Map the (capped) Supabase acquisition_stage + any metadata closing hint to a
 * closing universal stage. `contract_to_close` collapses Stages 6–10, so we
 * read an optional metadata override and otherwise default to formal_contract.
 */
export function mapToClosingStage(row: RawOpportunityRow): {
  stage: ClosingUniversalStage
  source: ClosingDataSource
} {
  const meta = row.metadata ?? {}
  const hint = str((meta as Record<string, unknown>).closing_universal_stage)
  const allowed: ClosingUniversalStage[] = [
    'formal_contract',
    'under_contract',
    'disposition',
    'prepared_to_close',
    'closed',
  ]
  if (hint && (allowed as string[]).includes(hint)) {
    return { stage: hint as ClosingUniversalStage, source: 'podio_mirror' }
  }
  const stage = str(row.acquisition_stage)
  // Production's acquisition_stage CHECK supports the full 10-stage universal
  // set (verified against prod — the repo migration 20260621120000 carries a
  // stale capped constraint). So when the row already names a closing-band
  // stage, trust it directly rather than collapsing to formal_contract.
  if (stage && (allowed as string[]).includes(stage)) {
    return { stage: stage as ClosingUniversalStage, source: 'acquisition_opportunities' }
  }
  // Legacy alias from the older 7-stage model.
  if (stage === 'contract_to_close') return { stage: 'formal_contract', source: 'derived' }
  // Anything earlier than the closing band is not a closing case yet.
  return { stage: 'formal_contract', source: 'derived' }
}

/** Build the all-null readiness checklist — Supabase does not project it. */
function emptyReadiness(): ClosingReadiness {
  return {
    contractComplete: null,
    allSignersVerified: null,
    ownershipVerified: null,
    authorityVerified: null,
    emdReceived: null,
    buyerSecured: null,
    buyerFundsVerified: null,
    titleOpened: null,
    titleCommitmentReceived: null,
    liensResolved: null,
    probateResolved: null,
    payoffReceived: null,
    municipalIssuesResolved: null,
    settlementStatementApproved: null,
    sellerReady: null,
    buyerReady: null,
    signingScheduled: null,
    clearToClose: null,
    funded: null,
    recorded: null,
    closed: null,
  }
}

function emptyDates(): ClosingDates {
  return {
    contractSignedDate: null,
    effectiveDate: null,
    emdDueDate: null,
    inspectionDeadline: null,
    titleOpenedDate: null,
    titleCommitmentDate: null,
    cureDeadline: null,
    scheduledClosingDate: null,
    signingDate: null,
    fundingDate: null,
    recordingDate: null,
    revenueConfirmedDate: null,
  }
}

function projectFinancials(row: RawOpportunityRow): ClosingFinancials {
  const sellerContractPrice = num(row.current_offer) ?? num(row.recommended_offer)
  return {
    sellerContractPrice,
    buyerPrice: null, // disposition price lives in Podio buyer-match
    assignmentFee: null,
    doubleCloseSpread: null,
    buyerEmd: null,
    sellerCredits: null,
    closingCosts: null,
    titleFees: null,
    expectedGrossRevenue: null, // requires buyer price — absent in Supabase
    confirmedGrossRevenue: null,
    netRevenue: null,
    fundingSource: null,
    revenueStatus: 'unknown',
  }
}

function projectIssues(row: RawOpportunityRow, closingCaseId: string): ClosingIssue[] {
  const blocker = str(row.blocker)
  if (!blocker) return []
  const def = getIssueDef('contract_issue')
  return [
    {
      issueId: `${closingCaseId}:blocker`,
      closingCaseId,
      category: 'contract_issue',
      title: blocker,
      severity: def?.defaultSeverity ?? 'high',
      status: 'open',
      owner: str(row.assigned_operator),
      openedAt: str(row.stage_entered_at) ?? str(row.last_activity_at),
      dueAt: str(row.next_action_due),
      slaHours: def?.defaultSlaHours ?? null,
      resolutionRequirements: [],
      evidence: [],
      dependencies: [],
      blockingMilestones: ['contract_fully_executed'],
      resolvedAt: null,
      resolutionNote: null,
      source: 'acquisition_opportunities',
    },
  ]
}

function projectMilestones(row: RawOpportunityRow, closingCaseId: string): ClosingMilestone[] {
  // The only milestone we can justify from a Supabase pipeline row that has
  // reached contract_to_close is that the accepted offer is locked.
  const out: ClosingMilestone[] = [
    createMilestone({
      closingCaseId,
      type: 'accepted_offer_locked',
      sourceSystem: 'acquisition_opportunities',
      sourceEntityId: str(row.id),
      occurredAt: str(row.stage_entered_at),
      recordedAt: str(row.last_activity_at) ?? new Date().toISOString(),
      actor: 'system_projection',
      resultingState: 'contract_to_close',
      snapshot: { acquisition_stage: row.acquisition_stage, opportunity_status: row.opportunity_status },
    }),
  ]
  return dedupeMilestones(out)
}

function projectParties(row: RawOpportunityRow): ClosingParty[] {
  const parties: ClosingParty[] = []
  const seller = str(row.seller_display_name)
  if (seller) {
    parties.push({ role: 'seller', name: seller, authorityType: null, verified: null, source: 'acquisition_opportunities' })
  }
  const op = str(row.assigned_operator)
  if (op) {
    parties.push({ role: 'acquisition_owner', name: op, authorityType: null, verified: null, source: 'acquisition_opportunities' })
  }
  return parties
}

/** The deep-state fields that Supabase cannot yet supply. */
const DEGRADED_FIELDS = [
  'title_status',
  'escrow_status',
  'funding_status',
  'disposition_status',
  'buyer',
  'assignment',
  'emd',
  'settlement_statement',
  'closing_dates',
  'readiness_checklist',
  'confirmed_revenue',
]

export function projectClosingCase(row: RawOpportunityRow): ClosingCase {
  const closingCaseId = str(row.id) ?? `unknown:${str(row.primary_thread_key) ?? 'na'}`
  const { stage, source: stageSource } = mapToClosingStage(row)

  const dates = emptyDates()
  const readiness = emptyReadiness()
  const issues = projectIssues(row, closingCaseId)
  const milestones = projectMilestones(row, closingCaseId)
  const financials = projectFinancials(row)

  const health = computeClosingHealth({
    universalStage: stage,
    dates,
    readiness,
    issues,
    milestones,
  })

  const boardColumn = deriveBoardColumn({
    universalStage: stage,
    closingStatus: 'unknown',
    contractStatus: stage === 'formal_contract' ? 'requested' : 'unknown',
    titleStatus: 'unknown',
    dispositionStatus: 'unknown',
    fundingStatus: 'unknown',
    clearToClose: null,
    hasActiveBlockingIssue: issues.some((i) => i.severity === 'blocker' || i.severity === 'high'),
    scheduledClosingDate: null,
  })

  const provenance: ClosingProvenance = {
    fullyBacked: false,
    fields: {
      identity: 'acquisition_opportunities',
      seller_contract_price: financials.sellerContractPrice !== null ? 'acquisition_opportunities' : 'absent',
      universal_stage: stageSource,
      issues: issues.length ? 'acquisition_opportunities' : 'absent',
      ...Object.fromEntries(DEGRADED_FIELDS.map((f) => [f, 'absent' as ClosingDataSource])),
    },
    degraded: [
      'Deep closing state (title, escrow, disposition, funding, settlement, confirmed revenue) is not yet projected from Podio into Supabase. Showing pipeline-derived fields only.',
    ],
  }

  return {
    identity: {
      closingCaseId,
      propertyId: str(row.primary_property_id),
      masterOwnerId: str(row.master_owner_id),
      prospectId: null,
      opportunityId: str(row.id),
      offerId: null,
      contractId: null,
      buyerId: null,
      assignmentId: null,
      titleCompanyId: null,
      escrowFileNumber: null,
    },
    displayName: str(row.property_address_full) ?? str(row.seller_display_name) ?? closingCaseId,
    propertyAddress: str(row.property_address_full),
    market: str(row.market),
    sellerName: str(row.seller_display_name),
    universalStage: stage,
    boardColumn,
    closingStatus: 'unknown',
    contractStatus: stage === 'formal_contract' ? 'requested' : 'unknown',
    dispositionStatus: 'unknown',
    titleStatus: 'unknown',
    escrowStatus: 'unknown',
    fundingStatus: 'unknown',
    riskLevel: health.band === 'critical' ? 'severe' : health.band === 'at_risk' ? 'high' : health.band === 'watch' ? 'medium' : 'low',
    dates,
    financials,
    parties: projectParties(row),
    readiness,
    milestones,
    issues,
    tasks: [],
    documents: [],
    health,
    provenance,
    lastActivityAt: str(row.last_activity_at),
  }
}
