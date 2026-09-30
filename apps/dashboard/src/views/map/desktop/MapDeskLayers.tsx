/**
 * LAYERS — the sensor array.
 *
 * Four groups (Properties · Market intelligence · Live world · Operations),
 * each layer a plate: a status light, what it draws and where from, its
 * switch, and — only where the layer genuinely supports it — opacity, style
 * and time. A layer with no data source yet is shown disabled with its reason.
 * Every control writes the Map's own existing state; nothing here fetches.
 */
import type { ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { CommandMapPerformanceSettings } from '../commandMapLiveActivity'
import { ACTIVITY_SCOPES, ACTIVITY_WINDOWS, type ActivityScope, type ActivityWindow } from '../mobile/map-mobile-model'
import type { LensStyle } from '../mobile/map-lenses'
import type { CompFilters } from '../mobile/useSoldComps'
import { buildSensorArray, groupTally, pctLabel, type SensorInput, type SensorRow, type SensorStatus } from './map-desk-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const STATUS_LABEL: Record<SensorStatus, string> = { live: 'Live', on: 'On', waiting: 'Waiting', off: 'Off', unavailable: 'Unavailable' }

export function DeskSwitch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={cls('mxd-switch', on && 'is-on')} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

export function DeskSeg<T extends string>({ value, options, onChange, label, size }: {
  value: T
  options: ReadonlyArray<{ key: T; label: string; count?: number }>
  onChange: (v: T) => void
  label: string
  size?: 'sm'
}) {
  return (
    <div className={cls('mxd-seg', size === 'sm' && 'is-sm')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} className={cls('mxd-seg__tab', value === o.key && 'is-on')} onClick={() => onChange(o.key)}>
          {o.label}{typeof o.count === 'number' ? <em>{o.count}</em> : null}
        </button>
      ))}
    </div>
  )
}

function OpacitySlider({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const pct = Math.round(value * 100)
  return (
    <label className="mxd-ctl">
      <span className="mxd-ctl__label">Opacity</span>
      <input
        type="range"
        min={20}
        max={100}
        step={5}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={`${label} opacity`}
        className="mxd-range-input"
        style={{ ['--mxd-pct' as string]: `${((pct - 20) / 80) * 100}%` }}
      />
      <em className="mxd-ctl__value">{pctLabel(value)}</em>
    </label>
  )
}

function Plate({ row, onToggle, children }: { row: SensorRow; onToggle?: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className={cls('mxd-plate', `is-${row.status}`, !row.available && 'is-disabled', row.on && row.available && 'is-on')} data-layer={row.id}>
      <div className="mxd-plate__row">
        <span className={cls('mxd-light', `is-${row.status}`)} aria-hidden="true" />
        <span className="mxd-plate__copy">
          <strong>{row.label}</strong>
          <span>{row.sub}</span>
        </span>
        {row.supports.visibility && onToggle ? (
          <DeskSwitch on={row.on} onChange={onToggle} label={`${row.label} ${row.on ? 'on' : 'off'}`} disabled={!row.available} />
        ) : (
          <span className="mxd-plate__state">{STATUS_LABEL[row.status]}</span>
        )}
      </div>
      {row.reason ? <p className={cls('mxd-plate__reason', !row.available && 'is-blocked')}>{row.reason}</p> : null}
      {children && row.on && row.available ? <div className="mxd-plate__controls">{children}</div> : null}
    </div>
  )
}

export interface MapDeskLayersProps {
  input: SensorInput
  // properties
  onPins: (v: boolean) => void
  pinOpacity: number
  onPinOpacity: (v: number) => void
  performance: CommandMapPerformanceSettings
  onPerformance: (patch: Partial<CommandMapPerformanceSettings>) => void
  onEveryProperty: (v: boolean) => void
  filterSummary: string | null
  onEditFilters: () => void
  // market
  onLensVisible: (v: boolean) => void
  onChooseLens: () => void
  lensStyle: LensStyle
  lensBlend: number
  lensOpacity: number
  onLensLook: (next: { style?: LensStyle; blend?: number; opacity?: number }) => void
  onComps: (v: boolean) => void
  compFilters: CompFilters
  onCompWindow: (w: CompFilters['window']) => void
  compsTotal: string | null
  onCompFilters: () => void
  onMarket: (v: boolean) => void
  // world
  onDaylight: (v: boolean) => void
  onLocalTime: (v: boolean) => void
  onZones: (v: boolean) => void
  onBuildings: (v: boolean) => void
  onRelief: (v: boolean) => void
  onTilt: () => void
  // operations
  onActivity: (v: boolean) => void
  activityWindow: ActivityWindow
  onActivityWindow: (w: ActivityWindow) => void
  activityScope: ActivityScope
  onActivityScope: (s: ActivityScope) => void
  scopeCounts: Record<ActivityScope, number>
  onOrbs: (v: boolean) => void
}

export function MapDeskLayers(p: MapDeskLayersProps) {
  const groups = buildSensorArray(p.input)
  const byId = (id: string) => groups.flatMap((g) => g.rows).find((r) => r.id === id)!

  const render = (row: SensorRow): ReactNode => {
    switch (row.id) {
      case 'pins':
        return (
          <Plate key={row.id} row={row} onToggle={p.onPins}>
            <OpacitySlider value={p.pinOpacity} onChange={p.onPinOpacity} label="Property pins" />
            <div className="mxd-ctl is-stack">
              <span className="mxd-ctl__label">Density</span>
              <DeskSeg size="sm" label="Marker density" value={p.performance.markerDensity} onChange={(v) => p.onPerformance({ markerDensity: v })} options={[{ key: 'low', label: 'Sparse' }, { key: 'medium', label: 'Balanced' }, { key: 'high', label: 'Everything' }]} />
            </div>
          </Plate>
        )
      case 'dots':
        return <Plate key={row.id} row={row} onToggle={p.onEveryProperty} />
      case 'lens':
        return (
          <Plate key={row.id} row={row} onToggle={p.onLensVisible}>
            <button type="button" className="mxd-linkrow" onClick={p.onChooseLens} data-lens-trigger aria-haspopup="dialog">
              <span>Color by</span><strong>{p.input.lensLabel}</strong><Icon name="chevron-right" size={13} />
            </button>
            {row.supports.style ? (
              <div className="mxd-ctl is-stack">
                <span className="mxd-ctl__label">Style</span>
                <DeskSeg size="sm" label="Lens style" value={p.lensStyle} onChange={(v) => p.onLensLook({ style: v })} options={[{ key: 'dots', label: 'Dots' }, { key: 'surface', label: 'Surface' }, { key: 'areas', label: 'Areas' }]} />
              </div>
            ) : null}
            {row.supports.style && p.lensStyle === 'surface' ? (
              <label className="mxd-ctl">
                <span className="mxd-ctl__label">Blend</span>
                <input type="range" min={0} max={100} value={Math.round(p.lensBlend * 100)} onChange={(e) => p.onLensLook({ blend: Number(e.target.value) / 100 })} aria-label="Individual dots to one surface" className="mxd-range-input" style={{ ['--mxd-pct' as string]: `${Math.round(p.lensBlend * 100)}%` }} />
                <em className="mxd-ctl__value">{p.lensBlend < 0.34 ? 'Dots' : p.lensBlend > 0.66 ? 'Surface' : 'Mixed'}</em>
              </label>
            ) : null}
            {row.supports.opacity ? <OpacitySlider value={p.lensOpacity} onChange={(v) => p.onLensLook({ opacity: v })} label="Color lens" /> : null}
          </Plate>
        )
      case 'comps':
        return (
          <Plate key={row.id} row={{ ...row, sub: p.compsTotal ? `${p.compsTotal} sold around this view · ${row.sub}` : row.sub }} onToggle={p.onComps}>
            <div className="mxd-ctl is-stack">
              <span className="mxd-ctl__label">Time</span>
              <DeskSeg size="sm" label="Sold within" value={p.compFilters.window} onChange={p.onCompWindow} options={[{ key: '6m', label: '6 mo' }, { key: '12m', label: '12 mo' }, { key: '24m', label: '24 mo' }, { key: 'all', label: 'All' }]} />
            </div>
            <button type="button" className="mxd-linkrow" onClick={p.onCompFilters}>
              <span>Filters</span><strong>Source, buyer type, price, beds</strong><Icon name="chevron-right" size={13} />
            </button>
          </Plate>
        )
      case 'market': return <Plate key={row.id} row={row} onToggle={p.onMarket} />
      case 'daylight': return <Plate key={row.id} row={row} onToggle={p.onDaylight} />
      case 'localTime': return <Plate key={row.id} row={row} onToggle={p.onLocalTime} />
      case 'zones': return <Plate key={row.id} row={row} onToggle={p.onZones} />
      case 'buildings':
        return (
          <Plate key={row.id} row={row} onToggle={p.onBuildings}>
            {!p.input.tilted ? <button type="button" className="mxd-linkrow" onClick={p.onTilt}><span>View</span><strong>Tilt into 3D</strong><Icon name="chevron-right" size={13} /></button> : null}
          </Plate>
        )
      case 'relief': return <Plate key={row.id} row={row} onToggle={p.onRelief} />
      case 'cameras': return <Plate key={row.id} row={row} />
      case 'activity':
        return (
          <Plate key={row.id} row={row} onToggle={p.onActivity}>
            <div className="mxd-ctl is-stack">
              <span className="mxd-ctl__label">Time</span>
              <DeskSeg size="sm" label="Time window" value={p.activityWindow} onChange={p.onActivityWindow} options={ACTIVITY_WINDOWS} />
            </div>
            <div className="mxd-ctl is-stack">
              <span className="mxd-ctl__label">Show</span>
              <div className="mxd-chips is-tight">
                {ACTIVITY_SCOPES.filter((s) => s.key === 'all' || p.scopeCounts[s.key] > 0).map((s) => (
                  <button key={s.key} type="button" className={cls('mxd-chip', 'is-button', p.activityScope === s.key && 'is-on')} aria-pressed={p.activityScope === s.key} onClick={() => p.onActivityScope(s.key)}>
                    {s.label}<em>{p.scopeCounts[s.key]}</em>
                  </button>
                ))}
              </div>
            </div>
          </Plate>
        )
      case 'orbs':
        return (
          <Plate key={row.id} row={row} onToggle={p.onOrbs}>
            <p className="mxd-ctl__note">Time is fixed: orbs fade over the last 24 hours.</p>
          </Plate>
        )
      default:
        return null
    }
  }

  const filterRow = byId('pins') && (
    <div className="mxd-plate is-cohort" data-layer="filter">
      <div className="mxd-plate__row">
        <span className={cls('mxd-light', p.filterSummary ? 'is-on' : 'is-off')} aria-hidden="true" />
        <span className="mxd-plate__copy">
          <strong>Filter cohort</strong>
          <span>{p.filterSummary ?? 'No filter — every property draws'}</span>
        </span>
        <button type="button" className="mxd-btn is-sm" onClick={p.onEditFilters}>{p.filterSummary ? 'Edit' : 'Filter'}</button>
      </div>
    </div>
  )

  return (
    <div className="mxd-sensors">
      {groups.map((g) => (
        <section key={g.id} className="mxd-sensors__group" aria-label={g.label}>
          <header className="mxd-block__head"><h3>{g.label}</h3><em>{groupTally(g)}</em></header>
          <div className="mxd-plates">
            {g.rows.map(render)}
            {g.id === 'properties' ? filterRow : null}
          </div>
        </section>
      ))}
      <section className="mxd-sensors__group" aria-label="Performance">
        <header className="mxd-block__head"><h3>Rendering</h3><em>how the map draws</em></header>
        <div className="mxd-plate is-plain">
          <div className="mxd-ctl is-stack">
            <span className="mxd-ctl__label">Grouping</span>
            <DeskSeg size="sm" label="Grouping" value={p.performance.clusterAggressiveness} onChange={(v) => p.onPerformance({ clusterAggressiveness: v })} options={[{ key: 'low', label: 'Less' }, { key: 'medium', label: 'Balanced' }, { key: 'high', label: 'More' }]} />
          </div>
          <p className="mxd-ctl__note">Properties replace market bubbles from zoom {p.performance.clusterAggressiveness === 'high' ? 11 : p.performance.clusterAggressiveness === 'low' ? 9 : 10}.</p>
          <div className="mxd-ctl is-stack">
            <span className="mxd-ctl__label">Motion</span>
            <DeskSeg size="sm" label="Motion" value={p.performance.animation} onChange={(v) => p.onPerformance({ animation: v })} options={[{ key: 'full', label: 'Full' }, { key: 'reduced', label: 'Reduced' }, { key: 'off', label: 'Off' }]} />
          </div>
          <div className="mxd-ctl is-stack">
            <span className="mxd-ctl__label">Quality</span>
            <DeskSeg size="sm" label="Rendering" value={p.performance.performanceMode} onChange={(v) => p.onPerformance({ performanceMode: v })} options={[{ key: 'auto', label: 'Auto' }, { key: 'quality', label: 'Quality' }, { key: 'balanced', label: 'Balanced' }, { key: 'speed', label: 'Speed' }]} />
          </div>
        </div>
      </section>
    </div>
  )
}
