/**
 * LEGEND · COLOR BY — what the colour on the map means, and the switch that
 * changes it.
 *
 * The header's "Color by ▾" opens the lens picker (the existing lenses, by
 * family); the body is the key: for Acquisition Radar the stage-ring key, for a
 * value lens its ramp with the lens's fixed domain printed at each end and the
 * real range in view, its source, and — where the lens has one — its style.
 * Nothing is drawn here that the lens state doesn't carry.
 *
 * At full size it is one slim strip (the lens, its key, a fold); in a compact
 * pane (map-desk.css container queries) it folds to a "Legend" chip that opens
 * the same key on demand.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { UNIVERSAL_STAGE_RING_COLORS } from '../universal-stage-colors'
import { DESK_LENS_FAMILIES as LENS_FAMILIES, DESK_LENSES as MAP_LENSES, formatLensValue, type LensStyle, type MapLens } from '../mobile/map-lenses'
import { rampGradient } from '../mobile/MapIntelCards'
import type { LensLook, LensState } from '../mobile/useMapLens'
import type { BoundaryStatus } from './useMapBoundaries'
import { LIGHTS_ATTRIBUTION } from '../world/city-lights'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const STAGE_KEY: Array<[string, string]> = [
  ['Uncontacted', UNIVERSAL_STAGE_RING_COLORS.uncontacted],
  ['Ownership check', UNIVERSAL_STAGE_RING_COLORS.ownership_check],
  ['Talking', UNIVERSAL_STAGE_RING_COLORS.active_communication],
  ['Negotiating', UNIVERSAL_STAGE_RING_COLORS.negotiating],
  ['Hot', UNIVERSAL_STAGE_RING_COLORS.hot_urgent],
  ['Follow-up', UNIVERSAL_STAGE_RING_COLORS.follow_up_due],
]

const STAGE_SWATCH = ['#29E68B', '#FF893D', '#FF4C55']
export const lensSwatchStyle = (lens: MapLens) => ({
  backgroundImage: lens.source && !lens.ambient ? rampGradient(lens) : `linear-gradient(90deg, ${STAGE_SWATCH.join(', ')})`,
})

/** The lens picker (L4). Choosing the active lens again keeps it — the Layers switch turns colour off. */
export function LensPicker({ active, onPick, onClose, placement }: { active: MapLens; onPick: (lens: MapLens) => void; onClose: () => void; placement: 'up' | 'down' | 'side' }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current() } }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (ref.current && t && !ref.current.contains(t) && !(t as HTMLElement).closest?.('[data-lens-trigger]')) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true) }
  }, [])
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' }) }, [])
  return (
    <div ref={ref} className={cls('mxd-pop', 'mxd-lenspick', `is-${placement}`)} role="dialog" aria-label="Color the map by">
      <div className="mxd-pop__head"><strong>Color by</strong><span>{MAP_LENSES.length} lenses · real stored values</span></div>
      <div className="mxd-lenspick__scroll">
        {LENS_FAMILIES.map((f) => (
          <section key={f.key} className="mxd-lenspick__family">
            <h4>{f.label}</h4>
            <div role="radiogroup" aria-label={f.label}>
              {MAP_LENSES.filter((l) => l.family === f.key).map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={l.id === active.id}
                  className={cls('mxd-lenspick__item', l.id === active.id && 'is-on')}
                  onClick={() => onPick(l)}
                  data-lens-id={l.id}
                >
                  <span className="mxd-lenspick__ramp" style={lensSwatchStyle(l)} aria-hidden="true" />
                  <span className="mxd-lenspick__copy"><strong>{l.label}</strong><span>{l.sub}</span></span>
                  {l.id === active.id ? <Icon name="check" size={13} /> : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

/**
 * [8.2] The boundary key: one entry per overlay that is on, drawn with the same
 * stroke as the map (solid state lines, dashed ZIP outlines), its count in view
 * or the reason nothing is drawn, and the source.
 */
export function BoundaryKey({ items }: { items: BoundaryStatus[] }) {
  const on = items.filter((b) => b.on)
  if (!on.length) return null
  const source = on.map((b) => b.source).find(Boolean) ?? 'US Census'
  return (
    <div className="mxd-legend__bounds" data-legend="boundaries">
      {on.map((b) => (
        <span key={b.level} className={cls('mxd-legend__bound', `is-${b.level}`, b.state !== 'on' && 'is-quiet')} title={b.reason ?? undefined}>
          <i aria-hidden="true" />
          {b.level === 'state' ? 'State lines' : 'ZIP outlines'}
          <em>{b.state === 'on' ? b.count.toLocaleString('en-US') : b.state === 'loading' ? 'reading…' : b.reason ?? 'not drawn'}</em>
        </span>
      ))}
      <span className="mxd-legend__bound-src">{source}</span>
    </div>
  )
}

/**
 * [8.3] The day/night key, shown while daylight is drawn as Dynamic (sun):
 * the same ramp the map uses, from full day through civil, nautical and
 * astronomical twilight to night. The source is the sun itself.
 */
export function SunKey({ lights = false }: { lights?: boolean }) {
  return (
    <div className="mxd-legend__sun" data-legend="sun">
      <span className="mxd-legend__sun-end">Day</span>
      <span className="mxd-legend__sun-ramp" aria-hidden="true"><i style={{ left: '24%' }} /><i style={{ left: '52%' }} /><i style={{ left: '78%' }} /></span>
      <span className="mxd-legend__sun-end">Night</span>
      <span className="mxd-legend__bound-src" title="Sunset line, then civil (−6°), nautical (−12°) and astronomical (−18°) twilight">Sun’s real position · now</span>
      {lights ? <span className="mxd-legend__sun-attr" title="We acknowledge the use of imagery provided by services from NASA’s Global Imagery Browse Services (GIBS), part of NASA’s Earth Science Data and Information System (ESDIS).">{LIGHTS_ATTRIBUTION}</span> : null}
    </div>
  )
}

export function MapDeskLegend({ lens, state, zoom, look, onLook, onColorBy, pickerOpen, collapsed, onCollapse, boundaries = [], sun = false, sunLights = false, context = null }: {
  lens: MapLens
  state: LensState
  zoom: number
  look: LensLook
  onLook: (next: Partial<LensLook>) => void
  onColorBy: () => void
  pickerOpen: boolean
  collapsed: boolean
  onCollapse: (v: boolean) => void
  boundaries?: BoundaryStatus[]
  /** Daylight is drawn as Dynamic (sun): show the day/night key. */
  sun?: boolean
  /** City lights are drawn (their source is credited in the key). */
  sunLights?: boolean
  /** [8.4] Context overlay entries (context/MapContextUI ContextKey). */
  context?: ReactNode
}) {
  const valueLens = Boolean(lens.source) && !lens.ambient
  const [a, b] = lens.domain ?? [0, 1]
  const isCount = lens.id === 'territory' || Boolean(lens.density)
  const coldLabel = lens.invert ? `${formatLensValue(lens, b)}+` : `≤ ${formatLensValue(lens, a)}`
  const hotLabel = lens.invert ? `≤ ${formatLensValue(lens, a)}` : `${formatLensValue(lens, b)}+`
  const range = state.lensId === lens.id ? state.inView : null
  const areas = look.style === 'areas'
  const unit = areas ? (zoom >= 7 ? 'ZIPs' : zoom >= 4.6 ? 'counties' : 'states') : lens.areal ? 'areas' : zoom >= 13 ? 'properties' : 'cells'
  const status = !valueLens ? 'Ring = stage' : state.error ? state.error : state.loading && !state.count ? 'Reading…' : `${state.count.toLocaleString('en-US')} ${unit}`
  const note = [status, !valueLens && lens.ambient ? 'worked and hot properties glow' : null].filter(Boolean).join(' · ')

  // [compact pane] the key folds to a "Legend" chip; it opens on demand and
  // closes on Escape or a press anywhere else (listeners only while open).
  const [peek, setPeek] = useState(false)
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!peek) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setPeek(false) } }
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (ref.current && t && !ref.current.contains(t) && !t.closest?.('.mxd-lenspick')) setPeek(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown, true) }
  }, [peek])

  return (
    <section ref={ref} className={cls('mxd-legend', collapsed && 'is-collapsed', peek && 'is-peek', valueLens ? 'is-value' : 'is-stage', state.loading && valueLens && 'is-loading')} data-map-card="legend" aria-label="Map legend">
      <button type="button" className="mxd-legend__chip mxd-l2" aria-expanded={peek} onClick={() => setPeek((v) => !v)} data-map-control="legend">
        <span className="mxd-legend__swatch" style={lensSwatchStyle(lens)} aria-hidden="true" />
        <span>Legend</span>
      </button>
      <div className="mxd-legend__panel mxd-l2">
        <button type="button" className={cls('mxd-legend__pick', pickerOpen && 'is-open')} onClick={onColorBy} aria-expanded={pickerOpen} aria-haspopup="dialog" aria-label={`Color by: ${lens.label}`} data-lens-trigger data-map-control="color-by">
          <span className="mxd-legend__swatch" style={lensSwatchStyle(lens)} aria-hidden="true" />
          <strong>{lens.label}</strong>
          <Icon name="chevron-down" size={11} />
        </button>
        <div className="mxd-legend__body" title={note}>
          {!valueLens ? (
            <>
              <div className="mxd-legend__stages">
                {STAGE_KEY.map(([label, c]) => <span key={label}><i style={{ borderColor: c }} />{label}</span>)}
              </div>
              <p className="mxd-legend__src"><span>{note}</span></p>
              <BoundaryKey items={boundaries} />
              {context}
              {sun ? <SunKey lights={sunLights} /> : null}
            </>
          ) : (
            <>
              <div className="mxd-legend__ramp">
                <span className="mxd-legend__end">{isCount ? 'Sparse' : coldLabel}</span>
                <div className="mxd-legend__bar" style={{ backgroundImage: rampGradient(lens) }}><i /></div>
                <span className="mxd-legend__end">{isCount ? 'Dense' : hotLabel}</span>
              </div>
              <div className="mxd-legend__look">
                <div className="mxd-seg is-xs" role="radiogroup" aria-label="Heat style">
                  {(['dots', 'surface', 'areas'] as LensStyle[]).map((st) => (
                    <button key={st} type="button" role="radio" aria-checked={look.style === st} className={cls('mxd-seg__tab', look.style === st && 'is-on')} onClick={() => onLook({ style: st })} data-lens-style={st}>
                      {st === 'dots' ? 'Dots' : st === 'surface' ? 'Surface' : 'Areas'}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mxd-legend__src">
                <span>{status}</span>
                {range && !isCount ? <span>here {formatLensValue(lens, range[0])} – {formatLensValue(lens, range[1])}</span> : null}
                {lens.attribution ? <span>{lens.attribution}</span> : null}
                <span>click the colour to read it</span>
              </p>
              <BoundaryKey items={boundaries} />
              {context}
              {sun ? <SunKey lights={sunLights} /> : null}
            </>
          )}
        </div>
        <button type="button" className="mxd-icon-btn is-xs mxd-legend__fold" aria-label={collapsed ? 'Show the key' : 'Hide the key'} aria-expanded={!collapsed} onClick={() => onCollapse(!collapsed)}>
          <Icon name={collapsed ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
      </div>
    </section>
  )
}
