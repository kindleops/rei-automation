import { useCallback, useEffect, useRef, useState } from 'react'
import { loadSettings } from '../../../shared/settings'

/**
 * A bounded, visibility-aware poll. The first read shows a calm loading state;
 * a later failed read keeps the last good answer on screen and says it is
 * stale rather than blanking the surface.
 */
export function usePoll<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[], intervalMs: number | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  const seq = useRef(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    const my = ++seq.current
    const ac = new AbortController()
    signal?.addEventListener('abort', () => ac.abort())
    try {
      const d = await fetchRef.current(ac.signal)
      if (my !== seq.current) return
      setData(d); setError(null); setAt(Date.now())
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || my !== seq.current) return
      setError((e as Error)?.message || 'unavailable')
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setData(null)
    void load(ac.signal)
    if (!intervalMs) return () => ac.abort()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, intervalMs)
    return () => { ac.abort(); window.clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, at, loading, reload: load }
}

/** Global motion setting + OS reduced motion → state changes instead of movement. */
export function useReducedMotion(): boolean {
  const read = () => {
    try {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true
      return loadSettings().animationsEnabled === false
    } catch { return false }
  }
  const [still, setStill] = useState(read)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const on = () => setStill(read())
    mq?.addEventListener?.('change', on)
    window.addEventListener('storage', on)
    return () => { mq?.removeEventListener?.('change', on); window.removeEventListener('storage', on) }
  }, [])
  return still
}

export const readParam = (k: string): string | null => { try { return new URLSearchParams(window.location.search).get(k) } catch { return null } }
