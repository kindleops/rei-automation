/**
 * DEV-ONLY Inbox load counters (Multi-Inbox §13/§30 measurement).
 *
 * The visual-QA capture reads `window.__lcInboxDebug.snapshot()` at 1/2/3/4
 * panes: open realtime channels (and total subscribes), authoritative counts
 * refreshes and pane page reads. Counting is a few integer increments; in a
 * production build `enabled` is false and nothing is attached to window.
 */
export interface InboxDebugCounters {
  realtimeChannelsOpen: number
  realtimeSubscribes: number
  countsRefreshes: number
  /** counts requests actually sent (refreshes from several Inbox instances join one) */
  countsReads: number
  paneReads: number
  paneJoined: number
  paneCacheHits: number
}

const counters: InboxDebugCounters = { realtimeChannelsOpen: 0, realtimeSubscribes: 0, countsRefreshes: 0, countsReads: 0, paneReads: 0, paneJoined: 0, paneCacheHits: 0 }
const enabled = Boolean(import.meta.env?.DEV)

export function bumpInboxCounter(key: keyof InboxDebugCounters, by = 1) {
  if (!enabled) return
  counters[key] += by
}

export function inboxDebugSnapshot(): InboxDebugCounters {
  return { ...counters }
}

export function resetInboxDebugCounters() {
  for (const key of Object.keys(counters) as Array<keyof InboxDebugCounters>) {
    if (key !== 'realtimeChannelsOpen') counters[key] = 0
  }
}

if (enabled && typeof window !== 'undefined') {
  ;(window as unknown as { __lcInboxDebug?: unknown }).__lcInboxDebug = { snapshot: inboxDebugSnapshot, reset: resetInboxDebugCounters }
}
