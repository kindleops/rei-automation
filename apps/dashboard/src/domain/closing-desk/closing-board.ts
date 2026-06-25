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
