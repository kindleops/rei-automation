import { useEffect, useState } from 'react'
import type { ThreadMessage } from '../../../lib/data/inboxData'
import { humanizeIntent } from './ledger-model'

/**
 * INBOX DESKTOP 4.0 — the composer owns the automation state. One signal.
 *
 * Every phase is read from the conversation the operator is looking at;
 * nothing is timed to look alive:
 *
 *   processing  the latest seller message carries the automation's own reply
 *               marker (auto_reply_queue_id, or auto_reply_status
 *               queued|processing|sending) and the reply is not visible yet
 *   queued      the reply became visible — a real send_queue row (shown as a
 *               scheduled bubble) or the sent message. Shown briefly as
 *               "Response queued ✓" ONLY when that transition happened while the
 *               conversation was open; then the composer rests
 *   held        the latest seller message was held for a person
 *               (human_review_required / needs_human_review) and nothing has
 *               been sent since — "NEEDS YOUR REVIEW", never "replying"
 *   failed      the conversation stands on a failed send — "SEND FAILED"
 *               with the existing retry
 *
 * There is no "manual takeover" phase: the autopilot write the old pill made
 * is dropped server-side (patch-universal-lead-state never writes it), so no
 * canonical takeover state exists to show.
 */

export type ComposerPhaseKind = 'resting' | 'processing' | 'queued' | 'held' | 'failed'

export interface ComposerPhase {
  kind: ComposerPhaseKind
  /** the seller message the phase is about — identity for transitions */
  inboundId: string | null
  /** "sends 2:31 PM" (queued) · hold reason (held) · failure reason (failed) */
  detail: string | null
  /** the existing retry path only retries a failed SEND, not a guard block */
  canRetry: boolean
}

export const RESTING: ComposerPhase = { kind: 'resting', inboundId: null, detail: null, canRetry: false }

/** An automation reply still being produced is bounded: a marker older than this is history. */
export const PROCESSING_WINDOW_MS = 10 * 60_000

const PROCESSING_STATUSES = new Set(['queued', 'processing', 'sending'])
const PENDING_QUEUE = new Set(['scheduled', 'queued', 'pending', 'approved', 'ready'])
const SENDING_QUEUE = new Set(['processing', 'sending'])
/** send_queue sources that are LeadCommand answering a seller (not campaigns, not the operator) */
export const AUTOMATION_QUEUE_SOURCES = new Set(['auto_reply', 'seller_inbound_orchestrator'])

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())
const truthy = (value: unknown): boolean => value === true || str(value).toLowerCase() === 'true'
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const messageMs = (message: ThreadMessage): number => {
  const ms = Date.parse(message.createdAt || message.sentAt || message.timelineAt || '')
  return Number.isFinite(ms) ? ms : 0
}

export interface ReplyMarker {
  queueId: string | null
  status: string
  humanReview: boolean
  intent: string | null
  confidence: number | null
  reviewReason: string | null
}

/** What the automation recorded on a seller message (message_events.metadata). */
export function readReplyMarker(message: ThreadMessage | null | undefined): ReplyMarker {
  const meta = asRecord(message?.metadata)
  const payload = asRecord(meta.payload)
  const decision = asRecord(meta.automation_decision ?? payload.automation_decision)
  const confidenceRaw = meta.classification_confidence ?? payload.classification_confidence
  const confidence = confidenceRaw === null || confidenceRaw === undefined || confidenceRaw === '' ? NaN : Number(confidenceRaw)
  return {
    queueId: str(meta.auto_reply_queue_id ?? payload.auto_reply_queue_id) || null,
    status: str(meta.auto_reply_status ?? payload.auto_reply_status).toLowerCase(),
    humanReview: truthy(meta.human_review_required) || truthy(meta.needs_human_review) || truthy(payload.human_review_required),
    intent: str(meta.detected_intent ?? payload.detected_intent) || null,
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
    reviewReason: str(decision.human_review_reason) || null,
  }
}

const isFailedMessage = (message: ThreadMessage): boolean => {
  const status = `${str(message.deliveryStatus)} ${str(message.rawStatus)}`.toLowerCase()
  return Boolean(message.error && status.includes('fail'))
    || status.includes('fail')
    || status.includes('undeliv')
    || status.includes('rejected')
    || status.includes('blocked')
}

const isGuardBlock = (message: ThreadMessage): boolean => str(message.rawStatus).toLowerCase().includes('blocked')

const humanizeReason = (value: string | null | undefined): string | null => {
  const text = str(value)
  if (!text) return null
  return text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase())
}

const isQueuedBubble = (message: ThreadMessage): boolean => {
  const status = str(message.deliveryStatus).toLowerCase()
  return message.source === 'send_queue' && !message.sentAt && (status === 'queued' || status === 'scheduled' || status === 'pending')
}

const formatSendTime = (iso: string, now: number): string => {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${time}`
}

/** The composer's phase for a conversation, from its messages alone. Pure. */
/**
 * `queueStatus` answers what send_queue says about a queue row the room has
 * read (null when unknown). A reply the queue cancelled is not "replying".
 */
export function deriveComposerPhase(
  messages: readonly ThreadMessage[],
  now = Date.now(),
  queueStatus: (queueId: string) => string | null = () => null,
): ComposerPhase {
  if (!messages.length) return RESTING
  const timeline = [...messages].sort((a, b) => messageMs(a) - messageMs(b))
  let inboundIndex = -1
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i].direction === 'inbound') { inboundIndex = i; break }
  }
  const last = timeline[timeline.length - 1]

  if (inboundIndex < 0) {
    return last.direction === 'outbound' && isFailedMessage(last)
      ? { kind: 'failed', inboundId: null, detail: humanizeReason(last.error), canRetry: !isGuardBlock(last) }
      : RESTING
  }

  const inbound = timeline[inboundIndex]
  const replies = timeline.slice(inboundIndex + 1).filter((message) => message.direction === 'outbound')
  const marker = readReplyMarker(inbound)
  const automationReply = replies.find((message) => (
    (marker.queueId && (message.developerMeta?.queue_id === marker.queueId || message.id === marker.queueId))
    || message.developerMeta?.origin === 'automation_queue'
  )) ?? null
  const hasMarker = Boolean(marker.queueId) || PROCESSING_STATUSES.has(marker.status)

  if (hasMarker || automationReply) {
    const reply = automationReply ?? replies[0] ?? null
    if (reply) {
      if (isFailedMessage(reply)) {
        return { kind: 'failed', inboundId: inbound.id, detail: humanizeReason(reply.error) ?? (isGuardBlock(reply) ? 'Blocked before sending' : null), canRetry: !isGuardBlock(reply) }
      }
      const sendsAt = isQueuedBubble(reply) ? formatSendTime(reply.createdAt, now) : ''
      return { kind: 'queued', inboundId: inbound.id, detail: sendsAt ? `sends ${sendsAt}` : null, canRetry: false }
    }
    const known = marker.queueId ? (queueStatus(marker.queueId) ?? '').toLowerCase() : ''
    if (known && !PENDING_QUEUE.has(known) && !SENDING_QUEUE.has(known)) return RESTING
    return now - messageMs(inbound) <= PROCESSING_WINDOW_MS
      ? { kind: 'processing', inboundId: inbound.id, detail: null, canRetry: false }
      : RESTING
  }

  if (marker.humanReview && replies.length === 0) {
    const intent = humanizeIntent(marker.intent) ?? 'Intent unclear'
    const confidence = marker.confidence !== null ? ` · ${Math.round(marker.confidence * 100)}% confidence` : ''
    const reason = humanizeReason(marker.reviewReason)
    return { kind: 'held', inboundId: inbound.id, detail: reason ? `${reason} — ${intent}${confidence}` : `${intent}${confidence}`, canRetry: false }
  }

  if (last.direction === 'outbound' && isFailedMessage(last)) {
    return { kind: 'failed', inboundId: inbound.id, detail: humanizeReason(last.error), canRetry: !isGuardBlock(last) }
  }
  return RESTING
}

/** How long the success state holds before the composer rests. */
export const QUEUED_FLASH_MS = 2600

/**
 * The phase to SHOW. Everything but `queued` shows as derived; `queued` is a
 * transition, shown only when the reply became visible for the same seller
 * message while this conversation was open — never on opening a conversation
 * whose reply was queued earlier.
 */
export interface SeenPhase { threadId: string | null; kind: ComposerPhaseKind; inboundId: string | null }

/**
 * Did the reply just become visible, live, for the same seller message in
 * the same conversation? Pure — the hook below and the tests share it.
 */
export function isLiveQueuedTransition(seen: SeenPhase, base: ComposerPhase, threadId: string | null): boolean {
  return seen.threadId === threadId
    && base.kind === 'queued'
    && seen.kind !== 'queued'
    && seen.inboundId !== null
    && seen.inboundId === base.inboundId
}

/** What to show: `queued` only while its success flash is live; otherwise rest. */
export function visibleComposerPhase(base: ComposerPhase, flashInboundId: string | null): ComposerPhase {
  if (base.kind !== 'queued') return base
  return flashInboundId !== null && flashInboundId === base.inboundId ? base : RESTING
}

export function useComposerPhase(base: ComposerPhase, threadId: string | null): ComposerPhase {
  const [seen, setSeen] = useState<SeenPhase>({ threadId, kind: base.kind, inboundId: base.inboundId })
  const [flash, setFlash] = useState<{ inboundId: string | null } | null>(null)

  if (seen.threadId !== threadId || seen.kind !== base.kind || seen.inboundId !== base.inboundId) {
    const live = isLiveQueuedTransition(seen, base, threadId)
    setSeen({ threadId, kind: base.kind, inboundId: base.inboundId })
    setFlash(live ? { inboundId: base.inboundId } : null)
  }

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), QUEUED_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [flash])

  return visibleComposerPhase(base, flash?.inboundId ?? null)
}

/* ── the automation's queued reply, made visible ────────────────────────── */

export interface QueueRowLike {
  id?: unknown
  queue_status?: unknown
  source?: unknown
  message_body?: unknown
  message_text?: unknown
  rendered_message?: unknown
  scheduled_for_utc?: unknown
  scheduled_for?: unknown
  created_at?: unknown
  sent_at?: unknown
  delivered_at?: unknown
  failed_reason?: unknown
  blocked_reason?: unknown
  paused_reason?: unknown
  to_phone_number?: unknown
  from_phone_number?: unknown
  thread_key?: unknown
  property_id?: unknown
  master_owner_id?: unknown
  prospect_id?: unknown
}

export const QUEUE_COLUMNS = 'id,queue_status,source,message_body,message_text,scheduled_for_utc,scheduled_for,created_at,sent_at,delivered_at,failed_reason,blocked_reason,paused_reason,to_phone_number,from_phone_number,thread_key,property_id,master_owner_id,prospect_id'

const SENT_QUEUE = new Set(['sent', 'delivered'])

/**
 * A send_queue row as a scheduled outbound bubble — or null when the row is
 * already represented by a sent message, was cancelled, or is not the
 * automation answering this seller. Read-only: no Edit/Cancel is offered on it
 * (origin `automation_queue`).
 */
export function queueRowToBubble(row: QueueRowLike): ThreadMessage | null {
  const id = str(row.id)
  const status = str(row.queue_status).toLowerCase()
  if (!id || !AUTOMATION_QUEUE_SOURCES.has(str(row.source).toLowerCase())) return null
  const blocked = status.includes('blocked') || status.startsWith('paused')
  const failed = status === 'failed' || blocked
  const sent = SENT_QUEUE.has(status)
  if (!PENDING_QUEUE.has(status) && !SENDING_QUEUE.has(status) && !failed && !sent) return null
  const body = str(row.message_body) || str(row.message_text) || str(row.rendered_message)
  if (!body) return null
  const when = str(row.scheduled_for_utc) || str(row.scheduled_for) || str(row.created_at) || new Date().toISOString()
  return {
    id: `sq:${id}`,
    threadKey: str(row.thread_key),
    direction: 'outbound',
    body,
    createdAt: when,
    timelineAt: when,
    sentAt: sent ? (str(row.sent_at) || when) : null,
    deliveredAt: status === 'delivered' ? (str(row.delivered_at) || null) : null,
    deliveryStatus: failed ? 'failed' : sent ? status : SENDING_QUEUE.has(status) ? 'sending' : 'queued',
    fromNumber: str(row.from_phone_number),
    toNumber: str(row.to_phone_number),
    ownerId: str(row.master_owner_id),
    prospectId: str(row.prospect_id),
    propertyId: str(row.property_id),
    phoneNumber: str(row.to_phone_number),
    canonicalE164: str(row.to_phone_number),
    templateId: null,
    templateName: null,
    agentId: null,
    source: 'send_queue',
    rawStatus: status,
    error: failed ? (humanizeReason(str(row.failed_reason) || str(row.blocked_reason) || str(row.paused_reason)) ?? (blocked ? 'Blocked before sending' : 'Send failed')) : null,
    metadata: {},
    developerMeta: { queue_id: id, origin: 'automation_queue' },
  }
}

/** Queue bubbles not already represented by a sent message in the timeline. */
export function mergeQueueBubbles(messages: readonly ThreadMessage[], bubbles: readonly ThreadMessage[]): ThreadMessage[] {
  if (!bubbles.length) return messages as ThreadMessage[]
  const represented = new Set(messages.map((message) => message.developerMeta?.queue_id).filter(Boolean) as string[])
  const fresh = bubbles.filter((bubble) => !represented.has(String(bubble.developerMeta?.queue_id ?? '')))
  return fresh.length ? [...messages, ...fresh] : (messages as ThreadMessage[])
}
