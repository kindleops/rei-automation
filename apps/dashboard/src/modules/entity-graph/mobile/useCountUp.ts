import { useEffect, useRef, useState } from 'react'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/**
 * Animate a number toward its target.
 *
 * The cohort count is the single most important number on the screen, and a
 * hard cut from 169,797 to 1,059 reads as a glitch rather than as a filter
 * taking effect. Counting it down makes cause and effect visible.
 *
 * Deliberately not a spring: the duration is fixed and short so the number is
 * settled and readable before the operator's eye reaches it. `prefers-reduced-
 * motion` jumps straight to the target.
 *
 * State transitions that are instant (null, or reduced motion) are applied
 * during render; only the per-frame updates come from the animation callback,
 * so no render pass is spent waiting on an effect.
 */
export function useCountUp(target: number | null, durationMs = 520): number | null {
  // `from` lives in state next to the target it belongs to, so the render-time
  // reset never has to write a ref (which would not survive StrictMode's
  // discarded first pass).
  const [state, setState] = useState<{ target: number | null; from: number; value: number | null }>(
    () => ({ target, from: target ?? 0, value: target }),
  )
  const frameRef = useRef<number | null>(null)

  if (state.target !== target) {
    // Jump instantly when there is nothing to animate *from* — a null previous
    // value means first paint, and counting 0 → 169,797 on load is noise, not
    // information. It also means a starved rAF (throttled or backgrounded tab)
    // can never leave the number stuck on "—": the value is always seeded with
    // the truth and motion only ever refines it.
    const instant = target === null || state.value === null || prefersReducedMotion()
    setState({
      target,
      from: instant ? (target ?? 0) : (state.value ?? state.from),
      value: instant ? target : state.value,
    })
  }

  const from = state.from
  const value = state.value

  useEffect(() => {
    if (target === null || prefersReducedMotion()) return
    if (from === target) return

    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      // easeOutCubic: responsive at the start, settled at the end.
      const eased = 1 - Math.pow(1 - t, 3)
      const next = Math.round(from + (target - from) * eased)
      setState((current) => (current.target === target ? { ...current, value: next } : current))
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        // Land exactly on the target so the next run starts from the truth
        // rather than from a rounding artefact.
        setState((current) => (current.target === target ? { target, from: target, value: target } : current))
        frameRef.current = null
      }
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [durationMs, from, target])

  return value
}
