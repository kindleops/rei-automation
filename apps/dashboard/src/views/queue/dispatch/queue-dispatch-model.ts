// ─── queue-dispatch-model.ts ─────────────────────────────────────────────────
// Presentation model for the mobile dispatch surface. Pure: no fetching, no
// mutation. Everything here reads fields the queue page API returns.
//
//   segment   Ready / Scheduled / Sending / Attention / History — the same
//             status buckets the server filters on (queue-page-service.js)
//   reason    the row's stored reason code in operator language
//   when      local time in the PROPERTY's timezone, with the zone named
//   recovery  a carrier-filtered first wording that the queue re-sent with
//             new copy is ONE communication that recovered, not a failure

import type { QueueItem, QueueSegment } from '../../../domain/queue/queue.types'

export type { QueueSegment }

export const SEGMENTS: ReadonlyArray<{ key: QueueSegment; label: string; short: string }> = [
  { key: 'ready', label: 'Ready', short: 'ready' },
  { key: 'scheduled', label: 'Scheduled', short: 'scheduled' },
  { key: 'sending', label: 'Sending', short: 'sending' },
  { key: 'attention', label: 'Attention', short: 'attention' },
  { key: 'history', label: 'History', short: 'sent' },
]

const READY = new Set(['queued', 'ready', 'pending', 'approved'])
const SENDING = new Set(['sending', 'processing'])
const HISTORY = new Set(['sent', 'delivered', 'cancelled', 'expired', 'replied_before_send'])
const FAILED = new Set(['failed', 'failed_transport', 'retry', 'retrying'])

const clean = (v: unknown) => String(v ?? '').trim()
const lower = (v: unknown) => clean(v).toLowerCase()
const meta = (item: QueueItem): Record<string, any> =>
  item.metadata && typeof item.metadata === 'object' ? (item.metadata as Record<string, any>) : {}

export function segmentOf(item: QueueItem): QueueSegment {
  const s = lower(item.queueStatusRaw || item.status)
  if (s === 'scheduled') return 'scheduled'
  if (READY.has(s)) return 'ready'
  if (SENDING.has(s)) return 'sending'
  if (HISTORY.has(s)) return 'history'
  return 'attention'
}

// ── Reasons ──────────────────────────────────────────────────────────────────

export type ReasonTone = 'red' | 'amber' | 'blue' | 'green' | 'muted'

export interface DispatchReason {
  title: string
  detail: string
  tone: ReasonTone
  /** Retrying or rescheduling cannot change the outcome (compliance / validity). */
  permanent: boolean
  /** The stored code the reason was read from, for diagnostics. */
  code: string | null
}

interface ReasonRule {
  match: RegExp
  title: string
  detail: string
  tone: ReasonTone
  permanent?: boolean
}

// First match wins; most specific first.
const REASON_RULES: ReasonRule[] = [
  { match: /template_asset_incompatible|asset_type_incompatible/, title: 'Template mismatch', detail: "The message was written for a different kind of property, so it was held before sending.", tone: 'amber' },
  { match: /21610|blacklist/, title: 'Carrier blocked this contact', detail: 'The carrier refuses this sender and recipient pair. It will not be retried.', tone: 'red', permanent: true },
  { match: /opted?_?out|opt-out|stop_request/, title: 'Seller opted out', detail: 'This contact asked not to be texted. It will not be retried.', tone: 'red', permanent: true },
  { match: /suppress|dnc|do_not_text/, title: 'Suppressed contact', detail: 'This contact is on a suppression list. It will not be retried.', tone: 'red', permanent: true },
  { match: /invalid_(phone|number)|to number invalid|not_textable|landline/, title: 'Not a textable number', detail: 'The number cannot receive SMS.', tone: 'red', permanent: true },
  { match: /content.?filter|textgrid_error|filtered/, title: 'Carrier filtered the wording', detail: 'The carrier rejected this wording. The queue can resend with different approved copy.', tone: 'amber' },
  { match: /health_guard|sender_health|cooldown/, title: 'Sender cooling down', detail: 'The sending number is paused after carrier errors and will resume on its own.', tone: 'amber' },
  { match: /sender_(number|ineligible|eligibility)|no_valid_(local_)?(textgrid_number|sender)|blocked_sender/, title: 'No eligible sender', detail: 'No sending number is currently allowed to text this market.', tone: 'amber' },
  { match: /blank_greeting|name_missing|seller_first_name/, title: 'Seller name missing', detail: 'The greeting would have been blank, so the message was held.', tone: 'amber' },
  { match: /duplicate/, title: 'Duplicate held', detail: 'An identical message already went to this contact.', tone: 'muted' },
  { match: /global_lock|emergency_stop|send_brake/, title: 'Global send lock', detail: 'All sending was paused when this row came up.', tone: 'amber' },
  { match: /max_retries|retry_exhausted/, title: 'Retries used up', detail: 'Every automatic retry was spent.', tone: 'red' },
  { match: /operator_review|incident_quarantine/, title: 'Held for review', detail: 'An operator has to review this row before it can send.', tone: 'amber' },
  { match: /deferred|no_renderable|no_followup_template|stage_no_reply_use_case/, title: 'No follow-up copy', detail: 'No approved template fits this follow-up yet.', tone: 'amber' },
  { match: /contact_window|quiet_hours|outside_window/, title: 'Outside contact hours', detail: "It waits for the seller's local contact window.", tone: 'blue' },
  { match: /campaign_paused/, title: 'Campaign paused', detail: 'The campaign is paused; its rows hold until it resumes.', tone: 'amber' },
  { match: /approval/, title: 'Needs approval', detail: 'An operator must approve this row before it sends.', tone: 'amber' },
  { match: /invalid_queue_row|missing_message_body|blank_message/, title: 'Row incomplete', detail: 'The row is missing data it needs to send.', tone: 'amber' },
  { match: /timeout|network|5\d\d|provider_unavailable|carrier_error|transport/, title: "Carrier didn't accept", detail: 'The carrier did not accept the message.', tone: 'red' },
]

function reasonCodes(item: QueueItem): string[] {
  const md = meta(item)
  return [
    item.guardReason, item.blockedReason, item.pausedReason, item.failedReason,
    md.skip_reason, md.provider_error?.normalized_reason, md.provider_error?.message,
    item.queueStatusRaw, item.failureCategory, item.status,
  ].map(clean).filter(Boolean)
}

export function dispatchReason(item: QueueItem): DispatchReason | null {
  const s = lower(item.queueStatusRaw || item.status)
  if (s === 'approval' || s === 'awaiting_approval') {
    return { title: 'Needs approval', detail: 'An operator must approve this row before it sends.', tone: 'amber', permanent: false, code: s }
  }
  if (s === 'expired') return { title: 'Window passed', detail: 'Its contact window closed before it could send.', tone: 'muted', permanent: false, code: s }
  if (s === 'cancelled') return { title: 'Cancelled', detail: 'This row was cancelled and will not send.', tone: 'muted', permanent: false, code: s }
  if (s === 'replied_before_send') return { title: 'Seller replied first', detail: 'The seller answered before this went out, so it was withdrawn.', tone: 'muted', permanent: false, code: s }
  if (segmentOf(item) !== 'attention') return null

  const codes = reasonCodes(item)
  const haystack = codes.join(' ').toLowerCase()
  for (const rule of REASON_RULES) {
    if (rule.match.test(haystack)) {
      const code = codes.find((c) => rule.match.test(c.toLowerCase())) ?? null
      return { title: rule.title, detail: rule.detail, tone: rule.tone, permanent: Boolean(rule.permanent), code }
    }
  }
  const failed = FAILED.has(s)
  return {
    title: failed ? 'Send failed' : 'Held before sending',
    detail: failed ? 'The message did not go out.' : 'A safety check held this row.',
    tone: failed ? 'red' : 'amber',
    permanent: false,
    code: codes[0] ?? null,
  }
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export interface DispatchRecovery {
  kind: 'recovered' | 'recovering' | 'template_corrected'
  title: string
  detail: string
}

export function dispatchRecovery(item: QueueItem): DispatchRecovery | null {
  const md = meta(item)
  const s = lower(item.queueStatusRaw || item.status)
  if (md.same_stage_failover === true) {
    if (s === 'delivered' || s === 'sent') {
      return { kind: 'recovered', title: 'Recovered automatically', detail: 'The carrier filtered the first wording; the same message went out with approved alternate copy.' }
    }
    if (segmentOf(item) !== 'attention') {
      return { kind: 'recovering', title: 'Resending with new wording', detail: 'The carrier filtered the first wording; an approved alternate is queued for this same message.' }
    }
  }
  if (md.template_reselection_reason === 'asset_type_incompatible') {
    return { kind: 'template_corrected', title: 'Template corrected', detail: "The original template didn't match this property type. It was replaced before sending." }
  }
  return null
}

// ── Time ─────────────────────────────────────────────────────────────────────

const validZone = (tz: string | null | undefined): string | null => {
  const z = clean(tz)
  if (!z) return null
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z } catch { return null }
}

const dayKey = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

/** "Today 12:10 PM CDT" / "Tomorrow 9:00 AM PDT" / "Sep 28, 9:00 AM EDT" in the property's zone. */
export function localWhen(iso: string | null | undefined, timeZone: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const tz = validZone(timeZone) ?? 'America/Chicago'
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d)
  const today = dayKey(now, tz)
  const tomorrow = dayKey(new Date(now.getTime() + 86400000), tz)
  const yesterday = dayKey(new Date(now.getTime() - 86400000), tz)
  const key = dayKey(d, tz)
  if (key === today) return `Today ${time}`
  if (key === tomorrow) return `Tomorrow ${time}`
  if (key === yesterday) return `Yesterday ${time}`
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d)
  return `${date}, ${time}`
}

/** "in 9h 12m" / "in 4m" / "3h ago" / "now". */
export function relative(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const diff = t - now.getTime()
  const abs = Math.abs(diff)
  const min = Math.round(abs / 60000)
  let span: string
  if (min < 1) return 'now'
  if (min < 60) span = `${min}m`
  else if (min < 60 * 24) {
    const h = Math.floor(min / 60)
    const m = min % 60
    span = m && h < 10 ? `${h}h ${m}m` : `${h}h`
  } else span = `${Math.round(min / 1440)}d`
  return diff > 0 ? `in ${span}` : `${span} ago`
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface DispatchStatus {
  label: string
  tone: ReasonTone | 'cyan'
}

export function dispatchStatus(item: QueueItem): DispatchStatus {
  const s = lower(item.queueStatusRaw || item.status)
  switch (segmentOf(item)) {
    case 'ready': return { label: s === 'approved' ? 'Approved' : 'Ready', tone: 'green' }
    case 'scheduled': return { label: 'Scheduled', tone: 'blue' }
    case 'sending': return { label: 'Sending', tone: 'cyan' }
    case 'history':
      if (s === 'delivered') return { label: 'Delivered', tone: 'green' }
      if (s === 'sent') return { label: 'Sent', tone: 'cyan' }
      return { label: dispatchReason(item)?.title ?? 'Closed', tone: 'muted' }
    default: {
      if (s === 'approval' || s === 'awaiting_approval') return { label: 'Approval', tone: 'amber' }
      return FAILED.has(s) ? { label: 'Failed', tone: 'red' } : { label: 'Held', tone: 'amber' }
    }
  }
}

/** The one time that matters for the row's state, phrased for it. */
export function dispatchWhen(item: QueueItem, now: Date = new Date()): { primary: string; secondary: string | null } {
  const seg = segmentOf(item)
  const tz = item.timezone
  const s = lower(item.queueStatusRaw || item.status)
  if (seg === 'scheduled' || seg === 'ready') {
    const at = item.scheduledForUtc || item.scheduledForLocal
    const local = localWhen(at, tz, now)
    const rel = relative(at, now)
    if (seg === 'ready') return { primary: rel && rel.startsWith('in ') ? `Sends ${rel}` : 'Next processor pass', secondary: local }
    return { primary: local ?? 'Time not set', secondary: rel }
  }
  if (seg === 'sending') return { primary: 'With the carrier', secondary: relative(item.updatedAt, now) }
  if (seg === 'history') {
    const at = s === 'delivered' ? (item.deliveredAt || item.sentAt) : s === 'sent' ? item.sentAt : item.updatedAt
    const verb = s === 'delivered' ? 'Delivered' : s === 'sent' ? 'Sent' : 'Closed'
    return { primary: `${verb} ${relative(at, now) ?? ''}`.trim(), secondary: localWhen(at, tz, now) }
  }
  return { primary: `${FAILED.has(s) ? 'Failed' : 'Held'} ${relative(item.updatedAt, now) ?? ''}`.trim(), secondary: localWhen(item.updatedAt, tz, now) }
}

export const phoneTail = (v: string | null | undefined): string | null => {
  const d = clean(v).replace(/\D/g, '')
  return d.length >= 4 ? `··${d.slice(-4)}` : null
}

export function formatPhone(v: string | null | undefined): string | null {
  const d = clean(v).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (d.length !== 10) return clean(v) || null
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** "Single Family", "Apartment Building · 8 units". */
export function assetLine(item: QueueItem): string | null {
  const label = clean(item.assetLabel) || clean(item.propertyType)
  if (!label) return null
  const units = Number(item.unitsCount)
  return units > 1 ? `${label} · ${units} units` : label
}

export function languageLine(item: QueueItem): string | null {
  const raw = clean(item.languageName) || (item.language === 'es' ? 'Spanish' : '')
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null
}

/** Header sentence: "34 scheduled · 105 need attention". Zero buckets are omitted. */
export function summarySentence(counts: Partial<Record<QueueSegment, number | null>> | undefined): string | null {
  if (!counts) return null
  const parts: string[] = []
  const n = (k: QueueSegment) => (typeof counts[k] === 'number' ? (counts[k] as number) : 0)
  if (n('ready')) parts.push(`${n('ready').toLocaleString()} ready`)
  if (n('scheduled')) parts.push(`${n('scheduled').toLocaleString()} scheduled`)
  if (n('sending')) parts.push(`${n('sending').toLocaleString()} sending`)
  if (n('attention')) parts.push(`${n('attention').toLocaleString()} attention`)
  return parts.length ? parts.join(' · ') : 'Nothing waiting to send'
}
