/**
 * MAP DESKTOP 2.0 — the map is the canvas.
 *
 * Full-bleed map; everything else floats above it on a depth system:
 *   L0  the map
 *   L1  recessed rail        the tool rail, set into the glass
 *   L2  raised glass         command stack, legend, zoom capsule
 *   L3  active inspector     Layers / Filters / Live (left), the property card,
 *                            comps, an event (right), the area shelf (bottom)
 *   L4  transient popovers   Color by, Appearance, tooltips
 *   L5  toasts               live events as they land
 *
 * Top-left: search → the lens pill (the lens, and LIVE only while the stream is
 * actually flowing) → the time/world capsule. Beside it, the icon rail: Layers,
 * Filters, Draw, Live, Appearance (no Measure — the Map has no such tool).
 *
 * All state is the Map's own (MapMobileChrome passes it in); this file only
 * decides which tool is open and lays the instruments out. The phone never
 * renders it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type maplibregl from 'maplibre-gl'
import { Icon } from '../../../shared/icons'
import type { LiveActivityEvent } from '../live-activity-engine'
import type { CommandMapPerformanceSettings } from '../commandMapLiveActivity'
import {
  ACTIVITY_SCOPES,
  ACTIVITY_WINDOWS,
  APPEARANCE_GROUPS,
  agoLabel,
  eventAction,
  eventTime,
  tierOf,
  timeAgo,
  type ActivityScope,
  type ActivityWindow,
} from '../mobile/map-mobile-model'
import type { MapLens } from '../mobile/map-lenses'
import type { LensLook, LensState } from '../mobile/useMapLens'
import type { CompFilters } from '../mobile/useSoldComps'
import { MarketPanel } from '../mobile/MapIntelCards'
import { MapSearch, MAP_OPEN_AREA_EVENT } from '../mobile/MapSearch'
import { HYBRID_THEMES } from '../mobile/useMapImagery'
import { lightState } from '../world/solar'
import type { LivingSettings } from '../world/living-settings'
import { DESK_TOOLS, filterCapsuleLabel, fmtCount, lensPillSub, liveSignal, clampOpacity, type DeskTool } from './map-desk-model'
import { DeskSeg, DeskSwitch, MapDeskLayers } from './MapDeskLayers'
import { LensPicker, MapDeskLegend, lensSwatchStyle } from './MapDeskLegend'
import { DESK_CARD_PRESENCE_EVENT, type DeskCardPresence } from '../seller-card/desk-card-presence'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
/** Below this pane width a left inspector and a docked card can't share the map (keep in step with map-desk.css). */
const NARROW_PANE = 900

export interface DeskPrefs {
  pins: boolean
  everyProperty: boolean
  comps: boolean
  compFilters: CompFilters
  market: boolean
  liveOrbs: boolean
  labels: boolean
  relief: boolean
  trueColor: boolean
  pinOpacity: number
  legendCollapsed: boolean
}

/** The desk's own left tools (Filters is owned by the Command Map; Draw is a mode). */
export type DeskOpenTool = Exclude<DeskTool, 'filters' | 'draw'> | null

export interface MapDeskChromeProps {
  /** Which desk tool is open — lifted, so map events (an activity marker) can open Live. */
  tool: DeskOpenTool
  onTool: Dispatch<SetStateAction<DeskOpenTool>>
  map: maplibregl.Map | null
  mapEpoch: number
  reducedMotion: boolean
  // lens
  lens: MapLens
  lensState: LensState
  lensLook: LensLook
  onPickLens: (lens: MapLens) => void
  onLensVisible: (on: boolean) => void
  onLensLook: (next: Partial<LensLook>) => void
  // what's in view
  inView: number | null
  zoom: number
  loading: boolean
  // prefs
  prefs: DeskPrefs
  setPref: <K extends keyof DeskPrefs>(k: K, v: DeskPrefs[K]) => void
  comps: { total: number; loading: boolean }
  onOpenCompFilters: () => void
  // filters (the inspector itself is owned by the Command Map)
  filterCount: number
  filterMatching: number | null
  filtersOpen: boolean
  onOpenFilters: () => void
  onCloseFilters: () => void
  // draw
  drawing: boolean
  onToggleDraw: () => void
  // live
  activityOn: boolean
  onActivity: (on: boolean) => void
  streamLive: boolean
  events: LiveActivityEvent[]
  /** The raw realtime stream (for toasts) and when its backfill completed (null = not yet). */
  liveEvents: LiveActivityEvent[]
  liveCoveredSince: number | null
  scopeCounts: Record<ActivityScope, number>
  scope: ActivityScope
  onScope: (s: ActivityScope) => void
  activityWindow: ActivityWindow
  onActivityWindow: (w: ActivityWindow) => void
  clock: number
  onOpenEvent: (e: LiveActivityEvent) => void
  // appearance
  dimension: '2d' | '3d'
  onDimension: (d: '2d' | '3d') => void
  themes: ReadonlyArray<{ id: string; label: string; accentColor: string }>
  styleMode: string
  onStyle: (id: string) => void
  living: LivingSettings
  onLiving: (patch: Partial<LivingSettings>) => void
  performance: CommandMapPerformanceSettings
  onPerformance: (patch: Partial<CommandMapPerformanceSettings>) => void
  // camera
  bearing: number
  onRecenter: () => void
  recenterLabel: string
  // search
  onSearchProperty: (hit: { propertyId: string; lng: number; lat: number; label: string }) => void
  onSearchActive: (active: boolean) => void
}

type Picker = 'pill' | 'legend' | 'side' | null
type Toast = { id: string; event: LiveActivityEvent; at: number }

// ── glyphs the shared set doesn't carry ─────────────────────────────────────
const LassoGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 18.5c-2.6-1.2-4-3.2-4-5.5C3 8.6 7 5 12 5s9 3.6 9 8c0 4.1-3.6 7.3-8.4 7.9" strokeDasharray="0.1 3.6" />
    <path d="M7 18.5c0 1.6 1.2 2.5 2.6 2.5 1.2 0 2-.7 2-1.7 0-1.4-1.6-2-3.1-1.6-.6.2-1.1.5-1.5.8Z" />
  </svg>
)
const SunGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3.2v1.6M12 19.2v1.6M3.2 12h1.6M19.2 12h1.6M5.8 5.8l1.1 1.1M17.1 17.1l1.1 1.1M5.8 18.2l1.1-1.1M17.1 6.9l1.1-1.1" />
    <path d="M12 7.6a4.4 4.4 0 1 0 0 8.8Z" fill="currentColor" stroke="none" opacity="0.9" />
    <circle cx="12" cy="12" r="4.4" />
  </svg>
)
const TOOL_ICON: Record<DeskTool, ReactNode> = {
  layers: <Icon name="layers" size={17} />,
  filters: <Icon name="filter" size={16} />,
  draw: <LassoGlyph />,
  live: <Icon name="activity" size={17} />,
  appearance: <SunGlyph />,
}

/** Phase of the real sun at the map centre (solar.ts — deterministic astronomy). */
function useCentreLight(map: maplibregl.Map | null, epoch: number, clock: number) {
  const [centre, setCentre] = useState<{ lat: number; lng: number } | null>(null)
  useEffect(() => {
    if (!map) return undefined
    const read = () => { try { const c = map.getCenter(); setCentre({ lat: c.lat, lng: c.lng }) } catch { /* map gone */ } }
    read()
    map.on('moveend', read)
    return () => { map.off('moveend', read) }
  }, [map, epoch])
  return useMemo(() => (centre ? lightState(new Date(clock), centre.lat, centre.lng) : null), [centre, clock])
}

// ── the Live inspector ───────────────────────────────────────────────────────
function LiveInspector(p: MapDeskChromeProps & { onClose: () => void }) {
  const signal = liveSignal({ streamLive: p.streamLive, activityOn: p.activityOn })
  return (
    <section className={cls('mxd-insp', 'is-left', 'mxd-live-insp', signal === 'live' && 'is-streaming')} role="dialog" aria-modal="false" aria-label="Live Activity" data-map-inspector="live">
      <header className="mxd-insp__head">
        <span className={cls('mxd-insp__glyph', signal === 'live' && 'is-live')} aria-hidden="true"><Icon name="activity" size={15} /></span>
        <div className="mxd-insp__title">
          <h2>Live Activity</h2>
          <p>{signal === 'live' ? 'Streaming from the database' : signal === 'connecting' ? 'Stream offline · showing what the map knows' : 'Markers off · the feed still reads'}</p>
        </div>
        <DeskSwitch on={p.activityOn} onChange={p.onActivity} label={p.activityOn ? 'Hide activity on the map' : 'Show activity on the map'} />
        <button type="button" className="mxd-icon-btn" aria-label="Close Live Activity" onClick={p.onClose} data-map-sheet-close><Icon name="close" size={14} /></button>
      </header>
      <div className="mxd-insp__body">
        <DeskSeg label="Time window" value={p.activityWindow} onChange={p.onActivityWindow} options={ACTIVITY_WINDOWS} />
        <div className="mxd-chips is-tight">
          {ACTIVITY_SCOPES.filter((s) => s.key === 'all' || p.scopeCounts[s.key] > 0).map((s) => (
            <button key={s.key} type="button" className={cls('mxd-chip', 'is-button', p.scope === s.key && 'is-on')} aria-pressed={p.scope === s.key} onClick={() => p.onScope(s.key)}>
              {s.label}<em>{p.scopeCounts[s.key]}</em>
            </button>
          ))}
        </div>
        {p.events.length === 0 ? (
          <div className="mxd-empty">
            <Icon name="activity" size={18} />
            <strong>Quiet</strong>
            <span>No {p.scope === 'all' ? '' : `${ACTIVITY_SCOPES.find((s) => s.key === p.scope)?.label.toLowerCase()} `}activity in this window.</span>
          </div>
        ) : (
          <ol className="mxd-feed">
            {p.events.slice(0, 80).map((e) => {
              const action = eventAction(e)
              return (
                <li key={e.id}>
                  <button type="button" className={cls('mxd-feedrow', `tier-${tierOf(e)}`)} data-activity-row onClick={() => p.onOpenEvent(e)}>
                    <span className="mxd-feedrow__dot" aria-hidden="true" />
                    <span className="mxd-feedrow__copy">
                      <strong>{e.title}</strong>
                      <span>{[e.subtitle, e.address || e.market, action ? null : 'No location'].filter(Boolean).join(' · ')}</span>
                      {e.detail ? <em>{e.detail}</em> : null}
                    </span>
                    <span className="mxd-feedrow__time">{timeAgo(eventTime(e), p.clock)}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}

// ── the Appearance popover ──────────────────────────────────────────────────
function AppearancePopover(p: MapDeskChromeProps & { top: number; onClose: () => void; vectorBuildings: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const light = useCentreLight(p.map, p.mapEpoch, p.clock)
  const closeRef = useRef(p.onClose)
  closeRef.current = p.onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current() } }
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (ref.current && t && !ref.current.contains(t) && !t.closest?.('[data-map-control="appearance"]')) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true) }
  }, [])
  const livingOn = p.living.enabled
  const theme = p.themes.find((t) => t.id === p.styleMode)
  return (
    <div ref={ref} className="mxd-pop mxd-appearance" style={{ top: p.top, maxHeight: `calc(100% - ${p.top}px - var(--mxd-gap))` }} role="dialog" aria-label="Appearance">
      <div className="mxd-pop__head"><strong>Appearance</strong><span>{[theme?.label, p.dimension === '3d' ? '3D' : '2D'].filter(Boolean).join(' · ')}</span></div>
      <div className="mxd-pop__body">
        <div className="mxd-block">
          <div className="mxd-block__head"><h3>Perspective</h3></div>
          <DeskSeg label="Perspective" value={p.dimension} onChange={p.onDimension} options={[{ key: '2d', label: '2D · Flat' }, { key: '3d', label: '3D · Tilted' }]} />
        </div>
        <div className="mxd-block">
          <div className="mxd-block__head"><h3>Light & world</h3>{light ? <em>{light.label} here · sun {Math.round(light.altitude)}°</em> : null}</div>
          <div className="mxd-rows">
            <div className="mxd-row">
              <span className="mxd-row__copy"><strong>Living Map</strong><span>{livingOn ? 'The physical world under the glass' : 'Off — the map renders flat, as before'}</span></span>
              <DeskSwitch on={livingOn} onChange={(v) => p.onLiving({ enabled: v })} label="Living Map" />
            </div>
            <div className={cls('mxd-row', !livingOn && 'is-disabled')}>
              <span className="mxd-row__copy"><strong>Real daylight</strong><span>Day, golden hour, twilight and night from the sun’s real position</span></span>
              <DeskSwitch on={p.living.daylight} onChange={(v) => p.onLiving({ daylight: v })} label="Real daylight" disabled={!livingOn} />
            </div>
            <div className={cls('mxd-row', (!livingOn || !p.vectorBuildings) && 'is-disabled')}>
              <span className="mxd-row__copy">
                <strong>3D buildings</strong>
                <span>{!p.vectorBuildings ? 'This map style has no building data' : p.dimension === '3d' ? 'Real heights where the source has them — downtown cores' : 'Shows when tilted · real heights, downtown cores'}</span>
              </span>
              <DeskSwitch on={p.living.buildings} onChange={(v) => p.onLiving({ buildings: v })} label="3D buildings" disabled={!livingOn || !p.vectorBuildings} />
            </div>
            <div className="mxd-row">
              <span className="mxd-row__copy"><strong>Terrain relief</strong><span>{p.dimension === '3d' ? 'Shaded hills, lifted into 3D' : 'Shaded hills · tilt for true 3D'}</span></span>
              <DeskSwitch on={p.prefs.relief} onChange={(v) => p.setPref('relief', v)} label="Terrain relief" />
            </div>
            {HYBRID_THEMES.has(p.styleMode) ? (
              <div className="mxd-row">
                <span className="mxd-row__copy"><strong>Roads & places</strong><span>Street names, highways and towns over the imagery</span></span>
                <DeskSwitch on={p.prefs.labels} onChange={(v) => p.setPref('labels', v)} label="Roads and places" />
              </div>
            ) : null}
          </div>
          {p.styleMode === 'satellite' ? (
            <DeskSeg size="sm" label="Imagery colour" value={p.prefs.trueColor ? 'true' : 'tactical'} onChange={(v) => p.setPref('trueColor', v === 'true')} options={[{ key: 'true', label: 'True colour' }, { key: 'tactical', label: 'Tactical' }]} />
          ) : null}
        </div>
        {APPEARANCE_GROUPS.map((g) => {
          const items = g.ids.map((id) => p.themes.find((t) => t.id === id)).filter(Boolean) as MapDeskChromeProps['themes'][number][]
          if (!items.length) return null
          return (
            <div key={g.label} className="mxd-block">
              <div className="mxd-block__head"><h3>{g.label}</h3></div>
              <div className="mxd-tiles">
                {items.map((t) => (
                  <button key={t.id} type="button" className={cls('mxd-tile', t.id === p.styleMode && 'is-on')} aria-pressed={t.id === p.styleMode} onClick={() => p.onStyle(t.id)} data-theme-id={t.id}>
                    <i style={{ background: t.accentColor }} aria-hidden="true" />{t.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── the chrome ──────────────────────────────────────────────────────────────
export function MapDeskChrome(p: MapDeskChromeProps) {
  const { map, mapEpoch, reducedMotion, lens, filtersOpen, onCloseFilters, activityOn } = p
  const { tool, onTool: setTool } = p
  const filtersOpenRef = useRef(filtersOpen)
  filtersOpenRef.current = filtersOpen
  const onCloseFiltersRef = useRef(onCloseFilters)
  onCloseFiltersRef.current = onCloseFilters
  const [picker, setPicker] = useState<Picker>(null)
  const [appearanceTop, setAppearanceTop] = useState(14)
  const railRef = useRef<HTMLElement | null>(null)

  // One left surface at a time: Filters (owned by the Command Map) closes ours.
  useEffect(() => { if (filtersOpen) setTool((t) => (t === 'appearance' ? t : null)) }, [filtersOpen, setTool])
  // Drawing takes the whole map.
  useEffect(() => { if (p.drawing) { setTool(null); setPicker(null) } }, [p.drawing, setTool])

  const openTool = useCallback((next: DeskOpenTool) => {
    setPicker(null)
    if (next && next !== 'appearance' && filtersOpen) onCloseFilters()
    setTool(next)
  }, [filtersOpen, onCloseFilters, setTool])

  const onRail = (id: DeskTool) => {
    if (id === 'filters') {
      setPicker(null)
      if (filtersOpen) onCloseFilters()
      else { setTool(null); p.onOpenFilters() }
      return
    }
    if (id === 'draw') { setTool(null); setPicker(null); p.onToggleDraw(); return }
    if (id === 'live') {
      if (tool === 'live') { openTool(null); return }
      if (!activityOn) p.onActivity(true)
      openTool('live')
      return
    }
    if (id === 'appearance') {
      setTool((t) => (t === 'appearance' ? null : 'appearance'))
      setPicker(null)
      return
    }
    openTool(tool === id ? null : id)
  }

  // Appearance opens beside its own rail button, however it was opened (the rail,
  // or the world capsule's "Living Map settings" link).
  useLayoutEffect(() => {
    if (tool !== 'appearance') return
    const rail = railRef.current
    const btn = rail?.querySelector<HTMLElement>('[data-map-control="appearance"]')
    if (rail && btn) setAppearanceTop(Math.max(8, btn.offsetTop + rail.offsetTop - 6))
  }, [tool])

  // A narrow pane can't hold a left inspector AND a docked card: the newest intent
  // wins. Opening the card (HALF/FULL) closes the inspector here; opening an
  // inspector over a docked card yields the card (CSS, while the inspector is open).
  useEffect(() => {
    const onPresence = (e: Event) => {
      const next = (e as CustomEvent<DeskCardPresence | null>).detail
      if (!next || next.state === 'preview') return
      const width = map?.getContainer().clientWidth ?? Infinity
      if (width > NARROW_PANE) return
      setTool((t) => (t === 'layers' || t === 'live' ? null : t))
      if (filtersOpenRef.current) onCloseFiltersRef.current()
    }
    window.addEventListener(DESK_CARD_PRESENCE_EVENT, onPresence)
    return () => window.removeEventListener(DESK_CARD_PRESENCE_EVENT, onPresence)
  }, [map, setTool])

  // Escape closes the open left inspector (one subscription, latest state via ref).
  const toolRef = useRef(tool)
  toolRef.current = tool
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (toolRef.current === 'layers' || toolRef.current === 'live') setTool(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTool])

  // ── the world capsule slot (LivingMap portals its chip here) ──
  // LivingMap mounts before this chrome and subscribes in an effect, after our
  // ref has already fired — so the slot is announced again once effects run.
  const worldSlotRef = useRef<HTMLDivElement | null>(null)
  const setWorldSlot = useCallback((el: HTMLDivElement | null) => {
    worldSlotRef.current = el
    ;(window as unknown as { __nxWorldSlot?: HTMLElement | null }).__nxWorldSlot = el
    window.dispatchEvent(new CustomEvent('nexus:world-slot', { detail: el }))
  }, [])
  useEffect(() => {
    const el = worldSlotRef.current
    if (el) window.dispatchEvent(new CustomEvent('nexus:world-slot', { detail: el }))
  }, [p.drawing])

  // ── does this theme carry vector buildings (CARTO)? imagery themes don't ──
  const [vectorBuildings, setVectorBuildings] = useState(true)
  useEffect(() => {
    if (!map) return undefined
    const read = () => { try { setVectorBuildings(Boolean(map.getSource('carto'))) } catch { /* style mid-swap */ } }
    read()
    map.on('styledata', read)
    return () => { map.off('styledata', read) }
  }, [map, mapEpoch, p.styleMode])

  // ── market bubbles: a click opens that market in the bottom shelf; a metro
  //    cluster (a grid cell, not a place) flies in. Only while bubbles are drawn.
  useEffect(() => {
    if (!map) return undefined
    const LAYER = 'map-agg-cluster-core'
    const onClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      if ((e as { _clickHandled?: boolean })._clickHandled) return
      const f = e.features?.[0]
      if (!f) return
      try { if (map.getPaintProperty(LAYER, 'circle-opacity') === 0 || map.getLayoutProperty(LAYER, 'visibility') === 'none') return } catch { return }
      ;(e as { _clickHandled?: boolean })._clickHandled = true
      const props = (f.properties ?? {}) as Record<string, unknown>
      const market = String(props.market ?? '').trim()
      if (props.aggregate_type === 'market' && market) {
        window.dispatchEvent(new CustomEvent(MAP_OPEN_AREA_EVENT, { detail: { kind: 'market', key: market, label: market } }))
        return
      }
      const g = f.geometry as { coordinates?: [number, number] }
      if (g?.coordinates) map.easeTo({ center: g.coordinates, zoom: Math.min(14, map.getZoom() + 2), duration: reducedMotion ? 0 : 700 })
    }
    const enter = () => { try { if (map.getPaintProperty(LAYER, 'circle-opacity') !== 0) map.getCanvas().style.cursor = 'pointer' } catch { /* ignore */ } }
    const leave = () => { map.getCanvas().style.cursor = '' }
    map.on('click', LAYER, onClick)
    map.on('mouseenter', LAYER, enter)
    map.on('mouseleave', LAYER, leave)
    return () => { map.off('click', LAYER, onClick); map.off('mouseenter', LAYER, enter); map.off('mouseleave', LAYER, leave) }
  }, [map, mapEpoch, reducedMotion])

  // ── L5 toasts: a brand-new REALTIME event while Live is on (never the backlog) ──
  const [toasts, setToasts] = useState<Toast[]>([])
  const seenRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!activityOn) { seenRef.current = null; setToasts([]); return }
    // Seed only once the stream's own backfill has landed: the last day arriving
    // in one batch is history, not news.
    if (p.liveCoveredSince === null) return
    if (seenRef.current === null) { seenRef.current = new Set(p.liveEvents.map((e) => e.id)); return }
    const fresh = p.liveEvents.filter((e) => !seenRef.current!.has(e.id))
    if (!fresh.length) return
    for (const e of fresh) seenRef.current.add(e.id)
    const now = Date.now()
    const recent = fresh.filter((e) => now - eventTime(e) < 10 * 60_000)
    if (!recent.length) return
    setToasts((cur) => [...recent.slice(0, 3).map((e) => ({ id: e.id, event: e, at: now })), ...cur].slice(0, 3))
  }, [p.liveEvents, p.liveCoveredSince, activityOn])
  useEffect(() => {
    if (!toasts.length) return undefined
    const t = window.setTimeout(() => { const cut = Date.now() - 6500; setToasts((cur) => cur.filter((x) => x.at > cut)) }, 1000)
    return () => window.clearTimeout(t)
  }, [toasts])

  const signal = liveSignal({ streamLive: p.streamLive, activityOn })
  const windowLabel = ACTIVITY_WINDOWS.find((w) => w.key === p.activityWindow)?.label ?? 'Today'
  const pillSub = lensPillSub({ inView: p.inView, loading: p.loading, zoom: p.zoom, activityOn, eventCount: p.events.length, windowLabel })
  const leftOpen = tool === 'layers' || tool === 'live' || filtersOpen

  const sensorInput = {
    pins: p.prefs.pins, everyProperty: p.prefs.everyProperty, filterActive: p.filterCount > 0,
    lensId: lens.id, lensLabel: lens.label, lensSub: lens.sub, lensHasSource: Boolean(lens.source), lensAmbient: Boolean(lens.ambient),
    comps: p.prefs.comps, market: p.prefs.market,
    daylight: p.living.daylight, localTime: p.living.localTime, zones: p.living.zones, livingEnabled: p.living.enabled,
    buildings: p.living.buildings, tilted: p.dimension === '3d', vectorBuildings,
    relief: p.prefs.relief, activityOn, streamLive: p.streamLive, orbs: p.prefs.liveOrbs,
  }

  const onPick = (l: MapLens) => { p.onPickLens(l); setPicker(null) }

  return (
    <>
      {/* L1 — the tool rail, set into the glass */}
      <nav ref={railRef} className={cls('mxd-rail', 'mxd-l1', p.drawing && 'is-drawing')} aria-label="Map tools">
        {DESK_TOOLS.map((t) => {
          const active = t.id === 'filters' ? filtersOpen : t.id === 'draw' ? p.drawing : tool === t.id
          const lit = (t.id === 'filters' && p.filterCount > 0) || (t.id === 'live' && activityOn)
          const label = t.id === 'filters' && p.filterCount > 0 ? `Filters · ${p.filterCount} applied` : t.id === 'live' ? (signal === 'live' ? 'Live Activity · streaming' : activityOn ? 'Live Activity · on' : 'Live Activity') : t.label
          return (
            <button
              key={t.id}
              type="button"
              className={cls('mxd-tool', active && 'is-active', lit && 'is-lit')}
              aria-label={label}
              aria-pressed={active}
              data-tip={label}
              data-map-control={t.id === 'live' ? 'activity' : t.id}
              onClick={() => onRail(t.id)}
            >
              {TOOL_ICON[t.id]}
              {t.id === 'filters' && p.filterCount > 0 ? <span className="mxd-tool__badge">{p.filterCount}</span> : null}
              {t.id === 'live' && activityOn ? <span className={cls('mxd-tool__live', signal === 'live' && 'is-live')} aria-hidden="true" /> : null}
            </button>
          )
        })}
      </nav>

      {/* L2 — the command stack */}
      {!p.drawing ? (
        <div className={cls('mxd-stack', leftOpen && 'is-covered')} aria-hidden={leftOpen || undefined}>
          <div className="mxd-stack__search">
            <MapSearch map={map} epoch={mapEpoch} reducedMotion={reducedMotion} onProperty={p.onSearchProperty} onActiveChange={p.onSearchActive} />
          </div>
          <div className="mxd-stack__lens">
            <button
              type="button"
              className={cls('mxd-lens', 'mxd-l2', picker === 'pill' && 'is-open', signal === 'live' && 'is-live')}
              data-map-control="mode"
              data-lens-trigger
              aria-haspopup="dialog"
              aria-expanded={picker === 'pill'}
              onClick={() => setPicker((v) => (v === 'pill' ? null : 'pill'))}
            >
              <span className="mxd-lens__swatch" style={lensSwatchStyle(lens)} aria-hidden="true" />
              <span className="mxd-lens__copy">
                <span className="mxd-lens__title">
                  <b>{lens.label}</b>
                  {signal === 'live' ? <em className="mxd-livebadge" title="Live Activity is streaming from the database"><i aria-hidden="true" />Live</em> : null}
                </span>
                <span className="mxd-lens__sub">{pillSub}</span>
              </span>
              <Icon name="chevron-down" size={13} />
            </button>
            {picker === 'pill' ? <LensPicker active={lens} placement="down" onPick={onPick} onClose={() => setPicker(null)} /> : null}
          </div>
          <div className="mxd-worldslot" ref={setWorldSlot} />
          {p.filterCount > 0 || p.prefs.comps ? (
            <div className="mxd-stack__capsules">
              {p.filterCount > 0 ? (
                <button type="button" className="mxd-capsule mxd-l2 is-filter" data-map-control="filter-summary" onClick={p.onOpenFilters}>
                  <Icon name="filter" size={12} />
                  <span>{filterCapsuleLabel(p.filterCount, p.filterMatching)}</span>
                  <b>Edit</b>
                </button>
              ) : null}
              {p.prefs.comps ? (
                <button type="button" className="mxd-capsule mxd-l2 is-comps" data-map-control="comps" onClick={p.onOpenCompFilters}>
                  <i aria-hidden="true" />
                  <span>{p.comps.loading && !p.comps.total ? 'Reading sales…' : `${fmtCount(p.comps.total) ?? '0'} sold`}</span>
                  <b>Filters</b>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* L2 — legend (and the ZIP market panel) */}
      {!p.drawing ? (
        <div className="mxd-cards">
          {p.prefs.market ? <MarketPanel map={map} epoch={mapEpoch} onClose={() => p.setPref('market', false)} /> : null}
          <MapDeskLegend
            lens={lens}
            state={p.lensState}
            zoom={p.zoom}
            look={p.lensLook}
            onLook={p.onLensLook}
            onColorBy={() => setPicker((v) => (v === 'legend' ? null : 'legend'))}
            pickerOpen={picker === 'legend'}
            collapsed={p.prefs.legendCollapsed}
            onCollapse={(v) => p.setPref('legendCollapsed', v)}
          />
          {picker === 'legend' ? <LensPicker active={lens} placement="up" onPick={onPick} onClose={() => setPicker(null)} /> : null}
        </div>
      ) : null}

      {/* L2 — zoom · perspective · north */}
      <div className="mxd-zoom mxd-l2" role="group" aria-label="Zoom, perspective and orientation">
        <button type="button" className="mxd-tool" aria-label="Zoom in" data-tip="Zoom in" data-map-control="zoom-in" onClick={() => map?.zoomIn({ duration: reducedMotion ? 0 : 260 })}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button type="button" className="mxd-tool" aria-label="Zoom out" data-tip="Zoom out" data-map-control="zoom-out" onClick={() => map?.zoomOut({ duration: reducedMotion ? 0 : 260 })}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
        <span className="mxd-rail__rule" aria-hidden="true" />
        <button
          type="button"
          className={cls('mxd-tool', 'is-text', p.dimension === '3d' && 'is-lit')}
          aria-label={p.dimension === '3d' ? 'Flat view (2D)' : 'Tilt into 3D'}
          aria-pressed={p.dimension === '3d'}
          data-tip={p.dimension === '3d' ? 'Flat view' : 'Tilt into 3D'}
          data-map-control="dimension"
          onClick={() => p.onDimension(p.dimension === '3d' ? '2d' : '3d')}
        >
          {p.dimension === '3d' ? '3D' : '2D'}
        </button>
        <button type="button" className={cls('mxd-tool', Math.abs(p.bearing) > 0.5 && 'is-turned')} aria-label="Reset to north" data-tip="Reset to north" data-map-control="north" onClick={() => map?.easeTo({ bearing: 0, pitch: p.dimension === '3d' ? map.getPitch() : 0, duration: reducedMotion ? 0 : 520 })}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${-p.bearing}deg)` }}>
            <path d="M12 3.5 15 12h-6z" fill="var(--mxd-north, #ff453a)" />
            <path d="M12 20.5 9 12h6z" fill="currentColor" opacity="0.5" />
          </svg>
        </button>
        {/* Recenter is navigation, so it lives with zoom and north, not among
            the tools: a quiet control, not a call to action (owner, 2026-09-30). */}
        <button type="button" className="mxd-tool is-quiet" aria-label={p.recenterLabel} data-tip={p.recenterLabel} data-map-control="recenter" onClick={p.onRecenter}>
          <Icon name="target" size={15} />
        </button>
      </div>

      {/* L3 — left inspectors owned here (Filters is the Command Map's) */}
      {tool === 'layers' ? (
        <section className="mxd-insp is-left mxd-layers" role="dialog" aria-modal="false" aria-label="Layers" data-map-inspector="layers">
          <header className="mxd-insp__head">
            <span className="mxd-insp__glyph" aria-hidden="true"><Icon name="layers" size={15} /></span>
            <div className="mxd-insp__title"><h2>Layers</h2><p>Sensor array · what the map draws, and from where</p></div>
            <button type="button" className="mxd-icon-btn" aria-label="Close layers" onClick={() => openTool(null)} data-map-sheet-close><Icon name="close" size={14} /></button>
          </header>
          <div className="mxd-insp__body">
            <MapDeskLayers
              input={sensorInput}
              onPins={(v) => p.setPref('pins', v)}
              pinOpacity={clampOpacity(p.prefs.pinOpacity)}
              onPinOpacity={(v) => p.setPref('pinOpacity', clampOpacity(v))}
              performance={p.performance}
              onPerformance={p.onPerformance}
              onEveryProperty={(v) => p.setPref('everyProperty', v)}
              filterSummary={p.filterCount > 0 ? filterCapsuleLabel(p.filterCount, p.filterMatching) : null}
              onEditFilters={() => { setTool(null); p.onOpenFilters() }}
              onLensVisible={p.onLensVisible}
              onChooseLens={() => setPicker((v) => (v === 'side' ? null : 'side'))}
              lensStyle={p.lensLook.style}
              lensBlend={p.lensLook.blend}
              lensOpacity={clampOpacity(p.lensLook.opacity ?? 1)}
              onLensLook={p.onLensLook}
              onComps={(v) => p.setPref('comps', v)}
              compFilters={p.prefs.compFilters}
              onCompWindow={(w) => p.setPref('compFilters', { ...p.prefs.compFilters, window: w })}
              compsTotal={p.prefs.comps && !p.comps.loading ? fmtCount(p.comps.total) : null}
              onCompFilters={p.onOpenCompFilters}
              onMarket={(v) => p.setPref('market', v)}
              onDaylight={(v) => p.onLiving({ daylight: v })}
              onLocalTime={(v) => p.onLiving({ localTime: v })}
              onZones={(v) => p.onLiving({ zones: v })}
              onBuildings={(v) => p.onLiving({ buildings: v })}
              onRelief={(v) => p.setPref('relief', v)}
              onTilt={() => p.onDimension('3d')}
              onActivity={p.onActivity}
              activityWindow={p.activityWindow}
              onActivityWindow={p.onActivityWindow}
              activityScope={p.scope}
              onActivityScope={p.onScope}
              scopeCounts={p.scopeCounts}
              onOrbs={(v) => p.setPref('liveOrbs', v)}
            />
          </div>
        </section>
      ) : null}
      {tool === 'live' ? <LiveInspector {...p} onClose={() => openTool(null)} /> : null}

      {/* L4 — Color by, beside the Layers inspector */}
      {picker === 'side' && tool === 'layers' ? <LensPicker active={lens} placement="side" onPick={onPick} onClose={() => setPicker(null)} /> : null}

      {/* L4 — Appearance, beside its rail button */}
      {tool === 'appearance' ? <AppearancePopover {...p} top={appearanceTop} vectorBuildings={vectorBuildings} onClose={() => setTool(null)} /> : null}

      {/* L5 — live events as they land */}
      {toasts.length ? (
        <div className="mxd-toasts" aria-live="polite">
          {toasts.map((t) => (
            <button key={t.id} type="button" className={cls('mxd-toast', 'mxd-l5', `tier-${tierOf(t.event)}`)} onClick={() => { setToasts((cur) => cur.filter((x) => x.id !== t.id)); p.onOpenEvent(t.event) }}>
              <span className="mxd-toast__dot" aria-hidden="true" />
              <span className="mxd-toast__copy">
                <strong>{t.event.title}</strong>
                <span>{[t.event.subtitle, t.event.address || t.event.market, agoLabel(eventTime(t.event), p.clock)].filter(Boolean).join(' · ')}</span>
              </span>
              <em>Live</em>
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}
