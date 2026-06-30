import type { QueueItem } from '../../domain/queue/queue.types'
import { FAILURE_LABEL } from '../../domain/queue/classifyFailure'
import { resolveQueueDispatchTruth } from '../../domain/queue/queue-dispatch-truth'

export type QueueDensity = 'comfortable' | 'compact' | 'command'

export const QUEUE_DENSITY_ORDER: QueueDensity[] = ['comfortable', 'compact', 'command']

export const QUEUE_DENSITY_LABEL: Record<QueueDensity, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
  command: 'Command',
}

export const queueShowsMessagePreview = (density: QueueDensity): boolean =>
  density === 'comfortable'
export type QueueSection = 'queue' | 'templates' | 'senders' | 'market' | 'failures' | 'events'

export const BLOCKED_STATUSES = new Set([
  'blocked', 'paused_invalid_queue_row', 'paused_name_missing', 'paused_max_retries',
  'paused_duplicate', 'paused_global_lock', 'duplicate_blocked', 'incident_quarantine',
])

const DELIVERED_STATUSES = new Set(['delivered'])
const FAILED_STATUSES = new Set(['failed', 'retry', 'retrying'])
const SENT_STATUSES = new Set(['sent', 'delivered', 'failed', 'retry', 'retrying'])

export const isDelivered = (s: string) => DELIVERED_STATUSES.has(s)
export const isFailed = (s: string) => FAILED_STATUSES.has(s)
export const isSent = (s: string) => SENT_STATUSES.has(s)

const INVALID_NAMES = new Set([
  'unknown contact', 'unknown seller', 'unknown owner', 'unknown', '—', '-', 'no phone',
])

const clean = (v: string | null | undefined): string => String(v ?? '').trim()

const looksLikePhone = (v: string) => /^\+?\d[\d\s().-]{6,}$/.test(v) || /^\d{10,}$/.test(v.replace(/\D/g, ''))

const isResolvableName = (name: string): boolean => {
  const t = clean(name)
  if (!t || INVALID_NAMES.has(t.toLowerCase())) return false
  if (looksLikePhone(t)) return false
  return true
}

export const isManualMessage = (item: QueueItem): boolean =>
  item.stageCode === 'manual_reply'
  || item.rowSource === 'manual'
  || item.useCase?.toLowerCase().includes('manual') === true
  || item.automationSource?.toLowerCase().includes('manual') === true
  || (Boolean(item.messageText?.trim()) && !item.templateId && item.rowSource !== 'campaign')

export const resolveMessageSource = (item: QueueItem): string => {
  if (item.stageCode === 'manual_reply' || item.rowSource === 'manual') return 'Manual Reply'
  if (item.rowSource === 'auto_reply' || item.stageCode === 'auto_reply') return 'Auto Reply'
  if (item.campaignName) return item.campaignName
  if (item.automationSource) return item.automationSource
  return item.useCase || 'Queue'
}

export const resolveTemplateLabel = (item: QueueItem): string => {
  if (isManualMessage(item)) return 'Manual Reply'
  if (item.templateName && item.templateName !== 'Template not attached') return item.templateName
  return '—'
}

export const resolveMessageLanguage = (item: QueueItem): string => {
  if (item.language === 'en') return 'EN'
  if (item.language === 'es') return 'ES'
  const text = item.messageText?.trim() ?? ''
  if (!text) return 'Unknown'
  if (/[¿¡áéíóúñ]/i.test(text) || /\b(hola|gracias|señor|buenos)\b/i.test(text)) return 'ES'
  if (/^[a-zA-Z0-9\s.,!?'"\-–—()]+$/.test(text) && text.length >= 12) return 'EN'
  return 'Unknown'
}

const pickFirstName = (candidates: Array<string | null | undefined>): string | null => {
  for (const candidate of candidates) {
    const t = clean(candidate)
    if (isResolvableName(t)) return t
  }
  return null
}

export interface SellerIdentity {
  primary: string
  secondary: string | null
  masterOwner: string | null
  phoneEnding: string | null
  glyph: 'person' | 'property' | 'unknown'
}

export const resolveSellerIdentity = (item: QueueItem): SellerIdentity => {
  const md = (item.metadata && typeof item.metadata === 'object' ? item.metadata : {}) as Record<string, unknown>
  const targetSnap = (md.target_snapshot && typeof md.target_snapshot === 'object' ? md.target_snapshot : {}) as Record<string, unknown>
  const candidateSnap = (md.candidate_snapshot && typeof md.candidate_snapshot === 'object' ? md.candidate_snapshot : {}) as Record<string, unknown>

  const phone = clean(item.toPhoneNumber || item.phone)
  const phoneEnding = phone && !phone.toLowerCase().includes('no phone') ? `…${phone.replace(/\D/g, '').slice(-4)}` : null

  const primary = pickFirstName([
    item.activeProspectFullName,
    String(targetSnap.prospect_full_name ?? targetSnap.active_prospect_full_name ?? ''),
    String(candidateSnap.prospect_full_name ?? ''),
    item.sellerFullNameResolved,
    item.sellerFullName,
    item.sellerDisplayName,
    item.sellerName,
    String(targetSnap.seller_full_name ?? ''),
    String(candidateSnap.seller_full_name ?? ''),
    item.masterOwnerDisplayName,
    String(candidateSnap.owner_display_name ?? targetSnap.owner_display_name ?? ''),
    String(md.property_owner_name ?? targetSnap.property_owner_name ?? ''),
    String(md.thread_participant_name ?? md.participant_name ?? ''),
    String(md.contact_owner_name ?? md.contact_method_owner ?? ''),
  ])
    ?? (phone && !phone.toLowerCase().includes('no phone') ? phone : null)
    ?? 'Unknown owner'

  const masterOwner = clean(
    item.masterOwnerDisplayName
    || String(candidateSnap.owner_display_name ?? targetSnap.owner_display_name ?? ''),
  ) || null

  let secondary: string | null = null
  const prospect = pickFirstName([item.activeProspectFullName, String(targetSnap.prospect_full_name ?? '')])
  if (prospect && prospect !== primary) secondary = prospect
  else if (masterOwner && masterOwner !== primary && isResolvableName(masterOwner)) secondary = masterOwner

  const glyph: SellerIdentity['glyph'] = primary === 'Unknown owner' ? 'unknown' : item.linkedPropertyId ? 'property' : 'person'

  return { primary, secondary, masterOwner, phoneEnding, glyph }
}

export const displayName = (item: QueueItem): string => resolveSellerIdentity(item).primary

export const formatDisplayStatus = (status: string): string => {
  if (status === 'approval') return 'Approval Required'
  if (status === 'held') return 'Paused'
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export interface StatusPresentation {
  primary: string
  tone: string
  blocking: string | null
  historicalWarnings: string[]
  hasCurrentException: boolean
  dispatchLabel?: string
  nextEligibleSendAt?: string | null
}

const FLAG_LABELS: Record<string, string> = {
  MISSING_TEMPLATE: 'Missing Template',
  MISSING_OWNER: 'Missing Owner',
  MISSING_MESSAGE_EVENT: 'Message Event Missing',
  MISSING_PROVIDER_ID: 'Missing Provider ID',
  MISSING_PROPERTY: 'Missing Property',
}

export const resolveStatusPresentation = (item: QueueItem): StatusPresentation => {
  const dispatchTruth = resolveQueueDispatchTruth({
    status: item.status,
    scheduledForUtc: item.scheduledForUtc,
    smsEligible: item.smsEligible,
    metadata: item.metadata,
    campaignId: item.campaignId,
    campaignStatus: (item.metadata?.campaign_status as string | undefined) ?? null,
    globalBrakes: item.metadata?.global_send_brakes as QueueItem['metadata'],
  })

  const toneMap: Record<string, string> = {
    scheduled: 'blue', queued: 'blue', sending: 'cyan', sent: 'green',
    delivered: 'green', failed: 'red', retry: 'red', blocked: 'amber',
    held: 'amber', approval: 'amber', cancelled: 'muted',
    paused_name_missing: 'amber', paused_invalid_queue_row: 'amber',
    paused_max_retries: 'amber', paused_duplicate: 'amber',
    paused_global_lock: 'amber', duplicate_blocked: 'muted',
    incident_quarantine: 'red', expired: 'muted', replied_before_send: 'green',
  }

  const manual = isManualMessage(item)
  const delivered = isDelivered(item.status)
  const terminal = delivered || item.status === 'cancelled' || item.status === 'replied_before_send'
  const historicalWarnings: string[] = []

  for (const flag of item.diagnosticFlags) {
    if (manual && (flag === 'MISSING_TEMPLATE' || flag === 'MISSING_OWNER')) continue
    if (terminal || delivered) {
      if (flag === 'MISSING_TEMPLATE' || flag === 'MISSING_OWNER' || flag === 'MISSING_MESSAGE_EVENT' || flag === 'MISSING_PROVIDER_ID') {
        historicalWarnings.push(`${FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ')} (historical)`)
        continue
      }
    }
    if (!terminal && flag === 'MISSING_TEMPLATE' && manual) continue
    if (!terminal && !delivered) historicalWarnings.push(FLAG_LABELS[flag] ?? flag.replace(/_/g, ' '))
  }

  if (delivered && item.failedReason && !isFailed(item.status)) {
    historicalWarnings.push(`Provider failure (historical): ${item.failedReason}`)
  }

  let blocking: string | null = dispatchTruth.blocker
  if (BLOCKED_STATUSES.has(item.status)) {
    blocking = item.blockedReason || item.pausedReason || item.guardReason || blocking || 'Blocked by queue guard'
  } else if (isFailed(item.status) && item.failureCategory) {
    if (!(manual && item.failureCategory === 'missing_template')) {
      blocking = FAILURE_LABEL[item.failureCategory] ?? item.failureCategory.replace(/_/g, ' ')
    }
  } else if (item.status === 'approval') {
    blocking = item.approvalReason || 'Operator approval required'
  } else if (!delivered && !manual && item.failureCategory === 'missing_template') {
    blocking = FAILURE_LABEL.missing_template ?? 'Missing template'
  }

  const hasCurrentException = Boolean(blocking)

  let tone = toneMap[item.status] ?? 'muted'
  if (delivered) tone = 'green'
  else if (item.status === 'sent' && item.deliveryStatus === 'pending') tone = 'green'

  const primary = item.dispatchLabel || dispatchTruth.label || formatDisplayStatus(item.status)

  return {
    primary,
    tone: dispatchTruth.category === 'proof' ? 'amber'
      : dispatchTruth.category === 'globally_blocked' ? 'red'
        : dispatchTruth.category === 'future_window' ? 'blue'
          : tone,
    blocking: hasCurrentException || dispatchTruth.blocker ? blocking : null,
    historicalWarnings,
    hasCurrentException: hasCurrentException || Boolean(dispatchTruth.blocker),
    dispatchLabel: dispatchTruth.label,
    nextEligibleSendAt: item.nextEligibleSendAt || dispatchTruth.nextEligibleSendAt,
  }
}

export const NON_RETRYABLE_CATEGORIES = new Set([
  'blacklist_pair_21610',
  'recipient_opted_out',
  'suppression_blocked',
  'invalid_number',
])

export const isNonRetryableRow = (item: QueueItem): boolean =>
  NON_RETRYABLE_CATEGORIES.has(item.failureCategory ?? '')
  || item.failureCategory === 'blacklist_pair_21610'
  || (item.failedReason ?? '').includes('21610')
  || !item.retryEligible

export interface BulkActionPreview {
  action: string
  affected: number
  eligible: number
  excluded: number
  markets: string[]
  senders: string[]
  campaigns?: string[]
  templates?: string[]
  exclusionReasons?: string[]
  retryable: number
  nonRetryable: number
  irreversible: boolean
  requiresPhrase: boolean
}

export const buildBulkActionPreview = (
  action: string,
  items: QueueItem[],
  rangeFailed?: number,
): BulkActionPreview => {
  const failedRows = items.filter(i => isFailed(i.status) || BLOCKED_STATUSES.has(i.status))
  const retryCandidates = items.filter(i => isFailed(i.status) && i.retryEligible && !isNonRetryableRow(i))
  const excluded = items.filter(i => isFailed(i.status) && isNonRetryableRow(i))

  const markets = [...new Set(items.map(i => i.market).filter(m => m && m !== 'Market unknown'))].sort()
  const senders = [...new Set(items.map(i => i.fromPhoneNumber).filter(Boolean))].sort()

  if (action === 'retry-all-failed') {
    const affected = rangeFailed ?? failedRows.length
    return {
      action,
      affected,
      eligible: retryCandidates.length,
      excluded: excluded.length,
      markets,
      senders,
      retryable: retryCandidates.length,
      nonRetryable: excluded.length,
      irreversible: false,
      requiresPhrase: affected > 25,
    }
  }

  if (action === 'run-queue-now') {
    const runnable = items.filter(i => ['scheduled', 'queued', 'ready'].includes(i.status))
    return {
      action,
      affected: runnable.length,
      eligible: runnable.length,
      excluded: 0,
      markets,
      senders,
      retryable: 0,
      nonRetryable: 0,
      irreversible: false,
      requiresPhrase: false,
    }
  }

  return {
    action,
    affected: items.length,
    eligible: items.length,
    excluded: 0,
    markets,
    senders,
    retryable: 0,
    nonRetryable: 0,
    irreversible: action.includes('suppress') || action.includes('cancel'),
    requiresPhrase: action.includes('suppress'),
  }
}

export const templateHealthWithSample = (
  sent: number,
  failPct: number,
): { health: 'healthy' | 'watch' | 'degraded' | 'critical' | 'insufficient'; label: string } => {
  if (sent < 5) return { health: 'insufficient', label: 'Low sample' }
  if (failPct >= 30) return { health: 'critical', label: 'Critical' }
  if (failPct >= 15) return { health: 'degraded', label: 'Degraded' }
  if (failPct >= 5) return { health: 'watch', label: 'Watch' }
  return { health: 'healthy', label: 'Healthy' }
}

export const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 100) : 0

export interface QueueKpiCounts {
  scheduled: number
  queued: number
  sending: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  approval: number
  optOuts: number
  total: number
}

export const KPI_TOOLTIPS: Record<string, string> = {
  Scheduled: 'Rows awaiting their scheduled send window. Current-state bucket.',
  Queued: 'Rows ready for the processor. Includes ready/pending statuses.',
  Sending: 'Rows actively dispatching to the provider right now.',
  Delivered: 'Provider-confirmed delivery. Subset of Sent.',
  Sent: 'All dispatched rows (delivered + failed + transient sent). Cumulative dispatch metric.',
  Failed: 'Provider or carrier failures after send attempt.',
  Blocked: 'Stopped before provider send by guards, pauses, or compliance.',
  'Opt-Outs': 'Opt-out and 21610 suppression events in range.',
  Approval: 'Rows requiring operator approval before send.',
}

export type ProcessorState = 'running' | 'idle' | 'paused' | 'degraded' | 'blocked' | 'unknown'

export interface OperationsPulseData {
  processorState: ProcessorState
  processorLabel: string
  jobsLastHour: number
  activeSenders: number
  nextScheduled: string | null
  pendingRetries: number
  approvalRequired: number
  blockedRows: number
  latestReceipt: string | null
  latestReceiptAge: string | null
  lastSuccessfulRun: string | null
  throughputLabel: string | null
  capacityLabel: string | null
}

export const buildOperationsPulse = (items: QueueItem[], kpi: QueueKpiCounts, model?: { sentTodayCount?: number; safeCapacityRemaining?: number } | null): OperationsPulseData => {
  const oneHourAgo = Date.now() - 3600000
  const jobsLastHour = items.filter(i => {
    const ts = i.sentAt || i.deliveredAt || i.lastEventAt || i.updatedAt
    return ts && new Date(ts).getTime() > oneHourAgo && isSent(i.status)
  }).length

  const activeSenders = new Set(
    items.filter(i => ['scheduled', 'queued', 'ready', 'sending'].includes(i.status) && i.fromPhoneNumber).map(i => i.fromPhoneNumber),
  ).size

  const nextRow = [...items]
    .filter(i => ['scheduled', 'queued', 'ready'].includes(i.status) && i.scheduledForLocal)
    .sort((a, b) => new Date(a.scheduledForLocal).getTime() - new Date(b.scheduledForLocal).getTime())[0]

  const latestDelivered = [...items]
    .filter(i => i.deliveredAt || (i.status === 'delivered' && i.lastEventAt))
    .sort((a, b) => new Date(b.deliveredAt ?? b.lastEventAt ?? 0).getTime() - new Date(a.deliveredAt ?? a.lastEventAt ?? 0).getTime())[0]

  const latestReceipt = latestDelivered?.deliveredAt ?? latestDelivered?.lastEventAt ?? null

  let processorState: ProcessorState = 'idle'
  if (kpi.sending > 0) processorState = 'running'
  else if (kpi.blocked > kpi.scheduled + kpi.queued) processorState = 'blocked'
  else if (kpi.failed > 10) processorState = 'degraded'
  else if (kpi.scheduled + kpi.queued === 0 && kpi.sending === 0) processorState = 'idle'

  const processorLabel = {
    running: 'Running',
    idle: 'Idle',
    paused: 'Paused',
    degraded: 'Degraded',
    blocked: 'Blocked',
    unknown: 'Unknown',
  }[processorState]

  const sentToday = model?.sentTodayCount ?? items.filter(i => i.sentAt && new Date(i.sentAt).toDateString() === new Date().toDateString()).length
  const capacity = model?.safeCapacityRemaining

  return {
    processorState,
    processorLabel,
    jobsLastHour,
    activeSenders,
    nextScheduled: nextRow?.scheduledForLocal ?? null,
    pendingRetries: items.filter(i => i.status === 'retry' && i.retryEligible).length,
    approvalRequired: kpi.approval,
    blockedRows: kpi.blocked,
    latestReceipt: latestReceipt ? (latestDelivered?.providerMessageId ?? latestDelivered?.textgridMessageId ?? 'Receipt logged') : null,
    latestReceiptAge: latestReceipt ? relTimeShort(latestReceipt) : null,
    lastSuccessfulRun: latestReceipt,
    throughputLabel: jobsLastHour > 0 ? `${jobsLastHour}/hr` : null,
    capacityLabel: capacity != null ? `${sentToday} sent · ${capacity} cap remaining` : sentToday > 0 ? `${sentToday} sent today` : null,
  }
}

const relTimeShort = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

export interface ExceptionItem {
  id: string
  priority: number
  category: string
  label: string
  urgency: 'critical' | 'high' | 'medium' | 'low'
  count: number
  action: string
  owner: string | null
  age: string | null
  market: string | null
  sender: string | null
  campaign: string | null
  causeKey: string | null
}

const EXCEPTION_PRIORITY: Array<{ key: string; label: string; urgency: ExceptionItem['urgency']; match: (i: QueueItem) => boolean; action: string }> = [
  { key: 'blacklist_pair_21610', label: 'Compliance / 21610', urgency: 'critical', match: i => i.failureCategory === 'blacklist_pair_21610', action: 'Suppress sender↔recipient pair' },
  { key: 'recipient_opted_out', label: 'Opt-out conflict', urgency: 'critical', match: i => i.failureCategory === 'recipient_opted_out' || i.failureCategory === 'suppression_blocked', action: 'Honor opt-out — do not retry' },
  { key: 'carrier', label: 'Provider rejection', urgency: 'high', match: i => i.failureGroup === 'Carrier' && isFailed(i.status), action: 'Review carrier failure and retry if eligible' },
  { key: 'missing_template', label: 'Missing template', urgency: 'high', match: i => !isManualMessage(i) && !isDelivered(i.status) && (i.failureCategory === 'missing_template' || i.diagnosticFlags.includes('MISSING_TEMPLATE')), action: 'Attach template and re-queue' },
  { key: 'message_event_missing', label: 'Message-event reconciliation', urgency: 'medium', match: i => i.diagnosticFlags.includes('MISSING_MESSAGE_EVENT'), action: 'Reconcile delivery webhook' },
  { key: 'approval', label: 'Approval required', urgency: 'medium', match: i => i.status === 'approval', action: 'Review and approve send' },
  { key: 'unknown', label: 'Unknown failure', urgency: 'low', match: i => isFailed(i.status) && !i.failureCategory, action: 'Inspect raw failure before bulk retry' },
  { key: 'retryable', label: 'Retryable transient', urgency: 'low', match: i => isFailed(i.status) && i.retryEligible && !isNonRetryableRow(i), action: 'Safe to retry within caps' },
]

export const buildExceptionsCenter = (items: QueueItem[]): ExceptionItem[] => {
  const results: ExceptionItem[] = []
  for (const rule of EXCEPTION_PRIORITY) {
    const matched = items.filter(rule.match)
    if (matched.length === 0) continue
    const sample = matched[0]
    const oldest = matched.reduce((a, b) => (new Date(a.updatedAt) < new Date(b.updatedAt) ? a : b))
    results.push({
      id: rule.key,
      priority: EXCEPTION_PRIORITY.indexOf(rule),
      category: rule.label,
      label: rule.label,
      urgency: rule.urgency,
      count: matched.length,
      action: rule.action,
      owner: sample.rowSource === 'campaign' ? 'Campaign queue' : sample.automationSource ?? null,
      age: relTimeShort(oldest.updatedAt),
      market: sample.market !== 'Market unknown' ? sample.market : null,
      sender: sample.fromPhoneNumber || null,
      campaign: sample.campaignName,
      causeKey: rule.key,
    })
  }
  return results.sort((a, b) => a.priority - b.priority)
}

export const buildSelectionPreview = (action: string, selected: QueueItem[]): BulkActionPreview => {
  const retryEligible = selected.filter(i => isFailed(i.status) && i.retryEligible && !isNonRetryableRow(i))
  const excluded = selected.filter(i => isFailed(i.status) && isNonRetryableRow(i))
  const markets = [...new Set(selected.map(i => i.market).filter(m => m && m !== 'Market unknown'))]
  const senders = [...new Set(selected.map(i => i.fromPhoneNumber).filter(Boolean))]
  const campaigns = [...new Set(selected.map(i => i.campaignName).filter(Boolean))]

  let eligible = selected.length
  if (action === 'bulk-retry') eligible = retryEligible.length
  if (action === 'bulk-cancel' || action === 'bulk-suppress') eligible = selected.filter(i => !['cancelled', 'delivered'].includes(i.status)).length

  return {
    action,
    affected: selected.length,
    eligible,
    excluded: excluded.length,
    markets,
    senders,
    retryable: retryEligible.length,
    nonRetryable: excluded.length,
    irreversible: action.includes('suppress') || action.includes('cancel'),
    requiresPhrase: action.includes('suppress') || selected.length > 10,
    campaigns,
    templates: [...new Set(selected.map(i => i.templateName).filter(t => t && t !== 'Template not attached'))],
    exclusionReasons: excluded.map(i => i.failureCategory ?? 'non-retryable').slice(0, 5),
  } as BulkActionPreview & { campaigns?: string[]; templates?: string[]; exclusionReasons?: string[] }
}

export const FLOW_STAGES = [
  { key: 'scheduled', label: 'Scheduled', cumulative: false },
  { key: 'queued', label: 'Queued', cumulative: false },
  { key: 'sending', label: 'Sending', cumulative: false, pulse: true },
  { key: 'sent', label: 'Sent', cumulative: true },
  { key: 'delivered', label: 'Delivered', cumulative: true },
] as const

export const FLOW_EXCEPTIONS = [
  { key: 'failed', label: 'Failed', tone: 'red' },
  { key: 'blocked', label: 'Blocked', tone: 'amber' },
  { key: 'approval', label: 'Approval', tone: 'amber' },
  { key: 'optOuts', label: 'Opt-Out', tone: 'red' },
] as const