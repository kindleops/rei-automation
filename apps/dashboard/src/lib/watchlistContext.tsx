import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { type WatchlistTogglePayload } from './data/watchlistData'
import { canonicalWatchKey, toggleLegacyWatch, useWatches } from './data/watchStore'

/**
 * Inbox watchlist context — a thin view over the ONE browser watch store
 * (lib/data/watchStore.ts), which reads and writes through apps/api.
 */
interface WatchlistContextValue {
  watchedKeys: ReadonlySet<string>
  isWatched: (watch_type: string, watch_key: string) => boolean
  toggleWatch: (payload: WatchlistTogglePayload) => Promise<void>
  loading: boolean
}

const WatchlistContext = createContext<WatchlistContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its provider
export function useWatchlist(): WatchlistContextValue {
  const ctx = useContext(WatchlistContext)
  if (!ctx) throw new Error('useWatchlist must be used within WatchlistProvider')
  return ctx
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const watches = useWatches()
  const isWatched = useCallback(
    (watch_type: string, watch_key: string) => watches.keys.has(canonicalWatchKey(watch_type, watch_key)),
    [watches.keys],
  )
  const value = useMemo<WatchlistContextValue>(() => ({
    watchedKeys: watches.keys,
    isWatched,
    toggleWatch: toggleLegacyWatch,
    loading: watches.status === 'idle' || watches.status === 'loading',
  }), [watches.keys, watches.status, isWatched])
  return <WatchlistContext.Provider value={value}>{children}</WatchlistContext.Provider>
}
