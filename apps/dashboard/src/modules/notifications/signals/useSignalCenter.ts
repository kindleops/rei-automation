import { useCallback, useEffect, useState } from 'react'
import { fetchSignalCenter } from './signals-api'
import type { SignalCenterModel } from './signals-model'

type Load = { status: 'loading' | 'ready' | 'error'; model: SignalCenterModel | null; error: string | null; at: number | null }

const REFRESH_MS = 60_000

/** The Signal Center read model, refreshed every minute (shared by this panel and the plane's settings surface). */
export function useSignalCenter() {
  const [load, setLoad] = useState<Load>({ status: 'loading', model: null, error: null, at: null })
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    let alive = true
    fetchSignalCenter().then((r) => {
      if (!alive) return
      if (r.ok) setLoad({ status: 'ready', model: r, error: null, at: Date.now() })
      else setLoad((prev) => ({ ...prev, status: 'error', error: r.message }))
    })
    const t = window.setTimeout(() => setTick((x) => x + 1), REFRESH_MS)
    return () => { alive = false; window.clearTimeout(t) }
  }, [tick])
  return { ...load, refresh }
}

