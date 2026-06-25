/**
 * Deterministic mapping from canonical lifecycle state → operator board lane.
 *
 * The board column is NOT a stored field — it is derived from the universal
 * stage + closing/title/disposition/funding status + active issues, so the
 * "Issues / Curative" lane is first-class without mutating pipeline state.
 */
import type {
  ClosingBoardColumn,
  ClosingCase,
  ClosingStatus,
  ClosingUniversalStage,
  ContractStatus,
  DispositionStatus,
  FundingStatus,
  TitleStatus,
} from './closing-desk.types'
import { isActivelyBlocking } from './closing-issues'

export const CLOSING_BOARD_COLUMNS: readonly { id: ClosingBoardColumn; label: string }[] =
  Object.freeze([
    { id: 'contract_intake', label: 'Contract Intake' },
    { id: 'title_open', label: 'Title Open' },
    { id: 'issues_curative', label: 'Issues / Curative' },
    { id: 'disposition', label: 'Disposition' },
    { id: 'buyer_secured', label: 'Buyer Secured' },
    { id: 'closing_scheduled', label: 'Closing Scheduled' },
    { id: 'clear_to_close', label: 'Clear to Close' },
    { id: 'funded', label: 'Funded' },
    { id: 'closed', label: 'Closed' },
    { id: 'cancelled', label: 'Cancelled' },
  ])

const BOARD_LABELS: Record<ClosingBoardColumn, string> = Object.fromEntries(
  CLOSING_BOARD_COLUMNS.map((c) => [c.id, c.label]),
) as Record<ClosingBoardColumn, string>

export function boardColumnLabel(id: ClosingBoardColumn): string {
  return BOARD_LABELS[id] ?? id
}

/** Operator-facing guidance shown when a lane has zero cases. */
export interface ClosingLaneGuidance {
  /** One-line description of what this lane represents. */
  hint: string
  /** What must be true for a case to land here. */
  qualifies: string
}

export const LANE_GUIDANCE: Readonly<Record<ClosingBoardColumn, ClosingLaneGuidance>> = Object.freeze({
  contract_intake: {
    hint: 'Fresh post-contract deals entering the closing lifecycle.',
    qualifies: 'Formal Contract or early Under Contract — contract executed, title not yet opened.',
  },
  title_open: {
    hint: 'Title work in flight — commitment, curative prep, or clearance pending.',
    qualifies: 'Title opened, commitment received, or cleared — no active blocking issues.',
  },
  issues_curative: {
    hint: 'Active title, lien, probate, or municipal blockers requiring resolution.',
    qualifies: 'Any open blocking issue, or title status explicitly flagged issues_open.',
  },
  disposition: {
    hint: 'Buyer matching, assignment, and disposition execution.',
    qualifies: 'Under Contract disposition stage — matching, buyer selected, or assignment out.',
  },
  buyer_secured: {
    hint: 'Buyer locked — EMD, funds verification, or assignment signed.',
    qualifies: 'EMD received, funds verified, or assignment fully executed.',
  },
  closing_scheduled: {
    hint: 'Closing date confirmed or signing scheduled with parties.',
    qualifies: 'Closing status scheduled/confirmed, or a scheduled closing date is set.',
  },
  clear_to_close: {
    hint: 'All readiness gates satisfied — awaiting final signing and funding.',
    qualifies: 'clearToClose flag is true — every curative and readiness gate passed.',
  },
  funded: {
    hint: 'Funds disbursed — recording and revenue confirmation next.',
    qualifies: 'Funding status funded or recorded, not yet closed in the universal stage.',
  },
  closed: {
    hint: 'Terminal success — deal completed and revenue path closed.',
    qualifies: 'Universal stage closed, or closing status completed.',
  },
  cancelled: {
    hint: 'Terminal loss — deal withdrawn, expired, or mutually cancelled.',
    qualifies: 'Closing status cancelled at any point in the lifecycle.',
  },
})

interface BoardInputs {
  universalStage: ClosingUniversalStage
  closingStatus: ClosingStatus
  contractStatus: ContractStatus
  titleStatus: TitleStatus
  dispositionStatus: DispositionStatus
  fundingStatus: FundingStatus
  clearToClose: boolean | null
  hasActiveBlockingIssue: boolean
  scheduledClosingDate: string | null
}

/**
 * Pure derivation. Terminal states win first, then active blockers surface to
 * the curative lane, then we fall through the happy-path ladder.
 */
export function deriveBoardColumn(input: BoardInputs): ClosingBoardColumn {
  // Terminal states are unambiguous.
  if (input.closingStatus === 'cancelled') return 'cancelled'
  if (input.universalStage === 'closed' || input.closingStatus === 'completed') return 'closed'
  if (input.fundingStatus === 'recorded' || input.fundingStatus === 'funded') return 'funded'

  // Clear to close is an explicit gate.
  if (input.clearToClose === true) return 'clear_to_close'

  // Active blockers pull the case into the curative lane regardless of stage,
  // so blocked deals never hide inside a happy-path column.
  if (input.hasActiveBlockingIssue) return 'issues_curative'

  if (input.closingStatus === 'scheduled' || input.closingStatus === 'confirmed' || input.scheduledClosingDate) {
    return 'closing_scheduled'
  }

  // Disposition ladder.
  if (
    input.dispositionStatus === 'emd_received' ||
    input.dispositionStatus === 'funds_verified' ||
    input.dispositionStatus === 'assignment_signed'
  ) {
    return 'buyer_secured'
  }
  if (
    input.universalStage === 'disposition' ||
    input.dispositionStatus === 'matching' ||
    input.dispositionStatus === 'buyer_selected' ||
    input.dispositionStatus === 'assignment_out'
  ) {
    return 'disposition'
  }

  // Title ladder.
  if (
    input.titleStatus === 'opened' ||
    input.titleStatus === 'commitment_received' ||
    input.titleStatus === 'cleared'
  ) {
    return 'title_open'
  }
  if (input.titleStatus === 'issues_open') return 'issues_curative'

  // Default earliest lane: contract intake (Stage 6 / early Stage 7).
  return 'contract_intake'
}

/** Convenience derivation directly from an assembled case. */
export function boardColumnForCase(c: ClosingCase): ClosingBoardColumn {
  return deriveBoardColumn({
    universalStage: c.universalStage,
    closingStatus: c.closingStatus,
    contractStatus: c.contractStatus,
    titleStatus: c.titleStatus,
    dispositionStatus: c.dispositionStatus,
    fundingStatus: c.fundingStatus,
    clearToClose: c.readiness.clearToClose,
    hasActiveBlockingIssue: c.issues.some(isActivelyBlocking),
    scheduledClosingDate: c.dates.scheduledClosingDate,
  })
}
