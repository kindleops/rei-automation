import { useState, useMemo, useEffect, useCallback, useRef, lazy, Suspense, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../components/auth/AuthProvider'
import { pushRoutePath } from '../../app/router'
import { useInboxData, toWorkflowThread, isInboxDebugEnabled } from './inbox.adapter'
import { resolveCanonicalThreadStateKey } from '../../domain/inbox/resolveCanonicalThreadStateKey'
import './inbox-universal.css'
import {
  updateThreadStage,
  updateThreadStatus,
  starThread,
  unstarThread,
  pinThread,
  unpinThread,
  archiveThread,
  unarchiveThread,
  markThreadRead,
  markThreadUnread,
  markThreadHot,
  snoozeThread,
  pauseAutomation,
  resumeAutomation,
  retryFailedSend,
  suppressThread,
  approveQueueItem,
  cancelQueueItem,
  type InboxStatus,
  type SellerStage,
  type InboxWorkflowThread,
  } from '../../lib/data/inboxWorkflowData'

import { executeAutoReply } from '../../lib/data/inboxAutoReply'


import {
  getQueueProcessorHealth,
  getThreadMessagesPageForThread,
  getThreadMessagesForThread,
  getConversationThreadIdForThread,
  buildThreadContextFromThread,
  queueReplyFromInbox,
  scheduleReplyFromInbox,
  sendInboxMessageNow,
  type QueueProcessorHealth,
  type ThreadIntelligenceRecord,
  type ThreadMessage,
  type ThreadContext,
  dedupeMessages,
  toThreadMessage,
} from '../../lib/data/inboxData'
import { getDealContextByProperty, getDealContextByThread, normalizeDealContext, type DealContext } from '../../lib/data/dealContext'

import { fetchQueueModel, type QueueModel } from '../../lib/data/queueData'
import { fetchSmsTemplates, type SmsTemplate } from '../../lib/data/templateData'
import { fetchInboxActivity, logInboxActivity, type InboxActivityEvent } from '../../lib/data/inboxActivityData'
import { getSupabaseClient, hasSupabaseEnv } from '../../lib/supabaseClient'
import { subscribeToInboxRealtime } from '../../lib/data/realtime'
import {
  getQueueControlSettings,
  updateQueueControlSettings,
  callBackend,
  getBackendHealth,
  fetchPropertyParticipants,
} from '../../lib/api/backendClient'
import { commitDashboardMessages, patchDashboardThread } from '../../lib/data/dashboardEntityStore'
import { logRealtimePatchApplied } from '../../lib/data/dashboardDataLayer'
import { WatchlistProvider } from '../../lib/watchlistContext'
import { emitNotification } from '../../shared/NotificationToast'
import { Icon } from '../../shared/icons'
import { NexusTopBar } from './components/NexusTopBar'
import { type CampaignControlDiagnostics, type QueueCommandCaps, type QueueCommandMode } from './components/QueueCommandCenter'
import { InboxSidebar } from './components/InboxSidebar'
import { InboxConversationTable, type ConversationTableSort } from './components/InboxConversationTable'
import { ChatThread, buildAdaptiveSuggestions } from './components/ChatThread'
import { Composer } from './components/Composer'
import { ActiveProspectCard } from './components/ActiveProspectCard'
import type { PropertyParticipant, PropertyParticipantGraph } from './utils/participantLabels'
// ComposerTranslationBar is now inline inside Composer
import { IntelligencePanel } from './components/IntelligencePanel'
import { QueuePage } from '../../views/queue/QueuePage'
import { InboxCalendarView } from '../../views/calendar/InboxCalendarView'
import type { TemplateActionPayload } from './components/TemplatePopover'
import { InboxActivityPanel } from './components/InboxActivityPanel'
import type { MapStyleMode } from '../../views/map/InboxCommandMap'
import { InboxUtilityDrawer, MapDossierDrawer } from './components/InboxUtilityDrawer'
import { LiveCopilotChat } from '../copilot/components/LiveCopilotChat'
import { AdvancedFiltersModal } from './components/AdvancedFiltersModal'
import { InboxCommandPalette, type InboxCmd } from './InboxCommandPalette'
import { InboxSchedulePanel, type ScheduledTime } from './InboxSchedulePanel'
import { ThreadDebugModal } from './components/ThreadDebugModal'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { MobileThreadHeader } from '../mobile/MobileThreadHeader'
import { publishMobileInboxBadge } from '../mobile/mobile-inbox-bridge'

import { EmailCommandCenter } from '../../views/email-command/EmailCommandCenter'
import WorkflowStudioV2 from '../../views/workflow-studio/v2/WorkflowStudioV2'
import { openSellerAutomationStudioFromEntity } from '../../views/workflow-studio/v2/workflow-studio-routing'
import {
  defaultBuyerMapFilters,
  useBuyerCommandData,
  type BuyerMapFilters,
} from '../../views/buyer-match/buyerCommandData'

import { translateText } from './translate.api'
import { buildThreadCommandIntel, type ThreadCommandIntel } from './ai-command-center'
import { buildAutonomousEngineModel, defaultAutonomyControlState, type AutonomyControlState } from './autonomy-engine'
import {
  closeMapMode,
  cycleInboxMode,
  cycleLeftPanelMode,
  cycleMapMode,
  cycleRightPanelMode,
  defaultInboxLayoutState,
  defaultMapSourceMode,
  getLayoutClassNames,
  layoutToastForState,
  openMapMode,
  resetLayoutMode,
  type ActiveOverlay,
  type InboxLayoutState,
  type MapSourceMode,
} from '../../domain/inbox/inbox-layout-state'
import {
  buildContextFromActivityEvent,
  buildContextFromCalendarEvent,
  buildContextFromQueueItem,
  buildContextFromThread,
  type ActiveInboxContext,
  type InboxWorkspaceView,
  type SetActiveContextOptions,
} from './active-context'
import { EntityGraphWorkspace } from '../entity-graph/EntityGraphWorkspace'
import type { EntityGraphAction } from '../../domain/entity-graph/entity-graph.types'
import { routeEntityGraphAction } from '../../domain/entity-graph/entity-graph-route-actions'
import {
  activeInboxFromUniversalContext,
  EMPTY_UNIVERSAL_ENTITY_CONTEXT,
  mergeUniversalContexts,
  parseEntityGraphDeepLink,
  syncUniversalContextToUrl,
  universalContextFromActiveInbox,
} from '../../domain/entity-graph/universal-entity-context'
import type { UniversalEntityContext } from '../../domain/entity-graph/entity-graph.types'
import {
  patchUniversalEntityContextSnapshot,
  setUniversalEntityContextSnapshot,
  subscribeUniversalEntityContext,
} from '../../domain/entity-graph/universal-entity-context-store'
import {
  activeContextMatchesThread,
  dealContextFromActiveInbox,
  findThreadByRef,
  findThreadForActiveContext,
  hasEntityAnchor,
  resolveCanonicalWorkspaceContext,
  resolveInboxHighlightId,
  syncPayloadFromOpportunity,
  syncPayloadFromUniversal,
  threadStubFromActiveContext,
} from '../../domain/entity-graph/universal-sync'
import type { PipelineOpportunity } from '../../domain/pipeline/pipeline-opportunity.types'
import {
  applyInboxFilters,
  getAdvancedFilterOptions,
  getInboxViewCounts,
  getSavedPresetConfig,
  isSuppressedThread,
  resolveThreadPrimaryName,
  resolveThreadOwnerName,
  type ApplyInboxFiltersOptions,
  type InboxAdvancedFilters,
  type InboxSavedFilterPreset,
  type InboxStageSelectValue,
  type InboxViewSelectValue,
} from './inbox-ui-helpers'
import { buildConversationDecision } from '../../domain/inbox/inbox-decisioning'
import {
  buildAdvancedFilterChips,
  clearAllAdvancedFilters,
  countActiveAdvancedFilters,
  hasActiveAdvancedFilters,
  serializeAdvancedFiltersForServer,
} from '../../domain/inbox/inbox-advanced-filter-engine'
import {
  getViewLayoutMode,
  resolveLayoutModeForPane,
  resolveWorkspaceFlexBases,
  resolveWorkspaceWidthLabels,
  type ViewWidthPercent,
} from '../../domain/inbox/view-layout'
import {
  buildIsStillSelected,
  createThreadSelectHandlers,
  executeThreadSelectFetches,
  planThreadSelect,
  resolveThreadCacheKey,
} from '../../domain/inbox/thread-select-orchestrator'
import {
  buildOptimisticOutboundMessage,
  buildOptimisticThreadPatch,
  mergeOptimisticPatches,
} from '../../domain/inbox/optimistic-thread-patch'
import {
  createSelectedThreadPollScheduler,
} from '../../domain/inbox/inbox-poll-scheduler'
import {
  getInboxProof,
  markDossierParallelStarted,
  markInboxNavigationStart,
  markInboxShellReady,
  markOptimisticPatch,
  markSelectedPollTick,
  markThreadSelectTelemetry,
  clearUncachedMessagesTelemetry,
  registerInboxProofDriveAction,
} from '../../domain/inbox/inbox-proof-bridge'

import './inbox-premium.css'
// inbox-rebuild-v2.css is merged into inbox-premium.css — do not re-import it
import './inbox-polish.css'
import './notification-hud.css'
import './inbox-density-25.css' // compact nx-row25 styles for rail25/review50 modes
import './inbox-elite-ui.css' // full-header gradient + category rail + four-zone rows
import './inbox-workspace-layout.css' // 25/50/75/100 workspace mode layout system
import '../../views/buyer-match/buyer-intel-upgrade.css'
import '../copilot/copilot-v2.css' // canonical copilot sheet (merged copilot/copilot.css)
import './conversation-redesign.css'
import './conversation-composer-premium.css'
import './conversation-header-timeline.css'
import './conversation-live.css'
// !! IMPORT ORDER LOCKED — nx-ui-foundation-final.css MUST remain the last CSS import here !!
import '../../styles/nx-ui-foundation-final.css'
import { GLOBAL_COMMAND_ACTION_EVENT, GLOBAL_COMMAND_CONTEXT_EVENT, GLOBAL_COMMAND_OPEN_EVENT, type CommandResult } from '../../domain/command-center/command.types'
import { useInboxTopSearch } from '../command-center/useInboxTopSearch'
import { saveRecentCommandLocation } from '../command-center/providers/locationCommandProvider'
import { applyThemeToDOM, loadSettings, resolveDataThemeAttr, subscribeSettings, updateSetting, type AccentPalette } from '../../shared/settings'
import type { NexusGlobalThemeId } from '../../domain/theme/nexusThemes'

const CompIntelligenceWorkspace = lazy(() => import('../../views/comp-intelligence/CompIntelligenceWorkspace').then((m) => ({ default: m.default })))
// DEV: Comp Intelligence V4 rebuild is the DEFAULT in dev. Opt OUT (old workspace)
// with localStorage 'nx.comp.v4' = '0'. Production (DEV false) always uses the old one.
const CompIntelligenceV4Workspace = lazy(() => import('../../views/comp-intelligence-v4/CompIntelligenceV4Workspace').then((m) => ({ default: m.default })))
const COMP_V4_ENABLED = Boolean(import.meta.env.DEV) && (typeof window === 'undefined' || window.localStorage.getItem('nx.comp.v4') !== '0')
const BuyerMatchWorkspace = lazy(() => import('./components/BuyerMatchWorkspace').then((m) => ({ default: m.BuyerMatchWorkspace })))
const BuyerMatchV4Workspace = lazy(() => import('./buyer-match-v4/BuyerMatchV4Workspace').then((m) => ({ default: m.BuyerMatchV4Workspace })))
/** DEV: Buyer Match V4 is default in dev. Opt out with localStorage `nx.buyer.v4` = '0'. */
const BUYER_MATCH_V4_ENABLED =
  Boolean(import.meta.env.DEV) && (typeof window === 'undefined' || window.localStorage.getItem('nx.buyer.v4') !== '0')
const PipelineWorkspace = lazy(() => import('../../views/pipeline/PipelineWorkspace').then((m) => ({ default: m.PipelineWorkspace })))
const MetricsWarRoom = lazy(() => import('./components/MetricsWarRoom').then((m) => ({ default: m.MetricsWarRoom })))
const InboxCommandMap = lazy(() => import('../../views/map/InboxCommandMap').then((m) => ({ default: m.InboxCommandMap })))
const InboxCampaignView = lazy(() => import('../../views/campaign-command/InboxCampaignView').then((m) => ({ default: m.InboxCampaignView })))
const ClosingDeskView = lazy(() => import('../../views/closing-desk/ClosingDeskView').then((m) => ({ default: m.ClosingDeskView })))

const WorkspaceSuspense = ({ children }: { children: ReactNode }) => (
  <Suspense fallback={<div className="nx-workspace-surface__loading">Loading workspace…</div>}>
    {children}
  </Suspense>
)

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

function resolveMessageCacheKeyForThread(
  thread: InboxWorkflowThread | null | undefined,
  fallbackId = '',
): string {
  return resolveThreadCacheKey(thread, fallbackId, thread ? getConversationThreadIdForThread(thread) : null)
}
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  it: 'Italian',
  de: 'German',
  ru: 'Russian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
}

type ThreadTranslateViewMode = 'original' | 'translated'
type TableDensityMode = 'comfortable' | 'compact' | 'ultra_compact'
const DEFAULT_QUEUE_COMMAND_CAPS: QueueCommandCaps = {
  sends_per_run: 10,
  auto_replies_per_run: 10,
  followups_per_run: 25,
  first_touches_per_run: 25,
  max_per_number_per_day: 40,
  max_per_market_per_hour: 75,
}

const normalizeLanguageCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().toLowerCase().replace('_', '-')
  if (!cleaned) return null
  if (cleaned.startsWith('english')) return 'en'
  if (cleaned.startsWith('spanish')) return 'es'
  return cleaned
}

const languageLabelFor = (languageCode: string | null): string => {
  if (!languageCode) return 'Unknown'
  const baseCode = languageCode.split('-')[0]
  return LANGUAGE_LABELS[baseCode] ?? languageCode.toUpperCase()
}

const isEnglishLanguage = (languageCode: string | null): boolean => {
  if (!languageCode) return false
  return languageCode.startsWith('en')
}

const WORKSPACE_VIEW_OPTIONS: Array<{ key: InboxWorkspaceView; label: string; description: string }> = [
  { key: 'thread', label: 'Inbox', description: 'Acquisition thread rail with priority buckets and live sellers.' },
  { key: 'sms_thread', label: 'Conversation View', description: 'Full seller conversation with quick actions and composer.' },
  { key: 'list', label: 'List View', description: 'Dense sortable thread list across the acquisition inbox.' },
  { key: 'entity_graph', label: 'Entity Graph', description: 'Universal entity selector across properties, owners, people, and contact methods.' },
  { key: 'deal_intelligence', label: 'Deal Intelligence', description: 'Full-screen seller, property, offer, and timeline intelligence.' },
  { key: 'closing_desk', label: 'Closing Desk', description: 'Offers, contracts, title, escrow, and signature timelines.' },
  { key: 'command_map', label: 'Command Map View', description: 'Cinematic acquisition map with ticker, pins, and live activity.' },
  { key: 'pipeline', label: 'Pipeline View', description: 'Stage-based command kanban for the active pipeline.' },
  { key: 'queue', label: 'Queue View', description: 'Outbound, follow-up, and delivery execution status.' },
  { key: 'calendar', label: 'Calendar View', description: 'Follow-ups, deadlines, queued sends, and contract timing.' },
  { key: 'metrics', label: 'Metrics View', description: 'Inbox KPI command center with automation and reply health.' },
  { key: 'comp_intelligence', label: 'Comp Intelligence View', description: 'Subject property, ARV, offer range, and comp signals.' },
  { key: 'buyer_match', label: 'Buyer Match View', description: 'Buyer demand, dispo fit, and buyer-match readiness.' },
  { key: 'campaigns', label: 'Campaign Command', description: 'SMS campaign intelligence, targets, and send performance.' },
  { key: 'email', label: 'Email Command', description: 'Brevo email records, inbox, composer, templates, and provider health.' },
  { key: 'workflow_studio', label: 'Workflow Studio', description: 'Workflow definitions, template variants, sender pools, and dry-run previews.' },
]

type NexusWorkspaceKey =
  | 'deal_desk'
  | 'command_center'
  | 'comping'
  | 'buyer_match_desk'
  | 'pipeline_flow'
  | 'queue_control'
  | 'market_command'
  | 'closing_desk'
  | 'ops_monitor'

type WorkspaceStatus = 'ready' | 'coming_soon' | 'backend_not_ready'

type NexusWorkspacePreset = {
  key: NexusWorkspaceKey
  label: string
  description: string
  status: WorkspaceStatus
  views: InboxWorkspaceView[]
  widths: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>
}

const NEXUS_WORKSPACE_PRESETS: NexusWorkspacePreset[] = [
  {
    key: 'deal_desk',
    label: 'Deal Desk',
    description: 'Inbox · Conversation · Deal Intelligence',
    status: 'ready',
    views: ['thread', 'sms_thread', 'deal_intelligence'],
    widths: { thread: '25', sms_thread: '50', deal_intelligence: '25' },
  },
  {
    key: 'command_center',
    label: 'Command Center',
    description: 'Status · Queue · Inbox · Incidents',
    status: 'backend_not_ready',
    views: ['queue', 'thread'],
    widths: { queue: '50', thread: '50' },
  },
  {
    key: 'comping',
    label: 'Comping',
    description: 'Comps · Map · Offer Stack',
    status: 'ready',
    views: ['comp_intelligence', 'command_map', 'deal_intelligence'],
    widths: { comp_intelligence: '50', command_map: '25', deal_intelligence: '25' },
  },
  {
    key: 'buyer_match_desk',
    label: 'Buyer Match Desk',
    description: 'Buyers · Deal Intelligence · Conversation',
    status: 'ready',
    views: ['buyer_match', 'deal_intelligence', 'sms_thread'],
    widths: { buyer_match: '50', deal_intelligence: '25', sms_thread: '25' },
  },
  {
    key: 'pipeline_flow',
    label: 'Pipeline Flow',
    description: 'Stages · Calendar · Tasks',
    status: 'ready',
    views: ['pipeline', 'calendar'],
    widths: { pipeline: '75', calendar: '25' },
  },
  {
    key: 'queue_control',
    label: 'Queue Control',
    description: 'Scheduled · Failed · Blocked',
    status: 'ready',
    views: ['queue', 'metrics'],
    widths: { queue: '50', metrics: '50' },
  },
  {
    key: 'market_command',
    label: 'Market Command',
    description: 'Map · Markets · Routing',
    status: 'ready',
    views: ['command_map', 'metrics', 'queue'],
    widths: { command_map: '50', metrics: '25', queue: '25' },
  },
  {
    key: 'closing_desk',
    label: 'Closing Desk',
    description: 'Stages 6–10 · contract through close',
    status: 'ready',
    views: ['closing_desk'],
    widths: { closing_desk: '100' },
  },
  {
    key: 'ops_monitor',
    label: 'Ops Monitor',
    description: 'Analytics · Activity · Alerts',
    status: 'backend_not_ready',
    views: ['metrics', 'queue'],
    widths: { metrics: '50', queue: '50' },
  },
]

const WORKSPACE_VIEW_MENU_OPTIONS: Array<{
  key: string
  label: string
  description: string
  status?: 'coming_soon' | 'backend_not_ready'
}> = [
  { key: 'thread', label: 'Inbox', description: 'Seller inbox rail and triage controls.' },
  { key: 'sms_thread', label: 'Conversation', description: 'Focus the active seller thread conversation.' },
  { key: 'deal_intelligence', label: 'Deal Intelligence', description: 'Seller + property intelligence panel.' },
  { key: 'comp_intelligence', label: 'Comp Intelligence', description: 'Comps, ARV, underwriting, and offer structure.' },
  { key: 'buyer_match', label: 'Buyer Match', description: 'Buyer-fit, demand score, and dispo matching.' },
  { key: 'queue', label: 'Queue', description: 'Queue execution and delivery status.' },
  { key: 'pipeline', label: 'Pipeline', description: 'Stage flow and deal movement.' },
  { key: 'calendar', label: 'Calendar', description: 'Follow-up schedule and event timeline.' },
  { key: 'list', label: 'List', description: 'Dense sortable thread command list.' },
  { key: 'entity_graph', label: 'Entity Graph', description: 'Universal entity search, dossier, and relationship selector.' },
  { key: 'command_map', label: 'Map', description: 'Command map for market and routing context.' },
  { key: 'analytics', label: 'Analytics', description: 'Operational KPI and analytics modules.' },
  { key: 'closing_desk', label: 'Closing Desk', description: 'Post-contract lifecycle command center — title, disposition, and close readiness.' },
  { key: 'campaigns', label: 'Campaign Command', description: 'SMS campaign intelligence, targets, and send performance.' },
  { key: 'email', label: 'Email Command', description: 'Brevo email records, inbox, composer, templates, and provider health.' },
  { key: 'workflow_studio', label: 'Workflow Studio', description: 'Workflow definitions, template variants, sender pools, and dry-run previews.' },
]

const MAX_TOGGLED_VIEWS = 4
const DEFAULT_WORKSPACE_VIEWS: InboxWorkspaceView[] = ['thread', 'sms_thread', 'deal_intelligence']
const DEFAULT_WORKSPACE_WIDTHS: Partial<Record<InboxWorkspaceView, ViewWidthPercent>> = {
  thread: '25',
  sms_thread: '50',
  deal_intelligence: '25',
}

const sumWidths = (values: ViewWidthPercent[]) => values.reduce((total, value) => total + Number(value), 0)
const cloneDefaultWorkspaceViews = (): InboxWorkspaceView[] => [...DEFAULT_WORKSPACE_VIEWS]
const cloneDefaultWorkspaceWidths = (): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> => ({ ...DEFAULT_WORKSPACE_WIDTHS })

type InboxRouteMode = 'workspace' | 'fullscreen'

type InboxPageProps = {
  initialWorkspaceView?: InboxWorkspaceView
  routeMode?: InboxRouteMode
}

const resolveRouteEntryView = (
  routeMode: InboxRouteMode,
  initialWorkspaceView?: InboxWorkspaceView,
): InboxWorkspaceView | undefined => {
  if (routeMode !== 'fullscreen') return initialWorkspaceView
  return initialWorkspaceView ?? 'thread'
}

const getInitialWorkspaceViews = (
  initialWorkspaceView?: InboxWorkspaceView,
  routeMode: InboxRouteMode = 'workspace',
): InboxWorkspaceView[] => {
  const entryView = resolveRouteEntryView(routeMode, initialWorkspaceView)
  if (entryView) return [entryView]
  return cloneDefaultWorkspaceViews()
}

const DEFAULT_WORKSPACE_KEY: NexusWorkspaceKey = 'deal_desk'
const WORKSPACE_VIEWS_STORAGE_KEY = 'nx.inbox.workspace-views-by-key'
const DEAL_DESK_LAYOUT_VERSION = 'v3'
const DEAL_DESK_LAYOUT_VERSION_KEY = 'nx.inbox.deal-desk-layout-version'
const isDefaultWorkspaceSet = (views: InboxWorkspaceView[]) =>
  views.length === DEFAULT_WORKSPACE_VIEWS.length &&
  DEFAULT_WORKSPACE_VIEWS.every((view) => views.includes(view))

/** Full (100%) is session-only — never restore a lone view that hides the inbox rail. */
const normalizePersistedWorkspaceViews = (
  workspaceKey: NexusWorkspaceKey,
  views: InboxWorkspaceView[],
): InboxWorkspaceView[] => {
  if (workspaceKey === DEFAULT_WORKSPACE_KEY && views.length === 1) {
    return cloneDefaultWorkspaceViews()
  }
  if (workspaceKey === DEFAULT_WORKSPACE_KEY && isDefaultWorkspaceSet(views)) {
    return cloneDefaultWorkspaceViews()
  }
  return views
}

const loadPersistedWorkspaceViews = (
  initialWorkspaceView?: InboxWorkspaceView,
  routeMode: InboxRouteMode = 'workspace',
): InboxWorkspaceView[] => {
  const entryView = resolveRouteEntryView(routeMode, initialWorkspaceView)
  if (entryView) return [entryView]

  try {
    const workspaceKey = window.localStorage.getItem('nx.inbox.selected-workspace') as NexusWorkspaceKey | null
    const raw = window.localStorage.getItem(WORKSPACE_VIEWS_STORAGE_KEY)
    if (workspaceKey && raw) {
      const parsed = JSON.parse(raw) as Partial<Record<NexusWorkspaceKey, InboxWorkspaceView[]>>
      const saved = parsed[workspaceKey]
      if (Array.isArray(saved) && saved.length > 0) {
        const restored = saved.filter((view) => WORKSPACE_VIEW_OPTIONS.some((opt) => opt.key === view)) as InboxWorkspaceView[]
        if (restored.length > 0) {
          return normalizePersistedWorkspaceViews(workspaceKey, restored)
        }
      }
    }
  } catch {}

  return getInitialWorkspaceViews(initialWorkspaceView, routeMode)
}

const stripDefaultDealDeskWidthOverrides = (
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> =>
  Object.fromEntries(
    Object.entries(overrides).filter(([view, value]) => {
      const workspaceView = view as InboxWorkspaceView
      return DEFAULT_WORKSPACE_WIDTHS[workspaceView] !== value
    }),
  ) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>

const sanitizeWorkspaceWidthOverrides = (
  views: InboxWorkspaceView[],
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> => {
  if (views.length === 0 || views.length === 1) return {}

  const next = Object.fromEntries(
    Object.entries(overrides).filter(([view, value]) => views.includes(view as InboxWorkspaceView) && value),
  ) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>

  if (isDefaultWorkspaceSet(views)) return stripDefaultDealDeskWidthOverrides(next)

  const values = views.map((view) => next[view]).filter(Boolean) as ViewWidthPercent[]
  if (views.length === 2) {
    if (values.length === 1) return next
    return values.length === 2 && sumWidths(values) === 100 ? next : {}
  }
  if (views.length === 3) {
    return next
  }
  if (views.length === 4) {
    return next
  }
  return {}
}

const resolvePresetWidthOverrides = (
  views: InboxWorkspaceView[],
  presetWidths: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> => {
  if (isDefaultWorkspaceSet(views)) return {}
  return sanitizeWorkspaceWidthOverrides(views, { ...presetWidths })
}

const loadPersistedWorkspaceWidthOverrides = (
  views: InboxWorkspaceView[],
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> => {
  try {
    const raw = window.localStorage.getItem('nx.inbox.workspace-width-overrides')
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>
    return sanitizeWorkspaceWidthOverrides(views, parsed)
  } catch {
    return {}
  }
}

const computeWorkspaceFlexBases = (
  views: InboxWorkspaceView[],
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
) => resolveWorkspaceFlexBases(views, overrides, {
  isDefaultSet: isDefaultWorkspaceSet,
  defaultWidths: cloneDefaultWorkspaceWidths(),
})

const computeWorkspaceWidths = (
  views: InboxWorkspaceView[],
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> =>
  resolveWorkspaceWidthLabels(views, overrides, computeWorkspaceFlexBases(views, overrides))

const queueModeFromControl = (diagnostics?: CampaignControlDiagnostics | null): QueueCommandMode => {
  const campaignMode = String(diagnostics?.campaign_mode || '').toLowerCase()
  const processorMode = String(diagnostics?.queue_processor_mode || '').toLowerCase()
  if (campaignMode === 'paused' || processorMode === 'off' || processorMode === 'paused') return 'paused'
  if (campaignMode === 'live_limited' || processorMode === 'live' || processorMode === 'automatic') return 'automatic'
  return 'assisted'
}

export default function InboxPage({ initialWorkspaceView, routeMode = 'workspace' }: InboxPageProps = {}) {
  useEffect(() => {
    markInboxNavigationStart()
  }, [])

  const isRouteFullscreen = routeMode === 'fullscreen'
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messageRefetchKey, setMessageRefetchKey] = useState(0)
  const [messageFetchDegraded, setMessageFetchDegraded] = useState(false)
  const {
    data,
    loading: _dataLoading,
    refresh: refreshInbox,
    loadMore,
    recentlyUpdatedThreadIds,
    sourceMode,
    setSourceMode
  } = useInboxData({ paused: messagesLoading })
  useEffect(() => {
    publishMobileInboxBadge(data.unreadCount ?? 0)
  }, [data.unreadCount])
  const { user, loading: authLoading, signOut } = useAuth()
  const { isMobile } = useBreakpoint()
  const DEV = Boolean(import.meta.env.DEV)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null)
  const [activeContext, setActiveContextState] = useState<ActiveInboxContext>({ sourceView: 'inbox' })
  const [previewContext, setPreviewContext] = useState<ActiveInboxContext | null>(null)
  const effectiveActiveContext = previewContext ?? activeContext
  const [universalEntityContext, setUniversalEntityContext] = useState<UniversalEntityContext>(() => {
    const deepLink = typeof window !== 'undefined' ? parseEntityGraphDeepLink(window.location.pathname) : null
    return deepLink ?? EMPTY_UNIVERSAL_ENTITY_CONTEXT
  })
  const [stageFilter, setStageFilter] = useState<InboxStageSelectValue>('all_stages')
  const [viewFilter, setViewFilter] = useState<InboxViewSelectValue>('all_messages' as any)
  const [savedPreset, setSavedPreset] = useState<InboxSavedFilterPreset>('my_priority')
  const [advancedFilters, setAdvancedFilters] = useState<InboxAdvancedFilters>({ outOfStateOwner: 'all' })
  const [rightViewFilter, setRightViewFilter] = useState<InboxViewSelectValue>('new_replies')
  const [rightSavedPreset, setRightSavedPreset] = useState<InboxSavedFilterPreset>('new_inbounds')
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<NexusWorkspaceKey>(DEFAULT_WORKSPACE_KEY)
  const [selectedWorkspaceViews, setSelectedWorkspaceViews] = useState<InboxWorkspaceView[]>(() =>
    loadPersistedWorkspaceViews(initialWorkspaceView, routeMode),
  )
  const [workspaceWidthOverrides, setWorkspaceWidthOverrides] = useState<Partial<Record<InboxWorkspaceView, ViewWidthPercent>>>(() =>
    loadPersistedWorkspaceWidthOverrides(loadPersistedWorkspaceViews(initialWorkspaceView, routeMode)),
  )
  const workspaceWidthsPersistReadyRef = useRef(false)
  const [tableSort, setTableSort] = useState<ConversationTableSort>('last_activity_desc')
  const [tableDensity, setTableDensity] = useState<TableDensityMode>('compact')
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarListScrollOffset, setSidebarListScrollOffset] = useState(0)
  const [topSearchQuery, setTopSearchQuery] = useState('')
  const [buyerFilters, setBuyerFilters] = useState<BuyerMapFilters>(defaultBuyerMapFilters)
  const [selectedBuyerKey, setSelectedBuyerKey] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [selectedMessages, setSelectedMessages] = useState<ThreadMessage[]>([])
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false)
  const [pendingMessagesByThread, setPendingMessagesByThread] = useState<Record<string, ThreadMessage[]>>({})
  const [visibleThreadCount, setVisibleThreadCount] = useState(1000)
  const [mapSourceMode, setMapSourceMode] = useState<MapSourceMode>(defaultMapSourceMode)
  const [commandMapTheme, setCommandMapTheme] = useState<MapStyleMode>('dark_ops')
  const [commandMapMarket, setCommandMapMarket] = useState('')

  const [threadContext, setThreadContext] = useState<ThreadContext | null>(null)
  const [propertyParticipants, setPropertyParticipants] = useState<PropertyParticipant[]>([])
  const [propertyParticipantsLoading, setPropertyParticipantsLoading] = useState(false)
  const [selectedParticipant, setSelectedParticipant] = useState<PropertyParticipant | null>(null)
  const [masterOwnerHouseholdLabel, setMasterOwnerHouseholdLabel] = useState<string | null>(null)
  const [nextEligibleContact, setNextEligibleContact] = useState<PropertyParticipant | null>(null)
  const [threadIntelligence, setThreadIntelligence] = useState<ThreadIntelligenceRecord | null>(null)
  const [dealContext, setDealContext] = useState<DealContext | null>(null)
  const [queueProcessorHealth, setQueueProcessorHealth] = useState<QueueProcessorHealth | null>(null)
  const [queueProcessorHealthLoading, setQueueProcessorHealthLoading] = useState(false)
  const [activeNexusThemeId, setActiveNexusThemeId] = useState<NexusGlobalThemeId>(() => {
    const initial = resolveDataThemeAttr(loadSettings().nexusTheme)
    return (initial as NexusGlobalThemeId) || 'dark'
  })
  const [activeAccentPalette, setActiveAccentPalette] = useState<AccentPalette>(() => loadSettings().accentPalette)
  const [queueCommandMode, setQueueCommandMode] = useState<QueueCommandMode>('paused')
  const [queueCommandCaps, setQueueCommandCaps] = useState<QueueCommandCaps>(DEFAULT_QUEUE_COMMAND_CAPS)
  const [queueCommandActionLoading, setQueueCommandActionLoading] = useState<string | null>(null)
  const [queueControlDiagnostics, setQueueControlDiagnostics] = useState<CampaignControlDiagnostics | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const heavyLoadPaused = _dataLoading || messagesLoading
  const [threadViewMode, setThreadViewMode] = useState<ThreadTranslateViewMode>('original')
  const [threadTranslations, setThreadTranslations] = useState<Record<string, string>>({})
  const [detectedThreadLanguage, setDetectedThreadLanguage] = useState<string | null>(null)
  const [threadTranslationLoading, setThreadTranslationLoading] = useState(false)
  const [draftTranslationLoading, setDraftTranslationLoading] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [schedulePanelOpen, setSchedulePanelOpen] = useState(false)
  const [scheduledTime, setScheduledTime] = useState<ScheduledTime | null>(null)
  const [scheduledTemplatePayload, setScheduledTemplatePayload] = useState<TemplateActionPayload | null>(null)
  // translate panel is now local to Composer; showTranslation drives nothing
  const [layoutState, setLayoutState] = useState<InboxLayoutState>(() => ({
    ...defaultInboxLayoutState,
    theme: resolveDataThemeAttr(loadSettings().nexusTheme) === 'light' ? 'light' : 'dark',
  }))
  const [dossierFull, setDossierFull] = useState(false)
  const [optimisticPatches, setOptimisticPatches] = useState<Record<string, Partial<InboxWorkflowThread>>>({})


  // Tracks whether the live inbox has resolved at least once — gates heavy background queries.
  const backgroundBootstrapStartedRef = useRef(false)
  const selectedWorkspaceViewsRef = useRef(selectedWorkspaceViews)
  const healthIntervalRef = useRef<number | null>(null)
  const autonomyIntervalRef = useRef<number | null>(null)

  useEffect(() => {
    selectedWorkspaceViewsRef.current = selectedWorkspaceViews
  }, [selectedWorkspaceViews])
  // Stable ref to selected thread — lets message effect depend on key (string) not object reference
  const selectedRef = useRef<InboxWorkflowThread | null>(null)
  const selectedThreadFallbackRef = useRef<InboxWorkflowThread | null>(null)
  const publishingUniversalRef = useRef(false)
  const [isSending, setIsSending] = useState(false)
  const [debugModalOpen, setDebugModalOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileIntelOpen, setMobileIntelOpen] = useState(false)

  const [queueModel, setQueueModel] = useState<QueueModel | null>(null)
  const [templateInventory, setTemplateInventory] = useState<SmsTemplate[]>([])
  const [activityFeed, setActivityFeed] = useState<InboxActivityEvent[]>([])
  const [autonomyControls, setAutonomyControls] = useState<AutonomyControlState>(defaultAutonomyControlState)
  const messageCacheRef = useRef<Record<string, ThreadMessage[]>>({})
  const dealContextCacheRef = useRef<Record<string, DealContext>>({})
  const optimisticMessageMapRef = useRef<Map<string, string>>(new Map()) // clientSendId → optimisticMessage.id
  const inFlightSendMapRef = useRef<Set<string>>(new Set()) // clientSendIds currently in-flight
  const prevThreadsRef = useRef<InboxWorkflowThread[]>([])
  useEffect(() => {

  }, [initialWorkspaceView])

  const rawThreads = useMemo(() => (data.threads ?? []).map(toWorkflowThread), [data.threads])
  const threads = useMemo(
    () => mergeOptimisticPatches(rawThreads, optimisticPatches),
    [rawThreads, optimisticPatches],
  )

  // O(1) lookups — replaces threads.find() in the hot selected-thread path
  const threadById = useMemo(
    () => new Map(threads.map((t) => [t.id, t])),
    [threads],
  )
  const threadByKey = useMemo(
    () => {
      const byKey = new Map<string, InboxWorkflowThread>()
      for (const thread of threads) {
        const conversationId = getConversationThreadIdForThread(thread)
        if (conversationId) byKey.set(conversationId, thread)
        if (thread.threadKey) byKey.set(thread.threadKey, thread)
        if (thread.id) byKey.set(thread.id, thread)
      }
      return byKey
    },
    [threads],
  )

  // Phase 2 trace — log whether the thread array reference is stable across refreshes
  useEffect(() => {
    const stable = threads === prevThreadsRef.current
    if (isInboxDebugEnabled()) {
      console.log('[THREADS_CHANGED]', { stable, length: threads.length })
    }
    prevThreadsRef.current = threads
  }, [threads])

  const mapThreads = useMemo(() => {
    const pins = data.mapPins ?? []
    if (pins.length === 0) return threads
    const pinByKey = new Map(pins.map((pin) => [pin.threadKey || pin.id, pin]))
    const seen = new Set<string>()
    const hydrated = threads.map((thread) => {
      const pin = pinByKey.get(thread.threadKey || thread.id)
      if (!pin) return thread
      seen.add(pin.threadKey || pin.id)
      return {
        ...thread,
        lat: pin.lat,
        lng: pin.lng,
        propertyAddress: thread.propertyAddress || pin.propertyAddress,
        latestMessageBody: thread.latestMessageBody || pin.latestMessageBody,
        streetview_image: (thread as any).streetview_image || null,
        map_image: (thread as any).map_image || null,
        satellite_image: (thread as any).satellite_image || null,
      }
    })

    const synthetic = pins
      .filter((pin) => !seen.has(pin.threadKey || pin.id))
      .map((pin) => ({
        id: pin.threadKey || pin.id,
        threadKey: pin.threadKey || pin.id,
        ownerName: pin.ownerName || 'Unknown Seller',
        subject: pin.propertyAddress || 'Property pin',
        preview: pin.latestMessageBody || 'Map pin',
        propertyAddress: pin.propertyAddress,
        marketId: 'unknown',
        priority: 'normal',
        inboxStatus: 'waiting',
        conversationStage: pin.stage || 'needs_review',
        lat: pin.lat,
        lng: pin.lng,
        lastMessageAt: new Date().toISOString(),
        lastMessageIso: new Date().toISOString(),
        lastMessageBody: pin.latestMessageBody || '',
        isRead: true,
      } as InboxWorkflowThread))
    return [...hydrated, ...synthetic]
  }, [data.mapPins, threads])

  void useMemo(() => getAdvancedFilterOptions(threads), [threads])
  const decisions = useMemo(
    () => new Map(threads.map((thread) => [thread.id, buildConversationDecision(thread)])),
    [threads],
  )

  const viewCounts = useMemo(() => {
    const safeRate = (numerator: number, denominator: number): number | null => {
      if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
      const rate = (numerator / denominator) * 100
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null
      return Math.round(rate)
    }
    const local = getInboxViewCounts(threads)
    const storeCounts = data.counts ?? {}
    const readStoreCount = (key: string): number | undefined => {
      const value = storeCounts[key]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    }
    const hasStoreCount = (key: string): boolean => readStoreCount(key) !== undefined
    const storeHasAnyCounts = Object.keys(storeCounts).some(hasStoreCount)
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const sentToday = threads.filter((thread) => {
      const ts = new Date(thread.lastOutboundAt || 0).getTime()
      return Number.isFinite(ts) && ts >= startOfDay
    }).length
    const repliesToday = threads.filter((thread) => {
      const ts = new Date(thread.lastInboundAt || 0).getTime()
      return Number.isFinite(ts) && ts >= startOfDay
    }).length
    const positiveRepliesToday = threads.filter((thread) => {
      const decision = decisions.get(thread.id)
      const ts = new Date(thread.lastInboundAt || 0).getTime()
      return Number.isFinite(ts) && ts >= startOfDay && (decision?.seller_intent === 'seller_interested' || decision?.seller_intent === 'price_interest')
    }).length
    const optOutsToday = threads.filter((thread) => {
      const decision = decisions.get(thread.id)
      const ts = new Date(thread.lastInboundAt || thread.lastMessageAt || 0).getTime()
      return Number.isFinite(ts) && ts >= startOfDay && decision?.suppression_status === 'suppressed'
    }).length
    const outboundThreadsToday = threads.filter((thread) => {
      const ts = new Date(thread.lastOutboundAt || 0).getTime()
      return Number.isFinite(ts) && ts >= startOfDay
    }).length
    const deliveredThreadsToday = threads.filter((thread) => {
      const ts = new Date(thread.lastOutboundAt || 0).getTime()
      return Number.isFinite(ts) && ts >= startOfDay && String(thread.deliveryStatus || '').toLowerCase() === 'delivered'
    }).length

    // Category tab counts must be global backend counts (pagination-safe).
    // Do NOT fall back to visible-row counts when the server returns 0 —
    // that causes phantom count inflation when counts genuinely drop to zero.
    const sv = (key: string, aliases: string[] = [], fallback?: number): number | undefined => {
      const direct = readStoreCount(key)
      if (direct !== undefined) return direct
      for (const alias of aliases) {
        const aliasValue = readStoreCount(alias)
        if (aliasValue !== undefined) return aliasValue
      }
      if (storeHasAnyCounts) return undefined
      if (threads.length > 0 && fallback !== undefined) return fallback
      return undefined
    }

    const num = (value: number | undefined): number | null => (
      typeof value === 'number' && Number.isFinite(value) ? value : null
    )

    const allCount = num(sv('all', ['all_messages'], data.allInboxCount ?? local.all))
    const newReplies = num(sv('new_replies', ['new_inbound', 'needs_reply'], local.new_replies))
    const priorityCount = num(sv('priority', ['hot_leads'], local.priority ?? local.hot_leads))
    const needsReview = num(sv('needs_review', ['manual_review'], local.needs_review))
    const followUpCount = num(sv('follow_up', ['follow_up_due', 'outbound_active'], local.follow_up ?? local.follow_up_due))
    const suppressed = num(sv('suppressed', ['dnc_opt_out'], local.suppressed))
    const coldNoResp = num(sv('cold', ['cold_no_response'], local.cold ?? local.cold_no_response))
    const deadCount = num(sv('dead', [], local.dead ?? local.wrong_number))
    const automated = num(sv('automated', ['auto_replied'], local.automated))
    const hotLeads = num(sv('hot_leads', [], local.hot_leads))
    const activeCount = num(sv('active', [], local.active))
    const waitingCount = num(sv('waiting', ['waiting_on_seller'], local.waiting ?? local.waiting_on_seller))

    return {
      ...local,
      all_messages: allCount,
      new_replies: newReplies,
      priority: priorityCount,
      negotiating: local.negotiating,
      // canonical bucket keys (sidebar uses these)
      follow_up: followUpCount,
      cold: coldNoResp,
      dead: deadCount,
      suppressed,
      // legacy aliases kept for backwards compat
      follow_up_due: followUpCount,
      waiting_on_seller: waitingCount,
      automated,
      hot_leads: hotLeads,
      needs_review: needsReview,
      cold_no_response: coldNoResp,
      wrong_number: deadCount,
      failed: local.failed,
      all: allCount,
      active: activeCount,
      waiting: waitingCount,
      my_priority: priorityCount,
      new_inbounds: newReplies,
      offer_needed: followUpCount,
      review_required: needsReview,
      active_conversations: activeCount,
      waiting_for_reply: waitingCount,
      all_threads: allCount,
      archived_leads: local.archived,
      wrong_numbers: local.wrong_number,
      sent_today: sentToday,
      replies_today: repliesToday,
      positive_reply_rate: safeRate(positiveRepliesToday, repliesToday),
      opt_out_rate: safeRate(optOutsToday, outboundThreadsToday),
      delivery_rate: safeRate(deliveredThreadsToday, outboundThreadsToday),
      queue_health: local.automated > 0 ? 'Healthy' : 'Watch',
    }
  }, [data.allInboxCount, data.counts, decisions, threads])

  const serverAdvancedPayload = useMemo(
    () => serializeAdvancedFiltersForServer(advancedFilters, { stage: stageFilter, view: viewFilter }),
    [advancedFilters, stageFilter, viewFilter],
  )

  const serverFilterOptions: ApplyInboxFiltersOptions = useMemo(() => ({
    // Rows are already bucket-scoped by useInboxData / inbox/live — do not re-bucket client-side.
    skipViewFilter: true,
    skipStageFilter: false,
    skipAdvancedFilter: hasActiveAdvancedFilters(advancedFilters),
  }), [advancedFilters])

  const resolveThreadsForView = useCallback((view: InboxViewSelectValue) => {
    return applyInboxFilters(threads, {
      search: searchQuery,
      stage: stageFilter,
      view,
      advanced: advancedFilters,
    }, serverFilterOptions)
  }, [advancedFilters, searchQuery, serverFilterOptions, stageFilter, threads])

  const listStatCounts = useMemo(() => [
    { label: 'New Replies', value: viewCounts.new_replies ?? 0 },
    { label: 'Priority', value: viewCounts.priority ?? 0 },
    { label: 'Needs Review', value: viewCounts.needs_review ?? 0 },
    { label: 'Follow-Up Due', value: viewCounts.follow_up ?? 0 },
    { label: 'Auto-Eligible', value: viewCounts.automated ?? 0 },
  ], [viewCounts])

  const filtered = useMemo(() => resolveThreadsForView(viewFilter), [resolveThreadsForView, viewFilter])

  const handleLoadMore = useCallback(async () => {
    await loadMore()
    setVisibleThreadCount(prev => prev + 200)
  }, [loadMore])

  const currentInboxQuery = useMemo(() => ({
    view: viewFilter,
    stage: stageFilter,
    query: searchQuery,
    advanced: serverAdvancedPayload,
  }), [searchQuery, serverAdvancedPayload, stageFilter, viewFilter])

  const activeAdvancedFilterCount = useMemo(
    () => countActiveAdvancedFilters(advancedFilters),
    [advancedFilters],
  )

  const activeAdvancedFilterChips = useMemo(
    () => buildAdvancedFilterChips(advancedFilters, { stage: stageFilter, view: viewFilter }).map((chip) => ({
      key: chip.key,
      label: chip.label,
    })),
    [advancedFilters, stageFilter, viewFilter],
  )

  const selected = useMemo(() => {
    if (selectedId) {
      const byId = threadById.get(selectedId)
      if (byId) return byId
    }
    if (selectedThreadKey) {
      const byKey = threadByKey.get(selectedThreadKey)
      if (byKey) return byKey
    }
    const fallback = selectedThreadFallbackRef.current
    if (fallback) {
      if (selectedId && fallback.id === selectedId) return fallback
      if (selectedThreadKey && (getConversationThreadIdForThread(fallback) || fallback.threadKey || fallback.id) === selectedThreadKey) return fallback
    }
    const hasExternalContext = hasEntityAnchor(effectiveActiveContext)
    if (selectedId || hasExternalContext) return null
    return null
  }, [effectiveActiveContext.masterOwnerId, effectiveActiveContext.opportunityId, effectiveActiveContext.propertyId, effectiveActiveContext.sellerId, effectiveActiveContext.threadKey, filtered, threads, selectedId, selectedThreadKey, threadById, threadByKey])

  // Keep ref in sync so message effect reads latest thread without it being a dep
  selectedRef.current = selected
  // Stable string key — message effect deps on this so it only fires when the thread changes,
  // not on every inbox refresh that produces a new `selected` object reference
  const selectedKeyForEffect = selected ? resolveMessageCacheKeyForThread(selected) : null
  // Snapshots for use in useMemo deps — avoids optional-chaining in dep arrays
  const selectedThreadKeySnapshot = selected ? (getConversationThreadIdForThread(selected) || selected.threadKey || null) : null
  const selectedIdSnapshot = selected?.id ?? null

  const canonicalSelectedContext = useMemo(
    () => resolveCanonicalWorkspaceContext({
      selected,
      dealContext,
      activeContext: effectiveActiveContext,
    }),
    [selected, dealContext, effectiveActiveContext],
  )

  const workspaceThread = useMemo(
    () => selected ?? threadStubFromActiveContext(effectiveActiveContext, canonicalSelectedContext),
    [selected, effectiveActiveContext, canonicalSelectedContext],
  )

  const inboxHighlightId = useMemo(
    () => resolveInboxHighlightId(threads, selected, effectiveActiveContext),
    [threads, selected, effectiveActiveContext],
  )

  useEffect(() => {
    if (!selected) return
    const selectedConversationId = getConversationThreadIdForThread(selected) || selected.threadKey || selected.id
    const inLoadedThreads = threads.some((thread) => (
      thread.id === selected.id ||
      (getConversationThreadIdForThread(thread) || thread.threadKey || thread.id) === selectedConversationId
    ))
    if (inLoadedThreads) {
      selectedThreadFallbackRef.current = selected
    }
  }, [selected, threads])
  const buyerDataEnabled = selectedWorkspaceViews.includes('buyer_match') || selectedWorkspaceViews.includes('command_map')
  const buyerCommandData = useBuyerCommandData(workspaceThread, buyerFilters, { enabled: buyerDataEnabled })

  useEffect(() => {
    if (selectedBuyerKey && buyerCommandData.matches.some((match) => match.buyerKey === selectedBuyerKey)) return
    if (selectedBuyerKey && buyerCommandData.profilePoints.some((profile) => profile.buyerKey === selectedBuyerKey)) return
    if (selectedBuyerKey && buyerCommandData.recentPurchases.some((purchase) => purchase.buyerKey === selectedBuyerKey)) return
    setSelectedBuyerKey(
      buyerCommandData.matches[0]?.buyerKey
      || buyerCommandData.profilePoints[0]?.buyerKey
      || buyerCommandData.recentPurchases[0]?.buyerKey
      || null,
    )
  }, [buyerCommandData.matches, buyerCommandData.profilePoints, buyerCommandData.recentPurchases, selectedBuyerKey])

  const _selectedFilteredOut = useMemo(() => (
    Boolean(selected && !filtered.some((thread) => thread.id === selected.id))
  ), [filtered, selected])
  void _selectedFilteredOut
  const _showSelectedInFilter = useCallback(() => {
    if (!selected) return
    const decision = decisions.get(selected.id)
    let nextView: InboxViewSelectValue = 'all_conversations'
    setSearchQuery('')
    setAdvancedFilters({ outOfStateOwner: 'all' })
    setStageFilter('all_stages')
    if (decision?.inbox_bucket === 'new_replies') nextView = 'new_replies'
    else if (decision?.inbox_bucket === 'priority') nextView = 'priority'
    else if (decision?.inbox_bucket === 'needs_review') nextView = 'needs_review'
    else if (decision?.inbox_bucket === 'follow_up' || decision?.inbox_bucket === 'follow_up_due') nextView = 'follow_up'
    else if (decision?.inbox_bucket === 'cold' || decision?.inbox_bucket === 'cold_no_response') nextView = 'cold'
    else if (decision?.inbox_bucket === 'dead') nextView = 'dead'
    else if (decision?.inbox_bucket === 'suppressed' || decision?.inbox_bucket === 'dnc_suppressed') nextView = 'suppressed'
    else if (decision?.inbox_bucket === 'negotiating') nextView = 'negotiating'
    else if (decision?.inbox_bucket === 'waiting_on_seller') nextView = 'waiting_on_seller'
    else if (decision?.inbox_bucket === 'automated') nextView = 'automated'
    setViewFilter(nextView)
    void refreshInbox({
      filters: {
        view: nextView,
        stage: 'all_stages',
        query: '',
        advanced: { outOfStateOwner: 'all' },
      },
      cursor: null,
      limit: 100,
    })
  }, [decisions, refreshInbox, selected])
  void _showSelectedInFilter

  useEffect(() => {
    if (!selected) return
    const conversationThreadId = getConversationThreadIdForThread(selected) || selected.threadKey || selected.id
    if (selected.id !== selectedId) setSelectedId(selected.id)
    if (conversationThreadId !== selectedThreadKey) {
      setSelectedThreadKey(conversationThreadId)
    }
  }, [selected, selectedId, selectedThreadKey])

  useEffect(() => {
    if (!effectiveActiveContext.threadKey && !effectiveActiveContext.propertyId && !effectiveActiveContext.sellerId && !effectiveActiveContext.masterOwnerId) return
    if (selected && activeContextMatchesThread(effectiveActiveContext, selected)) return

    const match = findThreadForActiveContext(threads, effectiveActiveContext)
    if (!match) {
      if (effectiveActiveContext.threadKey) {
        setSelectedThreadKey(effectiveActiveContext.threadKey)
      }
      return
    }
    setSelectedId(match.id)
    setSelectedThreadKey(match.threadKey || match.id)
    setLayoutState((current) => ({ ...current, selectedThreadId: match.id }))
  }, [effectiveActiveContext, selected, threads])

  // After bucket/category switch, surface the first lead once the list is stable.
  // Brief deferral keeps user-initiated row clicks ahead of boot dossier fetches.
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as Window & { __INBOX_PROOF_DISABLE_AUTO_SELECT__?: boolean }).__INBOX_PROOF_DISABLE_AUTO_SELECT__) {
      return
    }
    if (filtered.length === 0) return
    const selectedInBucket = selectedId
      ? filtered.some((thread) => thread.id === selectedId || (thread.threadKey || thread.id) === selectedThreadKey)
      : false
    if (selectedInBucket) return
    const first = filtered[0]
    if (!first) return
    const timer = setTimeout(() => {
      const active = selectedRef.current
      const activeKey = active?.id || selectedThreadKey
      const stillSelectedInBucket = activeKey
        ? filtered.some((thread) => thread.id === activeKey || (thread.threadKey || thread.id) === activeKey)
        : false
      if (stillSelectedInBucket) return
      setSelectedId(first.id)
      setSelectedThreadKey(getConversationThreadIdForThread(first) || first.threadKey || first.id)
      setLayoutState((current) => ({ ...current, selectedThreadId: first.id }))
    }, 400)
    return () => clearTimeout(timer)
  }, [filtered, selectedId, selectedThreadKey, viewFilter])

  const selectedSuppressed = useMemo(() => (selected ? isSuppressedThread(selected) : false), [selected])

  const adaptiveSuggestions = useMemo(() => {
    if (!selected) return []
    return buildAdaptiveSuggestions(selected, selectedSuppressed) as any[]
  }, [selected, selectedSuppressed])

  const selectedPendingMessages = useMemo(() => {
    if (!selected) return []
    return pendingMessagesByThread[selected.id] ?? []
  }, [pendingMessagesByThread, selected])

  const displayedMessages = useMemo(() => {
    const events = selectedMessages.filter(m => m.direction === 'outbound')
    const pending = selectedPendingMessages

    const filteredPending = pending.filter(p => {
      const match = events.some(e => {
        const pMeta = p.developerMeta || {}
        const eMeta = e.metadata || {}
        
        // 1. metadata.client_send_id
        if (pMeta.client_send_id && pMeta.client_send_id === eMeta.client_send_id) return true
        
        // 2. queue_id match (via event metadata)
        if (pMeta.queue_id && pMeta.queue_id === eMeta.queue_id) return true

        // 3. Provider ID match
        if (p.id && p.id === e.id) return true
        
        // 4. Temporal/Body match (within 180 seconds)
        const pTs = new Date(p.createdAt).getTime()
        const eTs = new Date(e.createdAt).getTime()
        if (Math.abs(pTs - eTs) < 180000 && p.body.trim() === e.body.trim()) return true
        
        return false
      })

      if (match) {
        console.debug('[InboxLifecycle] queue row hidden because matching event exists', { body: p.body })
        return false
      }
      
      console.debug('[InboxLifecycle] queue row rendered as pending because no event exists', { body: p.body })
      return true
    })

    // 6. Dedupe failed rows (same from/to/body within 5 min)
    const uniquePending: ThreadMessage[] = []
    const pendingSeen = new Set<string>()
    filteredPending.forEach(p => {
      const key = `${p.fromNumber}:${p.toNumber}:${p.body.trim()}:${Math.floor(new Date(p.createdAt).getTime() / 300000)}`
      if (!pendingSeen.has(key)) {
        pendingSeen.add(key)
        uniquePending.push(p)
      } else {
        console.debug('[InboxLifecycle] failed queue deduped', { body: p.body })
      }
    })

    return dedupeMessages([...selectedMessages, ...uniquePending])
  }, [selectedMessages, selectedPendingMessages])

  const commandIntel = useMemo(
    () => buildThreadCommandIntel(selected, displayedMessages, threadContext, threadIntelligence),
    [displayedMessages, selected, threadContext, threadIntelligence],
  )

  const liveCommandFeed = useMemo<ThreadCommandIntel[]>(() => {
    const selectedKey = selectedThreadKeySnapshot || selectedIdSnapshot
    return threads
      .slice(0, 8)
      .map((thread) =>
        buildThreadCommandIntel(
          thread,
          (thread.threadKey || thread.id) === selectedKey ? displayedMessages : [],
          (thread.threadKey || thread.id) === selectedKey ? threadContext : null,
          (thread.threadKey || thread.id) === selectedKey ? threadIntelligence : null,
        ),
      )
      .filter((item): item is ThreadCommandIntel => Boolean(item))
  }, [displayedMessages, selectedIdSnapshot, selectedThreadKeySnapshot, threadContext, threadIntelligence, threads])

  const activeWorkspaceView = selectedWorkspaceViews[0] ?? DEFAULT_WORKSPACE_VIEWS[0]
  const selectedWorkspacePreset = useMemo(
    () => NEXUS_WORKSPACE_PRESETS.find((workspace) => workspace.key === selectedWorkspaceKey) ?? NEXUS_WORKSPACE_PRESETS[0],
    [selectedWorkspaceKey],
  )
  const workspaceFlexBases = useMemo(
    () => computeWorkspaceFlexBases(selectedWorkspaceViews, workspaceWidthOverrides),
    [selectedWorkspaceViews, workspaceWidthOverrides],
  )
  const workspaceWidths = useMemo(
    () => computeWorkspaceWidths(selectedWorkspaceViews, workspaceWidthOverrides),
    [selectedWorkspaceViews, workspaceWidthOverrides],
  )
  const activeWorkspaceLabel = selectedWorkspacePreset.label
  const activeContextSubtitle = selectedWorkspacePreset.description

  const handleNavigateInboxView = useCallback((view: string) => {
    const viewMap: Record<string, InboxViewSelectValue> = {
      needs_review: 'needs_review',
      follow_up: 'follow_up_due',
      failed: 'failed',
    }
    const nextView = viewMap[view] ?? (view as InboxViewSelectValue)
    setViewFilter(nextView)
    if (!selectedWorkspaceViews.includes('thread')) {
      setSelectedWorkspaceViews((current) => (['thread', ...current] as InboxWorkspaceView[]).slice(0, MAX_TOGGLED_VIEWS))
    }
    pushRoutePath('/inbox')
  }, [selectedWorkspaceViews])

  const viewLabelByKey = useMemo(
    () => new Map(WORKSPACE_VIEW_OPTIONS.map((view) => [view.key, view.label.replace(' View', '')])),
    [],
  )
  const activeViewChips = useMemo(
    () => selectedWorkspaceViews.map((view) => ({ key: view, label: viewLabelByKey.get(view) ?? view })),
    [selectedWorkspaceViews, viewLabelByKey],
  )
  const activeViewMenuKeys = useMemo(
    () => selectedWorkspaceViews.map((view) => view === 'metrics' ? 'analytics' : view),
    [selectedWorkspaceViews],
  )
  const topSearchContext = useMemo(() => ({
    routePath: '/inbox',
    currentView: activeWorkspaceView,
    selectedMarket: commandMapMarket || advancedFilters.market || selected?.market || null,
    activeMapTheme: commandMapTheme,
    activeFilters: {
      market: advancedFilters.market || commandMapMarket || '',
      sourceMode,
      stageFilter,
      viewFilter,
    },
  }), [activeWorkspaceView, advancedFilters.market, commandMapMarket, commandMapTheme, selected?.market, sourceMode, stageFilter, viewFilter])
  const {
    loading: topSearchLoading,
    groupedResults: topSearchGroups,
  } = useInboxTopSearch(topSearchQuery, topSearchContext)

  const autonomyModel = useMemo(
    () => buildAutonomousEngineModel({
      threads,
      threadIntel: liveCommandFeed,
      queueModel,
      templates: templateInventory,
      activities: activityFeed,
      controls: autonomyControls,
    }),
    [activityFeed, autonomyControls, liveCommandFeed, queueModel, templateInventory, threads],
  )

  const sellerLanguageCode = useMemo(() => {
    if (!selected && !threadIntelligence) return null

    const selectedRecord = (selected ?? {}) as unknown as Record<string, unknown>
    const intelligenceRecord = (threadIntelligence ?? {}) as Record<string, unknown>

    const candidates: unknown[] = [
      selectedRecord.sellerLanguage,
      selectedRecord.seller_language,
      selectedRecord.detectedLanguage,
      selectedRecord.detected_language,
      intelligenceRecord.seller_language,
      intelligenceRecord.detected_language,
      intelligenceRecord.language_code,
      intelligenceRecord.language,
      intelligenceRecord.preferred_language,
      detectedThreadLanguage,
    ]

    for (const candidate of candidates) {
      const normalized = normalizeLanguageCode(candidate)
      if (normalized) return normalized
    }
    return null
  }, [detectedThreadLanguage, selected, threadIntelligence])

  const sellerLanguageLabel = useMemo(
    () => languageLabelFor(sellerLanguageCode),
    [sellerLanguageCode],
  )

  const threadHasInboundMessages = useMemo(
    () => selectedMessages.some((message) => message.direction === 'inbound' && message.body.trim().length > 0),
    [selectedMessages],
  )

  const displayedMessagesWithTranslation = useMemo(() => {
    if (threadViewMode !== 'translated') return displayedMessages
    return displayedMessages.map((message: ThreadMessage) => {
      if (message.direction !== 'inbound') return message
      const translated = threadTranslations[message.id]
      if (!translated || translated === message.body) return message
      return {
        ...message,
        body: translated,
      }
    })
  }, [displayedMessages, threadTranslations, threadViewMode])

  const applySavedPreset = useCallback((preset: InboxSavedFilterPreset) => {
    console.log('[BUCKET_CLICK]', preset)
    if (DEV) {
      console.log(`[NexusInboxActionNoRefresh]`, {
        action: `apply_preset_${preset}`,
        optimistic: true,
        preventedDefault: true,
        stoppedPropagation: true
      })
    }
    setSavedPreset(preset)
    const config = getSavedPresetConfig(preset)
    const isPrimaryCategoryTab = (
      preset === 'all_messages'
      || preset === 'my_priority'
      || preset === 'new_inbounds'
      || preset === 'review_required'
      || preset === 'waiting'
    )
    const nextView = (config.view ?? viewFilter)
    const nextStage = isPrimaryCategoryTab ? 'all_stages' : (config.stage ?? stageFilter)
    const nextSearch = searchQuery
    const nextAdvanced = config.advanced
      ? { ...advancedFilters, ...config.advanced }
      : advancedFilters

    if (isPrimaryCategoryTab) {
      setStageFilter('all_stages')
    } else {
      if (config.stage) setStageFilter(config.stage)
      if (config.advanced) setAdvancedFilters((current) => ({ ...current, ...config.advanced }))
    }
    if (config.view) {
      console.log('[BUCKET_STATE_SET]', config.view)
      setViewFilter(config.view)
    }

    // Clear selection so stale thread from the previous bucket is never shown in the new bucket.
    setSelectedId(null)
    setSelectedThreadKey(null)
    selectedThreadFallbackRef.current = null

    // Load category-specific rows from backend so paginated local state reflects the selected tab.
    void refreshInbox({
      filters: {
        view: nextView,
        stage: nextStage,
        query: nextSearch,
        advanced: serializeAdvancedFiltersForServer(nextAdvanced, { stage: nextStage, view: nextView }),
      },
      cursor: null,
      limit: 30,
      _force: true,
      _timeoutMode: 'manual_bucket_switch',
      _refreshReason: 'manual_bucket_switch',
    })
  }, [DEV, advancedFilters, refreshInbox, searchQuery, stageFilter, viewFilter])

  const applyRightSavedPreset = useCallback((preset: InboxSavedFilterPreset) => {
    if (DEV) {
      console.log(`[NexusInboxActionNoRefresh]`, {
        action: `apply_right_preset_${preset}`,
        optimistic: true,
        preventedDefault: true,
        stoppedPropagation: true
      })
    }
    setRightSavedPreset(preset)
    const config = getSavedPresetConfig(preset)
    if (config.view) setRightViewFilter(config.view)
  }, [DEV])

  const setActiveOverlay = useCallback((activeOverlay: ActiveOverlay) => {
    setLayoutState((current) => ({ ...current, activeOverlay }))
  }, [])

  const announceLayout = useCallback((message: string) => {
    emitNotification({ title: message, detail: 'NEXUS layout updated', severity: 'success' })
  }, [])

  const handleResetFilters = useCallback(() => {
    const cleared = clearAllAdvancedFilters()
    setSearchQuery('')
    setStageFilter('all_stages')
    setViewFilter('all_conversations')
    setAdvancedFilters(cleared)
    setSavedPreset('all_messages')
    setSelectedId(null)
    setSelectedThreadKey(null)
    selectedThreadFallbackRef.current = null
    void refreshInbox({
      filters: {
        view: 'all_conversations',
        stage: 'all_stages',
        query: '',
        advanced: serializeAdvancedFiltersForServer(cleared),
      },
      cursor: null,
      limit: 100,
      _force: true,
      _refreshReason: 'clear_all_filters',
    })
  }, [refreshInbox])

  const handleApplyAdvancedFilters = useCallback((payload: {
    view: InboxViewSelectValue
    stage: InboxStageSelectValue
    advanced: InboxAdvancedFilters
  }) => {
    setViewFilter(payload.view)
    setStageFilter(payload.stage)
    setAdvancedFilters(payload.advanced)
    void refreshInbox({
      filters: {
        view: payload.view,
        stage: payload.stage,
        query: searchQuery,
        advanced: serializeAdvancedFiltersForServer(payload.advanced, { stage: payload.stage, view: payload.view }),
      },
      cursor: null,
      limit: 100,
      _force: true,
      _refreshReason: 'advanced_filters_apply',
    })
  }, [refreshInbox, searchQuery])

  const handleRemoveAdvancedFilterChip = useCallback((chipKey: string) => {
    const chip = buildAdvancedFilterChips(advancedFilters, { stage: stageFilter, view: viewFilter })
      .find((entry) => entry.key === chipKey)
    if (!chip) return
    const nextAdvanced = chip.clear(advancedFilters)
    setAdvancedFilters(nextAdvanced)
    void refreshInbox({
      filters: {
        view: viewFilter,
        stage: stageFilter,
        query: searchQuery,
        advanced: serializeAdvancedFiltersForServer(nextAdvanced, { stage: stageFilter, view: viewFilter }),
      },
      cursor: null,
      limit: 100,
      _force: true,
      _refreshReason: 'advanced_filter_chip_remove',
    })
  }, [advancedFilters, refreshInbox, searchQuery, stageFilter, viewFilter])

  const handleRetryInboxLoad = useCallback(() => {
    void refreshInbox({
      filters: currentInboxQuery,
      cursor: null,
      limit: 100,
    })
  }, [currentInboxQuery, refreshInbox])

  const handleFocusWorkspaceView = useCallback((view: InboxWorkspaceView) => {
    setSelectedWorkspaceViews((current) => {
      if (current[0] === view) return current
      let nextViews: InboxWorkspaceView[]
      if (!current.includes(view)) {
        if (current.length >= MAX_TOGGLED_VIEWS) {
          nextViews = [view, ...current.slice(0, MAX_TOGGLED_VIEWS - 1)]
        } else {
          nextViews = [view, ...current]
        }
      } else {
        nextViews = [view, ...current.filter((item) => item !== view)]
      }
      setWorkspaceWidthOverrides((existing) => sanitizeWorkspaceWidthOverrides(nextViews, existing))
      return nextViews
    })
  }, [])

  const focusWorkspaceView = useCallback((view: InboxWorkspaceView) => {
    handleFocusWorkspaceView(view)
  }, [handleFocusWorkspaceView])

  const handleSelectWorkspace = useCallback((workspaceKey: string) => {
    const preset = NEXUS_WORKSPACE_PRESETS.find((workspace) => workspace.key === workspaceKey)
    if (!preset) return
    let views = [...preset.views]
    try {
      const raw = window.localStorage.getItem(WORKSPACE_VIEWS_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<NexusWorkspaceKey, InboxWorkspaceView[]>>
        const saved = parsed[workspaceKey as NexusWorkspaceKey]
        if (Array.isArray(saved) && saved.length > 0) {
          const restored = saved.filter((view) => WORKSPACE_VIEW_OPTIONS.some((opt) => opt.key === view)) as InboxWorkspaceView[]
          if (restored.length > 0) views = normalizePersistedWorkspaceViews(preset.key, restored)
        }
      }
    } catch {}
    setSelectedWorkspaceKey(preset.key)
    setSelectedWorkspaceViews(views)
    setWorkspaceWidthOverrides(resolvePresetWidthOverrides(views, preset.widths))
  }, [])

  const persistWorkspaceViewOverride = useCallback((workspaceKey: NexusWorkspaceKey, views: InboxWorkspaceView[]) => {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_VIEWS_STORAGE_KEY)
      const existing = raw ? JSON.parse(raw) as Partial<Record<NexusWorkspaceKey, InboxWorkspaceView[]>> : {}
      existing[workspaceKey] = views
      window.localStorage.setItem(WORKSPACE_VIEWS_STORAGE_KEY, JSON.stringify(existing))
    } catch {}
  }, [])

  const clearWorkspaceViewOverride = useCallback((workspaceKey: NexusWorkspaceKey) => {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_VIEWS_STORAGE_KEY)
      if (!raw) return
      const existing = JSON.parse(raw) as Partial<Record<NexusWorkspaceKey, InboxWorkspaceView[]>>
      delete existing[workspaceKey]
      window.localStorage.setItem(WORKSPACE_VIEWS_STORAGE_KEY, JSON.stringify(existing))
    } catch {}
  }, [])

  const handleSelectWorkspaceView = useCallback((viewKey: string) => {
    const viewMenuOption = WORKSPACE_VIEW_MENU_OPTIONS.find((option) => option.key === viewKey)
    if (viewMenuOption?.status) {
      emitNotification({
        title: viewMenuOption.status === 'backend_not_ready' ? 'Backend Not Ready' : 'Coming Soon',
        detail: `${viewMenuOption.label} is visible but not fully implemented yet.`,
        severity: 'warning',
      })
      return
    }
    if (viewKey === 'analytics') {
      const mappedView: InboxWorkspaceView = 'metrics'
      setSelectedWorkspaceViews((current) => {
        if (current.includes(mappedView)) {
          if (current.length <= 1) {
            emitNotification({
              title: 'View Required',
              detail: 'At least one view must stay active.',
              severity: 'warning',
            })
            return current
          }
          const nextViews = current.filter((view) => view !== mappedView)
          setWorkspaceWidthOverrides((existing) => sanitizeWorkspaceWidthOverrides(nextViews, existing))
          return nextViews
        }
        const nextViews = [mappedView, ...current.filter((view) => view !== mappedView)].slice(0, MAX_TOGGLED_VIEWS)
        setWorkspaceWidthOverrides((existing) => sanitizeWorkspaceWidthOverrides(nextViews, existing))
        return nextViews
      })
      return
    }
    const asWorkspaceView = viewKey as InboxWorkspaceView
    if (!WORKSPACE_VIEW_OPTIONS.some((option) => option.key === asWorkspaceView)) return
    setSelectedWorkspaceViews((current) => {
      if (current.includes(asWorkspaceView)) {
        if (current.length <= 1) {
          emitNotification({
            title: 'View Required',
            detail: 'At least one view must stay active.',
            severity: 'warning',
          })
          return current
        }
        const nextViews = current.filter((view) => view !== asWorkspaceView)
        setWorkspaceWidthOverrides((existing) => sanitizeWorkspaceWidthOverrides(nextViews, existing))
        return nextViews
      }
      const nextViews = [asWorkspaceView, ...current.filter((view) => view !== asWorkspaceView)].slice(0, MAX_TOGGLED_VIEWS)
      setWorkspaceWidthOverrides((existing) => sanitizeWorkspaceWidthOverrides(nextViews, existing))
      return nextViews
    })
  }, [emitNotification])

  const handleSelectWorkspaceViewWidth = useCallback((viewKey: string, width: ViewWidthPercent) => {
    const normalizedViewKey = viewKey === 'analytics'
        ? 'metrics'
        : viewKey

    const view = normalizedViewKey as InboxWorkspaceView
    if (!WORKSPACE_VIEW_OPTIONS.some((option) => option.key === view)) return

    if (width === '100') {
      setSelectedWorkspaceViews([view])
      setWorkspaceWidthOverrides({})
      return
    }

    setSelectedWorkspaceViews((current) => {
      let nextViews = current.includes(view)
        ? [view, ...current.filter((item) => item !== view)]
        : [view, ...current.slice(0, MAX_TOGGLED_VIEWS - 1)]

      if (nextViews.length === 1) {
        const fallback = view === 'deal_intelligence' ? 'thread' : 'deal_intelligence'
        nextViews = [view, fallback]
      }

      setWorkspaceWidthOverrides(() =>
        sanitizeWorkspaceWidthOverrides(nextViews, { [view]: width }),
      )
      return nextViews
    })
  }, [persistWorkspaceViewOverride, selectedWorkspaceKey])

  const handleToggleActiveViewChip = useCallback((viewKey: string) => {
    setSelectedWorkspaceViews((current) => {
      if (!current.includes(viewKey as InboxWorkspaceView)) return current
      if (current.length <= 1) {
        emitNotification({
          title: 'View Required',
          detail: 'At least one view must stay active.',
          severity: 'warning',
        })
        return current
      }
      const nextViews = current.filter((view) => view !== viewKey)
      setWorkspaceWidthOverrides((existing) => sanitizeWorkspaceWidthOverrides(nextViews, existing))
      return nextViews
    })
  }, [])

  const openGlobalCommand = useCallback((initialQuery = '') => {
    window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_OPEN_EVENT, { detail: { initialQuery } }))
  }, [])

  const handleExecuteTopSearchResult = useCallback((result: CommandResult) => {
    if (result.route && result.route !== window.location.pathname) {
      pushRoutePath(result.route)
    }

    if (result.location) {
      saveRecentCommandLocation(result.location)
    }

    const eventName = result.action?.eventName || GLOBAL_COMMAND_ACTION_EVENT
    if (result.payload || result.action?.eventName) {
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: {
          ...result.payload,
          route: result.route,
          resultId: result.id,
          resultType: result.type,
        },
      }))
    }

    setTopSearchQuery('')
  }, [])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(GLOBAL_COMMAND_CONTEXT_EVENT, {
      detail: {
        routePath: '/inbox',
        currentView: activeWorkspaceView,
        selectedMarket: commandMapMarket || advancedFilters.market || selected?.market || null,
        activeMapTheme: commandMapTheme,
        activeFilters: {
          searchQuery,
          stageFilter,
          viewFilter,
          sourceMode,
          market: advancedFilters.market || commandMapMarket || '',
        },
      },
    }))
  }, [activeWorkspaceView, advancedFilters.market, commandMapMarket, commandMapTheme, searchQuery, selected?.market, sourceMode, stageFilter, viewFilter])

  const setActiveContext = useCallback((nextContext: ActiveInboxContext, options?: SetActiveContextOptions) => {
    setActiveContextState((current) => {
      const merged = { ...current, ...nextContext }
      if (nextContext.sourceView === 'inbox' && nextContext.opportunityId === undefined) {
        delete merged.opportunityId
      }
      const match = findThreadForActiveContext(threads, merged)
      if (match) {
        setSelectedId(match.id)
        setSelectedThreadKey(match.threadKey || match.id)
        setLayoutState((layout) => ({ ...layout, selectedThreadId: match.id }))
        selectedThreadFallbackRef.current = match
      } else if (nextContext.threadKey) {
        setSelectedThreadKey(nextContext.threadKey)
      }
      return merged
    })
    setPreviewContext(null)
    setUniversalEntityContext((current) => {
      const merged = mergeUniversalContexts(current, {
        entityType: nextContext.entityType ?? (nextContext.propertyId ? 'property' : nextContext.prospectId ? 'prospect' : nextContext.masterOwnerId || nextContext.sellerId ? 'master_owner' : current.entityType),
        entityId: nextContext.entityId ?? nextContext.propertyId ?? nextContext.prospectId ?? nextContext.masterOwnerId ?? nextContext.sellerId ?? current.entityId,
        propertyId: nextContext.propertyId ?? current.propertyId,
        masterOwnerId: nextContext.masterOwnerId ?? nextContext.sellerId ?? current.masterOwnerId,
        prospectId: nextContext.prospectId ?? current.prospectId,
        threadKey: nextContext.threadKey ?? current.threadKey,
        contactMethodType: nextContext.contactMethodType ?? current.contactMethodType,
        contactMethodId: nextContext.contactMethodId ?? current.contactMethodId,
        opportunityId: nextContext.sourceView === 'inbox' && nextContext.opportunityId === undefined
          ? null
          : (nextContext.opportunityId ?? current.opportunityId),
      })
      publishingUniversalRef.current = true
      setUniversalEntityContextSnapshot(merged)
      return merged
    })

    const focusTarget = options?.focusView
      || (options?.openThread ? 'sms_thread' : undefined)
      || (nextContext.intent === 'open_queue' ? 'queue' : undefined)
      || (nextContext.intent === 'open_calendar' ? 'calendar' : undefined)
      || (nextContext.intent === 'focus_map' ? 'command_map' : undefined)

    if (focusTarget) {
      if (options?.preserveCurrentViews === false) {
        setSelectedWorkspaceViews([focusTarget])
      } else {
        focusWorkspaceView(focusTarget)
      }
    }

    if (options?.openThread) {
      focusWorkspaceView('sms_thread')
    }
  }, [focusWorkspaceView, threads])

  const handleOpenDealIntelligence = useCallback((threadId?: string | null) => {
    if (threadId) {
      setSelectedId(threadId)
      const match = threads.find((thread) => thread.id === threadId || (thread.threadKey || thread.id) === threadId)
      if (match) {
        setSelectedThreadKey(match.threadKey || match.id)
      }
    }
    setWorkspaceWidthOverrides({})
    setSelectedWorkspaceViews(['deal_intelligence'])
  }, [threads])

  const handleOpenSellerAutomation = useCallback((threadId?: string | null) => {
    const match = threadId
      ? threads.find((thread) => thread.id === threadId || (thread.threadKey || thread.id) === threadId)
      : selectedRef.current
    const thread = match || selectedRef.current
    if (!thread) return
    openSellerAutomationStudioFromEntity({
      propertyId: thread.propertyId || canonicalSelectedContext?.identity?.property_id || null,
      prospectId: thread.prospectId || canonicalSelectedContext?.identity?.prospect_id || null,
      masterOwnerId: thread.ownerId || canonicalSelectedContext?.identity?.master_owner_id || null,
      threadKey: thread.threadKey || thread.id,
      preservePath: true,
    })
    setWorkspaceWidthOverrides({})
    setSelectedWorkspaceViews(['workflow_studio'])
  }, [canonicalSelectedContext, threads])

  useEffect(() => {
    setLayoutState((current) => {
      const next = { ...current }
      next.mapMode = 'off'
      next.inboxMode = 'default'
      next.leftPanelMode = 'default'
      next.rightPanelMode = 'default'
      return next
    })
  }, [selectedWorkspaceViews])

  const prevSelectedIdRef = useRef<string | null>(null)
  const selectNonceRef = useRef(0)
  const pendingUncachedSelectRef = useRef<{ cacheKey: string; nonce: number } | null>(null)

  // This effect fires ONLY when the thread key (string) changes — NOT on every inbox refresh.
  // selectedRef.current always has the latest thread object without being in the dep array.
  // Messages are fetched and committed IMMEDIATELY, independent of context/intelligence.
  useEffect(() => {
    const thread = selectedRef.current
    if (!thread || !selectedKeyForEffect) {
      setSelectedMessages([])
      setHasOlderMessages(false)
      setOlderMessagesLoading(false)
      setThreadContext(null)
      setThreadIntelligence(null)
      if (!hasEntityAnchor(effectiveActiveContext)) {
        setDealContext(null)
      }
      setThreadTranslations({})
      setThreadViewMode('original')
      setDetectedThreadLanguage(null)
      prevSelectedIdRef.current = null
      return
    }

    const plan = planThreadSelect({
      thread,
      selectedKey: selectedKeyForEffect,
      conversationThreadId: getConversationThreadIdForThread(thread),
      messageRefetchKey,
      messageCache: messageCacheRef.current,
      dealContextFallback: normalizeDealContext(thread as unknown as Record<string, unknown>),
      threadContextSeed: buildThreadContextFromThread(thread),
      intelligenceSeed: (thread ?? null) as unknown as ThreadIntelligenceRecord,
    })
    if (!plan) return

    if (plan.clearMessageCache) delete messageCacheRef.current[plan.cacheKey]
    const cachedMessages = [...plan.immediate.cachedMessages]
    const cacheKey = plan.cacheKey
    prevSelectedIdRef.current = thread.id
    const selectStarted = performance.now()

    setThreadTranslations({})
    setThreadViewMode('original')
    setDetectedThreadLanguage(null)
    setDealContext(plan.immediate.dealContextFallback)
    setSelectedMessages(plan.immediate.selectedMessages)
    setMessagesLoading(plan.immediate.messagesLoading)
    setHasOlderMessages(false)
    setOlderMessagesLoading(false)
    setContextLoading(plan.immediate.contextLoading)
    setThreadContext(plan.immediate.threadContextSeed)
    setThreadIntelligence(plan.immediate.intelligenceSeed)

    if (DEV) console.log('[SMOOTH_THREAD_SELECT]', { key: selectedKeyForEffect, refetch: messageRefetchKey > 0, cacheHit: plan.telemetry.cacheHit })

    let cancelled = false
    const controller = new AbortController()
    const isStillSelected = buildIsStillSelected(
      selectedKeyForEffect,
      () => {
        const active = selectedRef.current
        if (!active) return null
        return resolveMessageCacheKeyForThread(active)
      },
      () => cancelled,
    )

    markThreadSelectTelemetry({
      cacheHit: plan.telemetry.cacheHit,
      cacheApplyMs: plan.telemetry.cacheApplyMs,
      selectMs: plan.telemetry.cacheApplyMs,
    })

    void executeThreadSelectFetches(
      plan,
      createThreadSelectHandlers(thread, {
        cachedMessages,
        onDossierStart: markDossierParallelStarted,
        shouldMeasureUncached: () => {
          const pending = pendingUncachedSelectRef.current
          return Boolean(
            pending
            && pending.cacheKey === selectedKeyForEffect
            && pending.nonce === selectNonceRef.current,
          )
        },
      }),
      isStillSelected,
      controller.signal,
      {
        onTelemetry: ({ phase }) => {
          if (phase === 'messages' && pendingUncachedSelectRef.current?.cacheKey === selectedKeyForEffect) {
            pendingUncachedSelectRef.current = null
          }
        },
        onMessages: (result) => {
          if (result.messages.length > 0 && !result.integrityBlocked) {
            messageCacheRef.current[cacheKey] = result.messages
          }
          setMessageFetchDegraded(Boolean(result.fetchFailed))
          setSelectedMessages(result.messages)
          setHasOlderMessages(result.hasMore)
          setMessagesLoading(false)
          const deliveredByBody = new Set(
            result.messages
              .filter((message) => message.direction === 'outbound' && String(message.deliveryStatus || '').toLowerCase() === 'delivered')
              .map((message) => String(message.body || '').trim().toLowerCase()),
          )
          if (deliveredByBody.size > 0) {
            setPendingMessagesByThread((current) => {
              const currentThreadPending = current[thread.id] ?? []
              const unresolved = currentThreadPending.filter((pending) => !deliveredByBody.has(String(pending.body || '').trim().toLowerCase()))
              if (unresolved.length === currentThreadPending.length) return current
              return { ...current, [thread.id]: unresolved }
            })
          }
        },
        onHydration: (result) => {
          if (result.messages.length > 0) {
            messageCacheRef.current[cacheKey] = result.messages
            setSelectedMessages((current) => (current.length > 0 ? current : result.messages))
            setHasOlderMessages(result.hasMore)
            setMessagesLoading(false)
          }
          if (result.dealContext) {
            setDealContext(result.dealContext)
            dealContextCacheRef.current[cacheKey] = result.dealContext
          }
          if (result.intelligence) {
            setThreadIntelligence({
              ...((thread ?? {}) as unknown as ThreadIntelligenceRecord),
              ...result.intelligence,
            })
          }
          setContextLoading(false)
        },
        onDossier: (result) => {
          if (result.dealContext) {
            setDealContext(result.dealContext)
            dealContextCacheRef.current[cacheKey] = result.dealContext
          }
          if (result.intelligence) {
            setThreadIntelligence((current) => ({ ...(current ?? {}), ...result.intelligence }))
          }
          setContextLoading(false)
        },
        onThreadContext: (result) => {
          if (result.context) setThreadContext(result.context)
        },
      },
    ).then(({ parallelStarted }) => {
      const prior = getInboxProof()
      markThreadSelectTelemetry({
        cacheHit: plan.telemetry.cacheHit || prior.lastThreadSelectCacheHit === true,
        cacheApplyMs: plan.telemetry.cacheHit
          ? plan.telemetry.cacheApplyMs
          : (prior.lastThreadSelectCacheApplyMs ?? plan.telemetry.cacheApplyMs),
        selectMs: performance.now() - selectStarted,
        parallelFetchStarted: parallelStarted,
      })
    }).catch((err) => {
      if (!cancelled) {
        console.error('[MESSAGES_FETCH_ERROR]', selectedKeyForEffect, err)
        setMessageFetchDegraded(true)
        setSelectedMessages(cachedMessages)
        setMessagesLoading(false)
      }
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DEV, selectedKeyForEffect, messageRefetchKey])

  useEffect(() => {
    if (!selectedKeyForEffect || !messageFetchDegraded) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = (delayMs = 3000) => {
      if (cancelled) return
      timer = setTimeout(() => { void probe() }, delayMs)
    }

    const probe = async () => {
      const health = await getBackendHealth()
      if (cancelled) return
      if (health.ok && (health.data?.status === 'ok' || health.data?.ok === true)) {
        setMessageFetchDegraded(false)
        setMessageRefetchKey((key) => key + 1)
        return
      }
      schedule()
    }

    schedule(1500)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [messageFetchDegraded, selectedKeyForEffect])

  const handleLoadOlderMessages = useCallback(async () => {
    const thread = selectedRef.current
    if (!thread || !selectedKeyForEffect || olderMessagesLoading) return
    const requestKey = selectedKeyForEffect
    setOlderMessagesLoading(true)
    try {
      const page = await getThreadMessagesPageForThread(thread, {
        offset: selectedMessages.length,
        maxMessages: 50,
      })
      const activeConversationId = selectedRef.current
        ? (getConversationThreadIdForThread(selectedRef.current) || selectedRef.current.threadKey || selectedRef.current.id)
        : null
      if (activeConversationId !== requestKey) return
      setSelectedMessages((current) => dedupeMessages([...page.messages, ...current]))
      setHasOlderMessages(page.pagination.hasMore)
      messageCacheRef.current[requestKey] = dedupeMessages([
        ...page.messages,
        ...(messageCacheRef.current[requestKey] ?? []),
      ])
    } catch (err) {
      if (DEV) console.warn('[InboxPage load older messages failed]', { threadKey: requestKey, err })
    } finally {
      setOlderMessagesLoading(false)
    }
  }, [DEV, olderMessagesLoading, selectedKeyForEffect, selectedMessages.length])

  useEffect(() => {
    if (!selectedKeyForEffect || data.dataMode !== 'live') return
    if (!hasSupabaseEnv) return

    const selected = selectedRef.current
    if (!selected) return

    const selectedKey = selectedKeyForEffect
    const selectedPhone = selected.canonicalE164 || selected.phoneNumber || ''
    const selectedOwnerId = selected.ownerId || ''
    const selectedPropertyId = selected.propertyId || ''
    const selectedProspectId = selected.prospectId || ''
    const shouldPollSelectedThread = data.connectionState === 'offline'
      || data.connectionState === 'degraded_polling'
    const supabase = getSupabaseClient()
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let pollController: AbortController | null = null
    let pollInFlight = false
    const scheduleRefreshInbox = () => {
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refreshInbox()
      }, 200)
    }

    const mergeRealtimeMessage = (incoming: ThreadMessage) => {
      messageCacheRef.current[selectedKey] = dedupeMessages([
        ...(messageCacheRef.current[selectedKey] ?? []),
        incoming,
      ])
      commitDashboardMessages(selectedKey, [incoming], {
        source: 'selected_thread_realtime',
      })

      setSelectedMessages((current) => {
        return dedupeMessages([...current, incoming])
      })
    }

    const belongsToSelection = (row: Record<string, unknown>) => {
      const rowConversationThreadId = String(row.conversation_thread_id ?? row.conversationThreadId ?? '').trim()
      const rowThreadKey = String(row.thread_key ?? row.threadKey ?? '').trim()
      const rowFrom = String(row.from_phone_number ?? '').trim()
      const rowTo = String(row.to_phone_number ?? '').trim()
      const rowOwnerId = String(row.master_owner_id ?? '').trim()
      const rowPropertyId = String(row.property_id ?? '').trim()
      const rowProspectId = String(row.prospect_id ?? '').trim()
      const phoneMatches = Boolean(selectedPhone && (rowFrom === selectedPhone || rowTo === selectedPhone || rowThreadKey === selectedPhone))
      if (rowConversationThreadId && rowConversationThreadId === selectedKey) return true
      if (rowThreadKey && rowThreadKey === selectedKey) return true
      if (selectedProspectId && phoneMatches && rowProspectId === selectedProspectId) return true
      if (selectedPropertyId && phoneMatches && rowPropertyId === selectedPropertyId) return true
      if (selectedOwnerId && phoneMatches && rowOwnerId === selectedOwnerId) return true
      if (!selectedProspectId && !selectedPropertyId && !selectedOwnerId && phoneMatches) return true
      return false
    }

    const channel = supabase
      .channel(`nexus-inbox-thread-${selectedKey}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_events' }, (payload) => {
        console.log('[InboxPage realtime message_events]', { eventType: payload.eventType, threadKey: selectedKey })
        const row = (payload.new ?? payload.old ?? {}) as Record<string, unknown>
        if (!belongsToSelection(row)) return
        if (DEV) {
          console.log('[InboxPage realtime message append]', {
            threadKey: selectedKey,
            eventType: payload.eventType,
            messageId: row.id ?? null,
          })
        }
        if (payload.eventType === 'DELETE') {
          setSelectedMessages((current) => current.filter((message) => message.id !== String(row.id ?? '')))
          return
        }
        const incoming = toThreadMessage(row)
        mergeRealtimeMessage(incoming)
        logRealtimePatchApplied({
          table: 'message_events',
          eventType: payload.eventType,
          threadKey: selectedKey,
          patchKeys: ['messagesByThreadId'],
          messageId: incoming.id,
        })

        // Remove any pending optimistic message that this confirmed event supersedes
        const rowCsid = String((row.metadata as Record<string, unknown> | null)?.client_send_id ?? '').trim()
        const rowQueueId = String(row.queue_id ?? '').trim()
        if (rowCsid || rowQueueId) {
          setPendingMessagesByThread((current) => {
            const currentThreadPending = current[selected.id] ?? []
            if (currentThreadPending.length === 0) return current
            const filtered = currentThreadPending.filter((pending) => {
              const pendingCsid = String(pending.developerMeta?.client_send_id ?? '').trim()
              const pendingQueueId = String(pending.developerMeta?.queue_id ?? '').trim()
              if (rowCsid && pendingCsid && pendingCsid === rowCsid) return false
              if (rowQueueId && pendingQueueId && pendingQueueId === rowQueueId) return false
              return true
            })
            if (filtered.length === currentThreadPending.length) return current
            console.log('[MessageLifecycle] event merged — pending removed', { rowCsid, rowQueueId, removedCount: currentThreadPending.length - filtered.length })
            return { ...current, [selected.id]: filtered }
          })
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'send_queue' }, (payload) => {
        console.log('[InboxPage realtime send_queue]', { eventType: payload.eventType, threadKey: selectedKey })
        const row = (payload.new ?? payload.old ?? {}) as Record<string, unknown>
        if (!belongsToSelection(row)) return

        const queueId = String(row.id ?? row.queue_id ?? '').trim()
        const nextStatus = String(row.queue_status ?? row.status ?? 'pending').trim().toLowerCase()
        const rowCsid = String((row.metadata as Record<string, unknown> | null)?.client_send_id ?? '').trim()

        setPendingMessagesByThread((current) => {
          const currentThreadPending = current[selected.id] ?? []
          if (currentThreadPending.length === 0) return current
          let changed = false
          const nextPending = currentThreadPending.map((message) => {
            const messageQueueId = String(message.developerMeta?.queue_id ?? '').trim()
            const messageCsid = String(message.developerMeta?.client_send_id ?? '').trim()
            const sameQueue = queueId && messageQueueId && messageQueueId === queueId
            const sameCsid = rowCsid && messageCsid && messageCsid === rowCsid
            const sameBody = String(row.message_body ?? row.message_text ?? '').trim() && String(row.message_body ?? row.message_text ?? '').trim() === message.body.trim()
            if (!sameQueue && !sameCsid && !sameBody) return message
            changed = true
            if (DEV) console.log('[MessageLifecycle] queue status update', { matchedBy: sameQueue ? 'queue_id' : sameCsid ? 'client_send_id' : 'body', nextStatus })
            return {
              ...message,
              deliveryStatus: nextStatus || message.deliveryStatus,
              rawStatus: nextStatus || message.rawStatus,
              error: String(row.failed_reason ?? row.failure_reason ?? '').trim() || message.error,
              developerMeta: {
                ...(message.developerMeta ?? {}),
                queue_id: queueId || String(message.developerMeta?.queue_id ?? ''),
                ...(rowCsid ? { client_send_id: rowCsid } : {}),
              },
            }
          })
          return changed ? { ...current, [selected.id]: dedupeMessages(nextPending) } : current
        })
        patchDashboardThread(selectedKey, {
          deliveryStatus: nextStatus,
          latestDeliveryStatus: nextStatus,
          queueId,
        }, {
          source: 'selected_thread_realtime',
          table: 'send_queue',
          eventType: payload.eventType,
        })
        logRealtimePatchApplied({
          table: 'send_queue',
          eventType: payload.eventType,
          threadKey: selectedKey,
          patchKeys: ['deliveryStatus', 'latestDeliveryStatus', 'queueId'],
          queueId,
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_thread_state' }, (payload) => {
        const row = (payload.new ?? payload.old ?? {}) as Record<string, unknown>
        if (!belongsToSelection(row)) return
        if (DEV) console.log('[InboxPage realtime dossier update]', { threadKey: selectedKey, eventType: payload.eventType })
        const patch = {
          inboxCategory: row.inbox_category,
          inbox_bucket: row.inbox_category,
          uiIntent: row.detected_intent || row.ui_intent,
          workflowStage: row.thread_stage,
        }
        
        setThreadIntelligence((current) => {
          if (!current) return current
          return {
            ...current,
            ...row,
            // Map common aliases
            inboxCategory: row.inbox_category || current.inboxCategory,
            uiIntent: row.detected_intent || row.ui_intent || current.uiIntent,
            workflowStage: row.thread_stage || current.workflowStage,
          }
        })
        patchDashboardThread(selectedKey, patch, {
          source: 'selected_thread_realtime',
          table: 'operator_thread_state',
          eventType: payload.eventType,
        })
        logRealtimePatchApplied({
          table: 'operator_thread_state',
          eventType: payload.eventType,
          threadKey: selectedKey,
          patchKeys: Object.keys(patch),
        })
      })
      .subscribe()

    // Inbox-wide realtime for list movement + counts (invalidates short TTL cache on message/state changes)
    const inboxSubs = subscribeToInboxRealtime(() => {
      // Trigger any local schedule if in scope, otherwise rely on cache-bust + next render/fetch cycle
      try { if (typeof scheduleRefreshInbox === 'function') scheduleRefreshInbox() } catch {}
    })

    const pollSelectedMessages = () => {
      if (!shouldPollSelectedThread || document.hidden || pollInFlight) return
      markSelectedPollTick()
      pollInFlight = true
      pollController = new AbortController()
      getThreadMessagesForThread(selected, { signal: pollController.signal, maxMessages: 50 }).then((messages) => {
        if (!messages.length) return
        commitDashboardMessages(selectedKey, messages, {
          source: 'selected_thread_polling',
          connectionState: data.connectionState ?? null,
        })
        messageCacheRef.current[selectedKey] = dedupeMessages([
          ...(messageCacheRef.current[selectedKey] ?? []),
          ...messages,
        ])
        setSelectedMessages((current) => {
          const merged = dedupeMessages([...current, ...messages])
          if (merged.length > current.length) scheduleRefreshInbox()
          return merged
        })
      }).catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') return
        if (DEV) console.warn('[InboxPage selected message poll failed]', { threadKey: selectedKey, err })
      }).finally(() => {
        pollInFlight = false
      })
    }
    const selectedPollScheduler = shouldPollSelectedThread
      ? createSelectedThreadPollScheduler({
        getConnectionState: () => data.connectionState ?? 'live',
        isDocumentHidden: () => document.hidden,
        isPollInFlight: () => pollInFlight,
        onTick: pollSelectedMessages,
      })
      : null

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      selectedPollScheduler?.stop()
      pollController?.abort()
      void supabase.removeChannel(channel)
      inboxSubs.forEach((s) => { try { s.unsubscribe() } catch {} })
    }
  }, [DEV, data.connectionState, data.dataMode, refreshInbox, selectedKeyForEffect])

  const handleTranslateThread = useCallback(async () => {
    if (!threadHasInboundMessages) return

    const inboundMessages = selectedMessages
      .filter((message) => message.direction === 'inbound' && message.body.trim().length > 0)

    if (inboundMessages.length === 0) return

    setThreadTranslationLoading(true)

    try {
      const uniqueBodies = Array.from(new Set(inboundMessages.map((message) => message.body.trim())))
      const translationByBody = new Map<string, string>()

      await Promise.all(uniqueBodies.map(async (body) => {
        const result = await translateText({
          text: body,
          sourceLanguage: sellerLanguageCode ?? undefined,
          targetLanguage: 'en',
          mode: 'thread',
        })
        translationByBody.set(body, result.translatedText)
        // Only store detected language if genuinely non-English — prevents English threads
        // from hiding the translate UI after detection sets sellerLanguageCode to 'en'
        if (result.detectedLanguage && !result.detectedLanguage.startsWith('en')) {
          setDetectedThreadLanguage(result.detectedLanguage.toLowerCase())
        }
      }))

      const nextTranslations: Record<string, string> = {}
      inboundMessages.forEach((message) => {
        const translated = translationByBody.get(message.body.trim())
        if (translated) {
          nextTranslations[message.id] = translated
        }
      })

      setThreadTranslations(nextTranslations)
      setThreadViewMode('translated')
      emitNotification({
        title: 'Thread Translated',
        detail: `${Object.keys(nextTranslations).length} inbound messages translated to English`,
        severity: 'success',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to translate thread messages'
      emitNotification({
        title: 'Translation Failed',
        detail: message,
        severity: 'warning',
      })
    } finally {
      setThreadTranslationLoading(false)
    }
  }, [selectedMessages, sellerLanguageCode, threadHasInboundMessages])

  // Auto-translate inbound messages when a KNOWN non-English thread is selected.
  // Guard requires sellerLanguageCode to be set — null = unknown language, don't auto-translate
  // (prevents false English detection from hiding the translate UI for English threads).
  const autoTranslatedThreadRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selected?.id || !sellerLanguageCode || isEnglishLanguage(sellerLanguageCode) || !threadHasInboundMessages) return
    if (autoTranslatedThreadRef.current === selected.id) return
    autoTranslatedThreadRef.current = selected.id
    const timer = setTimeout(() => { handleTranslateThread() }, 600)
    return () => clearTimeout(timer)
  }, [selected?.id, sellerLanguageCode, threadHasInboundMessages, handleTranslateThread])

  const handleTranslateDraft = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    setDraftTranslationLoading(true)

    try {
      const targetLanguage = sellerLanguageCode && !isEnglishLanguage(sellerLanguageCode)
        ? sellerLanguageCode
        : 'es'

      const result = await translateText({
        text: trimmed,
        sourceLanguage: 'en',
        targetLanguage,
        mode: 'draft',
      })

      if (result.detectedLanguage && !result.detectedLanguage.startsWith('en')) {
        setDetectedThreadLanguage((current) => current ?? result.detectedLanguage)
      }
      // Push translated text back to Composer via draftText prop.
      setDraftText(result.translatedText)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to translate draft'
      emitNotification({
        title: 'Draft Translation Failed',
        detail: message,
        severity: 'warning',
      })
    } finally {
      setDraftTranslationLoading(false)
    }
  }, [sellerLanguageCode])


  useEffect(() => {
    try {
      const layoutVersion = window.localStorage.getItem(DEAL_DESK_LAYOUT_VERSION_KEY)
      const shouldForceDealDesk = layoutVersion !== DEAL_DESK_LAYOUT_VERSION

      setSelectedWorkspaceKey(DEFAULT_WORKSPACE_KEY)
      let initialViews = loadPersistedWorkspaceViews(initialWorkspaceView, routeMode)
      let initialWidths = loadPersistedWorkspaceWidthOverrides(initialViews)
      if (shouldForceDealDesk && !isRouteFullscreen && initialWorkspaceView === undefined) {
        initialViews = cloneDefaultWorkspaceViews()
        initialWidths = {}
        window.localStorage.setItem(DEAL_DESK_LAYOUT_VERSION_KEY, DEAL_DESK_LAYOUT_VERSION)
      }
      setSelectedWorkspaceViews(initialViews)
      setWorkspaceWidthOverrides(initialWidths)

      if (!shouldForceDealDesk && !isRouteFullscreen && initialWorkspaceView === undefined) {
        const savedWorkspaceKey = window.localStorage.getItem('nx.inbox.selected-workspace') as NexusWorkspaceKey | null
        let savedViewsByWorkspace: Partial<Record<NexusWorkspaceKey, InboxWorkspaceView[]>> = {}
        try {
          const raw = window.localStorage.getItem(WORKSPACE_VIEWS_STORAGE_KEY)
          if (raw) savedViewsByWorkspace = JSON.parse(raw) as Partial<Record<NexusWorkspaceKey, InboxWorkspaceView[]>>
        } catch {}
        if (savedWorkspaceKey) {
          const preset = NEXUS_WORKSPACE_PRESETS.find((workspace) => workspace.key === savedWorkspaceKey)
          if (preset) {
            setSelectedWorkspaceKey(preset.key)
            const savedViews = savedViewsByWorkspace[preset.key]
            const restoredViews = Array.isArray(savedViews) && savedViews.length > 0
              ? savedViews.filter((view) => WORKSPACE_VIEW_OPTIONS.some((opt) => opt.key === view))
              : [...preset.views]
            const nextViews = normalizePersistedWorkspaceViews(preset.key, restoredViews)
            setSelectedWorkspaceViews(nextViews)
            initialViews = nextViews
            initialWidths = resolvePresetWidthOverrides(nextViews, preset.widths)
            setWorkspaceWidthOverrides(initialWidths)
          }
        }
        const savedOverrides = window.localStorage.getItem('nx.inbox.workspace-width-overrides')
        if (savedOverrides) {
          const parsed = JSON.parse(savedOverrides) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>
          setWorkspaceWidthOverrides(
            sanitizeWorkspaceWidthOverrides(
              initialViews,
              Object.keys(parsed).length > 0 ? parsed : initialWidths,
            ),
          )
        }
      }
      const savedMode = window.localStorage.getItem('nx.queue.mode') as QueueCommandMode | null
      const savedCaps = window.localStorage.getItem('nx.queue.caps')
      if (savedMode === 'paused' || savedMode === 'assisted' || savedMode === 'automatic') setQueueCommandMode(savedMode)
      if (savedCaps) {
        const parsed = JSON.parse(savedCaps) as Partial<QueueCommandCaps>
        setQueueCommandCaps((current) => ({ ...current, ...parsed }))
      }
    } catch {}
  }, [])

  const refreshQueueControl = useCallback(async () => {
    const res = await getQueueControlSettings()
    if (!res.ok) return null
    const d = res.data?.diagnostics as CampaignControlDiagnostics | undefined
    if (!d) return null
    setQueueControlDiagnostics(d)
    setQueueCommandMode(queueModeFromControl(d))
    setQueueCommandCaps((current) => ({
      ...current,
      sends_per_run: Math.max(1, Number(d.queue_run_limit || d.max_batch_size || current.sends_per_run)),
      max_per_number_per_day: Math.max(1, Number(d.queue_per_number_cap || d.queue_sender_throttle || d.per_number_cap || current.max_per_number_per_day)),
      max_per_market_per_hour: Math.max(1, Number(d.queue_market_cap || d.queue_market_throttle || d.market_cap || current.max_per_market_per_hour)),
    }))
    return d
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem('nx.queue.mode', queueCommandMode)
      window.localStorage.setItem('nx.queue.caps', JSON.stringify(queueCommandCaps))
    } catch {}
  }, [queueCommandCaps, queueCommandMode])

  useEffect(() => {
    if (!workspaceWidthsPersistReadyRef.current) {
      workspaceWidthsPersistReadyRef.current = true
      return
    }
    try {
      window.localStorage.setItem('nx.inbox.workspace-width-overrides', JSON.stringify(workspaceWidthOverrides))
    } catch {}
  }, [workspaceWidthOverrides])

  useEffect(() => {
    try {
      window.localStorage.setItem('nx.inbox.selected-workspace', selectedWorkspaceKey)
    } catch {}
  }, [selectedWorkspaceKey])

  useEffect(() => {
    const sync = () => {
      const settings = loadSettings()
      const resolvedThemeId = resolveDataThemeAttr(settings.nexusTheme) as NexusGlobalThemeId
      setActiveNexusThemeId(resolvedThemeId)
      setActiveAccentPalette(settings.accentPalette)
      setLayoutState((current) => {
        const nextTheme = resolvedThemeId === 'light' ? 'light' : 'dark'
        
        return current.theme === nextTheme ? current : { ...current, theme: nextTheme }
      })
    }
    sync()
    return subscribeSettings(sync)
  }, [])

  const refreshQueueHealth = useCallback(async () => {
    setQueueProcessorHealthLoading(true)
    const snapshot = await getQueueProcessorHealth()
    setQueueProcessorHealth(snapshot)
    setQueueProcessorHealthLoading(false)
    return snapshot
  }, [])

  const runQueueCommand = useCallback(async (
    actionKey: string,
    endpoint: string,
    options?: {
      body?: Record<string, unknown>
      successTitle?: string
      successDetail?: (payload: any) => string
    },
  ) => {
    setQueueCommandActionLoading(actionKey)
    try {
      const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
      const result = await callBackend<any>(path, {
        method: 'POST',
        body: JSON.stringify(options?.body ?? {}),
      })
      if (!result.ok) {
        throw new Error(String(result.error || result.message || 'Queue action failed'))
      }
      const payload = result.data || {}
      if (payload?.ok === false) {
        throw new Error(String(payload?.error || 'Queue action failed'))
      }
      await refreshQueueHealth()
      await refreshQueueControl()
      emitNotification({
        title: options?.successTitle || 'Queue Updated',
        detail: options?.successDetail ? options.successDetail(payload) : 'Queue action completed successfully.',
        severity: 'success',
      })
      return payload
    } catch (error) {
      emitNotification({
        title: 'Queue Action Failed',
        detail: error instanceof Error ? error.message : 'Unknown queue action error',
        severity: 'critical',
      })
      throw error
    } finally {
      setQueueCommandActionLoading(null)
    }
  }, [refreshQueueControl, refreshQueueHealth])

  // Serialize heavy background API work so thread messages / dossier are not competing
  // with queue/control/health/page on a single-worker dev API.
  useEffect(() => {
    if (data.liveFetchStatus !== 'active') return
    if (_dataLoading) return
    if (backgroundBootstrapStartedRef.current) return

    let active = true
    let idleHandle: number | null = null
    const gap = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })

    const runStaggeredBootstrap = async () => {
      if (!active || backgroundBootstrapStartedRef.current) return
      backgroundBootstrapStartedRef.current = true

      await gap(10_000)
      if (!active) return

      await refreshQueueControl().catch(() => null)
      if (!active) return
      await gap(600)

      await refreshQueueHealth().catch(() => null)
      if (!active) return
      await gap(600)

      const activity = await fetchInboxActivity().catch(() => [])
      if (active) setActivityFeed(activity)
      if (!active) return
      await gap(600)

      const templates = await fetchSmsTemplates({ includeInactive: true, limit: 800 }).catch(() => [])
      if (active) setTemplateInventory(templates)
      if (!active) return
      await gap(600)

      if (selectedWorkspaceViewsRef.current.includes('queue')) {
        const nextQueue = await fetchQueueModel().catch(() => null)
        if (active && nextQueue) setQueueModel(nextQueue)
      }

      healthIntervalRef.current = window.setInterval(() => { void refreshQueueHealth() }, 30_000)
      autonomyIntervalRef.current = window.setInterval(async () => {
        const nextActivity = await fetchInboxActivity().catch(() => [])
        if (nextActivity.length) setActivityFeed(nextActivity)
        if (!selectedWorkspaceViewsRef.current.includes('queue')) return
        const nextQueue = await fetchQueueModel().catch(() => null)
        if (nextQueue) setQueueModel(nextQueue)
      }, 45_000)
    }

    const kickoff = () => { void runStaggeredBootstrap() }
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(kickoff, { timeout: 18_000 })
    } else {
      kickoff()
    }

    return () => {
      active = false
      if (idleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle)
      }
    }
  }, [_dataLoading, data.liveFetchStatus, refreshQueueControl, refreshQueueHealth])

  useEffect(() => {
    return () => {
      if (healthIntervalRef.current !== null) window.clearInterval(healthIntervalRef.current)
      if (autonomyIntervalRef.current !== null) window.clearInterval(autonomyIntervalRef.current)
    }
  }, [])

  useEffect(() => {
    if (!selectedWorkspaceViews.includes('queue')) return
    if (queueModel) return
    let active = true
    void fetchQueueModel()
      .then((model) => { if (active) setQueueModel(model) })
      .catch(() => null)
    return () => { active = false }
  }, [queueModel, selectedWorkspaceViews])

  const handleQueueCommandModeChange = useCallback((mode: QueueCommandMode) => {
    if (mode === 'automatic') {
      if (!window.confirm('Set Live Limited mode? Queue work still requires explicit caps and scope before any live seller rows are created or sent.')) return
    }
    setQueueCommandMode(mode)
    const action = mode === 'paused' ? 'pause_queue_processor' : 'resume_queue_processor'
    const campaignMode = mode === 'automatic' ? 'live_limited' : mode === 'assisted' ? 'dry_run' : 'paused'
    void callBackend('/api/cockpit/queue/control', {
      method: 'POST',
      body: JSON.stringify({ action, campaign_mode: campaignMode }),
    }).then(() => refreshQueueControl())
    emitNotification({
      title: 'Queue Mode Updated',
      detail: mode === 'paused' ? 'Queue processor is paused.' : mode === 'assisted' ? 'Dry-run preview mode enabled.' : 'Live Limited selected; caps and scope are still required for live work.',
      severity: mode === 'automatic' ? 'warning' : 'success',
    })
  }, [refreshQueueControl])

  const handleQueueCapsChange = useCallback((patch: Partial<QueueCommandCaps>) => {
    setQueueCommandCaps((current) => {
      const next = { ...current, ...patch }
      void updateQueueControlSettings({
        queue_run_limit: String(next.sends_per_run),
        queue_hard_cap: String(next.sends_per_run),
        queue_max_batch_size: String(next.sends_per_run),
        queue_sender_throttle: String(next.max_per_number_per_day),
        queue_market_throttle: String(next.max_per_market_per_hour),
        queue_market_cap: String(next.max_per_market_per_hour),
        queue_per_number_cap: String(next.max_per_number_per_day),
      }).then(() => refreshQueueControl())
      return next
    })
  }, [refreshQueueControl])

  const buildQueueSafetyPayload = useCallback(() => {
    const campaignMode = String(queueControlDiagnostics?.campaign_mode || (queueCommandMode === 'automatic' ? 'live_limited' : queueCommandMode === 'assisted' ? 'dry_run' : 'paused'))
    const allMarketAck = queueControlDiagnostics?.all_market_ack ?? queueControlDiagnostics?.queue_all_market_ack
    return {
      campaign_mode: campaignMode,
      hard_cap: queueControlDiagnostics?.hard_cap ?? queueControlDiagnostics?.queue_hard_cap ?? queueCommandCaps.sends_per_run,
      max_batch_size: queueControlDiagnostics?.max_batch_size ?? queueControlDiagnostics?.queue_max_batch_size ?? queueCommandCaps.sends_per_run,
      daily_cap: queueControlDiagnostics?.daily_cap ?? queueControlDiagnostics?.queue_daily_send_cap ?? queueCommandCaps.sends_per_run,
      market_cap: queueControlDiagnostics?.market_cap ?? queueControlDiagnostics?.queue_market_cap ?? queueCommandCaps.max_per_market_per_hour,
      per_number_cap: queueControlDiagnostics?.per_number_cap ?? queueControlDiagnostics?.queue_per_number_cap ?? queueCommandCaps.max_per_number_per_day,
      scan_limit: queueControlDiagnostics?.scan_limit ?? queueControlDiagnostics?.queue_scan_limit ?? 1000,
      market: (queueControlDiagnostics?.market ?? queueControlDiagnostics?.queue_market_filter ?? commandMapMarket) || undefined,
      state: queueControlDiagnostics?.state ?? queueControlDiagnostics?.queue_state_filter ?? undefined,
      all_market_ack: allMarketAck === true || String(allMarketAck || '').toLowerCase() === 'true',
    }
  }, [commandMapMarket, queueCommandCaps, queueCommandMode, queueControlDiagnostics])

  const handleRunSafeBatch = useCallback(() => (
    runQueueCommand('safe_batch', '/api/cockpit/queue/control', {
      body: { action: 'queue_limited_batch', limit: Math.max(1, Math.min(10, queueCommandCaps.sends_per_run)), caps: queueCommandCaps, ...buildQueueSafetyPayload() },
      successTitle: 'Limited Queue Batch',
      successDetail: (payload) => {
        if (!payload) return 'No response received'
        const { rows_created = 0, rows_scheduled = 0, error } = payload
        return `${rows_created} queued, ${rows_scheduled} scheduled.${error ? ` Error: ${error}` : ''}`
      },
    })
  ), [buildQueueSafetyPayload, queueCommandCaps, runQueueCommand])

  const handleRunQueueNow = useCallback(() => (
    runQueueCommand('run_now', '/api/cockpit/queue/control', {
      body: { action: 'run_small_queue_batch', limit: Math.max(1, Math.min(5, queueCommandCaps.sends_per_run)), caps: queueCommandCaps, mode: queueCommandMode, ...buildQueueSafetyPayload() },
      successTitle: 'Limited Queue Run',
      successDetail: (payload) => {
        if (!payload) return 'No response received'
        const { rows_sent = 0, block_reasons = {}, error } = payload
        const reasons = Object.entries(block_reasons)
          .filter(([_, count]) => Number(count) > 0)
          .map(([reason, count]) => `${count} ${reason}`)
          .join(', ')
        return `${rows_sent} rows sent.${reasons ? ` Blocks: ${reasons}` : ''}${error ? ` Error: ${error}` : ''}`
      },
    })
  ), [buildQueueSafetyPayload, queueCommandCaps, queueCommandMode, runQueueCommand])

  const handleQueueMoreNow = useCallback(() => (
    runQueueCommand('queue_more', '/api/cockpit/queue/control', {
      body: {
        action: 'run_dry_run_feeder',
        dry_run: true,
        candidate_source: 'v_sms_ready_contacts_expanded',
        limit: Math.max(5, Math.min(25, queueCommandCaps.sends_per_run * 2)),
        scan_limit: 1000,
        respect_contact_window: true,
        only_first_touch: true,
        mode: queueCommandMode,
      },
      successTitle: 'Dry-Run Preview Completed',
      successDetail: (payload) => {
        if (!payload) return 'No response received'
        const { eligible_count = 0, skipped_count = 0, preview = {}, block_reasons = {}, error } = payload
        const scanned = preview?.scanned_count ?? preview?.candidates_scanned ?? 0
        const reasons = Object.entries(block_reasons)
          .filter(([_, count]) => Number(count) > 0)
          .map(([reason, count]) => `${count} ${reason}`)
          .join(', ')
        return `${eligible_count} eligible, ${skipped_count} skipped, ${scanned} scanned.${reasons ? ` Blocks: ${reasons}` : ''}${error ? ` Error: ${error}` : ''}`
      },
    })
  ), [queueCommandCaps.sends_per_run, queueCommandMode, runQueueCommand])

  const handleEmergencyPause = useCallback(async () => {
    setQueueCommandMode('paused')
    await callBackend('/api/cockpit/queue/control', {
      method: 'POST',
      body: JSON.stringify({ action: 'emergency_stop' }),
    })
    emitNotification({
      title: 'Emergency Pause Enabled',
      detail: 'Queue processor mode set to off and auto controls paused.',
      severity: 'warning',
    })
    await refreshQueueHealth()
    await refreshQueueControl()
  }, [refreshQueueControl, refreshQueueHealth])

  const handleReprocessPaused = useCallback((ids?: string[]) => (
    runQueueCommand(ids?.length ? `retry_routing:${ids[0]}` : 'reprocess_paused', '/api/cockpit/queue/reprocess-paused', {
      body: ids?.length ? { ids } : {},
      successTitle: ids?.length ? 'Routing Retry Completed' : 'Paused Rows Reprocessed',
      successDetail: (payload) => {
        const summary = payload?.summary ?? {}
        return `${summary.resolved ?? 0} resolved • ${summary.still_blocked ?? 0} still blocked • ${summary.skipped ?? 0} skipped.`
      },
    })
  ), [runQueueCommand])

  const handleRetryFailedQueue = useCallback(() => (
    runQueueCommand('retry_failed', '/api/cockpit/queue/retry-failed', {
      successTitle: 'Failed Sends Retried',
      successDetail: (payload) => {
        const summary = payload?.summary ?? {}
        return `${summary.resolved ?? 0} rescheduled • ${summary.blocked ?? 0} blocked • ${summary.failed ?? 0} still failed.`
      },
    })
  ), [runQueueCommand])

  const handleReconcileDelivery = useCallback(() => (
    runQueueCommand('reconcile_delivery', '/api/cockpit/queue/reconcile', {
      successTitle: 'Delivery Reconciled',
      successDetail: (payload) => `${payload?.reconciled ?? 0} delivery records reconciled.`,
    })
  ), [runQueueCommand])

  const handleCancelStaleFollowUps = useCallback(() => (
    runQueueCommand('cancel_stale_followups', '/api/cockpit/queue/cancel-stale-followups', {
      successTitle: 'Stale Follow-Ups Cancelled',
      successDetail: (payload) => `${payload?.cancelled ?? 0} stale follow-up rows cancelled.`,
    })
  ), [runQueueCommand])

  // ── ALWAYS-ON AUTOPILOT LOOP ──────────────────────────────────────────────
  const autopilotStateRef = useRef({
    mode: queueCommandMode,
    caps: queueCommandCaps,
    health: queueProcessorHealth
  })

  useEffect(() => {
    autopilotStateRef.current = { mode: queueCommandMode, caps: queueCommandCaps, health: queueProcessorHealth }
  }, [queueCommandMode, queueCommandCaps, queueProcessorHealth])

  useEffect(() => {
    if (!selectedWorkspaceViews.includes('queue')) return
    let active = true

    const runFeederSilently = async () => {
      if (!active) return
      const { mode, caps, health } = autopilotStateRef.current
      if (mode !== 'assisted' && mode !== 'automatic') return

      const targetCount = Math.max(50, caps.sends_per_run * 2)
      const currentActive = (health?.queuedCount ?? 0) + (health?.scheduledCount ?? 0)

      if (currentActive < targetCount) {
        const result = await callBackend('/api/cockpit/queue/queue-more', {
          method: 'POST',
          body: JSON.stringify({
            candidate_source: 'v_sms_ready_contacts',
            target_count: targetCount,
            scan_limit: 1000,
            respect_contact_window: true,
            only_first_touch: true,
            mode: mode,
          }),
        })
        if (result.ok || result.status === 423) void refreshQueueHealth()
      }
    }

    const runQueueSilently = async () => {
      if (!active) return
      const { mode, caps } = autopilotStateRef.current
      if (mode !== 'automatic') return

      const result = await callBackend('/api/cockpit/queue/run', {
        method: 'POST',
        body: JSON.stringify({
          caps: caps,
          mode: mode,
        }),
      })
      if (result.ok || result.status === 423) void refreshQueueHealth()
    }

    const feederInterval = window.setInterval(() => { void runFeederSilently() }, 2 * 60 * 1000)
    const runnerInterval = window.setInterval(() => { void runQueueSilently() }, 60 * 1000)

    return () => {
      active = false
      window.clearInterval(feederInterval)
      window.clearInterval(runnerInterval)
    }
  }, [refreshQueueHealth, selectedWorkspaceViews])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openGlobalCommand()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('nexus:focus-search'))
        return
      }

      if (event.key === 'Escape') {
        setCommandOpen(false)
        setSchedulePanelOpen(false)
        setLayoutState((current) => ({ ...current, activeOverlay: null }))
        return
      }

      if (isTyping) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (filtered.length === 0) return
        const currentIndex = selected ? filtered.findIndex((thread) => thread.id === selected.id) : -1
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = currentIndex === -1
          ? 0
          : Math.max(0, Math.min(filtered.length - 1, currentIndex + delta))
        const nextThread = filtered[nextIndex]
        if (nextThread) {
          setSelectedId(nextThread.id)
          setSelectedThreadKey(nextThread.threadKey || nextThread.id)
          setLayoutState((current) => ({ ...current, selectedThreadId: nextThread.id }))
        }
        return
      }

      if (event.altKey && /^[1-7]$/.test(event.key)) {
        event.preventDefault()
        const presetByKey: InboxSavedFilterPreset[] = ['positive_hot', 'manual_review', 'needs_reply', 'auto_replied', 'outbound_only', 'missing_context', 'suppressed']
        const preset = presetByKey[Number(event.key) - 1]
        if (preset) applySavedPreset(preset)
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setLayoutState((current) => {
          const next = current.mapMode === 'off' ? openMapMode(current) : closeMapMode(current)
          announceLayout(next.mapMode === 'off' ? 'Map mode closed' : 'Map mode')
          return next
        })
        return
      }

      if (event.key === '[') {
        setLayoutState((current) => {
          const next = cycleLeftPanelMode(current)
          announceLayout(layoutToastForState(next, '['))
          return next
        })
      }
      if (event.key === ']') {
        setLayoutState((current) => {
          const next = cycleRightPanelMode(current)
          announceLayout(layoutToastForState(next, ']'))
          return next
        })
      }
      if (event.key === '/') {
        event.preventDefault()
        setLayoutState((current) => {
          const next = cycleInboxMode(current)
          announceLayout(layoutToastForState(next, '/'))
          return next
        })
      }
      if (event.key === '\\') {
        if (layoutState.mapMode !== 'off') {
          // In map mode: cycle map panel size (side → half → 75% → full → side)
          setLayoutState(cycleMapMode)
        } else if (layoutState.leftPanelMode === 'full' || layoutState.inboxMode === 'full_double') {
          // In full-screen inbox: toggle double-sided inbox
          setLayoutState((current) => ({
            ...current,
            inboxMode: current.inboxMode === 'full_double' ? 'default' : 'full_double',
            leftPanelMode: current.inboxMode === 'full_double' ? 'full' : 'default',
          }))
        } else {
          // Default: toggle dossier overlay
          setActiveOverlay(layoutState.activeOverlay === 'dossier' ? null : 'dossier')
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [announceLayout, applySavedPreset, filtered, layoutState.activeOverlay, layoutState.mapMode, layoutState.leftPanelMode, layoutState.inboxMode, openGlobalCommand, selected, setActiveOverlay])

  const handleWorkflowMutation = useCallback(async (label: string, mutation: () => Promise<any>, options?: { action?: { label: string, onClick: () => void }, skipRefresh?: boolean }) => {
    try {
      if (DEV) console.log(`[NexusInbox] Mutation Triggered: ${label}`, { options })
      const result = await mutation()
      if (DEV) console.log(`[NexusInbox] Mutation Result: ${label}`, result)
      
      if (result && 'ok' in result && !result.ok) {
        emitNotification({ title: 'Error', detail: result.errorMessage || 'Unknown error', severity: 'critical' })
        return
      }
      if (!options?.skipRefresh) {
        if (DEV) console.log(`[NexusInbox] Refreshing data for: ${label}`)
        await refreshInbox({ filters: currentInboxQuery })
      } else {
        if (DEV) console.log(`[NexusInbox] Skipping refresh (optimistic only) for: ${label}`)
      }
      emitNotification({ 
        title: label, 
        detail: 'Action completed successfully', 
        severity: 'success',
        action: options?.action
      })
    } catch (err) {
      emitNotification({ title: 'Error', detail: String(err), severity: 'critical' })
    }
  }, [refreshInbox, currentInboxQuery, DEV])

  const handleThreadAction = useCallback(async (target: string | InboxWorkflowThread, action: string) => {
    const thread = typeof target === 'string' ? threads.find((t) => t.id === target) : target
    if (!thread) return

    let label = ''
    let mutation = async () => ({ ok: true, threadKey: thread.id })
    let optimisticAction: Parameters<typeof buildOptimisticThreadPatch>[0] | null = null

    if (action.startsWith('approve_queue:')) {
      const queueId = action.split(':')[1]
      label = 'Draft Approved'
      mutation = () => approveQueueItem(queueId!, thread)
      optimisticAction = 'approve_queue'
    } else if (action.startsWith('cancel_queue:')) {
      const queueId = action.split(':')[1]
      label = 'Draft Cancelled'
      mutation = () => cancelQueueItem(queueId!, thread)
      optimisticAction = 'cancel_queue'
    } else if (action.startsWith('edit_queue:')) {
      const queueId = action.split(':')[1]
      label = 'Opening Editor...'
      mutation = () => cancelQueueItem(queueId!, thread)
      optimisticAction = 'edit_queue'
      // Additional logic to focus composer could go here
    } else if (action === 'refetch') {
      setMessageRefetchKey((k) => k + 1)
      void refreshInbox({ filters: currentInboxQuery, cursor: null, limit: 100 })
      return
    } else if (action === 'open_map') {
      setSelectedWorkspaceViews(['command_map'])
      return
    } else if (action === 'open_property') {
      handleOpenDealIntelligence(thread.id)
      return
    } else if (action === 'open_queue') {
      setSelectedWorkspaceViews(['queue'])
      return
    } else {
      switch (action) {
        case 'archive':
          label = 'Thread Archived'
          mutation = () => archiveThread(thread)
          optimisticAction = 'archive'
          break
        case 'unarchive':
          label = 'Thread Restored'
          mutation = () => unarchiveThread(thread)
          optimisticAction = 'unarchive'
          break
        case 'star':
          label = 'Thread Starred'
          mutation = () => starThread(thread)
          optimisticAction = 'star'
          break
        case 'unstar':
          label = 'Star Removed'
          mutation = () => unstarThread(thread)
          optimisticAction = 'unstar'
          break
        case 'pin':
          label = 'Thread Pinned'
          mutation = () => pinThread(thread)
          optimisticAction = 'pin'
          break
        case 'unpin':
          label = 'Pin Removed'
          mutation = () => unpinThread(thread)
          optimisticAction = 'unpin'
          break
        case 'read':
          label = 'Marked Read'
          mutation = () => markThreadRead(thread)
          optimisticAction = 'read'
          break
        case 'unread':
          label = 'Marked Unread'
          mutation = () => markThreadUnread(thread)
          optimisticAction = 'unread'
          break
        default:
          return
      }
    }

    if (!optimisticAction) return
    const optimistic = buildOptimisticThreadPatch(optimisticAction, thread)
    setOptimisticPatches(prev => ({ ...prev, [thread.id]: { ...prev[thread.id], ...optimistic } }))
    markOptimisticPatch(String(optimisticAction), thread.id, optimistic as Record<string, unknown>)
    
    if (DEV) {
      console.log(`[NexusInboxActionNoRefresh]`, {
        action,
        thread_id: thread.id.slice(-8),
        optimistic: true,
        persisted: false,
        stoppedPropagation: true
      })
    }

    await handleWorkflowMutation(label, mutation, {
      skipRefresh: true,
      action: action === 'archive'
        ? {
            label: 'Undo',
            onClick: () => {
              setOptimisticPatches(prev => ({
                ...prev,
                [thread.id]: { ...prev[thread.id], isArchived: false, inboxStatus: 'new_reply' },
              }))
              console.log(`[NexusInboxActionNoRefresh]`, {
                action: 'undo_archive',
                thread_id: thread.id.slice(-8),
                optimistic: true,
                preventedDefault: true,
                stoppedPropagation: true
              })
              void handleWorkflowMutation('Thread Restored', () => unarchiveThread(thread), { skipRefresh: true })
            },
          }
        : undefined,
    })
  }, [threads, handleWorkflowMutation, DEV])

  const handleStatusChange = useCallback(async (status: InboxStatus | 'sent_message') => {
    if (!selected) return
    const actualStatus: InboxStatus = status === 'sent_message' ? 'waiting' : status
    const optimistic = buildOptimisticThreadPatch({ type: 'status', status }, selected)
    setOptimisticPatches(prev => ({ ...prev, [selected.id]: { ...prev[selected.id], ...optimistic } }))
    markOptimisticPatch(`status_${status}`, selected.id, optimistic as Record<string, unknown>)
    
    if (DEV) {
      console.log(`[NexusWorkflowStatus]`, {
        action: `status_change_${status}`,
        thread_id: selected.id.slice(-8),
        optimistic: true,
        preventedDefault: true,
        stoppedPropagation: true
      })
    }

    await handleWorkflowMutation(`Status: ${actualStatus.replace(/_/g, ' ')}`, () => updateThreadStatus(selected, actualStatus), { skipRefresh: true })
  }, [selected, handleWorkflowMutation, DEV])

  const handleStageChange = useCallback(async (stage: SellerStage) => {
    if (!selected) return
    const optimistic = buildOptimisticThreadPatch({ type: 'stage', stage }, selected)
    setOptimisticPatches(prev => ({ ...prev, [selected.id]: { ...prev[selected.id], ...optimistic } }))
    markOptimisticPatch(`stage_${stage}`, selected.id, optimistic as Record<string, unknown>)

    if (DEV) {
      console.log(`[NexusWorkflowStatus]`, {
        action: `stage_change_${stage}`,
        thread_id: selected.id.slice(-8),
        optimistic: true,
        preventedDefault: true,
        stoppedPropagation: true
      })
    }

    await handleWorkflowMutation(`Stage: ${stage.replace(/_/g, ' ')}`, () => updateThreadStage(selected, stage), { skipRefresh: true })
  }, [selected, handleWorkflowMutation, DEV])

  const handleToggleStar = useCallback(() => {
    if (!selected) return
    handleThreadAction(selected, selected.isStarred ? 'unstar' : 'star')
  }, [handleThreadAction, selected])

  const handleTogglePin = useCallback(() => {
    if (!selected) return
    handleThreadAction(selected, selected.isPinned ? 'unpin' : 'pin')
  }, [handleThreadAction, selected])

  useEffect(() => {
    registerInboxProofDriveAction((action, threadId) => {
      const target = threadId
        ? (findThreadByRef(threads, threadId) ?? selectedRef.current)
        : selectedRef.current
      if (!target) return
      if (action.startsWith('stage:')) {
        void handleStageChange(action.slice(6) as SellerStage)
        return
      }
      if (action.startsWith('status:')) {
        void handleStatusChange(action.slice(7) as InboxStatus | 'sent_message')
        return
      }
      if (action === 'snooze') {
        const optimistic = buildOptimisticThreadPatch('snooze', target)
        setOptimisticPatches((prev) => ({ ...prev, [target.id]: { ...prev[target.id], ...optimistic } }))
        markOptimisticPatch('snooze', target.id, optimistic as Record<string, unknown>)
        return
      }
      if (action === 'message_pending') {
        const clientSendId = crypto.randomUUID()
        const optimisticMessage = buildOptimisticOutboundMessage(target, 'proof outbound', clientSendId)
        markOptimisticPatch('message_pending', target.id, {
          body: optimisticMessage.body,
          deliveryStatus: optimisticMessage.deliveryStatus,
        })
        setPendingMessagesByThread((current) => ({
          ...current,
          [target.id]: [...(current[target.id] ?? []), optimisticMessage],
        }))
        return
      }
      void handleThreadAction(target, action)
    })
  }, [handleStageChange, handleStatusChange, handleThreadAction, threads])

  const handleToggleArchive = useCallback(() => {
    if (!selected) return
    handleThreadAction(selected, selected.isArchived ? 'unarchive' : 'archive')
  }, [handleThreadAction, selected])

  const anchorThreadSelection = useCallback((id: string) => {
    const thread = findThreadByRef(threads, id)
    if (thread) {
      setSelectedId(thread.id)
      setSelectedThreadKey(thread.threadKey || thread.id)
      setLayoutState((current) => ({ ...current, selectedThreadId: thread.id }))
      selectedThreadFallbackRef.current = thread
      return
    }
    setSelectedId(id)
    setSelectedThreadKey(id)
    setLayoutState((current) => ({ ...current, selectedThreadId: id }))
  }, [threads])

  const handleMobileBack = useCallback(() => {
    setSelectedId(null)
    setSelectedThreadKey(null)
    selectedThreadFallbackRef.current = null
    setMobileIntelOpen(false)
    setLayoutState((current) => ({ ...current, selectedThreadId: null }))
  }, [])

  const handleSelect = useCallback((id: string) => {
    setPreviewContext(null)
    const thread = findThreadByRef(threads, id)
    const threadKey = thread?.threadKey || thread?.id || id
    console.log('[THREAD_CLICK]', threadKey)
    console.log('[InboxUX] select thread', { threadKey, activeFilter: viewFilter })
    if (thread) {
      const uncachedKey = resolveMessageCacheKeyForThread(thread, id)
      const nextNonce = selectNonceRef.current + 1
      selectNonceRef.current = nextNonce
      pendingUncachedSelectRef.current = { cacheKey: uncachedKey, nonce: nextNonce }
      clearUncachedMessagesTelemetry()
      const alreadySelected = selectedId === thread.id || selectedThreadKey === (thread.threadKey || thread.id)
      if (alreadySelected) {
        const replay = planThreadSelect({
          thread,
          selectedKey: resolveMessageCacheKeyForThread(thread, id),
          conversationThreadId: getConversationThreadIdForThread(thread),
          messageRefetchKey: 0,
          messageCache: messageCacheRef.current,
        })
        if (replay) {
          markThreadSelectTelemetry({
            cacheHit: replay.telemetry.cacheHit,
            cacheApplyMs: replay.telemetry.cacheApplyMs,
            selectMs: replay.telemetry.cacheApplyMs,
          })
        }
      }
      setActiveContext(buildContextFromThread(thread, 'inbox'), { preserveCurrentViews: true })
      setSelectedId(thread.id)
      setSelectedThreadKey(thread.threadKey || thread.id)
      setLayoutState((current) => ({ ...current, selectedThreadId: thread.id }))
      selectedThreadFallbackRef.current = thread
    } else {
      // Keep pipeline/queue/calendar context — only anchor selection by thread key ref.
      setSelectedId(id)
      setSelectedThreadKey(id)
      setLayoutState((current) => ({ ...current, selectedThreadId: id }))
    }
    // Mark thread read and clear unread count in canonical state
    const canonicalStateKey = thread ? resolveCanonicalThreadStateKey(thread as unknown as Record<string, unknown>) : resolveCanonicalThreadStateKey({ thread_key: threadKey, threadKey })
    if (canonicalStateKey) {
      void callBackend('/api/cockpit/inbox/thread-state', {
        method: 'PATCH',
        body: JSON.stringify({ thread_key: canonicalStateKey, patch: { is_read: true } }),
      })
    }
  }, [setActiveContext, selectedId, selectedThreadKey, threads, viewFilter])

  const handleParticipantSelect = useCallback((participant: PropertyParticipant) => {
    const phone = String(participant.canonical_e164 ?? '').trim()
    if (!phone) return
    setSelectedParticipant(participant)
    const match = threads.find((thread) => {
      const candidates = [
        thread.canonicalE164,
        thread.bestPhone,
        thread.sellerPhone,
        thread.threadKey,
        thread.id,
      ].map((value) => String(value ?? '').trim()).filter(Boolean)
      return candidates.includes(phone)
    })
    if (match) {
      handleSelect(match.id)
      return
    }
    setActiveContext({
      ...activeContext,
      threadKey: phone,
      propertyId: participant.property_id || activeContext.propertyId,
      sourceView: activeContext.sourceView ?? 'inbox',
    }, { preserveCurrentViews: true })
    setSelectedThreadKey(phone)
    setSelectedId(phone)
  }, [activeContext, handleSelect, setActiveContext, threads])

  const handleTryNextEligible = useCallback((participant: PropertyParticipant) => {
    handleParticipantSelect(participant)
  }, [handleParticipantSelect])

  useEffect(() => {
    const propertyId = selected?.propertyId || effectiveActiveContext.propertyId
    const selectedPhone = selected?.canonicalE164 || selected?.bestPhone || selected?.sellerPhone || selected?.threadKey
    if (!propertyId) {
      setPropertyParticipants([])
      setSelectedParticipant(null)
      setMasterOwnerHouseholdLabel(null)
      setNextEligibleContact(null)
      return
    }

    let cancelled = false
    const controller = new AbortController()
    setPropertyParticipantsLoading(true)
    const fallbackParticipant = selected ? {
      participant_id: `${propertyId}:${selectedPhone || selected.id}`,
      property_id: propertyId,
      canonical_e164: selectedPhone || selected.canonicalE164 || selected.bestPhone || null,
      display_name: resolveThreadPrimaryName(selected) || selected.subject || null,
      relationship_to_property: String((selected as unknown as Record<string, unknown>).contact_identity_class || 'respondent'),
    } satisfies PropertyParticipant : null

    const loadParticipants = () => {
      if (cancelled) return
      void fetchPropertyParticipants(propertyId, selectedPhone || null, controller.signal)
        .then((res) => {
          if (cancelled) return
          if (!res.ok) {
            setPropertyParticipants(fallbackParticipant ? [fallbackParticipant] : [])
            setSelectedParticipant(fallbackParticipant)
            return
          }
          const payload = (res.data ?? {}) as PropertyParticipantGraph
          const participants = Array.isArray(payload.participants) && payload.participants.length > 0
            ? payload.participants
            : (fallbackParticipant ? [fallbackParticipant] : [])
          setPropertyParticipants(participants)
          setMasterOwnerHouseholdLabel(payload.master_owner_household_label || null)
          setNextEligibleContact(payload.next_eligible_contact || null)
          const current = participants.find((row) => String(row.canonical_e164 ?? '').trim() === String(selectedPhone ?? '').trim())
            || payload.selected_participant
            || participants[0]
            || fallbackParticipant
          setSelectedParticipant(current)
        })
        .catch(() => {
          if (!cancelled) {
            setPropertyParticipants(fallbackParticipant ? [fallbackParticipant] : [])
            setSelectedParticipant(fallbackParticipant)
          }
        })
        .finally(() => {
          if (!cancelled) setPropertyParticipantsLoading(false)
        })
    }

    loadParticipants()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [effectiveActiveContext.propertyId, selectedKeyForEffect, selected?.propertyId])

  const handleUniversalEntityContextChange = useCallback((next: UniversalEntityContext, options?: { pushHistory?: boolean }) => {
    publishingUniversalRef.current = true
    setUniversalEntityContext(next)
    setUniversalEntityContextSnapshot(next)
    setActiveContext(activeInboxFromUniversalContext(next, 'entity_graph'), { preserveCurrentViews: true })
    if (options?.pushHistory) syncUniversalContextToUrl(next, 'push')
  }, [setActiveContext])

  useEffect(() => {
    return subscribeUniversalEntityContext((next) => {
      setUniversalEntityContext(next)
      if (publishingUniversalRef.current) {
        publishingUniversalRef.current = false
        return
      }
      if (!hasEntityAnchor(syncPayloadFromUniversal(next, 'inbox'))) return
      const active = syncPayloadFromUniversal(next, activeContext.sourceView ?? 'inbox')
      setActiveContextState((current) => ({ ...current, ...active }))
      const match = findThreadForActiveContext(threads, active)
      if (match) {
        setSelectedId(match.id)
        setSelectedThreadKey(match.threadKey || match.id)
        setLayoutState((layout) => ({ ...layout, selectedThreadId: match.id }))
        selectedThreadFallbackRef.current = match
      } else if (active.threadKey) {
        setSelectedThreadKey(active.threadKey)
      }
    })
  }, [activeContext.sourceView, threads])

  useEffect(() => {
    const active = effectiveActiveContext
    const hasAnchor = Boolean(active.threadKey || active.propertyId || active.masterOwnerId || active.sellerId || active.opportunityId)
    if (!hasAnchor) return
    if (selected && activeContextMatchesThread(active, selected) && dealContext) return

    let cancelled = false
    const controller = new AbortController()
    const fallback = dealContextFromActiveInbox(active)
    const cacheKey = active.threadKey || active.propertyId || active.masterOwnerId || active.sellerId || ''
    const cachedDealContext = cacheKey ? dealContextCacheRef.current[cacheKey] : null
    if (cachedDealContext) {
      setDealContext(cachedDealContext)
    } else if (fallback && !dealContext) {
      setDealContext(fallback)
    }

    void (async () => {
      try {
        let hydrated: DealContext | null = cachedDealContext ?? null
        if (!hydrated && active.threadKey) {
          hydrated = await getDealContextByThread(active.threadKey, controller.signal)
        }
        if (!hydrated && active.propertyId) {
          hydrated = await getDealContextByProperty(active.propertyId, controller.signal)
        }
        if (cancelled || !hydrated) return
        if (cacheKey) dealContextCacheRef.current[cacheKey] = hydrated
        if (selected && !activeContextMatchesThread(active, selected)) return
        setDealContext((current) => {
          if (!current) return hydrated
          return {
            ...hydrated,
            ...current,
            ownerName: current.ownerName || hydrated.ownerName,
            propertyAddress: current.propertyAddress || hydrated.propertyAddress,
            market: current.market || hydrated.market,
          }
        })
      } catch {
        /* hydration is best-effort */
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    dealContext,
    effectiveActiveContext.masterOwnerId,
    effectiveActiveContext.opportunityId,
    effectiveActiveContext.propertyId,
    effectiveActiveContext.sellerId,
    effectiveActiveContext.threadKey,
    selected,
  ])

  const syncOpportunityContext = useCallback((opportunity: PipelineOpportunity, mode: 'select' | 'preview') => {
    const { active, universal } = syncPayloadFromOpportunity(opportunity)
    if (mode === 'preview') {
      setPreviewContext(active)
      patchUniversalEntityContextSnapshot(universal, { silent: true })
      return
    }
    setPreviewContext(null)
    setMessagesLoading(true)
    setSelectedMessages([])
    publishingUniversalRef.current = true
    setActiveContextState((current) => ({ ...current, ...active }))
    setUniversalEntityContext(universal)
    setUniversalEntityContextSnapshot(universal)
    const match = findThreadForActiveContext(threads, active)
    if (match) {
      setSelectedId(match.id)
      setSelectedThreadKey(match.threadKey || match.id)
      setLayoutState((layout) => ({ ...layout, selectedThreadId: match.id }))
      selectedThreadFallbackRef.current = match
    } else if (active.threadKey) {
      setSelectedThreadKey(active.threadKey)
    }
  }, [threads])

  const clearOpportunityPreview = useCallback(() => {
    setPreviewContext(null)
  }, [])

  const handleEntityGraphAction = useCallback((action: EntityGraphAction, context: UniversalEntityContext) => {
    const threadMatch = context.threadKey
      ? threads.find((thread) => (thread.threadKey || thread.id) === context.threadKey)
      : threads.find((thread) =>
        (context.propertyId && thread.propertyId === context.propertyId)
        || (context.masterOwnerId && thread.ownerId === context.masterOwnerId)
        || (context.prospectId && thread.prospectId === context.prospectId),
      )

    const routed = routeEntityGraphAction(action, context, {
      onOpenThread: () => {
        if (threadMatch) handleSelect(threadMatch.id)
        else if (context.threadKey) setActiveContext({ threadKey: context.threadKey, ...activeInboxFromUniversalContext(context, 'list') }, { openThread: true })
      },
      onOpenConversationDraft: () => {
        if (threadMatch) {
          handleSelect(threadMatch.id)
          focusWorkspaceView('sms_thread')
          return
        }
        setActiveContext(activeInboxFromUniversalContext(context, 'list'), { openThread: true, focusView: 'sms_thread' })
      },
      onOpenDealIntelligence: () => {
        if (threadMatch) handleOpenDealIntelligence(threadMatch.id)
        else if (context.propertyId) setActiveContext({ propertyId: context.propertyId, ...activeInboxFromUniversalContext(context, 'list') }, { preserveCurrentViews: true })
        setSelectedWorkspaceViews(['deal_intelligence'])
      },
      onOpenSellerAutomation: () => {
        if (threadMatch) handleOpenSellerAutomation(threadMatch.id)
        else {
          openSellerAutomationStudioFromEntity({
            propertyId: context.propertyId,
            prospectId: context.prospectId,
            masterOwnerId: context.masterOwnerId,
            threadKey: context.threadKey,
            preservePath: true,
          })
          setSelectedWorkspaceViews(['workflow_studio'])
        }
      },
      onOpenMap: () => setSelectedWorkspaceViews(['command_map']),
      onOpenCompIntelligence: () => setSelectedWorkspaceViews(['comp_intelligence']),
      onOpenBuyerMatch: () => setSelectedWorkspaceViews(['buyer_match']),
    })
    if (!routed) {
      if (DEV) console.warn('[InboxPage] unhandled entity graph action', action)
    }
  }, [focusWorkspaceView, handleOpenDealIntelligence, handleOpenSellerAutomation, handleSelect, setActiveContext, threads])

  useEffect(() => {
    if (!selected) return
    // Cross-app sources own context until the inbox row matches.
    if (activeContext.sourceView && activeContext.sourceView !== 'inbox' && hasEntityAnchor(activeContext)) {
      if (!activeContextMatchesThread(activeContext, selected)) return
    }
    setUniversalEntityContext((current) => {
      const merged = mergeUniversalContexts(current, universalContextFromActiveInbox({
        ...activeContext,
        threadKey: selected.threadKey || selected.id,
        propertyId: selected.propertyId,
        sellerId: selected.ownerId,
        masterOwnerId: selected.ownerId,
        prospectId: selected.prospectId,
      }))
      patchUniversalEntityContextSnapshot(merged, { silent: true })
      return merged
    })
  }, [activeContext, selected])

  useEffect(() => {
    const handlePopState = () => {
      const parsed = parseEntityGraphDeepLink(window.location.pathname)
      if (parsed) handleUniversalEntityContextChange(parsed, { pushHistory: false })
      else handleUniversalEntityContextChange(EMPTY_UNIVERSAL_ENTITY_CONTEXT, { pushHistory: false })
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [handleUniversalEntityContextChange])

  useEffect(() => {
    const handleCommandAction = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {}
      const kind = String(detail.kind || '')
      const threadId = typeof detail.threadId === 'string' ? detail.threadId : null
      const view = typeof detail.view === 'string' ? detail.view as InboxWorkspaceView : null
      const sourceModeFromEvent = typeof detail.sourceMode === 'string' ? detail.sourceMode as 'all_sellers' | 'conversations' : null

      if (kind === 'focus_workspace_view' && view) {
        handleFocusWorkspaceView(view)
        return
      }
      if (kind === 'focus_buyer') {
        const buyerKey = typeof detail.buyerKey === 'string' ? detail.buyerKey : ''
        if (!buyerKey) return
        setSelectedBuyerKey(buyerKey)
        handleFocusWorkspaceView('buyer_match')
        return
      }
      if (kind === 'focus_queue_row') {
        const queueId = typeof detail.queueId === 'string' ? detail.queueId : ''
        if (!queueId) return
        const queueItem = queueModel?.items.find((item) => item.queueId === queueId || item.id === queueId) ?? null
        if (queueItem) {
          setActiveContext(buildContextFromQueueItem(queueItem, 'queue'), { preserveCurrentViews: true })
        } else {
          setActiveContext({
            queueId,
            sourceView: 'queue',
            intent: 'open_queue',
          }, {
            preserveCurrentViews: true,
            focusView: 'queue',
            addViewIfMissing: true,
          })
        }
        handleFocusWorkspaceView('queue')
        return
      }
      if (kind === 'focus_market') {
        const market = typeof detail.market === 'string' ? detail.market : ''
        if (!market) return
        setAdvancedFilters((current) => ({ ...current, market }))
        setCommandMapMarket(market)
        handleFocusWorkspaceView('command_map')
        return
      }
      if (kind === 'focus_thread' && threadId) {
        if (view) handleFocusWorkspaceView(view)
        handleSelect(threadId)
        return
      }
      if (kind === 'set_inbox_source_mode' && sourceModeFromEvent) {
        setSourceMode(sourceModeFromEvent)
        return
      }
      if (kind === 'apply_inbox_view') {
        const nextView = typeof detail.view === 'string' ? detail.view as InboxViewSelectValue : 'priority'
        setViewFilter(nextView)
        setSelectedId(null)
        setSelectedThreadKey(null)
        selectedThreadFallbackRef.current = null
        void refreshInbox({
          filters: {
            view: nextView,
            stage: stageFilter,
            query: searchQuery,
            advanced: advancedFilters,
          },
          cursor: null,
          limit: 100,
        })
        if (sourceModeFromEvent === 'all_sellers' || nextView === 'not_contacted') {
          setSourceMode('all_sellers')
        }
        handleFocusWorkspaceView('thread')
        return
      }
      if (kind === 'clear_inbox_filters') {
        handleResetFilters()
        return
      }
      if (kind === 'set_map_theme') {
        const theme = typeof detail.theme === 'string' ? detail.theme as MapStyleMode : null
        if (!theme) return
        setCommandMapTheme(theme)
        handleFocusWorkspaceView('command_map')
        return
      }
      if (kind === 'queue_dry_run') {
        handleFocusWorkspaceView('queue')
        return
      }
      if (import.meta.env.DEV) {
        console.warn('[InboxPage GlobalCommand] No local handler for action', detail)
      }
    }

    window.addEventListener(GLOBAL_COMMAND_ACTION_EVENT, handleCommandAction as EventListener)
    return () => window.removeEventListener(GLOBAL_COMMAND_ACTION_EVENT, handleCommandAction as EventListener)
  }, [advancedFilters, handleFocusWorkspaceView, handleResetFilters, handleSelect, queueModel?.items, refreshInbox, searchQuery, setSourceMode, setActiveContext, stageFilter])

  const handleMapSellerContext = useCallback((context: {
    propertyId?: string
    masterOwnerId?: string
    sourceView: 'map'
    intent: 'open_seller' | 'open_queue'
  }) => {
    const propertyId = context.propertyId
    const masterOwnerId = context.masterOwnerId
    setActiveContext({
      propertyId,
      masterOwnerId,
      sellerId: masterOwnerId,
      entityType: propertyId ? 'property' : masterOwnerId ? 'master_owner' : null,
      entityId: propertyId || masterOwnerId || null,
      sourceView: context.sourceView,
      intent: context.intent,
    }, {
      preserveCurrentViews: true,
      focusView: context.intent === 'open_queue' ? 'queue' : undefined,
      addViewIfMissing: context.intent === 'open_queue',
    })
  }, [setActiveContext])

  const handleOperatorAction = useCallback(async (id: string, action: string, payload?: Record<string, unknown>) => {
    const thread = threads.find((t) => t.id === id)
    if (!thread) return

    if (DEV) console.log(`[OperatorAction] ${action} on ${id.slice(-8)}`)

    if (action.startsWith('cancel_queue:') || action.startsWith('edit_queue:') || action.startsWith('approve_queue:')) {
      await handleThreadAction(thread, action)
      if (action.startsWith('edit_queue:')) {
        const text = String(payload?.text ?? '').trim()
        if (text) setDraftText(text)
        setScheduledTemplatePayload({ text, template: null })
        setSchedulePanelOpen(true)
      }
      return
    }

    switch (action) {
      case 'refetch':
        setMessageRefetchKey((k) => k + 1)
        break
      case 'auto_reply':
        await handleWorkflowMutation('Auto-Reply: Queueing...', () => executeAutoReply(thread, null, { dryRun: autonomyControls.dryRun }), { skipRefresh: false })
        break
      case 'mark_hot':
// ... rest of switch
        await handleWorkflowMutation('Lead: HOT', () => markThreadHot(thread), { skipRefresh: true })
        break
      case 'snooze': {
        const optimistic = buildOptimisticThreadPatch('snooze', thread)
        setOptimisticPatches((prev) => ({ ...prev, [thread.id]: { ...prev[thread.id], ...optimistic } }))
        markOptimisticPatch('snooze', thread.id, optimistic as Record<string, unknown>)
        await handleWorkflowMutation('Thread: Snoozed', () => snoozeThread(thread), { skipRefresh: true })
        break
      }
        break
      case 'pause_automation':
        await handleWorkflowMutation('Automation: Paused', () => pauseAutomation(thread), { skipRefresh: true })
        break
      case 'resume_automation':
        await handleWorkflowMutation('Automation: Resumed', () => resumeAutomation(thread), { skipRefresh: true })
        break
      case 'suppress':
        await handleWorkflowMutation('Thread: Suppressed (DNC)', () => suppressThread(thread), { skipRefresh: true })
        break
      case 'retry_send':
        await handleWorkflowMutation('Timeline: Retrying...', () => retryFailedSend(thread), { skipRefresh: true })
        break
      case 'archive':
        await handleThreadAction(thread, 'archive')
        break
      case 'unarchive':
        await handleThreadAction(thread, 'unarchive')
        break
      case 'star':
        await handleThreadAction(thread, 'star')
        break
      case 'unstar':
        await handleThreadAction(thread, 'unstar')
        break
      case 'pin':
        await handleThreadAction(thread, 'pin')
        break
      case 'unpin':
        await handleThreadAction(thread, 'unpin')
        break
      case 'read':
        await handleThreadAction(thread, 'read')
        break
      case 'unread':
        await handleThreadAction(thread, 'unread')
        break
      case 'open_dossier':
        setActiveOverlay('dossier')
        break
      case 'add_note':
        setActiveOverlay('dossier')
        break
      case 'mark_reviewed':
        await handleThreadAction(thread, 'read')
        break
      case 'open_property':
        handleOpenDealIntelligence(thread.id)
        break
      case 'ai_assist':
        setActiveOverlay('ai')
        break
      default:
        console.warn('[OperatorAction] Unknown action', action)
    }
  }, [threads, handleWorkflowMutation, handleThreadAction, handleOpenDealIntelligence, setActiveOverlay, DEV])


  const handleSend = useCallback(async (text: string, template?: SmsTemplate | null) => {
    if (!selected || !text.trim() || isSending) return
    if (selectedSuppressed) {
      emitNotification({
        title: 'Suppressed Thread',
        detail: 'No message needed — suppression logged.',
        severity: 'warning',
      })
      return
    }

    const clientSendId = crypto.randomUUID()
    const optimisticMessage = buildOptimisticOutboundMessage(selected, text, clientSendId, template)
    markOptimisticPatch('message_pending', selected.id, { body: optimisticMessage.body, deliveryStatus: optimisticMessage.deliveryStatus })

    optimisticMessageMapRef.current.set(clientSendId, optimisticMessage.id)
    inFlightSendMapRef.current.add(clientSendId)
    console.log('[MessageLifecycle] optimistic created', { clientSendId, threadId: selected.id, body: text.trim().slice(0, 40) })

    setPendingMessagesByThread((current) => ({
      ...current,
      [selected.id]: [...(current[selected.id] ?? []), optimisticMessage],
    }))

    setIsSending(true)
    try {
      let result = await sendInboxMessageNow(selected, text, {
        selectedTemplate: template ?? null,
        threadContext,
        clientSendId,
      })
      const overrideAllowed = !result.ok && result.operatorOverrideAllowed === true
      if (overrideAllowed) {
        const retryMessage =
          result.backendReason === 'recent_delivery_failures'
            ? 'Recent delivery issue detected. Retry anyway?'
            : result.backendReason === 'content_blocked'
              ? 'Potential content issue detected. Send anyway?'
              : 'This send was blocked, but operator override is allowed. Retry anyway?'
        const retry = window.confirm(retryMessage)
        if (retry) {
          result = await sendInboxMessageNow(selected, text, {
            selectedTemplate: template ?? null,
            threadContext,
            clientSendId,
            operatorOverride: true,
          })
        }
      }
      emitNotification({
        title: result.ok
          ? 'Message Sent'
          : 'Send Failed',
        detail: result.ok
          ? (result.deliveryStatus === 'delivered'
            ? 'Message delivered.'
            : 'Provider accepted the message.')
          : (result.errorMessage ?? 'Could not queue message for send'),
        severity: result.ok
          ? 'success'
          : 'critical',
      })

      if (!result.ok) {
        setPendingMessagesByThread((current) => ({
          ...current,
          [selected.id]: dedupeMessages((current[selected.id] ?? []).map((pending) => (
            pending.id !== optimisticMessage.id
              ? pending
              : {
                  ...pending,
                  deliveryStatus: 'failed',
                  rawStatus: 'failed',
                  error: result.errorMessage,
                  metadata: { ...(pending.metadata ?? {}), client_send_id: clientSendId },
                  developerMeta: {
                    ...(pending.developerMeta ?? {}),
                    client_send_id: clientSendId,
                    ...(result.queueId ? { queue_id: result.queueId } : {}),
                    ...(result.providerMessageSid ? { provider_message_sid: result.providerMessageSid } : {}),
                    ...(result.messageEventId ? { message_event_id: result.messageEventId } : {}),
                  },
                }
          ))),
        }))
      } else {
        console.log('[MessageLifecycle] send merged', { clientSendId, queueId: result.queueId, status: result.deliveryStatus })

        // Optimistically update the thread so it clears from the unread queue instantly
        setOptimisticPatches((prev) => ({
          ...prev,
          [selected.id]: {
            ...prev[selected.id],
            isRead: true,
            unread: false,
            unreadCount: 0,
            status: 'replied',
            inboxStatus: 'waiting',
            latestMessageBody: text.trim(),
            latestMessageAt: optimisticMessage.createdAt,
            latestDirection: 'outbound',
            inboxCategory: 'follow_up'
          }
        }))

        setPendingMessagesByThread((current) => ({
          ...current,
          [selected.id]: dedupeMessages((current[selected.id] ?? []).map((pending) => (
            pending.id !== optimisticMessage.id
              ? pending
              : {
                  ...pending,
                  deliveryStatus: result.deliveryStatus || 'sent',
                  rawStatus: result.deliveryStatus || 'sent',
                  metadata: { ...(pending.metadata ?? {}), client_send_id: clientSendId },
                  developerMeta: {
                    ...(pending.developerMeta ?? {}),
                    client_send_id: clientSendId,
                    queue_id: result.queueId ?? '',
                    provider_message_sid: result.providerMessageSid ?? '',
                    ...(result.messageEventId ? { message_event_id: result.messageEventId } : {}),
                  },
                }
          ))),
        }))

        void refreshInbox({
          filters: currentInboxQuery,
          cursor: null,
          limit: 100,
          _force: true,
          _timeoutMode: 'manual_bucket_switch',
          _refreshReason: 'send_success',
        })
      }

      setDraftText('')
    } finally {
      inFlightSendMapRef.current.delete(clientSendId)
      setIsSending(false)
    }
  }, [currentInboxQuery, isSending, refreshInbox, selected, selectedSuppressed, threadContext])

  const handleSendTemplate = useCallback(async (payload: TemplateActionPayload) => {
    await handleSend(payload.text, payload.template)
  }, [handleSend])

  const handleQueueTemplate = useCallback(async (payload: TemplateActionPayload) => {
    if (!selected || !payload.text.trim()) return
    const result = await queueReplyFromInbox(selected, payload.text, {
      selectedTemplate: payload.template,
      threadContext,
    })
    emitNotification({
      title: result.ok ? 'Reply Queued For Approval' : 'Queue Failed',
      detail: result.ok
        ? `Queue row ${result.queueId ?? 'created'} is waiting for approval`
        : (result.errorMessage ?? 'Could not queue reply'),
      severity: result.ok ? 'success' : 'critical',
    })
    if (result.ok) {
      setDraftText('')
    }
  }, [selected, threadContext])


  const handleSelectCalendarEvent = useCallback((event: import('../../lib/data/calendarData').CalendarEvent) => {
    setActiveContext(buildContextFromCalendarEvent(event), { preserveCurrentViews: true })
    if (event.threadId) {
      const match = threads.find((thread) => thread.id === event.threadId || (thread.threadKey || thread.id) === event.threadId)
      if (match) {
        setSelectedId(match.id)
        setSelectedThreadKey(match.threadKey || match.id)
      }
    }
  }, [setActiveContext, threads])

  const handleActivityNavigation = useCallback((event: import('../../views/map/commandMapLiveActivity').CommandMapActivityEvent) => {
    const openThread = event.targetView === 'thread' || event.type === 'new_reply' || event.type === 'positive_reply'
    const focusView: InboxWorkspaceView =
      event.targetView === 'queue'
        ? 'queue'
        : event.targetView === 'calendar'
        ? 'calendar'
        : event.targetView === 'deal'
        ? 'deal_intelligence'
        : openThread
        ? 'sms_thread'
        : 'command_map'

    setActiveContext(buildContextFromActivityEvent(event), {
      focusView,
      openThread,
      focusMap: true,
      centerMap: true,
      openSellerCard: true,
    })
  }, [setActiveContext])

  const handleScheduleTemplate = useCallback((payload: TemplateActionPayload) => {
    setScheduledTemplatePayload(payload)
    setDraftText(payload.text)
    setSchedulePanelOpen(true)
  }, [])

  const insertAiSuggestion = useCallback((suggestionText: string) => {
    setDraftText(suggestionText)
  }, [])

  const updateAutonomyControl = useCallback(async (
    patch: Partial<AutonomyControlState>,
    title: string,
    detail: string,
  ) => {
    setAutonomyControls((current) => ({ ...current, ...patch }))
    emitNotification({ title, detail, severity: patch.autonomousMode === 'emergency_stop' ? 'critical' : 'success' })
    await logInboxActivity({
      event_type: 'ai_copilot_interaction',
      thread_key: selected?.threadKey || '__system__',
      actor: 'operator',
      title,
      description: detail,
      metadata: { autonomy_patch: patch },
      undo_payload: null,
    })
  }, [selected?.threadKey])

  const commandPaletteCommands = useMemo<InboxCmd[]>(() => {
    const commands: InboxCmd[] = [
      {
        id: 'focus-search',
        label: 'Focus Search',
        category: 'Navigation',
        shortcut: 'Cmd+Shift+F',
        keywords: ['find', 'search', 'seller', 'address'],
        action: () => window.dispatchEvent(new CustomEvent('nexus:focus-search')),
      },
      {
        id: 'open-ai',
        label: 'Open AI Assist',
        category: 'AI',
        shortcut: 'Cmd+K',
        keywords: ['copilot', 'assistant', 'draft'],
        action: () => setActiveOverlay('ai'),
      },
      {
        id: 'autonomy-emergency-stop',
        label: autonomyControls.autonomousMode === 'emergency_stop' ? 'Resume Autonomous Engine' : 'Emergency Stop Automation',
        category: 'AI',
        keywords: ['pause', 'emergency', 'automation', 'governance'],
        action: () => {
          void updateAutonomyControl(
            { autonomousMode: autonomyControls.autonomousMode === 'emergency_stop' ? 'approval_required' : 'emergency_stop' },
            autonomyControls.autonomousMode === 'emergency_stop' ? 'Autonomous Engine Resumed' : 'Emergency Stop Engaged',
            autonomyControls.autonomousMode === 'emergency_stop'
              ? 'System moved back into approval-required mode.'
              : 'All autonomous execution should be treated as halted until reviewed.',
          )
        },
      },
      {
        id: 'autonomy-approval-mode',
        label: autonomyControls.autonomousMode === 'approval_required' ? 'Enable Full Autonomy Mode' : 'Require Approval For Autonomy',
        category: 'AI',
        keywords: ['approval', 'human review', 'governance'],
        action: () => {
          void updateAutonomyControl(
            { autonomousMode: autonomyControls.autonomousMode === 'approval_required' ? 'active' : 'approval_required' },
            autonomyControls.autonomousMode === 'approval_required' ? 'Full Autonomy Enabled' : 'Approval Mode Enabled',
            autonomyControls.autonomousMode === 'approval_required'
              ? 'Autonomous execution restored for eligible threads.'
              : 'Negotiation and sensitive automations now require operator approval.',
          )
        },
      },
      {
        id: 'open-map',
        label: 'Open Map',
        category: 'Map',
        shortcut: 'Cmd+M',
        keywords: ['map', 'pin', 'property'],
        action: () => setLayoutState(openMapMode),
      },
      {
        id: 'open-dossier',
        label: 'Open Dossier Overlay',
        category: 'Layout',
        keywords: ['briefing', 'dossier', 'intel'],
        requiresThread: true,
        action: () => setActiveOverlay('dossier'),
      },
      {
        id: 'activity-feed',
        label: 'Open Activity Feed',
        category: 'Navigation',
        keywords: ['activity', 'timeline', 'audit'],
        action: () => setActiveOverlay('activity'),
      },
      {
        id: 'queue-hot-leads',
        label: 'Jump To Hot Leads',
        category: 'Filters',
        shortcut: 'Alt+1',
        keywords: ['hot', 'priority', 'leads'],
        action: () => applySavedPreset('positive_hot'),
      },
      {
        id: 'queue-needs-review',
        label: 'Jump To Needs Review',
        category: 'Filters',
        shortcut: 'Alt+2',
        keywords: ['review', 'manual', 'operator'],
        action: () => applySavedPreset('manual_review'),
      },
      {
        id: 'queue-new-inbound',
        label: 'Jump To New Inbound',
        category: 'Filters',
        shortcut: 'Alt+3',
        keywords: ['inbound', 'reply', 'new'],
        action: () => applySavedPreset('needs_reply'),
      },
    ]

    if (selected && commandIntel) {
      const firstSuggestion = commandIntel.suggestions[0]
      if (firstSuggestion) {
        commands.push({
          id: 'insert-ai-reply',
          label: `Insert ${firstSuggestion.label}`,
          category: 'Reply',
          requiresThread: true,
          keywords: ['reply', 'draft', 'suggested'],
          action: () => insertAiSuggestion(firstSuggestion.text),
        })
      }

      commands.push(
        {
          id: 'set-needs-review',
          label: 'Route Thread To Needs Review',
          category: 'Status',
          requiresThread: true,
          keywords: ['review', 'manual', 'escalate'],
          action: () => void handleStatusChange('needs_review'),
        },
        {
          id: 'set-queued',
          label: 'Mark Thread Queued',
          category: 'Status',
          requiresThread: true,
          keywords: ['queue', 'automation', 'follow-up'],
          action: () => void handleStatusChange('queued'),
        },
        {
          id: 'advance-stage',
          label: 'Advance Seller Stage',
          category: 'Seller',
          requiresThread: true,
          keywords: ['advance', 'stage', 'workflow'],
          action: () => {
            const stageOrder: SellerStage[] = [
              'ownership_check',
              'interest_probe',
              'seller_response',
              'price_discovery',
              'condition_details',
              'offer_reveal',
              'negotiation',
              'contract_path',
              'dead_suppressed',
            ]
            const currentIndex = stageOrder.indexOf(selected.conversationStage)
            const nextStage = stageOrder[Math.min(stageOrder.length - 1, Math.max(0, currentIndex + 1))]
            void handleStageChange(nextStage)
          },
        },
        {
          id: 'schedule-followup',
          label: 'Schedule Follow-Up',
          category: 'Schedule',
          requiresThread: true,
          keywords: ['schedule', 'follow up', 'later'],
          action: () => setSchedulePanelOpen(true),
        },
        {
          id: 'route-to-automation',
          label: 'Route Thread To Automation',
          category: 'AI',
          requiresThread: true,
          keywords: ['automation', 'route', 'eligible'],
          action: () => void handleStatusChange('queued'),
        },
        {
          id: 'route-to-manual-review',
          label: 'Escalate Thread To Manual Review',
          category: 'AI',
          requiresThread: true,
          keywords: ['manual', 'review', 'escalate'],
          action: () => void handleStatusChange('needs_review'),
        },
        {
          id: 'star-thread',
          label: selected.isStarred ? 'Remove Star' : 'Star Thread',
          category: 'Seller',
          requiresThread: true,
          keywords: ['star', 'priority', 'bookmark'],
          action: () => handleToggleStar(),
        },
      )
    }

    return commands
  }, [
    applySavedPreset,
    autonomyControls.autonomousMode,
    commandIntel,
    handleStageChange,
    handleStatusChange,
    handleToggleStar,
    insertAiSuggestion,
    selected,
    setActiveOverlay,
    updateAutonomyControl,
  ])

  // Full-page loading guard removed: bucket switches must never flash a blank page.
  // InboxSidebar shows an empty list while the fetch is in flight; that is intentional.

  const { inboxMode, mapMode, activeOverlay } = layoutState
  const layoutClasses = getLayoutClassNames(layoutState)
  const mapOpen = mapMode !== 'off'
  const dossierOpen = activeOverlay === 'dossier'
  const aiOpen = activeOverlay === 'ai'
  const keysOpen = activeOverlay === 'keys'

  const renderViews: InboxWorkspaceView[] = selectedWorkspaceViews
  const workspaceBlocked = selectedWorkspacePreset.status !== 'ready'

  const isMultiView = renderViews.length > 1
  const isDealDeskLayout = selectedWorkspacePreset.key === 'deal_desk'
    || (isMultiView
      && renderViews.includes('thread')
      && renderViews.includes('sms_thread')
      && renderViews.includes('deal_intelligence'))
  const isCustomMultiView = isMultiView && isDealDeskLayout
  const isCommandMapView = !isMultiView && activeWorkspaceView === 'command_map'
  const isDealIntelligenceView = !isMultiView && activeWorkspaceView === 'deal_intelligence'
  const _isEntityGraphView = !isMultiView && activeWorkspaceView === 'entity_graph'
  void _isEntityGraphView
  const useFullscreenShell = !workspaceBlocked && !isMultiView
  const isDoubleSided = inboxMode === 'full_double'

  const renderWorkspaceStatusShell = () => {
    const statusLabel = selectedWorkspacePreset.status === 'backend_not_ready' ? 'Backend Not Ready' : 'Coming Soon'
    const detail = selectedWorkspacePreset.status === 'backend_not_ready'
      ? 'This workspace preset is wired, but required backend surfaces are not ready yet.'
      : 'This workspace preset is planned and will be enabled as modules ship.'
    return (
      <section className="nx-workspace-status-shell">
        <div className="nx-workspace-status-shell__badge">{statusLabel}</div>
        <h2>{selectedWorkspacePreset.label}</h2>
        <p>{selectedWorkspacePreset.description}</p>
        <small>{detail}</small>
      </section>
    )
  }

  const handleSaveCurrentWorkspaceLayout = () => {
    persistWorkspaceViewOverride(selectedWorkspaceKey, selectedWorkspaceViews)
    emitNotification({
      title: 'Layout Saved',
      detail: 'Current workspace active views were saved locally.',
      severity: 'success',
    })
  }

  const handleResetWorkspaceLayout = () => {
    const preset = NEXUS_WORKSPACE_PRESETS.find((workspace) => workspace.key === selectedWorkspaceKey)
    if (!preset) {
      setLayoutState(resetLayoutMode)
      return
    }
    clearWorkspaceViewOverride(selectedWorkspaceKey)
    const nextViews = [...preset.views]
    setSelectedWorkspaceViews(nextViews)
    setWorkspaceWidthOverrides(resolvePresetWidthOverrides(nextViews, preset.widths))
    setLayoutState(resetLayoutMode)
    emitNotification({
      title: 'Layout Reset',
      detail: `${preset.label} restored to default active views.`,
      severity: 'success',
    })
  }

  const renderSmsThreadPane = (
    paneWidth: ViewWidthPercent = '100',
    layoutMode: ReturnType<typeof getViewLayoutMode> = getViewLayoutMode(paneWidth),
  ) => (
    <section
      className={cls(
        'nx-workspace-pane-surface',
        'nx-workspace-pane-surface--sms-thread',
        `is-width-${paneWidth}`,
        `is-layout-${layoutMode}`,
      )}
    >
      {isMobile ? (
        <MobileThreadHeader
          thread={selected}
          onBack={handleMobileBack}
          onOpenIntelligence={() => handleOpenDealIntelligence(selected?.id ?? null)}
          onOpenWorkflow={selected ? () => {
            openSellerAutomationStudioFromEntity({
              propertyId: selected.propertyId ?? undefined,
              threadKey: selected.threadKey ?? selected.id,
            })
            handleFocusWorkspaceView('workflow_studio')
          } : undefined}
        />
      ) : null}
      <ChatThread
        thread={selected}
        messages={displayedMessagesWithTranslation}
        loading={messagesLoading}
        isSuppressed={selectedSuppressed}
        isStarred={selected?.isStarred ?? false}
        onTogglePin={handleTogglePin}
        onToggleStar={handleToggleStar}
        onToggleArchive={handleToggleArchive}
        onThreadAction={handleOperatorAction}
        onOpenDebug={() => setDebugModalOpen(true)}
        searchQuery={searchQuery}
        layoutMode={layoutMode}
        threadTranslations={threadTranslations}
        sellerLanguageLabel={sellerLanguageLabel}
        isTranslatingThread={threadTranslationLoading}
        onTranslateThread={handleTranslateThread}
        backgroundLoading={contextLoading}
        hasOlderMessages={hasOlderMessages}
        olderMessagesLoading={olderMessagesLoading}
        onLoadOlder={handleLoadOlderMessages}
        selectedParticipant={selectedParticipant}
        masterOwnerHouseholdLabel={masterOwnerHouseholdLabel}
      />

      <ActiveProspectCard
        participants={propertyParticipants}
        selectedParticipant={selectedParticipant}
        masterOwnerHousehold={masterOwnerHouseholdLabel || (selected ? `${resolveThreadOwnerName(selected)} household` : null)}
        loading={propertyParticipantsLoading}
        onSelectParticipant={handleParticipantSelect}
        onTryNextEligible={handleTryNextEligible}
        nextEligiblePreview={nextEligibleContact}
      />

      <Composer
        draftText={draftText}
        onSend={handleSend}
        isSending={isSending}
        onOpenSchedule={(currentDraft) => {
          setScheduledTemplatePayload({ text: currentDraft, template: null })
          setSchedulePanelOpen(true)
        }}
        onAI={() => setActiveOverlay('ai')}
        thread={selected}
        threadContext={threadContext}
        onSendTemplate={handleSendTemplate}
        onQueueTemplate={handleQueueTemplate}
        onScheduleTemplate={handleScheduleTemplate}
        onQuickAction={(action) => handleOperatorAction(selected?.id ?? '', action)}
        disabled={!selected || selectedSuppressed}
        disabledReason={!selected ? 'Select a thread to compose' : 'Messaging disabled for suppressed thread'}
        aiSuggestions={adaptiveSuggestions.length > 0 ? adaptiveSuggestions : (commandIntel?.suggestions ?? [])}
        sellerLanguageLabel={sellerLanguageLabel}
        isSellerLanguageEnglish={isEnglishLanguage(sellerLanguageCode)}
        isTranslatingDraft={draftTranslationLoading}
        onTranslateDraft={handleTranslateDraft}
        autoTranslateDraft={!!sellerLanguageCode && !isEnglishLanguage(sellerLanguageCode)}
        layoutMode={layoutMode}
      />
    </section>
  )

  const renderInboxRailPane = (
    paneMode: 'single' | 'multi' = 'single',
    paneWidth: ViewWidthPercent = '100',
  ) => (
    <section
      className={cls(
        'nx-workspace-pane-surface',
        'nx-workspace-pane-surface--thread-rail',
        paneMode === 'single' ? 'is-pane-single' : 'is-pane-multi',
        `is-width-${paneWidth}`,
      )}
    >
      <InboxSidebar
        threads={threads}
        selectedId={inboxHighlightId}
        activeViewFilter={viewFilter}
        onSelect={handleSelect}
        onThreadAction={handleThreadAction}
        savedPreset={savedPreset}
        onApplySavedPreset={applySavedPreset}
        viewCounts={viewCounts}
        onOpenAdvancedFilters={() => setActiveOverlay('filters')}
        activeFilterChips={activeAdvancedFilterChips}
        activeFilterCount={activeAdvancedFilterCount}
        onRemoveFilterChip={handleRemoveAdvancedFilterChip}
        onClearFilters={handleResetFilters}
        onRetryLoad={handleRetryInboxLoad}
        onLoadMore={handleLoadMore}
        canLoadMore={Boolean(data.pagination?.hasMore)}
        recentlyUpdatedThreadIds={recentlyUpdatedThreadIds}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        sourceMode={sourceMode}
        onSourceModeChange={setSourceMode}
        visibleThreadCount={visibleThreadCount}
        loading={_dataLoading}
        loadingError={data.liveFetchError}
        realtimeStatus={data.realtimeStatus}
        refreshMode={data.refreshMode}
        densityMode={paneMode === 'single' || paneWidth === '75' || paneWidth === '100' ? 'full' : 'compact'}
        inboxMode={paneWidth === '25' ? 'rail25' : paneWidth === '50' ? 'review50' : paneWidth === '75' ? 'ops75' : 'full100'}
        listScrollOffset={sidebarListScrollOffset}
        onListScrollOffsetChange={setSidebarListScrollOffset}
      />
    </section>
  )

  const wrapWorkspaceSurface = (
    view: InboxWorkspaceView,
    paneWidth: ViewWidthPercent,
    layoutMode: ReturnType<typeof resolveLayoutModeForPane>,
    surfaceClass: string,
    children: ReactNode,
  ) => (
    <section
      className={cls(
        'nx-workspace-surface',
        surfaceClass,
        `is-view-${view}`,
        `is-width-${paneWidth}`,
        `is-layout-${layoutMode}`,
      )}
      style={{ height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </section>
  )

  const renderWorkspacePane = (
    view: InboxWorkspaceView,
    paneMode: 'single' | 'multi' = 'single',
    paneWidth: ViewWidthPercent = '100',
  ) => {
    let layoutMode = resolveLayoutModeForPane(
      workspaceFlexBases[view] ?? Number(paneWidth),
      workspaceWidthOverrides[view] ?? paneWidth,
    )
    if (isMobile) {
      if (view === 'pipeline' || view === 'command_map') layoutMode = 'compact'
      else if (view === 'deal_intelligence') layoutMode = 'medium'
      else if (view === 'queue' || view === 'campaigns' || view === 'email') layoutMode = 'medium'
      else if (view === 'workflow_studio') layoutMode = 'compact'
    }

    if (view === 'thread') {
      return renderInboxRailPane(paneMode, paneWidth)
    }

    if (view === 'sms_thread') {
      return renderSmsThreadPane(paneWidth, layoutMode)
    }

    if (view === 'list') {
      return wrapWorkspaceSurface(
        view,
        paneWidth,
        layoutMode,
        'nx-workspace-surface--list-compact',
        <InboxConversationTable
          threads={filtered}
          selectedId={inboxHighlightId}
          sort={tableSort}
          density={paneMode === 'multi' && paneWidth === '75' ? 'compact' : tableDensity}
          layoutMode={layoutMode}
          statCounts={listStatCounts}
          onSortChange={setTableSort}
          onDensityChange={setTableDensity}
          onSelect={handleSelect}
        />,
      )
    }

    if (view === 'entity_graph') {
      return (
        <section
          className={cls(
            'nx-workspace-surface',
            'nx-workspace-surface--entity-graph',
            `is-view-${view}`,
            `is-width-${paneWidth}`,
            `is-layout-${layoutMode}`,
          )}
          style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}
        >
          <EntityGraphWorkspace
            paneWidth={paneWidth}
            themeMode={layoutState.theme}
            universalContext={universalEntityContext}
            onUniversalContextChange={handleUniversalEntityContextChange}
            onAction={handleEntityGraphAction}
            onSelectThreadKey={(threadKey) => {
              const match = findThreadByRef(threads, threadKey)
              if (match) handleSelect(match.id)
              else setActiveContext({ threadKey, ...activeInboxFromUniversalContext(universalEntityContext, 'entity_graph') }, { openThread: true })
            }}
          />
        </section>
      )
    }

    if (view === 'command_map') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--map', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)}>
          <div className="nx-map-right-body nx-map-right-body--workspace">
            <WorkspaceSuspense>
            <InboxCommandMap
              threads={mapThreads}
              visibleThreads={filtered}
              selectedThread={workspaceThread}
              selectedThreadMessages={displayedMessages}
              selectedThreadMessagesLoading={messagesLoading}
              quickReplyDraft={draftText}
              onQuickReplyDraftChange={setDraftText}
              onQuickReplySend={(text) => handleSend(text)}
              quickReplyDisabled={selectedSuppressed || isSending}
              zoomedIn
              sourceMode={mapSourceMode}
              onSourceModeChange={setMapSourceMode}
              onSelectThreadId={handleSelect}
              onSelectSellerContext={handleMapSellerContext}
              onSelectActivity={handleActivityNavigation}
              onBackgroundClick={() => {}}
              onOpenDealIntelligence={handleOpenDealIntelligence}
              buyerCommandData={buyerCommandData}
              buyerFilters={buyerFilters}
              onBuyerFiltersChange={(patch) => setBuyerFilters((current) => ({ ...current, ...patch }))}
              selectedBuyerKey={selectedBuyerKey}
              onSelectBuyerKey={setSelectedBuyerKey}
              initialMapStyleMode={commandMapTheme}
              onStateChange={(state) => {
                setCommandMapTheme(state.mapStyleMode)
                setCommandMapMarket(state.filters.market || '')
              }}
              fullHeight={paneMode === 'single'}
              layoutMode={layoutMode}
              paused={heavyLoadPaused}
            />
            </WorkspaceSuspense>
          </div>
        </section>
      )
    }

    if (view === 'deal_intelligence') {
      return (
        <IntelligencePanel
          thread={workspaceThread}
          threadContext={threadContext}
          intelligence={threadIntelligence}
          dealContext={canonicalSelectedContext}
          onStatusChange={handleStatusChange}
          onStageChange={handleStageChange}
          onOpenMap={() => setSelectedWorkspaceViews(['command_map'])}
          onOpenComps={() => setSelectedWorkspaceViews(['comp_intelligence'])}
          onOpenDossier={() => handleOpenDealIntelligence(workspaceThread?.id ?? null)}
          onOpenSellerAutomation={() => handleOpenSellerAutomation(workspaceThread?.id ?? null)}
          onOpenAi={() => setActiveOverlay('ai')}
          messages={displayedMessages}
          panelMode={
            paneMode === 'single' || paneWidth === '75' || paneWidth === '100'
              ? 'full'
              : paneWidth === '25' || paneWidth === '50'
                ? 'half'
                : 'default'
          }
          layoutMode={layoutMode}
        />

      )
    }

    if (view === 'pipeline') {
      return wrapWorkspaceSurface(
        view,
        paneWidth,
        layoutMode,
        'nx-workspace-surface--kanban',
        <WorkspaceSuspense>
          <PipelineWorkspace
            selectedId={workspaceThread?.id ?? effectiveActiveContext.threadKey ?? null}
            externalContext={effectiveActiveContext}
            layoutMode={layoutMode}
            onSelect={handleSelect}
            onAnchorThread={anchorThreadSelection}
            onEstablishContext={(ctx) => setActiveContext(ctx, { preserveCurrentViews: true })}
            onSyncOpportunity={syncOpportunityContext}
            onClearOpportunityPreview={clearOpportunityPreview}
            onOpenCommandView={(threadId) => {
              if (threadId) handleSelect(threadId)
              handleFocusWorkspaceView('sms_thread')
            }}
            onOpenDealIntelligence={handleOpenDealIntelligence}
            onOpenSellerAutomation={(opp) => {
              openSellerAutomationStudioFromEntity({
                propertyId: opp.primary_property_id,
                prospectId: opp.prospect_id,
                masterOwnerId: opp.master_owner_id,
                threadKey: opp.primary_thread_key,
                preservePath: true,
              })
              setSelectedWorkspaceViews(['workflow_studio'])
            }}
            onAction={handleOperatorAction}
          />
        </WorkspaceSuspense>,
      )
    }

    if (view === 'queue') {
      return wrapWorkspaceSurface(
        view,
        paneWidth,
        layoutMode,
        'nx-workspace-surface--queue',
        <QueuePage
          externalContext={effectiveActiveContext}
          layoutMode={layoutMode}
          paneWidth={paneWidth}
          onSelectItem={queueItem =>
            setActiveContext(buildContextFromQueueItem(queueItem, 'queue'), { preserveCurrentViews: true })
          }
        />,
      )
    }

    if (view === 'calendar') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--calendar', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)}>
          <InboxCalendarView
            threads={filtered}
            selectedThread={workspaceThread}
            selectedId={workspaceThread?.id ?? null}
            layoutMode={layoutMode}
            onSelectThread={handleSelect}
            onSelectEvent={handleSelectCalendarEvent}
            onOpenDealIntelligence={handleOpenDealIntelligence}
          />
        </section>
      )
    }

    if (view === 'metrics') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--metrics', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)}>
          <WorkspaceSuspense>
            <MetricsWarRoom layoutMode={layoutMode} paneWidth={paneWidth} paused={heavyLoadPaused} />
          </WorkspaceSuspense>
        </section>
      )
    }

    if (view === 'comp_intelligence') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--map', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)}>
          <WorkspaceSuspense>
          {COMP_V4_ENABLED ? (
            <CompIntelligenceV4Workspace
              dealContext={canonicalSelectedContext}
              paused={heavyLoadPaused}
              paneWidth={paneWidth}
            />
          ) : (
            <CompIntelligenceWorkspace
              thread={workspaceThread}
              dealContext={canonicalSelectedContext}
              paused={heavyLoadPaused}
              paneWidth={paneWidth}
              layoutMode={layoutMode}
            />
          )}
          </WorkspaceSuspense>
        </section>
      )
    }

    if (view === 'buyer_match') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--map', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`, BUYER_MATCH_V4_ENABLED && 'is-buyer-match-v4')}>
          <WorkspaceSuspense>
          {BUYER_MATCH_V4_ENABLED ? (
            <BuyerMatchV4Workspace
              paused={heavyLoadPaused}
              dealContext={canonicalSelectedContext}
              paneWidth={paneWidth}
              onOpenFull={() => handleFocusWorkspaceView('buyer_match')}
            />
          ) : (
            <BuyerMatchWorkspace
              paused={heavyLoadPaused}
              dealContext={canonicalSelectedContext}
              propertySnapshot={{
                property_id: canonicalSelectedContext?.propertyId || '',
                address: canonicalSelectedContext?.propertyAddress || 'Property Unknown',
                market: canonicalSelectedContext?.market || '',
                zip: canonicalSelectedContext?.propertyZip || '',
                state: canonicalSelectedContext?.propertyState || '',
                county: canonicalSelectedContext?.propertyCounty || '',
                property_type: canonicalSelectedContext?.property_type || '',
                asset_class: canonicalSelectedContext?.property_type || '',
                beds: (canonicalSelectedContext?.property as Record<string, unknown> | null)?.total_bedrooms as number | null,
                baths: (canonicalSelectedContext?.property as Record<string, unknown> | null)?.total_baths as number | null,
                sqft: (canonicalSelectedContext?.property as Record<string, unknown> | null)?.building_square_feet as number | null,
                estimated_value: canonicalSelectedContext?.estimatedValue || null,
                arv: canonicalSelectedContext?.estimated_arv || canonicalSelectedContext?.estimatedValue || null,
                purchase_price: canonicalSelectedContext?.cashOffer || null,
                dispo_strategy: (canonicalSelectedContext?.property as Record<string, unknown> | null)?.dispo_strategy as string || '',
              }}
              paneWidth={paneWidth}
              apiBase="/api/cockpit"
            />
          )}
          </WorkspaceSuspense>
        </section>
      )
    }

    if (view === 'campaigns') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--campaigns', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)} style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <WorkspaceSuspense>
          <InboxCampaignView
            selectedThread={workspaceThread}
            paneWidth={paneWidth}
            layoutMode={layoutMode}
          />
          </WorkspaceSuspense>
        </section>
      )
    }

    if (view === 'email') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--campaigns', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)} style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <EmailCommandCenter
            paneWidth={paneWidth}
          />
        </section>
      )
    }

    if (view === 'workflow_studio') {
      return (
        <section className={cls('nx-workspace-surface', 'nx-workspace-surface--workflow-studio', 'wfs2-isolation-root', `is-view-${view}`, `is-width-${paneWidth}`, `is-layout-${layoutMode}`)} style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <WorkflowStudioV2
            paneWidth={paneWidth}
            layoutMode={layoutMode}
          />
        </section>
      )
    }

    if (view === 'closing_desk') {
      return wrapWorkspaceSurface(
        view,
        paneWidth,
        layoutMode,
        'nx-workspace-surface--closing-desk',
        <WorkspaceSuspense>
          <ClosingDeskView />
        </WorkspaceSuspense>,
      )
    }

    return renderSmsThreadPane()
  }

  return (
    <WatchlistProvider>
    <div
      id="nx-inbox-root"
      data-nexus-theme={activeNexusThemeId}
      data-nexus-accent={activeAccentPalette}
      className={cls(
        'nx-premium-inbox nx-inbox',
        ...layoutClasses,
        isRouteFullscreen && 'is-route-fullscreen',
        useFullscreenShell && 'is-workspace-fullscreen',
        isCommandMapView && 'is-command-view-active',
        `is-workspace-${activeWorkspaceView}`,
        isCustomMultiView && 'is-deal-desk-layout',
        isMultiView && 'is-multi-view-active',
      )}
    >
      <NexusTopBar
        onSelectSearchResult={handleSelect}
        topSearchQuery={topSearchQuery}
        onTopSearchQueryChange={setTopSearchQuery}
        topSearchGroups={topSearchGroups}
        topSearchLoading={topSearchLoading}
        onExecuteTopSearchResult={handleExecuteTopSearchResult}
        selectedThread={workspaceThread}
        isSuppressed={selectedSuppressed}
        notificationCount={data.unreadCount}
        queueProcessorHealth={queueProcessorHealth}
        queueControlDiagnostics={queueControlDiagnostics}
        queueProcessorHealthLoading={queueProcessorHealthLoading}
        onRefreshQueueHealth={refreshQueueHealth}
        queueCommandMode={queueCommandMode}
        queueCommandCaps={queueCommandCaps}
        queueCommandActionLoading={queueCommandActionLoading}
        onQueueCommandModeChange={handleQueueCommandModeChange}
        onQueueCommandCapsChange={handleQueueCapsChange}
        onRunSafeBatch={handleRunSafeBatch}
        onQueueMore={handleQueueMoreNow}
        onRunQueueNow={handleRunQueueNow}
        onEmergencyPause={handleEmergencyPause}
        onReprocessPaused={handleReprocessPaused}
        onRetryFailed={handleRetryFailedQueue}
        onReconcileDelivery={handleReconcileDelivery}
        onCancelStaleFollowUps={handleCancelStaleFollowUps}
        autonomyModel={autonomyModel}
        activeViewKey={activeWorkspaceView}
        activeViewKeys={activeViewMenuKeys}
        activeViewChips={activeViewChips}
        onToggleActiveViewChip={handleToggleActiveViewChip}
        activeThemeId={activeNexusThemeId}
        activeAccentId={activeAccentPalette}
        onSelectTheme={(themeId) => {
          setLayoutState((current) => ({ ...current, theme: themeId === 'light' ? 'light' : 'dark' }))
          updateSetting('nexusTheme', themeId)
          applyThemeToDOM()
        }}
        onSelectAccent={(accent) => {
          setActiveAccentPalette(accent)
          updateSetting('accentPalette', accent)
          applyThemeToDOM()
        }}
        activeOverlay={activeOverlay}
        onOpenOverlay={setActiveOverlay}
        onCloseOverlay={() => setActiveOverlay(null)}
        activeWorkspaceKey={selectedWorkspaceKey}
        activeWorkspaceLabel={activeWorkspaceLabel}
        contextSubtitle={activeContextSubtitle}
        actionCenterCounts={{
          loading: _dataLoading,
          humanReview: viewCounts.needs_review ?? 0,
          followUps: viewCounts.follow_up ?? 0,
          failedSends: queueProcessorHealth?.failedTodayCount ?? viewCounts.failed ?? 0,
          decisionsRequired: viewCounts.needs_review ?? 0,
          closingTasks: null,
          systemTasks: null,
        }}
        onNavigateInboxView={handleNavigateInboxView}
        onOpenQueueCommand={() => pushRoutePath('/queue')}
        authReady={Boolean(user)}
        authLoading={authLoading}
        onSignOut={() => { void signOut() }}
        profileInitials={(user?.email?.slice(0, 2) ?? 'RK').toUpperCase()}
        workspaceOptions={NEXUS_WORKSPACE_PRESETS.map((workspace) => ({
          key: workspace.key,
          label: workspace.label,
          description: workspace.description,
          statusLabel: workspace.status === 'ready' ? undefined : workspace.status === 'backend_not_ready' ? 'Backend not ready' : 'Coming soon',
        }))}
        onSelectWorkspace={handleSelectWorkspace}
        viewOptions={WORKSPACE_VIEW_MENU_OPTIONS.map((view) => ({
          key: view.key,
          label: view.label,
          description: view.description,
          statusLabel: view.status ? (view.status === 'backend_not_ready' ? 'Backend not ready' : 'Coming soon') : undefined,
        }))}
        onSelectView={handleSelectWorkspaceView}
        activeViewWidths={workspaceWidths as Partial<Record<string, ViewWidthPercent>>}
        onSelectViewWidth={handleSelectWorkspaceViewWidth}
        onSaveCurrentLayout={handleSaveCurrentWorkspaceLayout}
        onWorkspaceSettings={() => emitNotification({ title: 'Workspace Settings', detail: 'Workspace settings panel is not available yet.', severity: 'warning' })}
        onOpenMap={() => setSelectedWorkspaceViews(['command_map'])}
        onOpenDossier={() => handleOpenDealIntelligence(selected?.id ?? null)}
        onOpenAi={() => setActiveOverlay('ai')}
        onOpenKeys={() => setActiveOverlay('keys')}
        onOpenKpis={() => pushRoutePath('/analytics')}
        onOpenActivity={() => setActiveOverlay('activity')}
        onOpenTasks={() => handleNavigateInboxView('needs_review')}
        onResetLayout={handleResetWorkspaceLayout}
        dryRun={autonomyControls.dryRun}
        onToggleDryRun={() => setAutonomyControls(prev => ({ ...prev, dryRun: !prev.dryRun }))}
      />
      {workspaceBlocked ? (
        <div className="nx-inbox-shell nx-inbox-shell--workspace-status">{renderWorkspaceStatusShell()}</div>
      ) : useFullscreenShell ? (
        <div
          className={cls(
            'nx-fullscreen-app-shell',
            `is-view-${activeWorkspaceView}`,
            isDealIntelligenceView && 'nx-deal-intelligence-fullscreen',
            activeWorkspaceView === 'closing_desk' && 'is-view-closing_desk',
          )}
        >
          {renderWorkspacePane(activeWorkspaceView, 'single', '100')}
        </div>
      ) : (
      <div
        ref={(node) => { if (node) markInboxShellReady() }}
        className={cls(
          'nx-inbox-shell',
          isMobile && !useFullscreenShell && 'is-mobile-inbox',
          isMobile && Boolean(selected) && 'm-thread-open',
          mobileSidebarOpen && 'm-sidebar-open',
          mobileIntelOpen && 'm-intel-open',
        )}
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (target.classList.contains('nx-inbox-shell')) {
            setMobileSidebarOpen(false)
            setMobileIntelOpen(false)
          }
        }}
      >
        {/* Mobile panel toggle buttons */}
        <div className="nx-mobile-panel-toggles nx-desktop-only">
          <button
            type="button"
            className="nx-mobile-panel-toggle"
            onClick={() => { setMobileSidebarOpen(v => !v); setMobileIntelOpen(false) }}
          >
            ☰ Threads
          </button>
        </div>

        {isDoubleSided && (
          <InboxSidebar
            threads={threads}
            selectedId={selected?.id ?? null}
            activeViewFilter={rightViewFilter}
            onSelect={handleSelect}
            onThreadAction={handleThreadAction}
            savedPreset={rightSavedPreset}
            onApplySavedPreset={applyRightSavedPreset}
            viewCounts={viewCounts}
            onOpenAdvancedFilters={() => setActiveOverlay('filters')}
            activeFilterChips={activeAdvancedFilterChips}
            activeFilterCount={activeAdvancedFilterCount}
            onRemoveFilterChip={handleRemoveAdvancedFilterChip}
            onClearFilters={handleResetFilters}
            onRetryLoad={handleRetryInboxLoad}
            onLoadMore={handleLoadMore}
            canLoadMore={Boolean(data.pagination?.hasMore)}
            recentlyUpdatedThreadIds={recentlyUpdatedThreadIds}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            sourceMode={sourceMode}
            onSourceModeChange={setSourceMode}
            visibleThreadCount={visibleThreadCount}
            loading={_dataLoading}
            loadingError={data.liveFetchError}
            realtimeStatus={data.realtimeStatus}
            refreshMode={data.refreshMode}
            densityMode="compact"
            inboxMode="review50"
            listScrollOffset={sidebarListScrollOffset}
            onListScrollOffsetChange={setSidebarListScrollOffset}
          />
        )}

        <main
          className={cls(
            'nx-inbox-center',
            isMultiView && 'is-multi-view-shell',
            activeWorkspaceView === 'list' && 'is-list-mode',
            isDealIntelligenceView && 'is-dossier-mode',
            activeWorkspaceView === 'pipeline' && 'is-pipeline-mode',
            activeWorkspaceView === 'queue' && 'is-queue-mode',
            activeWorkspaceView === 'calendar' && 'is-calendar-mode',
            activeWorkspaceView === 'metrics' && 'is-metrics-mode',
            activeWorkspaceView === 'comp_intelligence' && 'is-comp-mode',
            activeWorkspaceView === 'buyer_match' && 'is-buyer-mode',
            activeWorkspaceView === 'campaigns' && 'is-campaigns-mode',
            activeWorkspaceView === 'workflow_studio' && 'is-workflow-studio-mode',
            activeWorkspaceView === 'entity_graph' && 'is-entity-graph-mode',
            isCommandMapView && 'is-command-map-mode',
          )}
        >
          {dossierOpen && (
            <MapDossierDrawer
              mode="dossier"
              thread={workspaceThread}
              context={threadContext}
              full={dossierFull}
              onToggleFull={() => setDossierFull((full) => !full)}
              onClose={() => setActiveOverlay(null)}
            />
          )}

          {isMultiView ? (
            <section className="nx-workspace-split-grid">
              {renderViews.map((view) => {
                const paneWidth = workspaceWidths[view] ?? '25'
                const flexBasis = workspaceFlexBases[view] ?? Number(paneWidth)
                const layoutMode = resolveLayoutModeForPane(
                  flexBasis,
                  workspaceWidthOverrides[view] ?? paneWidth,
                )
                return (
                  <div
                    key={view}
                    className={cls(
                      'nx-workspace-pane',
                      `is-view-${view}`,
                      `is-width-${paneWidth}`,
                      `is-layout-${layoutMode}`,
                      view === activeWorkspaceView && 'is-primary',
                    )}
                    style={{ flex: `1 1 ${flexBasis}%`, maxWidth: `${flexBasis}%`, minWidth: 0 }}
                  >
                    {renderWorkspacePane(view, 'multi', paneWidth)}
                  </div>
                )
              })}
            </section>
          ) : (
            renderWorkspacePane(activeWorkspaceView, 'single', '100')
          )}
        </main>

        {mapOpen && !isCommandMapView ? (
          <aside className="nx-map-right-panel">
            <div className="nx-map-right-header">
              <span className="nx-map-right-header__title">
                <Icon name="map" />
                Map View
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  · {mapMode === 'side' ? '25%' : mapMode === 'half' ? '50%' : mapMode === 'seventy_five' ? '75%' : 'Full'}
                </span>
              </span>
              <div className="nx-map-right-header__actions">
                <button
                  type="button"
                  title="Expand map (\\)"
                  onClick={() => setLayoutState(cycleMapMode)}
                >
                  <Icon name="maximize" />
                </button>
                <button
                  type="button"
                  title="Close map (⌘M)"
                  onClick={() => setLayoutState(closeMapMode)}
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
            <div className="nx-map-right-body">
              <InboxCommandMap
                threads={mapThreads}
                visibleThreads={filtered}
                selectedThread={workspaceThread}
                selectedThreadMessages={displayedMessages}
                selectedThreadMessagesLoading={messagesLoading}
                quickReplyDraft={draftText}
                onQuickReplyDraftChange={setDraftText}
                onQuickReplySend={(text) => handleSend(text)}
                quickReplyDisabled={selectedSuppressed || isSending}
                zoomedIn={mapMode !== 'side'}
                sourceMode={mapSourceMode}
                onSourceModeChange={setMapSourceMode}
              onSelectThreadId={handleSelect}
              onSelectSellerContext={handleMapSellerContext}
              onBackgroundClick={() => {}}
              onOpenDealIntelligence={handleOpenDealIntelligence}
              buyerCommandData={buyerCommandData}
              buyerFilters={buyerFilters}
              onBuyerFiltersChange={(patch) => setBuyerFilters((current) => ({ ...current, ...patch }))}
              selectedBuyerKey={selectedBuyerKey}
              onSelectBuyerKey={setSelectedBuyerKey}
              initialMapStyleMode={commandMapTheme}
              onStateChange={(state) => {
                setCommandMapTheme(state.mapStyleMode)
                setCommandMapMarket(state.filters.market || '')
              }}
            />
          </div>
        </aside>
        ) : null}
      </div>
      )}

      <AdvancedFiltersModal
        open={activeOverlay === 'filters'}
        stageFilter={stageFilter}
        viewFilter={viewFilter}
        inboxBucket={viewFilter === 'all_conversations' ? 'all' : viewFilter}
        advancedFilters={advancedFilters}
        onAdvancedFiltersChange={setAdvancedFilters}
        onReset={handleResetFilters}
        onClose={() => setActiveOverlay(null)}
        onApply={handleApplyAdvancedFilters}
      />

      {activeOverlay === 'activity' && (
        <InboxActivityPanel
          threadKey={selected?.threadKey}
          onClose={() => setActiveOverlay(null)}
          onViewThread={(key) => {
            const t = threads.find((thread) => thread.threadKey === key)
            if (t) handleSelect(t.id)
            setActiveOverlay(null)
          }}
        />
      )}

      {aiOpen
        ? createPortal(
            <LiveCopilotChat
              thread={selected}
              onClose={() => setActiveOverlay(null)}
            />,
            document.body,
          )
        : null}

      {keysOpen && <InboxUtilityDrawer type="keys" thread={selected} onClose={() => setActiveOverlay(null)} />}


      <InboxCommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        hasThread={!!selected}
        commands={commandPaletteCommands}
      />

      <InboxSchedulePanel
        open={schedulePanelOpen}
        onClose={() => {
          setSchedulePanelOpen(false)
          setScheduledTemplatePayload(null)
        }}
        thread={selected}
        onSchedule={(time) => {
          setScheduledTime(time)
          setSchedulePanelOpen(false)
          const payload = scheduledTemplatePayload ?? { text: draftText, template: null }
          if (!selected || !payload.text.trim()) {
            emitNotification({ title: 'Schedule Failed', detail: 'No message available to schedule.', severity: 'warning' })
            return
          }
          void (async () => {
            const result = await scheduleReplyFromInbox(selected, payload.text, time.iso, {
              selectedTemplate: payload.template,
              threadContext,
            })
            emitNotification({
              title: result.ok ? 'Scheduled' : 'Schedule Failed',
              detail: result.ok ? `Sent set for ${time.label}` : (result.errorMessage ?? 'Could not schedule message'),
              severity: result.ok ? 'success' : 'critical',
            })
            if (result.ok) {
              setDraftText('')
              setScheduledTemplatePayload(null)
            }
          })()
        }}
      />
      {contextLoading && <div hidden>Loading context</div>}
      {scheduledTime && <div hidden>{scheduledTime.label}</div>}
      {debugModalOpen && (
        <ThreadDebugModal
          isOpen={debugModalOpen}
          onClose={() => setDebugModalOpen(false)}
          thread={selected}
          messages={selectedMessages}
          intelligence={threadIntelligence}
        />
      )}
    </div>
    </WatchlistProvider>
  )
}
