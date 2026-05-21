import type { ReactNode } from 'react'
import { LiveDashboardPage } from '../modules/dashboard/live/LiveDashboardPage'
import { loadLiveDashboard } from '../modules/dashboard/live/load-live-dashboard'
import type { LiveDashboardModel } from '../modules/dashboard/live/live-dashboard.adapter'
import InboxPage from '../modules/inbox/InboxPage'
import { AlertsPage } from '../modules/alerts/AlertsPage'
import { loadAlerts } from '../modules/alerts/alerts.adapter'
import type { AlertsModel } from '../modules/alerts/alerts.adapter'
import { StatsPage } from '../modules/stats/StatsPage'
import { loadStats } from '../modules/stats/stats.adapter'
import type { StatsModel } from '../modules/stats/stats.adapter'
import { MarketsPage } from '../modules/markets/MarketsPage'
import { loadMarkets } from '../modules/markets/markets.adapter'
import type { MarketsModel } from '../modules/markets/markets.adapter'
import { BuyerIntelPage } from '../modules/buyer/BuyerIntelPage'
import { loadBuyer } from '../modules/buyer/buyer.adapter'
import type { BuyerModel } from '../modules/buyer/buyer.adapter'
import { TitleWarRoomPage } from '../modules/title/TitleWarRoomPage'
import { loadTitle } from '../modules/title/title.adapter'
import type { TitleModel } from '../modules/title/title.adapter'
import { SettingsPage } from '../modules/settings/SettingsPage'
import { NotificationsPage } from '../modules/notifications/NotificationsPage'
import { loadNotifications } from '../modules/notifications/notifications.adapter'
import type { NotificationsModel } from '../modules/notifications/notifications.adapter'
import { WatchlistsPage } from '../modules/watchlists/WatchlistsPage'
import { loadWatchlists } from '../modules/watchlists/watchlists.adapter'
import type { WatchlistsModel } from '../modules/watchlists/watchlists.adapter'
import { QueuePage } from '../modules/queue/QueuePage'
import { loadQueue } from '../modules/queue/queue.adapter'
import type { QueueModel } from '../modules/queue/queue.types'
import { DossierPage } from '../modules/dossier/DossierPage'
import { loadDossier } from '../modules/dossier/dossier.adapter'
import type { DossierModel } from '../modules/dossier/dossier.types'
import { KpiIntelligencePage } from '../modules/kpis/KpiIntelligencePage'
import { HomePage } from '../modules/home/HomePage'
import { loadHome } from '../modules/home/home.adapter'
import type { HomeModel } from '../modules/home/home.types'
import { CommandStorePage } from '../modules/command-store/CommandStorePage'
import { AcquisitionSpaceDashboard } from '../modules/acquisition/AcquisitionSpaceDashboard'
import { OwnerIntelligenceApp } from '../modules/acquisition/apps/OwnerIntelligenceApp'
import { PropertyIntelligenceApp } from '../modules/acquisition/apps/PropertyIntelligenceApp'
import { ProspectCommandApp } from '../modules/acquisition/apps/ProspectCommandApp'
import { ContactStackApp } from '../modules/acquisition/apps/ContactStackApp'
import { OfferStudioApp } from '../modules/acquisition/apps/OfferStudioApp'
import { UnderwritingApp } from '../modules/acquisition/apps/UnderwritingApp'
import { AIBrainApp } from '../modules/acquisition/apps/AIBrainApp'
import { AcquisitionMapApp } from '../modules/acquisition/apps/AcquisitionMapApp'
import { AutomationMonitorApp } from '../modules/acquisition/apps/AutomationMonitorApp'
import { AcquisitionInboxApp } from '../modules/acquisition/apps/AcquisitionInboxApp'
import { AcquisitionQueueApp } from '../modules/acquisition/apps/AcquisitionQueueApp'
import { loadAcquisitionWorkspace } from '../modules/acquisition/acquisition.adapter'
import type { AcquisitionWorkspaceModel } from '../modules/acquisition/acquisition.types'

import { AgentsPage } from '../modules/agents/AgentsPage'
import { loadAgents } from '../modules/agents/agents.adapter'
import type { AgentsModel } from '../modules/agents/agents.adapter'

interface AppRoute<TData> {
  path: string
  title: string
  loader: () => Promise<TData>
  render: (data: TData) => ReactNode
}

export interface ResolvedRoute {
  path: string
  title: string
  loader: () => Promise<unknown>
  render: (data: unknown) => ReactNode
}

const defineRoute = <TData,>(route: AppRoute<TData>): ResolvedRoute => ({
  path: route.path,
  title: route.title,
  loader: route.loader as () => Promise<unknown>,
  render: (data) => route.render(data as TData),
})

const liveDashboardRoute = defineRoute<LiveDashboardModel>({
  path: '/dashboard/live',
  title: 'NEXUS | Live Command Center',
  loader: loadLiveDashboard,
  render: (data) => <LiveDashboardPage data={data} />,
})

const homeRoute = defineRoute<HomeModel>({
  path: '/',
  title: 'NEXUS | Command Board',
  loader: loadHome,
  render: (data) => <HomePage data={data} />,
})

const commandStoreRoute = defineRoute<null>({
  path: '/command-store',
  title: 'NEXUS | Command Store',
  loader: async () => null,
  render: () => <CommandStorePage />,
})

const acquisitionRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition',
  title: 'NEXUS | Acquisition Command',
  loader: loadAcquisitionWorkspace,
  render: (data) => <AcquisitionSpaceDashboard data={data} />,
})

const acquisitionOwnersRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/owners',
  title: 'NEXUS | Owner Intelligence',
  loader: loadAcquisitionWorkspace,
  render: (data) => <OwnerIntelligenceApp data={data} />,
})

const acquisitionPropertiesRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/properties',
  title: 'NEXUS | Property Intelligence',
  loader: loadAcquisitionWorkspace,
  render: (data) => <PropertyIntelligenceApp data={data} />,
})

const propertiesRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/properties',
  title: 'NEXUS | Property Intelligence',
  loader: loadAcquisitionWorkspace,
  render: (data) => <PropertyIntelligenceApp data={data} />,
})

const acquisitionProspectsRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/prospects',
  title: 'NEXUS | Prospect Command',
  loader: loadAcquisitionWorkspace,
  render: (data) => <ProspectCommandApp data={data} />,
})

const acquisitionContactsRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/contacts',
  title: 'NEXUS | Contact Stack',
  loader: loadAcquisitionWorkspace,
  render: (data) => <ContactStackApp data={data} />,
})

const acquisitionInboxRoute = defineRoute<null>({
  path: '/acquisition/inbox',
  title: 'NEXUS | Seller Inbox',
  loader: async () => null,
  render: () => <AcquisitionInboxApp />,
})

const acquisitionQueueRoute = defineRoute<
  AcquisitionWorkspaceModel & { queueData: QueueModel }
>({
  path: '/acquisition/queue',
  title: 'NEXUS | Outreach Queue',
  loader: async () => {
    const [workspaceData, queueData] = await Promise.all([
      loadAcquisitionWorkspace(),
      loadQueue(),
    ])
    return { ...workspaceData, queueData }
  },
  render: (data) => <AcquisitionQueueApp data={data} />,
})

const acquisitionOffersRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/offers',
  title: 'NEXUS | Offer Studio',
  loader: loadAcquisitionWorkspace,
  render: (data) => <OfferStudioApp data={data} />,
})

const acquisitionUnderwritingRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/underwriting',
  title: 'NEXUS | Underwriting',
  loader: loadAcquisitionWorkspace,
  render: (data) => <UnderwritingApp data={data} />,
})

const acquisitionAIBrainRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/ai-brain',
  title: 'NEXUS | AI Brain',
  loader: loadAcquisitionWorkspace,
  render: (data) => <AIBrainApp data={data} />,
})

const acquisitionMapRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/map',
  title: 'NEXUS | Acquisition Map',
  loader: loadAcquisitionWorkspace,
  render: (data) => <AcquisitionMapApp data={data} />,
})

const acquisitionsMapRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisitions/map',
  title: 'NEXUS | Acquisitions Command Map',
  loader: loadAcquisitionWorkspace,
  render: (data) => <AcquisitionMapApp data={data} />,
})

const acquisitionAutomationsRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/acquisition/automations',
  title: 'NEXUS | Automation Monitor',
  loader: loadAcquisitionWorkspace,
  render: (data) => <AutomationMonitorApp data={data} />,
})

const inboxRoute = defineRoute<null>({
  path: '/inbox',
  title: 'NEXUS | Inbox',
  loader: async () => null,
  render: () => <InboxPage />,
})

const alertsRoute = defineRoute<AlertsModel>({
  path: '/alerts',
  title: 'NEXUS | Alerts',
  loader: loadAlerts,
  render: (data) => <AlertsPage data={data} />,
})

const statsRoute = defineRoute<StatsModel>({
  path: '/stats',
  title: 'NEXUS | Intelligence Dashboard',
  loader: loadStats,
  render: (data) => <StatsPage data={data} />,
})

const kpiRoute = defineRoute<null>({
  path: '/dashboard/kpis',
  title: 'NEXUS | KPI Intelligence',
  loader: async () => null,
  render: () => <KpiIntelligencePage />,
})

const marketsRoute = defineRoute<MarketsModel>({
  path: '/markets',
  title: 'NEXUS | Active Markets',
  loader: loadMarkets,
  render: (data) => <MarketsPage data={data} />,
})

const buyerRoute = defineRoute<BuyerModel>({
  path: '/buyer',
  title: 'NEXUS | Buyer Intelligence',
  loader: loadBuyer,
  render: (data) => <BuyerIntelPage data={data} />,
})

const titleRoute = defineRoute<TitleModel>({
  path: '/title',
  title: 'NEXUS | Title & Closing',
  loader: loadTitle,
  render: (data) => <TitleWarRoomPage data={data} />,
})

const settingsRoute = defineRoute<null>({
  path: '/settings',
  title: 'NEXUS | Settings',
  loader: async () => null,
  render: () => <SettingsPage />,
})

const notificationsRoute = defineRoute<NotificationsModel>({
  path: '/notifications',
  title: 'NEXUS | Notifications',
  loader: loadNotifications,
  render: (data) => <NotificationsPage data={data} />,
})

const watchlistsRoute = defineRoute<WatchlistsModel>({
  path: '/watchlists',
  title: 'NEXUS | Watchlists',
  loader: loadWatchlists,
  render: (data) => <WatchlistsPage data={data} />,
})

const queueRoute = defineRoute<QueueModel>({
  path: '/queue',
  title: 'NEXUS | Queue',
  loader: loadQueue,
  render: (data) => <QueuePage data={data} />,
})

const dossierRoute = defineRoute<DossierModel>({
  path: '/dossier',
  title: 'NEXUS | Seller Dossier',
  loader: loadDossier,
  render: (data) => <DossierPage data={data} />,
})

const agentsRoute = defineRoute<AgentsModel>({
  path: '/agents',
  title: 'NEXUS | AI Agent Performance',
  loader: loadAgents,
  render: (data) => <AgentsPage data={data} />,
})

const routes = [
  homeRoute,
  agentsRoute,
  acquisitionRoute,
  acquisitionOwnersRoute,
  acquisitionPropertiesRoute,
  propertiesRoute,
  acquisitionProspectsRoute,
  acquisitionContactsRoute,
  acquisitionInboxRoute,
  acquisitionQueueRoute,
  acquisitionOffersRoute,
  acquisitionUnderwritingRoute,
  acquisitionAIBrainRoute,
  acquisitionMapRoute,
  acquisitionsMapRoute,
  acquisitionAutomationsRoute,
  commandStoreRoute,
  liveDashboardRoute,
  inboxRoute,
  alertsRoute,
  statsRoute,
  kpiRoute,
  marketsRoute,
  buyerRoute,
  titleRoute,
  settingsRoute,
  notificationsRoute,
  watchlistsRoute,
  queueRoute,
  dossierRoute,
]

export const resolveRoute = (path: string) =>
  routes.find((route) => route.path === path) ?? homeRoute
