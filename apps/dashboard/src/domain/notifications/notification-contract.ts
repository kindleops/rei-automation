/**
 * LeadCommand Notification Intelligence — domain contract.
 *
 * Canonical frontend types + API response mappers for the cockpit
 * notification intelligence endpoints.
 */

// ── Core enums ────────────────────────────────────────────────────────────

export type NotificationDomain =
  | 'campaigns'
  | 'templates'
  | 'numbers'
  | 'markets'
  | 'inbox'
  | 'acquisition'
  | 'closing'
  | 'workflow'
  | 'platform'
  | 'intelligence'

export type NotificationSeverity = 'positive' | 'neutral' | 'warning' | 'critical'

export type NotificationStatus = 'unread' | 'read' | 'dismissed' | 'snoozed'

export type SoundCategory =
  | 'positive-outcome'
  | 'seller-reply'
  | 'campaign-activity'
  | 'offer-contract'
  | 'warning-alert'
  | 'critical-system'

export type NotificationPatchOp =
  | 'mark_read'
  | 'mark_unread'
  | 'dismiss'
  | 'clear'
  | 'snooze'
  | 'mute_source'
  | 'bulk_mark_read'
  | 'bulk_dismiss'

export type NotificationTimeGroup = 'today' | 'yesterday' | 'earlier'

// ── Domain models ─────────────────────────────────────────────────────────

export interface NotificationAction {
  type: string
  label: string
  href?: string | null
  payload?: Record<string, unknown>
  primary?: boolean
}

export interface NotificationMetrics {
  label: string
  value: string | number
  unit?: string
  trend?: 'up' | 'down' | 'flat'
}

export interface NotificationEvent {
  id: string
  domain: NotificationDomain
  severity: NotificationSeverity
  type: string
  title: string
  body: string
  summary?: string
  status: NotificationStatus
  soundCategory: SoundCategory
  sourceId?: string | null
  sourceLabel?: string | null
  createdAt: string
  readAt?: string | null
  dismissedAt?: string | null
  snoozedUntil?: string | null
  actions: NotificationAction[]
  metrics?: NotificationMetrics[]
  threadKey?: string | null
  propertyId?: string | null
  ownerId?: string | null
  queueId?: string | null
  offerId?: string | null
  contractId?: string | null
  campaignId?: string | null
  groupedCount?: number
  groupKey?: string | null
}

export interface NotificationPreferences {
  masterMuted: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  domainMutes: Partial<Record<NotificationDomain, boolean>>
  soundCategoryEnabled: Partial<Record<SoundCategory, boolean>>
  soundCategoryVolumes: Partial<Record<SoundCategory, number>>
  pollIntervalMs?: number
  updatedAt?: string | null
}

export interface NotificationListFilters {
  severity?: NotificationSeverity | NotificationSeverity[]
  domain?: NotificationDomain | NotificationDomain[]
  status?: NotificationStatus | NotificationStatus[]
  search?: string
  limit?: number
  offset?: number
  includeDismissed?: boolean
  includeSnoozed?: boolean
}

// ── API envelopes ─────────────────────────────────────────────────────────

export interface ApiNotificationRow {
  id: string
  domain: string
  severity: string
  event_type?: string
  notification_type?: string
  type?: string
  title: string
  description?: string
  body?: string
  summary?: string
  status?: string
  sound_category?: string
  source_entity_type?: string | null
  source_entity_id?: string | null
  source_id?: string | null
  source_label?: string | null
  created_at: string
  read_at?: string | null
  dismissed_at?: string | null
  snoozed_until?: string | null
  available_actions?: Array<string | ApiNotificationActionRow>
  actions?: ApiNotificationActionRow[]
  metrics_snapshot?: Record<string, unknown> | ApiNotificationMetricRow[]
  metrics?: ApiNotificationMetricRow[]
  participant_id?: string | null
  thread_key?: string | null
  property_id?: string | null
  owner_id?: string | null
  queue_id?: string | null
  offer_id?: string | null
  deal_id?: string | null
  contract_id?: string | null
  closing_id?: string | null
  campaign_id?: string | null
  template_id?: string | null
  sender_number_id?: string | null
  market_id?: string | null
  workflow_id?: string | null
  group_count?: number
  grouped_count?: number
  grouping_key?: string | null
  group_key?: string | null
  recommendation?: Record<string, unknown> | null
}

export interface ApiNotificationActionRow {
  action_type?: string
  type?: string
  label: string
  href?: string | null
  payload?: Record<string, unknown>
  primary?: boolean
}

export interface ApiNotificationMetricRow {
  label: string
  value: string | number
  unit?: string
  trend?: string
}

export interface ApiNotificationsListResponse {
  ok?: boolean
  notifications?: ApiNotificationRow[]
  items?: ApiNotificationRow[]
  unread_count?: number
  total?: number
  scanned_at?: string
  error?: string
  message?: string
}

export interface ApiNotificationPatchResponse {
  ok?: boolean
  notification?: ApiNotificationRow
  affected_count?: number
  error?: string
  message?: string
}

export interface ApiNotificationActionResponse {
  ok?: boolean
  result?: Record<string, unknown>
  href?: string | null
  error?: string
  message?: string
}

export interface ApiNotificationPreferencesResponse {
  ok?: boolean
  preferences?: Partial<ApiNotificationPreferencesRow>
  error?: string
  message?: string
}

export interface ApiNotificationPreferencesRow {
  master_muted?: boolean
  quiet_hours_enabled?: boolean
  quiet_hours_start?: string
  quiet_hours_end?: string
  domain_mutes?: Record<string, boolean>
  sound_category_enabled?: Record<string, boolean>
  sound_category_volumes?: Record<string, number>
  poll_interval_ms?: number
  updated_at?: string | null
}

export interface ApiNotificationScanResponse {
  ok?: boolean
  scanned?: number
  created?: number
  updated?: number
  campaigns_checked?: number
  notifications_created?: number
  error?: string
  message?: string
}

// ── Normalizers ─────────────────────────────────────────────────────────

const DOMAIN_SET = new Set<NotificationDomain>([
  'campaigns', 'templates', 'numbers', 'markets', 'inbox', 'acquisition', 'closing', 'workflow', 'platform', 'intelligence',
])

const SEVERITY_SET = new Set<NotificationSeverity>(['positive', 'neutral', 'warning', 'critical'])

const STATUS_SET = new Set<NotificationStatus>(['unread', 'read', 'dismissed', 'snoozed'])

const SOUND_CATEGORY_SET = new Set<SoundCategory>([
  'positive-outcome',
  'seller-reply',
  'campaign-activity',
  'offer-contract',
  'warning-alert',
  'critical-system',
])

const SEVERITY_FROM_LEGACY: Record<string, NotificationSeverity> = {
  info: 'neutral',
  success: 'positive',
  positive: 'positive',
  neutral: 'neutral',
  warning: 'warning',
  critical: 'critical',
}

const SOUND_FROM_SEVERITY: Record<NotificationSeverity, SoundCategory> = {
  positive: 'positive-outcome',
  neutral: 'seller-reply',
  warning: 'warning-alert',
  critical: 'critical-system',
}

const SOUND_FROM_DOMAIN: Partial<Record<NotificationDomain, SoundCategory>> = {
  inbox: 'seller-reply',
  campaigns: 'campaign-activity',
  acquisition: 'offer-contract',
  closing: 'offer-contract',
  platform: 'critical-system',
  workflow: 'warning-alert',
  templates: 'campaign-activity',
  numbers: 'warning-alert',
  markets: 'campaign-activity',
}

const ACTION_LABELS: Record<string, string> = {
  pause_campaign: 'Pause Campaign',
  resume_campaign: 'Resume Campaign',
  scale_campaign: 'Scale Up',
  pause_template: 'Pause Template',
  resume_template: 'Reactivate Template',
  pause_sender: 'Pause Number',
  resume_sender: 'Resume Number',
  inspect_campaign: 'Open Campaign',
  inspect_template: 'Open Template',
  inspect_sender: 'Open Number',
  inspect_thread: 'Open Thread',
  inspect_market: 'Open Market',
  inspect_queue: 'View Queue',
  inspect_workflow: 'Open Workflow',
  inspect_closing: 'Open Closing Desk',
  navigate: 'Open',
  dismiss: 'Dismiss',
  snooze: 'Snooze',
  mark_read: 'Mark Read',
  clear: 'Clear',
  resolve: 'Resolve',
  run_scan: 'Run Scan',
  approve_scale: 'Approve Scale',
  approve_pause: 'Approve Pause',
  retry_queue_item: 'Retry',
  acknowledge: 'Acknowledge',
  mute_domain: 'Mute Domain',
  mute_entity: 'Mute Source',
  open_workflow: 'Open Workflow',
  open_closing_case: 'Open Closing Desk',
}

export function normalizeNotificationDomain(raw: string | undefined | null): NotificationDomain {
  const value = String(raw ?? 'platform').toLowerCase() as NotificationDomain
  return DOMAIN_SET.has(value) ? value : 'platform'
}

export function normalizeNotificationSeverity(raw: string | undefined | null): NotificationSeverity {
  const value = String(raw ?? 'neutral').toLowerCase()
  if (SEVERITY_SET.has(value as NotificationSeverity)) return value as NotificationSeverity
  return SEVERITY_FROM_LEGACY[value] ?? 'neutral'
}

export function deriveNotificationStatus(row: ApiNotificationRow): NotificationStatus {
  if (row.snoozed_until) {
    const until = new Date(row.snoozed_until)
    if (Number.isFinite(until.getTime()) && until > new Date()) return 'snoozed'
  }
  if (row.status === 'dismissed' || row.dismissed_at) return 'dismissed'
  if (row.read_at) return 'read'
  return 'unread'
}

export function normalizeNotificationStatus(raw: string | undefined | null): NotificationStatus {
  const value = String(raw ?? 'unread').toLowerCase() as NotificationStatus
  return STATUS_SET.has(value) ? value : 'unread'
}

export function normalizeSoundCategory(
  raw: string | undefined | null,
  severity: NotificationSeverity,
  domain: NotificationDomain,
): SoundCategory {
  const value = String(raw ?? '').toLowerCase() as SoundCategory
  if (SOUND_CATEGORY_SET.has(value)) return value
  return SOUND_FROM_DOMAIN[domain] ?? SOUND_FROM_SEVERITY[severity]
}

export function mapApiNotificationAction(row: ApiNotificationActionRow): NotificationAction {
  return {
    type: String(row.action_type ?? row.type ?? 'open'),
    label: row.label,
    href: row.href ?? null,
    payload: row.payload,
    primary: row.primary ?? false,
  }
}

export function mapApiNotificationMetric(row: ApiNotificationMetricRow): NotificationMetrics {
  const trend = row.trend === 'up' || row.trend === 'down' || row.trend === 'flat' ? row.trend : undefined
  return {
    label: row.label,
    value: row.value,
    unit: row.unit,
    trend,
  }
}

function mapAvailableActions(row: ApiNotificationRow): NotificationAction[] {
  const raw = row.available_actions ?? row.actions ?? []
  if (!Array.isArray(raw)) return []

  return raw.map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        type: entry,
        label: ACTION_LABELS[entry] ?? entry.replace(/_/g, ' '),
        primary: index === 0,
      }
    }
    return mapApiNotificationAction(entry)
  })
}

function mapMetricsSnapshot(row: ApiNotificationRow): NotificationMetrics[] | undefined {
  if (Array.isArray(row.metrics)) {
    return row.metrics.map(mapApiNotificationMetric)
  }

  const snapshot = row.metrics_snapshot
  if (!snapshot || Array.isArray(snapshot)) return undefined
  if (typeof snapshot !== 'object') return undefined

  const metrics: NotificationMetrics[] = []
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null || typeof value === 'object') continue
    metrics.push({
      label: key.replace(/_/g, ' '),
      value: typeof value === 'number' ? value : String(value),
    })
  }
  return metrics.length ? metrics : undefined
}

export function mapApiNotification(row: ApiNotificationRow): NotificationEvent {
  const domain = normalizeNotificationDomain(row.domain)
  const severity = normalizeNotificationSeverity(row.severity)
  return {
    id: row.id,
    domain,
    severity,
    type: String(row.event_type ?? row.notification_type ?? row.type ?? 'notification'),
    title: row.title,
    body: row.description ?? row.body ?? row.summary ?? '',
    summary: row.summary,
    status: deriveNotificationStatus(row),
    soundCategory: normalizeSoundCategory(row.sound_category, severity, domain),
    sourceId: row.source_entity_id ?? row.source_id ?? null,
    sourceLabel: row.source_entity_type ?? row.source_label ?? null,
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
    dismissedAt: row.dismissed_at ?? null,
    snoozedUntil: row.snoozed_until ?? null,
    actions: mapAvailableActions(row),
    metrics: mapMetricsSnapshot(row),
    threadKey: row.participant_id ?? row.thread_key ?? null,
    propertyId: row.property_id ?? null,
    ownerId: row.owner_id ?? null,
    queueId: row.queue_id ?? null,
    offerId: row.offer_id ?? row.deal_id ?? null,
    contractId: row.contract_id ?? row.closing_id ?? null,
    campaignId: row.campaign_id ?? null,
    groupedCount: row.group_count ?? row.grouped_count ?? undefined,
    groupKey: row.grouping_key ?? row.group_key ?? null,
  }
}

export function mapApiNotificationsList(
  envelope: ApiNotificationsListResponse | null | undefined,
): { notifications: NotificationEvent[]; unreadCount: number; total: number; scannedAt: string | null } {
  const rows = envelope?.notifications ?? envelope?.items ?? []
  const notifications = Array.isArray(rows) ? rows.map(mapApiNotification) : []
  return {
    notifications,
    unreadCount: Number(envelope?.unread_count ?? notifications.filter((n) => n.status === 'unread').length),
    total: Number(envelope?.total ?? notifications.length),
    scannedAt: envelope?.scanned_at ?? null,
  }
}

export function mapApiPreferences(row: Partial<ApiNotificationPreferencesRow> | null | undefined): NotificationPreferences {
  const domainMutes: Partial<Record<NotificationDomain, boolean>> = {}
  for (const [key, value] of Object.entries(row?.domain_mutes ?? {})) {
    if (DOMAIN_SET.has(key as NotificationDomain)) {
      domainMutes[key as NotificationDomain] = Boolean(value)
    }
  }

  const soundCategoryEnabled: Partial<Record<SoundCategory, boolean>> = {}
  const soundCategoryVolumes: Partial<Record<SoundCategory, number>> = {}
  for (const [key, value] of Object.entries(row?.sound_category_enabled ?? {})) {
    if (SOUND_CATEGORY_SET.has(key as SoundCategory)) {
      soundCategoryEnabled[key as SoundCategory] = Boolean(value)
    }
  }
  for (const [key, value] of Object.entries(row?.sound_category_volumes ?? {})) {
    if (SOUND_CATEGORY_SET.has(key as SoundCategory)) {
      const numeric = Number(value)
      soundCategoryVolumes[key as SoundCategory] = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0.5
    }
  }

  return {
    masterMuted: Boolean(row?.master_muted),
    quietHoursEnabled: Boolean(row?.quiet_hours_enabled),
    quietHoursStart: row?.quiet_hours_start ?? '22:00',
    quietHoursEnd: row?.quiet_hours_end ?? '07:00',
    domainMutes,
    soundCategoryEnabled,
    soundCategoryVolumes,
    pollIntervalMs: row?.poll_interval_ms,
    updatedAt: row?.updated_at ?? null,
  }
}

export function serializePreferences(prefs: NotificationPreferences): ApiNotificationPreferencesRow {
  return {
    master_muted: prefs.masterMuted,
    quiet_hours_enabled: prefs.quietHoursEnabled,
    quiet_hours_start: prefs.quietHoursStart,
    quiet_hours_end: prefs.quietHoursEnd,
    domain_mutes: prefs.domainMutes,
    sound_category_enabled: prefs.soundCategoryEnabled,
    sound_category_volumes: prefs.soundCategoryVolumes,
    poll_interval_ms: prefs.pollIntervalMs,
  }
}

export function groupNotificationsByTime(notifications: NotificationEvent[]): Record<NotificationTimeGroup, NotificationEvent[]> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)

  const groups: Record<NotificationTimeGroup, NotificationEvent[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  }

  for (const item of notifications) {
    const created = new Date(item.createdAt)
    if (Number.isNaN(created.getTime())) {
      groups.earlier.push(item)
      continue
    }
    if (created >= startOfToday) {
      groups.today.push(item)
    } else if (created >= startOfYesterday) {
      groups.yesterday.push(item)
    } else {
      groups.earlier.push(item)
    }
  }

  return groups
}

export const NOTIFICATION_DOMAINS: NotificationDomain[] = [
  'campaigns', 'templates', 'numbers', 'markets', 'inbox', 'acquisition', 'closing', 'workflow', 'platform', 'intelligence',
]

export const NOTIFICATION_SEVERITIES: NotificationSeverity[] = [
  'positive', 'neutral', 'warning', 'critical',
]

export const SOUND_CATEGORIES: SoundCategory[] = [
  'positive-outcome',
  'seller-reply',
  'campaign-activity',
  'offer-contract',
  'warning-alert',
  'critical-system',
]