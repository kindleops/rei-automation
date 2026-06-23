import { HOME_PRESETS, HOME_WORKSPACES } from './home.presets'
import type { HomeModel } from './home.types'
import { HOME_WIDGETS } from './home.widgets'
import { fetchHomeDashboardSnapshot } from '../../lib/data/dashboardData'
import { isDev, shouldUseSupabase } from '../../lib/data/shared'

export const loadHome = async (): Promise<HomeModel> => {
  const base: HomeModel = {
    workspaces: HOME_WORKSPACES,
    widgets: HOME_WIDGETS,
    presets: HOME_PRESETS,
    briefingInsights: [
      { id: 'hot-replies', label: 'Hot replies waiting', value: '14', tone: 'warning' },
      { id: 'failed-sends', label: 'Failed sends needing recovery', value: '7', tone: 'danger' },
      { id: 'market-pressure', label: 'Highest pressure market', value: 'Houston', tone: 'neutral' },
      { id: 'title-blockers', label: 'Offer/contract action needed', value: '9 files', tone: 'warning' },
      { id: 'automation-health', label: 'Automation health', value: '96.8% healthy', tone: 'success' },
    ],
    topMarkets: ['Dallas', 'Houston', 'Phoenix', 'Atlanta', 'Charlotte', 'Minneapolis'],
    activeMarkets: 7,
    leadPulses: 42,
    highPressureZones: 4,
    aiScanStatus: 'AI scan ready',
    activities: [
      { id: 'a1', kind: 'reply', source: 'Inbox', severity: 'info', title: 'New inbound seller reply', detail: 'Owner in Dallas replied in 2m on SMS thread', time: '2m ago' },
      { id: 'a2', kind: 'failed-send', source: 'Queue', severity: 'critical', title: 'Failed send requires retry', detail: 'Twilio route timeout in Houston sequence', time: '6m ago' },
      { id: 'a3', kind: 'offer', source: 'Deals', severity: 'warning', title: 'Offer package ready', detail: '3 offers are staged for operator approval', time: '11m ago' },
      { id: 'a4', kind: 'title', source: 'Title', severity: 'warning', title: 'Title blocker detected', detail: 'Lien hold on active contract in Phoenix', time: '18m ago' },
      { id: 'a5', kind: 'buyer', source: 'Dispo', severity: 'info', title: 'Buyer interest spike', detail: '8 buyers viewed package in the last hour', time: '23m ago' },
      { id: 'a6', kind: 'webhook', source: 'Automation', severity: 'critical', title: 'Webhook issue', detail: 'Podio sync webhook returned 429', time: '31m ago' },
    ],
  }

  if (!shouldUseSupabase()) {
    return base
  }

  try {
    const snapshot = await fetchHomeDashboardSnapshot()
    const widgets = base.widgets.map((widget) => {
      const liveMetric = snapshot.widgetMetrics[widget.id]
      return liveMetric ? { ...widget, primaryMetric: liveMetric } : widget
    })

    return {
      ...base,
      widgets,
      briefingInsights: snapshot.briefingInsights,
      topMarkets: snapshot.topMarkets.length > 0 ? snapshot.topMarkets : base.topMarkets,
      activeMarkets: snapshot.activeMarkets,
      leadPulses: snapshot.leadPulses,
      highPressureZones: snapshot.highPressureZones,
      aiScanStatus: snapshot.aiScanStatus,
      activities: snapshot.activities.length > 0 ? snapshot.activities : base.activities,
    }
  } catch (error) {
    if (isDev) {
      console.warn('[NEXUS] Home Supabase load failed, using static model.', error)
    }
    return base
  }
}
