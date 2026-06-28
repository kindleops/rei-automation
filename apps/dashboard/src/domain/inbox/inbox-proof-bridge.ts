export interface InboxProofOptimisticPatch {
  action: string
  threadId: string
  at: string
  patch: Record<string, unknown>
}

export interface InboxProofTelemetry {
  activeBucketKey: string
  lastBucketSwitchMs: number | null
  lastBucketFrom: string | null
  lastBucketTo: string | null
  apiBootResponseMs: number | null
  firstRowsPaintMs: number | null
  lastThreadSelectMs: number | null
  lastThreadSelectCacheHit: boolean | null
  lastThreadSelectCacheApplyMs: number | null
  lastOptimisticPatch: InboxProofOptimisticPatch | null
  fetchInFlight: number
  parallelFetchStarted: number | null
  scrollOffset: number | null
  driveAction: ((action: string, threadId?: string) => void) | null
}

const EMPTY: InboxProofTelemetry = {
  activeBucketKey: 'all_messages',
  lastBucketSwitchMs: null,
  lastBucketFrom: null,
  lastBucketTo: null,
  apiBootResponseMs: null,
  firstRowsPaintMs: null,
  lastThreadSelectMs: null,
  lastThreadSelectCacheHit: null,
  lastThreadSelectCacheApplyMs: null,
  lastOptimisticPatch: null,
  fetchInFlight: 0,
  parallelFetchStarted: null,
  scrollOffset: null,
  driveAction: null,
}

let snapshot: InboxProofTelemetry = { ...EMPTY }
let apiBootStartedAt: number | null = null

function syncWindow() {
  if (typeof window === 'undefined') return
  ;(window as Window & { __INBOX_PROOF__?: InboxProofTelemetry }).__INBOX_PROOF__ = snapshot
}

export function getInboxProof(): InboxProofTelemetry {
  return snapshot
}

export function publishInboxProof(patch: Partial<InboxProofTelemetry>): void {
  snapshot = { ...snapshot, ...patch }
  syncWindow()
}

export function registerInboxProofDriveAction(
  driveAction: (action: string, threadId?: string) => void,
): void {
  publishInboxProof({ driveAction })
}

export function markApiBootRequestStart(): void {
  apiBootStartedAt = performance.now()
}

export function markApiBootResponse(): void {
  if (apiBootStartedAt == null) return
  publishInboxProof({ apiBootResponseMs: Math.round(performance.now() - apiBootStartedAt) })
}

export function markFirstRowsPainted(): void {
  if (snapshot.firstRowsPaintMs != null) return
  const base = snapshot.apiBootResponseMs != null && apiBootStartedAt != null
    ? apiBootStartedAt + snapshot.apiBootResponseMs
    : performance.now()
  publishInboxProof({ firstRowsPaintMs: Math.max(0, Math.round(performance.now() - base)) })
}

export function markBucketSwitch(fromKey: string, toKey: string, ms: number): void {
  publishInboxProof({
    activeBucketKey: toKey,
    lastBucketFrom: fromKey,
    lastBucketTo: toKey,
    lastBucketSwitchMs: Math.round(ms),
  })
}

export function markThreadSelectTelemetry(input: {
  cacheHit: boolean
  cacheApplyMs: number
  selectMs: number
  parallelFetchStarted: number
}): void {
  publishInboxProof({
    lastThreadSelectCacheHit: input.cacheHit,
    lastThreadSelectCacheApplyMs: input.cacheApplyMs,
    lastThreadSelectMs: Math.round(input.selectMs),
    parallelFetchStarted: input.parallelFetchStarted,
  })
}

export function markOptimisticPatch(action: string, threadId: string, patch: Record<string, unknown>): void {
  publishInboxProof({
    lastOptimisticPatch: {
      action,
      threadId,
      at: new Date().toISOString(),
      patch,
    },
  })
}

export function adjustFetchInFlight(delta: number): void {
  publishInboxProof({ fetchInFlight: Math.max(0, snapshot.fetchInFlight + delta) })
}

export function markListScrollOffset(offset: number): void {
  publishInboxProof({ scrollOffset: Math.round(offset) })
}

export function resetInboxProofForTests(): void {
  snapshot = { ...EMPTY }
  apiBootStartedAt = null
  syncWindow()
}