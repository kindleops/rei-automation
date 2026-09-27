import { useCallback, useEffect, useRef, useState } from 'react'
import {
  dataOf,
  loadHomeCampaigns,
  loadHomeClosings,
  loadHomeInbox,
  loadHomeMarkets,
  loadHomeMessaging,
  loadHomePipeline,
  loadHomeQueue,
  type HomeCampaigns,
  type HomeClosings,
  type HomeInbox,
  type HomeLoad,
  type HomeMarket,
  type HomeMessaging,
  type HomePipeline,
  type HomeQueue,
} from './home-signals'

export interface HomeSignals {
  inbox: HomeLoad<HomeInbox>
  queue: HomeLoad<HomeQueue>
  messaging: HomeLoad<HomeMessaging>
  campaigns: HomeLoad<HomeCampaigns>
  pipeline: HomeLoad<HomePipeline>
  closings: HomeLoad<HomeClosings>
  markets: HomeLoad<HomeMarket[]>
}

type SourceKey = keyof HomeSignals

const LOADING: HomeSignals = {
  inbox: { status: 'loading' },
  queue: { status: 'loading' },
  messaging: { status: 'loading' },
  campaigns: { status: 'loading' },
  pipeline: { status: 'loading' },
  closings: { status: 'loading' },
  markets: { status: 'loading' },
}

const LOADERS: { [K in SourceKey]: (signal: AbortSignal) => Promise<HomeSignals[K]> } = {
  inbox: loadHomeInbox,
  queue: () => loadHomeQueue(),
  messaging: () => loadHomeMessaging(),
  campaigns: () => loadHomeCampaigns(),
  pipeline: () => loadHomePipeline(),
  closings: loadHomeClosings,
  markets: () => loadHomeMarkets(),
}

/** The engine moves fastest; the pipeline and closings move on the scale of hours. */
const FAST_POLL_MS = 45_000
const SLOW_POLL_MS = 3 * 60_000
/**
 * A source that has not answered by now is reported unavailable rather than left
 * spinning. Some loaders fall back to a second read when the first fails, and on a
 * bad connection that chain can outlast the operator's patience; Focus waits for
 * every source to settle before it can honestly say "you're clear".
 */
const SOURCE_TIMEOUT_MS = 15_000
const FAST: SourceKey[] = ['inbox', 'queue', 'messaging']
const SLOW: SourceKey[] = ['campaigns', 'pipeline', 'closings', 'markets']

/**
 * Loads every Home source in parallel, each settling on its own.
 *
 * A source that fails keeps its last good value rather than flipping back to
 * unavailable on one bad poll — a single dropped request should not blank a
 * module the operator is reading. A source that has never loaded shows as
 * unavailable, with the reason.
 *
 * Polling pauses while the tab is hidden and catches up the moment it returns,
 * so a phone left on Home overnight is current the second it is picked up.
 */
export function useHomeSignals() {
  const [signals, setSignals] = useState<HomeSignals>(LOADING)
  const [refreshing, setRefreshing] = useState(false)
  const inflight = useRef(new Map<SourceKey, AbortController>())

  const settle = useCallback(<K extends SourceKey>(key: K, next: HomeSignals[K]) => {
    setSignals((current) => {
      const previous = current[key]
      if (next.status === 'unavailable' && previous.status === 'ready') return current
      return { ...current, [key]: next }
    })
  }, [])

  const run = useCallback(async (keys: SourceKey[]) => {
    await Promise.all(keys.map((key) => load(key)))

    async function load<K extends SourceKey>(key: K) {
      inflight.current.get(key)?.abort()
      const controller = new AbortController()
      inflight.current.set(key, controller)
      let result: HomeSignals[K]
      try {
        let timer = 0
        const timeout = new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error('Timed out')), SOURCE_TIMEOUT_MS)
        })
        try {
          result = await Promise.race([LOADERS[key](controller.signal), timeout])
        } finally {
          window.clearTimeout(timer)
        }
      } catch (error) {
        result = { status: 'unavailable', reason: error instanceof Error ? error.message : 'Unavailable' }
      }
      if (controller.signal.aborted) return
      inflight.current.delete(key)
      settle(key, result)
    }
  }, [settle])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await run([...FAST, ...SLOW])
    } finally {
      setRefreshing(false)
    }
  }, [run])

  useEffect(() => {
    const controllers = inflight.current
    void run([...FAST, ...SLOW])

    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const fast = window.setInterval(() => { if (visible()) void run(FAST) }, FAST_POLL_MS)
    const slow = window.setInterval(() => { if (visible()) void run(SLOW) }, SLOW_POLL_MS)
    const onVisible = () => { if (visible()) void run([...FAST, ...SLOW]) }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(fast)
      window.clearInterval(slow)
      document.removeEventListener('visibilitychange', onVisible)
      controllers.forEach((controller) => controller.abort())
      controllers.clear()
    }
  }, [run])

  return { signals, refresh, refreshing }
}

export type SystemTone = 'good' | 'warn' | 'bad' | 'unknown'

export function resolveSystemState(signals: HomeSignals): { tone: SystemTone; label: string } {
  const queue = dataOf(signals.queue)
  if (signals.queue.status === 'loading') return { tone: 'unknown', label: 'Checking systems' }
  if (!queue) return { tone: 'unknown', label: 'Engine status unavailable' }
  if (queue.status === 'critical') return { tone: 'bad', label: 'Needs intervention' }
  if (queue.status === 'warning' || queue.failedToday > 0 || queue.lagging > 0) {
    return { tone: 'warn', label: 'Running with issues' }
  }
  return { tone: 'good', label: 'All systems operational' }
}
