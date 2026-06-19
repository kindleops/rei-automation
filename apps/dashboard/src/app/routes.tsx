import type { ReactNode } from 'react'

import { FullscreenAppShell } from '../shared/FullscreenAppShell'
import { InboxView } from '../views/inbox/InboxView'

import { PropertyIntelligenceApp } from '../views/deal-intelligence/PropertyIntelligenceApp'
import { loadAcquisitionWorkspace } from '../domain/acquisition/acquisition.adapter'
import type { AcquisitionWorkspaceModel } from '../domain/acquisition/acquisition.types'
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

const wrapFullscreen = (node: ReactNode, viewId?: string) => (
  <FullscreenAppShell viewId={viewId}>{node}</FullscreenAppShell>
)

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
  render: () => <InboxView initialWorkspaceView="thread" routeMode="fullscreen" />,
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
  render: (data) => wrapFullscreen(<PropertyIntelligenceApp data={data} />, 'deal_intelligence'),
})

const compIntelligenceRoute = defineRoute<null>({
  path: '/comp-intelligence',
  title: 'NEXUS | Comp Intelligence',
  loader: async () => null,
  render: () => <InboxView initialWorkspaceView="comp_intelligence" routeMode="fullscreen" />,
})

const buyerMatchRoute = defineRoute<BuyerModel>({
  path: '/buyer-match',
  title: 'NEXUS | Buyer Match',
  loader: loadBuyer,
  render: (data) => wrapFullscreen(<BuyerMatchView data={data} />, 'buyer_match'),
})

const queueRoute = defineRoute<QueueModel>({
  path: '/queue',
  title: 'NEXUS | Queue',
  loader: loadQueue,
  render: (data) => wrapFullscreen(<QueueView data={data} />, 'queue'),
})

const pipelineRoute = defineRoute<null>({
  path: '/pipeline',
  title: 'NEXUS | Pipeline',
  loader: async () => null,
  render: () => <InboxView initialWorkspaceView="pipeline" routeMode="fullscreen" />,
})

const calendarRoute = defineRoute<null>({
  path: '/calendar',
  title: 'NEXUS | Calendar',
  loader: async () => null,
  render: () => <InboxView initialWorkspaceView="calendar" routeMode="fullscreen" />,
})

const mapRoute = defineRoute<null>({
  path: '/map',
  title: 'NEXUS | Map',
  loader: async () => null,
  render: () => <InboxView initialWorkspaceView="command_map" routeMode="fullscreen" />,
})

const analyticsRoute = defineRoute<null>({
  path: '/analytics',
  title: 'NEXUS | Analytics',
  loader: async () => null,
  render: () => wrapFullscreen(<KpiIntelligencePage />, 'metrics'),
})

const closingDeskRoute = defineRoute<null>({
  path: '/closing-desk',
  title: 'NEXUS | Closing Desk',
  loader: async () => null,
  render: () => wrapFullscreen(<ClosingDeskView />, 'closing_desk'),
})

const campaignCommandRoute = defineRoute<null>({
  path: '/campaign-command',
  title: 'NEXUS | Campaign Command',
  loader: async () => null,
  render: () => wrapFullscreen(<CampaignsPage />, 'campaigns'),
})

const emailCommandRoute = defineRoute<null>({
  path: '/email-command',
  title: 'NEXUS | Email Command',
  loader: async () => null,
  render: () => wrapFullscreen(<EmailCommandCenter paneWidth="100" />, 'email'),
})

const workflowStudioRoute = defineRoute<null>({
  path: '/workflow-studio',
  title: 'NEXUS | Workflow Studio',
  loader: async () => null,
  render: () => wrapFullscreen(<WorkflowStudioV2 />, 'workflow_studio'),
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
  '/dashboard/kpis': '/analytics',
  '/buyer': '/buyer-match',
  '/campaigns': '/campaign-command',
  '/email': '/email-command',
  '/workflows-v2': '/workflow-studio',

  '/properties': '/deal-intelligence',

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