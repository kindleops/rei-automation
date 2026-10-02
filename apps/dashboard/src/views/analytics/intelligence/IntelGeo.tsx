/**
 * GEOGRAPHIC INTELLIGENCE — a KPI heat map with drill-down, not navigation.
 *
 *   Nation → State → County → City → ZIP
 *
 * Any of the Lab's metrics that resolve to geography colours the map
 * (sellers reached, replied, reply rate, interested, opportunities, sent,
 * delivered, delivery rate, opt-out rate, …). Every click is a breadcrumb the
 * WHOLE Lab re-reads through (chip: "County · Hennepin, MN"), exactly like the
 * funnel drill; the period, filters and comparison are the Lab's own.
 *
 * Honesty layer:
 *   · aggregation is server-side and bounded (the Lab's breakdown: one row per
 *     area, ≤ 400) — no raw rows reach the browser
 *   · state and county are true Census polygons; ZIPs are US Census ZCTA
 *     outlines when the Lab can read them (/boundaries → the owner-approved
 *     analytics_zip_boundaries function), otherwise — and for any ZIP without
 *     an outline — drawn at the centre of their own properties; cities have
 *     no boundary source at all. The key always says which (intel-atlas.ts)
 *   · a rate under the registry's min_sample is HATCHED and never sets the
 *     scale; an area with no activity is quiet, not zero-coloured
 *   · counts shade on a square-root scale (labelled), rates linearly from 0
 *   · unplaced activity is counted beside the map, never assigned
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, KeyboardEvent } from 'react'
import { animate } from 'framer-motion'
import type { BreakdownRow, LabQuery, LabRecords, MetricDef } from '../../../domain/analytics/analytics-lab-api'
import { fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { LCSegmented, LCSelect, LC_DUR, cx, lcEase, useLcReducedMotion } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { callBackend } from '../../../lib/api/backendClient'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { fmtThrough, useBuyerWindow } from './intel-hooks'
import { project, stateLabel } from './intel-geo'
import { ATLAS_CHILD, FRAME, GEO_SEGMENT_DIMS, LEVEL_NOUN, atlasLevel, dodge, frameBox, heatClass, heatOf, loadCounties, loadStates, matchCounty, unionBox, zipOutlineLayer } from './intel-atlas'
import type { AreaShape, Box, GeoLevel, StateShape, ZipOutlines } from './intel-atlas'
import { fmtInt, seqColor } from './intel-format'
import { serverContext } from './intel-state'
import { RankedBars } from './IntelCharts'

type Row = BreakdownRow & { centroid?: { lat: number; lng: number; n: number } }
const FAMILY_ORDER = ['communication', 'delivery', 'pipeline', 'automation']
const familyRank = (f: string) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? 99 : i }
const isGeoMetric = (d: MetricDef | undefined) => Boolean(d && d.dimensions.includes('state') && d.dimensions.includes('county'))
const isNamed = (r: Row) => r.key !== '__unresolved' && r.key !== '__none'
const STEPS = 6

/** Lazily loaded geometry, keyed so a stale load never paints the wrong state. */
function useShapes<T>(key: string | null, load: (k: string) => Promise<T>): T | null {
  const [got, setGot] = useState<{ key: string; v: T } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    load(key).then((v) => { if (live) setGot({ key, v }) }).catch(() => {})
    return () => { live = false }
  }, [key, load])
  return got && got.key === key ? got.v : null
}

export function IntelGeo({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, act, defs, inspect, records, refreshing } = useLab()
  const reduced = useLcReducedMotion()
  const [own, setOwn] = useState<string | null>(null)
  const m = own && isGeoMetric(defs[own]) ? own : isGeoMetric(defs[ctx.metric]) ? ctx.metric : 'reply_rate'
  const def = defs[m]
  const unit = def?.unit || 'count'
  const isRate = unit === 'rate'
  const minSample = def?.min_sample || null
  const [buyersOn, setBuyersOn] = useState(false)

  /* ── where we are in the drill ── */
  const geo = ctx.segment.filter((s) => (GEO_SEGMENT_DIMS as readonly string[]).includes(s.dim))
  const deepest = geo[geo.length - 1] || null
  const level: GeoLevel = atlasLevel(ctx.segment)
  const child = ATLAS_CHILD[level]
  const step = (dim: string) => ctx.segment.find((s) => s.dim === dim) || null
  const countyStep = step('county')
  const cityStep = step('city')
  const zipStep = step('zip')
  const keyState = (v: unknown) => { const p = String(v ?? '').split('|'); return p.length > 1 ? p[p.length - 1].toUpperCase() : null }
  const focusState = (step('state')?.value ? String(step('state')?.value).toUpperCase() : null) || keyState(countyStep?.value) || keyState(cityStep?.value)

  /* ── the numbers: one bounded server breakdown per level ── */
  const mapDim = child || 'zip'
  // on a ZIP the map shows its sibling ZIPs (the selected one lit), so the step still has a context
  const mapSegment = child ? ctx.segment : ctx.segment.filter((s) => s.dim !== 'zip')
  const mapQ = useIntel<LabQuery>(paths.query({ ...serverContext(ctx, { metric: m, groupBy: null, segment: mapSegment }), groupBy: mapDim, limit: mapDim === 'state' ? 60 : mapDim === 'zip' ? 400 : 300 }, 'breakdown'))
  const rows = useMemo(() => ((mapQ.data?.result?.rows || []) as Row[]), [mapQ.data])
  const named = useMemo(() => rows.filter(isNamed).map((r) => (mapDim === 'state' ? { ...r, label: stateLabel(r.key) } : r)), [rows, mapDim])
  const unresolved = rows.find((r) => r.key === '__unresolved') || null
  const bw = useBuyerWindow(ctx, buyersOn)
  const buyers = bw.shown

  /* ── geometry ── */
  const states = useShapes<StateShape[]>('us', loadStates as (k: string) => Promise<StateShape[]>)
  const counties = useShapes<AreaShape[]>(level !== 'nation' && focusState ? focusState : null, loadCounties)

  const countTotal = unit === 'count' ? named.reduce((a, r) => a + (r.value ?? 0), 0) : 0
  const peak = useMemo(() => Math.max(0, ...named.filter((r) => !(isRate && r.insufficient)).map((r) => r.value ?? 0)), [named, isRate])
  const heat = (r: Row | null | undefined) => (r ? heatOf(r.value, peak, unit) : null)
  const fill = (r: Row | null | undefined) => {
    const t = heat(r)
    if (t === null || (isRate && r?.insufficient)) return undefined
    return seqColor(0.1 + 0.9 * heatClass(t, STEPS))
  }

  // ZIP outlines (US Census ZCTA) when the Lab can read them; centre marks otherwise
  const zipShown = mapDim === 'zip'
  const zipKeys = useMemo(() => (zipShown ? named.map((r) => r.key).filter((k) => /^[0-9]{5}$/.test(k)).slice(0, 400) : []), [zipShown, named])
  const outlineQ = useIntel<ZipOutlines>(zipKeys.length ? paths.boundaries(zipKeys) : null, 10 * 60_000)
  // an answer for another ZIP set (held while the next loads) is not this set's outlines
  const outlines = outlineQ.stale ? null : outlineQ.data
  const zipLayer = useMemo(() => (zipShown ? zipOutlineLayer(named, outlines, project) : null), [zipShown, named, outlines])

  // the areas on show, each tied to its row
  const areas = useMemo(() => {
    const out: Array<{ key: string; label: string; d: string; at: [number, number]; box: [number, number, number, number]; row: Row | null }> = []
    if (level === 'nation' && states) {
      const byKey = new Map(named.map((r) => [String(r.key).toUpperCase(), r]))
      for (const s of states) out.push({ key: s.abbr, label: s.name, d: s.d, at: s.at, box: s.box, row: byKey.get(s.abbr) || null })
    } else if (level === 'state' && counties) {
      const byShape = new Map<string, Row>()
      for (const r of named) {
        const xy = r.centroid ? project(r.centroid.lng, r.centroid.lat) : null
        const shape = matchCounty(r.key, counties, xy)
        if (shape && !byShape.has(shape.id)) byShape.set(shape.id, r)
      }
      for (const c of counties) { const r = byShape.get(c.id) || null; out.push({ key: r?.key || `fips:${c.id}`, label: r?.label || c.name, d: c.d, at: c.at, box: c.box, row: r }) }
    } else if (zipLayer) {
      for (const a of zipLayer.areas) out.push({ key: a.row.key, label: a.row.label, d: a.d, at: a.at, box: a.box, row: a.row })
    }
    return out
  }, [level, states, counties, named, zipLayer])
  const drawnKeys = new Set(areas.filter((a) => a.row).map((a) => a.row?.key))
  const notDrawn = level === 'state' && counties ? named.filter((r) => !drawnKeys.has(r.key)).length : 0

  // the selected county's polygon (county / city / ZIP levels)
  const countyShape = useMemo(() => {
    if (!counties || !countyStep?.value) return null
    return matchCounty(String(countyStep.value), counties)
  }, [counties, countyStep?.value])

  // cities (no boundary source) and ZIPs without an outline → the centre of their own properties
  const points = useMemo(() => {
    if (level === 'nation' || level === 'state') return []
    const base = Math.max(1, ...named.map((r) => (isRate ? r.den ?? r.n : r.n)))
    return (zipLayer ? zipLayer.rest : named).map((r) => {
      const xy = r.centroid ? project(r.centroid.lng, r.centroid.lat) : null
      return xy ? { row: r, x: xy[0], y: xy[1], w: Math.sqrt(Math.max(1, isRate ? r.den ?? r.n : r.n) / base) } : null
    }).filter(Boolean) as Array<{ row: Row; x: number; y: number; w: number }>
  }, [level, named, isRate, zipLayer])
  const unplaced = level === 'nation' || level === 'state' ? 0 : named.length - points.length - areas.length

  /* ── the camera ── */
  const target: Box = useMemo(() => {
    if (level === 'nation') return { x: 0, y: 0, w: FRAME.width, h: FRAME.height }
    const st = states?.find((s) => s.abbr === focusState) || null
    const stBox = st ? frameBox(unionBox([st.box]), 0.06) : null
    if (level === 'state') return stBox || frameBox(null)
    if (level === 'county') return countyShape ? frameBox(unionBox([countyShape.box]), 0.12) : points.length ? frameBox(unionBox(points.map((p) => [p.x, p.y, p.x, p.y])), 0.3, 18) : stBox || frameBox(null)
    // city and ZIP share one frame (the ZIPs of the city: outlines and centre marks), so selecting a ZIP never jumps
    const zipBoxes = [...areas.map((a) => a.box), ...points.map((p) => [p.x, p.y, p.x, p.y] as [number, number, number, number])]
    if (zipBoxes.length) return frameBox(unionBox(zipBoxes), areas.length ? 0.1 : 0.45, 3.5)
    return countyShape ? frameBox(unionBox([countyShape.box]), 0.12) : stBox || frameBox(null)
  }, [level, states, focusState, countyShape, points, areas])

  const svg = useRef<SVGSVGElement | null>(null)
  const shown = useRef<Box | null>(null)
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const set = (b: Box) => { shown.current = b; el.setAttribute('viewBox', `${b.x.toFixed(2)} ${b.y.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)}`) }
    const from = shown.current
    if (!from || reduced) { set(target); return }
    const controls = animate(0, 1, {
      duration: LC_DUR.morph,
      ease: lcEase('standard'),
      onUpdate: (p) => set({ x: from.x + (target.x - from.x) * p, y: from.y + (target.y - from.y) * p, w: from.w + (target.w - from.w) * p, h: from.h + (target.h - from.h) * p }),
      onComplete: () => set(target),
    })
    return () => controls.stop()
  }, [target, reduced])

  // a pixel in viewBox units at the target zoom (marks and labels keep their on-screen size)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const stageW = stage.w
  const ro = useRef<ResizeObserver | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el
    ro.current?.disconnect()
    if (!el) return
    ro.current = new ResizeObserver((e) => {
      const w = Math.round(e[0]?.contentRect.width || 0)
      const h = Math.round(e[0]?.contentRect.height || 0)
      setStage((p) => (Math.abs(p.w - w) >= 2 || Math.abs(p.h - h) >= 2 ? { w, h } : p))
    })
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])
  const px = target.w / Math.max(320, stageW || 720)
  // centre marks sized in screen pixels, pushed apart so neighbours never hide each other
  const marks = useMemo(() => dodge(points.map((p) => ({ ...p, r: (5 + 13 * p.w) * px })), 2 * px), [points, px])

  /* ── interaction ── */
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null)
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const areaByKey = useMemo(() => new Map(areas.map((a) => [a.key, a])), [areas])
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const t = (e.target as Element).closest?.('[data-k]') as HTMLElement | SVGElement | null
    const b = stageRef.current?.getBoundingClientRect()
    if (!t || !b) { if (hover) setHover(null); return }
    setHover({ key: t.getAttribute('data-k') || '', x: e.clientX - b.left, y: e.clientY - b.top })
  }
  const labelFor = (key: string) => {
    const r = rowByKey.get(key)
    if (mapDim === 'state') return stateLabel(key)
    return r?.label || areaByKey.get(key)?.label || key
  }
  const drill = (key: string) => {
    const r = rowByKey.get(key)
    if (!r || !isNamed(r) || r.test) return
    if (!child) return // a ZIP is the deepest step: its siblings are context, not a drill
    act.pushSegment({ dim: mapDim, value: r.key, label: mapDim === 'state' ? stateLabel(r.key) : r.label })
  }
  const onKey = (e: KeyboardEvent<SVGElement>, key: string) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill(key) } }

  const hoverRow = hover ? rowByKey.get(hover.key) || null : null
  const hoverArea = hover ? areaByKey.get(hover.key) || null : null
  const format = (v: number | null) => fmtMetric(def, v)
  const through = bw.through ? fmtThrough(bw.through) : null
  const buyerWindow = bw.window === 'latest' && bw.start && bw.end ? `${new Date(bw.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${through}` : null
  const buyerRings = buyersOn ? (buyers?.markets || []).map((b) => {
    const xy = b.centroid ? project(b.centroid.lng, b.centroid.lat) : null
    return xy ? { key: b.key, label: b.label, cur: b.cur, x: xy[0], y: xy[1] } : null
  }).filter(Boolean) as Array<{ key: string; label: string; cur: number; x: number; y: number }> : []
  const buyerPeak = Math.max(1, ...buyerRings.map((b) => b.cur))

  // Open in Map: the exact sellers reached in this slice (≤ 5,000 places), as a focus set
  const [mapping, setMapping] = useState(false)
  const openInMap = async () => {
    setMapping(true)
    try {
      const res = await callBackend<{ ok: boolean; data: LabRecords }>(paths.records(serverContext(ctx, { metric: 'sellers_reached', groupBy: null }), { metric: 'sellers_reached', part: 'numerator' }, 1, 10, null, 'desc'), { timeoutMs: 120_000 })
      const pts = res.ok && res.data?.ok ? res.data.data.handoff.points : []
      const where = deepest ? deepest.label || deepest.value : 'all markets'
      writeMapFocusSet({ label: `Analytics · sellers reached · ${where}`, tone: 'property', points: pts.map((p) => ({ lat: p.lat, lng: p.lng, id: p.id, label: p.label ?? null })) })
      pushRoutePath('/map')
    } finally { setMapping(false) }
  }

  const crumbs: Array<{ label: string; depth: number }> = [{ label: 'Nation', depth: -1 }]
  geo.forEach((g) => crumbs.push({ label: g.label || (g.dim === 'state' ? stateLabel(String(g.value)) : String(g.value)), depth: ctx.segment.indexOf(g) + 1 }))
  const clearGeo = () => act.set((x) => ({ segment: x.segment.filter((s) => !(GEO_SEGMENT_DIMS as readonly string[]).includes(s.dim)) }))

  const metricOptions = useMemo(() => Object.values(defs)
    .filter(isGeoMetric)
    .sort((a, b) => familyRank(a.family) - familyRank(b.family))
    .map((d) => ({ value: d.id, label: d.label, group: d.family ? d.family[0].toUpperCase() + d.family.slice(1) : undefined, hint: d.unit === 'rate' ? `rate · needs n ≥ ${d.min_sample ?? '—'}` : d.unit === 'count' ? 'count' : d.unit === 'duration_min' ? 'median time' : 'ratio' })), [defs])

  const levelNote = level === 'nation' || level === 'state'
    ? `${level === 'nation' ? 'States' : 'Counties'}: US Census boundaries`
    : zipLayer
      ? zipLayer.note
      : `${LEVEL_NOUN[mapDim]} have no boundary source — drawn at the centre of their properties`
  const sampleLabel = def?.denominator?.label || 'base'
  const delta = (r: Row) => {
    const p = r.prev?.value
    if (p === null || p === undefined || r.value === null) return null
    const d = r.value - p
    return isRate ? `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} pts` : unit === 'count' ? `${d >= 0 ? '+' : '−'}${fmtInt(Math.abs(d))}` : `${d >= 0 ? '+' : '−'}${format(Math.abs(d))}`
  }
  // name the areas that carry the most of the base — a few, never overlapping, so the map stays a map
  const fontV = 10.5 * px
  const labels = useMemo(() => {
    const cands = (level === 'nation' || level === 'state')
      ? areas.filter((a) => a.row).map((a) => (level === 'nation'
        ? { key: a.key, row: a.row as Row, x: a.at[0], y: a.at[1], text: a.key, side: false }
        // a county is small at state zoom: its name sits beside it, never over its colour
        : { key: a.key, row: a.row as Row, x: a.box[2] + 4 * px, y: a.at[1], text: (a.row?.label || a.label).replace(/, [A-Z]{2}$/, ''), side: true }))
      : [
          ...areas.filter((a) => a.row).map((a) => ({ key: a.key, row: a.row as Row, x: a.at[0], y: a.at[1], text: a.key, side: false })),
          ...marks.map((p) => ({ key: p.row.key, row: p.row, x: p.x, y: p.y - p.r - 7 * px, text: p.row.label.replace(/, [A-Z]{2}$/, ''), side: false })),
        ]
    const placed: Array<{ key: string; x: number; y: number; text: string; side: boolean; box: [number, number, number, number] }> = []
    for (const c of cands.sort((a, b) => (b.row.den ?? b.row.n ?? 0) - (a.row.den ?? a.row.n ?? 0))) {
      if (placed.length >= (level === 'nation' ? 14 : 8)) break
      const w = c.text.length * fontV * 0.62 + fontV * 0.6
      const h = fontV * 1.35
      const box: [number, number, number, number] = c.side ? [c.x, c.y - h / 2, c.x + w, c.y + h / 2] : [c.x - w / 2, c.y - h / 2, c.x + w / 2, c.y + h / 2]
      if (placed.some((p) => box[0] < p.box[2] && box[2] > p.box[0] && box[1] < p.box[3] && box[3] > p.box[1])) continue
      placed.push({ key: c.key, x: c.x, y: c.y, text: c.text, side: c.side, box })
    }
    return placed
  }, [level, areas, marks, px, fontV])
  const hatchId = `ixg-hatch-${variant}`
  const loading = (mapQ.loading && !mapQ.data) || !states || (level !== 'nation' && Boolean(focusState) && !counties)

  return (
    <section className={cx('ix-geo lc-plane is-solid is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Geographic heat map">
      <header className="ix-plane__head ix-geo__head">
        <div>
          <span className="ix-eyebrow">Geography · heat map</span>
          <nav className="ix-geo__crumbs" aria-label="Geographic drill">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`}>
                {i > 0 ? <Icon name="chevron-right" size={11} /> : null}
                <button type="button" onClick={() => (i === 0 ? clearGeo() : act.popSegmentTo(c.depth))} disabled={i === crumbs.length - 1} className={cx(i === crumbs.length - 1 && 'is-here')}>{c.label}</button>
              </span>
            ))}
          </nav>
        </div>
        <div className="ix-geo__ctl">
          <LCSelect label="Colour the map by" prefix="Heat" variant="quiet" size="sm" value={m} onChange={(v) => setOwn(v)} options={metricOptions} menuWidth={300} />
          <LCSegmented label="Second layer" size="sm" value={buyersOn ? 'buyers' : 'none'} onChange={(v) => setBuyersOn(v === 'buyers')} options={[{ value: 'none', label: 'Sellers' }, { value: 'buyers', label: '+ Buyers' }]} />
        </div>
      </header>
      <div className="ix-geo__body">
        <div className="ix-geo__mapcol">
        <div ref={measure} className={cx('ix-geo__stage', `is-${level}`)} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg ref={svg} className="ix-geo__svg" style={{ width: '100%', height: 'auto', aspectRatio: `${FRAME.width} / ${FRAME.height}` }} viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`${def?.label || m} by ${(LEVEL_NOUN[mapDim] || 'area').toLowerCase()}`}>
            <defs>
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width={6 * px} height={6 * px} patternTransform="rotate(45)">
                <rect width={6 * px} height={6 * px} className="ix-geo__hatchbg" />
                <line x1={0} y1={0} x2={0} y2={6 * px} className="ix-geo__hatch" style={{ strokeWidth: 1.6 * px }} />
              </pattern>
            </defs>
            {/* the country: quiet land under everything (and the neighbours of an open state) */}
            {states && level !== 'nation' ? states.map((s) => <path key={`land-${s.abbr}`} d={s.d} className={cx('ix-geo__land', s.abbr === focusState && 'is-focus')} vectorEffect="non-scaling-stroke" />) : null}
            {/* county and below: the state's counties as context, the open county outlined */}
            {level !== 'nation' && level !== 'state' && counties ? counties.map((c) => <path key={`c-${c.id}`} d={c.d} className={cx('ix-geo__ctx', countyShape?.id === c.id && 'is-focus')} vectorEffect="non-scaling-stroke" />) : null}
            {/* choropleth areas: states (nation), counties (state) or ZIP outlines (city / ZIP) */}
            {areas.map((a) => {
              const r = a.row
              const thin = Boolean(r && isRate && r.insufficient)
              const f = fill(r)
              const lit = hover?.key === a.key
              const can = Boolean(r && isNamed(r) && !r.test && child)
              return (
                <path
                  key={a.key} d={a.d} data-k={a.key}
                  className={cx('ix-geo__area', !r && 'is-empty', thin && 'is-thin', lit && 'is-on', can && 'is-drill', Boolean(f) && level === 'state' && 'is-hot', level === 'zip' && (String(zipStep?.value) === a.key ? 'is-sel' : 'is-sib'))}
                  style={f ? { fill: f } : thin ? { fill: `url(#${hatchId})` } : undefined}
                  vectorEffect="non-scaling-stroke"
                  tabIndex={can ? 0 : undefined} role={can ? 'button' : undefined}
                  aria-label={r ? `${labelFor(a.key)}: ${format(r.value)}${isRate ? `, ${fmtInt(r.num)} of ${fmtInt(r.den)}` : ''}${thin ? ', small sample' : ''}` : undefined}
                  onClick={() => drill(a.key)} onKeyDown={(e) => onKey(e, a.key)}
                  onFocus={() => setHover({ key: a.key, x: 24, y: 24 })} onBlur={() => setHover(null)}
                />
              )
            })}
            {hoverArea ? <path d={hoverArea.d} className="ix-geo__hl" vectorEffect="non-scaling-stroke" /> : null}
            {/* cities / ZIPs at the centre of their properties */}
            {marks.map((p) => {
              const r = p.row
              const thin = Boolean(isRate && r.insufficient)
              const f = fill(r)
              const on = hover?.key === r.key || (level === 'zip' && String(zipStep?.value) === r.key)
              const can = Boolean(child && !r.test)
              const moved = Math.hypot(p.x - p.ox, p.y - p.oy) > p.r * 0.6
              return (
                <g key={r.key}>
                {moved ? <><line className="ix-geo__leader" x1={p.ox} y1={p.oy} x2={p.x} y2={p.y} vectorEffect="non-scaling-stroke" /><circle className="ix-geo__home" cx={p.ox} cy={p.oy} r={1.6 * px} /></> : null}
                <circle
                  data-k={r.key} cx={p.x} cy={p.y} r={p.r}
                  className={cx('ix-geo__pt', thin && 'is-thin', on && 'is-on', can && 'is-drill', level === 'zip' && String(zipStep?.value) !== r.key && 'is-sib')}
                  style={f ? { fill: f } : thin ? { fill: `url(#${hatchId})` } : undefined}
                  vectorEffect="non-scaling-stroke"
                  tabIndex={can ? 0 : undefined} role={can ? 'button' : undefined}
                  aria-label={`${r.label}: ${format(r.value)}${isRate ? `, ${fmtInt(r.num)} of ${fmtInt(r.den)}` : ''}${thin ? ', small sample' : ''}`}
                  onClick={() => drill(r.key)} onKeyDown={(e) => onKey(e, r.key)}
                  onFocus={() => setHover({ key: r.key, x: 24, y: 24 })} onBlur={() => setHover(null)}
                />
                </g>
              )
            })}
            {buyerRings.map((b) => <circle key={`b-${b.key}`} cx={b.x} cy={b.y} r={(5 + 14 * Math.sqrt(b.cur / buyerPeak)) * px} className="ix-geo__buyer" vectorEffect="non-scaling-stroke" />)}
            {/* names for the areas carrying most of the base */}
            <g className="ix-geo__labels" aria-hidden="true" style={{ fontSize: fontV }}>
              {labels.map((l) => <text key={`t-${l.key}`} x={l.x} y={l.y} style={{ strokeWidth: 3 * px, textAnchor: l.side ? 'start' : 'middle' }}>{l.text}</text>)}
            </g>
          </svg>
          {hover && (hoverRow || hoverArea) ? (
            <div className={cx('ix-geo__tip', hover.x > stage.w * 0.58 && 'is-left', hover.y > stage.h * 0.52 && 'is-up')} style={{ left: hover.x, top: hover.y }} role="status">
              <b>{labelFor(hover.key)}</b>
              {hoverRow ? (
                <>
                  <strong>{format(hoverRow.value)}</strong>
                  <span>{isRate ? `${fmtInt(hoverRow.num)} of ${fmtInt(hoverRow.den)} ${sampleLabel}` : unit === 'count' ? (countTotal > 0 && hoverRow.value !== null ? `${((hoverRow.value / countTotal) * 100).toFixed(hoverRow.value / countTotal < 0.1 ? 1 : 0)}% of the ${fmtInt(countTotal)} placed in this view` : '') : `n = ${fmtInt(hoverRow.n)}`}</span>
                  {isRate && hoverRow.ci && hoverRow.den ? <span>95% interval {format(hoverRow.ci.low)} – {format(hoverRow.ci.high)}</span> : null}
                  {hoverRow.prev && hoverRow.prev.value !== null ? <span>Previous period {format(hoverRow.prev.value)}{isRate ? ` (${fmtInt(hoverRow.prev.num)} of ${fmtInt(hoverRow.prev.den)})` : ''}{delta(hoverRow) ? ` · ${delta(hoverRow)}` : ''}{isRate && minSample && (hoverRow.prev.den ?? 0) < minSample ? ' · small sample' : ''}</span> : null}
                  {isRate && hoverRow.insufficient ? <em className="is-thin">Small sample — under {minSample}; shown hatched, not ranked</em> : null}
                  {child && isNamed(hoverRow) && !hoverRow.test ? <em>{ATLAS_CHILD[mapDim as GeoLevel] ? `Click to open its ${ATLAS_CHILD[mapDim as GeoLevel] === 'zip' ? 'ZIPs' : LEVEL_NOUN[ATLAS_CHILD[mapDim as GeoLevel] as string].toLowerCase()}` : 'Click to narrow the Lab to this ZIP'}</em> : null}
                </>
              ) : <span>No activity in this slice</span>}
            </div>
          ) : null}
          {loading ? <p className="ix-geo__state">Reading geography…</p> : null}
          {mapQ.error && !mapQ.data ? <p className="ix-geo__state is-bad">Geography didn’t load · {mapQ.error}</p> : null}
        </div>
        <div className="ix-geo__foot">
          <div className="ix-geo__key" aria-hidden="true">
            <span className="ix-geo__ramp">
              {Array.from({ length: STEPS }, (_, i) => <i key={i} style={{ background: seqColor(0.1 + 0.9 * ((i + 1) / STEPS)) }} />)}
              <em>{format(0)} → {format(peak)}{unit === 'count' ? ' · √ scale' : ''}</em>
            </span>
            {isRate && minSample ? <span><i className="is-hatch" />n &lt; {minSample}</span> : null}
            <span><i className="is-none" />no activity</span>
            {buyersOn ? <span><i className="is-buyer" />buyer purchases{buyerWindow ? ` · ${buyerWindow}` : through ? ` · through ${through}` : ''}</span> : null}
          </div>
          <p className="ix-geo__src">{levelNote}</p>
        </div>
        </div>
        <aside className="ix-geo__list" aria-label={LEVEL_NOUN[mapDim] || 'Areas'}>
          <div className="ix-geo__listhead">
            <span className="ix-eyebrow">{child ? `${LEVEL_NOUN[child]} · ${child === 'zip' ? 'click to select' : 'click to drill'}` : `ZIPs in ${cityStep?.label || countyStep?.label || 'this area'}`}</span>
            {mapQ.data?.result?.truncated ? <small>top {named.length} of {mapQ.data.result.total}</small> : null}
          </div>
          {named.length ? (
            <RankedBars
              rows={named}
              unit={unit}
              format={format}
              maxRows={variant === 'lens' ? 14 : 8}
              compact
              selected={level === 'zip' ? String(zipStep?.value) : null}
              onPick={child ? (r) => drill(r.key) : undefined}
              onRecords={(r) => records({ cohort: { metric: m, part: isRate ? 'denominator' : undefined, group: { dim: mapDim, key: r.key, label: r.label } }, title: `${def?.label} · ${r.label}` })}
            />
          ) : mapQ.loading ? <div className="ix-skel-rows"><i /><i /><i /></div> : <p className="ix-note">No {(LEVEL_NOUN[mapDim] || 'areas').toLowerCase()} with activity in this slice.</p>}
          {unresolved ? <p className="ix-note">{fmtInt(unresolved.n)} {isRate ? 'in the base' : ''} could not be placed in a canonical {mapDim}; counted, never assigned.</p> : null}
          {notDrawn ? <p className="ix-note">{notDrawn} {notDrawn === 1 ? 'county is' : 'counties are'} listed but not drawn — the recorded name has no Census match.</p> : null}
          {unplaced ? <p className="ix-note">{unplaced} without coordinates are listed but not drawn.</p> : null}
          {buyersOn && bw.period ? <p className="ix-note">{bw.window === 'latest' ? `Buyer rings: recorded purchases ${buyerWindow} — the corpus’s latest 90 days. It ends ${through}, so this period’s buyer activity is not yet recorded (not zero).` : `Buyer rings: recorded purchases in this period, data through ${through}.`}</p> : null}
          <div className="ix-geo__acts">
            <button type="button" className="ix-link" onClick={openInMap} disabled={mapping}>{mapping ? 'Preparing the cohort…' : 'Open in Map'} <Icon name="arrow-up-right" size={12} /></button>
            {deepest ? <button type="button" className="ix-link" onClick={() => inspect({ kind: 'group', dim: deepest.dim, key: String(deepest.value), label: deepest.label || String(deepest.value), metric: m })}>Inspect {deepest.label || deepest.value}</button> : null}
            {level === 'zip' || level === 'city' ? <button type="button" className="ix-link" onClick={() => records({ cohort: { metric: m, part: isRate ? 'denominator' : undefined }, title: `${def?.label} · ${deepest?.label || deepest?.value}` })}>Open the records <Icon name="chevron-right" size={12} /></button> : null}
          </div>
        </aside>
      </div>
    </section>
  )
}
