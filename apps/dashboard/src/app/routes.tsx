import type { ReactNode } from 'react'

import InboxPage from '../modules/inbox/InboxPage'

import { PropertyIntelligenceApp } from '../views/deal-intelligence/PropertyIntelligenceApp'
import { loadAcquisitionWorkspace } from '../modules/acquisition/acquisition.adapter'
import type { AcquisitionWorkspaceModel } from '../modules/acquisition/acquisition.types'

import { BuyerMatchView } from '../views/buyer-match/BuyerMatchView'
import { loadBuyer } from '../domain/buyer/buyer.adapter'
import type { BuyerModel } from '../domain/buyer/buyer.adapter'

import { QueueView } from '../views/queue/QueueView'
import { loadQueue } from '../views/queue/queue.adapter'
import type { QueueModel } from '../domain/queue/queue.types'

import { KpiIntelligencePage } from '../views/analytics/KpiIntelligencePage'

import { TitleWarRoomPage } from '../modules/title/TitleWarRoomPage'
import { loadTitle } from '../modules/title/title.adapter'
import type { TitleModel } from '../modules/title/title.adapter'

import { CampaignsPage } from '../views/campaign-command/CampaignsPage'
import { EmailCommandCenter } from '../views/email-command/EmailCommandCenter'
import WorkflowStudioV2 from '../views/workflow-studio/v2/WorkflowStudioV2'

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

const rootRoute = defineRoute<null>({
  path: '/',
  title: 'NEXUS | Inbox',
  loader: async () => null,
  render: () => <InboxPage />,
})

const inboxRoute = defineRoute<null>({
  path: '/inbox',
  title: 'NEXUS | Inbox',
  loader: async () => null,
  render: () => <InboxPage />,
})

const conversationRoute = defineRoute<null>({
  path: '/conversation',
  title: 'NEXUS | Conversation',
  loader: async () => null,
  render: () => <InboxPage />,
})

const dealIntelligenceRoute = defineRoute<AcquisitionWorkspaceModel>({
  path: '/deal-intelligence',
  title: 'NEXUS | Deal Intelligence',
  loader: loadAcquisitionWorkspace,
  render: (data) => <PropertyIntelligenceApp data={data} />,
})

const compIntelligenceRoute = defineRoute<null>({
  path: '/comp-intelligence',
  title: 'NEXUS | Comp Intelligence',
  loader: async () => null,
  render: () => <InboxPage />,
})

const buyerMatchRoute = defineRoute<BuyerModel>({
  path: '/buyer-match',
  title: 'NEXUS | Buyer Match',
  loader: loadBuyer,
  render: (data) => <BuyerMatchView data={data} />,
})

const queueRoute = defineRoute<QueueModel>({
  path: '/queue',
  title: 'NEXUS | Queue',
  loader: loadQueue,
  render: (data) => <QueueView data={data} />,
})

const pipelineRoute = defineRoute<null>({
  path: '/pipeline',
  title: 'NEXUS | Pipeline',
  loader: async () => null,
  render: () => <InboxPage />,
})

const calendarRoute = defineRoute<null>({
  path: '/calendar',
  title: 'NEXUS | Calendar',
  loader: async () => null,
  render: () => <InboxPage />,
})

const mapRoute = defineRoute<null>({
  path: '/map',
  title: 'NEXUS | Map',
  loader: async () => null,
  render: () => <InboxPage />,
})

const analyticsRoute = defineRoute<null>({
  path: '/analytics',
  title: 'NEXUS | Analytics',
  loader: async () => null,
  render: () => <KpiIntelligencePage />,
})

const closingDeskRoute = defineRoute<TitleModel>({
  path: '/closing-desk',
  title: 'NEXUS | Closing Desk',
  loader: loadTitle,
  render: (data) => <TitleWarRoomPage data={data} />,
})

const campaignCommandRoute = defineRoute<null>({
  path: '/campaign-command',
  title: 'NEXUS | Campaign Command',
  loader: async () => null,
  render: () => <CampaignsPage />,
})

const emailCommandRoute = defineRoute<null>({
  path: '/email-command',
  title: 'NEXUS | Email Command',
  loader: async () => null,
  render: () => <EmailCommandCenter />,
})

const workflowStudioRoute = defineRoute<null>({
  path: '/workflow-studio',
  title: 'NEXUS | Workflow Studio',
  loader: async () => null,
  render: () => (
    <div
      className="nx-premium-inbox"
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <WorkflowStudioV2 />
    </div>
  ),
})

const routes = [
  rootRoute,
  inboxRoute,
  conversationRoute,
  dealIntelligenceRoute,
  compIntelligenceRoute,
  buyerMatchRoute,
  queueRoute,
  pipelineRoute,
  calendarRoute,
  mapRoute,
  analyticsRoute,
  closingDeskRoute,
  campaignCommandRoute,
  emailCommandRoute,
  workflowStudioRoute,
]

const legacyRouteAliases: Record<string, string> = {
  '/dashboard/live': '/map',
  '/dashboard/kpis': '/analytics',
  '/stats': '/analytics',
  '/buyer': '/buyer-match',
  '/title': '/closing-desk',
  '/campaigns': '/campaign-command',
  '/email': '/email-command',
  '/workflows-v2': '/workflow-studio',

  '/properties': '/deal-intelligence',
  '/acquisition': '/deal-intelligence',
  '/acquisition/owners': '/deal-intelligence',
  '/acquisition/properties': '/deal-intelligence',
  '/acquisition/prospects': '/deal-intelligence',
  '/acquisition/contacts': '/deal-intelligence',
  '/acquisition/inbox': '/inbox',
  '/acquisition/queue': '/queue',
  '/acquisition/offers': '/closing-desk',
  '/acquisition/underwriting': '/deal-intelligence',
  '/acquisition/ai-brain': '/analytics',
  '/acquisition/map': '/map',
  '/acquisitions/map': '/map',
  '/acquisition/automations': '/workflow-studio',

  '/alerts': '/analytics',
  '/markets': '/map',
  '/dossier': '/deal-intelligence',
  '/agents': '/analytics',
  '/mobile': '/inbox',
  '/notifications': '/inbox',
  '/watchlists': '/deal-intelligence',
  '/settings': '/inbox',
  '/command-store': '/inbox',
}

const normalizePath = (path: string) => {
  if (!path || path === '/') return '/'
  return path.endsWith('/') ? path.slice(0, -1) : path
}

export const resolveRoute = (path: string) => {
  const normalizedPath = normalizePath(path)
  const canonicalPath = legacyRouteAliases[normalizedPath] ?? normalizedPath

  return routes.find((route) => route.path === canonicalPath) ?? inboxRoute
}