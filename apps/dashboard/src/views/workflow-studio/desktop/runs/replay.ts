import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RunDetailResponse, TimingQuality } from '../lib/types'

/**
 * REPLAY — plays a run's RECORDED path back on the board. It never
 * re-executes anything and never invents timing:
 *
 *   measured  the orchestrator stamps each step: playback follows the real
 *             gaps (compressed so a 4-hour wait takes ~2 s — the scrubber
 *             always shows the real timestamp)
 *   recorder  steps were written in one burst after the run (seller flow):
 *             the ORDER is causal, the spacing is uniform presentation
 *   inferred / single   one row per run: order only
 */

export interface ReplayStep { node: string; at: number | null; status: string; label: string | null }

export const SPEEDS = [0.5, 1, 2] as const
export type Speed = (typeof SPEEDS)[number]

export function replayStepsOf(run: RunDetailResponse | null): ReplayStep[] {
  if (!run) return []
  return run.path.order.map((k) => {
    const n = run.path.nodes[k]
    const t = n?.at ? Date.parse(n.at) : NaN
    return { node: k, at: Number.isFinite(t) ? t : null, status: n?.status || 'succeeded', label: n?.label || (n?.reason ? n.reason.replace(/_/g, ' ') : null) }
  }).filter((s) => s.status !== 'skipped')
}

/** Playback delay before step i (ms at 1×). */
export function delayBefore(steps: ReplayStep[], i: number, quality: TimingQuality): number {
  if (i <= 0) return 0
  if (quality !== 'measured') return 620
  const a = steps[i - 1]?.at
  const b = steps[i]?.at
  if (a === null || b === null || a === undefined || b === undefined) return 620
  const gap = Math.max(0, b - a)
  return Math.round(Math.min(1900, Math.max(260, 260 + 330 * Math.log10(1 + gap / 1000))))
}

interface State { key: string | null; index: number | null; playing: boolean; speed: Speed }

export function useReplay(runKey: string | null, steps: ReplayStep[], quality: TimingQuality) {
  const [st, setSt] = useState<State>({ key: null, index: null, playing: false, speed: 1 })
  // a different run starts idle — derived, never reset inside an effect
  const cur: State = useMemo(() => (st.key === runKey ? st : { key: runKey, index: null, playing: false, speed: st.speed }), [runKey, st])
  const n = steps.length
  const playing = cur.playing && cur.index !== null && cur.index < n

  useEffect(() => {
    if (!playing || cur.index === null) return
    const t = window.setTimeout(() => setSt((s) => (s.key === runKey ? { ...s, index: Math.min(n, (s.index ?? 0) + 1) } : s)), delayBefore(steps, cur.index, quality) / cur.speed || 620 / cur.speed)
    return () => window.clearTimeout(t)
  }, [cur.index, cur.speed, n, playing, quality, runKey, steps])

  const play = useCallback(() => setSt({ key: runKey, index: cur.index === null || cur.index >= n ? 1 : cur.index, playing: true, speed: cur.speed }), [cur.index, cur.speed, n, runKey])
  const pause = useCallback(() => setSt({ ...cur, playing: false }), [cur])
  const seek = useCallback((i: number) => setSt({ ...cur, key: runKey, index: Math.max(0, Math.min(n, i)), playing: false }), [cur, n, runKey])
  const step = useCallback((d: number) => setSt({ ...cur, key: runKey, index: Math.max(1, Math.min(n, (cur.index ?? 0) + d)), playing: false }), [cur, n, runKey])
  const stop = useCallback(() => setSt({ ...cur, key: runKey, index: null, playing: false }), [cur, runKey])
  const setSpeed = useCallback((speed: Speed) => setSt({ ...cur, key: runKey, speed }), [cur, runKey])

  const span = useMemo(() => {
    const ts = steps.map((s) => s.at).filter((x): x is number => x !== null)
    return ts.length ? { from: Math.min(...ts), to: Math.max(...ts) } : null
  }, [steps])
  return { index: cur.index, playing, speed: cur.speed, active: cur.index !== null, length: n, span, play, pause, seek, step, stop, setSpeed }
}

export type Replay = ReturnType<typeof useReplay>
