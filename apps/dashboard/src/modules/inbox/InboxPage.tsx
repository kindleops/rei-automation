import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { pushRoutePath } from '../../app/router'
import { useInboxData, toWorkflowThread } from './inbox.adapter'
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
  getThreadHydrationForThread,
  getThreadMessagesPageForThread,
  getThreadMessagesForThread,
  getConversationThreadIdForThread,
  getThreadContext,
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
import { normalizeDealContext, type DealContext } from '../../lib/data/dealContext'
import { fetchQueueModel, type QueueModel } from '../../lib/data/queueData'
import { fetchSmsTemplates, type SmsTemplate } from '../../lib/data/templateData'
import { fetchInboxActivity, logInboxActivity, type InboxActivityEvent } from '../../lib/data/inboxActivityData'
import { getSupabaseClient } from '../../lib/supabaseClient'
import { getQueueControlSettings, updateQueueControlSettings, callBackend } from '../../lib/api/backendClient'
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
// ComposerTranslationBar is now inline inside Composer
import { IntelligencePanel } from './components/IntelligencePanel'
import { CompIntelligenceWorkspace } from '../../views/comp-intelligence/CompIntelligenceWorkspace'
import { BuyerMatchWorkspace } from './components/BuyerMatchWorkspace'
import { SendQueueDashboard } from './components/SendQueueDashboard'
import { InboxPipelineView } from '../../views/pipeline/InboxPipelineView'
import { InboxCalendarView } from '../../views/calendar/InboxCalendarView'
import { MetricsWarRoom } from './components/MetricsWarRoom'
import type { TemplateActionPayload } from './components/TemplatePopover'
import { InboxActivityPanel } from './components/InboxActivityPanel'
import { InboxCommandMap, type MapStyleMode } from '../../views/map/InboxCommandMap'
import { InboxUtilityDrawer, MapDossierDrawer } from './components/InboxUtilityDrawer'
import { LiveCopilotChat } from '../copilot/components/LiveCopilotChat'
import { AdvancedFiltersPopover } from './components/AdvancedFiltersPopover'
import { InboxCommandPalette, type InboxCmd } from './InboxCommandPalette'
import { InboxSchedulePanel, type ScheduledTime } from './InboxSchedulePanel'
import { ThreadDebugModal } from './components/ThreadDebugModal'
import { InboxCampaignView } from '../../views/campaign-command/InboxCampaignView'
import { EmailCommandCenter } from '../../views/email-command/EmailCommandCenter'
import { WorkflowStudio } from '../../views/workflow-studio/WorkflowStudio'
import WorkflowStudioV2, { isWorkflowStudioV2Enabled } from '../../views/workflow-studio/v2/WorkflowStudioV2'
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
import {
  applyInboxFilters,
  getAdvancedFilterOptions,
  getInboxViewCounts,
  getSavedPresetConfig,
  isSuppressedThread,
  type ApplyInboxFiltersOptions,
  type InboxAdvancedFilters,
  type InboxSavedFilterPreset,
  type InboxStageSelectValue,
  type InboxViewSelectValue,
} from './inbox-ui-helpers'
import { buildConversationDecision } from '../../domain/inbox/inbox-decisioning'
import { getViewLayoutMode, type ViewWidthPercent } from '../../domain/inbox/view-layout'
import './inbox-premium.css'
import './inbox-rebuild.css'
import './inbox-rebuild-v2.css'
import './inbox-polish.css'
import './notification-hud.css'
import './inbox-density-25.css' // compact nx-row25 styles for rail25/review50 modes
import '../../views/buyer-match/buyer-intel-upgrade.css'
import './copilot/copilot.css'
import './conversation-redesign.css'
import { GLOBAL_COMMAND_ACTION_EVENT, GLOBAL_COMMAND_CONTEXT_EVENT, GLOBAL_COMMAND_OPEN_EVENT, type CommandResult } from '../command-center/command.types'
import { useInboxTopSearch } from '../command-center/useInboxTopSearch'
import { saveRecentCommandLocation } from '../command-center/providers/locationCommandProvider'
import { applyThemeToDOM, loadSettings, resolveDataThemeAttr, subscribeSettings, updateSetting, type AccentPalette } from '../../shared/settings'
import type { NexusGlobalThemeId } from '../../domain/theme/nexusThemes'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')
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
    description: 'Offers · Contracts · Title',
    status: 'backend_not_ready',
    views: ['closing_desk', 'calendar', 'sms_thread'],
    widths: { closing_desk: '50', calendar: '25', sms_thread: '25' },
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
  { key: 'command_map', label: 'Map', description: 'Command map for market and routing context.' },
  { key: 'analytics', label: 'Analytics', description: 'Operational KPI and analytics modules.' },
  { key: 'closing_desk', label: 'Closing Desk', description: 'Offers, contracts, title, escrow, and signatures.', status: 'backend_not_ready' },
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
const DEFAULT_WORKSPACE_KEY: NexusWorkspaceKey = 'deal_desk'
const WORKSPACE_VIEWS_STORAGE_KEY = 'nx.inbox.workspace-views-by-key'
const isDefaultWorkspaceSet = (views: InboxWorkspaceView[]) =>
  views.length === DEFAULT_WORKSPACE_VIEWS.length &&
  DEFAULT_WORKSPACE_VIEWS.every((view) => views.includes(view))

const sanitizeWorkspaceWidthOverrides = (
  views: InboxWorkspaceView[],
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> => {
  if (views.length === 0 || views.length === 1) return {}

  const next = Object.fromEntries(
    Object.entries(overrides).filter(([view, value]) => views.includes(view as InboxWorkspaceView) && value),
  ) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>

  if (isDefaultWorkspaceSet(views)) return { ...cloneDefaultWorkspaceWidths(), ...next }

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

const computeWorkspaceWidths = (
  views: InboxWorkspaceView[],
  overrides: Partial<Record<InboxWorkspaceView, ViewWidthPercent>>,
): Partial<Record<InboxWorkspaceView, ViewWidthPercent>> => {
  if (views.length === 0) return {}
  if (views.length === 1) return { [views[0]]: '100' } as Record<InboxWorkspaceView, ViewWidthPercent>
  if (views.length === 2) {
    const [first, second] = views
    const firstOverride = overrides[first]
    const secondOverride = overrides[second]
    if (firstOverride && secondOverride && sumWidths([firstOverride, secondOverride]) === 100) {
      return { [first]: firstOverride, [second]: secondOverride } as Record<InboxWorkspaceView, ViewWidthPercent>
    }
    if (firstOverride === '75') return { [first]: '75', [second]: '25' } as Record<InboxWorkspaceView, ViewWidthPercent>
    if (firstOverride === '25') return { [first]: '25', [second]: '75' } as Record<InboxWorkspaceView, ViewWidthPercent>
    if (firstOverride === '50') return { [first]: '50', [second]: '50' } as Record<InboxWorkspaceView, ViewWidthPercent>
    if (secondOverride === '75') return { [first]: '25', [second]: '75' } as Record<InboxWorkspaceView, ViewWidthPercent>
    if (secondOverride === '25') return { [first]: '75', [second]: '25' } as Record<InboxWorkspaceView, ViewWidthPercent>
    if (secondOverride === '50') return { [first]: '50', [second]: '50' } as Record<InboxWorkspaceView, ViewWidthPercent>
    return { [first]: '50', [second]: '50' } as Record<InboxWorkspaceView, ViewWidthPercent>
  }
  if (views.length === 3) {
    const overrideValues = views.map((view) => overrides[view]).filter(Boolean) as ViewWidthPercent[]
    if (overrideValues.length === 3 && sumWidths(overrideValues) === 100) {
      return Object.fromEntries(views.map((view) => [view, overrides[view]!])) as Record<InboxWorkspaceView, ViewWidthPercent>
    }
    return {
      [views[0]]: '50',
      [views[1]]: '25',
      [views[2]]: '25',
    } as Record<InboxWorkspaceView, ViewWidthPercent>
  }
  const overrideValues = views.slice(0, 4).map((view) => overrides[view]).filter(Boolean) as ViewWidthPercent[]
  if (overrideValues.length === 4 && sumWidths(overrideValues) === 100) {
    return Object.fromEntries(views.slice(0, 4).map((view) => [view, overrides[view]!])) as Record<InboxWorkspaceView, ViewWidthPercent>
  }
  return {
    [views[0]]: '25',
    [views[1]]: '25',
    [views[2]]: '25',
    [views[3]]: '25',
  } as Record<InboxWorkspaceView, ViewWidthPercent>
}

// ── Canonical context merge ───────────────────────────────────────────────────
// Produces a single DealContext that is the richest available merge of the
// enrichment API result and the live inbox thread row. Rules:
//   1. dealContext wins when its field is valid (non-null, non-empty, non-"Unknown")
//   2. selected thread row fills any missing/invalid fields
//   3. Coordinates (lat/lng) always come from the source that has valid coords
const INVALID_STRING_VALUES = new Set(['', 'Unknown', 'Unknown Property', 'Unknown Owner', 'Unknown Seller', 'Unknown Address', 'Unknown Market'])
const isValidStr = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && !INVALID_STRING_VALUES.has(v.trim())
const isValidNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 0
const isValidCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > 0.001

const pickStr = (a: unknown, b: unknown): string => (isValidStr(a) ? (a as string) : isValidStr(b) ? (b as string) : '')
const pickNum = (a: unknown, b: unknown): number => (isValidNum(a) ? (a as number) : isValidNum(b) ? (b as number) : 0)

function mergeSelectedThreadAndDealContext(
  thread: InboxWorkflowThread,
  dc: DealContext | null,
): DealContext {
  const t = thread as unknown as Record<string, unknown>
  const base = dc ?? normalizeDealContext(t)

  const dcLat = isValidCoord(base.latitude) ? base.latitude : (isValidCoord(base.lat) ? base.lat : null)
  const dcLng = isValidCoord(base.longitude) ? base.longitude : (isValidCoord(base.lng) ? base.lng : null)
  const tLat = isValidCoord(t.lat) ? t.lat as number : (isValidCoord(t.latitude) ? t.latitude as number : null)
  const tLng = isValidCoord(t.lng) ? t.lng as number : (isValidCoord(t.longitude) ? t.longitude as number : null)
  const lat = dcLat ?? tLat ?? 0
  const lng = dcLng ?? tLng ?? 0

  return {
    ...base,
    propertyId: pickStr(base.propertyId, t.property_id || t.propertyId) || base.propertyId,
    property_id: pickStr(base.property_id, t.property_id) || base.property_id,
    masterOwnerId: pickStr(base.masterOwnerId, t.master_owner_id || t.ownerId) || base.masterOwnerId,
    master_owner_id: pickStr(base.master_owner_id, t.master_owner_id) || base.master_owner_id,
    prospectId: pickStr(base.prospectId, t.prospect_id || t.prospectId) || base.prospectId,
    prospect_id: pickStr(base.prospect_id, t.prospect_id) || base.prospect_id,
    ownerName: pickStr(base.ownerName, t.owner_name || t.ownerName),
    owner_name: pickStr(base.owner_name, t.owner_name || t.ownerName),
    firstName: pickStr(base.firstName, t.seller_first_name || t.first_name),
    first_name: pickStr(base.first_name, t.first_name),
    propertyAddress: pickStr(base.propertyAddress, t.property_address_full || t.propertyAddress || t.subject),
    property_address_full: pickStr(base.property_address_full, t.property_address_full || t.propertyAddress),
    market: pickStr(base.market, t.market),
    market_name: pickStr(base.market_name, t.market || t.market_name),
    propertyState: pickStr(base.propertyState, t.property_address_state || t.propertyState),
    propertyZip: pickStr(base.propertyZip, t.property_address_zip || t.propertyZip),
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    estimatedValue: pickNum(base.estimatedValue, t.estimated_value),
    estimated_value: pickNum(base.estimated_value, t.estimated_value),
    cashOffer: pickNum(base.cashOffer, t.cash_offer),
    cash_offer: pickNum(base.cash_offer, t.cash_offer),
    equityPercent: pickNum(base.equityPercent, t.equity_percent),
    equity_percent: pickNum(base.equity_percent, t.equity_percent),
    status: pickStr(base.status, t.universal_status),
    universal_status: pickStr(base.universal_status, t.universal_status),
    stage: pickStr(base.stage, t.universal_stage),
    universal_stage: pickStr(base.universal_stage, t.universal_stage),
    bucket: pickStr(base.bucket, t.inbox_bucket),
    inbox_bucket: pickStr(base.inbox_bucket, t.inbox_bucket),
    latestMessageBody: pickStr(base.latestMessageBody, t.latest_message_body || t.latestMessageBody),
    latest_message_body: pickStr(base.latest_message_body, t.latest_message_body),
    latestMessageDirection: pickStr(base.latestMessageDirection, t.latest_message_direction),
    latest_message_direction: pickStr(base.latest_message_direction, t.latest_message_direction),
  }
}

const queueModeFromControl = (diagnostics?: CampaignControlDiagnostics | null): QueueCommandMode => {
  const campaignMode = String(diagnostics?.campaign_mode || '').toLowerCase()
  const processorMode = String(diagnostics?.queue_processor_mode || '').toLowerCase()
  if (campaignMode === 'paused' || processorMode === 'off' || processorMode === 'paused') return 'paused'
  if (campaignMode === 'live_limited' || processorMode === 'live' || processorMode === 'automatic') return 'automatic'
  return 'assisted'
}

export default function InboxPage() {
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messageRefetchKey, setMessageRefetchKey] = useState(0)
  const {
    data,
    loading: _dataLoading,
    refresh: refreshInbox,
    loadMore,
    recentlyUpdatedThreadIds,
    sourceMode,
    setSourceMode
  } = useInboxData({ paused: messagesLoading })
  const DEV = Boolean(import.meta.env.DEV)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null)
  const [activeContext, setActiveContextState] = useState<ActiveInboxContext>({ sourceView: 'inbox' })
  const [stageFilter, setStageFilter] = useState<InboxStageSelectValue>('all_stages')
  const [viewFilter, setViewFilter] = useState<InboxViewSelectValue>('all_messages' as any)
  const [savedPreset, setSavedPreset] = useState<InboxSavedFilterPreset>('my_priority')
  const [advancedFilters, setAdvancedFilters] = useState<InboxAdvancedFilters>({ outOfStateOwner: 'all' })
  const [rightViewFilter, setRightViewFilter] = useState<InboxViewSelectValue>('new_replies')
  const [rightSavedPreset, setRightSavedPreset] = useState<InboxSavedFilterPreset>('new_inbounds')
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<NexusWorkspaceKey>(DEFAULT_WORKSPACE_KEY)
  const [selectedWorkspaceViews, setSelectedWorkspaceViews] = useState<InboxWorkspaceView[]>(cloneDefaultWorkspaceViews)
  const [workspaceWidthOverrides, setWorkspaceWidthOverrides] = useState<Partial<Record<InboxWorkspaceView, ViewWidthPercent>>>(cloneDefaultWorkspaceWidths)
  const [tableSort, setTableSort] = useState<ConversationTableSort>('last_activity_desc')
  const [tableDensity, setTableDensity] = useState<TableDensityMode>('compact')
  const [searchQuery, setSearchQuery] = useState('')
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
  const hasLoadedInitialInboxRef = useRef(false)
  const hasLoggedThemeRef = useRef(false)
  // Tracks whether the live inbox has resolved at least once — gates heavy background queries.
  const heavyQueriesStartedRef = useRef(false)
  const autonomyQueriesStartedRef = useRef(false)
  const healthIntervalRef = useRef<number | null>(null)
  const autonomyIntervalRef = useRef<number | null>(null)
  // Stable ref to selected thread — lets message effect depend on key (string) not object reference
  const selectedRef = useRef<InboxWorkflowThread | null>(null)
  const selectedThreadFallbackRef = useRef<InboxWorkflowThread | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [debugModalOpen, setDebugModalOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileIntelOpen, setMobileIntelOpen] = useState(false)

  const [queueModel, setQueueModel] = useState<QueueModel | null>(null)
  const [templateInventory, setTemplateInventory] = useState<SmsTemplate[]>([])
  const [activityFeed, setActivityFeed] = useState<InboxActivityEvent[]>([])
  const [autonomyControls, setAutonomyControls] = useState<AutonomyControlState>(defaultAutonomyControlState)
  const messageCacheRef = useRef<Record<string, ThreadMessage[]>>({})
  const optimisticMessageMapRef = useRef<Map<string, string>>(new Map()) // clientSendId → optimisticMessage.id
  const inFlightSendMapRef = useRef<Set<string>>(new Set()) // clientSendIds currently in-flight
  const prevThreadsRef = useRef<InboxWorkflowThread[]>([])
  useEffect(() => {
    console.log('[InboxPage] mounted')
  }, [])

  const rawThreads = useMemo(() => (data.threads ?? []).map(toWorkflowThread), [data.threads])
  const threads = useMemo(() => {
    return rawThreads.map(t => optimisticPatches[t.id] ? { ...t, ...optimisticPatches[t.id] } : t)
  }, [rawThreads, optimisticPatches])

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
    console.log('[THREADS_CHANGED]', { stable, length: threads.length })
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

  const advancedFilterOptions = useMemo(() => getAdvancedFilterOptions(threads), [threads])
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
    const srv = data.counts ?? {}
    const sv = (key: string, fallback: number) => {
      const v = srv[key]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        return v === 0 && Number.isFinite(fallback) && fallback > 0 ? fallback : v
      }
      return fallback
    }

    const allCount = sv('all', data.allInboxCount ?? local.all)
    const newReplies = sv('new_replies', sv('new_inbound', sv('needs_reply', local.new_replies)))
    const priorityCount = sv('priority', sv('hot_leads', local.priority ?? local.hot_leads))
    const needsReview = sv('needs_review', sv('manual_review', local.needs_review))
    const followUpCount = sv('follow_up', sv('follow_up_due', local.follow_up ?? local.follow_up_due ?? 0))
    const suppressed = sv('suppressed', sv('dnc_opt_out', local.suppressed))
    const coldNoResp = sv('cold', sv('cold_no_response', local.cold ?? local.cold_no_response))
    const deadCount = sv('dead', local.dead ?? local.wrong_number ?? 0)
    const automated = sv('automated', sv('auto_replied', local.automated))
    const hotLeads = sv('hot_leads', local.hot_leads)
    const activeCount = sv('active', local.active)
    const waitingCount = sv('waiting', sv('waiting_on_seller', local.waiting ?? local.waiting_on_seller ?? 0))

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

  const serverFilterOptions: ApplyInboxFiltersOptions = useMemo(() => ({
    skipViewFilter: false,
    skipStageFilter: false,
  }), [])

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

  // Pipeline view shows all loaded threads (not just priority-filtered ones).
  // Search and advanced filters still apply; view filter is intentionally skipped
  // so the kanban represents the full seller universe, not just unread/high-score threads.
  const pipelineThreads = useMemo(() => (
    applyInboxFilters(threads, {
      search: searchQuery,
      stage: 'all_stages',
      view: 'all_conversations',
      advanced: advancedFilters,
    }, { skipViewFilter: false, skipStageFilter: false })
  ), [advancedFilters, searchQuery, threads])

  const handleLoadMore = useCallback(async () => {
    await loadMore()
    setVisibleThreadCount(prev => prev + 200)
  }, [loadMore])

  const currentInboxQuery = useMemo(() => ({
    view: viewFilter,
    stage: stageFilter,
    query: searchQuery,
    advanced: advancedFilters,
  }), [advancedFilters, searchQuery, stageFilter, viewFilter])

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
    return selectedId ? null : (filtered[0] ?? threads[0] ?? null)
  }, [filtered, threads, selectedId, selectedThreadKey, threadById, threadByKey])

  // Keep ref in sync so message effect reads latest thread without it being a dep
  selectedRef.current = selected
  // Stable string key — message effect deps on this so it only fires when the thread changes,
  // not on every inbox refresh that produces a new `selected` object reference
  const selectedKeyForEffect = selected ? (getConversationThreadIdForThread(selected) || selected.threadKey || selected.id) : null
  // Snapshots for use in useMemo deps — avoids optional-chaining in dep arrays
  const selectedThreadKeySnapshot = selected ? (getConversationThreadIdForThread(selected) || selected.threadKey || null) : null
  const selectedIdSnapshot = selected?.id ?? null

  // Phase 1 trace — fires ONLY when the actual thread identity changes (string key, not object ref)
  useEffect(() => {
    console.log('[SELECTED_KEY_CHANGED]', selectedKeyForEffect)
  }, [selectedKeyForEffect])

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
  const buyerCommandData = useBuyerCommandData(selected, buyerFilters)

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

  const selectedFilteredOut = useMemo(() => (
    Boolean(selected && !filtered.some((thread) => thread.id === selected.id))
  ), [filtered, selected])
  const showSelectedInFilter = useCallback(() => {
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

  useEffect(() => {
    if (!selected) return
    const conversationThreadId = getConversationThreadIdForThread(selected) || selected.threadKey || selected.id
    if (selected.id !== selectedId) setSelectedId(selected.id)
    if (conversationThreadId !== selectedThreadKey) {
      setSelectedThreadKey(conversationThreadId)
    }
  }, [selected, selectedId, selectedThreadKey])

  useEffect(() => {
    if (!activeContext.threadKey && !activeContext.propertyId && !activeContext.sellerId) return
    if (selected && (
      (activeContext.threadKey && (selected.threadKey || selected.id) === activeContext.threadKey)
      || (activeContext.propertyId && selected.propertyId === activeContext.propertyId)
      || (activeContext.sellerId && selected.ownerId === activeContext.sellerId)
    )) {
      return
    }

    const match = threads.find((thread) =>
      (activeContext.threadKey && (thread.threadKey || thread.id) === activeContext.threadKey)
      || (activeContext.propertyId && thread.propertyId === activeContext.propertyId)
      || (activeContext.sellerId && thread.ownerId === activeContext.sellerId),
    )

    if (!match) return
    setSelectedId(match.id)
    setSelectedThreadKey(match.threadKey || match.id)
    setLayoutState((current) => ({ ...current, selectedThreadId: match.id }))
  }, [activeContext.propertyId, activeContext.sellerId, activeContext.threadKey, selected, threads])


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

  // Single canonical context passed to all enrichment panels — richest merge of
  // live thread row + committed dealContext. Always non-null when a thread is selected.
  const canonicalSelectedContext = useMemo(
    () => (selected ? mergeSelectedThreadAndDealContext(selected, dealContext) : null),
    [selected, dealContext],
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
  const workspaceWidths = useMemo(
    () => computeWorkspaceWidths(selectedWorkspaceViews, workspaceWidthOverrides),
    [selectedWorkspaceViews, workspaceWidthOverrides],
  )
  const activeWorkspaceLabel = selectedWorkspacePreset.label
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
    const nextStage = (config.stage ?? stageFilter)
    const nextView = (config.view ?? viewFilter)
    const nextAdvanced = { ...advancedFilters, ...(config.advanced ?? {}) }
    if (config.stage) setStageFilter(config.stage)
    if (config.view) {
      console.log('[BUCKET_STATE_SET]', config.view)
      setViewFilter(config.view)
    }
    if (config.advanced) setAdvancedFilters((current) => ({ ...current, ...config.advanced }))

    // Clear selection so stale thread from the previous bucket is never shown in the new bucket.
    setSelectedId(null)
    setSelectedThreadKey(null)
    selectedThreadFallbackRef.current = null

    // Load category-specific rows from backend so paginated local state reflects the selected tab.
    void refreshInbox({
      filters: {
        view: nextView,
        stage: nextStage,
        query: searchQuery,
        advanced: nextAdvanced,
      },
      cursor: null,
      limit: 100,
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
    setSearchQuery('')
    setStageFilter('all_stages')
    setViewFilter('priority')
    setAdvancedFilters({ outOfStateOwner: 'all' })
    setSavedPreset('my_priority')
    void refreshInbox({
      filters: {
        view: 'priority',
        stage: 'all_stages',
        query: '',
        advanced: { outOfStateOwner: 'all' },
      },
      cursor: null,
      limit: 100,
    })
  }, [refreshInbox])

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
        if (Array.isArray(saved) && saved.length > 0) views = saved.filter((view) => WORKSPACE_VIEW_OPTIONS.some((opt) => opt.key === view))
      }
    } catch {}
    setSelectedWorkspaceKey(preset.key)
    setSelectedWorkspaceViews(views)
    setWorkspaceWidthOverrides(sanitizeWorkspaceWidthOverrides(views, { ...preset.widths }))
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

      setWorkspaceWidthOverrides((existing) =>
        sanitizeWorkspaceWidthOverrides(nextViews, { ...existing, [view]: width }),
      )
      return nextViews
    })
  }, [])

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
    setActiveContextState((current) => ({ ...current, ...nextContext }))

    const nextThreadKey = nextContext.threadKey ?? null
    if (nextThreadKey) {
      const match = threads.find((thread) => (thread.threadKey || thread.id) === nextThreadKey || thread.id === nextThreadKey)
      if (match) {
        setSelectedId(match.id)
        setSelectedThreadKey(match.threadKey || match.id)
        setLayoutState((current) => ({ ...current, selectedThreadId: match.id }))
      } else {
        setSelectedThreadKey(nextThreadKey)
      }
    }

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

  useEffect(() => {
    if (hasLoadedInitialInboxRef.current) return
    hasLoadedInitialInboxRef.current = true
    setVisibleThreadCount(1000)
    void refreshInbox({ filters: currentInboxQuery, cursor: null, limit: 100 })
  }, [currentInboxQuery, refreshInbox])



  const prevSelectedIdRef = useRef<string | null>(null)

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
      setDealContext(null)
      setThreadTranslations({})
      setThreadViewMode('original')
      setDetectedThreadLanguage(null)
      prevSelectedIdRef.current = null
      return
    }

    const cacheKey = selectedKeyForEffect
    // When messageRefetchKey > 0 this is an explicit user-triggered retry — drop the cache so
    // we don't serve the previous 0-row result while waiting for the fresh fetch.
    if (messageRefetchKey > 0) delete messageCacheRef.current[cacheKey]
    const cachedMessages = messageCacheRef.current[cacheKey] ?? []
    const fallbackDealContext = normalizeDealContext(thread as unknown as Record<string, unknown>)
    prevSelectedIdRef.current = thread.id
    const fetchStartTs = performance.now()

    setThreadTranslations({})
    setThreadViewMode('original')
    setDetectedThreadLanguage(null)
    setDealContext(fallbackDealContext)
    setSelectedMessages([])
    setHasOlderMessages(false)
    setOlderMessagesLoading(false)
    setMessagesLoading(true)
    setContextLoading(true)
    setThreadIntelligence((thread ?? null) as unknown as ThreadIntelligenceRecord | null)

    if (DEV) console.log('[SMOOTH_THREAD_SELECT]', { key: selectedKeyForEffect, refetch: messageRefetchKey > 0 })

    let cancelled = false
    const controller = new AbortController()
    const hydrationPromise = getThreadHydrationForThread(thread, controller.signal)
    const contextPromise = getThreadContext(thread, controller.signal).catch((err: unknown) => {
      console.warn('[ENRICHMENT_CONTEXT_ERROR_ISOLATED]', cacheKey, err)
      return null as unknown as ThreadContext
    })

    // ── Messages: fire immediately, commit as soon as done ──────────────────
    console.log('[MESSAGES_FETCH_START]', selectedKeyForEffect)
    hydrationPromise.then((hydration) => {
      if (cancelled) return
      const activeConversationId = selectedRef.current ? (getConversationThreadIdForThread(selectedRef.current) || selectedRef.current.threadKey || selectedRef.current.id) : null
      if (activeConversationId !== selectedKeyForEffect) return
      const durationMs = Math.round(performance.now() - fetchStartTs)
      const messages = hydration.messages
      const integrityBlocked = Boolean((hydration.diagnostics as Record<string, unknown> | undefined)?.integrity_blocked)
      
      console.log('[MESSAGES_FETCH_DONE]', selectedKeyForEffect, messages.length, `${durationMs}ms`)
      if (durationMs > 1500) {
        console.log('[MESSAGES_FETCH_SLOW]', selectedKeyForEffect, {
          durationMs,
          endpoint: '/api/cockpit/inbox/thread-messages',
          status: 'completed',
        })
      }
      const resolvedMessages = integrityBlocked ? [] : messages
      if (messages.length > 0 && !integrityBlocked) {
        messageCacheRef.current[cacheKey] = messages
      } else if (DEV) {
        console.warn('[InboxPage] message hydration returned 0 rows', {
          threadKey: cacheKey,
          integrityBlocked,
          ownerId: thread.ownerId,
          propertyId: thread.propertyId,
          phoneNumber: thread.phoneNumber,
          cachedMessages: cachedMessages.length,
        })
      }
      console.log('[MESSAGES_COMMIT]', selectedKeyForEffect, resolvedMessages.length)
      setSelectedMessages(resolvedMessages)
      setHasOlderMessages(Boolean(hydration.pagination?.hasMore))
      setMessagesLoading(false)
      if (hydration.dealContext) {
        setDealContext(hydration.dealContext)
      }
      setThreadIntelligence({
        ...((thread ?? {}) as unknown as ThreadIntelligenceRecord),
        ...((hydration.intelligence ?? {}) as ThreadIntelligenceRecord),
      })

      const deliveredByBody = new Set(
        messages
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
    }).catch((err) => {
      if (cancelled) {
        console.warn('[MESSAGES_ABORT]', selectedKeyForEffect)
      } else {
        console.error('[MESSAGES_FETCH_ERROR]', selectedKeyForEffect, err)
        setSelectedMessages(cachedMessages)
        setHasOlderMessages(false)
        setMessagesLoading(false)
      }
    })

    // ── Context + hydration: fetch together, never block row fallback/messages ────
    const threadKeyForCtx = thread.threadKey || thread.id
    console.log('[THREAD_CONTEXT_START]', { threadKey: threadKeyForCtx, propertyId: thread.propertyId, prospectId: thread.prospectId, ownerId: thread.ownerId })
    Promise.allSettled([contextPromise, hydrationPromise]).then((results) => {
      if (cancelled) return
      const activeConversationId = selectedRef.current ? (getConversationThreadIdForThread(selectedRef.current) || selectedRef.current.threadKey || selectedRef.current.id) : null
      if (activeConversationId !== selectedKeyForEffect) return
      const context = results[0].status === 'fulfilled' ? results[0].value : null
      const hydration = results[1].status === 'fulfilled' ? results[1].value : null
      setThreadContext(context)
      if (hydration?.intelligence) {
        setThreadIntelligence({
          ...((thread ?? {}) as unknown as ThreadIntelligenceRecord),
          ...((hydration.intelligence ?? {}) as ThreadIntelligenceRecord),
        })
      }
      if (hydration?.dealContext) {
        const dc = hydration.dealContext
        console.log('[THREAD_CONTEXT_DONE]', {
          threadKey: threadKeyForCtx,
          propertyId: dc.propertyId,
          prospectId: dc.prospectId,
          masterOwnerId: dc.masterOwnerId,
          coordsResolved: Boolean(dc.latitude && dc.longitude),
          intelligenceResolved: Boolean(dc.valuation?.id || dc.buyerMatch?.id),
        })
        setDealContext(dc)
        console.log('[THREAD_CONTEXT_COMMIT]', threadKeyForCtx)
      } else {
        console.log('[THREAD_CONTEXT_FALLBACK_FROM_ROW]', threadKeyForCtx)
        setDealContext(fallbackDealContext)
      }
    }).catch((err: unknown) => {
      if (!cancelled) {
        console.warn('[ENRICHMENT_BATCH_ERROR_ISOLATED]', threadKeyForCtx, err)
        console.log('[THREAD_CONTEXT_FALLBACK_FROM_ROW]', threadKeyForCtx)
        setDealContext(fallbackDealContext)
      }
    }).finally(() => {
      if (!cancelled) setContextLoading(false)
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DEV, selectedKeyForEffect, messageRefetchKey])

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

    const selected = selectedRef.current
    if (!selected) return

    const selectedKey = selectedKeyForEffect
    const selectedPhone = selected.canonicalE164 || selected.phoneNumber || ''
    const selectedOwnerId = selected.ownerId || ''
    const selectedPropertyId = selected.propertyId || ''
    const selectedProspectId = selected.prospectId || ''
    const shouldPollSelectedThread = data.connectionState !== 'live'
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

    const pollSelectedMessages = () => {
      if (!shouldPollSelectedThread || document.hidden || pollInFlight) return
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
    const selectedMessagePollInterval = window.setInterval(pollSelectedMessages, 12_000)

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      window.clearInterval(selectedMessagePollInterval)
      pollController?.abort()
      void supabase.removeChannel(channel)
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
      setSelectedWorkspaceKey(DEFAULT_WORKSPACE_KEY)
      setSelectedWorkspaceViews(cloneDefaultWorkspaceViews())
      setWorkspaceWidthOverrides(cloneDefaultWorkspaceWidths())
      let initialViews = cloneDefaultWorkspaceViews()
      let initialWidths = cloneDefaultWorkspaceWidths()
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
          const nextViews = Array.isArray(savedViews) && savedViews.length > 0
            ? savedViews.filter((view) => WORKSPACE_VIEW_OPTIONS.some((opt) => opt.key === view))
            : [...preset.views]
          setSelectedWorkspaceViews(nextViews)
          initialViews = nextViews
          initialWidths = sanitizeWorkspaceWidthOverrides(nextViews, { ...preset.widths })
          setWorkspaceWidthOverrides(initialWidths)
        }
      }
      const savedOverrides = window.localStorage.getItem('nx.inbox.workspace-width-overrides')
      if (savedOverrides) {
        const parsed = JSON.parse(savedOverrides) as Partial<Record<InboxWorkspaceView, ViewWidthPercent>>
        setWorkspaceWidthOverrides(sanitizeWorkspaceWidthOverrides(initialViews, { ...initialWidths, ...parsed }))
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
    let active = true
    const loadQueueControl = async () => {
      const diagnostics = await refreshQueueControl()
      if (!active || !diagnostics) return
    }
    void loadQueueControl()
    return () => { active = false }
  }, [refreshQueueControl])

  useEffect(() => {
    try {
      window.localStorage.setItem('nx.queue.mode', queueCommandMode)
      window.localStorage.setItem('nx.queue.caps', JSON.stringify(queueCommandCaps))
    } catch {}
  }, [queueCommandCaps, queueCommandMode])

  useEffect(() => {
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
        
        if (!hasLoggedThemeRef.current) {
          hasLoggedThemeRef.current = true
          console.log('[InboxTheme] active theme + accent palette + root classes:', {
            theme: resolvedThemeId,
            accent: settings.accentPalette,
            classes: getLayoutClassNames({
              ...current,
              theme: nextTheme
            })
          })
        }

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

  // Queue health polls send_queue (heavy). Only start once after live inbox has resolved.
  // Cleanup does NOT clear the interval — a separate mount-only effect handles unmount cleanup.
  useEffect(() => {
    if (data.liveFetchStatus !== 'active') return
    if (heavyQueriesStartedRef.current) return
    heavyQueriesStartedRef.current = true

    let active = true
    const refreshHealth = async () => {
      const snapshot = await refreshQueueHealth()
      if (!active) return
      setQueueProcessorHealth(snapshot)
    }
    void refreshHealth()
    healthIntervalRef.current = window.setInterval(() => { void refreshHealth() }, 30000)
    return () => { active = false }  // cancel in-flight only; interval runs until unmount
  }, [data.liveFetchStatus, refreshQueueHealth])

  useEffect(() => {
    return () => { if (healthIntervalRef.current !== null) window.clearInterval(healthIntervalRef.current) }
  }, [])

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

  // Templates, queue model, and activity are heavy Supabase queries. Only start once after live inbox resolves.
  // Cleanup does NOT clear the interval — a separate mount-only effect handles unmount cleanup.
  useEffect(() => {
    if (data.liveFetchStatus !== 'active') return
    if (autonomyQueriesStartedRef.current) return
    autonomyQueriesStartedRef.current = true

    let active = true
    const refreshAutonomyInputs = async () => {
      try {
        const [nextQueue, nextTemplates, nextActivity] = await Promise.all([
          fetchQueueModel().catch(() => null),
          fetchSmsTemplates({ includeInactive: true, limit: 800 }).catch(() => []),
          fetchInboxActivity().catch(() => []),
        ])
        if (!active) return
        setQueueModel(nextQueue)
        setTemplateInventory(nextTemplates)
        setActivityFeed(nextActivity)
      } catch (error) {
        if (DEV) console.warn('[InboxPage autonomy inputs] refresh failed', error)
      }
    }
    void refreshAutonomyInputs()
    autonomyIntervalRef.current = window.setInterval(() => { void refreshAutonomyInputs() }, 45000)
    return () => { active = false }  // cancel in-flight only; interval runs until unmount
  }, [DEV, data.liveFetchStatus])

  useEffect(() => {
    return () => { if (autonomyIntervalRef.current !== null) window.clearInterval(autonomyIntervalRef.current) }
  }, [])

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
    let active = true

    const runFeederSilently = async () => {
      if (!active) return
      const { mode, caps, health } = autopilotStateRef.current
      if (mode !== 'assisted' && mode !== 'automatic') return
      
      const targetCount = Math.max(50, caps.sends_per_run * 2)
      const currentActive = (health?.queuedCount ?? 0) + (health?.scheduledCount ?? 0)
      
      if (currentActive < targetCount) {
        try {
          await callBackend('/api/cockpit/queue/queue-more', {
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
          void refreshQueueHealth()
        } catch (error) {
          if (DEV) console.warn('[Autopilot] Feeder run failed', error)
        }
      }
    }

    const runQueueSilently = async () => {
      if (!active) return
      const { mode, caps } = autopilotStateRef.current
      if (mode !== 'automatic') return

      try {
        await callBackend('/api/cockpit/queue/run', {
          method: 'POST',
          body: JSON.stringify({
            caps: caps,
            mode: mode,
          }),
        })
        void refreshQueueHealth()
      } catch (error) {
        if (DEV) console.warn('[Autopilot] Queue runner failed', error)
      }
    }

    const feederInterval = window.setInterval(() => { void runFeederSilently() }, 2 * 60 * 1000)
    const runnerInterval = window.setInterval(() => { void runQueueSilently() }, 60 * 1000)

    // Deferred to avoid competing with initial thread message fetch
    const initialTimeout = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => {
          void runFeederSilently()
          void runQueueSilently()
        }, { timeout: 30000 })
      } else {
        void runFeederSilently()
        void runQueueSilently()
      }
    }, 20000)

    return () => {
      active = false
      window.clearInterval(feederInterval)
      window.clearInterval(runnerInterval)
      window.clearTimeout(initialTimeout)
    }
  }, [DEV, refreshQueueHealth])

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
    let optimistic: Partial<InboxWorkflowThread> = {}

    if (action.startsWith('approve_queue:')) {
      const queueId = action.split(':')[1]
      label = 'Draft Approved'
      mutation = () => approveQueueItem(queueId!, thread)
      optimistic = { inboxStatus: 'queued' }
    } else if (action.startsWith('cancel_queue:')) {
      const queueId = action.split(':')[1]
      label = 'Draft Cancelled'
      mutation = () => cancelQueueItem(queueId!, thread)
      optimistic = { inboxStatus: 'waiting' }
    } else if (action.startsWith('edit_queue:')) {
      const queueId = action.split(':')[1]
      // For editing, we could cancel and load text into composer
      // For now, we'll just treat it as a cancel + focus
      label = 'Opening Editor...'
      mutation = () => cancelQueueItem(queueId!, thread)
      optimistic = { inboxStatus: 'waiting' }
      // Additional logic to focus composer could go here
    } else if (action === 'refetch') {
      // Re-trigger message hydration for the selected thread (e.g. after a failed hydration).
      setMessageRefetchKey((k) => k + 1)
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
          optimistic = { isArchived: true, inboxStatus: 'closed' }
          break
        case 'unarchive':
          label = 'Thread Restored'
          mutation = () => unarchiveThread(thread)
          optimistic = { isArchived: false, inboxStatus: 'needs_review' }
          break
        case 'star':
          label = 'Thread Starred'
          mutation = () => starThread(thread)
          optimistic = { isStarred: true }
          break
        case 'unstar':
          label = 'Star Removed'
          mutation = () => unstarThread(thread)
          optimistic = { isStarred: false }
          break
        case 'pin':
          label = 'Thread Pinned'
          mutation = () => pinThread(thread)
          optimistic = { isPinned: true }
          break
        case 'unpin':
          label = 'Pin Removed'
          mutation = () => unpinThread(thread)
          optimistic = { isPinned: false }
          break
        case 'read':
          label = 'Marked Read'
          mutation = () => markThreadRead(thread)
          optimistic = { isRead: true, unread: false, unreadCount: 0, status: 'read', inboxStatus: 'closed' }
          break
        case 'unread':
          label = 'Marked Unread'
          mutation = () => markThreadUnread(thread)
          optimistic = { isRead: false, unread: true, unreadCount: 1, status: 'unread', inboxStatus: 'new_reply' }
          break
        default:
          return
      }
    }

    setOptimisticPatches(prev => ({ ...prev, [thread.id]: { ...prev[thread.id], ...optimistic } }))
    
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
    const extraPatch = status === 'sent_message'
      ? { latestDirection: 'outbound' as const, lastDirection: 'outbound' as const, lastOutboundAt: new Date().toISOString() }
      : {}
    setOptimisticPatches(prev => ({ ...prev, [selected.id]: { ...prev[selected.id], inboxStatus: actualStatus, ...extraPatch } }))
    
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
    setOptimisticPatches(prev => ({ ...prev, [selected.id]: { ...prev[selected.id], conversationStage: stage } }))
    
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

  const handleToggleArchive = useCallback(() => {
    if (!selected) return
    handleThreadAction(selected, selected.isArchived ? 'unarchive' : 'archive')
  }, [handleThreadAction, selected])

  const handleSelect = useCallback((id: string) => {
    const thread = threads.find((candidate) => candidate.id === id)
    const threadKey = thread?.threadKey || id
    console.log('[THREAD_CLICK]', threadKey)
    console.log('[InboxUX] select thread', { threadKey, activeFilter: viewFilter })
    // Immediately clear old messages and show skeleton — effect fetches fresh ones
    setSelectedMessages([])
    setMessagesLoading(true)
    setActiveContext(buildContextFromThread(thread ?? null, 'inbox'), { preserveCurrentViews: true })
    setSelectedId(id)
    setSelectedThreadKey(thread?.threadKey || thread?.id || null)
    setLayoutState((current) => ({ ...current, selectedThreadId: id }))
  }, [setActiveContext, threads, viewFilter])

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
    setActiveContext({
      propertyId: context.propertyId,
      masterOwnerId: context.masterOwnerId,
      sellerId: context.masterOwnerId,
      sourceView: context.sourceView,
      intent: context.intent,
    }, {
      preserveCurrentViews: true,
      focusView: context.intent === 'open_queue' ? 'queue' : undefined,
      addViewIfMissing: context.intent === 'open_queue',
    })
  }, [setActiveContext])

  const handleOperatorAction = useCallback(async (id: string, action: string) => {
    const thread = threads.find((t) => t.id === id)
    if (!thread) return

    if (DEV) console.log(`[OperatorAction] ${action} on ${id.slice(-8)}`)

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
      case 'snooze':
        await handleWorkflowMutation('Thread: Snoozed', () => snoozeThread(thread), { skipRefresh: true })
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
      default:
        console.warn('[OperatorAction] Unknown action', action)
    }
  }, [threads, handleWorkflowMutation, handleThreadAction, DEV])


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
    const timestamp = new Date().toISOString()
    const optimisticMessage: ThreadMessage = {
      id: `pending-${selected.id}-${Date.now()}`,
      direction: 'outbound',
      body: text.trim(),
      createdAt: timestamp,
      timelineAt: timestamp,
      deliveredAt: null,
      deliveryStatus: 'sending',
      fromNumber: '',
      toNumber: selected.canonicalE164 || selected.phoneNumber || '',
      ownerId: selected.ownerId || '',
      prospectId: selected.prospectId || '',
      propertyId: selected.propertyId || '',
      phoneNumber: selected.phoneNumber || '',
      canonicalE164: selected.canonicalE164 || '',
      templateId: template?.templateId ?? template?.id ?? null,
      templateName: template?.useCase ?? null,
      agentId: null,
      source: 'operator',
      rawStatus: 'sending',
      error: null,
      metadata: { client_send_id: clientSendId },
      developerMeta: { client_send_id: clientSendId },
    }

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
            latestMessageAt: timestamp,
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

  const handleSelectQueueItem = useCallback((item: import('../../lib/data/queueData').QueueItem) => {
    setActiveContext(buildContextFromQueueItem(item, 'queue'), { preserveCurrentViews: true })
    if (item.linkedInboxThreadId) {
      const match = threads.find((thread) => thread.id === item.linkedInboxThreadId || (thread.threadKey || thread.id) === item.linkedInboxThreadId)
      if (match) {
        setSelectedId(match.id)
        setSelectedThreadKey(match.threadKey || match.id)
      }
    }
  }, [setActiveContext, threads])

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

  const { leftPanelMode, rightPanelMode, inboxMode, mapMode, activeOverlay } = layoutState
  const layoutClasses = getLayoutClassNames(layoutState)
  const mapOpen = mapMode !== 'off'
  const dossierOpen = activeOverlay === 'dossier'
  const aiOpen = activeOverlay === 'ai'
  const keysOpen = activeOverlay === 'keys'

  const renderViews: InboxWorkspaceView[] = selectedWorkspaceViews
  const workspaceBlocked = selectedWorkspacePreset.status !== 'ready'

  const isMultiView = renderViews.length > 1
  const isDefaultWorkspaceShell = isDefaultWorkspaceSet(renderViews)
  const isCustomMultiView = isMultiView && !isDefaultWorkspaceShell
  const isCommandMapView = !isMultiView && activeWorkspaceView === 'command_map'
  const isDealIntelligenceView = !isMultiView && activeWorkspaceView === 'deal_intelligence'
  const showLeftPanel = isDefaultWorkspaceShell
  const isDoubleSided = inboxMode === 'full_double'
  const showRightCommandPanel = isDefaultWorkspaceShell

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
    setWorkspaceWidthOverrides(sanitizeWorkspaceWidthOverrides(nextViews, { ...preset.widths }))
    setLayoutState(resetLayoutMode)
    emitNotification({
      title: 'Layout Reset',
      detail: `${preset.label} restored to default active views.`,
      severity: 'success',
    })
  }

  const renderSmsThreadPane = (layoutMode: ReturnType<typeof getViewLayoutMode> = 'full') => (
    <section className="nx-workspace-pane-surface nx-workspace-pane-surface--sms-thread">
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
        selectedId={selected?.id ?? null}
        activeViewFilter={viewFilter}
        onSelect={handleSelect}
        onThreadAction={handleThreadAction}
        savedPreset={savedPreset}
        onApplySavedPreset={applySavedPreset}
        viewCounts={viewCounts}
        onOpenAdvancedFilters={() => setActiveOverlay('filters')}
        onClearFilters={handleResetFilters}
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
      />
    </section>
  )

  const renderWorkspacePane = (
    view: InboxWorkspaceView,
    paneMode: 'single' | 'multi' = 'single',
    paneWidth: ViewWidthPercent = '100',
  ) => {
    const layoutMode = getViewLayoutMode(paneWidth)

    if (view === 'thread') {
      return renderInboxRailPane(paneMode, paneWidth)
    }

    if (view === 'sms_thread') {
      return renderSmsThreadPane(layoutMode)
    }

    if (view === 'list') {
      return (
        <InboxConversationTable
          threads={filtered}
          selectedId={selected?.id ?? null}
          sort={tableSort}
          density={paneMode === 'multi' && paneWidth === '75' ? 'compact' : tableDensity}
          layoutMode={layoutMode}
          statCounts={listStatCounts}
          onSortChange={setTableSort}
          onDensityChange={setTableDensity}
          onSelect={handleSelect}
        />
      )
    }

    if (view === 'command_map') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--map">
          <div className="nx-map-right-body nx-map-right-body--workspace">
            <InboxCommandMap
              threads={mapThreads}
              visibleThreads={filtered}
              selectedThread={selected}
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
          </div>
        </section>
      )
    }

    if (view === 'deal_intelligence') {
      return (
        <IntelligencePanel
          thread={selected}
          threadContext={threadContext}
          intelligence={threadIntelligence}
          dealContext={canonicalSelectedContext}
          onStatusChange={handleStatusChange}
          onStageChange={handleStageChange}
          onOpenMap={() => setSelectedWorkspaceViews(['command_map'])}
          onOpenComps={() => setSelectedWorkspaceViews(['comp_intelligence'])}
          onOpenDossier={() => handleOpenDealIntelligence(selected?.id ?? null)}
          onOpenAi={() => setActiveOverlay('ai')}
          messages={displayedMessages}
          panelMode={paneMode === 'single' ? 'full' : paneWidth === '25' || paneWidth === '50' ? 'half' : 'default'}
          layoutMode={layoutMode}
        />

      )
    }

    if (view === 'pipeline') {
      return (
        <InboxPipelineView
          threads={pipelineThreads}
          selectedId={selected?.id ?? null}
          selectedThread={selected}
          layoutMode={layoutMode}
          onSelect={handleSelect}
          onActivateThread={(thread) => setActiveContext(buildContextFromThread(thread, 'pipeline'), { preserveCurrentViews: true })}
          onOpenCommandView={handleOpenDealIntelligence}
          onThreadAction={handleOperatorAction}
        />
      )
    }

    if (view === 'queue') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--queue">
          <SendQueueDashboard
            queueModel={queueModel}
            processorHealth={queueProcessorHealth}
            queueCommandMode={queueCommandMode}
            layoutMode={layoutMode}
            selectedQueueId={activeContext.queueId ?? null}
            onSelectItem={handleSelectQueueItem}
          />
        </section>
      )
    }

    if (view === 'calendar') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--calendar">
          <InboxCalendarView
            threads={filtered}
            selectedThread={selected}
            selectedId={selected?.id ?? null}
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
        <section className="nx-workspace-surface nx-workspace-surface--metrics">
          <MetricsWarRoom layoutMode={layoutMode} paneWidth={paneWidth} paused={heavyLoadPaused} />
        </section>
      )
    }

    if (view === 'comp_intelligence') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--map">
          <CompIntelligenceWorkspace
            thread={selected}
            dealContext={canonicalSelectedContext}
            paused={heavyLoadPaused}
            paneWidth={paneWidth}
            layoutMode={layoutMode}
          />
        </section>
      )
    }

    if (view === 'buyer_match') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--map">
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
        </section>
      )
    }

    if (view === 'campaigns') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--campaigns" style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <InboxCampaignView
            selectedThread={selected}
            paneWidth={paneWidth}
            layoutMode={layoutMode}
          />
        </section>
      )
    }

    if (view === 'email') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--campaigns" style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <EmailCommandCenter
            paneWidth={paneWidth}
          />
        </section>
      )
    }

    if (view === 'workflow_studio') {
      const Studio = isWorkflowStudioV2Enabled() ? WorkflowStudioV2 : WorkflowStudio
      return (
        <section className="nx-workspace-surface nx-workspace-surface--workflow-studio" style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Studio
            paneWidth={paneWidth}
            layoutMode={layoutMode}
          />
        </section>
      )
    }

    if (view === 'closing_desk') {
      return (
        <section className="nx-workspace-surface nx-workspace-surface--queue">
          <div className="nx-workspace-card">
            <div className="nx-workspace-card__title"><Icon name="briefcase" /><span>Closing Desk</span></div>
            <p className="nx-workspace-card__body">Offers, contracts, title, escrow, signatures, and closing timeline.</p>
          </div>
          <div className="nx-workspace-card-grid">
            {[
              ['Offers', 'Offer package review, approvals, and seller revisions.'],
              ['Contracts', 'Drafts, sent contracts, counters, and execution health.'],
              ['Title', 'Ownership verification, title tasks, and clearance blockers.'],
              ['Escrow', 'Escrow milestones, deposits, and disbursement checkpoints.'],
              ['Closing Timeline', 'Critical path milestones from offer to close.'],
              ['Signatures', 'Signature state, pending signees, and reminders.'],
            ].map(([title, desc]) => (
              <div key={title} className="nx-workspace-card">
                <div className="nx-workspace-card__title"><Icon name="file-text" /><span>{title}</span></div>
                <p className="nx-workspace-card__body">{desc}</p>
                <small>Section scaffold active. Live module wiring in progress.</small>
              </div>
            ))}
          </div>
        </section>
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
        isCommandMapView && 'is-command-view-active',
        `is-workspace-${activeWorkspaceView}`,
        isCustomMultiView && 'is-multi-view-active',
      )}
    >
      <NexusTopBar
        onSelectSearchResult={handleSelect}
        topSearchQuery={topSearchQuery}
        onTopSearchQueryChange={setTopSearchQuery}
        topSearchGroups={topSearchGroups}
        topSearchLoading={topSearchLoading}
        onExecuteTopSearchResult={handleExecuteTopSearchResult}
        selectedThread={selected}
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
          updateSetting('accentPalette', accent)
          applyThemeToDOM()
        }}
        activeOverlay={activeOverlay}
        onOpenOverlay={setActiveOverlay}
        onCloseOverlay={() => setActiveOverlay(null)}
        activeWorkspaceKey={selectedWorkspaceKey}
        activeWorkspaceLabel={activeWorkspaceLabel}
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
        onOpenTasks={() => emitNotification({ title: 'Tasks', detail: 'Tasks menu is coming soon.', severity: 'warning' })}
        onOpenSettings={undefined}
        onResetLayout={handleResetWorkspaceLayout}
        dryRun={autonomyControls.dryRun}
        onToggleDryRun={() => setAutonomyControls(prev => ({ ...prev, dryRun: !prev.dryRun }))}
      />
      {workspaceBlocked ? (
        <div className="nx-inbox-shell nx-inbox-shell--workspace-status">{renderWorkspaceStatusShell()}</div>
      ) : isDealIntelligenceView && !isMultiView ? (
        <div className="nx-deal-intelligence-fullscreen">
          <IntelligencePanel
            thread={selected}
            threadContext={threadContext}
            intelligence={threadIntelligence}
            dealContext={canonicalSelectedContext}
            onStatusChange={handleStatusChange}
            onStageChange={handleStageChange}
            onOpenMap={() => setSelectedWorkspaceViews(['command_map'])}
            onOpenComps={() => setSelectedWorkspaceViews(['comp_intelligence'])}
            onOpenDossier={() => handleOpenDealIntelligence(selected?.id ?? null)}
            onOpenAi={() => setActiveOverlay('ai')}
            messages={displayedMessages}
            panelMode="full"
            layoutMode="full"
          />

      </div>
      ) : (
      <div
        className={cls('nx-inbox-shell', mobileSidebarOpen && 'm-sidebar-open', mobileIntelOpen && 'm-intel-open')}
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (target.classList.contains('nx-inbox-shell')) {
            setMobileSidebarOpen(false)
            setMobileIntelOpen(false)
          }
        }}
      >
        {/* Mobile panel toggle buttons */}
        <div className="nx-mobile-panel-toggles" style={{ display: 'none' }}>
          <button
            type="button"
            className="nx-mobile-panel-toggle"
            onClick={() => { setMobileSidebarOpen(v => !v); setMobileIntelOpen(false) }}
          >
            ☰ Threads
          </button>
          {showRightCommandPanel && (
            <button
              type="button"
              className="nx-mobile-panel-toggle"
              onClick={() => { setMobileIntelOpen(v => !v); setMobileSidebarOpen(false) }}
            >
              ◧ Intel
            </button>
          )}
        </div>
        {showLeftPanel && !isDealIntelligenceView && (
          <InboxSidebar
            threads={threads}
            selectedId={selected?.id ?? null}
            activeViewFilter={viewFilter}
            onSelect={handleSelect}
            onThreadAction={handleThreadAction}
            savedPreset={savedPreset}
            onApplySavedPreset={applySavedPreset}
            viewCounts={viewCounts}
            onOpenAdvancedFilters={() => setActiveOverlay('filters')}
            onClearFilters={handleResetFilters}
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
            densityMode={leftPanelMode === 'full' ? 'full' : 'compact'}
            inboxMode="rail25"
          />
        )}

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
            onClearFilters={handleResetFilters}
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
            isCommandMapView && 'is-command-map-mode',
          )}
        >
          {dossierOpen && (
            <MapDossierDrawer
              mode="dossier"
              thread={selected}
              context={threadContext}
              full={dossierFull}
              onToggleFull={() => setDossierFull((full) => !full)}
              onClose={() => setActiveOverlay(null)}
            />
          )}

          {selectedFilteredOut && selected && (
            <div className="nx-filtered-out-notice">
              <span>Selected thread is outside this filter.</span>
              <div className="nx-filtered-out-notice__actions">
                <button type="button" onClick={handleResetFilters}>Clear filters</button>
                <button type="button" onClick={showSelectedInFilter}>Show selected</button>
                <button type="button" onClick={() => handleThreadAction(selected, 'pin')}>Keep selected pinned</button>
              </div>
            </div>
          )}

          {isCustomMultiView ? (
            <section className="nx-workspace-split-grid">
              {renderViews.map((view) => {
                const paneWidth = workspaceWidths[view] ?? '25'
                const layoutMode = getViewLayoutMode(paneWidth)
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
                    style={{ flex: `0 0 ${paneWidth}%` }}
                  >
                    {renderWorkspacePane(view, 'multi', paneWidth)}
                  </div>
                )
              })}
            </section>
          ) : isDefaultWorkspaceShell ? (
            renderWorkspacePane('sms_thread', 'single')
          ) : (
            renderWorkspacePane(activeWorkspaceView, 'single')
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
                selectedThread={selected}
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
        ) : showRightCommandPanel ? (
          <IntelligencePanel
            thread={selected}
            threadContext={threadContext}
            intelligence={threadIntelligence}
            dealContext={canonicalSelectedContext}
            onStatusChange={handleStatusChange}
            onStageChange={handleStageChange}
            onOpenMap={() => setSelectedWorkspaceViews(['command_map'])}
            onOpenComps={() => setSelectedWorkspaceViews(['comp_intelligence'])}
            onOpenDossier={() => handleOpenDealIntelligence(selected?.id ?? null)}
            onOpenAi={() => setActiveOverlay('ai')}
            messages={displayedMessages}
            panelMode={rightPanelMode === 'hidden' ? 'default' : rightPanelMode}
            layoutMode={getViewLayoutMode(workspaceWidths['deal_intelligence'] ?? '25')}
          />
        ) : null}
      </div>
      )}

      <AdvancedFiltersPopover
        open={activeOverlay === 'filters'}
        stageFilter={stageFilter}
        setStageFilter={setStageFilter}
        viewFilter={viewFilter}
        setViewFilter={setViewFilter}
        advancedFilters={advancedFilters}
        onAdvancedFiltersChange={(filters) => setAdvancedFilters(filters)}
        advancedFilterOptions={advancedFilterOptions}
        viewCounts={viewCounts}
        onReset={handleResetFilters}
        onClose={() => setActiveOverlay(null)}
        onApply={() => { /* Handled by useEffect */ }}
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
