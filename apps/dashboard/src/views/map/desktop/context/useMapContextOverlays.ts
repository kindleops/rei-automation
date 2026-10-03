/**
 * The Map's context overlays (desktop): their preferences, one viewport read
 * per overlay through the operator-gated API, the MapLibre layers, and what
 * the operator has picked on the map (a camera, an incident, a presence area).
 *
 * Preferences are the desk's own (localStorage), so the phone never sees them.
 * Reads are debounced on camera stops, newest request wins, and an overlay
 * that is off costs nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import { callBackend } from '../../../../lib/api/backendClient'
import {
  CONTEXT_DEFAULTS, OVERLAY_OFF, cameraStatus, camerasRequestFor, contextGroup, crimeRequestFor, crimeStatus, presenceRequestFor, presenceStatus,
  type CamerasReply, type ContextPrefs, type CrimeIncident, type CrimeReply, type OverlayStatus, type PresenceCell, type PresenceReply, type ViewBox,
} from './context-model'
import { CTX_IDS, cameraFeatures, crimeFeatures, ensureCameras, ensureCrime, ensurePresence, presenceData, removeCameras, removeCrime, removePresence } from './context-layers'

const STORE = 'nexus.map.deskContext'
const LIGHT_BASEMAPS = new Set(['light_street', 'terrain'])

function readPrefs(): ContextPrefs {
  try { return { ...CONTEXT_DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') } } catch { return CONTEXT_DEFAULTS }
}

export function useContextPrefs(): [ContextPrefs, (patch: Partial<ContextPrefs>) => void] {
  const [prefs, setPrefs] = useState<ContextPrefs>(readPrefs)
  const set = useCallback((patch: Partial<ContextPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      try { localStorage.setItem(STORE, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [])
  return [prefs, set]
}

interface ViewportRead<T> { reply: T | null; loading: boolean; refused: boolean; failed: boolean; zoom: number; key: string }
const IDLE = { reply: null, loading: false, refused: false, failed: false, zoom: 0, key: '' }

/** One overlay's read for the current viewport. `pathFor` returning null = refused before any call. */
function useViewportRead<T extends { ok: boolean }>(map: maplibregl.Map | null, mapEpoch: number, on: boolean, pathFor: (b: ViewBox, zoom: number) => string | null, key: string): ViewportRead<T> {
  const [read, setRead] = useState<ViewportRead<T>>(IDLE)
  const pathRef = useRef(pathFor)
  useEffect(() => { pathRef.current = pathFor })
  useEffect(() => {
    if (!map || !on) return undefined
    let alive = true
    let timer: number | undefined
    let ctl: AbortController | null = null
    let seq = 0
    const load = async () => {
      const id = ++seq
      const b = map.getBounds()
      const zoom = map.getZoom()
      const path = pathRef.current({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, zoom)
      if (!path) { setRead({ reply: null, loading: false, refused: true, failed: false, zoom, key }); return }
      ctl?.abort()
      ctl = new AbortController()
      setRead((r) => ({ ...r, loading: true, zoom, key }))
      const res = await callBackend<T>(path, { signal: ctl.signal, timeoutMs: 30_000 })
      if (!alive || id !== seq) return
      const body = res.ok ? (res.data as T | undefined) : undefined
      setRead({ reply: body && body.ok ? body : null, loading: false, refused: false, failed: !body || !body.ok, zoom, key })
    }
    const schedule = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => { void load() }, 360)
    }
    schedule()
    map.on('moveend', schedule)
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
      ctl?.abort()
      map.off('moveend', schedule)
    }
  }, [map, mapEpoch, on, key])
  return on && read.key === key ? read : { ...IDLE, key }
}

/** Keep one overlay drawn (re-adding it after a theme swap), or removed when off. */
function useOverlayDraw(map: maplibregl.Map | null, mapEpoch: number, on: boolean, fc: GeoJSON.FeatureCollection, probe: string, ensure: (m: maplibregl.Map, fc: GeoJSON.FeatureCollection) => void, remove: (m: maplibregl.Map) => void) {
  const ensureRef = useRef(ensure)
  useEffect(() => { ensureRef.current = ensure })
  useEffect(() => {
    if (!map) return undefined
    if (!on) { remove(map); return undefined }
    const apply = (force: boolean) => { try { if (force || !map.getLayer(probe)) ensureRef.current(map, fc) } catch { /* style mid-swap */ } }
    apply(true)
    const onStyle = () => apply(false)
    map.on('styledata', onStyle)
    return () => { map.off('styledata', onStyle) }
  }, [map, mapEpoch, on, fc, probe, remove])
}

export type ContextPick =
  | { kind: 'camera'; id: string; name: string | null }
  | { kind: 'crime'; incident: CrimeIncident }
  | { kind: 'presence'; cell: PresenceCell }

export interface MapContextOverlays {
  prefs: ContextPrefs
  setPrefs: (patch: Partial<ContextPrefs>) => void
  cameras: { status: OverlayStatus; reply: CamerasReply | null }
  crime: { status: OverlayStatus; reply: CrimeReply | null }
  presence: { status: OverlayStatus; reply: PresenceReply | null }
  group: ReturnType<typeof contextGroup>
  pick: ContextPick | null
  setPick: (p: ContextPick | null) => void
}

export function useMapContextOverlays(map: maplibregl.Map | null, mapEpoch: number, styleMode: string): MapContextOverlays {
  const [prefs, setPrefs] = useContextPrefs()
  const light = LIGHT_BASEMAPS.has(styleMode)

  const cam = useViewportRead<CamerasReply>(map, mapEpoch, prefs.cameras, camerasRequestFor, 'cam')
  const crime = useViewportRead<CrimeReply>(map, mapEpoch, prefs.crime, (b, z) => crimeRequestFor(b, z, prefs.crimeDays), `crime:${prefs.crimeDays}`)
  const pres = useViewportRead<PresenceReply>(map, mapEpoch, prefs.presence, (b, z) => presenceRequestFor(b, z, prefs.presenceMonths), `pres:${prefs.presenceMonths}`)

  const camFc = useMemo(() => cameraFeatures(cam.reply), [cam.reply])
  const crimeFc = useMemo(() => crimeFeatures(crime.reply), [crime.reply])
  const presFc = useMemo(() => presenceData(pres.reply), [pres.reply])
  useOverlayDraw(map, mapEpoch, prefs.cameras, camFc, CTX_IDS.camDots, (m, fc) => ensureCameras(m, fc, light), removeCameras)
  useOverlayDraw(map, mapEpoch, prefs.crime, crimeFc, CTX_IDS.crimeDots, (m, fc) => ensureCrime(m, fc, light), removeCrime)
  useOverlayDraw(map, mapEpoch, prefs.presence, presFc, CTX_IDS.presBuys, (m, fc) => ensurePresence(m, fc, prefs.presenceView), removePresence)
  // view switch without new data
  useEffect(() => {
    if (!map || !prefs.presence) return
    try { if (map.getLayer(CTX_IDS.presBuys)) ensurePresence(map, presFc, prefs.presenceView) } catch { /* style mid-swap */ }
  }, [map, prefs.presence, prefs.presenceView, presFc])

  const [pick, setPick] = useState<ContextPick | null>(null)
  const replies = useRef({ crime: crime.reply, pres: pres.reply })
  useEffect(() => { replies.current = { crime: crime.reply, pres: pres.reply } })

  // Presses on the overlays (each only while its overlay is on).
  useEffect(() => {
    if (!map) return undefined
    const offs: Array<() => void> = []
    const bind = (layer: string, on: boolean, handle: (f: maplibregl.MapGeoJSONFeature) => void) => {
      if (!on) return
      const click = (e: maplibregl.MapLayerMouseEvent) => { const f = e.features?.[0]; if (f) handle(f) }
      const enter = () => { map.getCanvas().style.cursor = 'pointer' }
      const leave = () => { map.getCanvas().style.cursor = '' }
      map.on('click', layer, click)
      map.on('mouseenter', layer, enter)
      map.on('mouseleave', layer, leave)
      offs.push(() => { map.off('click', layer, click); map.off('mouseenter', layer, enter); map.off('mouseleave', layer, leave) })
    }
    bind(CTX_IDS.camHit, prefs.cameras, (f) => { const id = String(f.properties?.id || ''); if (id) setPick({ kind: 'camera', id, name: String(f.properties?.name || '') || null }) })
    bind(CTX_IDS.crimeDots, prefs.crime, (f) => { const i = Number(f.properties?.i); const inc = replies.current.crime?.incidents[i]; if (inc) setPick({ kind: 'crime', incident: inc }) })
    bind(CTX_IDS.presBuys, prefs.presence, (f) => { const c = replies.current.pres?.cells[Number(f.properties?.i)]; if (c) setPick({ kind: 'presence', cell: c }) })
    bind(CTX_IDS.presEntity, prefs.presence, (f) => { const c = replies.current.pres?.cells[Number(f.properties?.i)]; if (c) setPick({ kind: 'presence', cell: c }) })
    return () => { for (const off of offs) off() }
  }, [map, mapEpoch, prefs.cameras, prefs.crime, prefs.presence])

  const camStatus = prefs.cameras ? (cam.refused ? { ...OVERLAY_OFF, on: true, state: 'waiting' as const, reason: 'Zoom in to a state to see cameras' } : cam.loading && !cam.reply ? { ...OVERLAY_OFF, on: true, state: 'loading' as const, reason: 'Reading camera feeds…' } : cam.failed ? cameraStatus(null, cam.zoom) : cam.reply ? cameraStatus(cam.reply, cam.zoom) : { ...OVERLAY_OFF, on: true, state: 'loading' as const }) : OVERLAY_OFF
  const crimeSt = prefs.crime ? (crime.loading && !crime.reply ? { ...OVERLAY_OFF, on: true, state: 'loading' as const, reason: 'Reading city open data…' } : crime.failed ? crimeStatus(null) : crime.reply ? crimeStatus(crime.reply) : { ...OVERLAY_OFF, on: true, state: 'loading' as const }) : OVERLAY_OFF
  const presSt = prefs.presence ? (pres.loading && !pres.reply ? { ...OVERLAY_OFF, on: true, state: 'loading' as const, reason: 'Reading recorded sales…' } : presenceStatus(pres.failed ? null : pres.reply, pres.zoom, pres.refused)) : OVERLAY_OFF

  const activePick = pick && ((pick.kind === 'camera' && prefs.cameras) || (pick.kind === 'crime' && prefs.crime) || (pick.kind === 'presence' && prefs.presence)) ? pick : null

  return {
    prefs,
    setPrefs,
    cameras: { status: camStatus, reply: prefs.cameras ? cam.reply : null },
    crime: { status: crimeSt, reply: prefs.crime ? crime.reply : null },
    presence: { status: presSt, reply: prefs.presence ? pres.reply : null },
    group: contextGroup(camStatus, crimeSt, presSt, prefs),
    pick: activePick,
    setPick,
  }
}
