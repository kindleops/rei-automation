import type { ClosingCase, ClosingBoardColumn, ClosingDeskSummary } from '../../domain/closing-desk/closing-desk.types'
import { CLOSING_BOARD_COLUMNS } from '../../domain/closing-desk/closing-board'
import { computeClosingSummary } from '../../domain/closing-desk/closing-summary'
import { highestSeverityBlocker, isActivelyBlocking } from '../../domain/closing-desk/closing-issues'
import { humanizeEnum } from './closing-desk-present'
import { LIFECYCLE_STAGE_META, type LifecycleStageCode } from '../../domain/lead-state/universal-lead-state-registry'

const MS_PER_DAY = 86_400_000

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? null : `$${Math.round(v).toLocaleString()}`

export function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function daysRemaining(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.round((t - now) / MS_PER_DAY)
}

export function stageLabel(stage: string): string {
  const code = stage as LifecycleStageCode
  const meta = LIFECYCLE_STAGE_META[code]
  if (meta) return `${meta.shortLabel} ${meta.label}`
  return humanizeEnum(stage) ?? stage
}

export function primaryBlocker(c: ClosingCase) {
  return highestSeverityBlocker(c.issues.filter(isActivelyBlocking)) ?? c.issues[0] ?? null
}

export function emdState(c: ClosingCase): string {
  if (c.readiness.emdReceived === true) return 'Received'
  if (c.readiness.emdReceived === false) return 'Outstanding'
  return 'Unknown'
}

/** Canonical lane grouping — every case lands in exactly one lane. */
export function groupCasesByLane(cases: ClosingCase[]): Map<ClosingBoardColumn, ClosingCase[]> {
  const ids = new Set(CLOSING_BOARD_COLUMNS.map((c) => c.id))
  const map = new Map<ClosingBoardColumn, ClosingCase[]>()
  for (const col of CLOSING_BOARD_COLUMNS) map.set(col.id, [])
  for (const c of cases) {
    const lane = ids.has(c.boardColumn) ? c.boardColumn : 'contract_intake'
    map.get(lane)!.push(c)
  }
  return map
}

/**
 * Single render pipeline: board, table, metrics, and intelligence must share this list.
 * Live routes never surface fixture-backed rows unless ?demo=1 / ?fixture=1.
 */
export function resolveRenderableCases(
  filteredCases: ClosingCase[],
  opts: { fixtureQuery: boolean; modelMode: 'live' | 'fixture' | null },
): ClosingCase[] {
  if (opts.fixtureQuery) return filteredCases
  if (opts.modelMode === 'live') return filteredCases
  return []
}

/** Metrics must derive from the same cases the board renders — never orphan fixture summary on live routes. */
export function resolveDisplaySummary(
  renderableCases: ClosingCase[],
  modelSummary: ClosingDeskSummary | null | undefined,
  opts: { fixtureQuery: boolean; modelMode: 'live' | 'fixture' | null },
  now = Date.now(),
): ClosingDeskSummary {
  if (renderableCases.length > 0) return computeClosingSummary(renderableCases, now)
  if (opts.modelMode === 'live' && modelSummary) return modelSummary
  if (opts.fixtureQuery && modelSummary && renderableCases.length === 0) return computeClosingSummary([], now)
  return computeClosingSummary([], now)
}

export type TableSortKey =
  | 'displayName'
  | 'sellerName'
  | 'market'
  | 'universalStage'
  | 'boardColumn'
  | 'health'
  | 'scheduledClosingDate'
  | 'daysRemaining'
  | 'blocker'
  | 'blockerOwner'
  | 'sellerPrice'
  | 'expectedRevenue'
  | 'nextAction'

export function sortCases(cases: ClosingCase[], key: TableSortKey, dir: 'asc' | 'desc'): ClosingCase[] {
  const mul = dir === 'asc' ? 1 : -1
  const sorted = [...cases].sort((a, b) => {
    const blockerA = primaryBlocker(a)
    const blockerB = primaryBlocker(b)
    let av: string | number = ''
    let bv: string | number = ''
    switch (key) {
      case 'displayName': av = a.displayName; bv = b.displayName; break
      case 'sellerName': av = a.sellerName ?? ''; bv = b.sellerName ?? ''; break
      case 'market': av = a.market ?? ''; bv = b.market ?? ''; break
      case 'universalStage': av = a.universalStage; bv = b.universalStage; break
      case 'boardColumn': av = a.boardColumn; bv = b.boardColumn; break
      case 'health': av = a.health.score; bv = b.health.score; break
      case 'scheduledClosingDate':
        av = a.dates.scheduledClosingDate ? new Date(a.dates.scheduledClosingDate).getTime() : 0
        bv = b.dates.scheduledClosingDate ? new Date(b.dates.scheduledClosingDate).getTime() : 0
        break
      case 'daysRemaining':
        av = a.health.daysUntilClosing ?? 9999
        bv = b.health.daysUntilClosing ?? 9999
        break
      case 'blocker': av = blockerA?.title ?? ''; bv = blockerB?.title ?? ''; break
      case 'blockerOwner': av = blockerA?.owner ?? a.health.responsibleParty ?? ''; bv = blockerB?.owner ?? b.health.responsibleParty ?? ''; break
      case 'sellerPrice': av = a.financials.sellerContractPrice ?? 0; bv = b.financials.sellerContractPrice ?? 0; break
      case 'expectedRevenue': av = a.financials.expectedGrossRevenue ?? 0; bv = b.financials.expectedGrossRevenue ?? 0; break
      case 'nextAction': av = a.health.nextRequiredAction ?? ''; bv = b.health.nextRequiredAction ?? ''; break
    }
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul
    return String(av).localeCompare(String(bv)) * mul
  })
  return sorted
}

export function portfolioPulse(cases: ClosingCase[]) {
  const atRisk = cases.filter((c) => c.health.band === 'at_risk' || c.health.band === 'critical').length
  const attention = cases.filter((c) => c.health.nextRequiredAction || c.issues.some(isActivelyBlocking)).length
  return { active: cases.length, atRisk, attention }
}