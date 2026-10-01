import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { AnalyticsPerformance } from '../../../../domain/analytics/analytics-performance-api'
import type { HomeLoad } from '../../home-signals'
import { formatCount } from '../../home-signals'
import { goTo } from '../../home-navigation'
import {
  HOME_MAP_VIEWBOX,
  MAP_LAYERS,
  heatField,
  homeDots,
  layerLeaders,
  layerPoints,
  nearestDot,
  stateName,
  type MapLayerId,
} from './home-command-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * THE MARKET FIELD — the country as a grid of pixels lit by one real metric.
 *
 * Each dot of the Census-accurate dot matrix is a pixel; a layer's points are
 * projected into it (Albers USA) and spread to their neighbours, so a market
 * glows as a region. Hover reads the state's raw total. Every layer is a real
 * metric with a real location; points that cannot be placed are counted and
 * said, never dropped silently.
 */
export function HomeHeatMap({
  layer,
  onLayer,
  performance,
  deals,
  rangeLabel,
  live,
  still,
}: {
  layer: MapLayerId
  onLayer: (id: MapLayerId) => void
  performance: HomeLoad<AnalyticsPerformance>
  deals: HomeLoad<Array<{ lat: number; lng: number }>>
  rangeLabel: string
  live: boolean
  still: boolean
}) {
  const meta = MAP_LAYERS.find((l) => l.id === layer) ?? MAP_LAYERS[0]
  const source = layer === 'deals' ? deals : performance
  const perf = performance.status === 'ready' ? performance.data : null
  const dealPoints = deals.status === 'ready' ? deals.data : null
  const points = useMemo(() => layerPoints(layer, { performance: perf, deals: dealPoints }), [layer, perf, dealPoints])
  const field = useMemo(() => heatField(points ?? []), [points])
  const leaders = useMemo(() => (points ? layerLeaders(layer, { performance: perf }, field, 8) : []), [layer, perf, field, points])
  const leaderMax = leaders.reduce((m, l) => Math.max(m, l.value), 0)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hover, setHover] = useState<{ state: number; x: number; y: number } | null>(null)
  const hoverRef = useRef<number | null>(null)
  hoverRef.current = hover?.state ?? null

  // Draw: every dot is a pixel; lit pixels take the layer's colour by level.
  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const dots = homeDots()
    const [r, g, b] = hexToRgb(meta.hue)
    const phase = new Float32Array(dots.length)
    for (let i = 0; i < dots.length; i += 1) phase[i] = ((i * 2654435761) % 1000) / 1000 * Math.PI * 2
    const lit: number[] = []
    for (let i = 0; i < dots.length; i += 1) if (field.level[i] > 0.015) lit.push(i)
    lit.sort((a, b2) => field.level[a] - field.level[b2])
    const animate = live && meta.ranged && !still && lit.length > 0

    let frame = 0
    let last = 0
    const draw = (t: number) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // The canvas is width: 100% of the stage (CSS); only its height follows the
      // map's aspect. Pinning a pixel width made it overhang for a frame whenever
      // the stage narrowed (a scrollbar appearing).
      const cssW = canvas.clientWidth
      const cssH = Math.round(cssW * (HOME_MAP_VIEWBOX.height / HOME_MAP_VIEWBOX.width))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (!cssW) return
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr)
        canvas.height = Math.round(cssH * dpr)
        canvas.style.height = `${cssH}px`
      }
      const k = (cssW / HOME_MAP_VIEWBOX.width) * dpr
      ctx.setTransform(k, 0, 0, k, 0, 0)
      ctx.clearRect(0, 0, HOME_MAP_VIEWBOX.width, HOME_MAP_VIEWBOX.height)
      const styles = getComputedStyle(stage)
      const base = styles.getPropertyValue('--chm-dot').trim() || 'rgba(226, 232, 244, 0.1)'
      const baseHover = styles.getPropertyValue('--chm-dot-hover').trim() || 'rgba(226, 232, 244, 0.24)'
      const hovered = hoverRef.current
      // On a light surface a pale hue washes out: deepen it (theme-set factor).
      const deepen = parseFloat(styles.getPropertyValue('--chm-ink-mix')) || 1
      const [lr, lg, lb] = [Math.round(r * deepen), Math.round(g * deepen), Math.round(b * deepen)]
      const s = 6.4
      for (let i = 0; i < dots.length; i += 1) {
        if (field.level[i] > 0.015) continue
        ctx.fillStyle = hovered != null && dots[i].state === hovered ? baseHover : base
        ctx.fillRect(dots[i].x - s / 2, dots[i].y - s / 2, s, s)
      }
      for (const i of lit) {
        const level = field.level[i]
        const tw = animate ? 0.86 + 0.14 * Math.sin(t / 820 + phase[i]) : 1
        const alpha = Math.min(1, (0.26 + 0.74 * level) * tw)
        const size = s + 2.4 * level
        if (level > 0.6) {
          ctx.shadowColor = `rgba(${lr}, ${lg}, ${lb}, ${0.85 * level})`
          ctx.shadowBlur = 10 * level
        } else {
          ctx.shadowBlur = 0
        }
        ctx.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${Math.min(1, alpha * (deepen < 1 ? 1.25 : 1))})`
        ctx.fillRect(dots[i].x - size / 2, dots[i].y - size / 2, size, size)
      }
      ctx.shadowBlur = 0
    }

    const loop = (t: number) => {
      if (t - last > 40) { draw(t); last = t }
      frame = requestAnimationFrame(loop)
    }
    draw(window.performance.now())
    if (animate) frame = requestAnimationFrame(loop)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw(window.performance.now())) : null
    ro?.observe(stage)
    return () => { cancelAnimationFrame(frame); ro?.disconnect() }
  }, [field, meta.hue, meta.ranged, live, still, hover?.state])

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const box = canvas.getBoundingClientRect()
    const vx = ((e.clientX - box.left) / box.width) * HOME_MAP_VIEWBOX.width
    const vy = ((e.clientY - box.top) / box.height) * HOME_MAP_VIEWBOX.height
    const i = vx >= 0 && vy >= 0 && vx <= HOME_MAP_VIEWBOX.width && vy <= HOME_MAP_VIEWBOX.height ? nearestDot(vx, vy) : null
    const state = i == null ? null : homeDots()[i].state
    if (state == null) { if (hover) setHover(null); return }
    const stageBox = stage.getBoundingClientRect()
    setHover({ state, x: e.clientX - stageBox.left, y: e.clientY - stageBox.top })
  }

  const hoverValue = hover ? field.byState.get(hover.state) ?? 0 : 0

  return (
    <section className="ch-map ch-glass is-deep" aria-label="Markets">
      <header className="ch-zone-head">
        <div className="ch-zone-title">
          <span className="ch-eyebrow">Markets · {rangeLabel}</span>
          <h2>{meta.label}</h2>
        </div>
        <div className="ch-map__layers" role="radiogroup" aria-label="Map layer">
          {MAP_LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={l.id === layer}
              className={cls('ch-chip', l.id === layer && 'is-on')}
              style={{ ['--chip' as string]: l.hue }}
              onClick={() => onLayer(l.id)}
              title={l.definition}
            >
              <i aria-hidden="true" />{l.label}
            </button>
          ))}
        </div>
      </header>

      <div className="ch-map__body">
        <div
          ref={stageRef}
          className={cls('ch-map__stage', source.status !== 'ready' && 'is-dim')}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <canvas ref={canvasRef} className="ch-map__canvas" aria-hidden="true" />
          {hover ? (
            <div className="ch-map__tip" style={{ left: hover.x, top: hover.y }} role="status">
              <b>{stateName(hover.state)}</b>
              <span>{hoverValue ? `${formatCount(Math.round(hoverValue))} ${meta.unit}` : `No ${meta.unit}`}</span>
            </div>
          ) : null}
          {source.status === 'loading' ? <p className="ch-map__state">Reading {meta.label.toLowerCase()}…</p> : null}
          {source.status === 'unavailable' ? <p className="ch-map__state is-bad">Couldn’t load {meta.label.toLowerCase()} · {source.reason}</p> : null}
          {source.status === 'ready' && field.total === 0 ? <p className="ch-map__state">No {meta.unit} {meta.ranged ? `in ${rangeLabel.toLowerCase()}` : 'right now'}</p> : null}
        </div>

        <aside className="ch-map__leaders" aria-label={`Top places · ${meta.label}`}>
          <span className="ch-eyebrow">Leading</span>
          {leaders.length ? (
            <ol>
              {leaders.map((l) => (
                <li key={l.label}>
                  <span className="ch-map__leader-name">{l.label}</span>
                  <b>{formatCount(Math.round(l.value))}</b>
                  <i style={{ width: `${leaderMax ? Math.max(6, (l.value / leaderMax) * 100) : 0}%`, background: meta.hue }} aria-hidden="true" />
                </li>
              ))}
            </ol>
          ) : (
            <p className="ch-muted">{source.status === 'ready' ? 'Nothing to rank yet.' : '—'}</p>
          )}
          <div className="ch-map__scale" aria-hidden="true">
            <i style={{ background: `linear-gradient(90deg, var(--chm-dot), ${meta.hue})` }} />
            <span>fewer</span><span>more</span>
          </div>
          <div className="ch-map__total">
            <b>{source.status === 'ready' ? formatCount(Math.round(field.total)) : '—'}</b>
            <span>{meta.unit}{meta.ranged ? ` · ${rangeLabel.toLowerCase()}` : ' · now'}</span>
            {field.unplaced ? <small title="Rows whose property has no usable coordinates">{formatCount(field.unplaced)} without a location</small> : null}
          </div>
        </aside>
      </div>

      <footer className="ch-zone-foot">
        <span className="ch-muted">{meta.definition}</span>
        <button type="button" className="ch-link" onClick={() => goTo('/map')}>Open map <Icon name="arrow-up-right" size={13} /></button>
      </footer>
    </section>
  )
}
