// Pure reducer — zero runtime imports. Importable by Node.js test scripts via `npx tsx`.

// ── State types ─────────────────────────────────────────────────────────────

export interface BucketSlice {
  rows: unknown[]
  loading: boolean
  error: string | null
  lastRequestId: string | null
  lastLoadedAt: string | null
  scrollTop: number
  cursor: string | null
  hasMore: boolean
}

export interface MessagesSlice {
  messages: unknown[]
  loading: boolean
  error: string | null
  lastRequestId: string | null
  lastLoadedAt: string | null
}

export interface InboxStoreState {
  activeBucketKey: string
  buckets: Record<string, BucketSlice>
  messagesByThreadKey: Record<string, MessagesSlice>
  selectedThreadKey: string | null
  realtimeStatus: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled'
  viewCounts: Record<string, number>
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type InboxStoreAction =
  | { type: 'SWITCH_BUCKET'; bucketKey: string }
  | { type: 'BUCKET_FETCH_START'; bucketKey: string; requestId: string }
  | { type: 'BUCKET_FETCH_DONE'; bucketKey: string; requestId: string; rows: unknown[]; cursor: string | null; hasMore: boolean }
  | { type: 'BUCKET_FETCH_ERROR'; bucketKey: string; requestId: string; error: string }
  | { type: 'BUCKET_APPEND_ROWS'; bucketKey: string; requestId: string; rows: unknown[]; cursor: string | null; hasMore: boolean }
  | { type: 'SELECT_THREAD'; threadKey: string | null }
  | { type: 'MESSAGES_FETCH_START'; threadKey: string; requestId: string }
  | { type: 'MESSAGES_FETCH_DONE'; threadKey: string; requestId: string; messages: unknown[] }
  | { type: 'MESSAGES_FETCH_ERROR'; threadKey: string; requestId: string; error: string }
  | { type: 'REALTIME_PATCH_THREAD'; threadKey: string; patch: Record<string, unknown>; targetBucketKey?: string | null; upsert?: boolean; countDeltas?: Record<string, number>; diagnostics?: Record<string, unknown> }
  | { type: 'SET_BUCKET_SCROLL'; bucketKey: string; scrollTop: number }
  | { type: 'SET_VIEW_COUNTS'; counts: Record<string, number>; preserveExisting?: boolean; reason?: string }
  | { type: 'SET_REALTIME_STATUS'; status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled' }

// ── Helpers ──────────────────────────────────────────────────────────────────

export const emptyBucket = (): BucketSlice => ({
  rows: [],
  loading: false,
  error: null,
  lastRequestId: null,
  lastLoadedAt: null,
  scrollTop: 0,
  cursor: null,
  hasMore: false,
})

export const emptyMessages = (): MessagesSlice => ({
  messages: [],
  loading: false,
  error: null,
  lastRequestId: null,
  lastLoadedAt: null,
})

const getBucket = (state: InboxStoreState, key: string): BucketSlice =>
  state.buckets[key] ?? emptyBucket()

const getMessages = (state: InboxStoreState, key: string): MessagesSlice =>
  state.messagesByThreadKey[key] ?? emptyMessages()

const BUCKET_ALIASES: Record<string, string> = {
  all: 'all_messages',
  all_conversations: 'all_messages',
  hot_leads: 'priority',
  positive_hot: 'priority',
  new_inbound: 'new_replies',
  needs_reply: 'new_replies',
  manual_review: 'needs_review',
  outbound_active: 'follow_up',
  follow_up_due: 'follow_up',
  cold_no_response: 'cold',
  dnc_opt_out: 'suppressed',
  opt_out: 'suppressed',
  wrong_number: 'dead',
  waiting_on_seller: 'waiting',
  waiting: 'waiting',
}

const ACTIVE_BUCKETS = new Set(['priority', 'new_replies', 'needs_review', 'follow_up'])

const normalizeBucketKey = (value: unknown): string => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  return BUCKET_ALIASES[raw] ?? raw
}

const getRowValue = (row: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return undefined
}

const threadIdentityCandidates = (value: unknown): string[] => {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  if (raw.toLowerCase().startsWith('ct:')) return [raw]

  const candidates = new Set<string>([raw])
  const withoutPhonePrefix = raw.toLowerCase().startsWith('phone:') ? raw.slice(6).trim() : ''
  if (withoutPhonePrefix) candidates.add(withoutPhonePrefix)

  for (const candidate of [...candidates]) {
    if (candidate.includes('|')) continue
    const digits = candidate.replace(/\D/g, '')
    if (digits.length === 10) candidates.add(`+1${digits}`)
    else if (digits.length === 11 && digits.startsWith('1')) candidates.add(`+${digits}`)
    else if (candidate.startsWith('+') && digits.length >= 10) candidates.add(`+${digits}`)
  }

  return [...candidates].filter(Boolean)
}

const rowIdentityValues = (row: Record<string, unknown>): string[] => {
  return Array.from(new Set([
    getRowValue(row, 'conversationThreadId', 'conversation_thread_id'),
    getRowValue(row, 'threadKey', 'thread_key'),
    getRowValue(row, 'id'),
    getRowValue(row, 'canonicalE164', 'canonical_e164'),
    getRowValue(row, 'phoneNumber', 'phone_number', 'phone'),
    getRowValue(row, 'sellerPhone', 'seller_phone'),
    getRowValue(row, 'bestPhone', 'best_phone'),
    getRowValue(row, 'displayPhone', 'display_phone'),
  ].flatMap(threadIdentityCandidates)))
}

const rowMatchesThread = (row: Record<string, unknown>, threadKey: string): boolean => {
  const needles = threadIdentityCandidates(threadKey)
  if (needles.length === 0) return false
  const identities = new Set(rowIdentityValues(row))
  return needles.some((needle) => identities.has(needle))
}

const getRowAutomationLane = (row: Record<string, unknown>): string =>
  String(getRowValue(row, 'automation_lane', 'automationLane') ?? '').trim().toLowerCase()

const WAITING_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

const rowTimestampMs = (value: unknown): number => {
  const ms = new Date(String(value ?? '')).getTime()
  return Number.isFinite(ms) ? ms : 0
}

const rowIsOutboundLastWithoutReply = (row: Record<string, unknown>): boolean => {
  const outboundMs = rowTimestampMs(getRowValue(row, 'last_outbound_at', 'lastOutboundAt', 'latest_message_at', 'latestMessageAt'))
  if (!outboundMs) return false
  const inboundMs = rowTimestampMs(getRowValue(row, 'last_inbound_at', 'lastInboundAt'))
  return !inboundMs || inboundMs < outboundMs
}

const getRowBucketKey = (row: Record<string, unknown>): string => {
  const bucket = normalizeBucketKey(
    getRowValue(row, 'inbox_bucket', 'inboxBucket', 'inbox_category', 'inboxCategory', 'priorityBucket', 'priority_bucket', 'bucket'),
  )
  if (bucket) return bucket
  if (getRowAutomationLane(row) === 'cold_reactivation') return 'cold'
  return ''
}

const rowBelongsToBucket = (row: Record<string, unknown>, bucketKey: string): boolean => {
  const key = normalizeBucketKey(bucketKey)
  const rowBucket = getRowBucketKey(row)
  if (key === 'all_messages') return true
  if (key === 'active') return ACTIVE_BUCKETS.has(rowBucket)
  if (key === 'waiting') {
    if (['dead', 'suppressed'].includes(rowBucket)) return false
    if (!rowIsOutboundLastWithoutReply(row)) return false
    const outboundMs = rowTimestampMs(getRowValue(row, 'last_outbound_at', 'lastOutboundAt', 'latest_message_at', 'latestMessageAt'))
    return outboundMs > 0 && (Date.now() - outboundMs) <= WAITING_REPLY_WINDOW_MS
  }
  if (key === 'cold') {
    if (['dead', 'suppressed'].includes(rowBucket)) return false
    if (rowBucket === 'cold' || getRowAutomationLane(row) === 'cold_reactivation') return true
    if (!rowIsOutboundLastWithoutReply(row)) return false
    const outboundMs = rowTimestampMs(getRowValue(row, 'last_outbound_at', 'lastOutboundAt', 'latest_message_at', 'latestMessageAt'))
    return outboundMs > 0 && (Date.now() - outboundMs) > WAITING_REPLY_WINDOW_MS
  }
  if (key === 'new_replies') {
    if (['dead', 'suppressed'].includes(rowBucket)) return false
    const direction = String(getRowValue(row, 'latest_message_direction', 'latestDirection', 'direction') ?? '').trim().toLowerCase()
    const normalizedDirection = direction === 'in' || direction === 'incoming' ? 'inbound'
      : direction === 'out' || direction === 'outgoing' ? 'outbound'
        : direction
    if (normalizedDirection !== 'inbound') return false
    if (Number(getRowValue(row, 'pending_queue_count', 'pendingQueueCount') ?? 0) > 0) return false
    const lastOut = getRowValue(row, 'last_outbound_at', 'lastOutboundAt')
    const lastIn = getRowValue(row, 'last_inbound_at', 'lastInboundAt', 'latest_message_at', 'latestMessageAt')
    const inMs = rowTimestampMs(lastIn)
    const outMs = rowTimestampMs(lastOut)
    if (!inMs) return false
    if (outMs > 0 && inMs < outMs) return false
    const isRead = getRowValue(row, 'is_read', 'isRead') === true
    const isActioned = getRowValue(row, 'is_actioned', 'isActioned') === true
    const isTerminal = getRowValue(row, 'opt_out', 'optOut') === true
      || getRowValue(row, 'wrong_number', 'wrongNumber') === true
      || getRowValue(row, 'not_interested', 'notInterested') === true
      || getRowValue(row, 'is_suppressed', 'isSuppressed') === true
    if (isRead || isActioned || isTerminal) return false
    return rowBucket === 'new_replies' || normalizedDirection === 'inbound'
  }
  return rowBucket === key
}

const rowTimestamp = (row: Record<string, unknown>): number => {
  const value = getRowValue(row, 'lastMessageIso', 'latestMessageAt', 'latest_message_at', 'latest_activity_at', 'lastMessageAt', 'updatedAt')
  const ts = new Date(String(value ?? '')).getTime()
  return Number.isFinite(ts) ? ts : 0
}

const sortRowsNewestFirst = (rows: unknown[]): unknown[] =>
  [...rows].sort((left, right) => {
    const leftRow = left as Record<string, unknown>
    const rightRow = right as Record<string, unknown>
    return rowTimestamp(rightRow) - rowTimestamp(leftRow)
  })

const withThreadIdentity = (threadKey: string, row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  conversationThreadId: getRowValue(row, 'conversationThreadId', 'conversation_thread_id') ?? threadKey,
  conversation_thread_id: getRowValue(row, 'conversation_thread_id', 'conversationThreadId') ?? threadKey,
  threadKey: getRowValue(row, 'threadKey', 'thread_key') ?? threadKey,
  id: getRowValue(row, 'id', 'threadKey', 'thread_key') ?? threadKey,
})

const applyCountDeltas = (current: Record<string, number>, deltas: Record<string, number> = {}): Record<string, number> => {
  const next = { ...current }
  for (const [key, delta] of Object.entries(deltas)) {
    const numericDelta = Number(delta)
    if (!Number.isFinite(numericDelta) || numericDelta === 0) continue
    const currentValue = Number(next[key] ?? 0)
    next[key] = Math.max(0, currentValue + numericDelta)
  }
  return next
}

// ── Initial state ─────────────────────────────────────────────────────────────

export const EMPTY_INBOX_STORE_STATE: InboxStoreState = {
  activeBucketKey: 'all_messages',
  buckets: {},
  messagesByThreadKey: {},
  selectedThreadKey: null,
  realtimeStatus: 'connecting',
  viewCounts: {},
}

// ── Reducer ───────────────────────────────────────────────────────────────────
// Pure function — no side effects, deterministic, safe to unit-test without React.

export function inboxReducer(state: InboxStoreState, action: InboxStoreAction): InboxStoreState {
  switch (action.type) {

    case 'SWITCH_BUCKET': {
      if (action.bucketKey === state.activeBucketKey) return state
      return { ...state, activeBucketKey: action.bucketKey }
    }

    case 'BUCKET_FETCH_START': {
      const bucket = getBucket(state, action.bucketKey)
      return {
        ...state,
        buckets: {
          ...state.buckets,
          [action.bucketKey]: { ...bucket, loading: true, error: null, lastRequestId: action.requestId },
        },
      }
    }

    case 'BUCKET_FETCH_DONE': {
      const bucket = getBucket(state, action.bucketKey)
      // Stale guard: only the latest requestId for this bucket may commit rows.
      if (bucket.lastRequestId !== action.requestId) return state
      return {
        ...state,
        buckets: {
          ...state.buckets,
          [action.bucketKey]: {
            ...bucket,
            rows: action.rows,
            loading: false,
            error: null,
            cursor: action.cursor,
            hasMore: action.hasMore,
            lastLoadedAt: new Date().toISOString(),
          },
        },
      }
    }

    case 'BUCKET_FETCH_ERROR': {
      const bucket = getBucket(state, action.bucketKey)
      if (bucket.lastRequestId !== action.requestId) return state
      return {
        ...state,
        buckets: {
          ...state.buckets,
          // Rows are NOT cleared on error — keep showing last-good rows with error banner.
          [action.bucketKey]: { ...bucket, loading: false, error: action.error },
        },
      }
    }

    case 'BUCKET_APPEND_ROWS': {
      const bucket = getBucket(state, action.bucketKey)
      if (bucket.lastRequestId !== action.requestId) return state
      // Deduplicate by (threadKey || id) so Load More never creates duplicate rows.
      const existingKeys = new Set(
        bucket.rows.map((r) => {
          const row = r as Record<string, unknown>
          return (row.threadKey as string) || (row.id as string) || ''
        }),
      )
      const fresh = action.rows.filter((r) => {
        const row = r as Record<string, unknown>
        const key = (row.threadKey as string) || (row.id as string) || ''
        return key ? !existingKeys.has(key) : true
      })
      return {
        ...state,
        buckets: {
          ...state.buckets,
          [action.bucketKey]: {
            ...bucket,
            rows: [...bucket.rows, ...fresh],
            loading: false,
            cursor: action.cursor,
            hasMore: action.hasMore,
            lastLoadedAt: new Date().toISOString(),
          },
        },
      }
    }

    case 'SELECT_THREAD': {
      return { ...state, selectedThreadKey: action.threadKey }
    }

    case 'MESSAGES_FETCH_START': {
      const msgs = getMessages(state, action.threadKey)
      return {
        ...state,
        messagesByThreadKey: {
          ...state.messagesByThreadKey,
          [action.threadKey]: { ...msgs, loading: true, error: null, lastRequestId: action.requestId },
        },
      }
    }

    case 'MESSAGES_FETCH_DONE': {
      const msgs = getMessages(state, action.threadKey)
      // Stale guard: only commit if requestId still matches (newer open replaces it).
      if (msgs.lastRequestId !== action.requestId) return state
      return {
        ...state,
        messagesByThreadKey: {
          ...state.messagesByThreadKey,
          [action.threadKey]: {
            ...msgs,
            messages: action.messages,
            loading: false,
            error: null,
            lastLoadedAt: new Date().toISOString(),
          },
        },
      }
    }

    case 'MESSAGES_FETCH_ERROR': {
      const msgs = getMessages(state, action.threadKey)
      if (msgs.lastRequestId !== action.requestId) return state
      return {
        ...state,
        messagesByThreadKey: {
          ...state.messagesByThreadKey,
          [action.threadKey]: { ...msgs, loading: false, error: action.error },
        },
      }
    }

    case 'REALTIME_PATCH_THREAD': {
      const { threadKey, patch } = action
      let changed = false
      const newBuckets: Record<string, BucketSlice> = {}
      let existingRow: Record<string, unknown> | null = null
      let previousBucketKey = ''
      const existingBucketKeys = new Set<string>()

      for (const [key, bucket] of Object.entries(state.buckets)) {
        const match = bucket.rows.find((r) => rowMatchesThread(r as Record<string, unknown>, threadKey)) as Record<string, unknown> | undefined
        if (match) existingBucketKeys.add(key)
        if (match && !existingRow) {
          existingRow = match
          previousBucketKey = normalizeBucketKey(key) || getRowBucketKey(match)
        }
      }

      if (!existingRow && action.upsert !== true) {
        const viewCounts = action.countDeltas ? applyCountDeltas(state.viewCounts, action.countDeltas) : state.viewCounts
        return viewCounts === state.viewCounts ? state : { ...state, viewCounts }
      }

      const patchedRow = withThreadIdentity(threadKey, {
        ...(existingRow ?? {}),
        ...patch,
      })
      const explicitPatchBucketKey = getRowBucketKey(patch)
      const targetBucketKey = normalizeBucketKey(action.targetBucketKey) || explicitPatchBucketKey || getRowBucketKey(patchedRow) || previousBucketKey
      const shouldMoveBuckets = Boolean(normalizeBucketKey(action.targetBucketKey) || explicitPatchBucketKey || action.upsert === true)
      if (targetBucketKey && !getRowBucketKey(patchedRow)) {
        patchedRow.inbox_bucket = targetBucketKey
        patchedRow.inboxBucket = targetBucketKey
        patchedRow.inboxCategory = targetBucketKey
      }

      const bucketEntries = Object.entries(state.buckets)
      for (const [key, bucket] of bucketEntries) {
        const withoutThread = bucket.rows.filter((r) => !rowMatchesThread(r as Record<string, unknown>, threadKey))
        const shouldInclude = shouldMoveBuckets
          ? rowBelongsToBucket(patchedRow, key)
          : existingBucketKeys.has(key) || rowBelongsToBucket(patchedRow, key)
        const nextRows = shouldInclude
          ? sortRowsNewestFirst([patchedRow, ...withoutThread])
          : withoutThread
        newBuckets[key] = nextRows === bucket.rows ? bucket : { ...bucket, rows: nextRows }
        if (nextRows.length !== bucket.rows.length || nextRows[0] !== bucket.rows[0]) changed = true
      }

      if (action.upsert === true && targetBucketKey && !newBuckets[targetBucketKey]) {
        newBuckets[targetBucketKey] = {
          ...emptyBucket(),
          rows: [patchedRow],
          lastLoadedAt: new Date().toISOString(),
        }
        changed = true
      }

      const viewCounts = action.countDeltas ? applyCountDeltas(state.viewCounts, action.countDeltas) : state.viewCounts
      if (!changed && viewCounts === state.viewCounts) return state
      return { ...state, buckets: changed ? newBuckets : state.buckets, viewCounts }
    }

    case 'SET_BUCKET_SCROLL': {
      const bucket = getBucket(state, action.bucketKey)
      return {
        ...state,
        buckets: {
          ...state.buckets,
          [action.bucketKey]: { ...bucket, scrollTop: action.scrollTop },
        },
      }
    }

    case 'SET_VIEW_COUNTS': {
      // Counts are fully isolated from bucket rows — a counts fetch failure
      // only affects this field, never touches buckets or messagesByThreadKey.
      if (!action.preserveExisting) return { ...state, viewCounts: action.counts }
      const next = { ...state.viewCounts }
      for (const [key, value] of Object.entries(action.counts)) {
        if (!Number.isFinite(value) || value < 0) continue
        if (value === 0 && Number.isFinite(next[key])) continue
        if (Number.isFinite(next[key]) && next[key] > 0) continue
        next[key] = value
      }
      return { ...state, viewCounts: next }
    }

    case 'SET_REALTIME_STATUS': {
      return { ...state, realtimeStatus: action.status }
    }

    default:
      return state
  }
}
