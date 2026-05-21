import type { CommandCenterStore } from '../../domain/types'
import { formatCurrency, formatRelativeTime } from '../../shared/formatters'

export interface TitleItem {
  id: string
  leadId: string
  marketId: string
  address: string
  ownerName: string
  status: 'clear' | 'review' | 'issue' | 'pending' | 'closed'
  closingPhase: string
  closingPhaseLabel: string
  titleCompany: string
  scheduledCloseIso: string | null
  scheduledCloseLabel: string | null
  daysInPhase: number
  earnestDeposit: number
  earnestLabel: string
  purchasePrice: number
  priceLabel: string
  issues: string[]
  lastUpdatedLabel: string
  lastUpdatedIso: string
  marketLabel: string
}

export interface TitleModel {
  items: TitleItem[]
  clearCount: number
  issueCount: number
  pendingCount: number
  totalValue: string
  totalEarnest: string
}

const phaseLabels: Record<string, string> = {
  'title-ordered': 'Title Ordered',
  'title-clear': 'Title Clear',
  'closing-scheduled': 'Closing Scheduled',
  'closed': 'Closed',
  'post-close': 'Post-Close',
}

export const adaptTitleModel = (store: CommandCenterStore): TitleModel => {
  const items: TitleItem[] = store.titleRecordIds.map((id) => {
    const raw = store.titleRecordsById[id]!
    const market = store.marketsById[raw.marketId]

    return {
      id: raw.id,
      leadId: raw.leadId,
      marketId: raw.marketId,
      address: raw.address,
      ownerName: raw.ownerName,
      status: raw.status,
      closingPhase: raw.closingPhase,
      closingPhaseLabel: phaseLabels[raw.closingPhase] ?? raw.closingPhase,
      titleCompany: raw.titleCompany,
      scheduledCloseIso: raw.scheduledCloseIso,
      scheduledCloseLabel: raw.scheduledCloseIso
        ? formatRelativeTime(raw.scheduledCloseIso)
        : null,
      daysInPhase: raw.daysInPhase,
      earnestDeposit: raw.earnestDeposit,
      earnestLabel: formatCurrency(raw.earnestDeposit),
      purchasePrice: raw.purchasePrice,
      priceLabel: formatCurrency(raw.purchasePrice),
      issues: raw.issues,
      lastUpdatedLabel: formatRelativeTime(raw.lastUpdatedIso),
      lastUpdatedIso: raw.lastUpdatedIso,
      marketLabel: market?.label ?? raw.marketId,
    }
  })

  // Sort: issues first, then pending, then by days in phase desc
  items.sort((a, b) => {
    const statusOrder = { issue: 0, review: 1, pending: 2, clear: 3, closed: 4 }
    const diff = statusOrder[a.status] - statusOrder[b.status]
    if (diff !== 0) return diff
    return b.daysInPhase - a.daysInPhase
  })

  const totalValue = items.reduce((s, t) => s + t.purchasePrice, 0)
  const totalEarnest = items.reduce((s, t) => s + t.earnestDeposit, 0)

  return {
    items,
    clearCount: items.filter((t) => t.status === 'clear').length,
    issueCount: items.filter((t) => t.status === 'issue').length,
    pendingCount: items.filter((t) => t.status === 'pending' || t.status === 'review').length,
    totalValue: formatCurrency(totalValue),
    totalEarnest: formatCurrency(totalEarnest),
  }
}

export const loadTitle = async (): Promise<TitleModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptTitleModel(store)
}
