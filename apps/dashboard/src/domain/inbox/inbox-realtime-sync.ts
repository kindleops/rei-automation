/**
 * Inbox realtime sync — the pieces that keep a live Inbox live.
 *
 * Pure / injectable so they can be tested without a browser or a socket:
 *   - buildThreadStateListPatch: inbox_thread_state is the canonical read model
 *     for a thread's latest message and bucket. Its UPDATE must move the row
 *     (latest message, preview, bucket), not only its lifecycle labels.
 *   - createRealtimeOverlayStore: remembers recent realtime row changes so a
 *     list fetch that read the read model before it caught up cannot undo them.
 *   - createRealtimeResubscribeTrigger: re-creates channels when the page comes
 *     back (visibility / online) or the session token changes, because a socket
 *     that slept through a token expiry can stay "SUBSCRIBED" and deliver
 *     nothing.
 *   - realtimeRetryDelayMs: backoff for re-subscribing after CHANNEL_ERROR /
 *     TIMED_OUT / CLOSED.
 */
import type { RealtimeRowOverlay } from '../../modules/inbox/inbox-store'

/** Tables in the supabase_realtime publication that the Inbox binds. Binding
 * an unpublished table silently disables the other bindings on its channel. */
export const INBOX_REALTIME_PUBLISHED_TABLES = ['message_events', 'inbox_thread_state', 'send_queue'] as const

const present = (value: unknown): boolean => value !== undefined && value !== null && String(value).trim() !== ''

const normalizeDirection = (value: unknown): 'inbound' | 'outbound' | '' => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw.startsWith('in')) return 'inbound'
  if (raw.startsWith('out')) return 'outbound'
  return ''
}

/**
 * List-row fields carried by an inbox_thread_state change. Only fields the row
 * actually carries are emitted, so a partial UPDATE never blanks the list row.
 */
export function buildThreadStateListPatch(row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (present(row.latest_message_at)) {
    const at = String(row.latest_message_at)
    patch.latestMessageAt = at
    patch.latest_message_at = at
    patch.latest_activity_at = at
    patch.lastMessageIso = at
    patch.lastMessageAt = at
  }
  if (present(row.latest_message_body)) {
    const body = String(row.latest_message_body)
    patch.preview = body
    patch.latestMessageBody = body
    patch.latest_message_body = body
    patch.lastMessageBody = body
  }
  const direction = normalizeDirection(row.latest_direction)
  if (direction) {
    patch.latestDirection = direction
    patch.latestMessageDirection = direction
    patch.latest_message_direction = direction
    patch.directionUsed = direction
    if (direction === 'inbound') {
      // Inbound threads never show an outbound delivery state.
      patch.deliveryStatus = ''
      patch.latestDeliveryStatus = ''
    }
  }
  if (direction === 'outbound' && present(row.latest_delivery_status)) {
    patch.deliveryStatus = row.latest_delivery_status
    patch.latestDeliveryStatus = row.latest_delivery_status
  }
  if (present(row.inbox_bucket)) {
    const bucket = String(row.inbox_bucket)
    patch.inbox_bucket = bucket
    patch.inboxBucket = bucket
    patch.inboxCategory = bucket
    patch.inbox_category = bucket
    patch.priorityBucket = bucket
  }
  if (typeof row.is_read === 'boolean') {
    patch.isRead = row.is_read
    patch.unread = !row.is_read
    if (row.is_read) patch.unreadCount = 0
    else if (direction === 'inbound') patch.unreadCount = 1
  }
  if (present(row.last_inbound_at)) patch.lastInboundAt = row.last_inbound_at
  if (present(row.last_outbound_at)) {
    patch.lastOutboundAt = row.last_outbound_at
    patch.last_outbound_at = row.last_outbound_at
  }
  if (present(row.message_count)) patch.messageCount = Number(row.message_count)
  return patch
}

// ── Overlay store ─────────────────────────────────────────────────────────────

export const REALTIME_OVERLAY_TTL_MS = 60_000

export interface RealtimeOverlayStore {
  /** Remember a change. A canonical (inbox_thread_state) change replaces any
   * earlier event-derived one for the same thread. */
  record: (overlay: RealtimeRowOverlay & { canonical?: boolean }) => void
  list: () => RealtimeRowOverlay[]
  clear: () => void
}

export function createRealtimeOverlayStore(options: { ttlMs?: number; now?: () => number } = {}): RealtimeOverlayStore {
  const ttlMs = options.ttlMs ?? REALTIME_OVERLAY_TTL_MS
  const now = options.now ?? (() => Date.now())
  const entries = new Map<string, { overlay: RealtimeRowOverlay; at: number; canonical: boolean }>()
  const prune = () => {
    const cutoff = now() - ttlMs
    for (const [key, entry] of entries) if (entry.at < cutoff) entries.delete(key)
  }
  return {
    record: ({ canonical = false, ...overlay }) => {
      const key = overlay.threadKey
      if (!key) return
      const previous = entries.get(key)
      const merged: RealtimeRowOverlay = canonical || !previous
        ? overlay
        : {
            threadKey: key,
            patch: { ...previous.overlay.patch, ...overlay.patch },
            upsert: previous.overlay.upsert || overlay.upsert,
          }
      entries.set(key, { overlay: merged, at: now(), canonical: canonical || (previous?.canonical ?? false) })
      prune()
    },
    list: () => {
      prune()
      return [...entries.values()].map((entry) => entry.overlay)
    },
    clear: () => entries.clear(),
  }
}

// ── Re-subscribe trigger ──────────────────────────────────────────────────────

export type RealtimeResubscribeReason = 'visible' | 'online' | 'token_refreshed' | 'signed_in'

interface MinimalEventTarget {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

export interface RealtimeResubscribeTriggerInput {
  onResubscribe: (reason: RealtimeResubscribeReason) => void
  /** document-like: needs `hidden` and visibilitychange events. */
  doc?: (MinimalEventTarget & { hidden: boolean }) | null
  /** window-like: online events. */
  win?: MinimalEventTarget | null
  /** Subscribe to auth changes; returns an unsubscribe. */
  subscribeAuth?: ((listener: (event: string) => void) => () => void) | null
  /** Ignore very short hide/show flickers (alt-tab). */
  minHiddenMs?: number
  now?: () => number
}

export function createRealtimeResubscribeTrigger(input: RealtimeResubscribeTriggerInput): () => void {
  const now = input.now ?? (() => Date.now())
  const minHiddenMs = input.minHiddenMs ?? 15_000
  let hiddenAt: number | null = input.doc?.hidden ? now() : null

  const onVisibility = () => {
    if (!input.doc) return
    if (input.doc.hidden) {
      hiddenAt = now()
      return
    }
    const wasHiddenFor = hiddenAt == null ? 0 : now() - hiddenAt
    hiddenAt = null
    if (wasHiddenFor >= minHiddenMs) input.onResubscribe('visible')
  }
  const onOnline = () => input.onResubscribe('online')

  input.doc?.addEventListener('visibilitychange', onVisibility)
  input.win?.addEventListener('online', onOnline)
  const unsubscribeAuth = input.subscribeAuth?.((event) => {
    if (event === 'TOKEN_REFRESHED') input.onResubscribe('token_refreshed')
    else if (event === 'SIGNED_IN') input.onResubscribe('signed_in')
  }) ?? null

  return () => {
    input.doc?.removeEventListener('visibilitychange', onVisibility)
    input.win?.removeEventListener('online', onOnline)
    unsubscribeAuth?.()
  }
}

/** 2s, 4s, 8s, 16s, 30s cap. */
export function realtimeRetryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(30_000, 2_000 * 2 ** n)
}

/** Channel statuses after which the channel will not deliver until re-created. */
export function isDeadChannelStatus(status: string): boolean {
  return status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'
}
