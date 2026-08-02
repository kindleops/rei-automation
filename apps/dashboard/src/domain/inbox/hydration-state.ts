/**
 * Deal Desk hydration state — separates *what is selected* from *what is hydrated*.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md §J):
 *   "Where good data is wiped by an unresolved request" — the bucket switch nulls the
 *   selection which clears `selectedMessages`/`threadContext`/`threadIntelligence`/
 *   `dealContext` (`InboxPage.tsx:2004-2017`), and `ChatThread` swaps content for a
 *   skeleton whenever `loading && messages.length === 0` (`ChatThread.tsx:539`).
 *
 * The invariant every transition here enforces: **a load, a refresh or a failure never
 * erases data that was already valid.** Only an explicit `resetHydration` does, and that
 * is reserved for an explicit selection clear.
 *
 * Pure and dependency-free — the full transition table is testable under `node --test`.
 */

export type HydrationStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error'

export type HydrationState<T> =
  | { status: 'idle'; data: null }
  | { status: 'loading'; data: T | null }
  | { status: 'ready'; data: T }
  | { status: 'refreshing'; data: T }
  | { status: 'error'; data: T | null; error: Error }

export const idleHydration = <T>(): HydrationState<T> => ({ status: 'idle', data: null })

/**
 * Begin a load.
 *   - with prior data → `refreshing`, data retained (no skeleton over real content)
 *   - without prior data → `loading`, data null (the only case that may show a skeleton)
 */
export const beginHydration = <T>(previous: HydrationState<T> | undefined): HydrationState<T> => {
  const prior = previous?.data ?? null
  if (prior !== null) return { status: 'refreshing', data: prior }
  return { status: 'loading', data: null }
}

/** Commit a successful response. */
export const commitHydration = <T>(data: T): HydrationState<T> => ({ status: 'ready', data })

/**
 * Record a failure. Error state is scoped to this resource and retains whatever data was
 * already valid, so a failed Deal Intelligence request cannot erase the conversation.
 */
export const failHydration = <T>(
  previous: HydrationState<T> | undefined,
  error: Error,
): HydrationState<T> => ({ status: 'error', data: previous?.data ?? null, error })

/** Drop everything. Only valid on an explicit selection clear. */
export const resetHydration = <T>(): HydrationState<T> => idleHydration<T>()

/**
 * Seed a resource with an optimistic/derived value (e.g. the thread row itself acting as
 * an intelligence seed) without claiming the network response arrived.
 */
export const seedHydration = <T>(data: T): HydrationState<T> => ({ status: 'loading', data })

export const hydrationData = <T>(state: HydrationState<T> | undefined): T | null =>
  state?.data ?? null

export const isHydrationPending = <T>(state: HydrationState<T> | undefined): boolean =>
  state?.status === 'loading' || state?.status === 'refreshing'

/** True when there is data worth rendering, whatever the status. */
export const hasHydratedData = <T>(state: HydrationState<T> | undefined): boolean =>
  (state?.data ?? null) !== null

/**
 * True when this resource should render its *own* empty/skeleton treatment.
 * Localised loading: never blanks a panel that already has content.
 */
export const shouldRenderResourceSkeleton = <T>(state: HydrationState<T> | undefined): boolean =>
  state?.status === 'loading' && !hasHydratedData(state)

export const hydrationError = <T>(state: HydrationState<T> | undefined): Error | null =>
  state?.status === 'error' ? state.error : null
