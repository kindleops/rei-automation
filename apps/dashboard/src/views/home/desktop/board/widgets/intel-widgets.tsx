import { useEffect, useMemo, useRef, useState } from 'react'
import { LCSparkline } from '../../../../../shared/lc'
import { writeMapFocusSet } from '../../../../../domain/map/map-focus-set'
import type { AnalyticsPerformance, RangeKey } from '../../../../../domain/analytics/analytics-performance-api'
import {
  HOME_MAP_VIEWBOX,
  MAP_LAYERS,
  heatField,
  homeDots,
  layerLeaders,
  layerPoints,
  nearestDot,
  notYetRecorded,
  projectAlbersUsa,
  stateName,
  type HeatPoint,
  type MapLayerId,
} from '../../command/home-command-model'
import { mapActivitySource, performanceSource, SOURCES } from '../board-data'
import { ANALYTICS_METRICS, METRIC_CONTRACT, type MetricKey } from './analytics-metrics'
import { cx, fmt, openPath, pct, useWidgetSource } from '../widget-runtime'
import { WFigure, WState } from '../widget-ui'
import type { WidgetRenderProps } from '../widget-registry'

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * THE PIXEL MAP — the national dot matrix lit by one real metric (the Home's
 * visual DNA, from the Command Center). One canvas, drawn once per data or
 * size change; it never animates to look alive. Hover reads the state's raw
 * total; a click hands that state's points to the Map as a focus set.
 */
function PixelMap({ points, hue, unit, onState, dim }: { points: HeatPoint[] | null; hue: string; unit: string; onState?: (state: number) => void; dim?: boolean }) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const field = useMemo(() => heatField(points ?? []), [points])
  const [hover, setHover] = useState<{ state: number; x: number; y: number } | null>(null)
  const hoverState = hover?.state ?? null

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const dots = homeDots()
    const [r, g, b] = hexToRgb(hue)
    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const aspect = HOME_MAP_VIEWBOX.height / HOME_MAP_VIEWBOX.width
      const sw = stage.clientWidth
      const sh = stage.clientHeight
      if (!sw || !sh) return
      const cssW = Math.min(sw, sh / aspect)
      const cssH = Math.round(cssW * aspect)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr)
        canvas.height = Math.round(cssH * dpr)
        canvas.style.width = `${Math.round(cssW)}px`
        canvas.style.height = `${cssH}px`
      }
      const k = (cssW / HOME_MAP_VIEWBOX.width) * dpr
      ctx.setTransform(k, 0, 0, k, 0, 0)
      ctx.clearRect(0, 0, HOME_MAP_VIEWBOX.width, HOME_MAP_VIEWBOX.height)
      const styles = getComputedStyle(stage)
      const base = styles.getPropertyValue('--chm-dot').trim() || 'rgba(226, 232, 244, 0.1)'
      const baseHover = styles.getPropertyValue('--chm-dot-hover').trim() || 'rgba(226, 232, 244, 0.24)'
      const deepen = parseFloat(styles.getPropertyValue('--chm-ink-mix')) || 1
      const [lr, lg, lb] = [Math.round(r * deepen), Math.round(g * deepen), Math.round(b * deepen)]
      const s = 6.4
      for (let i = 0; i < dots.length; i += 1) {
        if (field.level[i] > 0.015) continue
        ctx.fillStyle = hoverState != null && dots[i].state === hoverState ? baseHover : base
        ctx.fillRect(dots[i].x - s / 2, dots[i].y - s / 2, s, s)
      }
      for (let i = 0; i < dots.length; i += 1) {
        const level = field.level[i]
        if (level <= 0.015) continue
        const size = s + 2.4 * level
        if (level > 0.6) { ctx.shadowColor = `rgba(${lr}, ${lg}, ${lb}, ${0.8 * level})`; ctx.shadowBlur = 9 * level } else ctx.shadowBlur = 0
        ctx.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${Math.min(1, (0.26 + 0.74 * level) * (deepen < 1 ? 1.25 : 1))})`
        ctx.fillRect(dots[i].x - size / 2, dots[i].y - size / 2, size, size)
      }
      ctx.shadowBlur = 0
    }
    draw()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null
    ro?.observe(stage)
    return () => ro?.disconnect()
  }, [field, hue, hoverState])

  const stateAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    const vx = ((clientX - box.left) / box.width) * HOME_MAP_VIEWBOX.width
    const vy = ((clientY - box.top) / box.height) * HOME_MAP_VIEWBOX.height
    const i = vx >= 0 && vy >= 0 && vx <= HOME_MAP_VIEWBOX.width && vy <= HOME_MAP_VIEWBOX.height ? nearestDot(vx, vy) : null
    return i == null ? null : homeDots()[i].state
  }

  const value = hover ? field.byState.get(hover.state) ?? 0 : 0
  return (
    <div
      ref={stageRef}
      className={cx('hb-pmap', dim && 'is-dim', onState && 'is-clickable')}
      onPointerMove={(e) => {
        const st = stateAt(e.clientX, e.clientY)
        if (st == null) { if (hover) setHover(null); return }
        const box = stageRef.current!.getBoundingClientRect()
        setHover({ state: st, x: e.clientX - box.left, y: e.clientY - box.top })
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => { const st = stateAt(e.clientX, e.clientY); if (st != null && onState) onState(st) }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {hover ? (
        <div className="hb-pmap__tip" style={{ left: hover.x, top: hover.y }} role="status">
          <b>{stateName(hover.state)}</b>
          <span>{value ? `${fmt(Math.round(value))} ${unit}` : `No ${unit}`}</span>
        </div>
      ) : null}
    </div>
  )
}

/* ── Map (flagship) ─────────────────────────────────────────────────── */

const RANGE_LABEL: Record<string, string> = { today: 'today', '7d': 'last 7 days', '30d': 'last 30 days' }

export function MapWidget({ size, config, setConfig }: WidgetRenderProps<{ lens: string; range: string }>) {
  const lens = (MAP_LAYERS.some((l) => l.id === config.lens) ? config.lens : 'replies') as MapLayerId
  const range = (['today', '7d', '30d'].includes(config.range) ? config.range : '7d') as RangeKey
  const meta = MAP_LAYERS.find((l) => l.id === lens)!
  const activity = useWidgetSource(lens === 'deals' ? null : mapActivitySource(lens, range === 'today' || range === '30d' ? range : '7d'))
  const deals = useWidgetSource(lens === 'deals' ? SOURCES.pipelinePoints : null)
  const load = lens === 'deals' ? deals : activity
  const actD = activity.load.status === 'ready' ? activity.load.data : null
  const dealsD = deals.load.status === 'ready' ? deals.load.data : null
  const points = useMemo(() => layerPoints(lens, { activity: actD, deals: dealsD }), [lens, actD, dealsD])
  const field = useMemo(() => heatField(points ?? []), [points])
  const leaders = useMemo(() => (points ? layerLeaders(lens, { activity: actD }, field, size === 'feature' ? 7 : 5) : []), [lens, actD, field, points, size])
  const notReadable = lens !== 'deals' && actD && !actD.available ? actD : null
  const recordedThrough = lens === 'buyers' ? notYetRecorded(actD) : null
  const unplaced = field.unplaced + (lens !== 'deals' && actD ? actD.unplaced : 0)
  const leaderMax = leaders.reduce((m, l) => Math.max(m, l.value), 0)
  const showLeaders = size === 'large' || size === 'feature' || size === 'wide'
  const showLenses = size === 'large' || size === 'feature' || size === 'wide' || size === 'tall'

  /** Click a state: hand its points to the Map as a focus set (the Map frames them). */
  const focusState = (state: number) => {
    const inState = (points ?? []).filter((p) => {
      const xy = projectAlbersUsa(p.lng, p.lat)
      const i = xy ? nearestDot(xy[0], xy[1]) : null
      return i != null && homeDots()[i].state === state
    })
    if (inState.length && writeMapFocusSet({ label: `${meta.label} · ${stateName(state) ?? 'state'}`, tone: lens === 'buyers' ? 'buyer' : 'property', points: inState.map((p) => ({ lat: p.lat, lng: p.lng })) })) openPath('/map', true)
    else openPath('/map', true)
  }

  return (
    <div className={cx('hb-map', `is-${size}`)} style={{ ['--lens' as string]: meta.hue }}>
      <div className="hb-map__head">
        <span className="hb-map__lens"><i aria-hidden="true" />{meta.label}<small>{meta.ranged ? RANGE_LABEL[range] : 'now'}</small></span>
        <b className="hb-map__total">{load.load.status === 'ready' && !notReadable ? fmt(Math.round(field.total)) : '—'} <small>{meta.unit}</small></b>
      </div>
      {showLenses ? (
        <div className="hb-map__lenses" role="radiogroup" aria-label="Map lens">
          {MAP_LAYERS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={l.id === lens} className={cx('hb-chip', l.id === lens && 'is-on')} style={{ ['--chip' as string]: l.hue }} onClick={() => setConfig({ lens: l.id })} title={l.definition}>
              <i aria-hidden="true" />{l.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="hb-map__body">
        <div className="hb-map__stage">
          <PixelMap points={points} hue={meta.hue} unit={meta.unit} onState={focusState} dim={load.load.status !== 'ready'} />
          {load.load.status === 'loading' ? <p className="hb-map__state">Reading {meta.label.toLowerCase()}…</p> : null}
          {load.load.status === 'unavailable' ? <p className="hb-map__state is-bad">Couldn’t load {meta.label.toLowerCase()} · <button type="button" className="hb-link" onClick={load.reload}>Retry</button></p> : null}
          {notReadable ? <p className="hb-map__state" title={notReadable.message}>{meta.label} isn’t readable on Home yet</p> : null}
          {load.load.status === 'ready' && !notReadable && recordedThrough ? <p className="hb-map__state">Recorded purchases end {recordedThrough} · {RANGE_LABEL[range]} not yet recorded</p> : null}
          {load.load.status === 'ready' && !notReadable && !recordedThrough && field.total === 0 ? <p className="hb-map__state">No {meta.unit} {meta.ranged ? RANGE_LABEL[range] : 'right now'}</p> : null}
        </div>
        {showLeaders ? (
          <aside className="hb-map__leaders" aria-label={`Leading · ${meta.label}`}>
            <span className="hb-eyebrow">Leading</span>
            {leaders.length ? (
              <ol>
                {leaders.map((l) => (
                  <li key={l.label}>
                    <span>{l.label}</span>
                    <b>{fmt(Math.round(l.value))}</b>
                    <i style={{ width: `${leaderMax ? Math.max(6, (l.value / leaderMax) * 100) : 0}%` }} aria-hidden="true" />
                  </li>
                ))}
              </ol>
            ) : <p className="hb-muted">{load.load.status === 'ready' && !notReadable ? 'Nothing to rank yet.' : '—'}</p>}
            {unplaced ? <small className="hb-muted" title="Rows whose property has no usable coordinates">{fmt(unplaced)} without a location</small> : null}
          </aside>
        ) : null}
      </div>
      {size !== 'small' && size !== 'compact' ? <p className="hb-map__def">{meta.definition}{size === 'medium' ? '' : ' Click a state to frame it on the Map.'}</p> : null}
      {size === 'medium' ? (
        <div className="hb-map__range" role="radiogroup" aria-label="Period">
          {meta.ranged ? (['today', '7d', '30d'] as const).map((r) => <button key={r} type="button" role="radio" aria-checked={range === r} className={cx('hb-chip is-small', range === r && 'is-on')} onClick={() => setConfig({ range: r })}>{r === 'today' ? 'Today' : r.toUpperCase()}</button>) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ── Analytics ──────────────────────────────────────────────────────── */


function reading(perf: AnalyticsPerformance, metric: MetricKey): { value: string; delta: string | null; tone: 'ok' | 'crit' | null; series: number[] | null; basis: string } {
  const spec = ANALYTICS_METRICS.find((m) => m.value === metric)!
  const { contract: key, series: seriesKey } = METRIC_CONTRACT[metric]
  if (spec.kind === 'rate') {
    const r = perf.rates[metric as 'reply_rate' | 'delivery_rate' | 'opt_out_rate']
    const pp = r.pp
    const better = pp == null ? null : spec.good === 'up' ? pp > 0 : pp < 0
    return {
      value: pct(r.cur),
      delta: r.reliable && pp != null ? `${pp > 0 ? '+' : ''}${pp.toFixed(1)} pts` : null,
      tone: better == null || pp === 0 ? null : better ? 'ok' : 'crit',
      series: null,
      basis: `${fmt(r.sample.cur)} in sample`,
    }
  }
  const c = perf.compare[key]
  const better = c && c.delta !== 0 ? (spec.good === 'up' ? c.delta > 0 : c.delta < 0) : null
  return {
    value: fmt(c?.cur ?? perf.totals.cur[key] ?? null),
    delta: c ? (c.basis === 'percent' && c.pct !== null ? `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(Math.abs(c.pct) >= 100 ? 0 : 1)}%` : `${c.delta > 0 ? '+' : ''}${fmt(c.delta)}`) : null,
    tone: better == null ? null : better ? 'ok' : 'crit',
    series: seriesKey ? perf.series.map((p) => p[seriesKey] ?? 0) : null,
    basis: perf.priorHasData ? 'vs the previous period' : 'no prior period on record',
  }
}

function Bars({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values)
  return (
    <div className="hb-bars" role="img" aria-label={label}>
      {values.map((v, i) => <i key={i} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} title={fmt(v)} />)}
    </div>
  )
}

export function AnalyticsWidget({ size, config }: WidgetRenderProps<{ metric: string; period: string; market: string | null; display: string }>) {
  const metric = (ANALYTICS_METRICS.some((m) => m.value === config.metric) ? config.metric : 'replied') as MetricKey
  const period = (['today', '7d', '30d', '90d'].includes(config.period) ? config.period : '7d') as RangeKey
  const market = config.market || null
  const { load, reload } = useWidgetSource(performanceSource(period, market))
  const spec = ANALYTICS_METRICS.find((m) => m.value === metric)!
  return (
    <WState load={load} what="analytics" onRetry={reload} shape={size === 'compact' ? 'metric' : 'chart'}>
      {(perf) => {
        const r = reading(perf, metric)
        const contract = perf.metrics[METRIC_CONTRACT[metric].contract]
        const label = contract?.label || spec.label
        const scope = [perf.scope.marketName || (market ? market : 'All markets'), period === 'today' ? 'Today' : period.toUpperCase()].join(' · ')
        const chart = config.display !== 'number' && r.series && r.series.length > 1
        return (
          <div className={cx('hb-ana', `is-${size}`)}>
            <div className="hb-ana__top">
              <WFigure value={r.value} label={label} sub={r.delta ? <span className={cx('hb-delta', r.tone && `is-${r.tone}`)}>{r.delta}</span> : null} size={size === 'compact' ? 'md' : 'xl'} onClick={() => openPath('/analytics')} />
              {chart && (size === 'small' || size === 'medium' || size === 'tall') ? <LCSparkline values={r.series!} width={120} height={34} tone={r.tone === 'crit' ? 'crit' : 'exec'} label={`${label} over the period`} /> : null}
            </div>
            {size !== 'compact' ? <p className="hb-ana__scope">{scope}{r.delta ? ` · ${r.basis}` : ''}</p> : null}
            {chart && (size === 'wide' || size === 'large' || size === 'feature') ? <Bars values={r.series!} label={`${label} by ${perf.period.bucket}`} /> : null}
            {(size === 'large' || size === 'feature' || size === 'tall') && contract ? <p className="hb-ana__def">{contract.definition}</p> : null}
          </div>
        )
      }}
    </WState>
  )
}
