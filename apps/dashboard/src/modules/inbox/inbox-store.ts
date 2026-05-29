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
  realtimeStatus: 'connected' | 'disconnected' | 'error'
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
  | { type: 'REALTIME_PATCH_THREAD'; threadKey: string; patch: Record<string, unknown> }
  | { type: 'SET_BUCKET_SCROLL'; bucketKey: string; scrollTop: number }
  | { type: 'SET_VIEW_COUNTS'; counts: Record<string, number> }
  | { type: 'SET_REALTIME_STATUS'; status: 'connected' | 'disconnected' | 'error' }

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

// ── Initial state ─────────────────────────────────────────────────────────────

export const EMPTY_INBOX_STORE_STATE: InboxStoreState = {
  activeBucketKey: 'all_messages',
  buckets: {},
  messagesByThreadKey: {},
  selectedThreadKey: null,
  realtimeStatus: 'disconnected',
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
      // Update exactly one row in exactly the bucket(s) it lives in.
      // Never insert new rows or move threads between buckets.
      const { threadKey, patch } = action
      let changed = false
      const newBuckets: Record<string, BucketSlice> = {}
      for (const [key, bucket] of Object.entries(state.buckets)) {
        const idx = bucket.rows.findIndex((r) => {
          const row = r as Record<string, unknown>
          return row.threadKey === threadKey || row.id === threadKey
        })
        if (idx !== -1) {
          const newRows = [...bucket.rows]
          newRows[idx] = { ...(newRows[idx] as Record<string, unknown>), ...patch }
          newBuckets[key] = { ...bucket, rows: newRows }
          changed = true
        } else {
          newBuckets[key] = bucket
        }
      }
      if (!changed) return state
      return { ...state, buckets: newBuckets }
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
      return { ...state, viewCounts: action.counts }
    }

    case 'SET_REALTIME_STATUS': {
      return { ...state, realtimeStatus: action.status }
    }

    default:
      return state
  }
}
