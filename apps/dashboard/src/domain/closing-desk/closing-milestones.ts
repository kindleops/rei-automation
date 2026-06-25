/**
 * Canonical closing milestone catalog + immutable event helpers.
 *
 * Milestones are append-only facts. The same underlying evidence must never
 * produce two milestone rows — `buildMilestoneIdempotencyKey` guarantees a
 * stable key so re-projection is safe (mirrors the UNIQUE idempotency_key
 * pattern on public.acquisition_opportunity_history).
 */
import type {
  ClosingMilestone,
  ClosingMilestoneType,
  ClosingDataSource,
} from './closing-desk.types'

export interface ClosingMilestoneDef {
  type: ClosingMilestoneType
  label: string
  /** Monotonic order index used for timeline sort + "next milestone" logic. */
  order: number
  /** The universal stage this milestone belongs to. */
  stageHint: 'formal_contract' | 'under_contract' | 'disposition' | 'prepared_to_close' | 'closed'
  /** True when this milestone is a hard gate that downstream milestones depend on. */
  gate: boolean
}

/**
 * Ordered catalog. Order is the canonical happy-path sequence; real cases can
 * skip optional milestones (issues, inspections) without violating ordering.
 */
export const CLOSING_MILESTONE_CATALOG: readonly ClosingMilestoneDef[] = Object.freeze([
  { type: 'accepted_offer_locked', label: 'Accepted Offer Locked', order: 0, stageHint: 'formal_contract', gate: true },
  { type: 'contract_generated', label: 'Contract Generated', order: 1, stageHint: 'formal_contract', gate: false },
  { type: 'contract_sent', label: 'Contract Sent', order: 2, stageHint: 'formal_contract', gate: false },
  { type: 'contract_viewed', label: 'Contract Viewed', order: 3, stageHint: 'formal_contract', gate: false },
  { type: 'contract_signed', label: 'Contract Signed', order: 4, stageHint: 'formal_contract', gate: false },
  { type: 'contract_fully_executed', label: 'Contract Fully Executed', order: 5, stageHint: 'under_contract', gate: true },
  { type: 'closing_case_created', label: 'Closing Case Created', order: 6, stageHint: 'under_contract', gate: true },
  { type: 'title_company_selected', label: 'Title Company Selected', order: 7, stageHint: 'under_contract', gate: false },
  { type: 'title_opened', label: 'Title Opened', order: 8, stageHint: 'under_contract', gate: true },
  { type: 'title_commitment_received', label: 'Title Commitment Received', order: 9, stageHint: 'under_contract', gate: false },
  { type: 'title_issue_detected', label: 'Title Issue Detected', order: 10, stageHint: 'under_contract', gate: false },
  { type: 'payoff_requested', label: 'Payoff Requested', order: 11, stageHint: 'under_contract', gate: false },
  { type: 'payoff_received', label: 'Payoff Received', order: 12, stageHint: 'under_contract', gate: false },
  { type: 'probate_issue_detected', label: 'Probate Issue Detected', order: 13, stageHint: 'under_contract', gate: false },
  { type: 'heirship_issue_detected', label: 'Heirship Issue Detected', order: 14, stageHint: 'under_contract', gate: false },
  { type: 'municipal_issue_detected', label: 'Municipal Issue Detected', order: 15, stageHint: 'under_contract', gate: false },
  { type: 'title_issue_resolved', label: 'Title Issue Resolved', order: 16, stageHint: 'under_contract', gate: false },
  { type: 'buyer_match_started', label: 'Buyer Match Started', order: 17, stageHint: 'disposition', gate: false },
  { type: 'buyer_selected', label: 'Buyer Selected', order: 18, stageHint: 'disposition', gate: true },
  { type: 'assignment_agreement_generated', label: 'Assignment Agreement Generated', order: 19, stageHint: 'disposition', gate: false },
  { type: 'assignment_agreement_signed', label: 'Assignment Agreement Signed', order: 20, stageHint: 'disposition', gate: true },
  { type: 'emd_due', label: 'EMD Due', order: 21, stageHint: 'disposition', gate: false },
  { type: 'emd_received', label: 'EMD Received', order: 22, stageHint: 'disposition', gate: true },
  { type: 'buyer_funds_verified', label: 'Buyer Funds Verified', order: 23, stageHint: 'disposition', gate: false },
  { type: 'inspection_deadline', label: 'Inspection Deadline', order: 24, stageHint: 'prepared_to_close', gate: false },
  { type: 'inspection_complete', label: 'Inspection Complete', order: 25, stageHint: 'prepared_to_close', gate: false },
  { type: 'closing_scheduled', label: 'Closing Scheduled', order: 26, stageHint: 'prepared_to_close', gate: true },
  { type: 'settlement_statement_received', label: 'Settlement Statement Received', order: 27, stageHint: 'prepared_to_close', gate: false },
  { type: 'settlement_statement_approved', label: 'Settlement Statement Approved', order: 28, stageHint: 'prepared_to_close', gate: false },
  { type: 'clear_to_close', label: 'Clear to Close', order: 29, stageHint: 'prepared_to_close', gate: true },
  { type: 'seller_signing_complete', label: 'Seller Signing Complete', order: 30, stageHint: 'prepared_to_close', gate: false },
  { type: 'buyer_signing_complete', label: 'Buyer Signing Complete', order: 31, stageHint: 'prepared_to_close', gate: false },
  { type: 'funded', label: 'Funded', order: 32, stageHint: 'closed', gate: true },
  { type: 'recorded', label: 'Recorded', order: 33, stageHint: 'closed', gate: true },
  { type: 'revenue_expected', label: 'Revenue Expected', order: 34, stageHint: 'closed', gate: false },
  { type: 'revenue_confirmed', label: 'Revenue Confirmed', order: 35, stageHint: 'closed', gate: true },
  { type: 'closing_completed', label: 'Closing Completed', order: 36, stageHint: 'closed', gate: true },
  { type: 'closing_cancelled', label: 'Closing Cancelled', order: 99, stageHint: 'closed', gate: false },
])

const BY_TYPE: ReadonlyMap<ClosingMilestoneType, ClosingMilestoneDef> = new Map(
  CLOSING_MILESTONE_CATALOG.map((def) => [def.type, def]),
)

export function getMilestoneDef(type: ClosingMilestoneType): ClosingMilestoneDef | null {
  return BY_TYPE.get(type) ?? null
}

export function milestoneLabel(type: ClosingMilestoneType): string {
  return BY_TYPE.get(type)?.label ?? type
}

export function milestoneOrder(type: ClosingMilestoneType): number {
  return BY_TYPE.get(type)?.order ?? Number.MAX_SAFE_INTEGER
}

/**
 * Stable idempotency key. Identical (case, type, source entity, occurrence)
 * always collapses to one key so re-running projection is a no-op.
 */
export function buildMilestoneIdempotencyKey(input: {
  closingCaseId: string
  type: ClosingMilestoneType
  sourceEntityId?: string | null
  occurredAt?: string | null
}): string {
  const entity = (input.sourceEntityId ?? 'na').trim() || 'na'
  // Normalize occurrence to the calendar instant so re-sync of the same event
  // (which may carry a re-serialized timestamp) does not fork the key.
  const occurred = input.occurredAt ? new Date(input.occurredAt).toISOString() : 'na'
  return `cm:${input.closingCaseId}:${input.type}:${entity}:${occurred}`
}

/**
 * Build an immutable milestone record. `recordedAt` defaults to now but the
 * idempotency key is independent of it, so the same evidence recorded twice
 * still de-dupes.
 */
export function createMilestone(input: {
  closingCaseId: string
  type: ClosingMilestoneType
  sourceSystem: ClosingDataSource
  sourceEntityId?: string | null
  occurredAt?: string | null
  recordedAt?: string
  actor?: string | null
  priorState?: string | null
  resultingState?: string | null
  snapshot?: Record<string, unknown>
}): ClosingMilestone {
  return Object.freeze({
    eventId: buildMilestoneIdempotencyKey(input),
    closingCaseId: input.closingCaseId,
    type: input.type,
    sourceSystem: input.sourceSystem,
    sourceEntityId: input.sourceEntityId ?? null,
    occurredAt: input.occurredAt ?? null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    actor: input.actor ?? null,
    priorState: input.priorState ?? null,
    resultingState: input.resultingState ?? null,
    snapshot: Object.freeze({ ...(input.snapshot ?? {}) }),
    idempotencyKey: buildMilestoneIdempotencyKey(input),
  }) as ClosingMilestone
}

/** Collapse a list to one milestone per idempotency key, newest evidence wins. */
export function dedupeMilestones(milestones: ClosingMilestone[]): ClosingMilestone[] {
  const byKey = new Map<string, ClosingMilestone>()
  for (const m of milestones) {
    const existing = byKey.get(m.idempotencyKey)
    if (!existing) {
      byKey.set(m.idempotencyKey, m)
      continue
    }
    // Keep the one with the later occurredAt (or later recordedAt as tiebreak).
    const a = existing.occurredAt ?? existing.recordedAt
    const b = m.occurredAt ?? m.recordedAt
    if (new Date(b).getTime() >= new Date(a).getTime()) byKey.set(m.idempotencyKey, m)
  }
  return [...byKey.values()].sort((a, b) => milestoneOrder(a.type) - milestoneOrder(b.type))
}

/** The first catalog milestone that has not yet occurred for this case. */
export function nextExpectedMilestone(achieved: ClosingMilestoneType[]): ClosingMilestoneDef | null {
  const done = new Set(achieved)
  for (const def of CLOSING_MILESTONE_CATALOG) {
    if (def.type === 'closing_cancelled') continue
    if (!done.has(def.type)) return def
  }
  return null
}
