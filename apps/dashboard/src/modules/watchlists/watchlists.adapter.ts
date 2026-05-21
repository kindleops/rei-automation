import type { CommandCenterStore } from '../../domain/types'
import { formatRelativeTime } from '../../shared/formatters'

export interface WatchlistItem {
  id: string
  type: 'market' | 'lead' | 'agent' | 'zip'
  targetId: string
  label: string
  notes: string
  addedLabel: string
  addedIso: string
  alertOnChange: boolean
}

export interface WatchlistsModel {
  items: WatchlistItem[]
  totalCount: number
  alertingCount: number
}

export const adaptWatchlistsModel = (store: CommandCenterStore): WatchlistsModel => {
  const items: WatchlistItem[] = store.watchlistIds.map((id) => {
    const raw = store.watchlistsById[id]!
    return {
      ...raw,
      addedLabel: formatRelativeTime(raw.addedIso),
    }
  })

  items.sort((a, b) => new Date(b.addedIso).getTime() - new Date(a.addedIso).getTime())

  return {
    items,
    totalCount: items.length,
    alertingCount: items.filter((i) => i.alertOnChange).length,
  }
}

export const loadWatchlists = async (): Promise<WatchlistsModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptWatchlistsModel(store)
}
