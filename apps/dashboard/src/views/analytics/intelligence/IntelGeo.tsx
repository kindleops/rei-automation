/**
 * GEOGRAPHIC INTELLIGENCE — an analytical map, not navigation.
 *
 * The country is the desktop's Census dot matrix (Albers USA). Drill follows
 * the canonical taxonomy — Nation → State → Market → County → ZIP — and every
 * step is a breadcrumb the WHOLE Lab re-reads through (chip: "Market ·
 * Minneapolis, MN"). The map zooms to the step it is on.
 *
 *   rates    states are shaded by their rate (one hue); a state or group under
 *            the metric's minimum sample is drawn hollow — a small market with
 *            a high rate is not a finding
 *   counts   are NEVER shaded as area intensity (big states would win by
 *            size); they are proportional symbols at the groups' centroids
 *   buyers   an optional second layer: recorded buyer purchases by market,
 *            from the corpus's own window (DATA THROUGH its date), never
 *            presented as current
 *
 * Centroids are the mean of each group's own property coordinates (server).
 * Unplaced activity is counted beside the map, never assigned.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import type { BreakdownRow, LabQuery, LabRecords } from '../../../domain/analytics/analytics-lab-api'
import { fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { LCSegmented, LCSelect, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { callBackend } from '../../../lib/api/backendClient'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { fmtThrough, useBuyerWindow } from './intel-hooks'
import { DOT_SPACING, VIEWBOX, dots, fitBox, nearestDot, pointsBox, project, stateAbbr, stateBox, stateLabel, stateName } from './intel-geo'
import { fmtInt } from './intel-format'
import { serverContext } from './intel-state'
import { RankedBars } from './IntelCharts'

const GEO_METRICS = ['reply_rate', 'sellers_reached', 'interest_rate', 'opportunities_created', 'stage_advancements', 'transport_failures', 'opt_out_rate', 'messages_sent'] as const
type Level = 'nation' | 'state' | 'market' | 'county' | 'zip'
const CHILD: Record<Level, 'market' | 'county' | 'zip' | null> = { nation: 'market', state: 'market', market: 'county', county: 'zip', zip: null }
const LEVEL_NOUN: Record<string, string> = { market: 'Markets', county: 'Counties', zip: 'ZIPs' }
type Row = BreakdownRow & { centroid?: { lat: number; lng: number; n: number } }

const rgb = (s: string, fb: [number, number, number]): [number, number, number] => {
  const p = s.split(',').map((x) => Number(x.trim()))
  return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : fb
}
const mix = (a: [number, number, number], b: [number, number, number], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number]

type Camera = ReturnType<typeof fitBox>
/** Where the map looks: the country, the selected state, or the box of the groups on show. */
function cameraFor(level: Level, named: Row[], focusState: string | null): Camera {
  if (level === 'nation') return fitBox({ x: 0, y: 0, w: VIEWBOX.width, h: VIEWBOX.height })
  if (level === 'state' && focusState) { const b = stateBox(focusState); if (b) return fitBox(b) }
  const pts = named.map((r) => (r.centroid ? project(r.centroid.lng, r.centroid.lat) : null)).filter(Boolean) as Array<[number, number]>
  const b = pointsBox(pts)
  if (b) return fitBox(b)
  if (focusState) { const sb = stateBox(focusState); if (sb) return fitBox(sb) }
  return fitBox({ x: 0, y: 0, w: VIEWBOX.width, h: VIEWBOX.height })
}
/** The groups on show as proportional symbols at their centroids (rates sized by their base). */
function symbolsFor(named: Row[], isRate: boolean, nPeak: number, level: Level) {
  return named.map((r) => {
    const xy = r.centroid ? project(r.centroid.lng, r.centroid.lat) : null
    const weight = isRate ? r.den ?? r.n : r.value ?? 0
    return xy ? { row: r, x: xy[0], y: xy[1], r: (level === 'nation' ? 3 : 4) + (level === 'nation' ? 11 : 16) * Math.sqrt(Math.max(0, weight) / nPeak) } : null
  }).filter(Boolean) as Array<{ row: Row; x: number; y: number; r: number }>
}
/** Buyer purchases as dashed rings at their markets' centroids (sized by purchases). */
function buyerSymbolsFor(markets: Array<{ key: string; label: string; cur: number; prev: number; centroid?: { lat: number; lng: number } | null }> | null) {
  if (!markets?.length) return []
  const bPeak = Math.max(1, ...markets.map((b) => b.cur + b.prev))
  return markets.map((b) => {
    const xy = b.centroid ? project(b.centroid.lng, b.centroid.lat) : null
    return xy ? { key: b.key, label: b.label, total: b.cur, x: xy[0], y: xy[1], r: 4 + 14 * Math.sqrt(b.cur / bPeak) } : null
  }).filter(Boolean) as Array<{ key: string; label: string; total: number; x: number; y: number; r: number }>
}

export function IntelGeo({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, act, defs, inspect, records, refreshing } = useLab()
  const metric = (GEO_METRICS as readonly string[]).includes(ctx.metric) ? ctx.metric : 'reply_rate'
  const [own, setOwn] = useState<string | null>(null)
  const m = own && defs[own] ? own : metric
  const def = defs[m]
  const isRate = def?.unit === 'rate'
  const minSample = def?.min_sample || 30
  const [buyersOn, setBuyersOn] = useState(false)

  // where we are in the taxonomy (the deepest geography step of the breadcrumb)
  const geo = ctx.segment.filter((s) => ['state', 'market', 'county', 'zip'].includes(s.dim))
  const deepest = geo[geo.length - 1] || null
  const level: Level = !deepest ? 'nation' : (deepest.dim as Level)
  const child = CHILD[level]
  const stateStep = ctx.segment.find((s) => s.dim === 'state') || null
  const focusState = stateStep?.value ? String(stateStep.value).toUpperCase() : null

  const base = serverContext(ctx, { metric: m, groupBy: null })
  const statesQ = useIntel<LabQuery>(paths.query({ ...base, groupBy: 'state', limit: 60 }, 'breakdown'))
  const childQ = useIntel<LabQuery>(child ? paths.query({ ...base, groupBy: child, limit: child === 'zip' ? 400 : 120 }, 'breakdown') : null)
  const bw = useBuyerWindow(ctx, buyersOn)
  const stateRows = useMemo(() => ((statesQ.data?.result?.rows || []) as Row[]), [statesQ.data])
  const rows = useMemo(() => ((childQ.data?.result?.rows || []) as Row[]), [childQ.data])
  const buyers = bw.shown
  const unresolved = rows.find((r) => r.key === '__unresolved') || null
  const named = useMemo(() => rows.filter((r) => r.key !== '__unresolved' && r.key !== '__none'), [rows])

  const byState = useMemo(() => {
    const out = new Map<string, Row>()
    for (const r of stateRows) out.set(String(r.key).toUpperCase(), r)
    return out
  }, [stateRows])
  const peak = useMemo(() => Math.max(0, ...stateRows.filter((r) => r.key !== '__unresolved' && (!isRate || !r.insufficient)).map((r) => r.value ?? 0)), [stateRows, isRate])
  const nPeak = useMemo(() => Math.max(1, ...named.map((r) => (isRate ? r.den ?? r.n : r.value ?? 0))), [named, isRate])

  // the camera: the whole country, the selected state, or the box of the current groups
  const camera = cameraFor(level, named, focusState)
  const { x: camX, y: camY, w: camW, h: camH, scale: camScale } = camera

  const stage = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [hover, setHover] = useState<{ kind: 'state' | 'group' | 'buyer'; key: string; x: number; y: number } | null>(null)
  const hoverKey = hover ? `${hover.kind}:${hover.key}` : null

  const symbols = symbolsFor(named, isRate, nPeak, level)
  const buyerMarkets = buyersOn ? buyers?.markets ?? null : null
  const buyerSymbols = buyerSymbolsFor(buyerMarkets)

  useEffect(() => {
    const cv = canvas.current
    const st = stage.current
    if (!cv || !st) return
    const all = dots()
    const draw = () => {
      const g = cv.getContext('2d')
      const cssW = cv.clientWidth
      if (!g || !cssW) return
      const cssH = Math.round(cssW * (VIEWBOX.height / VIEWBOX.width))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) { cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr); cv.style.height = `${cssH}px` }
      const css = getComputedStyle(st)
      const dotRgb = rgb(css.getPropertyValue('--ixg-dot-rgb'), [226, 232, 244])
      const dotA = Number(css.getPropertyValue('--ixg-dot-a')) || 0.08
      const lo = rgb(css.getPropertyValue('--ixg-lo-rgb'), [22, 52, 70])
      const hi = rgb(css.getPropertyValue('--ixg-hi-rgb'), [94, 234, 212])
      const ring = rgb(css.getPropertyValue('--ixg-ring-rgb'), [94, 234, 212])
      const buyer = rgb(css.getPropertyValue('--ixg-buyer-rgb'), [167, 139, 250])
      const k = (cssW / camW) * dpr
      g.setTransform(k, 0, 0, k, -camX * k, -camY * k)
      g.clearRect(camX, camY, camW, camH)
      const size = DOT_SPACING * 0.56
      const focus = focusState
      for (const d of all) {
        if (d.x < camX - 12 || d.x > camX + camW + 12 || d.y < camY - 12 || d.y > camY + camH + 12) continue
        const abbr = stateAbbr(d.state) || ''
        const row = byState.get(abbr)
        const dim = focus && abbr !== focus ? 0.35 : 1
        const lit = hoverKey === `state:${abbr}`
        if (isRate && row && row.value !== null && !row.insufficient && peak > 0) {
          const t = Math.sqrt(Math.max(0, row.value) / peak)
          const c = mix(lo, hi, t)
          g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(0.35 + 0.65 * t) * dim})`
        } else if (isRate && row && row.insufficient) {
          g.strokeStyle = `rgba(${hi[0]},${hi[1]},${hi[2]},${0.32 * dim})`
          g.lineWidth = 0.9
          g.strokeRect(d.x - size / 2 + 0.45, d.y - size / 2 + 0.45, size - 0.9, size - 0.9)
          continue
        } else {
          const a = (row && (row.value ?? 0) > 0 ? dotA * 2.1 : dotA) * dim
          g.fillStyle = `rgba(${dotRgb[0]},${dotRgb[1]},${dotRgb[2]},${lit ? Math.min(0.5, a * 3) : a})`
        }
        g.fillRect(d.x - size / 2, d.y - size / 2, size, size)
      }
      const s = 1 / (camScale || 1)
      for (const b of buyerSymbolsFor(buyerMarkets)) {
        g.beginPath(); g.arc(b.x, b.y, b.r * s * 1.15, 0, Math.PI * 2)
        g.setLineDash([2.5 * s, 2 * s]); g.lineWidth = 1.2 * s; g.strokeStyle = `rgba(${buyer[0]},${buyer[1]},${buyer[2]},0.85)`; g.stroke(); g.setLineDash([])
      }
      for (const sym of symbolsFor(named, isRate, nPeak, level)) {
        const r = sym.r * s
        const thin = isRate && sym.row.insufficient
        const on = hoverKey === `group:${sym.row.key}`
        g.beginPath(); g.arc(sym.x, sym.y, r, 0, Math.PI * 2)
        if (isRate && !thin && sym.row.value !== null && peak > 0) {
          const t = Math.sqrt(Math.max(0, sym.row.value) / Math.max(peak, sym.row.value))
          const c = mix(lo, hi, t)
          g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.88)`
          g.fill()
        } else if (!isRate) {
          g.fillStyle = `rgba(${ring[0]},${ring[1]},${ring[2]},0.16)`
          g.fill()
        }
        g.lineWidth = (on ? 2 : 1.2) * s
        g.strokeStyle = `rgba(${ring[0]},${ring[1]},${ring[2]},${thin ? 0.45 : on ? 1 : 0.85})`
        if (thin) g.setLineDash([2 * s, 2 * s])
        g.stroke()
        g.setLineDash([])
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(st)
    const mo = new MutationObserver(draw)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [byState, peak, isRate, hoverKey, camX, camY, camW, camH, camScale, named, nPeak, level, buyerMarkets, focusState])

  const toView = (e: PointerEvent) => {
    const cv = canvas.current
    if (!cv) return null
    const b = cv.getBoundingClientRect()
    return { vx: camera.x + ((e.clientX - b.left) / b.width) * camera.w, vy: camera.y + ((e.clientY - b.top) / b.height) * camera.h, px: e.clientX - b.left, py: e.clientY - b.top }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = toView(e)
    if (!p) return
    const s = 1 / (camera.scale || 1)
    const sym = [...symbols].reverse().find((x) => (x.x - p.vx) ** 2 + (x.y - p.vy) ** 2 <= (Math.max(6, x.r) * s * 1.2) ** 2)
    if (sym) { setHover({ kind: 'group', key: sym.row.key, x: p.px, y: p.py }); return }
    const bs = buyerSymbols.find((x) => (x.x - p.vx) ** 2 + (x.y - p.vy) ** 2 <= (x.r * s * 1.3) ** 2)
    if (bs) { setHover({ kind: 'buyer', key: bs.key, x: p.px, y: p.py }); return }
    const i = nearestDot(p.vx, p.vy)
    const abbr = i === null ? null : stateAbbr(dots()[i].state)
    setHover(abbr ? { kind: 'state', key: abbr, x: p.px, y: p.py } : null)
  }
  const onClick = () => {
    if (!hover) return
    if (hover.kind === 'group') {
      const r = named.find((x) => x.key === hover.key)
      if (r && child) act.pushSegment({ dim: child, value: r.key, label: r.label })
      return
    }
    if (hover.kind === 'state' && level === 'nation' && byState.has(hover.key)) act.pushSegment({ dim: 'state', value: hover.key, label: stateLabel(hover.key) })
  }
  const hoverRow = hover?.kind === 'group' ? named.find((x) => x.key === hover.key) : hover?.kind === 'state' ? byState.get(hover.key) : null
  const hoverBuyer = hover?.kind === 'buyer' ? buyers?.markets.find((b) => b.key === hover.key) : null
  const format = (v: number | null) => fmtMetric(def, v)
  const through = bw.through ? fmtThrough(bw.through) : null
  const buyerWindow = bw.window === 'latest' && bw.start && bw.end ? `${new Date(bw.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${through}` : null

  // Open in Map: the exact sellers reached in this slice (≤ 5,000 places), as a focus set
  const [mapping, setMapping] = useState(false)
  const openInMap = async () => {
    setMapping(true)
    try {
      const res = await callBackend<{ ok: boolean; data: LabRecords }>(paths.records(serverContext(ctx, { metric: 'sellers_reached', groupBy: null }), { metric: 'sellers_reached', part: 'numerator' }, 1, 10, null, 'desc'), { timeoutMs: 120_000 })
      const pts = res.ok && res.data?.ok ? res.data.data.handoff.points : []
      const where = deepest ? deepest.label || deepest.value : 'all markets'
      if (writeMapFocusSet({ label: `Analytics · sellers reached · ${where}`, tone: 'property', points: pts.map((p) => ({ lat: p.lat, lng: p.lng, id: p.id, label: p.label ?? null })) })) pushRoutePath('/map')
      else pushRoutePath('/map')
    } finally { setMapping(false) }
  }

  const crumbs: Array<{ label: string; depth: number }> = [{ label: 'Nation', depth: ctx.segment.findIndex((s) => ['state', 'market', 'county', 'zip'].includes(s.dim)) }]
  geo.forEach((g) => crumbs.push({ label: g.label || (g.dim === 'state' ? stateLabel(String(g.value)) : String(g.value)), depth: ctx.segment.indexOf(g) + 1 }))

  return (
    <section className={cx('ix-geo lc-plane is-solid is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Geographic intelligence">
      <header className="ix-plane__head ix-geo__head">
        <div>
          <span className="ix-eyebrow">Geography</span>
          <nav className="ix-geo__crumbs" aria-label="Geographic drill">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`}>
                {i > 0 ? <Icon name="chevron-right" size={11} /> : null}
                <button type="button" onClick={() => (i === 0 ? act.set((x) => ({ segment: x.segment.filter((s) => !['state', 'market', 'county', 'zip'].includes(s.dim)) })) : act.popSegmentTo(c.depth))} disabled={i === crumbs.length - 1} className={cx(i === crumbs.length - 1 && 'is-here')}>{c.label}</button>
              </span>
            ))}
          </nav>
        </div>
        <div className="ix-geo__ctl">
          <LCSelect label="Colour the map by" prefix="Map" variant="quiet" size="sm" value={m} onChange={(v) => setOwn(v)} options={GEO_METRICS.filter((id) => defs[id]).map((id) => ({ value: id, label: defs[id].label, hint: defs[id].unit === 'rate' ? 'shaded by rate' : 'sized by count' }))} menuWidth={240} />
          <LCSegmented label="Second layer" size="sm" value={buyersOn ? 'buyers' : 'none'} onChange={(v) => setBuyersOn(v === 'buyers')} options={[{ value: 'none', label: 'Sellers' }, { value: 'buyers', label: '+ Buyers' }]} />
        </div>
      </header>
      <div className="ix-geo__body">
        <div ref={stage} className="ix-geo__stage" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={onClick} role="img" aria-label={`${def?.label} by ${level === 'nation' ? 'state and market' : (LEVEL_NOUN[child || ''] || 'area').toLowerCase()}`}>
          <canvas ref={canvas} className="ix-geo__canvas" aria-hidden="true" />
          {hover && (hoverRow || hoverBuyer || hover.kind === 'state') ? (
            <div className="ix-geo__tip" style={{ left: hover.x, top: hover.y }}>
              {hoverBuyer ? (
                <><b>{hoverBuyer.label}</b><span>{fmtInt(hoverBuyer.cur)} recorded purchases · {fmtInt(hoverBuyer.entities)} buyers</span><em>recorded purchases · {buyerWindow || `data through ${through}`}</em></>
              ) : (
                <>
                  <b>{hover.kind === 'state' ? stateName(dots().find((d) => stateAbbr(d.state) === hover.key)?.state ?? -1) || hover.key : hoverRow?.label}</b>
                  {hoverRow ? <span>{format(hoverRow.value)}{isRate ? ` · ${fmtInt(hoverRow.num)} of ${fmtInt(hoverRow.den)}` : ''}{hoverRow.insufficient ? ' · small sample' : ''}</span> : <span>No activity in this slice</span>}
                  {hoverRow && (hover.kind === 'group' ? Boolean(child) : level === 'nation') ? <em>Click to drill in</em> : null}
                </>
              )}
            </div>
          ) : null}
          {statesQ.loading && !statesQ.data ? <p className="ix-geo__state">Reading geography…</p> : null}
          {statesQ.error && !statesQ.data ? <p className="ix-geo__state is-bad">Geography didn’t load · {statesQ.error}</p> : null}
          <div className="ix-geo__key" aria-hidden="true">
            {isRate ? <span><i className="is-ramp" />{format(0)} → {format(peak)}</span> : <span><i className="is-size" />size = {def?.short?.toLowerCase() || 'count'}</span>}
            {isRate ? <span><i className="is-hollow" />n &lt; {minSample}</span> : null}
            {buyersOn ? <span><i className="is-buyer" />buyer purchases{buyerWindow ? ` · ${buyerWindow}` : through ? ` · through ${through}` : ''}</span> : null}
          </div>
        </div>
        <aside className="ix-geo__list" aria-label={child ? LEVEL_NOUN[child] : 'Records'}>
          <div className="ix-geo__listhead">
            <span className="ix-eyebrow">{child ? `${LEVEL_NOUN[child]}${child !== 'zip' ? ' · click to drill' : ''}` : 'This ZIP'}</span>
            {childQ.data?.result?.truncated ? <small>top {named.length} of {childQ.data.result.total}</small> : null}
          </div>
          {child ? (
            named.length ? (
              <RankedBars
                rows={named}
                unit={def?.unit || 'count'}
                format={format}
                maxRows={variant === 'lens' ? 14 : 8}
                compact
                onPick={(r) => act.pushSegment({ dim: child, value: r.key, label: r.label })}
                onRecords={(r) => records({ cohort: { metric: m, part: isRate ? 'denominator' : undefined, group: { dim: child, key: r.key, label: r.label } }, title: `${def?.label} · ${r.label}` })}
              />
            ) : childQ.loading ? <div className="ix-skel-rows"><i /><i /><i /></div> : <p className="ix-note">No {LEVEL_NOUN[child].toLowerCase()} with activity in this slice.</p>
          ) : (
            <button type="button" className="ix-link" onClick={() => records({ cohort: { metric: m, part: isRate ? 'denominator' : undefined }, title: `${def?.label} · ${deepest?.label || deepest?.value}` })}>Open the records <Icon name="chevron-right" size={12} /></button>
          )}
          {unresolved ? <p className="ix-note">{fmtInt(unresolved.n)} {isRate ? 'in the base' : ''} could not be placed in a canonical {child}; counted, never assigned.</p> : null}
          {buyersOn && bw.period ? <p className="ix-note">{bw.window === 'latest' ? `Buyer rings: recorded purchases ${buyerWindow} — the corpus’s latest 90 days. It ends ${through}, so this period’s buyer activity is not yet recorded (not zero).` : `Buyer rings: recorded purchases in this period, data through ${through}.`}</p> : null}
          <div className="ix-geo__acts">
            <button type="button" className="ix-link" onClick={openInMap} disabled={mapping}>{mapping ? 'Preparing the cohort…' : 'Open in Map'} <Icon name="arrow-up-right" size={12} /></button>
            {deepest ? <button type="button" className="ix-link" onClick={() => inspect({ kind: 'group', dim: deepest.dim, key: String(deepest.value), label: deepest.label || String(deepest.value), metric: m })}>Inspect {deepest.label || deepest.value}</button> : null}
          </div>
        </aside>
      </div>
    </section>
  )
}
