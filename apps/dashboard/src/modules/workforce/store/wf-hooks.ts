/**
 * WORKFORCE — data hooks. Read-only GETs with a live clock.
 *
 * The pattern is Pipeline's (views/pipeline/desk/use-pipeline-desk.ts):
 * one refresh clock per app, keyed reads that keep their last good frame
 * while the next lands, state set only from async results, one automatic
 * retry for a failed GET. The clock slows to a crawl when the pane is a
 * background tab or behind a maximized pane (useAppInstance().visible).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppInstance } from '../../desktop/workspace/instance-context'
import { listEvents, type WfFailure, type WfResult } from '../api/wf-client'
import type { WfEvent } from '../api/wf-types'

export const WF_POLL = { fast: 4_000, normal: 20_000, hidden: 120_000 } as const

/** The cadence for a pane: fast while something is moving, slow when the pane is not visible. */
export const pollMsFor = (visible: boolean, fast: boolean): number => (!visible ? WF_POLL.hidden : fast ? WF_POLL.fast : WF_POLL.normal)

/** One refresh clock: a steady poll plus an immediate bump when the window regains focus. */
export function useWfLiveTick(fast = false): { tick: number; pollMs: number; visible: boolean; bump: () => void } {
  const { visible } = useAppInstance()
  const pollMs = pollMsFor(visible, fast)
  const [tick, setTick] = useState(0)
  const bump = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    const poll = window.setInterval(() => setTick((n) => n + 1), pollMs)
    const onFocus = () => { if (visible) setTick((n) => n + 1) }
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(poll); window.removeEventListener('focus', onFocus) }
  }, [pollMs, visible])
  return { tick, pollMs, visible, bump }
}

export interface WfView<T> {
  data: T | null
  failure: WfFailure | null
  loading: boolean
  /** ms of the last good frame */
  at: number | null
  fixture: boolean
  retry: () => void
}

type Frame<T> = { key: string; data: T | null; failure: WfFailure | null; at: number | null; fixture: boolean }

const NO_RETRY = new Set(['not_enabled', 'session', 'denied', 'cancelled'])

/** A keyed GET. `key` encodes every input of `load`; `tick` re-runs it. Null key = idle. */
export function useWf<T>(key: string | null, load: (signal: AbortSignal) => Promise<WfResult<T>>, tick: number): WfView<T> {
  const [frame, setFrame] = useState<Frame<T> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retried = useRef<Set<string>>(new Set())
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])
  useEffect(() => {
    if (!key) return
    const c = new AbortController()
    loadRef.current(c.signal).then((r) => {
      if (c.signal.aborted) return
      if (r.ok) {
        retried.current.delete(key)
        setFrame({ key, data: r.data, failure: null, at: Date.now(), fixture: r.fixture })
        return
      }
      if (r.state === 'cancelled') return
      setFrame((cur) => ({ key, data: cur && cur.key === key ? cur.data : null, failure: r, at: cur && cur.key === key ? cur.at : null, fixture: cur?.fixture ?? false }))
      if (!NO_RETRY.has(r.state) && !retried.current.has(key)) {
        retried.current.add(key)
        window.setTimeout(() => setAttempt((a) => a + 1), 2500)
      }
    }, () => { /* a transport throw is reported by the next frame */ })
    return () => c.abort()
  }, [key, tick, attempt])
  const current = frame && frame.key === key ? frame : null
  return {
    data: current?.data ?? null,
    failure: current?.failure ?? null,
    loading: Boolean(key) && !current,
    at: current?.at ?? null,
    fixture: current?.fixture ?? false,
    retry: () => setAttempt((a) => a + 1),
  }
}

/* ── the operations feed: cursor paging both ways ─────────────────────── */

export interface WfFeed {
  events: WfEvent[]
  failure: WfFailure | null
  loading: boolean
  at: number | null
  /** ids that arrived since the first page (one highlight, never a loop) */
  fresh: ReadonlySet<number>
  loadOlder: () => void
  loadingOlder: boolean
  hasOlder: boolean
  fixture: boolean
}

const PAGE = 40

/** Newest first. The first page reads the latest events; each tick asks for `after=<newest>`; Load older asks for `before=<oldest>`. */
export function useWfFeed(tick: number, mission: string | null = null): WfFeed {
  const [events, setEvents] = useState<WfEvent[]>([])
  const [failure, setFailure] = useState<WfFailure | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [at, setAt] = useState<number | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set())
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasOlder, setHasOlder] = useState(true)
  const [fixture, setFixture] = useState(false)
  const newest = useRef<number | null>(null)
  const oldest = useRef<number | null>(null)
  const scope = useRef(mission)

  useEffect(() => {
    // a new scope starts over (state is reset from the async result, below)
    if (scope.current !== mission) { scope.current = mission; newest.current = null; oldest.current = null }
    const c = new AbortController()
    const first = newest.current === null
    listEvents(first ? { mission, limit: PAGE } : { mission, after: newest.current, limit: 200 }, c.signal).then((r) => {
      if (c.signal.aborted) return
      if (!r.ok) { if (r.state !== 'cancelled') { setFailure(r); setLoaded(true) } return }
      setFailure(null)
      setFixture(r.fixture)
      setAt(Date.now())
      setLoaded(true)
      const page = [...r.data.events].sort((a, b) => b.event_id - a.event_id)
      if (first) {
        setEvents(page)
        setHasOlder(page.length >= PAGE)
        setFresh(new Set())
      } else if (page.length) {
        setEvents((cur) => {
          const seen = new Set(cur.map((e) => e.event_id))
          return [...page.filter((e) => !seen.has(e.event_id)), ...cur]
        })
        setFresh(new Set(page.map((e) => e.event_id)))
      }
      if (page.length) {
        newest.current = Math.max(newest.current ?? 0, page[0].event_id)
        if (first) oldest.current = page[page.length - 1].event_id
      }
    }, () => { /* reported by the next frame */ })
    return () => c.abort()
  }, [tick, mission])

  const loadOlder = useCallback(() => {
    if (loadingOlder || oldest.current === null) return
    setLoadingOlder(true)
    void listEvents({ mission, before: oldest.current, limit: PAGE }).then((r) => {
      setLoadingOlder(false)
      if (!r.ok) { if (r.state !== 'cancelled') setFailure(r); return }
      const page = [...r.data.events].sort((a, b) => b.event_id - a.event_id).filter((e) => oldest.current === null || e.event_id < oldest.current)
      if (page.length) oldest.current = page[page.length - 1].event_id
      setHasOlder(page.length >= PAGE)
      setEvents((cur) => [...cur, ...page])
    })
  }, [loadingOlder, mission])

  return { events, failure, loading: !loaded, at, fresh, loadOlder, loadingOlder, hasOlder, fixture }
}
