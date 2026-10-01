/**
 * THE HOME READ MODEL.
 *
 * Home is an orchestration surface: it owns no data. Every figure on it is read from
 * the same endpoint the destination app reads, so a number on Home and the number
 * one tap away can never disagree.
 *
 * Each source resolves independently into a `HomeLoad`. The distinction that matters
 * is `unavailable` versus zero: several loaders in this codebase coerce a failed
 * read into zeros (processor health reports 0 failed, the closing desk serves a
 * fixture, market performance returns []), and on a command surface that reads as
 * "everything is fine" at exactly the moment it is not. The loaders below call the
 * transport directly and treat anything short of a well-formed success as
 * unavailable, which the modules render as such.
 *
 * Everything below the loaders is pure, so the Focus ranking and the pipeline
 * grouping are testable without a network.
 */
import { callBackend, fetchInboxCounts, getCockpitOpsMetrics } from '../../lib/api/backendClient'
import { fetchLiveInbox } from '../../lib/data/inboxData'
import type { InboxThread } from '../../domain/inbox/inbox-model-types'
import { fetchCampaignsSurface } from '../campaign-command/campaigns.adapter'
import { computeCampaignHealth } from '../campaign-command/campaign-health'
import type { CampaignSummary } from '../campaign-command/campaigns.types'
import { loadPipelineMetricsSurface } from '../../domain/pipeline/pipeline-surface-loader'
import { fetchClosingDeskModel } from '../../domain/closing-desk/closing-desk-api'
import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import { loadCalendarEventsWithMeta, type CalendarEvent, type CalendarEventType } from '../../lib/data/calendarData'
import type { CalendarLayerId } from '../../lib/calendar/calendar-layers'
import { projectAlbersUsa } from './home-geo'
import type { IconName } from '../../shared/icons'

// ── Load envelope ───────────────────────────────────────────────────────────

export type HomeLoad<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; at: number }
  | { status: 'unavailable'; reason: string }

export const ready = <T,>(data: T): HomeLoad<T> => ({ status: 'ready', data, at: Date.now() })
export const unavailable = <T,>(reason: string): HomeLoad<T> => ({ status: 'unavailable', reason })

export const dataOf = <T,>(load: HomeLoad<T>): T | null => (load.status === 'ready' ? load.data : null)

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const failureReason = (result: { ok: false; message?: string; error?: string; status?: number }) =>
  result.message || result.error || `HTTP ${result.status ?? 'error'}`

// ── Inbox ───────────────────────────────────────────────────────────────────

export interface HomeThread {
  id: string
  threadKey: string | null
  propertyId: string | null
  prospectId: string | null
  masterOwnerId: string | null
  seller: string
  address: string | null
  market: string | null
  preview: string
  at: string | null
  unread: boolean
  hot: boolean
  urgent: boolean
}

export interface HomeInbox {
  /** Seller replies waiting on the operator — the `new_replies` bucket. */
  newReplies: number | null
  priority: number | null
  needsAttention: number | null
  threads: HomeThread[]
}

const sellerName = (thread: InboxThread) =>
  str(thread.ownerDisplayName) || str(thread.sellerName) || str(thread.ownerName) || 'Unknown Seller'

const toHomeThread = (thread: InboxThread): HomeThread => {
  const raw = thread as InboxThread & Record<string, unknown>
  return {
    id: thread.id,
    threadKey: str(thread.threadKey) ?? str(thread.id),
    propertyId: str(thread.propertyId),
    prospectId: str(thread.prospectId),
    masterOwnerId: str(raw.masterOwnerId) ?? str(thread.ownerId),
    seller: sellerName(thread),
    address: str(thread.propertyAddressFull) || str(thread.propertyAddress),
    market: str(thread.market) || [str(thread.city), str(thread.state)].filter(Boolean).join(', ') || null,
    preview: str(thread.latestMessageBody) || str(thread.preview) || '',
    at: str(thread.lastInboundAt) || str(thread.latestMessageAt) || str(thread.lastMessageIso),
    unread: thread.status === 'unread' || (thread.unreadCount ?? 0) > 0,
    hot: thread.sentiment === 'hot',
    urgent: thread.priority === 'urgent' || thread.priority === 'high',
  }
}

export async function loadHomeInbox(signal?: AbortSignal): Promise<HomeLoad<HomeInbox>> {
  try {
    const response = await fetchLiveInbox({
      filter: 'new_replies',
      direction: 'all',
      limit: 6,
      map: false,
      skipDelivery: true,
      timeoutMode: 'auto_refresh',
      refreshReason: 'home_snapshot',
      signal,
    })
    let counts: Record<string, unknown> = response.counts ?? {}
    // The live list skips its bucket counts on an auto-refresh (they come back
    // null, flagged degraded); the canonical counts endpoint has them.
    if (num(counts.new_replies ?? counts.needs_reply) === null) {
      const canonical = await fetchInboxCounts(signal).catch(() => null)
      const body = canonical && canonical.ok ? (canonical.data as { counts?: Record<string, unknown> } | null) : null
      if (body?.counts) counts = body.counts
    }
    return ready({
      newReplies: num(counts.new_replies ?? counts.needs_reply),
      priority: num(counts.priority ?? counts.hot_leads),
      needsAttention: num(counts.needs_attention),
      threads: response.threads.map(toHomeThread),
    })
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'Inbox unavailable')
  }
}

// ── Queue / delivery engine ─────────────────────────────────────────────────

export type EngineStatus = 'healthy' | 'warning' | 'critical'

export interface HomeQueue {
  status: EngineStatus
  sentToday: number
  deliveredToday: number
  failedToday: number
  /** Rows the engine still owes: queued, pending, approval, scheduled and sending. */
  inFlight: number
  awaitingApproval: number
  lagging: number
  stale: number
  latestSentAt: string | null
}

export async function loadHomeQueue(): Promise<HomeLoad<HomeQueue>> {
  const result = await callBackend<Record<string, unknown>>('/api/cockpit/queue/processor-health')
  if (!result.ok) return unavailable(failureReason(result))
  const payload = result.data ?? {}
  if (payload.ok === false || !payload.counts || typeof payload.counts !== 'object') {
    return unavailable(str(payload.message) ?? 'Queue health returned no counts')
  }
  const counts = payload.counts as Record<string, unknown>
  const n = (key: string) => num(counts[key]) ?? 0
  const status = payload.status === 'critical' || payload.status === 'warning' ? payload.status : 'healthy'
  return ready({
    status,
    sentToday: n('sentToday'),
    deliveredToday: n('deliveredToday'),
    failedToday: n('failedToday'),
    inFlight: n('queued') + n('pending') + n('approval') + n('scheduled') + n('processing'),
    awaitingApproval: n('approval'),
    lagging: n('lagActive'),
    stale: n('staleActive'),
    latestSentAt: str(payload.latestSentAt),
  })
}

// ── Messaging today ─────────────────────────────────────────────────────────

export interface HomeMessaging {
  sent: number | null
  delivered: number | null
  replies: number | null
  failed: number | null
  /** Sending numbers that actually sent today — not the size of the fleet. */
  sendersActive: number | null
  deliveryRate: number | null
  replyRate: number | null
}

export async function loadHomeMessaging(): Promise<HomeLoad<HomeMessaging>> {
  const result = await getCockpitOpsMetrics('today')
  if (!result.ok) return unavailable(failureReason(result))
  const diagnostics = result.data?.ok === false ? null : result.data?.diagnostics
  if (!diagnostics) return unavailable('Messaging metrics returned no diagnostics')
  const senders = Array.isArray(diagnostics.sender_performance) ? diagnostics.sender_performance : null
  return ready({
    sent: num(diagnostics.sent_count),
    delivered: num(diagnostics.delivered_count),
    replies: num(diagnostics.received_count),
    failed: num(diagnostics.failed_count),
    sendersActive: senders ? senders.filter((row) => (num(row.sent_count) ?? 0) > 0).length : null,
    deliveryRate: num(diagnostics.delivery_rate),
    replyRate: num(diagnostics.reply_rate),
  })
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export interface HomeCampaign {
  id: string
  name: string
  market: string | null
  status: CampaignSummary['status']
  ready: number
  total: number
  sent: number
  replies: number
  issue: string | null
}

export interface HomeCampaigns {
  live: number
  paused: number
  readyTargets: number
  attention: HomeCampaign[]
  highlighted: HomeCampaign[]
  degraded: boolean
}

const RUNNING = new Set<CampaignSummary['status']>(['active', 'activating', 'live_limited', 'queued'])
const RETIRED = new Set<CampaignSummary['status']>(['archived', 'completed', 'draft', 'previewed'])

const toHomeCampaign = (campaign: CampaignSummary): HomeCampaign => {
  const health = computeCampaignHealth(campaign)
  return {
    id: campaign.id,
    name: campaign.campaign_name || 'Untitled campaign',
    market: str(campaign.market_label),
    status: campaign.status,
    ready: campaign.ready_targets ?? 0,
    total: campaign.total_targets ?? 0,
    sent: campaign.sent_count ?? 0,
    replies: campaign.reply_count ?? 0,
    issue: health.issues[0] ?? (health.level === 'dangerous' ? 'Delivery health is dangerous' : null),
  }
}

export function summarizeCampaigns(campaigns: CampaignSummary[], degraded = false): HomeCampaigns {
  const running = campaigns.filter((campaign) => RUNNING.has(campaign.status))
  const considered = campaigns.filter((campaign) => !RETIRED.has(campaign.status))
  const attention = considered
    .map(toHomeCampaign)
    .filter((campaign) => campaign.issue !== null || campaign.status === 'failed')
  const highlighted = running
    .map(toHomeCampaign)
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 2)
  return {
    live: running.length,
    paused: campaigns.filter((campaign) => campaign.status === 'paused').length,
    readyTargets: running.reduce((total, campaign) => total + (campaign.ready_targets ?? 0), 0),
    attention,
    highlighted,
    degraded,
  }
}

export async function loadHomeCampaigns(): Promise<HomeLoad<HomeCampaigns>> {
  try {
    const surface = await fetchCampaignsSurface()
    if (!surface.ok) return unavailable(surface.errorMessage ?? 'Campaigns unavailable')
    return ready(summarizeCampaigns(surface.data, Boolean(surface.degraded)))
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'Campaigns unavailable')
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export type PipelineBucketId = 'new' | 'talking' | 'offer' | 'contract' | 'closing'

export interface PipelineBucket {
  id: PipelineBucketId
  label: string
  count: number
  color: string
}

/**
 * The ten canonical stages (S1–S10), folded into the five an operator thinks in.
 * S10 Closed is deliberately excluded: this bar is the work in motion, and a
 * growing closed count would slowly flatten every other segment.
 */
const BUCKET_STAGES: Array<{ id: PipelineBucketId; label: string; color: string; stages: string[] }> = [
  { id: 'new', label: 'New', color: '#60a5fa', stages: ['ownership_confirmation', 'offer_interest'] },
  { id: 'talking', label: 'Talking', color: '#a78bfa', stages: ['asking_price', 'property_condition'] },
  { id: 'offer', label: 'Offer', color: '#f5b84a', stages: ['offer'] },
  { id: 'contract', label: 'Contract', color: '#34d399', stages: ['formal_contract', 'disposition', 'under_contract'] },
  { id: 'closing', label: 'Closing', color: '#f472b6', stages: ['prepared_to_close'] },
]

export interface HomePipeline {
  active: number | null
  buckets: PipelineBucket[]
  followUpsDue: number | null
  blocked: number | null
  offers: number | null
  contractsOut: number | null
  underContract: number | null
  closing: number | null
}

export function bucketPipelineStages(byStage: Record<string, unknown> | null | undefined): PipelineBucket[] {
  return BUCKET_STAGES.map(({ id, label, color, stages }) => ({
    id,
    label,
    color,
    count: stages.reduce((total, stage) => total + (num(byStage?.[stage]) ?? 0), 0),
  }))
}

export async function loadHomePipeline(): Promise<HomeLoad<HomePipeline>> {
  const surface = await loadPipelineMetricsSurface()
  if (!surface.ok) return unavailable(surface.errorMessage ?? 'Pipeline unavailable')
  const metrics = surface.data as typeof surface.data & Record<string, unknown>
  const byStage = (metrics.by_acquisition_stage ?? metrics.by_pipeline_stage) as Record<string, unknown> | undefined
  return ready({
    active: num(metrics.active_opportunities),
    buckets: bucketPipelineStages(byStage),
    followUpsDue: num(metrics.follow_ups_due),
    blocked: num(metrics.blocked),
    offers: num(metrics.offer_ready),
    contractsOut: num(metrics.contract_sent),
    underContract: num(metrics.under_contract),
    closing: num(metrics.closing),
  })
}

// ── Closings ────────────────────────────────────────────────────────────────

export interface HomeClosing {
  name: string
  address: string | null
  date: string
}

/** Null is "the desk could not measure this", never zero. */
export interface HomeClosings {
  underContract: number | null
  closingsThisWeek: number | null
  titleBlocked: number | null
  actionRequired: number | null
  next: HomeClosing | null
}

export async function loadHomeClosings(signal?: AbortSignal): Promise<HomeLoad<HomeClosings>> {
  try {
    const model = await fetchClosingDeskModel({ limit: 100, signal })
    // The desk substitutes FIXTURE cases when its API fails. A fixture closing on the
    // Home screen would be an invented deal, so anything but live is unavailable.
    if (model.mode !== 'live') return unavailable(model.diagnostics[0] ?? 'Closing Desk is not live')
    const now = Date.now()
    const upcoming = model.cases
      .map((item) => ({ item, date: item.dates?.scheduledClosingDate ?? null }))
      .filter((entry): entry is { item: typeof entry.item; date: string } =>
        Boolean(entry.date) && new Date(entry.date as string).getTime() >= now - 86_400_000)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    const first = upcoming[0]
    return ready({
      underContract: model.summary.underContract,
      closingsThisWeek: model.summary.closingsThisWeek,
      titleBlocked: model.summary.titleBlocked,
      actionRequired: model.summary.sellerActionRequired == null && model.summary.buyerActionRequired == null
        ? null
        : (model.summary.sellerActionRequired ?? 0) + (model.summary.buyerActionRequired ?? 0),
      next: first
        ? { name: first.item.sellerName || first.item.displayName, address: first.item.propertyAddress || null, date: first.date }
        : null,
    })
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'Closing Desk unavailable')
  }
}

// ── Markets ─────────────────────────────────────────────────────────────────

export interface HomeMarket {
  market: string
  state: string | null
  sent: number
  replied: number
  positive: number
  replyRate: number | null
}

export function rankMarkets(rows: unknown[]): HomeMarket[] {
  return rows
    .map((row) => row as Record<string, unknown>)
    .map((row) => ({
      market: str(row.market) ?? 'Unknown market',
      state: str(row.state) === '—' ? null : str(row.state),
      sent: num(row.sent) ?? 0,
      replied: num(row.replied) ?? 0,
      positive: num(row.positive) ?? 0,
      replyRate: num(row.replyRate),
    }))
    .filter((row) => row.sent > 0 && !/^unknown/i.test(row.market))
    // Opportunity first (positive replies), then engagement, then volume.
    .sort((a, b) => b.positive - a.positive || b.replied - a.replied || b.sent - a.sent)
}

export async function loadHomeMarkets(): Promise<HomeLoad<HomeMarket[]>> {
  const qs = new URLSearchParams({ window: '7d', channel: 'all', state: 'all', market: 'all', agent: 'all' })
  const result = await callBackend<Record<string, unknown>>(`/api/cockpit/metrics/war-room?${qs.toString()}`)
  if (!result.ok) return unavailable(failureReason(result))
  const leaderboard = result.data?.market_leaderboard
  if (result.data?.ok === false || !Array.isArray(leaderboard)) {
    return unavailable(str(result.data?.message) ?? 'Market leaderboard unavailable')
  }
  return ready(rankMarkets(leaderboard))
}

// ── Seller replies on the map ───────────────────────────────────────────────

export interface HomeReplyPin {
  id: string
  x: number
  y: number
  hot: boolean
  seller: string
}

/**
 * Where sellers are replying from: the recent-replies bucket with the inbox's own
 * map coordinates, projected into the Home map. Threads without coordinates, and
 * Alaska/Hawaii (drawn as insets), are left off rather than misplaced.
 */
export async function loadHomeReplyPins(signal?: AbortSignal): Promise<HomeLoad<HomeReplyPin[]>> {
  try {
    const response = await fetchLiveInbox({
      filter: 'new_replies',
      direction: 'all',
      limit: 80,
      map: true,
      skipCounts: true,
      skipDelivery: true,
      timeoutMode: 'auto_refresh',
      refreshReason: 'home_map',
      signal,
    })
    const hot = new Set(response.threads.filter((t) => t.sentiment === 'hot').map((t) => str(t.threadKey) ?? t.id))
    const pins = response.mapPins.flatMap((pin): HomeReplyPin[] => {
      const point = projectAlbersUsa(Number(pin.lng), Number(pin.lat))
      if (!point) return []
      return [{ id: pin.id || pin.threadKey, x: point[0], y: point[1], hot: hot.has(pin.threadKey), seller: pin.ownerName || 'Seller' }]
    })
    return ready(pins)
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'Reply locations unavailable')
  }
}

// ── Calendar ────────────────────────────────────────────────────────────────

export interface HomeAgendaItem {
  id: string
  at: string
  allDay: boolean
  title: string
  who: string
  tone: CalendarEvent['tone']
  overdue: boolean
  hot: boolean
  threadId: string | null
}

export interface HomeCalendarDay {
  /** Local date key, YYYY-MM-DD. */
  key: string
  date: Date
  agenda: HomeAgendaItem[]
  scheduledSends: number
}

export interface HomeCalendar {
  days: HomeCalendarDay[]
  overdue: number
}

/** Record-of-what-happened types: counted elsewhere, never agenda items. */
const HISTORY_TYPES = new Set<CalendarEventType>([
  'sms_sent', 'sms_delivered', 'sms_failed', 'inbound_reply', 'historical_event',
  'dnc_suppression', 'wrong_number', 'positive_intent',
])
const SEND_TYPES = new Set<CalendarEventType>(['scheduled_sms', 'campaign_scheduled'])

const HOME_CALENDAR_LAYERS: CalendarLayerId[] = [
  'sms', 'follow_ups', 'workflow', 'campaigns', 'offers', 'contracts', 'title', 'closings', 'buyers', 'manual_events', 'risks',
]

export const localDayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function summarizeCalendar(events: CalendarEvent[], start: Date, dayCount = 7): HomeCalendar {
  const days: HomeCalendarDay[] = Array.from({ length: dayCount }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    return { key: localDayKey(date), date, agenda: [], scheduledSends: 0 }
  })
  const byKey = new Map(days.map((day) => [day.key, day]))
  let overdue = 0
  for (const event of events) {
    if (HISTORY_TYPES.has(event.type)) continue
    const when = new Date(event.timestamp)
    if (Number.isNaN(when.getTime())) continue
    if (event.overdue) overdue += 1
    const day = byKey.get(localDayKey(when))
    if (!day) continue
    if (SEND_TYPES.has(event.type)) {
      day.scheduledSends += 1
      continue
    }
    day.agenda.push({
      id: event.id,
      at: event.timestamp,
      allDay: Boolean(event.allDay),
      title: event.title,
      who: [event.sellerName, event.propertyAddress].filter((v) => v && !/unknown|unresolved/i.test(v)).join(' · '),
      tone: event.tone,
      overdue: event.overdue,
      hot: event.hot,
      threadId: event.threadId,
    })
  }
  for (const day of days) day.agenda.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.at.localeCompare(b.at))
  return { days, overdue }
}

export async function loadHomeCalendar(): Promise<HomeLoad<HomeCalendar>> {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
  const result = await loadCalendarEventsWithMeta({
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    layers: HOME_CALENDAR_LAYERS,
  })
  // The calendar's client fallback rebuilds events from raw tables with
  // placeholder sellers and addresses. On Home that would be an invented agenda.
  if (result.usedFallback || result.error) return unavailable(result.error ?? 'Calendar unavailable')
  return ready(summarizeCalendar(result.events, start))
}

// ── Focus: the cross-app priority queue ─────────────────────────────────────

export type FocusTone = 'critical' | 'high' | 'opportunity' | 'normal'

export type FocusTarget =
  | { kind: 'route'; path: string }
  | { kind: 'thread'; thread: HomeThread }

export interface FocusItem {
  id: string
  tone: FocusTone
  icon: IconName
  app: string
  title: string
  detail: string
  at: string | null
  target: FocusTarget
  /** Higher sorts first. Tone sets the band, recency orders within it. */
  weight: number
}

export interface FocusInputs {
  inbox: HomeInbox | null
  queue: HomeQueue | null
  campaigns: HomeCampaigns | null
  pipeline: HomePipeline | null
  closings: HomeClosings | null
  notifications: NotificationEvent[]
  now?: number
}

const TONE_BAND: Record<FocusTone, number> = { critical: 4000, high: 3000, opportunity: 2000, normal: 1000 }

const recency = (iso: string | null, now: number) => {
  if (!iso) return 0
  const age = now - new Date(iso).getTime()
  if (!Number.isFinite(age)) return 0
  // 0–999 inside the band: newer is higher, flattening out after ~2 days.
  return Math.max(0, 999 - Math.round(age / 180_000))
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

const NOTIFICATION_APP: Partial<Record<NotificationEvent['domain'], { app: string; path: string; icon: IconName }>> = {
  campaigns: { app: 'Campaigns', path: '/campaign-command', icon: 'bolt' },
  templates: { app: 'Campaigns', path: '/campaign-command', icon: 'file-text' },
  numbers: { app: 'Queue', path: '/queue', icon: 'phone' },
  markets: { app: 'Map', path: '/map', icon: 'map' },
  inbox: { app: 'Inbox', path: '/inbox', icon: 'message' },
  acquisition: { app: 'Pipeline', path: '/pipeline', icon: 'target' },
  closing: { app: 'Closing', path: '/closing-desk', icon: 'file-text' },
  workflow: { app: 'Workflows', path: '/workflow-studio', icon: 'layers' },
  platform: { app: 'System', path: '/queue', icon: 'cpu' },
  intelligence: { app: 'Analytics', path: '/analytics', icon: 'brain' },
}

export function notificationPath(event: NotificationEvent): string {
  const primary = event.actions.find((action) => action.primary) ?? event.actions[0]
  if (primary?.href && primary.href.startsWith('/')) return primary.href.split('?')[0]
  if (event.threadKey) return '/inbox'
  if (event.queueId) return '/queue'
  if (event.contractId) return '/closing-desk'
  if (event.campaignId) return '/campaign-command'
  return NOTIFICATION_APP[event.domain]?.path ?? '/inbox'
}

/**
 * Rank everything that wants the operator into one short list.
 *
 * The rule of thumb: system failures first (the machine cannot help itself),
 * then deals with a clock on them, then sellers who replied, then opportunity.
 * Aggregates are preferred over per-row noise — "4 campaigns need attention" is
 * one item, not four — so the list stays short enough to act on.
 */
export function buildFocusItems(inputs: FocusInputs): FocusItem[] {
  const now = inputs.now ?? Date.now()
  const items: FocusItem[] = []
  const push = (item: Omit<FocusItem, 'weight'> & { weight?: number }) =>
    items.push({ ...item, weight: TONE_BAND[item.tone] + (item.weight ?? recency(item.at, now)) })

  const { queue, campaigns, pipeline, closings, inbox } = inputs

  if (queue) {
    if (queue.status === 'critical') {
      push({
        id: 'queue-critical', tone: 'critical', icon: 'alert', app: 'Queue',
        title: 'Delivery engine needs intervention',
        detail: queue.failedToday > 0 ? `${plural(queue.failedToday, 'send')} failed today` : 'Processor reported critical health',
        at: null, target: { kind: 'route', path: '/queue' }, weight: 999,
      })
    } else if (queue.failedToday > 0) {
      push({
        id: 'queue-failed', tone: queue.failedToday >= 10 ? 'critical' : 'high', icon: 'alert-circle', app: 'Queue',
        title: `${plural(queue.failedToday, 'send')} failed today`,
        detail: 'Review and retry from the queue',
        at: null, target: { kind: 'route', path: '/queue' }, weight: 900,
      })
    }
    if (queue.status !== 'critical' && (queue.lagging > 0 || queue.stale > 0)) {
      push({
        id: 'queue-lag', tone: 'high', icon: 'clock', app: 'Queue',
        title: 'Queue is running behind',
        detail: [queue.lagging > 0 && `${queue.lagging} past the lag window`, queue.stale > 0 && `${queue.stale} stale`]
          .filter(Boolean).join(' · '),
        at: null, target: { kind: 'route', path: '/queue' }, weight: 850,
      })
    }
    if (queue.awaitingApproval > 0) {
      push({
        id: 'queue-approval', tone: 'high', icon: 'check-double', app: 'Queue',
        title: `${plural(queue.awaitingApproval, 'message')} awaiting approval`,
        detail: 'Automation is holding these for you',
        at: null, target: { kind: 'route', path: '/queue' }, weight: 700,
      })
    }
  }

  const seenNotificationTypes = new Set<string>()
  for (const event of inputs.notifications) {
    if (event.status !== 'unread') continue
    if (event.severity !== 'critical' && event.severity !== 'warning') continue
    // Inbox replies are represented by the threads below with their own deep link.
    if (event.domain === 'inbox' && event.threadKey) continue
    const key = event.groupKey || event.type
    if (seenNotificationTypes.has(key)) continue
    seenNotificationTypes.add(key)
    const meta = NOTIFICATION_APP[event.domain]
    push({
      id: `notification-${event.id}`,
      tone: event.severity === 'critical' ? 'critical' : 'high',
      icon: meta?.icon ?? 'bell',
      app: meta?.app ?? 'Alerts',
      title: event.title,
      detail: event.summary || event.body,
      at: event.createdAt,
      target: { kind: 'route', path: notificationPath(event) },
    })
  }

  if (closings?.next) {
    const days = Math.round((new Date(closings.next.date).getTime() - now) / 86_400_000)
    if (days <= 7) {
      push({
        id: 'closing-next', tone: days <= 1 ? 'critical' : 'high', icon: 'calendar', app: 'Closing',
        title: days <= 0 ? 'Closing today' : days === 1 ? 'Closing tomorrow' : `Closing in ${days} days`,
        detail: [closings.next.name, closings.next.address].filter(Boolean).join(' · '),
        at: null, target: { kind: 'route', path: '/closing-desk' }, weight: 950 - Math.max(0, days) * 10,
      })
    }
  }
  if (closings && (closings.titleBlocked ?? 0) > 0) {
    push({
      id: 'closing-title', tone: 'high', icon: 'shield', app: 'Closing',
      title: `${plural(closings.titleBlocked ?? 0, 'deal')} blocked on title`,
      detail: 'Clear title issues before the closing date',
      at: null, target: { kind: 'route', path: '/closing-desk' }, weight: 800,
    })
  }

  if (campaigns && campaigns.attention.length > 0) {
    const [first] = campaigns.attention
    push({
      id: 'campaigns-attention', tone: 'high', icon: 'bolt', app: 'Campaigns',
      title: campaigns.attention.length === 1 ? `${first.name} needs attention` : `${campaigns.attention.length} campaigns need attention`,
      detail: first.issue ?? 'Review campaign health',
      at: null, target: { kind: 'route', path: '/campaign-command' }, weight: 600,
    })
  }

  if (pipeline && (pipeline.blocked ?? 0) > 0) {
    push({
      id: 'pipeline-blocked', tone: 'high', icon: 'flag', app: 'Pipeline',
      title: `${plural(pipeline.blocked ?? 0, 'deal')} blocked or awaiting approval`,
      detail: 'Automation cannot advance these without you',
      at: null, target: { kind: 'route', path: '/pipeline' }, weight: 500,
    })
  }

  if (inbox) {
    const threads = [...inbox.threads].sort((a, b) =>
      Number(b.hot) - Number(a.hot) || Number(b.urgent) - Number(a.urgent)
      || new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())
    for (const thread of threads.slice(0, 3)) {
      push({
        id: `thread-${thread.id}`,
        tone: thread.hot || thread.urgent ? 'opportunity' : 'normal',
        icon: 'message',
        app: 'Inbox',
        title: `${thread.seller} replied`,
        detail: thread.preview || thread.address || 'Open the conversation',
        at: thread.at,
        target: { kind: 'thread', thread },
      })
    }
  }

  if (pipeline && (pipeline.followUpsDue ?? 0) > 0) {
    push({
      id: 'pipeline-followups', tone: 'normal', icon: 'clock', app: 'Pipeline',
      title: `${plural(pipeline.followUpsDue ?? 0, 'follow-up')} due`,
      detail: 'Next actions have come due',
      at: null, target: { kind: 'route', path: '/pipeline' }, weight: 400,
    })
  }

  return items.sort((a, b) => b.weight - a.weight)
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  if (ms < 45_000) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return value.toLocaleString()
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '·'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function greetingFor(date: Date): string {
  const hour = date.getHours()
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}
