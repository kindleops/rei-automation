/**
 * Command Wall presentation primitives: event glyphs, the rolling KPI figure,
 * the rail sparkline. Pure presentation — every number they draw is handed in
 * from the one channel; nothing here fetches, polls or animates on a timer.
 */
import { useLayoutEffect, useRef } from 'react'
import type { WallEvent } from './wall-types'

/* ── event-type glyphs (16-unit grid, 1.5 hairline stroke, currentColor) ── */
const GLYPH: Record<WallEvent['kind'], string> = {
  sends: 'M5 11 11 5M6.2 5H11v4.8',
  reply: 'M3.6 3.6h8.8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.2l-3 2.4v-2.4H3.6a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
  interest: 'M8 2.4 9.3 6.7 13.6 8 9.3 9.3 8 13.6 6.7 9.3 2.4 8 6.7 6.7z',
  asking_price: 'M2.6 8.3V3.6a1 1 0 0 1 1-1h4.7l5.3 5.3-5.8 5.8zM5.6 5.6h.01',
  offer: 'M4 2.6h5.4L12 5.2v8.2H4zM9.4 2.6v2.6H12M6.2 8.4h3.6M6.2 10.8h2.4',
  counter: 'M3 5.8h9.4L10 3.4M13 10.2H3.6L6 12.6',
  deal: 'M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6zM5.6 8.2l1.7 1.7 3.2-3.4',
  stage: 'M4 4.4 7.6 8 4 11.6M8.4 4.4 12 8l-3.6 3.6',
  campaign: 'M8 6.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM5.1 4.9a4.3 4.3 0 0 0 0 6.2M10.9 4.9a4.3 4.3 0 0 1 0 6.2M3.4 3.2a6.7 6.7 0 0 0 0 9.6M12.6 3.2a6.7 6.7 0 0 1 0 9.6',
  signal: 'M8 2.8 13.7 12.6H2.3zM8 6.6v2.8M8 11.1v.05',
  opt_out: 'M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6zM5.5 8h5',
}

export function WallGlyph({ kind, className }: { kind: WallEvent['kind']; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={GLYPH[kind] ?? GLYPH.signal} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const INT_RE = /^\d{1,3}(,\d{3})*$|^\d+$/
const ease = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * A KPI figure that rolls from its previous value when a NEW real value arrives
 * (state refresh), then rests. Writes textContent through a ref so a roll never
 * re-renders React. Non-integer values ("Delayed", "14/18", "—") just swap.
 */
export function RollNumber({ value, animate, className }: { value: string; animate: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const prev = useRef<string>(value)
  // React never owns this text node (no children): the effect is the only writer, so a roll can't fight reconciliation
  useLayoutEffect(() => {
    const el = ref.current
    const from = prev.current
    prev.current = value
    if (!el) return undefined
    if (!animate || !INT_RE.test(value) || !INT_RE.test(from) || from === value) { el.textContent = value; return undefined }
    const a = Number(from.replace(/,/g, ''))
    const b = Number(value.replace(/,/g, ''))
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) < 1) { el.textContent = value; return undefined }
    const dur = 720
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      el.textContent = Math.round(a + (b - a) * ease(k)).toLocaleString('en-US')
      if (k < 1) raf = requestAnimationFrame(step)
      else el.textContent = value
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); el.textContent = value }
  }, [value, animate])
  return <span ref={ref} className={className} />
}

/**
 * Sparkline over real bins. null = the wall holds no history for that bin, so
 * the line simply starts later — it never draws a flat "zero" it did not see.
 */
export function Sparkline({ values, tone = 'cobalt', className }: { values: (number | null)[]; tone?: 'cobalt' | 'gold'; className?: string }) {
  const W = 100
  const H = 28
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length < 3) return null
  const max = Math.max(1, ...nums)
  const step = W / Math.max(1, values.length - 1)
  const pts: [number, number][] = []
  values.forEach((v, i) => { if (v !== null) pts.push([i * step, H - 2 - (v / max) * (H - 5)]) })
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('')
  const area = `${line}L${pts[pts.length - 1][0].toFixed(2)} ${H}L${pts[0][0].toFixed(2)} ${H}Z`
  const last = pts[pts.length - 1]
  const id = `cw-sg-${tone}`
  return (
    <svg className={className} data-tone={tone} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <path className="cw-spark__head" d={`M${last[0].toFixed(2)} ${last[1].toFixed(2)}h0`} fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
