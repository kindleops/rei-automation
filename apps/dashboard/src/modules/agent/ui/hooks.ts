/**
 * Small UI hooks + derived clocks shared by the agent surfaces (kept out of
 * component files so React Fast Refresh stays component-only there).
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { RunSnapshot } from '../runtime/agent-store'

/** Re-render on a cadence while something is live (elapsed time is derived, never stored). */
export function useTick(ms: number, on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms, on])
}

/** Wall clock for a run; a held (capture) fixture never runs past its last event. */
export const nowWallOf = (snap: RunSnapshot) => (snap.record.frozenT !== null ? snap.record.startWall + Math.min(snap.record.frozenT, snap.end) : Date.now())

/** Width of an element, tracked with a ResizeObserver (the canvas adds columns as it widens). */
export function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}
