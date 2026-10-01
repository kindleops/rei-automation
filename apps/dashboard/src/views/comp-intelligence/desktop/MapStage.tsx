import type { ReactNode } from 'react'
import { LCButton, LCIconButton, LCSegmented, LCSelect, LCStatus, cx } from '../../../shared/lc'
import { fmtAge, fmtMoney, fmtUnitValue } from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Workstation } from './derive-workstation'
import { EvidenceMap, type CameraAction, type MapPoint } from './EvidenceMap'
import type { FocusStore } from './focus-store'
import { rampFor, type MapMode } from './map-style'

interface Props {
  m: Workstation
  points: MapPoint[]
  mode: MapMode
  onMode: (m: MapMode) => void
  domain: [number, number] | null
  imagery: boolean
  onImagery: () => void
  theme: string
  store: FocusStore
  onOpen: (key: string) => void
  camera: CameraAction | null
  onCamera: (kind: CameraAction['kind']) => void
  reduced: boolean
  mapReady: boolean
  onMapReady: () => void
  radius: number
  months: number
  onWindow: (radius: number | null, months: number | null) => void
  refreshing: boolean
  clustered: boolean
  children?: ReactNode
}

export function MapStage(p: Props) {
  const { m, mode } = p
  const engineWindow = m.w.query.engineWindow
  const radiusOptions = [...new Set([...m.w.query.radiusOptions, ...(engineWindow ? [engineWindow.radiusMiles] : [])])].sort((a, b) => a - b)
  const monthOptions = [...new Set([...m.w.query.monthOptions, ...(engineWindow ? [engineWindow.months] : [])])].sort((a, b) => a - b)
  const hasSubjectPin = m.w.subject.lat !== null && m.w.subject.lng !== null

  return (
    <div className="ciw-map" data-map={p.mapReady ? 'ready' : 'loading'}>
      <EvidenceMap
        subject={{ lat: m.w.subject.lat, lng: m.w.subject.lng, address: m.w.subject.address }}
        points={p.points}
        mode={mode}
        domain={p.domain}
        radiusMiles={p.radius}
        imagery={p.imagery}
        theme={p.theme}
        store={p.store}
        onOpen={p.onOpen}
        camera={p.camera}
        reduced={p.reduced}
        onReady={p.onMapReady}
      />

      <div className="ciw-maptop">
        <LCSegmented
          className="ciw-maplens"
          label="Map analysis"
          size="sm"
          value={mode}
          onChange={p.onMode}
          options={[
            { value: 'evidence', label: 'Evidence' },
            { value: 'ppsf', label: `$${m.metric.short}` },
            { value: 'price', label: 'Price' },
            { value: 'recency', label: 'Recency' },
            { value: 'score', label: 'Score' },
          ]}
        />
        <div className="ciw-window">
          <LCSelect
            label="Search radius"
            prefix="Within"
            variant="chip"
            size="sm"
            value={String(p.radius)}
            onChange={(v) => p.onWindow(Number(v), p.months)}
            options={radiusOptions.map((r) => ({ value: String(r), label: `${r} mi`, hint: engineWindow?.radiusMiles === r ? 'engine window' : undefined }))}
          />
          <LCSelect
            label="Sold within"
            prefix="Sold"
            variant="chip"
            size="sm"
            value={String(p.months)}
            onChange={(v) => p.onWindow(p.radius, Number(v))}
            options={monthOptions.map((mo) => ({ value: String(mo), label: `≤ ${mo} mo`, hint: engineWindow?.months === mo ? 'engine window' : undefined }))}
          />
          {engineWindow && (engineWindow.radiusMiles !== p.radius || engineWindow.months !== p.months) ? (
            <LCButton variant="ghost" size="sm" onClick={() => p.onWindow(null, null)}>Engine window</LCButton>
          ) : null}
          {p.refreshing ? <LCStatus state="running" label="Loading the search" /> : null}
        </div>
      </div>

      <div className="ciw-mapctl" role="toolbar" aria-label="Map controls" aria-orientation="vertical">
        <LCIconButton icon="target" label="Center on the subject" variant="glass" size="sm" tooltipSide="left" onClick={() => p.onCamera('subject')} disabled={!hasSubjectPin} />
        <LCIconButton icon="maximize" label="Fit the shown set" variant="glass" size="sm" tooltipSide="left" onClick={() => p.onCamera('set')} />
        <LCIconButton icon="radar" label="Fit the search radius" variant="glass" size="sm" tooltipSide="left" onClick={() => p.onCamera('search')} disabled={!hasSubjectPin} />
        <LCIconButton icon="globe" label={p.imagery ? 'Show streets' : 'Show imagery'} variant="glass" size="sm" tooltipSide="left" selected={p.imagery} onClick={p.onImagery} />
        <span className="ciw-mapctl__zoom">
          <LCButton variant="ghost" size="sm" aria-label="Zoom in" onClick={() => p.onCamera('zoomIn')}>+</LCButton>
          <LCButton variant="ghost" size="sm" aria-label="Zoom out" onClick={() => p.onCamera('zoomOut')}>−</LCButton>
        </span>
      </div>

      <MapLegend m={m} mode={mode} domain={p.domain} theme={p.imagery ? 'dark' : p.theme} clustered={p.clustered} />

      {!hasSubjectPin ? <div className="ciw-map__note" role="note">The subject has no recorded coordinates — distances come from the comp records.</div> : null}
      {p.children}
    </div>
  )
}

function MapLegend({ m, mode, domain, theme, clustered }: { m: Workstation; mode: MapMode; domain: [number, number] | null; theme: string; clustered: boolean }) {
  if (mode !== 'evidence' && domain) {
    const ramp = rampFor(theme === 'light' ? 'light' : 'dark')
    const colors = mode === 'recency' ? [...ramp].reverse() : ramp
    const fmt = (v: number) => mode === 'ppsf' ? `${fmtUnitValue(v, m.metric)}` : mode === 'price' ? fmtMoney(v) ?? '' : mode === 'recency' ? fmtAge(v) ?? '' : `${Math.round(v)}`
    const title = mode === 'ppsf' ? `${m.metric.label} as sold` : mode === 'price' ? 'Sale price' : mode === 'recency' ? 'Sale age — recent is strongest' : 'Engine comparability score'
    return (
      <div className="ciw-legend" aria-label={`Legend: ${title}`}>
        <span className="ciw-legend__title">{title}</span>
        <span className="ciw-legend__ramp" style={{ background: `linear-gradient(90deg, ${colors.join(', ')})` }} aria-hidden="true" />
        <span className="ciw-legend__ends lc-num"><span>≤ {fmt(domain[0])}</span><span>≥ {fmt(domain[1])}</span></span>
        <span className="ciw-legend__foot">5th–95th percentile of the sales shown · ringed hollow = excluded (no value)</span>
      </div>
    )
  }
  return (
    <div className="ciw-legend" aria-label="Legend: evidence">
      <span className="ciw-legend__title">Evidence</span>
      <ul className="ciw-legend__keys">
        <li><i className="k-subject" aria-hidden="true" />Subject</li>
        <li><i className="k-set" aria-hidden="true" />{m.lens === 'operator' ? 'Your set' : 'System set'}</li>
        {m.added.size ? <li><i className="k-added" aria-hidden="true" />Added by you</li> : null}
        {m.removed.length ? <li><i className="k-removed" aria-hidden="true" />Removed by you</li> : null}
        <li><i className="k-cand" aria-hidden="true" />Candidate</li>
        <li><i className="k-excl" aria-hidden="true" />Excluded</li>
        {m.band ? <li><i className="k-flag" aria-hidden="true" />Outside outlier band</li> : null}
        {clustered ? <li><i className="k-cluster" aria-hidden="true" />Cluster — click to open</li> : null}
        <li><i className={cx('k-ring')} aria-hidden="true" />Search radius</li>
      </ul>
    </div>
  )
}
