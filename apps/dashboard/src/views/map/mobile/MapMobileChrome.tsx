/**
 * Mobile Map chrome.
 *
 * The map is the surface. On a phone the only permanent chrome is:
 *   · a context pill (mode · properties in view) — opens Layers
 *   · a floating control stack (layers · filters · activity · recenter)
 *   · when Live Activity is on, one compact peek bar
 * Everything else — mode, appearance, intelligence, advanced/performance,
 * activity feed — lives in sheets. The desktop MODES / FILTERS / STYLE /
 * INTEL / PERF panel is never rendered on a phone.
 *
 * All state is the Command Map's own (passed in); this component owns only
 * which sheet is open, the activity scope/window, and the activity overlay
 * layers it draws on the map.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import maplibregl from 'maplibre-gl'
import { Icon } from '../../../shared/icons'
import type { LiveActivityEvent } from '../live-activity-engine'
import type { CommandMapPerformanceSettings } from '../commandMapLiveActivity'
import {
  ACTIVITY_SCOPES,
  ACTIVITY_WINDOWS,
  APPEARANCE_GROUPS,
  buildMarkerEmphasisExpr,
  eventAction,
  eventTime,
  filterActivity,
  groupByPlace,
  newEventIds,
  precisionForZoom,
  scopeCounts,
  tierOf,
  timeAgo,
  type ActivityScope,
  type ActivityWindow,
  type ActivityTier,
} from './map-mobile-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type SheetKey = 'layers' | 'activity' | null
type LayersTab = 'mode' | 'appearance' | 'intel' | 'advanced'

export interface MapMobileChromeProps {
  map: maplibregl.Map | null
  mapEpoch: number
  modes: ReadonlyArray<{ key: string; label: string; description: string; swatches: string[] }>
  mode: string
  onMode: (key: string) => void
  themes: ReadonlyArray<{ id: string; label: string; accentColor: string }>
  styleMode: string
  onStyle: (id: string) => void
  dimension: '2d' | '3d'
  onDimension: (d: '2d' | '3d') => void
  filterCount: number
  onOpenFilters: () => void
  activityEvents: LiveActivityEvent[]
  onSelectEvent: (event: LiveActivityEvent) => void
  showMapKey: boolean
  onShowMapKey: (v: boolean) => void
  showCensusDock: boolean
  onShowCensusDock: (v: boolean) => void
  performance: CommandMapPerformanceSettings
  onPerformance: (patch: Partial<CommandMapPerformanceSettings>) => void
  /** A property card is open: controls step aside and the activity peek hides. */
  cardOpen: boolean
  selectedLngLat: [number, number] | null
  reducedMotion: boolean
  /** Base style or pins still arriving. */
  loading?: boolean
  /** Bounds of the operator's live sellers — the home view. */
  homeBounds?: [[number, number], [number, number]] | null
}

const ACTIVITY_STORE = 'nexus.map.mobileActivity'
const readActivityPref = (): { on: boolean; scope: ActivityScope; window: ActivityWindow } => {
  try {
    const v = JSON.parse(localStorage.getItem(ACTIVITY_STORE) || '{}')
    return { on: Boolean(v.on), scope: v.scope || 'all', window: v.window || 'today' }
  } catch { return { on: false, scope: 'all', window: 'today' } }
}

const TIER_LABEL: Record<ActivityTier, string> = { critical: 'Needs attention', important: 'Important', normal: 'Activity', background: 'Background' }

// ── Sheet ────────────────────────────────────────────────────────────────────

function MapSheet({ title, onClose, children, className, header }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  className?: string
  header?: React.ReactNode
}) {
  const [closing, setClosing] = useState(false)
  const dismiss = useCallback(() => { setClosing(true); window.setTimeout(onClose, 180) }, [onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])
  return createPortal(
    <div className={cls('mx-sheet', className, closing && 'is-closing')} role="presentation">
      <button type="button" className="mx-sheet__backdrop" aria-label="Close" onClick={dismiss} />
      <section className="mx-sheet__panel" role="dialog" aria-modal="true" aria-label={title}>
        <span className="mx-sheet__grip" aria-hidden="true" />
        <header className="mx-sheet__head">
          <strong>{title}</strong>
          {header}
          <button type="button" className="mx-btn is-sm" onClick={dismiss} aria-label="Close" data-map-sheet-close>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="mx-sheet__body">{children}</div>
      </section>
    </div>,
    document.body,
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: ReadonlyArray<{ key: T; label: string; count?: number }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="mx-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" role="tab" aria-selected={value === o.key} className={cls('mx-seg__tab', value === o.key && 'is-active')} onClick={() => onChange(o.key)}>
          {o.label}
          {typeof o.count === 'number' && <em>{o.count}</em>}
        </button>
      ))}
    </div>
  )
}

function Toggle({ label, sub, on, onChange }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="mx-row" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="mx-row__copy"><strong>{label}</strong>{sub && <span>{sub}</span>}</span>
      <span className={cls('mx-switch', on && 'is-on')} aria-hidden="true"><span /></span>
    </button>
  )
}

// ── Chrome ───────────────────────────────────────────────────────────────────

export function MapMobileChrome(props: MapMobileChromeProps) {
  const {
    map, mapEpoch, modes, mode, onMode, themes, styleMode, onStyle, dimension, onDimension,
    filterCount, onOpenFilters, activityEvents, onSelectEvent, showMapKey, onShowMapKey,
    showCensusDock, onShowCensusDock, performance, onPerformance, cardOpen, selectedLngLat, reducedMotion, loading, homeBounds,
  } = props

  const [sheet, setSheet] = useState<SheetKey>(null)
  const [layersTab, setLayersTab] = useState<LayersTab>('mode')
  const initial = useMemo(readActivityPref, [])
  const [activityOn, setActivityOn] = useState(initial.on)
  const [scope, setScope] = useState<ActivityScope>(initial.scope)
  const [window_, setWindow] = useState<ActivityWindow>(initial.window)
  const [openEvent, setOpenEvent] = useState<LiveActivityEvent | null>(null)
  const [inView, setInView] = useState<number | null>(null)
  const [zoom, setZoom] = useState(() => map?.getZoom() ?? 4)
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    try { localStorage.setItem(ACTIVITY_STORE, JSON.stringify({ on: activityOn, scope, window: window_ })) } catch { /* private mode */ }
  }, [activityOn, scope, window_])

  // Relative times tick once a minute; nothing else animates on a timer.
  useEffect(() => {
    const t = window.setInterval(() => setClock(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  // Properties in view: the rendered property markers, de-duplicated by id.
  useEffect(() => {
    if (!map) return
    let raf = 0
    const count = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          const layers = ['prop-tiles-hit', 'command-pin-core-raw'].filter((l) => map.getLayer(l))
          if (!layers.length) { setInView(null); return }
          const ids = new Set<string>()
          for (const f of map.queryRenderedFeatures({ layers })) {
            const id = String((f.properties as Record<string, unknown>)?.property_id ?? (f.properties as Record<string, unknown>)?.conversation_id ?? f.id ?? '')
            if (id) ids.add(id)
          }
          setInView(ids.size)
          setZoom(map.getZoom())
        } catch { /* style reloading */ }
      })
    }
    // The map's own pulse animation keeps it from ever going 'idle', so count
    // on camera stops and when property data finishes arriving.
    const onData = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e?.isSourceLoaded && (e.sourceId === 'property-map-tiles' || e.sourceId === 'command-pins-raw')) count()
    }
    map.on('moveend', count)
    map.on('sourcedata', onData)
    count()
    return () => { map.off('moveend', count); map.off('sourcedata', onData); cancelAnimationFrame(raf) }
  }, [map, mapEpoch])

  // ── Marker hierarchy (mobile) ──────────────────────────────────────────────
  // Selected and live properties keep full strength; properties with a stage
  // ring (a real conversation) stay clear; the untouched universe goes quiet.
  // Uses only the feature-state the map already writes — no new scoring. The
  // constant pulse is switched off: new activity pulses once, from the overlay.
  useEffect(() => {
    if (!map) return
    const originals = new Map<string, unknown>()
    const applied = new Map<string, string>()
    const QUIET = buildMarkerEmphasisExpr()
    const TARGETS: Array<[string, string]> = [
      ['prop-tiles-glass', 'circle-opacity'],
      ['prop-tiles-ring', 'circle-stroke-opacity'],
      ['prop-tiles-icon', 'icon-opacity'],
    ]
    const apply = () => {
      try {
        for (const [layer, prop] of TARGETS) {
          if (!map.getLayer(layer)) continue
          const current = map.getPaintProperty(layer, prop as never)
          const key = `${layer}:${prop}`
          if (applied.get(key) === JSON.stringify(current)) continue
          if (!originals.has(key)) originals.set(key, current ?? 1)
          const next = ['*', originals.get(key) ?? 1, QUIET]
          map.setPaintProperty(layer, prop as never, next as never)
          applied.set(key, JSON.stringify(map.getPaintProperty(layer, prop as never)))
        }
        if (map.getLayer('prop-tiles-pulse')) map.setPaintProperty('prop-tiles-pulse', 'circle-opacity', 0)
      } catch { /* layer mid-reload */ }
    }
    const onTiles = (e: { sourceId?: string; isSourceLoaded?: boolean }) => { if (e?.sourceId === 'property-map-tiles') apply() }
    apply()
    map.on('styledata', apply)
    map.on('sourcedata', onTiles)
    return () => { map.off('styledata', apply); map.off('sourcedata', onTiles) }
  }, [map, mapEpoch])

  const now = useMemo(() => new Date(clock), [clock])
  const events = useMemo(() => filterActivity(activityEvents, { scope, window: window_, now }), [activityEvents, scope, window_, now])
  const counts = useMemo(() => scopeCounts(activityEvents, window_, now), [activityEvents, window_, now])
  const latest = events[0] ?? null

  // ── Activity overlay on the map ────────────────────────────────────────────
  const SRC = 'nx-mx-activity'
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      if (!map.style) return
      if (!map.getSource(SRC)) {
        map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: `${SRC}-halo`, type: 'circle', source: SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 14, 10, 22, 50, 30],
            'circle-color': ['match', ['get', 'tier'], 'critical', '#ff453a', 'important', '#ff9f0a', 'normal', '#5ee7ff', '#8e8e93'],
            'circle-opacity': 0.16,
            'circle-blur': 0.5,
          },
        })
        map.addLayer({
          id: `${SRC}-core`, type: 'circle', source: SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 6, 10, 10, 50, 14],
            'circle-color': ['match', ['get', 'tier'], 'critical', '#ff453a', 'important', '#ff9f0a', 'normal', '#5ee7ff', '#8e8e93'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-opacity': 0.95,
          },
        })
        map.addLayer({
          id: `${SRC}-count`, type: 'symbol', source: SRC,
          filter: ['>', ['get', 'count'], 1],
          layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': 11, 'text-font': ['Open Sans Bold'], 'text-allow-overlap': true },
          paint: { 'text-color': '#05070b' },
        })
      }
    }
    try { if (map.isStyleLoaded()) ensure(); else map.once('styledata', ensure) } catch { /* ignore */ }
    const reapply = () => { try { ensure() } catch { /* ignore */ } }
    map.on('styledata', reapply)
    return () => { map.off('styledata', reapply) }
  }, [map, mapEpoch])

  const places = useMemo(() => (activityOn ? groupByPlace(events, precisionForZoom(zoom)) : []), [activityOn, events, zoom])
  useEffect(() => {
    if (!map || !map.style) return
    let src: maplibregl.GeoJSONSource | undefined
    try { src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined } catch { return }
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: places.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { key: p.key, count: p.events.length, tier: p.tier },
      })),
    })
    const vis = activityOn ? 'visible' : 'none'
    try {
      for (const l of [`${SRC}-halo`, `${SRC}-core`, `${SRC}-count`]) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', vis)
    } catch { /* map replaced */ }
  }, [map, places, activityOn, mapEpoch])

  // Tap an activity marker → its event (or the feed, scoped to that place).
  const placesRef = useRef(places)
  placesRef.current = places
  useEffect(() => {
    if (!map) return
    const onClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const key = e.features?.[0]?.properties?.key
      const place = placesRef.current.find((p) => p.key === key)
      if (!place) return
      if (place.events.length === 1) setOpenEvent(place.events[0])
      else { setSheet('activity') }
    }
    const layer = `${SRC}-core`
    map.on('click', layer, onClick)
    return () => { map.off('click', layer, onClick) }
  }, [map, mapEpoch])

  // A new event arrives: one pulse at its place. No auto-pan, ever.
  const seenRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!map || !activityOn) return
    if (seenRef.current === null) { seenRef.current = new Set(events.map((e) => e.id)); return }
    const fresh = newEventIds(seenRef.current, events)
    for (const id of fresh) seenRef.current.add(id)
    if (reducedMotion) return
    for (const id of fresh.slice(0, 6)) {
      const ev = events.find((e) => e.id === id)
      if (!ev || typeof ev.lng !== 'number' || typeof ev.lat !== 'number') continue
      const el = document.createElement('span')
      el.className = `mx-pulse tier-${tierOf(ev)}`
      const marker = new maplibregl.Marker({ element: el }).setLngLat([ev.lng, ev.lat]).addTo(map)
      window.setTimeout(() => marker.remove(), 1800)
    }
  }, [map, events, activityOn, reducedMotion])

  const fitHome = useCallback((animate: boolean) => {
    if (!map || !homeBounds) return false
    const [[w, s], [e, n]] = homeBounds
    const top = 130
    map.fitBounds([[w, s], [e, n]], {
      padding: { top, bottom: 170, left: 40, right: 72 },
      maxZoom: 10,
      duration: animate && !reducedMotion ? 900 : 0,
    })
    return true
  }, [map, homeBounds, reducedMotion])

  // First arrival: frame the operator's live sellers — once, and only if the
  // operator hasn't already moved the map or selected a property.
  const framedRef = useRef(false)
  const userMovedRef = useRef(false)
  useEffect(() => {
    if (!map) return
    const mark = (e: { originalEvent?: unknown }) => { if (e?.originalEvent) userMovedRef.current = true }
    map.on('dragstart', mark); map.on('zoomstart', mark)
    return () => { map.off('dragstart', mark); map.off('zoomstart', mark) }
  }, [map, mapEpoch])
  useEffect(() => {
    if (framedRef.current || userMovedRef.current || selectedLngLat || !homeBounds || !map) return
    framedRef.current = fitHome(false)
  }, [map, homeBounds, selectedLngLat, fitHome])

  // ── Selected marker: unmistakable, calm ───────────────────────────────────
  // An accent ring + soft glow above every property marker, scaled in once on
  // selection. No continuous pulse.
  const SEL = 'nx-mx-selected'
  useEffect(() => {
    if (!map) return
    const ensure = () => {
      try {
        if (!map.getSource(SEL)) {
          map.addSource(SEL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          const accent = getComputedStyle(document.documentElement).getPropertyValue('--nexus-accent').trim() || '#38bdf8'
          map.addLayer({ id: `${SEL}-glow`, type: 'circle', source: SEL, paint: { 'circle-radius': 26, 'circle-color': accent, 'circle-opacity': 0.18, 'circle-blur': 0.6 } })
          map.addLayer({ id: `${SEL}-ring`, type: 'circle', source: SEL, paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': accent, 'circle-stroke-width': 3, 'circle-stroke-opacity': 1 } })
          map.addLayer({ id: `${SEL}-dot`, type: 'circle', source: SEL, paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-color': accent, 'circle-stroke-width': 2 } })
        }
      } catch { /* style reloading */ }
    }
    ensure()
    map.on('styledata', ensure)
    return () => { map.off('styledata', ensure) }
  }, [map, mapEpoch])
  useEffect(() => {
    if (!map || !map.style) return
    let src: maplibregl.GeoJSONSource | undefined
    try { src = map.getSource(SEL) as maplibregl.GeoJSONSource | undefined } catch { return }
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: selectedLngLat ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: selectedLngLat }, properties: {} }] : [],
    })
    if (!selectedLngLat || reducedMotion) return
    // One arrival: the ring settles from a little larger, once.
    let frame = 0
    const start = window.performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 420)
      const e = 1 - Math.pow(1 - k, 3)
      try {
        map.setPaintProperty(`${SEL}-ring`, 'circle-radius', 15 + (1 - e) * 10)
        map.setPaintProperty(`${SEL}-glow`, 'circle-opacity', 0.18 + (1 - e) * 0.2)
      } catch { return }
      if (k < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [map, mapEpoch, selectedLngLat?.[0], selectedLngLat?.[1], reducedMotion])

  const recenter = () => {
    if (!map) return
    if (selectedLngLat) { map.easeTo({ center: selectedLngLat, duration: reducedMotion ? 0 : 650 }); return }
    if (fitHome(true)) return
    map.easeTo({ center: [-96, 37.5], zoom: 3.6, duration: reducedMotion ? 0 : 900 })
  }

  const activeMode = modes.find((m) => m.key === mode)
  const activeTheme = themes.find((t) => t.id === styleMode)

  return (
    <div className={cls('mx', cardOpen && 'has-card', activityOn && 'is-activity')}>
      <div className="mx-top">
        <button type="button" className="mx-context" data-map-control="mode" onClick={() => { setLayersTab('mode'); setSheet('layers') }}>
          <span className="mx-context__swatch" aria-hidden="true">
            {(activeMode?.swatches ?? []).slice(0, 3).map((c) => <i key={c} style={{ background: c }} />)}
          </span>
          <span className="mx-context__copy">
            <strong>{activeMode?.label ?? 'Map'}</strong>
            <span>
              {inView === null
                ? 'Loading properties…'
                : inView === 0
                  ? (loading ? 'Updating…' : zoom < 9 ? 'Zoom in to see properties' : 'No properties in this view')
                  : `${inView.toLocaleString()} in view${loading ? ' · updating' : ''}`}
            </span>
          </span>
          <Icon name="chevron-down" size={13} />
        </button>
        {filterCount > 0 && (
          <button type="button" className="mx-chip" onClick={onOpenFilters} data-map-control="filter-summary">
            <Icon name="filter" size={12} /> Filters · {filterCount}
          </button>
        )}
      </div>

      <div className="mx-stack" role="toolbar" aria-label="Map controls">
        <button type="button" className="mx-btn" aria-label="Layers and map mode" data-map-control="layers" onClick={() => { setLayersTab('mode'); setSheet('layers') }}>
          <Icon name="layers" size={18} />
        </button>
        <button type="button" className={cls('mx-btn', filterCount > 0 && 'is-lit')} aria-label={filterCount > 0 ? `Filters, ${filterCount} active` : 'Filters'} data-map-control="filters" onClick={onOpenFilters}>
          <Icon name="filter" size={17} />
          {filterCount > 0 && <span className="mx-btn__badge">{filterCount}</span>}
        </button>
        <button type="button" className={cls('mx-btn', activityOn && 'is-lit')} aria-label={activityOn ? 'Live Activity on' : 'Live Activity'} aria-pressed={activityOn} data-map-control="activity" onClick={() => { if (!activityOn) { setActivityOn(true) } else { setSheet('activity') } }}>
          <Icon name="activity" size={18} />
          {activityOn && <span className="mx-live" aria-hidden="true" />}
        </button>
        <button type="button" className="mx-btn" aria-label={selectedLngLat ? 'Center on selected property' : homeBounds ? 'Show your active sellers' : 'Show the whole country'} data-map-control="recenter" onClick={recenter}>
          <Icon name="target" size={17} />
        </button>
      </div>

      {activityOn && !cardOpen && (
        <button type="button" className="mx-peek" data-map-control="activity-feed" onClick={() => setSheet('activity')}>
          <span className={cls('mx-peek__dot', latest && `tier-${tierOf(latest)}`)} aria-hidden="true" />
          <span className="mx-peek__copy">
            <strong>{latest ? latest.title : 'Live Activity'}</strong>
            <span>{latest ? [latest.address || latest.market, timeAgo(eventTime(latest), clock)].filter(Boolean).join(' · ') : `No activity · ${ACTIVITY_WINDOWS.find((w) => w.key === window_)?.label}`}</span>
          </span>
          <span className="mx-peek__count">{events.length}</span>
        </button>
      )}

      {openEvent && (
        <div className="mx-event" role="dialog" aria-label={openEvent.title}>
          <div className="mx-event__head">
            <span className={cls('mx-tier', `tier-${tierOf(openEvent)}`)}>{TIER_LABEL[tierOf(openEvent)]}</span>
            <button type="button" className="mx-btn is-sm" aria-label="Close" data-map-sheet-close onClick={() => setOpenEvent(null)}><Icon name="close" size={13} /></button>
          </div>
          <strong className="mx-event__title">{openEvent.title}</strong>
          {(openEvent.detail || openEvent.subtitle) && <p className="mx-event__detail">{openEvent.detail || openEvent.subtitle}</p>}
          <p className="mx-event__meta">{[openEvent.address || openEvent.market, timeAgo(eventTime(openEvent), clock) && `${timeAgo(eventTime(openEvent), clock)} ago`].filter(Boolean).join(' · ')}</p>
          {eventAction(openEvent) && (
            <button type="button" className="mx-act is-primary" onClick={() => { const e = openEvent; setOpenEvent(null); onSelectEvent(e) }}>
              {eventAction(openEvent)!.label}
            </button>
          )}
        </div>
      )}

      {sheet === 'layers' && (
        <MapSheet title="Map" onClose={() => setSheet(null)} className="mx-layers">
          <Segmented<LayersTab>
            value={layersTab}
            onChange={setLayersTab}
            label="Map settings"
            options={[{ key: 'mode', label: 'Mode' }, { key: 'appearance', label: 'Appearance' }, { key: 'intel', label: 'Intel' }, { key: 'advanced', label: 'Advanced' }]}
          />
          {layersTab === 'mode' && (
            <div className="mx-list">
              {modes.map((m) => (
                <button key={m.key} type="button" className={cls('mx-mode', m.key === mode && 'is-active')} aria-pressed={m.key === mode} onClick={() => { onMode(m.key); setSheet(null) }}>
                  <span className="mx-mode__swatch" aria-hidden="true">{m.swatches.slice(0, 3).map((c) => <i key={c} style={{ background: c }} />)}</span>
                  <span className="mx-row__copy"><strong>{m.label}</strong><span>{m.description}</span></span>
                  {m.key === mode && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
          )}
          {layersTab === 'appearance' && (
            <>
              {APPEARANCE_GROUPS.map((g) => {
                const items = g.ids.map((id) => themes.find((t) => t.id === id)).filter(Boolean) as MapMobileChromeProps['themes'][number][]
                if (!items.length) return null
                return (
                  <section key={g.label} className="mx-block">
                    <h3>{g.label}</h3>
                    <div className="mx-tiles">
                      {items.map((t) => (
                        <button key={t.id} type="button" className={cls('mx-tile', t.id === styleMode && 'is-active')} aria-pressed={t.id === styleMode} onClick={() => onStyle(t.id)} data-theme-id={t.id}>
                          <span className="mx-tile__chip" style={{ background: t.accentColor }} aria-hidden="true" />
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </section>
                )
              })}
              <section className="mx-block">
                <h3>Perspective</h3>
                <Segmented<'2d' | '3d'> value={dimension} onChange={onDimension} label="Perspective" options={[{ key: '2d', label: 'Flat' }, { key: '3d', label: 'Tilted' }]} />
              </section>
            </>
          )}
          {layersTab === 'intel' && (
            <div className="mx-list">
              <Toggle label="Map key" sub="What marker colours and icons mean" on={showMapKey} onChange={onShowMapKey} />
              <Toggle label="Census panel" sub="Demographics for the area in view" on={showCensusDock} onChange={onShowCensusDock} />
            </div>
          )}
          {layersTab === 'advanced' && (
            <>
              <p className="mx-note">Rendering controls for slower phones. Defaults are tuned for this device.</p>
              <section className="mx-block">
                <h3>Marker density</h3>
                <Segmented value={performance.markerDensity} onChange={(v) => onPerformance({ markerDensity: v })} label="Marker density" options={[{ key: 'low', label: 'Sparse' }, { key: 'medium', label: 'Balanced' }, { key: 'high', label: 'Everything' }]} />
              </section>
              <section className="mx-block">
                <h3>Motion</h3>
                <Segmented value={performance.animation} onChange={(v) => onPerformance({ animation: v })} label="Motion" options={[{ key: 'full', label: 'Full' }, { key: 'reduced', label: 'Reduced' }, { key: 'off', label: 'Off' }]} />
              </section>
              <section className="mx-block">
                <h3>Grouping</h3>
                <Segmented value={performance.clusterAggressiveness} onChange={(v) => onPerformance({ clusterAggressiveness: v })} label="Grouping" options={[{ key: 'low', label: 'Less' }, { key: 'medium', label: 'Balanced' }, { key: 'high', label: 'More' }]} />
              </section>
              <section className="mx-block">
                <h3>Rendering</h3>
                <Segmented value={performance.performanceMode} onChange={(v) => onPerformance({ performanceMode: v })} label="Rendering" options={[{ key: 'auto', label: 'Auto' }, { key: 'quality', label: 'Quality' }, { key: 'balanced', label: 'Balanced' }, { key: 'speed', label: 'Speed' }]} />
              </section>
            </>
          )}
          <p className="mx-foot">{activeTheme ? `${activeTheme.label} · ` : ''}{activeMode?.label}</p>
        </MapSheet>
      )}

      {sheet === 'activity' && (
        <MapSheet
          title="Live Activity"
          onClose={() => setSheet(null)}
          className="mx-activity-sheet"
          header={(
            <button type="button" className={cls('mx-switch', 'is-inline', activityOn && 'is-on')} role="switch" aria-checked={activityOn} aria-label="Show activity on the map" onClick={() => setActivityOn((v) => !v)}>
              <span />
            </button>
          )}
        >
          <Segmented<ActivityWindow> value={window_} onChange={setWindow} label="Time window" options={ACTIVITY_WINDOWS} />
          <div className="mx-chips">
            {ACTIVITY_SCOPES.filter((s) => s.key === 'all' || counts[s.key] > 0).map((s) => (
              <button key={s.key} type="button" className={cls('mx-chiptab', scope === s.key && 'is-active')} aria-pressed={scope === s.key} onClick={() => setScope(s.key)}>
                {s.label}<em>{counts[s.key]}</em>
              </button>
            ))}
          </div>
          {events.length === 0 ? (
            <div className="mx-empty">
              <Icon name="activity" size={18} />
              <strong>Quiet</strong>
              <span>No {scope === 'all' ? '' : `${ACTIVITY_SCOPES.find((s) => s.key === scope)?.label.toLowerCase()} `}activity in this window.</span>
            </div>
          ) : (
            <ol className="mx-feed">
              {events.slice(0, 80).map((e) => {
                const action = eventAction(e)
                return (
                  <li key={e.id}>
                    <button type="button" className={cls('mx-feedrow', `tier-${tierOf(e)}`)} data-activity-row onClick={() => { setSheet(null); setOpenEvent(e) }}>
                      <span className="mx-feedrow__dot" aria-hidden="true" />
                      <span className="mx-row__copy">
                        <strong>{e.title}</strong>
                        <span>{[e.address || e.market || e.subtitle, action ? null : 'No location'].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="mx-feedrow__time">{timeAgo(eventTime(e), clock)}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </MapSheet>
      )}
    </div>
  )
}
