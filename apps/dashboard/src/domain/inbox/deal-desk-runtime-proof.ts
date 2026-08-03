/**
 * Deal Desk runtime proof counters.
 *
 * Publishes selection/hydration diagnostics on `window.__DEAL_DESK_PROOF__` so the
 * performance guardrails in N.1 (requests per selection, duplicate requests, remount
 * counts, stale-response rejections) can be measured in a real browser instead of
 * asserted from static reasoning.
 *
 * Deliberately silent: nothing here writes to the console. The object is only attached
 * in dev builds or when a harness sets `window.__DEAL_DESK_PROOF_ENABLED__ = true` before
 * the module loads, so production sessions carry no instrumentation.
 */

export interface DealDeskProofCounters {
  /** Canonical selection key currently active. */
  selectionKey: string | null
  /** Monotonic selection generation. */
  selectionVersion: number
  /** How many times an explicit or auto selection has been committed. */
  selectionCommits: number
  /** Requests issued per resource for the current session. */
  requestsByResource: Record<string, number>
  /** Responses that proved current and were allowed to commit. */
  acceptedResponses: number
  /** Responses refused because they belonged to a superseded selection. */
  staleRejections: number
  /** Requests cancelled because a newer request superseded them. */
  abortedRequests: number
  /** Mount counts per instrumented component. */
  mounts: Record<string, number>
  /** True while a bucket list request is in flight. */
  bucketTransitionPending: boolean
  /** True when the workspace is showing the first-run blank state. */
  globalEmptyWorkspace: boolean
  /** Reason string from the last selection reconciliation. */
  lastReconcileReason: string | null
}

type ProofWindow = Window & {
  __DEAL_DESK_PROOF__?: DealDeskProofCounters
  __DEAL_DESK_PROOF_ENABLED__?: boolean
}

const emptyCounters = (): DealDeskProofCounters => ({
  selectionKey: null,
  selectionVersion: 0,
  selectionCommits: 0,
  requestsByResource: {},
  acceptedResponses: 0,
  staleRejections: 0,
  abortedRequests: 0,
  mounts: {},
  bucketTransitionPending: false,
  globalEmptyWorkspace: true,
  lastReconcileReason: null,
})

const counters = emptyCounters()

const proofWindow = (): ProofWindow | null =>
  typeof window === 'undefined' ? null : (window as ProofWindow)

const isEnabled = (): boolean => {
  const win = proofWindow()
  if (!win) return false
  if (win.__DEAL_DESK_PROOF_ENABLED__ === true) return true
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

const publish = () => {
  const win = proofWindow()
  if (!win || !isEnabled()) return
  win.__DEAL_DESK_PROOF__ = { ...counters, requestsByResource: { ...counters.requestsByResource }, mounts: { ...counters.mounts } }
}

/** Record a component mount. Call from a `useEffect(..., [])`. */
export const markDealDeskMount = (component: string): void => {
  if (!isEnabled()) return
  counters.mounts[component] = (counters.mounts[component] ?? 0) + 1
  publish()
}

/** Snapshot the current selection state. */
export const markDealDeskSelection = (input: {
  selectionKey: string | null
  selectionVersion: number
  bucketTransitionPending: boolean
  globalEmptyWorkspace: boolean
  lastReconcileReason: string | null
}): void => {
  if (!isEnabled()) return
  if (input.selectionVersion !== counters.selectionVersion) counters.selectionCommits += 1
  counters.selectionKey = input.selectionKey
  counters.selectionVersion = input.selectionVersion
  counters.bucketTransitionPending = input.bucketTransitionPending
  counters.globalEmptyWorkspace = input.globalEmptyWorkspace
  counters.lastReconcileReason = input.lastReconcileReason
  publish()
}

/** Mirror the selection request guard's counters. */
export const markDealDeskGuardStats = (stats: {
  accepted: number
  rejectedStale: number
  aborted: number
  byResource: Record<string, { issued: number }>
}): void => {
  if (!isEnabled()) return
  counters.acceptedResponses = stats.accepted
  counters.staleRejections = stats.rejectedStale
  counters.abortedRequests = stats.aborted
  counters.requestsByResource = Object.fromEntries(
    Object.entries(stats.byResource).map(([key, value]) => [key, value.issued]),
  )
  publish()
}

/** Read the counters directly (tests, dev tooling). */
export const getDealDeskProof = (): DealDeskProofCounters => ({
  ...counters,
  requestsByResource: { ...counters.requestsByResource },
  mounts: { ...counters.mounts },
})

/** Reset between harness scenarios. */
export const resetDealDeskProof = (): void => {
  Object.assign(counters, emptyCounters())
  publish()
}
