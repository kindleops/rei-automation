import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAnalyticsPerformance, type AnalyticsPerformance } from '../../../../domain/analytics/analytics-performance-api'
import { fetchPipelineFeed, fetchPipelineOverview, fetchPipelinePoints, type PipelineCommandCard, type PipelineCommandOverview } from '../../../../domain/pipeline/pipeline-command-api'
import type { HomeLoad } from '../../home-signals'
import { fetchStudioActivity, type StudioActivity } from './home-command-model'

export type HomeRange = 'today' | '7d' | '30d'
export const HOME_RANGES: Array<{ key: HomeRange; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
]

const RANGE_KEY = 'nx.home.cmd.range'
const LIVE_KEY = 'nx.home.cmd.live'

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* private mode */ }
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * One source: loads now, re-loads on `deps`, polls while the tab is visible,
 * and keeps the last good value through a failed poll (a dropped request must
 * not blank a surface the operator is reading). Never loaded → unavailable,
 * with the reason.
 */
function useSource<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], everyMs: number): [HomeLoad<T>, () => void] {
  const [state, setState] = useState<HomeLoad<T>>({ status: 'loading' })
  const loadRef = useRef(load)
  loadRef.current = load
  const ctl = useRef<AbortController | null>(null)

  // A poll never cancels a read still in flight — on a slow day a source that
  // takes longer than its poll interval would otherwise never finish. Only a
  // real change (new deps) cancels and restarts.
  const run = useCallback((restart = false) => {
    if (ctl.current && !ctl.current.signal.aborted) {
      if (!restart) return
      ctl.current.abort()
    }
    const controller = new AbortController()
    ctl.current = controller
    const done = () => { if (ctl.current === controller) ctl.current = null }
    loadRef.current(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, at: Date.now() }); done() },
      (error: unknown) => {
        done()
        if (controller.signal.aborted) return
        setState((prev) => (prev.status === 'ready' ? prev : { status: 'unavailable', reason: error instanceof Error ? error.message : 'Unavailable' }))
      },
    )
  }, [])

  useEffect(() => {
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }))
    run(true)
    const t = window.setInterval(() => { if (visible()) run() }, everyMs)
    const onVisible = () => { if (visible()) run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      ctl.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, everyMs, run])

  return [state, useCallback(() => run(), [run])]
}

export interface HomeCommandData {
  range: HomeRange
  setRange: (r: HomeRange) => void
  live: boolean
  setLive: (on: boolean) => void
  performance: HomeLoad<AnalyticsPerformance>
  overview: HomeLoad<PipelineCommandOverview>
  deals: HomeLoad<Array<{ lat: number; lng: number }>>
  /** The live deals carrying the most estimated value. */
  top: HomeLoad<PipelineCommandCard[]>
  activity: HomeLoad<StudioActivity>
  refresh: () => void
}

export function useHomeCommand(): HomeCommandData {
  const [range, setRangeState] = useState<HomeRange>(() => readPref(RANGE_KEY, ['today', '7d', '30d'] as const, '7d'))
  const [live, setLiveState] = useState<boolean>(() => readPref(LIVE_KEY, ['on', 'off'] as const, 'on') === 'on')
  const setRange = useCallback((r: HomeRange) => { setRangeState(r); writePref(RANGE_KEY, r) }, [])
  const setLive = useCallback((on: boolean) => { setLiveState(on); writePref(LIVE_KEY, on ? 'on' : 'off') }, [])

  const [performance, reloadPerformance] = useSource((signal) => fetchAnalyticsPerformance({ range }, signal), [range], 3 * 60_000)
  const [overview, reloadOverview] = useSource((signal) => fetchPipelineOverview({ scope: 'active' }, signal), [], 3 * 60_000)
  const [deals, reloadDeals] = useSource(
    async (signal) => (await fetchPipelinePoints({ scope: 'active' }, signal)).points.map((p) => ({ lat: p.lat, lng: p.lng })),
    [],
    10 * 60_000,
  )
  const [top, reloadTop] = useSource(
    async (signal) => (await fetchPipelineFeed({ scope: 'active', view: 'all', sort: 'value', limit: 5 }, signal)).rows.filter((c) => (c.money.value ?? 0) > 0),
    [],
    3 * 60_000,
  )
  // Live mode is the feed's heartbeat: every 20 s while on, every 90 s while off.
  const [activity, reloadActivity] = useSource((signal) => fetchStudioActivity({ hours: 24, limit: 90 }, signal), [], live ? 20_000 : 90_000)

  const refresh = useCallback(() => { reloadPerformance(); reloadOverview(); reloadDeals(); reloadTop(); reloadActivity() }, [reloadPerformance, reloadOverview, reloadDeals, reloadTop, reloadActivity])

  return { range, setRange, live, setLive, performance, overview, deals, top, activity, refresh }
}
