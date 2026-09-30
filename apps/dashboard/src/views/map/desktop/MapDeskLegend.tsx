/**
 * LEGEND · COLOR BY — what the colour on the map means, and the switch that
 * changes it.
 *
 * The header's "Color by ▾" opens the lens picker (the existing lenses, by
 * family); the body is the key: for Acquisition Radar the stage-ring key, for a
 * value lens its ramp with the lens's fixed domain printed at each end and the
 * real range in view, its source, and — where the lens has one — its style.
 * Nothing is drawn here that the lens state doesn't carry.
 */
import { useEffect, useRef } from 'react'
import { Icon } from '../../../shared/icons'
import { UNIVERSAL_STAGE_RING_COLORS } from '../universal-stage-colors'
import { LENS_FAMILIES, MAP_LENSES, formatLensValue, type LensStyle, type MapLens } from '../mobile/map-lenses'
import { rampGradient } from '../mobile/MapIntelCards'
import type { LensLook, LensState } from '../mobile/useMapLens'

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

export function MapDeskLegend({ lens, state, zoom, look, onLook, onColorBy, pickerOpen, collapsed, onCollapse }: {
  lens: MapLens
  state: LensState
  zoom: number
  look: LensLook
  onLook: (next: Partial<LensLook>) => void
  onColorBy: () => void
  pickerOpen: boolean
  collapsed: boolean
  onCollapse: (v: boolean) => void
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

  return (
    <section className={cls('mxd-legend', 'mxd-l2', collapsed && 'is-collapsed', state.loading && valueLens && 'is-loading')} data-map-card="legend" aria-label="Map legend">
      <header className="mxd-legend__head">
        <span className="mxd-legend__eyebrow">Color by</span>
        <button type="button" className={cls('mxd-legend__pick', pickerOpen && 'is-open')} onClick={onColorBy} aria-expanded={pickerOpen} aria-haspopup="dialog" data-lens-trigger data-map-control="color-by">
          <span className="mxd-legend__swatch" style={lensSwatchStyle(lens)} aria-hidden="true" />
          <strong>{lens.label}</strong>
          <Icon name="chevron-down" size={12} />
        </button>
        <button type="button" className="mxd-icon-btn is-xs" aria-label={collapsed ? 'Show the key' : 'Hide the key'} aria-expanded={!collapsed} onClick={() => onCollapse(!collapsed)}>
          <Icon name={collapsed ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
      </header>
      {collapsed ? null : (
        <div className="mxd-legend__body">
          {!valueLens ? (
            <>
              <div className="mxd-legend__stages">
                {STAGE_KEY.map(([label, c]) => <span key={label}><i style={{ borderColor: c }} />{label}</span>)}
              </div>
              <p className="mxd-legend__src"><span>{status}</span>{lens.ambient ? <span>worked and hot properties glow</span> : null}</p>
            </>
          ) : (
            <>
              <div className="mxd-legend__bar" style={{ backgroundImage: rampGradient(lens) }}><i /></div>
              <div className="mxd-legend__ends">
                <span>{isCount ? 'Sparse' : coldLabel}</span>
                {range && !isCount ? <em>here {formatLensValue(lens, range[0])} – {formatLensValue(lens, range[1])}</em> : null}
                <span>{isCount ? 'Dense' : hotLabel}</span>
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
              <p className="mxd-legend__src"><span>{status}</span>{lens.attribution ? <span>{lens.attribution}</span> : null}<span>click the colour to read it</span></p>
            </>
          )}
        </div>
      )}
    </section>
  )
}
