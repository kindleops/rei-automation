/**
 * Measured element width via ResizeObserver.
 *
 * Generalised from `views/queue/hooks/useQueueLayout.ts` — the one place in the
 * repo that already resolved layout from a real measurement rather than a mode
 * flag. Once pane widths are continuous, every adaptive surface needs this.
 *
 * The observer callback is rAF-coalesced and only re-renders when the rounded
 * width actually changes, so a drag that ends on the same integer width costs
 * zero renders.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { resolveBandFromWidth, type PaneWidthBand } from './pane-geometry'

export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options?: {
    enabled?: boolean
    /**
     * Snap the reported width to this pixel grid before re-rendering.
     *
     * This is not a micro-optimisation. Reporting every pixel re-renders the
     * whole pane subtree, and a virtualised list whose scrollbar appears and
     * disappears across a width boundary then oscillates: observer -> render ->
     * relayout -> observer. That loop is what "Maximum update depth exceeded"
     * looks like from `react-window`. Quantizing makes it impossible.
     */
    quantum?: number
  },
): number {
  const enabled = options?.enabled !== false
  const quantum = Math.max(1, options?.quantum ?? 1)
  const [width, setWidth] = useState(0)
  const frameRef = useRef(0)
  const lastRef = useRef(-1)

  useEffect(() => {
    const element = ref.current
    if (!element || !enabled || typeof ResizeObserver === 'undefined') return

    const commit = (next: number) => {
      const rounded = Math.round(next / quantum) * quantum
      if (rounded === lastRef.current) return
      lastRef.current = rounded
      setWidth(rounded)
    }

    commit(element.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const next = entry.contentRect.width || element.getBoundingClientRect().width
      cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => commit(next))
    })

    observer.observe(element)
    return () => {
      cancelAnimationFrame(frameRef.current)
      observer.disconnect()
    }
  }, [ref, enabled, quantum])

  return width
}

/** Convenience wrapper: measured width plus its recomposition band. */
export function useMeasuredBand<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options?: { enabled?: boolean },
): { width: number; band: PaneWidthBand } {
  const width = useElementWidth(ref, options)
  return { width, band: resolveBandFromWidth(width) }
}
