import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { fetchWatchlist, toggleWatch as apiToggleWatch, type WatchlistTogglePayload } from './data/watchlistData'

interface WatchlistContextValue {
  watchedKeys: Set<string>
  isWatched: (watch_type: string, watch_key: string) => boolean
  toggleWatch: (payload: WatchlistTogglePayload) => Promise<void>
  loading: boolean
}

const WatchlistContext = createContext<WatchlistContextValue | null>(null)

export function useWatchlist(): WatchlistContextValue {
  const ctx = useContext(WatchlistContext)
  if (!ctx) throw new Error('useWatchlist must be used within WatchlistProvider')
  return ctx
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchedKeys, setWatchedKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchWatchlist()
      .then((entries) => {
        const keys = new Set(entries.map((e) => `${e.watch_type}:${e.watch_key}`))
        setWatchedKeys(keys)
      })
      .finally(() => setLoading(false))
  }, [])

  const isWatched = useCallback(
    (watch_type: string, watch_key: string) => watchedKeys.has(`${watch_type}:${watch_key}`),
    [watchedKeys],
  )

  const toggleWatch = useCallback(async (payload: WatchlistTogglePayload) => {
    const compositeKey = `${payload.watch_type}:${payload.watch_key}`
    // Optimistic update
    setWatchedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(compositeKey)) {
        next.delete(compositeKey)
      } else {
        next.add(compositeKey)
      }
      return next
    })

    const result = await apiToggleWatch(payload)
    // Reconcile with server result
    setWatchedKeys((prev) => {
      const next = new Set(prev)
      if (result === 'added') {
        next.add(compositeKey)
      } else {
        next.delete(compositeKey)
      }
      return next
    })
  }, [])

  return (
    <WatchlistContext.Provider value={{ watchedKeys, isWatched, toggleWatch, loading }}>
      {children}
    </WatchlistContext.Provider>
  )
}
