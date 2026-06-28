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
  shellToRowsMs: number | null
  firstRowVisibleMs: number | null
  navigationStartedAt: number | null
  maxParallelFetchStarted: number
  degradedPollTicks: number
  selectedPollTicks: number
  duplicateLiveRequestBlocked: number
  lastThreadSelectMs: number | null
  lastThreadSelectCacheHit: boolean | null
  lastThreadSelectCacheApplyMs: number | null
  lastOptimisticPatch: InboxProofOptimisticPatch | null
  optimisticPatches: InboxProofOptimisticPatch[]
  fetchInFlight: number
  maxFetchInFlight: number
  inboxLiveRequestCount: number
  parallelFetchStarted: number | null
  dossierParallelStarted: boolean
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
  shellToRowsMs: null,
  firstRowVisibleMs: null,
  navigationStartedAt: null,
  maxParallelFetchStarted: 0,
  degradedPollTicks: 0,
  selectedPollTicks: 0,
  duplicateLiveRequestBlocked: 0,
  lastThreadSelectMs: null,
  lastThreadSelectCacheHit: null,
  lastThreadSelectCacheApplyMs: null,
  lastOptimisticPatch: null,
  optimisticPatches: [],
  fetchInFlight: 0,
  maxFetchInFlight: 0,
  inboxLiveRequestCount: 0,
  parallelFetchStarted: null,
  dossierParallelStarted: false,
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

export function markInboxNavigationStart(): void {
  if (snapshot.navigationStartedAt != null) return
  const started = performance.now()
  publishInboxProof({ navigationStartedAt: Math.round(started) })
}

export function markApiBootRequestStart(): void {
  apiBootStartedAt = performance.now()
  markInboxNavigationStart()
}

export function markApiBootResponse(): void {
  if (apiBootStartedAt == null) return
  const apiBootResponseMs = Math.round(performance.now() - apiBootStartedAt)
  publishInboxProof({
    apiBootResponseMs,
    shellToRowsMs: snapshot.firstRowsPaintMs != null
      ? apiBootResponseMs + snapshot.firstRowsPaintMs
      : null,
  })
}

export function markFirstRowsPainted(): void {
  if (snapshot.firstRowsPaintMs != null) return
  const base = snapshot.apiBootResponseMs != null && apiBootStartedAt != null
    ? apiBootStartedAt + snapshot.apiBootResponseMs
    : performance.now()
  const firstRowsPaintMs = Math.max(0, Math.round(performance.now() - base))
  const shellToRowsMs = snapshot.apiBootResponseMs != null
    ? snapshot.apiBootResponseMs + firstRowsPaintMs
    : firstRowsPaintMs
  const navBase = snapshot.navigationStartedAt
  const firstRowVisibleMs = navBase != null
    ? Math.max(0, Math.round(performance.now() - navBase))
    : shellToRowsMs
  publishInboxProof({
    firstRowsPaintMs,
    shellToRowsMs,
    firstRowVisibleMs,
  })
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
  parallelFetchStarted?: number
}): void {
  const incomingParallel = input.parallelFetchStarted ?? 0
  const parallelStarted = incomingParallel > 0
    ? incomingParallel
    : snapshot.parallelFetchStarted
  const maxParallelFetchStarted = Math.max(
    snapshot.maxParallelFetchStarted,
    incomingParallel,
    snapshot.parallelFetchStarted ?? 0,
  )
  publishInboxProof({
    lastThreadSelectCacheHit: input.cacheHit,
    lastThreadSelectCacheApplyMs: input.cacheApplyMs,
    lastThreadSelectMs: Math.round(input.selectMs),
    parallelFetchStarted: parallelStarted,
    maxParallelFetchStarted,
  })
}

export function markOptimisticPatch(action: string, threadId: string, patch: Record<string, unknown>): void {
  const entry: InboxProofOptimisticPatch = {
    action,
    threadId,
    at: new Date().toISOString(),
    patch,
  }
  publishInboxProof({
    lastOptimisticPatch: entry,
    optimisticPatches: [...snapshot.optimisticPatches, entry].slice(-24),
  })
}

export function adjustFetchInFlight(delta: number): void {
  const fetchInFlight = Math.max(0, snapshot.fetchInFlight + delta)
  publishInboxProof({
    fetchInFlight,
    maxFetchInFlight: Math.max(snapshot.maxFetchInFlight, fetchInFlight),
  })
}

export function markInboxLiveRequest(): void {
  publishInboxProof({ inboxLiveRequestCount: snapshot.inboxLiveRequestCount + 1 })
}

export function markDuplicateLiveRequestBlocked(): void {
  publishInboxProof({ duplicateLiveRequestBlocked: snapshot.duplicateLiveRequestBlocked + 1 })
}

export function markDegradedPollTick(): void {
  publishInboxProof({ degradedPollTicks: snapshot.degradedPollTicks + 1 })
}

export function markSelectedPollTick(): void {
  publishInboxProof({ selectedPollTicks: snapshot.selectedPollTicks + 1 })
}

export function markDossierParallelStarted(): void {
  publishInboxProof({ dossierParallelStarted: true })
}

export function markListScrollOffset(offset: number): void {
  publishInboxProof({ scrollOffset: Math.round(offset) })
}

export function resetInboxProofForTests(): void {
  snapshot = { ...EMPTY }
  apiBootStartedAt = null
  syncWindow()
}