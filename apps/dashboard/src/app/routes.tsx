import type { ReactNode } from 'react'

import { InboxView } from '../views/inbox/InboxView'

import { PropertyIntelligenceApp } from '../views/deal-intelligence/PropertyIntelligenceApp'
import { loadAcquisitionWorkspace } from '../modules/acquisition/acquisition.adapter'
import type { AcquisitionWorkspaceModel } from '../modules/acquisition/acquisition.types'
import { ConversationView } from '../views/conversation/ConversationView'

import { BuyerMatchView } from '../views/buyer-match/BuyerMatchView'
import { loadBuyer } from '../domain/buyer/buyer.adapter'
import type { BuyerModel } from '../domain/buyer/buyer.adapter'

import { QueueView } from '../views/queue/QueueView'
import { loadQueue } from '../views/queue/queue.adapter'
import type { QueueModel } from '../domain/queue/queue.types'

import { KpiIntelligencePage } from '../views/analytics/KpiIntelligencePage'
import { ClosingDeskView } from '../views/closing-desk/ClosingDeskView'


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
  render: () => <ConversationView />,
})

const inboxRoute = defineRoute<null>({
  path: '/inbox',
  title: 'NEXUS | Inbox',
  loader: async () => null,
  render: () => <InboxView />,
})

const conversationRoute = defineRoute<null>({
  path: '/conversation',
  title: 'NEXUS | Conversation',
  loader: async () => null,
  render: () => <ConversationView />,
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
  render: () => <InboxView />,
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
  render: () => <InboxView />,
})

const calendarRoute = defineRoute<null>({
  path: '/calendar',
  title: 'NEXUS | Calendar',
  loader: async () => null,
  render: () => <InboxView />,
})

const mapRoute = defineRoute<null>({
  path: '/map',
  title: 'NEXUS | Map',
  loader: async () => null,
  render: () => <InboxView />,
})

const analyticsRoute = defineRoute<null>({
  path: '/analytics',
  title: 'NEXUS | Analytics',
  loader: async () => null,
  render: () => <KpiIntelligencePage />,
})

const closingDeskRoute = defineRoute<null>({
  path: '/closing-desk',
  title: 'NEXUS | Closing Desk',
  loader: async () => null,
  render: () => <ClosingDeskView />,
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
  '/buyer': '/buyer-match',
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

  '/markets': '/map',
  '/dossier': '/deal-intelligence',
  '/agents': '/analytics',
  '/mobile': '/inbox',
  '/notifications': '/inbox',
  '/watchlists': '/deal-intelligence',
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