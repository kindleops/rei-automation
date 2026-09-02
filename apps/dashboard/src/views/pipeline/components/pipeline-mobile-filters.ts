/**
 * Filter and sort semantics for the mobile Pipeline board.
 *
 * Pure and separately testable, because the board's hardest requirement is not
 * visual: every number on screen — header total, scope count, stage count,
 * quick-filter count — must describe the SAME universe as the rendered list.
 * Keeping one predicate set here is what makes that checkable.
 *
 * THE COUNT CONTRACT
 * ------------------
 * There is one funnel, applied in this order:
 *
 *   1. scope        (Active / Attention / All / Dead / Suppressed / Closed)
 *   2. search query
 *   3. filters      (stage, status, temperature, needs response, follow-up due)
 *   4. stage        (which stage of the spine you are looking at)
 *
 * Every count is taken AFTER step 3 and BEFORE step 4, except the stage counts
 * on the spine (which are the step-4 partition) and the rendered list (step 4).
 * So with "Need a reply" + S2 selected:
 *
 *   header total       = leads in scope matching filters      (all stages)
 *   quick-filter count = same universe (it IS one of the filters)
 *   stage count on S2  = that universe restricted to S2
 *   rendered rows      = the S2 count, exactly
 *
 * The quick-filter chips are shortcuts onto `needsResponse` / `followUpDue`
 * rather than a parallel mechanism, so a chip and the Filters sheet can never
 * disagree about what is selected.
 */
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import { isFollowUpDue, resolveTemperature } from '../../../domain/pipeline/pipeline-display-helpers'

export type PipelineMobileSortId = 'recent' | 'stale' | 'follow_up'

export interface PipelineMobileFilters {
  /** Canonical lifecycle stage codes. Empty = every stage. */
  stages: string[]
  /** Canonical operational status codes. Empty = every status. */
  statuses: string[]
  /** hot | warm | cold. Empty = every temperature. */
  temperatures: string[]
  needsResponse: boolean
  followUpDue: boolean
}

export const EMPTY_FILTERS: PipelineMobileFilters = {
  stages: [], statuses: [], temperatures: [], needsResponse: false, followUpDue: false,
}

export const SORT_OPTIONS: Array<{ id: PipelineMobileSortId; label: string; hint: string }> = [
  { id: 'recent', label: 'Newest activity', hint: 'Most recently touched first' },
  { id: 'stale', label: 'Oldest first', hint: 'Stalest leads first' },
  { id: 'follow_up', label: 'Follow-up due', hint: 'Soonest due first' },
]

const rec = (opp: PipelineOpportunity) => opp as unknown as Record<string, unknown>

const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()

const time = (v: unknown): number => {
  const t = new Date(String(v ?? '')).getTime()
  return Number.isFinite(t) ? t : NaN
}

/** Canonical stage, falling back to the opportunity's own column. */
export function stageOf(opp: PipelineOpportunity): string {
  return lower(rec(opp).canonical_lifecycle_stage) || lower(opp.acquisition_stage)
}

/** Canonical operational status, falling back to the opportunity's own column. */
export function statusOf(opp: PipelineOpportunity): string {
  return lower(rec(opp).canonical_operational_status) || lower(opp.opportunity_status)
}

export function temperatureOf(opp: PipelineOpportunity): string {
  return lower(rec(opp).canonical_lead_temperature) || lower(resolveTemperature(opp))
}

/**
 * "The seller is waiting on us."
 *
 * The canonical `operational_status` is the only trustworthy signal here.
 * Measured on the live 258: `conversation_state` is `seller_replied` on 254 of
 * them, so treating that as "needs a reply" selected the entire book and made
 * the chip meaningless. `canonical_operational_status = 'new_reply'` is 63 —
 * an actual queue.
 *
 * `conversation_state` is consulted only for the handful of rows with no
 * canonical status at all, and `seller_replied` is excluded there for the same
 * reason. Deliberately NOT `resolveReplyAttentionState`, which also labels
 * `awaiting_seller` — the opposite situation.
 */
export function needsResponse(opp: PipelineOpportunity): boolean {
  const status = statusOf(opp)
  if (status) return status === 'new_reply'
  const cs = lower(rec(opp).conversation_state)
  return cs === 'needs_reply' || cs === 'new_inbound' || cs === 'unread'
}

export function followUpDue(opp: PipelineOpportunity): boolean {
  return isFollowUpDue(opp)
}

export function isFiltersActive(f: PipelineMobileFilters): boolean {
  return activeFilterCount(f) > 0
}

/** How many distinct filter dimensions are engaged — shown on the trigger. */
export function activeFilterCount(f: PipelineMobileFilters): number {
  return (f.stages.length ? 1 : 0)
    + (f.statuses.length ? 1 : 0)
    + (f.temperatures.length ? 1 : 0)
    + (f.needsResponse ? 1 : 0)
    + (f.followUpDue ? 1 : 0)
}

/** Step 3 of the funnel. Scope and query are applied by the caller. */
export function applyFilters(
  opps: PipelineOpportunity[],
  f: PipelineMobileFilters,
): PipelineOpportunity[] {
  return opps.filter((opp) => {
    if (f.stages.length && !f.stages.includes(stageOf(opp))) return false
    if (f.statuses.length && !f.statuses.includes(statusOf(opp))) return false
    if (f.temperatures.length && !f.temperatures.includes(temperatureOf(opp))) return false
    if (f.needsResponse && !needsResponse(opp)) return false
    if (f.followUpDue && !followUpDue(opp)) return false
    return true
  })
}

const lastActivity = (opp: PipelineOpportunity): number =>
  time(opp.last_contact_at) || time(rec(opp).stage_entered_at) || time(rec(opp).updated_at)

const followUpAt = (opp: PipelineOpportunity): number =>
  time(rec(opp).next_follow_up_at) || time(rec(opp).follow_up_at) || time(rec(opp).next_action_at)

/**
 * Sorts are stable and put missing values last, so a lead with no follow-up
 * date never displaces one that has a real due date.
 */
export function applySort(
  opps: PipelineOpportunity[],
  sort: PipelineMobileSortId,
): PipelineOpportunity[] {
  const keyed = opps.map((opp, i) => ({ opp, i }))

  const cmp = (a: { opp: PipelineOpportunity; i: number }, b: { opp: PipelineOpportunity; i: number }) => {
    const pick = sort === 'follow_up' ? followUpAt : lastActivity
    const av = pick(a.opp)
    const bv = pick(b.opp)
    const aMissing = !Number.isFinite(av)
    const bMissing = !Number.isFinite(bv)
    if (aMissing && bMissing) return a.i - b.i
    if (aMissing) return 1
    if (bMissing) return -1
    if (av !== bv) return sort === 'recent' ? bv - av : av - bv
    return a.i - b.i
  }

  return keyed.sort(cmp).map((k) => k.opp)
}
