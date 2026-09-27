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
import { clearActiveContext } from '../../../domain/locator/active-context'
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
  mergeActivity,
  newEventIds,
  precisionForZoom,
  scopeCounts,
  tierOf,
  timeAgo,
  agoLabel,
  type ActivityScope,
  type ActivityWindow,
} from './map-mobile-model'
import { LENS_FAMILIES, MAP_LENSES, formatLensValue, lensById, type LensStyle, type MapLens } from './map-lenses'
import { lensValueAt, useMapLens } from './useMapLens'
import { HYBRID_THEMES, useMapImagery } from './useMapImagery'
import { LensLegend, MarketPanel, rampGradient } from './MapIntelCards'
import { useRealtimeActivity } from './useRealtimeActivity'
import { MapAreaTool } from './MapAreaTool'
import { dotsInView, usePropertyDots } from './usePropertyDots'
import { LiquidGlassControls } from '../../../shared/LiquidGlassControls'
import { BUYER_CLASS_LABEL, COMP_LAYERS, COMP_SOURCE_LABEL, DEFAULT_COMP_FILTERS, activeCompFilterCount, loadCompsInBox, useSoldComps, type CompFilters, type CompRow } from './useSoldComps'
import { CompFiltersPanel, MapCompCard } from './MapCompCard'
import { MapSearch } from './MapSearch'
import { MapEventCard } from './MapEventCard'
import { landEvent, useLiveOrbs } from './useLiveOrbs'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type SheetKey = 'layers' | 'activity' | 'comps' | null
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

/** Phone-only map preferences: the active lens and what floats on the map. */
const LENS_STORE = 'nexus.map.mobileLens'
interface LensPrefs { lens: string; mapKey: boolean; market: boolean; modePill: boolean; labels: boolean; relief: boolean; trueColor: boolean; everyProperty: boolean; comps: boolean; compFilters: CompFilters; lensStyle: LensStyle; lensBlend: number; liveOrbs: boolean; pins: boolean }
const LENS_DEFAULTS: LensPrefs = { lens: 'radar', mapKey: true, market: false, modePill: true, labels: true, relief: false, trueColor: true, everyProperty: true, comps: false, compFilters: DEFAULT_COMP_FILTERS, lensStyle: 'surface', lensBlend: 0.7, liveOrbs: true, pins: true }
const readLensPrefs = (): LensPrefs => {
  try { return { ...LENS_DEFAULTS, ...JSON.parse(localStorage.getItem(LENS_STORE) || '{}') } } catch { return LENS_DEFAULTS }
}

export { agoLabel } from './map-mobile-model'

const STAGE_SWATCH = ['#29E68B', '#FF893D', '#FF4C55']
const lensSwatch = (lens: MapLens) => (lens.source && !lens.ambient ? undefined : STAGE_SWATCH)


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
    map, mapEpoch, mode, onMode, themes, styleMode, onStyle, dimension, onDimension,
    filterCount, onOpenFilters, activityEvents, onSelectEvent,
    performance, onPerformance, cardOpen, selectedLngLat, reducedMotion, loading, homeBounds,
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
  const [prefs, setPrefs] = useState<LensPrefs>(readLensPrefs)
  const [drawing, setDrawing] = useState(false)
  const [searchActive, setSearchActive] = useState(false)
  const openSearchProperty = useCallback((hit: { propertyId: string; lng: number; lat: number; label: string }) => {
    onSelectEvent({
      id: `search:${hit.propertyId}`, type: 'new_reply', priority: 'normal', title: hit.label, severity: 'info', channel: 'context',
      summary: hit.label, primaryAction: 'Show on map', secondaryAction: null, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      source: 'search', isUnread: false, isPinned: false, isAcknowledged: true, rankScore: 0, isGlobalCritical: false,
      lat: hit.lat, lng: hit.lng, targetType: 'seller', targetId: hit.propertyId, propertyId: hit.propertyId, address: hit.label,
    } as LiveActivityEvent)
  }, [onSelectEvent])
  const setPref = useCallback(<K extends keyof LensPrefs>(k: K, v: LensPrefs[K]) => setPrefs((p) => ({ ...p, [k]: v })), [])
  useEffect(() => { try { localStorage.setItem(LENS_STORE, JSON.stringify(prefs)) } catch { /* private mode */ } }, [prefs])

  // ── Intelligence lens ──────────────────────────────────────────────────────
  const lens = lensById(prefs.lens)
  const lensLook = useMemo(() => ({ style: prefs.lensStyle, blend: prefs.lensBlend }), [prefs.lensStyle, prefs.lensBlend])
  const lensState = useMapLens(map, mapEpoch, lens, lensLook)
  usePropertyDots(map, mapEpoch, prefs.pins && prefs.everyProperty, (prefs.pins && prefs.everyProperty) || (Boolean(lens.source) && !lens.ambient), openSearchProperty, reducedMotion, lens.id === 'radar')
  // Property pins on/off: every property layer, over any lens.
  useEffect(() => {
    if (!map) return
    // EVERY property marker family, not just the vector tiles: the seller-thread
    // pins, the property universe and the count bubbles are separate layers, and
    // a toggle that left them up looked like it did nothing. The gold star (the
    // selected subject) is deliberately not in the list.
    const PIN_PREFIXES = ['prop-tiles-', 'prop-univ-', 'seller-pins-', 'command-pin-', 'map-agg-cluster-']
    const hidden = new Set<string>()
    const apply = () => {
      let layers: Array<{ id: string }> = []
      try { layers = map.getStyle().layers ?? [] } catch { return }
      for (const { id } of layers) {
        if (!PIN_PREFIXES.some((p) => id.startsWith(p))) continue
        try {
          const cur = map.getLayoutProperty(id, 'visibility')
          if (!prefs.pins) {
            if (cur !== 'none') { map.setLayoutProperty(id, 'visibility', 'none'); hidden.add(id) }
          } else if (hidden.has(id) || id.startsWith('prop-tiles-')) {
            if (cur === 'none') map.setLayoutProperty(id, 'visibility', 'visible')
            hidden.delete(id)
          }
        } catch { /* ignore */ }
      }
    }
    apply()
    map.on('styledata', apply)
    const t = window.setInterval(apply, 1500)
    return () => { map.off('styledata', apply); window.clearInterval(t) }
  }, [map, mapEpoch, prefs.pins])
  // Sold comps: on with the toggle, and always under a comps lens.
  const compsOn = prefs.comps
  const comps = useSoldComps(map, mapEpoch, compsOn, { ...DEFAULT_COMP_FILTERS, ...prefs.compFilters })
  const [compId, setCompId] = useState<string | null>(null)
  const [compList, setCompList] = useState<{ rows: CompRow[]; loading: boolean; n: number } | null>(null)
  const compFiltersRef = useRef(prefs.compFilters)
  compFiltersRef.current = prefs.compFilters
  useEffect(() => {
    if (!map) return
    const onPoint = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      ;(e as { _clickHandled?: boolean })._clickHandled = true
      const id = e.features?.[0]?.properties?.comp_id
      if (id) { setCompId(String(id)); setOpenEvent(null) }
    }
    const onCluster = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      ;(e as { _clickHandled?: boolean })._clickHandled = true
      const f = e.features?.[0]
      const g = f?.geometry as { coordinates?: [number, number] } | undefined
      if (!g?.coordinates) return
      const n = Number(f?.properties?.n) || 0
      // A handful of sales: list them right here. A crowd: fly in.
      if (n > 0 && n <= 60) {
        const z = map.getZoom()
        const half = z >= 10 ? 0.003 : z >= 9 ? 0.012 : 0.04
        const [lng, lat] = g.coordinates
        setCompList({ rows: [], loading: true, n })
        void loadCompsInBox({ minLat: lat - half, maxLat: lat + half, minLng: lng - half, maxLng: lng + half }, { ...DEFAULT_COMP_FILTERS, ...compFiltersRef.current })
          .then((rows) => setCompList({ rows, loading: false, n }))
        return
      }
      map.easeTo({ center: g.coordinates, zoom: Math.min(16, map.getZoom() + 2.2), duration: reducedMotion ? 0 : 700 })
    }
    map.on('click', COMP_LAYERS.point, onPoint)
    map.on('click', COMP_LAYERS.cluster, onCluster)
    return () => { map.off('click', COMP_LAYERS.point, onPoint); map.off('click', COMP_LAYERS.cluster, onCluster) }
  }, [map, mapEpoch, reducedMotion])
  // Tap open map → the property card closes (and its star with it). Runs after
  // every layer handler has had its turn; anything tappable under the finger
  // (a pin, dot, comp, activity marker) wins.
  const cardOpenRef = useRef(cardOpen)
  cardOpenRef.current = cardOpen
  useEffect(() => {
    if (!map) return
    const TAPPABLE = /^(prop-tiles-hit|prop-univ-marker-hit|seller-pins-hit|seller-pins-core|command-pin-core|command-pin-cluster-core|nx-dots-hit|nx-comps-|nx-mx-activity|nx-search-area-fill|map-agg-cluster-core)/
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!cardOpenRef.current) return
      window.setTimeout(() => {
        if ((e as { _clickHandled?: boolean })._clickHandled || !cardOpenRef.current) return
        try {
          const layers = (map.getStyle().layers ?? []).map((l) => l.id).filter((id) => TAPPABLE.test(id) && map.getLayoutProperty(id, 'visibility') !== 'none')
          if (layers.length && map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers }).length) return
        } catch { return }
        clearActiveContext()
      }, 0)
    }
    map.on('click', onClick)
    return () => { map.off('click', onClick) }
  }, [map, mapEpoch])
  useMapImagery(map, mapEpoch, { labels: prefs.labels, trueColor: prefs.trueColor, relief: prefs.relief, tilted: dimension === '3d', theme: styleMode, reducedMotion })
  // The Command Map's own mode follows the lens (marker styling, overlays).
  const modeSynced = useRef(false)
  useEffect(() => {
    if (modeSynced.current) return
    modeSynced.current = true
    if (lens.legacyMode !== mode) onMode(lens.legacyMode)
  }, [lens.legacyMode, mode, onMode])
  const [scanKey, setScanKey] = useState(0)
  const chooseLens = (picked: MapLens) => {
    // Tapping the active mode again turns modes off: just the properties.
    const next = picked.id === lens.id && picked.id !== 'none' ? lensById('none') : picked
    setPref('lens', next.id)
    if (next.legacyMode !== mode) onMode(next.legacyMode)
    setScanKey((k) => k + 1)
    setSheet(null)
  }

  // Read the heat under a finger: press-and-hold anywhere (a property marker
  // is almost always under a plain tap), or a plain tap on open heat.
  const [readout, setReadout] = useState<{ x: number; y: number; text: string; sub: string; key: number } | null>(null)
  const lensRef = useRef(lens)
  lensRef.current = lens
  useEffect(() => {
    if (!map) return
    let timer = 0
    let hold = 0
    let start: { x: number; y: number } | null = null
    const read = (point: { x: number; y: number }) => {
      const l = lensRef.current
      if (!l.source || l.ambient) return false
      const hit = lensValueAt(map, point)
      if (!hit) return false
      const sub = l.id === 'territory'
        ? 'properties here'
        : l.density ? `${l.label.toLowerCase()} here`
        : l.areal ? l.attribution ?? l.label : hit.n > 1 ? `${l.label} · avg of ${hit.n.toLocaleString()}` : l.label
      setReadout({ x: point.x, y: point.y, text: l.id === 'territory' ? hit.n.toLocaleString() : l.density ? Math.round(hit.v).toLocaleString() : formatLensValue(l, hit.v), sub, key: Date.now() })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setReadout(null), 2800)
      return true
    }
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!lensRef.current.source || lensRef.current.ambient) return
      try {
        const hitLayers = ['prop-tiles-hit', 'command-pin-core-raw', 'nx-mx-activity-core', 'map-market-aggregates-core'].filter((id) => map.getLayer(id))
        if (hitLayers.length && map.queryRenderedFeatures(e.point, { layers: hitLayers }).length) return
      } catch { return }
      read(e.point)
    }
    const onTouchStart = (e: maplibregl.MapTouchEvent) => {
      window.clearTimeout(hold)
      if (!lensRef.current.source || lensRef.current.ambient || e.points.length !== 1) { start = null; return }
      start = { x: e.point.x, y: e.point.y }
      hold = window.setTimeout(() => {
        if (start && read(start)) { try { navigator.vibrate?.(8) } catch { /* unsupported */ } }
        start = null
      }, 420)
    }
    const onTouchMove = (e: maplibregl.MapTouchEvent) => {
      if (start && (Math.abs(e.point.x - start.x) > 8 || Math.abs(e.point.y - start.y) > 8)) { start = null; window.clearTimeout(hold) }
    }
    const onTouchEnd = () => { start = null; window.clearTimeout(hold) }
    const onContext = (e: maplibregl.MapMouseEvent) => { read(e.point) }
    const clear = () => setReadout(null)
    map.on('click', onClick)
    map.on('touchstart', onTouchStart)
    map.on('touchmove', onTouchMove)
    map.on('touchend', onTouchEnd)
    map.on('touchcancel', onTouchEnd)
    map.on('contextmenu', onContext)
    map.on('movestart', clear)
    return () => {
      map.off('click', onClick)
      map.off('touchstart', onTouchStart)
      map.off('touchmove', onTouchMove)
      map.off('touchend', onTouchEnd)
      map.off('touchcancel', onTouchEnd)
      map.off('contextmenu', onContext)
      map.off('movestart', clear)
      window.clearTimeout(timer)
      window.clearTimeout(hold)
    }
  }, [map, mapEpoch])

  useEffect(() => {
    try { localStorage.setItem(ACTIVITY_STORE, JSON.stringify({ on: activityOn, scope, window: window_ })) } catch { /* private mode */ }
  }, [activityOn, scope, window_])

  // Relative times tick once a minute; nothing else animates on a timer.
  useEffect(() => {
    const t = window.setInterval(() => setClock(Date.now()), 30_000)
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
          const dots = dotsInView(map)
          if (dots !== null) { setInView(dots); setZoom(map.getZoom()); return }
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
      if (e?.isSourceLoaded && (e.sourceId === 'property-map-tiles' || e.sourceId === 'command-pins-raw' || e.sourceId === 'nx-dots')) count()
    }
    map.on('moveend', count)
    map.on('sourcedata', onData)
    count()
    return () => { map.off('moveend', count); map.off('sourcedata', onData); cancelAnimationFrame(raf) }
  }, [map, mapEpoch])

  // ── Market bubbles (below property zoom): the biggest markets keep their
  // labels, smaller neighbours yield instead of stacking numbers on a phone.
  useEffect(() => {
    if (!map) return
    const COUNT = ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 1]
    const apply = () => {
      try {
        if (map.getLayer('map-agg-cluster-count')) {
          if (map.getLayoutProperty('map-agg-cluster-count', 'text-allow-overlap') !== false) {
            map.setLayoutProperty('map-agg-cluster-count', 'text-allow-overlap', false)
            map.setLayoutProperty('map-agg-cluster-count', 'text-padding', 5)
            map.setLayoutProperty('map-agg-cluster-count', 'symbol-sort-key', ['-', 0, COUNT] as never)
          }
        }
        if (map.getLayer('map-agg-cluster-icon') && map.getLayoutProperty('map-agg-cluster-icon', 'icon-allow-overlap') !== false) {
          map.setLayoutProperty('map-agg-cluster-icon', 'icon-allow-overlap', false)
          map.setLayoutProperty('map-agg-cluster-icon', 'symbol-sort-key', ['-', 0, COUNT] as never)
        }
        // The dark halo under each bubble would black out the density glow beneath.
        if (map.getLayer('map-agg-cluster-halo') && map.getPaintProperty('map-agg-cluster-halo', 'circle-opacity') !== 0.18) {
          map.setPaintProperty('map-agg-cluster-halo', 'circle-opacity', 0.18)
        }
        // Bigger markets draw on top.
        for (const id of ['map-agg-cluster-halo', 'map-agg-cluster-core', 'map-agg-cluster-ring']) {
          if (map.getLayer(id) && map.getLayoutProperty(id, 'circle-sort-key') === undefined) map.setLayoutProperty(id, 'circle-sort-key', COUNT as never)
        }
      } catch { /* style mid-swap */ }
    }
    apply()
    map.on('styledata', apply)
    return () => { map.off('styledata', apply) }
  }, [map, mapEpoch])

  // ── Marker hierarchy (mobile) ──────────────────────────────────────────────
  // Selected and live properties keep full strength; properties with a stage
  // ring (a real conversation) stay clear; the untouched universe goes quiet.
  // Uses only the feature-state the map already writes — no new scoring. The
  // constant pulse is switched off: new activity pulses once, from the overlay.
  // Under a heat lens the markers step back so the colour field reads; at
  // street zoom they return (each property then glows its own value).
  // Pins stay clearly visible over any heat (the operator turns them off with
  // the Property pins switch); they only soften enough for the colour to read.
  const lensDim = !lens.source || lens.ambient ? 1 : zoom >= 13 ? 0.95 : lens.areal ? 0.85 : 0.78
  // Sold comps on: properties soften so the red sales read.
  const markerDim = Math.min(lensDim, compsOn ? (zoom >= 14 ? 0.8 : 0.6) : 1)
  const originalsRef = useRef(new Map<string, unknown>())
  const appliedRef = useRef(new Map<string, string>())
  useEffect(() => { originalsRef.current = new Map(); appliedRef.current = new Map() }, [map, mapEpoch])
  useEffect(() => {
    if (!map) return
    const originals = originalsRef.current
    const applied = appliedRef.current
    applied.clear()
    const QUIET = markerDim === 1 ? buildMarkerEmphasisExpr() : ['*', buildMarkerEmphasisExpr(), markerDim]
    const TARGETS: Array<[string, string]> = [
      ['prop-tiles-glass', 'circle-opacity'],
      ['prop-tiles-ring', 'circle-stroke-opacity'],
      ['prop-tiles-icon', 'icon-opacity'],
    ]
    // Our own wrapping: ['*', original, emphasis]. Anything else is the map's
    // (a theme swap re-sets paint) and becomes the new original.
    const isOurs = (v: unknown) => Array.isArray(v) && v[0] === '*' && v.length === 3 && typeof v[2] === 'object' && JSON.stringify(v[2]).includes('pin_selected')
    const apply = () => {
      try {
        for (const [layer, prop] of TARGETS) {
          if (!map.getLayer(layer)) continue
          const current = map.getPaintProperty(layer, prop as never)
          const key = `${layer}:${prop}`
          const currentJson = JSON.stringify(current)
          if (applied.get(key) === currentJson) continue
          if (!isOurs(current)) originals.set(key, current ?? 1)
          const next = ['*', originals.get(key) ?? 1, QUIET]
          if (JSON.stringify(next) === currentJson) { applied.set(key, currentJson); continue }
          map.setPaintProperty(layer, prop as never, next as never)
          applied.set(key, JSON.stringify(map.getPaintProperty(layer, prop as never)))
        }
        if (map.getLayer('prop-tiles-pulse') && map.getPaintProperty('prop-tiles-pulse', 'circle-opacity') !== 0) map.setPaintProperty('prop-tiles-pulse', 'circle-opacity', 0)
      } catch { /* layer mid-reload */ }
    }
    const onTiles = (e: { sourceId?: string; isSourceLoaded?: boolean }) => { if (e?.sourceId === 'property-map-tiles') apply() }
    apply()
    map.on('styledata', apply)
    map.on('sourcedata', onTiles)
    // Theme presentation can re-set marker paint without an event we see; a
    // cheap check keeps the hierarchy (and lens dimming) in force.
    const tick = window.setInterval(apply, 1500)
    return () => { map.off('styledata', apply); map.off('sourcedata', onTiles); window.clearInterval(tick) }
  }, [map, mapEpoch, markerDim])

  // Live stream (Supabase realtime + the last day) merged over the map's derived feed.
  // The stream is always on: the map itself is alive (orbs, landings), not only the feed.
  const realtime = useRealtimeActivity(true)
  useLiveOrbs(map, mapEpoch, realtime.events, prefs.liveOrbs, reducedMotion)
  // A brand-new event lands where it happened: shockwave + rising label.
  const landedRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!map || !realtime.coveredSince) return
    if (landedRef.current === null) { landedRef.current = new Set(realtime.events.map((e) => e.id)); return }
    const fresh = realtime.events.filter((e) => !landedRef.current!.has(e.id))
    for (const e of fresh) landedRef.current.add(e.id)
    if (!prefs.liveOrbs || reducedMotion) return
    for (const e of fresh.slice(0, 5)) landEvent(map, e)
  }, [map, realtime.events, realtime.coveredSince, prefs.liveOrbs, reducedMotion])
  const allEvents = useMemo(() => mergeActivity(realtime.events, activityEvents, realtime.coveredSince), [realtime.events, activityEvents, realtime.coveredSince])
  const now = useMemo(() => new Date(clock), [clock])
  const events = useMemo(() => filterActivity(allEvents, { scope, window: window_, now }), [allEvents, scope, window_, now])
  const counts = useMemo(() => scopeCounts(allEvents, window_, now), [allEvents, window_, now])
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

  // Camera moves the home framing makes itself don't count as "the operator moved".
  const framingRef = useRef(false)
  const fitHome = useCallback((animate: boolean) => {
    if (!map || !homeBounds) return false
    framingRef.current = true
    map.once('moveend', () => { framingRef.current = false })
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
    // Any move we didn't make — a drag, a pinch, a search fly-to, a tap that
    // centres a property — means the operator has taken the camera: a late
    // home framing must never yank it back to the national view.
    const mark = () => { if (!framingRef.current) userMovedRef.current = true }
    map.on('movestart', mark)
    return () => { map.off('movestart', mark) }
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

  const activeTheme = themes.find((t) => t.id === styleMode)
  const pillSwatch = lensSwatch(lens)

  return (
    <div className={cls('mx', (cardOpen || compId || compList) && 'has-card', activityOn && 'is-activity', drawing && 'is-drawing')}>
      <MapAreaTool map={map} epoch={mapEpoch} drawing={drawing} onDrawingChange={setDrawing} reducedMotion={reducedMotion} />
      {!drawing && (
        <div className="mx-searchrow">
          <MapSearch map={map} epoch={mapEpoch} reducedMotion={reducedMotion} onProperty={openSearchProperty} onActiveChange={setSearchActive} />
        </div>
      )}
      {!drawing && <div className={cls('mx-top', searchActive && 'is-yielding')}>
        {prefs.modePill && (
        <button type="button" className="mx-context" data-map-control="mode" onClick={() => { setLayersTab('mode'); setSheet('layers') }}>
          <span className={cls('mx-context__swatch', !pillSwatch && 'is-ramp')} aria-hidden="true" style={pillSwatch ? undefined : { backgroundImage: rampGradient(lens, '0deg') }}>
            {pillSwatch?.map((c) => <i key={c} style={{ background: c }} />)}
          </span>
          <span className="mx-context__copy">
            <strong>{lens.label}</strong>
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
        )}
        {compsOn && (
          <button type="button" className="mx-chip is-comps" onClick={() => setSheet('comps')} data-map-control="comps">
            <i aria-hidden="true" /> {comps.loading && !comps.total ? 'Comps…' : `${comps.total.toLocaleString()} sold`}{activeCompFilterCount(prefs.compFilters) ? ` · ${activeCompFilterCount(prefs.compFilters)}` : ''}
          </button>
        )}
        {filterCount > 0 && (
          <button type="button" className="mx-chip" onClick={onOpenFilters} data-map-control="filter-summary">
            <Icon name="filter" size={12} /> Filters · {filterCount}
          </button>
        )}
      </div>}

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
        <button type="button" className={cls('mx-btn', drawing && 'is-lit')} aria-label="Draw an area" aria-pressed={drawing} data-map-control="draw" onClick={() => { setSheet(null); setOpenEvent(null); setDrawing((v) => !v) }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 18.5c-2.6-1.2-4-3.2-4-5.5C3 8.6 7 5 12 5s9 3.6 9 8c0 4.1-3.6 7.3-8.4 7.9" strokeDasharray="0.1 3.6" />
            <path d="M7 18.5c0 1.6 1.2 2.5 2.6 2.5 1.2 0 2-.7 2-1.7 0-1.4-1.6-2-3.1-1.6-.6.2-1.1.5-1.5.8Z" />
            <path d="M9.6 21c-.3 1-.9 1.6-1.8 2" />
          </svg>
        </button>
        <button type="button" className="mx-btn" aria-label={selectedLngLat ? 'Center on selected property' : homeBounds ? 'Show your active sellers' : 'Show the whole country'} data-map-control="recenter" onClick={recenter}>
          <Icon name="target" size={17} />
        </button>
      </div>

      {scanKey > 0 && !reducedMotion && <span key={scanKey} className="mx-scan" aria-hidden="true" style={{ backgroundImage: rampGradient(lens, '180deg') }} />}

      {readout && (
        <div key={readout.key} className="mx-readout" style={{ left: readout.x, top: readout.y }} role="status">
          <strong>{readout.text}</strong>
          <span>{readout.sub}</span>
        </div>
      )}

      {compId && <MapCompCard map={map} compId={compId} onClose={() => setCompId(null)} reducedMotion={reducedMotion} />}

      {!cardOpen && !compId && !searchActive && (prefs.market || prefs.mapKey) && (
        <div className={cls('mx-cards', activityOn && 'has-peek')}>
          {prefs.market && <MarketPanel map={map} epoch={mapEpoch} onClose={() => setPref('market', false)} />}
          {prefs.mapKey && (
            <LensLegend
              lens={lens}
              state={lensState}
              zoom={zoom}
              look={lensLook}
              onLook={(next) => { if (next.style !== undefined) setPref('lensStyle', next.style); if (next.blend !== undefined) setPref('lensBlend', next.blend) }}
            />
          )}
        </div>
      )}

      {activityOn && !cardOpen && !compId && !searchActive && (
        <button type="button" className="mx-peek" data-map-control="activity-feed" onClick={() => setSheet('activity')}>
          <span className={cls('mx-peek__dot', latest && `tier-${tierOf(latest)}`)} aria-hidden="true" />
          <span className="mx-peek__copy" key={latest?.id ?? 'none'}>
            <strong>{latest ? latest.title : 'Live Activity'}</strong>
            <span>{latest ? [latest.address || latest.market, agoLabel(eventTime(latest), clock)].filter(Boolean).join(' · ') : `No activity · ${ACTIVITY_WINDOWS.find((w) => w.key === window_)?.label}`}</span>
          </span>
          {realtime.live && <span className="mx-peek__live">Live</span>}
          <span className="mx-peek__count">{events.length}</span>
        </button>
      )}

      {openEvent && (
        <MapEventCard event={openEvent} onClose={() => setOpenEvent(null)} onShowProperty={(e) => { setOpenEvent(null); onSelectEvent(e) }} />
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
              <Toggle label="Property pins" sub={prefs.pins ? 'On over every mode — tap any pin for its preview' : 'Off — heat and market data only'} on={prefs.pins} onChange={(v) => setPref('pins', v)} />
            </div>
          )}
          {layersTab === 'mode' && LENS_FAMILIES.map((f) => (
            <section key={f.key} className="mx-block">
              <h3>{f.label}</h3>
              <div className="mx-lenses">
                {MAP_LENSES.filter((l) => l.family === f.key).map((l, i) => {
                  const sw = lensSwatch(l)
                  return (
                    <button
                      key={l.id}
                      type="button"
                      className={cls('mx-lens', l.id === lens.id && 'is-active')}
                      aria-pressed={l.id === lens.id}
                      data-lens-id={l.id}
                      style={{ animationDelay: `${i * 22}ms` }}
                      onClick={() => chooseLens(l)}
                    >
                      <span className="mx-lens__ramp" aria-hidden="true" style={sw ? { backgroundImage: `linear-gradient(90deg, ${sw.join(', ')})` } : { backgroundImage: rampGradient(l) }} />
                      <strong>{l.label}</strong>
                      <span>{l.sub}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
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
                <h3>Liquid glass</h3>
                <LiquidGlassControls />
              </section>
              <section className="mx-block">
                <h3>Perspective</h3>
                <Segmented<'2d' | '3d'> value={dimension} onChange={onDimension} label="Perspective" options={[{ key: '2d', label: 'Flat' }, { key: '3d', label: 'Tilted' }]} />
              </section>
              <div className="mx-list">
                {styleMode === 'satellite' && (
                  <section className="mx-block">
                    <h3>Imagery</h3>
                    <Segmented<'true' | 'tactical'> value={prefs.trueColor ? 'true' : 'tactical'} onChange={(v) => setPref('trueColor', v === 'true')} label="Imagery colour" options={[{ key: 'true', label: 'True colour' }, { key: 'tactical', label: 'Tactical' }]} />
                  </section>
                )}
                {HYBRID_THEMES.has(styleMode) && (
                  <Toggle label="Roads & places" sub="Street names, highways and towns over the imagery" on={prefs.labels} onChange={(v) => setPref('labels', v)} />
                )}
                <Toggle label="Terrain relief" sub={dimension === '3d' ? 'Shaded hills, lifted into 3D while tilted' : 'Shaded hills and valleys · tilt for true 3D'} on={prefs.relief} onChange={(v) => setPref('relief', v)} />
              </div>
            </>
          )}
          {layersTab === 'intel' && (
            <div className="mx-list">
              <Toggle label="Living map" sub="Glowing orbs where replies, sends, deliveries and stage moves happened today; new ones land with a shockwave" on={prefs.liveOrbs} onChange={(v) => setPref('liveOrbs', v)} />
              <Toggle label="Property pins" sub="Every property's pin — stage ring, asset shape, activity pulse — over any mode or heat map" on={prefs.pins} onChange={(v) => setPref('pins', v)} />
              <Toggle label="Every property" sub="A glowing dot for every property at any zoom, a real pin for each one up close" on={prefs.everyProperty} onChange={(v) => setPref('everyProperty', v)} />
              <Toggle label="Sold comps" sub="Every MLS, public-record and investor sale — buyer, portfolio and hedge-fund buys flagged" on={prefs.comps} onChange={(v) => setPref('comps', v)} />
              {compsOn && (
                <button type="button" className="mx-row" onClick={() => setSheet('comps')}>
                  <span className="mx-row__copy"><strong>Comp filters</strong><span>{activeCompFilterCount(prefs.compFilters) ? `${activeCompFilterCount(prefs.compFilters)} active` : 'Source, buyer type, date, price, type, beds'}</span></span>
                  <Icon name="chevron-right" size={16} />
                </button>
              )}
              <Toggle label="Map key" sub="What the colour on the map means, with real values" on={prefs.mapKey} onChange={(v) => setPref('mapKey', v)} />
              <Toggle label="Market panel" sub="Census, HUD rent, price growth and flood for the ZIP at the map centre" on={prefs.market} onChange={(v) => setPref('market', v)} />
              <Toggle label="Mode pill" sub="The mode and properties-in-view pill, top left" on={prefs.modePill} onChange={(v) => setPref('modePill', v)} />
              <Toggle label="Live Activity on map" sub="Replies, stage changes and sends as they happen" on={activityOn} onChange={setActivityOn} />
            </div>
          )}
          {layersTab === 'advanced' && (
            <>
              <p className="mx-note">Density decides how many properties draw before you zoom all the way in; Everything shows every property from zoom 11.5.</p>
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
                <p className="mx-note">Properties replace market bubbles from zoom {performance.clusterAggressiveness === 'high' ? 11 : performance.clusterAggressiveness === 'low' ? 9 : 10}.</p>
              </section>
              <section className="mx-block">
                <h3>Rendering</h3>
                <Segmented value={performance.performanceMode} onChange={(v) => onPerformance({ performanceMode: v })} label="Rendering" options={[{ key: 'auto', label: 'Auto' }, { key: 'quality', label: 'Quality' }, { key: 'balanced', label: 'Balanced' }, { key: 'speed', label: 'Speed' }]} />
              </section>
            </>
          )}
          <p className="mx-foot">{activeTheme ? `${activeTheme.label} · ` : ''}{lens.label}</p>
        </MapSheet>
      )}

      {compList && (
        <MapSheet title={compList.loading ? 'Sales here…' : `${compList.rows.length} sale${compList.rows.length === 1 ? '' : 's'} here`} onClose={() => setCompList(null)} className="mx-comps-list">
          {compList.loading && <div className="mx-area__loading"><span /><span /><span /></div>}
          <ol className="mx-feed mx-complist">
            {compList.rows.map((r) => {
              const instit = r.buyer_class === 'institutional' || r.buyer_class === 'hedge_fund'
              const price = r.portfolio_size >= 2 ? r.per_door : r.price
              return (
                <li key={r.comp_id}>
                  <button type="button" className={cls('mx-feedrow', 'mx-comprow', instit && 'is-gold')} onClick={() => { setCompList(null); setCompId(r.comp_id) }} data-comp-row>
                    <span className={cls('mx-comprow__dot', `src-${r.source}`)} aria-hidden="true" />
                    <span className="mx-row__copy">
                      <strong>{r.address ? r.address.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Sold property'}</strong>
                      <span>{[COMP_SOURCE_LABEL[r.source], r.buyer_class !== 'unknown' ? BUYER_CLASS_LABEL[r.buyer_class] : null, r.portfolio_size >= 2 ? `portfolio of ${r.portfolio_size}` : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="mx-comprow__price">
                      <strong>{price ? (price >= 1e6 ? `$${(price / 1e6).toFixed(1)}M` : `$${Math.round(price / 1000)}K`) : '—'}</strong>
                      <em>{r.sold_on ? new Date(`${r.sold_on}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : ''}</em>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </MapSheet>
      )}

      {sheet === 'comps' && (
        <MapSheet title="Sold comps" onClose={() => setSheet(null)} className="mx-comps-sheet"
          header={(
            <button type="button" className={cls('mx-switch', 'is-inline', prefs.comps && 'is-on')} role="switch" aria-checked={prefs.comps} aria-label="Show sold comps on the map" onClick={() => setPref('comps', !prefs.comps)}>
              <span />
            </button>
          )}
        >
          <CompFiltersPanel filters={{ ...DEFAULT_COMP_FILTERS, ...prefs.compFilters }} onChange={(f) => setPref('compFilters', f)} total={comps.total} institutional={comps.institutional} />
        </MapSheet>
      )}

      {sheet === 'activity' && (
        <MapSheet
          title="Live Activity"
          onClose={() => setSheet(null)}
          className={cls('mx-activity-sheet', realtime.live && 'is-streaming')}
          header={(<>
            {realtime.live && <span className="mx-streaming" title="Streaming from the database">Live</span>}
            <button type="button" className={cls('mx-switch', 'is-inline', activityOn && 'is-on')} role="switch" aria-checked={activityOn} aria-label="Show activity on the map" onClick={() => setActivityOn((v) => !v)}>
              <span />
            </button>
          </>)}
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
                        <span>{[e.subtitle, e.address || e.market, action ? null : 'No location'].filter(Boolean).join(' · ')}</span>
                        {e.detail && <em className="mx-feedrow__detail">{e.detail}</em>}
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
