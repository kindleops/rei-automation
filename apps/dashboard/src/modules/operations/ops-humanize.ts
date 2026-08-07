/**
 * Operations Center — operator-facing language.
 *
 * Constitution §0.2 forbids developer artifacts in the operator interface:
 * no internal event codes, no raw phone numbers as titles, no UUIDs where a
 * name belongs, no `[object Object]` reaching the DOM.
 *
 * The live notification feed violates this today: 198 of 200 titles are
 * `New message — +12529085640`. These helpers are the single place that
 * converts backend vocabulary into operator vocabulary.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A run of 10+ digits, optionally +1 prefixed — i.e. an E.164 or bare phone. */
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g

/** Separators the backend uses between an event label and its subject. */
const TITLE_SEPARATORS = /\s+[—–-]\s+/

export const isUuid = (value: unknown): boolean => UUID_RE.test(String(value ?? '').trim())

/** True when the string is essentially just a phone number. */
export const isPhoneLike = (value: unknown): boolean => {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return false
  return /^[+\d\s().-]+$/.test(String(value ?? '').trim())
}

/** `+12529085640` -> `(252) 908-5640`. Never returns raw E.164. */
export const formatPhoneForDisplay = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw
}

const sentenceCase = (value: string): string => {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!spaced) return ''
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ── Notification event codes ──────────────────────────────────────────────

/**
 * Event types observed in the live feed plus the catalog. Anything unmapped is
 * sentence-cased rather than rendered as `snake_case`.
 */
const EVENT_LABELS: Record<string, string> = {
  inbox_message_received: 'New message',
  inbox_hot_lead: 'Hot lead',
  inbox_negative_sentiment: 'Negative sentiment',
  inbox_opt_out: 'Opt-out received',
  inbox_ownership_confirmed: 'Ownership confirmed',
  inbox_condition_disclosed: 'Condition disclosed',
  inbox_price_disclosed: 'Price disclosed',
  inbox_needs_review: 'Needs review',
  inbox_no_reply: 'No reply',
  campaign_paused: 'Campaign paused',
  campaign_completed: 'Campaign completed',
  campaign_stalled: 'Campaign stalled',
  campaign_launched: 'Campaign launched',
  template_underperforming: 'Template underperforming',
  template_paused: 'Template paused',
  sender_delivery_failure_spike: 'Sender failure spike',
  sender_blocked: 'Sender blocked',
  sender_quota_reached: 'Sender quota reached',
  market_saturated: 'Market saturated',
  market_window_closed: 'Send window closed',
  queue_backlog: 'Queue backlog',
  queue_stalled: 'Queue stalled',
  queue_failure_spike: 'Send failure spike',
  offer_accepted: 'Offer accepted',
  offer_countered: 'Offer countered',
  offer_expired: 'Offer expired',
  contract_signed: 'Contract signed',
  closing_scheduled: 'Closing scheduled',
  workflow_failed: 'Workflow failed',
  workflow_completed: 'Workflow completed',
  platform_degraded: 'System degraded',
  platform_recovered: 'System recovered',
}

export const humanizeEventType = (eventType: unknown): string => {
  const key = String(eventType ?? '').trim().toLowerCase()
  if (!key) return 'Notification'
  return EVENT_LABELS[key] ?? sentenceCase(key)
}

export interface HumanizedTitle {
  /** Safe to render as a heading. Contains no phone number, UUID or enum code. */
  title: string
  /**
   * The subject that used to be jammed into the title — a formatted phone, a
   * name, or a campaign. Render this in a meta slot, never as the heading.
   */
  subject: string | null
  /** True when we had to strip an identifier out of the incoming title. */
  sanitized: boolean
}

/**
 * Convert a backend notification title into an operator-facing heading.
 *
 *   'New message — +12529085640'  -> { title: 'New message', subject: '(252) 908-5640' }
 *   'Hot lead — 2529085640'       -> { title: 'Hot lead',    subject: '(252) 908-5640' }
 *   '9f2c…-uuid'                  -> { title: <event label>, subject: null }
 */
export function humanizeNotificationTitle(
  rawTitle: unknown,
  fallbackEventType?: unknown,
): HumanizedTitle {
  const raw = String(rawTitle ?? '').trim()
  const eventLabel = humanizeEventType(fallbackEventType)

  if (!raw) return { title: eventLabel, subject: null, sanitized: false }

  // A bare UUID or bare phone is not a title at all.
  if (isUuid(raw)) return { title: eventLabel, subject: null, sanitized: true }
  if (isPhoneLike(raw)) {
    return { title: eventLabel, subject: formatPhoneForDisplay(raw), sanitized: true }
  }

  // `<label> — <subject>` is the catalog's dominant shape.
  const parts = raw.split(TITLE_SEPARATORS)
  if (parts.length >= 2) {
    const head = parts.slice(0, -1).join(' — ').trim()
    const tail = parts[parts.length - 1].trim()
    if (isPhoneLike(tail)) {
      return { title: head || eventLabel, subject: formatPhoneForDisplay(tail), sanitized: true }
    }
    if (isUuid(tail)) {
      return { title: head || eventLabel, subject: null, sanitized: true }
    }
  }

  // Last resort: a phone embedded mid-string.
  if (PHONE_RE.test(raw)) {
    PHONE_RE.lastIndex = 0
    const match = raw.match(PHONE_RE)
    const cleaned = raw.replace(PHONE_RE, '').replace(TITLE_SEPARATORS, ' ').replace(/\s+/g, ' ').trim()
    return {
      title: cleaned.replace(/[—–-]\s*$/, '').trim() || eventLabel,
      subject: match?.[0] ? formatPhoneForDisplay(match[0]) : null,
      sanitized: true,
    }
  }

  return { title: raw, subject: null, sanitized: false }
}

/** Never render a UUID where a person's name belongs. */
export function humanizeEntityName(value: unknown, fallback = 'Unnamed'): string {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  if (isUuid(raw)) return fallback
  if (isPhoneLike(raw)) return formatPhoneForDisplay(raw)
  return raw
}

// ── Queue enums ───────────────────────────────────────────────────────────

const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  retry: 'Retrying',
  held: 'Held',
  approval: 'Awaiting approval',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  paused_invalid_queue_row: 'Paused — row no longer valid',
  paused_invalid: 'Paused — row no longer valid',
  blocked_by_health_guard: 'Blocked — health guard',
  replied_before_send: 'Skipped — seller replied first',
  blocked_suppressed: 'Blocked — contact suppressed',
  blocked_duplicate: 'Skipped — duplicate send',
  blocked_blank_body: 'Blocked — empty message',
  blocked_no_route: 'Blocked — no sender number',
  expired: 'Expired',
}

/** `paused_invalid_queue_row` -> `Paused — row no longer valid`. */
export const humanizeQueueStatus = (status: unknown): string => {
  const key = String(status ?? '').trim().toLowerCase()
  if (!key) return 'Unknown'
  return QUEUE_STATUS_LABELS[key] ?? sentenceCase(key)
}

// ── Metric snapshot keys ──────────────────────────────────────────────────

const METRIC_LABELS: Record<string, string> = {
  intent: 'Detected intent',
  execution_mode: 'Execution mode',
  lead_temperature: 'Lead temperature',
  compliance_flag: 'Compliance flag',
  delivery_rate: 'Delivery rate',
  failure_rate: 'Failure rate',
  reply_rate: 'Reply rate',
  opt_out_rate: 'Opt-out rate',
  sent_today: 'Sent today',
  failed_today: 'Failed today',
  delivered_today: 'Delivered today',
  queue_depth: 'Queue depth',
  ready_targets: 'Ready targets',
  days_stalled: 'Days stalled',
}

/**
 * Keys that are provider/internal identifiers. These are developer artifacts
 * and are dropped rather than relabelled.
 */
const METRIC_DENYLIST = new Set([
  'provider_message_sid',
  'message_sid',
  'sid',
  'request_id',
  'trace_id',
  'correlation_id',
  'raw',
  'payload',
  'id',
])

export const isRenderableMetricKey = (key: string): boolean => {
  const k = String(key ?? '').trim().toLowerCase()
  if (!k) return false
  if (METRIC_DENYLIST.has(k)) return false
  if (k.endsWith('_sid') || k.endsWith('_id') || k.endsWith('_uuid')) return false
  return true
}

export const humanizeMetricKey = (key: string): string => {
  const k = String(key ?? '').trim().toLowerCase()
  return METRIC_LABELS[k] ?? sentenceCase(k)
}

/** Values that must never reach the DOM. */
export const isRenderableMetricValue = (value: unknown): boolean => {
  if (value == null) return false
  if (typeof value === 'object') return false
  const s = String(value).trim()
  if (!s) return false
  if (s === 'undefined' || s === 'NaN' || s === 'null' || s === '[object Object]') return false
  if (isUuid(s)) return false
  return true
}

// ── Notification action types ─────────────────────────────────────────────

const ACTION_LABEL_EXTENSIONS: Record<string, string> = {
  inspect_property: 'Open Property',
  inspect_offer: 'Open Offer',
  inspect_deal: 'Open Deal',
  inspect_contract: 'Open Contract',
  open_inbox: 'Open Inbox',
  open_queue: 'Open Queue',
  open_thread: 'Open Thread',
  reply: 'Reply',
  call: 'Call',
  escalate: 'Escalate',
  assign: 'Assign',
  snooze_1h: 'Snooze 1 hour',
  snooze_1d: 'Snooze 1 day',
  retry: 'Retry',
  retry_send: 'Retry Send',
  cancel_send: 'Cancel Send',
  suppress_contact: 'Suppress Contact',
  review: 'Review',
  view_details: 'View Details',
}

/**
 * Fallback for action types the domain contract does not map. Previously these
 * rendered as `entry.replace(/_/g,' ')`, i.e. lowercase snake_case in a button.
 */
export const humanizeActionType = (actionType: string): string => {
  const key = String(actionType ?? '').trim().toLowerCase()
  if (!key) return 'Open'
  if (ACTION_LABEL_EXTENSIONS[key]) return ACTION_LABEL_EXTENSIONS[key]
  return sentenceCase(key)
    .split(' ')
    .map((word) => (word.length > 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ')
}

// ── Toast <-> notification severity reconciliation ────────────────────────

/**
 * `shared/NotificationToast.tsx` uses 'info'|'success'|'warning'|'critical'.
 * The notification domain uses 'positive'|'neutral'|'warning'|'critical'.
 * The two were never reconciled, so a toast could not be represented in the
 * bell and vice versa.
 */
export type ToastSeverity = 'info' | 'success' | 'warning' | 'critical'
export type DomainSeverity = 'positive' | 'neutral' | 'warning' | 'critical'

export const toastSeverityToDomain = (severity: ToastSeverity | string): DomainSeverity => {
  switch (String(severity ?? '').toLowerCase()) {
    case 'success': return 'positive'
    case 'warning': return 'warning'
    case 'critical': return 'critical'
    default: return 'neutral'
  }
}

export const domainSeverityToToast = (severity: DomainSeverity | string): ToastSeverity => {
  switch (String(severity ?? '').toLowerCase()) {
    case 'positive': return 'success'
    case 'warning': return 'warning'
    case 'critical': return 'critical'
    default: return 'info'
  }
}
