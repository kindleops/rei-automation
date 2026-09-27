/** A number that arrives — counts up from zero with an expo ease, then rests. */
import { useEffect, useRef, useState } from 'react'

export function CountUp({ value, format, ms = 1100 }: { value: number | null | undefined; format: (v: number) => string; ms?: number }) {
  const [shown, setShown] = useState<number | null>(value == null ? null : 0)
  const raf = useRef(0)
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) { setShown(null); return }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(value); return }
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
      setShown(value * e)
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [value, ms])
  return <>{shown == null ? '—' : format(shown)}</>
}
