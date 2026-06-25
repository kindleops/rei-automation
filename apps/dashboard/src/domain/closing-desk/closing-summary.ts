/**
 * Header command-layer summary, computed from assembled cases.
 * Every metric declares its backend source — nothing is hardcoded.
 */
import type {
  ClosingCase,
  ClosingDataSource,
  ClosingDeskSummary,
} from './closing-desk.types'
import { isActivelyBlocking } from './closing-issues'

const MS_PER_DAY = 86_400_000

function withinDays(iso: string | null, days: number, now: number): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  const diff = (t - now) / MS_PER_DAY
  return diff >= 0 && diff <= days
}

export function computeClosingSummary(
  cases: ClosingCase[],
  now: number = Date.now(),
): ClosingDeskSummary {
  let underContract = 0
  let closingsThisWeek = 0
  let clearToClose = 0
  let titleBlocked = 0
  let sellerActionRequired = 0
  let buyerActionRequired = 0
  let emdOverdue = 0
  let expectedRevenue = 0
  let confirmedRevenueThisMonth = 0

  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  for (const c of cases) {
    if (c.universalStage === 'under_contract' || c.universalStage === 'formal_contract') underContract += 1
    if (withinDays(c.dates.scheduledClosingDate, 7, now)) closingsThisWeek += 1
    if (c.readiness.clearToClose === true) clearToClose += 1
    if (c.titleStatus === 'issues_open') titleBlocked += 1
    if (c.readiness.sellerReady === false) sellerActionRequired += 1
    if (c.readiness.buyerReady === false || c.readiness.buyerSecured === false) buyerActionRequired += 1
    if (c.dates.emdDueDate && c.readiness.emdReceived === false) {
      if (new Date(c.dates.emdDueDate).getTime() < now) emdOverdue += 1
    }
    if (c.financials.expectedGrossRevenue !== null) expectedRevenue += c.financials.expectedGrossRevenue
    if (
      c.financials.confirmedGrossRevenue !== null &&
      c.dates.revenueConfirmedDate &&
      new Date(c.dates.revenueConfirmedDate).getTime() >= monthStart.getTime()
    ) {
      confirmedRevenueThisMonth += c.financials.confirmedGrossRevenue
    }
    // Issues that are active blockers also raise the title-blocked signal when
    // the category is title-group, even if titleStatus is not yet projected.
    if (c.titleStatus !== 'issues_open' && c.issues.some((i) => isActivelyBlocking(i) && /title|lien|payoff|probate|heirship|municipal/.test(i.category))) {
      titleBlocked += 1
    }
  }

  const metricSources: Record<string, ClosingDataSource> = {
    underContract: 'derived',
    closingsThisWeek: 'derived',
    clearToClose: 'derived',
    titleBlocked: 'derived',
    sellerActionRequired: 'derived',
    buyerActionRequired: 'derived',
    emdOverdue: 'derived',
    expectedRevenue: 'derived',
    confirmedRevenueThisMonth: 'derived',
  }

  return {
    underContract,
    closingsThisWeek,
    clearToClose,
    titleBlocked,
    sellerActionRequired,
    buyerActionRequired,
    emdOverdue,
    expectedRevenue,
    confirmedRevenueThisMonth,
    metricSources,
  }
}
