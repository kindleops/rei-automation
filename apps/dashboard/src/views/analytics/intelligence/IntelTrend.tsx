/**
 * THE TREND — one metric over the period, the comparison window aligned by
 * bucket, drawn as an instrument rather than a widget.
 *
 * Interaction after Arc's Line Chart (free, MIT): a crosshair that follows
 * the pointer and the keyboard (role="slider": ← → PgUp PgDn Home End, Enter
 * inspects, Esc releases), and paths that MORPH from the shape on screen to
 * the next dataset — metric switch, range change, filter — instead of
 * redrawing. It is implemented here rather than reused because the shared
 * component draws a missing value as zero; in Analytics a day with no
 * sellers reached has NO reply rate — never a 0% dip.
 *
 * Honesty layer:
 *   · one continuous trend, no invented values (intel-trend-path.ts): a count
 *     with no activity is a real 0; a rate with no denominator has no value,
 *     and the line BRIDGES it with a faint dashed connector whose empty days
 *     read "no sellers that day" on hover — the connector is never a value
 *   · rates carry their Wilson 95% band; buckets under the sample floor are
 *     hollow and the band says how little they know
 *   · the newest seller cohorts are "maturing" (less time to reply) — shaded
 *   · the previous period is recessed (dashed, quiet), never a rival line
 *   · operational events are pins on the time axis; a pin opens the event
 *
 * Geometry is computed in data units once per dataset; a resize only
 * re-projects it (no recomputation per pixel, no remount).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { animate } from 'framer-motion'
import { LC_DUR, lcEase, useLcReducedMotion } from '../../../shared/lc'
import type { IntelEvent, TrendPoint } from './intel-model'
import { clamp, fmtBucket, labelIndices, niceTicks } from './intel-format'
import { trendSegments } from './intel-trend-path'

type Unit = 'count' | 'rate' | 'ratio' | 'duration_min'
type Props = {
  points: TrendPoint[]
  unit: Unit
  grain: string
  tz: string
  label: string
  format: (v: number | null) => string
  formatTick: (v: number) => string
  height?: number
  minSample?: number | null
  maturingFrom?: number | null
  events?: IntelEvent[]
  showCompare?: boolean
  active: number | null
  onActive: (i: number | null) => void
  onPick?: (i: number) => void
  /** an event pin (several pins too close to tell apart become one pin that opens them all) */
  onEvent?: (e: IntelEvent, group?: IntelEvent[]) => void
  /** for rates: the per-bucket sample (the denominator) as a thin strip under the axis — why a day is a gap or hollow */
  sampleLabel?: string | null
  /** draw a floating readout beside the crosshair (compact charts; the hero has its own headline) */
  tooltip?: boolean
  compareLabel?: string | null
  currentLabel?: string
  loading?: boolean
  className?: string
}

type Geo = {
  n: number
  cur: Array<number | null>
  /** the current series where the bucket has enough sample to draw solid (rates); all of it for counts */
  sure: Array<number | null>
  prev: Array<number | null>
  lo: Array<number | null>
  hi: Array<number | null>
  min: number
  max: number
  ticks: number[]
  /** buckets below this denominator are drawn hollow, outside the solid line */
  floor: number
  /** the largest per-bucket denominator (rates) */
  denMax: number
}
const M = { l: 6, r: 52, t: 30, b: 28 }

/** Data-unit geometry: values, interval, a clean scale from zero. Pure. */
function trendGeometry(points: TrendPoint[], unit: Unit, showCompare: boolean, minSample?: number | null): Geo {
  const isRate = unit === 'rate'
  const cur = points.map((p) => (p.value === null || p.value === undefined ? null : p.value))
  const prev = points.map((p) => (showCompare && p.prev && p.prev.value !== null && p.prev.value !== undefined ? p.prev.value : null))
  const floorOf = isRate ? Math.max(5, Math.ceil((minSample || 30) / 3)) : 0
  // the interval travels with the line: credible buckets only (a 1-of-1 day's 20–100% band is not a trend)
  const lo = points.map((p) => (isRate && p.ci && (p.den ?? 0) >= floorOf ? p.ci.low : null))
  const hi = points.map((p) => (isRate && p.ci && (p.den ?? 0) >= floorOf ? p.ci.high : null))
  // a rate's scale is set by buckets with enough sample: one seller who replied
  // (1 of 1 = 100%) must not flatten every meaningful day into the floor; such a
  // bucket is drawn clipped at the top edge, hollow, and the readout says so
  const floor = floorOf
  const vals: number[] = []
  for (let i = 0; i < points.length; i += 1) {
    const sure = !isRate || (points[i].den ?? 0) >= floor
    const sureP = !isRate || (points[i].prev?.den ?? 0) >= floor
    if (cur[i] !== null && sure) vals.push(cur[i] as number)
    if (prev[i] !== null && sureP) vals.push(prev[i] as number)
    if (hi[i] !== null && sure) vals.push(hi[i] as number)
  }
  if (!vals.length) for (let i = 0; i < points.length; i += 1) if (cur[i] !== null) vals.push(cur[i] as number)
  const sure = cur.map((v, i) => (v !== null && (!isRate || (points[i].den ?? 0) >= floor) ? v : null))
  // the comparison line runs through its credible buckets only (a 1-of-2 day is not a trend)
  for (let i = 0; i < prev.length; i += 1) if (isRate && prev[i] !== null && (points[i].prev?.den ?? 0) < floor) prev[i] = null
  const top = vals.length ? Math.max(...vals) : 0
  const { ticks, hi: max } = niceTicks(0, top > 0 ? top * 1.06 : isRate ? 0.1 : 4, 4)
  const denMax = isRate ? Math.max(0, ...points.map((p) => p.den ?? 0)) : 0
  return { n: points.length, cur, sure, prev, lo, hi, min: 0, max, ticks, floor, denMax }
}

/** Resample a series onto `n` positions (linear on the normalised axis); a gap stays a gap. */
function resample(values: Array<number | null>, n: number): Array<number | null> {
  const m = values.length
  if (m === n) return values.slice()
  if (!m) return new Array(n).fill(null)
  return Array.from({ length: n }, (_, j) => {
    const t = n <= 1 ? 0 : (j / (n - 1)) * (m - 1)
    const a = Math.floor(t)
    const b = Math.min(m - 1, a + 1)
    const va = values[a]
    const vb = values[b]
    if (va === null || vb === null) return va ?? vb ?? null
    return va + (vb - va) * (t - a)
  })
}
const lerpSeries = (a: Array<number | null>, b: Array<number | null>, p: number) => b.map((v, i) => (v === null ? null : a[i] === null ? v : (a[i] as number) + (v - (a[i] as number)) * p))

/**
 * Rates: the trend runs through the CREDIBLE buckets (sample ≥ floor), bridged
 * across empty and small-sample days alike; a small-sample day stays a hollow
 * dot beside the line, so one 1-of-1 day can't yank the trend to 100%. When
 * fewer than two buckets are credible, every observed bucket carries it.
 */
function lineSegments(cur: Array<number | null>, sure: Array<number | null>, unit: Unit) {
  if (unit === 'rate' && sure.filter((v) => v !== null).length >= 2) return trendSegments(sure, sure)
  return trendSegments(cur, sure)
}

type Frame = { cur: Array<number | null>; sure: Array<number | null>; prev: Array<number | null>; lo: Array<number | null>; hi: Array<number | null>; max: number }

export function IntelTrend({
  points, unit, grain, tz, label, format, formatTick, height = 280, minSample, maturingFrom, events = [], showCompare = true,
  active, onActive, onPick, onEvent, tooltip = false, compareLabel, currentLabel = 'This period', loading, className, sampleLabel,
}: Props) {
  const reduced = useLcReducedMotion()
  const [width, setWidth] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    ro.current = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width || 0)
      setWidth((prev) => (Math.abs(prev - w) >= 1 ? w : prev))
    })
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])

  const geo = useMemo(() => trendGeometry(points, unit, showCompare, minSample), [points, unit, showCompare, minSample])
  const W = Math.max(240, width)
  // rates carry a sample strip under the time axis (its own small chart, never a second axis)
  const strip = unit === 'rate' && geo.denMax > 0 && geo.n > 1 ? 16 : 0
  const H = height + (strip ? strip + 10 : 0)
  const iw = W - M.l - M.r
  const ih = height - M.t - M.b
  const n = geo.n
  const x = useCallback((i: number) => M.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw), [n, iw])

  /* ── the imperative painter: paths + scale follow the animated frame ── */
  const curRef = useRef<SVGPathElement>(null)
  const allRef = useRef<SVGPathElement>(null)
  const bridgeRef = useRef<SVGPathElement>(null)
  const areaRef = useRef<SVGPathElement>(null)
  const prevRef = useRef<SVGPathElement>(null)
  const bandRef = useRef<SVGPathElement>(null)
  const gridRef = useRef<SVGGElement>(null)
  const tickRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<SVGCircleElement>(null)
  const shown = useRef<Frame | null>(null)

  const draw = useCallback((f: Frame) => {
    shown.current = f
    const y = (v: number) => M.t + ih - (clamp(v, 0, f.max) / (f.max || 1)) * ih
    const pt = (vals: Array<number | null>, i: number) => `${x(i).toFixed(1)},${y(vals[i] as number).toFixed(1)}`
    const runs = (vals: Array<number | null>, list: number[][]) => list.map((r) => `M${r.map((i) => pt(vals, i)).join('L')}`).join('')
    // the current series as one trend: solid where sure, thin under the floor, dashed across empty buckets
    const seg = lineSegments(f.cur, f.sure, unit)
    // the comparison is recessed: one quiet polyline through its observed buckets
    const prevObs = f.prev.flatMap((v, i) => (v === null ? [] : [i]))
    // the area under each continuous run of the current series (never across a gap)
    const area = (vals: Array<number | null>) => {
      let d = ''
      let run: number[] = []
      const flush = () => {
        if (run.length > 1) d += `M${x(run[0]).toFixed(1)},${(M.t + ih).toFixed(1)}${run.map((i) => `L${x(i).toFixed(1)},${y(vals[i] as number).toFixed(1)}`).join('')}L${x(run[run.length - 1]).toFixed(1)},${(M.t + ih).toFixed(1)}Z`
        run = []
      }
      vals.forEach((v, i) => { if (v === null) flush(); else run.push(i) })
      flush()
      return d
    }
    const band = () => {
      const up: string[] = []
      const down: string[] = []
      let d = ''
      const flush = () => { if (up.length > 1) d += `M${up.join('L')}L${down.reverse().join('L')}Z`; up.length = 0; down.length = 0 }
      f.hi.forEach((h, i) => {
        const l = f.lo[i]
        if (h === null || l === null) { flush(); return }
        up.push(`${x(i).toFixed(1)},${y(h).toFixed(1)}`)
        down.push(`${x(i).toFixed(1)},${y(l).toFixed(1)}`)
      })
      flush()
      return d
    }
    curRef.current?.setAttribute('d', runs(f.cur, seg.solid))
    allRef.current?.setAttribute('d', runs(f.cur, seg.thin))
    bridgeRef.current?.setAttribute('d', runs(f.cur, seg.bridge))
    areaRef.current?.setAttribute('d', unit === 'rate' ? '' : area(f.cur))
    prevRef.current?.setAttribute('d', prevObs.length > 1 ? runs(f.prev, [prevObs]) : '')
    bandRef.current?.setAttribute('d', unit === 'rate' ? band() : '')
    gridRef.current?.querySelectorAll<SVGLineElement>('line[data-v]').forEach((el) => {
      const yy = Math.round(y(Number(el.dataset.v))) + 0.5
      el.setAttribute('y1', String(yy)); el.setAttribute('y2', String(yy))
    })
    tickRef.current?.querySelectorAll<HTMLElement>('[data-v]').forEach((el) => { el.style.transform = `translateY(${y(Number(el.dataset.v)).toFixed(1)}px)` })
    let last = -1
    for (let i = f.cur.length - 1; i >= 0; i -= 1) if (f.cur[i] !== null) { last = i; break }
    if (endRef.current) {
      if (last >= 0) { endRef.current.setAttribute('cx', x(last).toFixed(1)); endRef.current.setAttribute('cy', y(f.cur[last] as number).toFixed(1)); endRef.current.style.opacity = '1' }
      else endRef.current.style.opacity = '0'
    }
  }, [ih, unit, x])

  // a new dataset morphs from what is on screen; reduced motion swaps
  useEffect(() => {
    const to: Frame = { cur: geo.cur, sure: geo.sure, prev: geo.prev, lo: geo.lo, hi: geo.hi, max: geo.max }
    const from = shown.current
    if (!from || reduced) { draw(to); return }
    const fr: Frame = { cur: resample(from.cur, geo.n), sure: resample(from.sure, geo.n), prev: resample(from.prev, geo.n), lo: resample(from.lo, geo.n), hi: resample(from.hi, geo.n), max: from.max }
    const controls = animate(0, 1, {
      duration: LC_DUR.morph,
      ease: lcEase('standard'),
      onUpdate: (p) => draw({ cur: lerpSeries(fr.cur, to.cur, p), sure: lerpSeries(fr.sure, to.sure, p), prev: lerpSeries(fr.prev, to.prev, p), lo: lerpSeries(fr.lo, to.lo, p), hi: lerpSeries(fr.hi, to.hi, p), max: fr.max + (to.max - fr.max) * p }),
      onComplete: () => draw(to),
    })
    return () => controls.stop()
    // draw changes with width: the resize path below re-projects without a morph
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, reduced])
  useLayoutEffect(() => { if (shown.current) draw(shown.current) }, [draw])

  /* ── scrubbing ── */
  const plot = useRef<HTMLDivElement>(null)
  const idx = active !== null && active < n ? active : null
  const pickAt = (clientX: number) => {
    const r = plot.current?.getBoundingClientRect()
    if (!r || n < 1) return null
    return clamp(Math.round(((clientX - r.left - M.l) / Math.max(1, iw)) * (n - 1)), 0, n - 1)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' && !e.buttons) return
    const i = pickAt(e.clientX)
    if (i !== idx) onActive(i)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return
    const page = Math.max(1, Math.round(n / 6))
    const from = idx ?? n
    const next = ({ ArrowLeft: from - 1, ArrowDown: from - 1, ArrowRight: idx === null ? n - 1 : from + 1, ArrowUp: idx === null ? n - 1 : from + 1, PageDown: from - page, PageUp: from + page, Home: 0, End: n - 1 } as Record<string, number>)[e.key]
    if (e.key === 'Escape' && idx !== null) { e.preventDefault(); e.stopPropagation(); onActive(null); return }
    if ((e.key === 'Enter' || e.key === ' ') && idx !== null && onPick) { e.preventDefault(); onPick(idx); return }
    if (next === undefined) return
    e.preventDefault()
    onActive(clamp(next, 0, n - 1))
  }

  const y = (v: number) => M.t + ih - (clamp(v, 0, geo.max) / (geo.max || 1)) * ih
  const hp = idx !== null ? points[idx] : null
  const labels = labelIndices(n, iw, grain === 'hour' ? 54 : 74)
  const isRate = unit === 'rate'
  const thinFloor = minSample ? Math.min(10, minSample) : 0
  const matIdx = maturingFrom ? points.findIndex((p) => p.start >= maturingFrom) : -1
  const segs = useMemo(() => lineSegments(geo.cur, geo.sure, unit), [geo, unit])
  const prevLone = useMemo(() => trendSegments(geo.prev).lone, [geo])
  // the maturing tail keeps the line but wears its own (receding) ink: a hard stop in the stroke
  const gid = `ixt-mat-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const matStop = matIdx > 0 ? clamp((x(matIdx - 0.5) - M.l) / Math.max(1, iw), 0, 1) : matIdx === 0 ? 0 : null
  const inkStyle = matStop !== null ? { stroke: `url(#${gid})` } : undefined
  const start = points[0]?.start ?? 0
  const end = points.length ? points[points.length - 1].end : 0
  const ex = (t: number) => M.l + ((t - start) / Math.max(1, end - start)) * iw
  const pins = events.filter((e) => { const t = Date.parse(e.at); return t >= start && t < end })
  // pins closer than a pin's width are one pin that opens them all
  const pinGroups: Array<{ px: number; first: number; last: number; events: IntelEvent[] }> = []
  for (const p of pins.map((e) => ({ e, px: ex(Date.parse(e.at)) })).sort((a, b) => a.px - b.px)) {
    const g = pinGroups[pinGroups.length - 1]
    if (g && p.px - g.last <= 14) { g.events.push(p.e); g.last = p.px; g.px = (g.first + p.px) / 2 }
    else pinGroups.push({ px: p.px, first: p.px, last: p.px, events: [p.e] })
  }
  const groupTone = (list: IntelEvent[]) => (list.some((e) => e.tone === 'crit') ? 'crit' : list.some((e) => e.tone === 'attn') ? 'attn' : list[0]?.tone || 'neutral')
  const stripTop = M.t + ih + M.b + 6
  const bw = clamp((iw / Math.max(1, n)) * 0.6, 1.5, 12)
  const valueText = hp ? `${fmtBucket(hp.start, grain, tz, true)}: ${hp.value === null && isRate ? `no ${sampleLabel || 'sample'}, no rate` : format(hp.value)}${hp.prev ? `, previous period ${format(hp.prev.value)}` : ''}` : `${label}. ${n} ${grain} buckets.`
  const last = [...points].reverse().find((p) => p.value !== null) || null
  const summary = `${label}, ${n} ${grain} buckets${last ? `, latest ${format(last.value)}` : ''}${pins.length ? `, ${pins.length} marked event${pins.length === 1 ? '' : 's'}` : ''}.`
  const tipLeft = idx !== null ? clamp(x(idx) + 14, 4, W - 212) : 0
  // a bucket without a value says why (and that the dashed connector across it is not a value)
  const emptyNote = idx !== null && hp && hp.value === null
    ? `${isRate ? `No ${sampleLabel || 'sample'} that ${grain}` : `Nothing recorded that ${grain}`}${segs.bridged.has(idx) ? ' — the dashed line only connects the days either side' : ''}`
    : null

  return (
    <div className={['ixt', className, loading && 'is-loading'].filter(Boolean).join(' ')} ref={measure}>
      <div
        ref={plot}
        className="ixt__plot"
        style={{ height: H }}
        role="slider"
        tabIndex={n ? 0 : -1}
        aria-label={`${label}, explore by ${grain}`}
        aria-valuemin={1}
        aria-valuemax={Math.max(1, n)}
        aria-valuenow={(idx ?? n - 1) + 1}
        aria-valuetext={valueText}
        onPointerMove={onPointerMove}
        onPointerDown={(e) => { const i = pickAt(e.clientX); if (i !== null) onActive(i) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') onActive(null) }}
        onClick={() => { if (idx !== null && onPick) onPick(idx) }}
        onKeyDown={onKeyDown}
        onBlur={() => onActive(null)}
      >
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="ixt__svg" style={{ width: W, height: H }}>
          {matIdx >= 0 ? (
            <g className="ixt__maturing">
              <rect x={x(Math.max(0, matIdx - 0.5))} y={M.t} width={Math.max(0, M.l + iw - x(Math.max(0, matIdx - 0.5)))} height={ih} />
              <text x={M.l + iw - 4} y={M.t + 12} textAnchor="end">maturing</text>
            </g>
          ) : null}
          <g ref={gridRef} className="ixt__grid">
            {geo.ticks.slice(1).map((t) => <line key={t} data-v={t} x1={M.l} x2={M.l + iw} />)}
            <line className="ixt__base" x1={M.l} x2={M.l + iw} y1={M.t + ih + 0.5} y2={M.t + ih + 0.5} />
          </g>
          <path ref={bandRef} className="ixt__band" />
          <path ref={areaRef} className="ixt__area" />
          {matStop !== null ? (
            <defs>
              <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={M.l} x2={M.l + iw} y1={0} y2={0}>
                <stop offset={0} className="ixt__ink" />
                <stop offset={matStop} className="ixt__ink" />
                <stop offset={matStop} className="ixt__ink is-maturing" />
                <stop offset={1} className="ixt__ink is-maturing" />
              </linearGradient>
            </defs>
          ) : null}
          <path ref={prevRef} className="ixt__prev" />
          <path ref={bridgeRef} className="ixt__line is-bridge" style={inkStyle} />
          <path ref={allRef} className="ixt__line is-all" style={inkStyle} />
          <path ref={curRef} className="ixt__line" style={inkStyle} />
          {n <= 400 ? segs.lone.map((i) => (geo.cur[i] !== null && (geo.cur[i] as number) <= geo.max
            ? <circle key={`lone-${points[i]?.start ?? i}`} className={matIdx >= 0 && i >= matIdx ? 'ixt__lone is-maturing' : 'ixt__lone'} cx={x(i)} cy={y(geo.cur[i] as number)} r={2.75} />
            : null)) : null}
          {isRate && n <= 400 ? segs.lone.map((i) => (geo.lo[i] !== null && geo.hi[i] !== null
            ? <line key={`w-${points[i]?.start ?? i}`} className="ixt__whisker" x1={x(i)} x2={x(i)} y1={y(geo.hi[i] as number)} y2={y(geo.lo[i] as number)} />
            : null)) : null}
          {showCompare && n <= 400 ? prevLone.map((i) => (geo.prev[i] !== null ? <circle key={`pl-${points[i]?.start ?? i}`} className="ixt__prevdot" cx={x(i)} cy={y(geo.prev[i] as number)} r={2.25} /> : null)) : null}
          {isRate && n <= 120 ? points.map((p, i) => (p.value !== null && (((p.den ?? 0) > 0 && (p.den ?? 0) < geo.floor) || p.value > geo.max)
            ? <circle key={p.start} className={p.value > geo.max ? 'ixt__thin is-clipped' : 'ixt__thin'} cx={x(i)} cy={y(p.value)} r={3} />
            : null)) : null}
          <circle ref={endRef} className="ixt__end" r={4} />
          {pinGroups.map((g) => (
            <line key={`l-${g.events[0].id}`} className="ixt__pinline" data-tone={groupTone(g.events)} x1={g.px} x2={g.px} y1={M.t - 6} y2={M.t + ih} />
          ))}
          {strip ? (
            <g className="ixt__strip">
              {points.map((p, i) => {
                const d = p.den ?? 0
                if (d <= 0) return null
                const h = Math.max(1.5, (d / geo.denMax) * strip)
                return <rect key={p.start} className={d < geo.floor ? 'is-thin' : undefined} x={x(i) - bw / 2} y={stripTop + strip - h} width={bw} height={h} rx={1} />
              })}
              <line className="ixt__stripbase" x1={M.l} x2={M.l + iw} y1={stripTop + strip + 0.5} y2={stripTop + strip + 0.5} />
              {idx !== null ? <line className="ixt__stripcross" x1={x(idx)} x2={x(idx)} y1={stripTop - 2} y2={stripTop + strip} /> : null}
            </g>
          ) : null}
          {idx !== null ? (
            <g className="ixt__cross">
              <line x1={x(idx)} x2={x(idx)} y1={M.t - 4} y2={M.t + ih} />
              {hp?.prev && hp.prev.value !== null ? <circle className="ixt__dot is-prev" cx={x(idx)} cy={y(hp.prev.value)} r={3.5} /> : null}
              {hp && hp.value !== null ? <circle className="ixt__dot" cx={x(idx)} cy={y(hp.value)} r={5} /> : null}
            </g>
          ) : null}
        </svg>
        <div ref={tickRef} className="ixt__ticks" style={{ left: M.l + iw + 8 }} aria-hidden="true">
          {geo.ticks.map((t) => <span key={t} data-v={t}>{formatTick(t)}</span>)}
        </div>
        <div className="ixt__axis" style={{ top: M.t + ih + 9 }} aria-hidden="true">
          {labels.map((i) => (
            <span key={points[i]?.start ?? i} style={{ left: x(i), transform: `translateX(${i === 0 ? 0 : i === n - 1 ? -100 : -50}%)` }}>{points[i] ? fmtBucket(points[i].start, grain, tz) : ''}</span>
          ))}
        </div>
        {pinGroups.map((g) => {
          const e = g.events[0]
          const many = g.events.length > 1
          return (
            <button
              key={e.id}
              type="button"
              className={['ixt__pin', many && 'is-many'].filter(Boolean).join(' ')}
              data-tone={groupTone(g.events)}
              style={{ left: g.px }}
              onClick={(ev) => { ev.stopPropagation(); onEvent?.(e, many ? g.events : undefined) }}
              onPointerMove={(ev) => ev.stopPropagation()}
              onPointerDown={(ev) => ev.stopPropagation()}
              aria-label={many ? `${g.events.length} events: ${g.events.map((x) => x.title).join('; ')}` : `${e.title}: ${e.subject}, ${new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
              title={many ? g.events.map((x) => `${x.title} · ${x.subject}`).join('\n') : `${e.title} · ${e.subject}`}
            >
              <i aria-hidden="true" />
              {many ? <em aria-hidden="true">{g.events.length}</em> : null}
            </button>
          )
        })}
        {strip ? (
          <span className="ixt__nkey" style={{ left: M.l + iw + 8, top: stripTop - 1 }} title={`${sampleLabel || 'sample'} per ${grain} — the tallest bar`} aria-hidden="true">n {geo.denMax >= 10_000 ? `${Math.round(geo.denMax / 1000)}K` : geo.denMax}</span>
        ) : null}
        {tooltip && hp ? (
          <div className="ixt__tip" style={{ left: tipLeft }} role="status">
            <b>{fmtBucket(hp.start, grain, tz, true)}{matIdx >= 0 && idx !== null && idx >= matIdx ? <em> · maturing</em> : null}</b>
            <span><i className="ixt__key" />{currentLabel}<strong>{format(hp.value)}</strong></span>
            {emptyNote ? <small>{emptyNote}</small> : isRate && hp.den !== undefined ? <small>{hp.num ?? 0} / {hp.den}{hp.den > 0 && hp.den < thinFloor ? ' · small sample' : ''}</small> : null}
            {hp.prev ? <span className="is-prev"><i className="ixt__key is-prev" />{compareLabel || 'Previous'}<strong>{format(hp.prev.value)}</strong></span> : null}
          </div>
        ) : null}
      </div>
      <p className="ix-sr">{summary}</p>
    </div>
  )
}

/** The table twin (WCAG-clean equivalent of the chart). */
export function IntelTrendTable({ points, grain, tz, format, unit }: { points: TrendPoint[]; grain: string; tz: string; format: (v: number | null) => string; unit: Unit }) {
  return (
    <div className="ix-tablewrap lc-scroll">
      <table className="ix-table">
        <thead><tr><th>{grain === 'hour' ? 'Hour' : grain === 'week' ? 'Week' : grain === 'month' ? 'Month' : 'Day'}</th><th>Value</th>{unit === 'rate' ? <><th>Num</th><th>Den</th><th>95% interval</th></> : <th>n</th>}<th>Previous period</th></tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.start}>
              <th>{fmtBucket(p.start, grain, tz, true)}</th>
              <td>{format(p.value)}</td>
              {unit === 'rate' ? <><td>{p.num ?? '—'}</td><td>{p.den ?? '—'}</td><td>{p.ci ? `${format(p.ci.low)} – ${format(p.ci.high)}` : '—'}</td></> : <td>{p.n ?? '—'}</td>}
              <td>{p.prev ? format(p.prev.value) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Columns for counts: precise per-bucket comparison; heights glide (CSS) on a new dataset. */
export function IntelColumns({ points, grain, tz, format, height = 240, active, onActive, onPick, label }: {
  points: TrendPoint[]; grain: string; tz: string; format: (v: number | null) => string; height?: number
  active: number | null; onActive: (i: number | null) => void; onPick?: (i: number) => void; label: string
}) {
  const max = Math.max(1, ...points.map((p) => Math.max(p.value ?? 0, p.prev?.value ?? 0)))
  const { ticks, hi } = niceTicks(0, max * 1.06, 4)
  const n = points.length
  return (
    <div className="ixc" style={{ height }} role="group" aria-label={label}>
      <div className="ixc__grid" aria-hidden="true">{ticks.slice(1).map((t) => <i key={t} style={{ bottom: `${(t / hi) * 100}%` }}><em>{format(t)}</em></i>)}</div>
      <div className="ixc__cols" onPointerLeave={() => onActive(null)}>
        {points.map((p, i) => (
          <button
            key={p.start}
            type="button"
            className={['ixc__col', active === i && 'is-on'].filter(Boolean).join(' ')}
            onPointerEnter={() => onActive(i)}
            onFocus={() => onActive(i)}
            onClick={() => onPick?.(i)}
            aria-label={`${fmtBucket(p.start, grain, tz, true)}: ${format(p.value)}${p.prev ? `, previous ${format(p.prev.value)}` : ''}`}
          >
            {p.prev && p.prev.value !== null ? <i className="ixc__prev" style={{ transform: `scaleY(${(p.prev.value || 0) / hi})` }} /> : null}
            <i className="ixc__bar" style={{ transform: `scaleY(${(p.value || 0) / hi})` }} />
            {n <= 16 || i === n - 1 || i === 0 ? <span className="ixc__lab">{fmtBucket(p.start, grain, tz)}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
