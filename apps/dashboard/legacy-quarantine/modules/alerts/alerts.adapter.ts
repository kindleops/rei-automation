import type { CommandCenterStore } from '../../domain/types'
import { formatRelativeTime } from '../../shared/formatters'

export interface AlertItem {
  id: string
  marketId: string
  marketLabel: string
  severity: 'critical' | 'warning' | 'info'
  priority: string
  title: string
  detail: string
  metricLabel: string
  metricValue: string
  timestampLabel: string
  timestampIso: string
  relatedLeadId: string | null
}

export interface AlertsModel {
  alerts: AlertItem[]
  criticalCount: number
  warningCount: number
  infoCount: number
  totalCount: number
  affectedMarkets: string[]
}

export const adaptAlertsModel = (store: CommandCenterStore): AlertsModel => {
  const alerts: AlertItem[] = store.alertIds.map((id) => {
    const raw = store.alertsById[id]!
    const market = store.marketsById[raw.marketId]
    // Find a related lead in this market for linking
    const marketProps = store.propertyIdsByMarketId[raw.marketId] ?? []
    return {
      id: raw.id,
      marketId: raw.marketId,
      marketLabel: market?.label ?? raw.marketId,
      severity: raw.severity,
      priority: raw.priority,
      title: raw.title,
      detail: raw.detail,
      metricLabel: raw.metricLabel,
      metricValue: raw.metricValue,
      timestampLabel: formatRelativeTime(raw.timestampIso),
      timestampIso: raw.timestampIso,
      relatedLeadId: marketProps[0] ?? null,
    }
  })

  alerts.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 }
    return severityOrder[a.severity] - severityOrder[b.severity]
  })

  const affectedMarkets = [...new Set(alerts.map((a) => a.marketLabel))]

  return {
    alerts,
    criticalCount: alerts.filter((a) => a.severity === 'critical').length,
    warningCount: alerts.filter((a) => a.severity === 'warning').length,
    infoCount: alerts.filter((a) => a.severity === 'info').length,
    totalCount: alerts.length,
    affectedMarkets,
  }
}

export const loadAlerts = async (): Promise<AlertsModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptAlertsModel(store)
}
