import { useLayoutEffect, useRef } from 'react'
import { formatCount } from './home-signals'
import { prefersStill } from './home-motion'

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4

/**
 * A number that counts to its value instead of snapping to it — up from zero on
 * first appearance, and from the old value to the new one when a poll moves it.
 *
 * It writes the text node directly inside requestAnimationFrame, so a count costs
 * no React renders. React still owns the final text: when `value` changes React
 * writes it, and the layout effect rewinds to the shown value before paint.
 */
export function Counter({ value, format = formatCount }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(0)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const start = shown.current
    const end = value
    if (start === end || prefersStill()) {
      node.textContent = format(end)
      shown.current = end
      return
    }
    node.textContent = format(start)
    const t0 = performance.now()
    const duration = 900 + Math.min(700, Math.log10(Math.abs(end - start) + 1) * 220)
    let frame = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      const current = Math.round(start + (end - start) * easeOutQuart(p))
      shown.current = current
      node.textContent = format(current)
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [format, value])

  return <span ref={ref} className="nx-home-counter">{format(value)}</span>
}
