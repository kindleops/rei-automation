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
  Object.assign(patch, buildThreadStateIdentityPatch(row))
  return patch
}

const toE164 = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return ''
}

/**
 * WHO THE THREAD IS WITH, from the canonical read model.
 *
 * P0 2026-10-09: an inbox_thread_state change for a thread the list had not
 * loaded (a fresh reply on a new campaign) used to create the row from the
 * list fields alone -- no phone, no prospect, no property. The composer then
 * held a phone-less thread ("Thread has no valid phone number", no send_queue
 * row) and the contact card fell back to "Unknown Contact" even though the
 * server row had thread_key, seller_phone and canonical_e164. The row carries
 * them, so the patch carries them. Only present values are emitted, and the
 * seller phone is never our own number.
 */
export function buildThreadStateIdentityPatch(row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const ourNumber = toE164(row.our_number)
  const sellerPhone = [row.canonical_e164, row.seller_phone, row.thread_key]
    .map(toE164)
    .find((phone) => phone && phone !== ourNumber) ?? ''
  if (sellerPhone) {
    patch.canonicalE164 = sellerPhone
    patch.canonical_e164 = sellerPhone
    patch.phoneNumber = sellerPhone
    patch.sellerPhone = sellerPhone
    patch.seller_phone = sellerPhone
  }
  if (ourNumber) patch.ourNumber = ourNumber
  if (present(row.property_id)) {
    patch.propertyId = String(row.property_id)
    patch.property_id = String(row.property_id)
  }
  if (present(row.prospect_id)) {
    patch.prospectId = String(row.prospect_id)
    patch.prospect_id = String(row.prospect_id)
  }
  if (present(row.master_owner_id)) {
    patch.ownerId = String(row.master_owner_id)
    patch.master_owner_id = String(row.master_owner_id)
  }
  if (present(row.seller_display_name)) {
    patch.sellerDisplayName = String(row.seller_display_name)
    patch.seller_display_name = String(row.seller_display_name)
  }
  if (present(row.market)) patch.market = String(row.market)
  return patch
}

// ── Overlay store ─────────────────────────────────────────────────────────────

export const REALTIME_OVERLAY_TTL_MS = 60_000

const OVERLAY_IDENTITY_FIELDS = [
  'canonicalE164', 'canonical_e164', 'phoneNumber', 'sellerPhone', 'seller_phone', 'ourNumber',
  'propertyId', 'property_id', 'prospectId', 'prospect_id', 'ownerId', 'master_owner_id',
  'sellerDisplayName', 'seller_display_name',
] as const

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
      // A canonical change replaces the event-derived one, but never drops who
      // the thread is with: an identity field the canonical patch lacks is kept.
      const keptIdentity: Record<string, unknown> = {}
      if (canonical && previous) {
        for (const key of OVERLAY_IDENTITY_FIELDS) {
          const value = previous.overlay.patch[key]
          if (present(value) && !present(overlay.patch[key])) keptIdentity[key] = value
        }
      }
      const merged: RealtimeRowOverlay = canonical && previous && Object.keys(keptIdentity).length > 0
        ? { ...overlay, patch: { ...keptIdentity, ...overlay.patch } }
        : canonical || !previous
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

/**
 * A FLAPPING CHANNEL MUST NOT BECOME A POLL LOOP (RC 8.3.2 hotfix, 2026-10-04).
 *
 * The rejoin loop reset its backoff on every SUBSCRIBED and ran a full catch-up
 * (list + counts) on every rejoin. During a Realtime CDC failure (prod
 * realtime_logs 07:30-07:35Z: "connection not available", replication slot not
 * alive) a channel joins and then errors straight away, so each Inbox instance
 * cycled SUBSCRIBED → catch-up → CHANNEL_ERROR → 2 s → rejoin: one list read
 * and one counts read every ~2-3 s per pane, sustained for the whole outage.
 *
 * Policy: the backoff resets only after the channel has STAYED subscribed for
 * `stableMs`; a catch-up runs at most once per `catchUpMinMs`.
 */
export interface RealtimeRejoinPolicy {
  /** delay before the next re-subscribe after a dead status */
  nextRetryDelay(now: number): number
  /** SUBSCRIBED arrived; true when a catch-up read should run now */
  onSubscribed(now: number, isRejoin: boolean): boolean
  /** a dead status arrived */
  onDead(now: number): void
  /** an explicit resubscribe (visible / online / token refresh) */
  reset(): void
}

export function createRealtimeRejoinPolicy({ stableMs = 30_000, catchUpMinMs = 30_000 } = {}): RealtimeRejoinPolicy {
  let attempt = 0
  let subscribedAt: number | null = null
  let lastCatchUpAt = Number.NEGATIVE_INFINITY
  return {
    nextRetryDelay() {
      const delay = realtimeRetryDelayMs(attempt)
      attempt += 1
      return delay
    },
    onSubscribed(now, isRejoin) {
      subscribedAt = now
      if (!isRejoin) return false
      if (now - lastCatchUpAt < catchUpMinMs) return false
      lastCatchUpAt = now
      return true
    },
    onDead(now) {
      // Only a channel that held for stableMs earns a fresh backoff.
      if (subscribedAt !== null && now - subscribedAt >= stableMs) attempt = 0
      subscribedAt = null
    },
    reset() {
      attempt = 0
    },
  }
}
