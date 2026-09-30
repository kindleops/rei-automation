import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import maplibregl from 'maplibre-gl'
import { Icon } from '../../../shared/icons'
import { useLivingSettings, living } from './living-settings'
import { useWorldLight } from './useWorldLight'
import { useBuildings3D } from './useBuildings3D'
import { nextSunEvent, type LightState } from './solar'
import { fetchWorld, fetchZones, invalidateWorldCaches, localClock, untilLabel, windowIsStale, windowTone, type WorldResponse, type ZonesResponse } from './world-api'
import './world.css'

/**
 * LIVING MAP — the physical world under the glass.
 *
 * Composes: real daylight (useWorldLight), real building volumes
 * (useBuildings3D), the place / local time / seller contact window for the
 * geography in view, zone clocks at national zoom, and camera memory for the
 * property card. Off (master switch) = the map renders exactly as before.
 * Every value comes from the server's canonical resolution or from the sun;
 * nothing is shown that could not be resolved.
 */

const NATIONAL_ZOOM = 5.2
/** Which clock survives when two would overlap on a narrow screen. */
const ZONE_PRIORITY = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu']
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const kmApart = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180))
/** Why there is no local time here, in words. */
const noZoneWhy = (reason?: string) => (reason === 'timezone_ambiguous_for_geography' ? 'Timezone not certain here' : 'No LeadCommand geography here')

export interface LivingMapProps {
  map: maplibregl.Map | null
  mapEpoch: number
  theme: string
  tilted: boolean
  selected: [number, number] | null
  reducedMotion: boolean
  isMobile: boolean
  /** Card/sheet open: the chip steps aside. */
  cardOpen: boolean
}

function PhaseGlyph({ ls }: { ls: LightState | null }) {
  const phase = ls?.phase ?? 'day'
  if (phase === 'night' || phase === 'twilight') return <span className={cls('nxw-glyph', `is-${phase}`)} aria-hidden><Icon name="moon" size={13} /></span>
  return <span className={cls('nxw-glyph', `is-${phase}`)} aria-hidden><i /></span>
}

export function LivingMap({ map, mapEpoch, theme, tilted, selected, reducedMotion, isMobile, cardOpen }: LivingMapProps) {
  const [settings] = useLivingSettings()
  const on = living(settings)
  const light = useWorldLight(map, mapEpoch, { enabled: on.daylight, theme, tilted, reducedMotion })
  useBuildings3D(map, mapEpoch, { enabled: on.buildings, tilted, theme, night: Boolean(light && (light.phase === 'night' || light.phase === 'twilight')), selected })

  // ── where are we looking ──
  const [zoom, setZoom] = useState<number>(() => map?.getZoom() ?? 4)
  const [world, setWorld] = useState<WorldResponse | null>(null)
  const [worldStatus, setWorldStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const worldAt = useRef<{ lat: number; lng: number } | null>(null)
  const [zones, setZones] = useState<ZonesResponse | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const national = zoom < NATIONAL_ZOOM

  useEffect(() => {
    if (!map || !on.localTime) { setWorld(null); setWorldStatus('idle'); return }
    let timer = 0
    const ac = { current: null as AbortController | null }
    const read = () => {
      const z = map.getZoom()
      setZoom(z)
      if (z < NATIONAL_ZOOM) return
      // Somewhere else entirely: the last answer would be wrong while the new one loads.
      const c0 = map.getCenter()
      if (worldAt.current && kmApart(worldAt.current, c0) > 25) setWorld(null)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        ac.current?.abort()
        const c = new AbortController(); ac.current = c
        const center = map.getCenter()
        setWorldStatus('loading')
        // One quiet retry: a cold server or a dropped request should not read as "unknown".
        const attempt = (n: number) => {
          fetchWorld(center.lat, center.lng, c.signal)
            .then((w) => { if (c.signal.aborted) return; worldAt.current = { lat: center.lat, lng: center.lng }; setWorld(w); setWorldStatus('ready') })
            .catch(() => {
              if (c.signal.aborted) return
              if (n === 0) { timer = window.setTimeout(() => { if (!c.signal.aborted) attempt(1) }, 2500); return }
              setWorldStatus('failed')
            })
        }
        attempt(0)
      }, 380)
    }
    read()
    map.on('moveend', read)
    return () => { map.off('moveend', read); window.clearTimeout(timer); ac.current?.abort() }
  }, [map, mapEpoch, on.localTime])

  useEffect(() => {
    if (!on.localTime || !on.zones || !national) return
    const ac = new AbortController()
    fetchZones(ac.signal).then(setZones).catch(() => { /* zones simply absent */ })
    return () => ac.abort()
  }, [on.localTime, on.zones, national])

  // Clock: re-render every 20 s; re-read when a window boundary passes.
  useEffect(() => {
    if (!on.localTime) return
    const t = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      const n = Date.now()
      setNow(n)
      if (world && windowIsStale(world.contact_window, n) && map) {
        invalidateWorldCaches()
        const c = map.getCenter()
        fetchWorld(c.lat, c.lng).then(setWorld).catch(() => { /* ignore */ })
      }
      if (zones && zones.zones.some((z) => windowIsStale(z.contact_window, n))) {
        invalidateWorldCaches()
        fetchZones().then(setZones).catch(() => { /* ignore */ })
      }
    }, 20_000)
    return () => window.clearInterval(t)
  }, [on.localTime, world, zones, map])

  // ── zone clocks at national zoom (DOM markers: no glyph dependency) ──
  const markers = useRef<Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>>(new Map())
  useEffect(() => {
    const clear = () => { for (const m of markers.current.values()) m.marker.remove(); markers.current.clear() }
    if (!map || !on.localTime || !on.zones || !national || !zones) { clear(); return }
    for (const z of zones.zones) {
      let entry = markers.current.get(z.iana)
      if (!entry) {
        // MapLibre owns the marker element (its classes position it); we only
        // ever write into an inner child.
        const el = document.createElement('div')
        const inner = document.createElement('div')
        inner.className = 'nxw-zone'
        el.appendChild(inner)
        entry = { el: inner, marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([z.lng, z.lat]).addTo(map) }
        markers.current.set(z.iana, entry)
      }
      const tone = windowTone(z.contact_window, now)
      const status = tone === 'quiet' ? 'Quiet hours' : tone === 'unknown' ? 'Window unknown' : tone === 'closing' ? `Closes in ${untilLabel(z.contact_window?.closes_at ?? null, now)}` : 'Window open'
      entry.el.className = cls('nxw-zone', `is-${tone}`)
      entry.el.innerHTML = `<b>${z.city.toUpperCase()}</b><span><em></em>${localClock(z.iana, new Date(now))} ${z.abbr}</span>`
      entry.el.setAttribute('aria-label', `${z.city}: ${localClock(z.iana, new Date(now))} ${z.abbr}. ${status}`)
      entry.el.title = status
    }
    return undefined
  }, [map, on.localTime, on.zones, national, zones, now])
  useEffect(() => () => { for (const m of markers.current.values()) m.marker.remove(); markers.current.clear() }, [map])

  // Narrow screens: clocks that would overlap a more important one fade out.
  useEffect(() => {
    if (!map || !on.localTime || !on.zones || !national || !zones) return
    let raf = 0
    const resolve = () => {
      raf = 0
      const kept: DOMRect[] = []
      const order = [...markers.current.entries()].sort((a, b) => ZONE_PRIORITY.indexOf(a[0]) - ZONE_PRIORITY.indexOf(b[0]))
      for (const [, e] of order) {
        const r = e.el.getBoundingClientRect()
        const clash = kept.some((k) => r.left < k.right + 6 && r.right > k.left - 6 && r.top < k.bottom + 4 && r.bottom > k.top - 4)
        e.el.dataset.hidden = clash ? '1' : '0'
        if (!clash) kept.push(r)
      }
    }
    const schedule = () => { if (!raf) raf = window.requestAnimationFrame(resolve) }
    schedule()
    map.on('move', schedule)
    window.addEventListener('resize', schedule)
    return () => { map.off('move', schedule); window.removeEventListener('resize', schedule); if (raf) window.cancelAnimationFrame(raf) }
  }, [map, on.localTime, on.zones, national, zones, now])

  // ── camera memory: a closed card returns the view it came from ──
  const settled = useRef<{ center: maplibregl.LngLat; zoom: number; pitch: number; bearing: number } | null>(null)
  const wandered = useRef(false)
  const prevSel = useRef<[number, number] | null>(null)
  const saved = useRef<typeof settled.current>(null)
  useEffect(() => {
    if (!map) return
    const onEnd = () => { if (!prevSel.current) settled.current = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() } }
    const onUser = (e: { originalEvent?: unknown }) => { if (prevSel.current && e.originalEvent) wandered.current = true }
    onEnd()
    map.on('moveend', onEnd)
    map.on('dragstart', onUser)
    map.on('zoomstart', onUser)
    return () => { map.off('moveend', onEnd); map.off('dragstart', onUser); map.off('zoomstart', onUser) }
  }, [map, mapEpoch])
  useEffect(() => {
    if (!map || !settings.enabled) { prevSel.current = selected; return }
    const was = prevSel.current
    prevSel.current = selected
    if (!was && selected) {
      saved.current = settled.current
      wandered.current = false
      // Tilted with real buildings: once the existing selection ease settles,
      // frame the structure closely enough for its volume to read.
      if (tilted && on.buildings) {
        map.once('moveend', () => {
          if (prevSel.current && map.getZoom() < 15.6) map.easeTo({ center: prevSel.current, zoom: 16.2, duration: reducedMotion ? 0 : 700, essential: true })
        })
      }
    } else if (was && !selected && saved.current && !wandered.current) {
      const s = saved.current
      saved.current = null
      map.easeTo({ center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing, duration: reducedMotion ? 0 : 650, essential: true })
    }
  }, [map, selected?.[0], selected?.[1], settings.enabled, tilted, on.buildings, reducedMotion])

  // ── phone: the chip lives in the map chrome's own row, under the mode pill ──
  const [slot, setSlot] = useState<HTMLElement | null>(() => (typeof window !== 'undefined' ? ((window as unknown as { __nxWorldSlot?: HTMLElement | null }).__nxWorldSlot ?? null) : null))
  useEffect(() => {
    const on = (e: Event) => setSlot(((e as CustomEvent).detail as HTMLElement | null) ?? null)
    window.addEventListener('nexus:world-slot', on)
    return () => window.removeEventListener('nexus:world-slot', on)
  }, [])

  // ── chip content ──
  const tz = world?.timezone.iana || null
  const cw = world?.contact_window || null
  const tone = windowTone(cw, now)
  const sun = useMemo(() => {
    if (!map || !open) return null
    const c = map.getCenter()
    return nextSunEvent(new Date(now), c.lat, c.lng)
  }, [map, open, now])
  const openZones = zones ? zones.zones.filter((z) => z.contact_window?.open).length : null
  const openLayers = useCallback(() => { setOpen(false); window.dispatchEvent(new CustomEvent('nexus:map-open-layers', { detail: { tab: 'appearance' } })) }, [])

  if (!settings.enabled || (!on.localTime && !on.daylight)) return null
  const place = world?.place
  const placeLabel = national ? 'United States' : place?.city || place?.market?.replace(/,\s*[A-Z]{2}$/, '') || (place?.state ? place.state : null)

  const content = (
    <div className={cls('nxw', isMobile ? 'is-mobile' : 'is-desktop', cardOpen && 'is-aside', open && 'is-open')} data-testid="living-map">
      <button type="button" className={cls('nxw-chip', `is-${tone}`)} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Local time and seller contact window">
        <PhaseGlyph ls={light} />
        {on.localTime && national ? (
          <span className="nxw-chip__main"><b>United States</b>{openZones !== null ? <em>{openZones} of {zones!.zones.length} zones in window</em> : <em>{light?.label ?? ''}</em>}</span>
        ) : on.localTime && placeLabel && tz ? (
          <span className="nxw-chip__main">
            <b>{placeLabel.toUpperCase()} · {localClock(tz, new Date(now))} {world?.timezone.abbr}</b>
            {cw ? <em><i className="nxw-dot" />{cw.open ? `Open · closes in ${untilLabel(cw.closes_at, now)}` : `Quiet hours · opens ${localClock(tz, new Date(cw.next_open_at || now))}`}</em> : <em>{light?.label}</em>}
          </span>
        ) : (
          <span className="nxw-chip__main">
            <b>{light?.label ?? 'Living map'}</b>
            {on.localTime && !national ? (world && !tz ? <em>{noZoneWhy(world.timezone.reason)}</em> : !world && worldStatus === 'loading' ? <em>Resolving local time…</em> : !world && worldStatus === 'failed' ? <em>Local time unavailable</em> : null) : null}
          </span>
        )}
      </button>
      {open ? (
        <div className="nxw-pop" role="dialog" aria-label="Local context">
          {national ? (
            <>
              <p className="nxw-pop__eyebrow">Across the country</p>
              <ul className="nxw-zonelist">
                {(zones?.zones || []).map((z) => {
                  const t = windowTone(z.contact_window, now)
                  return <li key={z.iana} className={`is-${t}`}><b>{z.label}</b><span>{localClock(z.iana, new Date(now))} {z.abbr}</span><em>{t === 'quiet' ? 'Quiet' : t === 'closing' ? `Closes ${untilLabel(z.contact_window?.closes_at ?? null, now)}` : t === 'open' ? 'Open' : '—'}</em></li>
                })}
              </ul>
              {zones?.window ? <p className="nxw-pop__note">Seller contact window {zones.window.start}–{zones.window.end} local time, per the operator policy.</p> : null}
            </>
          ) : (
            <>
              <p className="nxw-pop__eyebrow">{[place?.city, place?.state, place?.zip].filter(Boolean).join(' · ') || 'Here'}</p>
              <dl className="nxw-facts">
                {tz ? <div><dt>Local time</dt><dd>{localClock(tz, new Date(now))} {world?.timezone.abbr}<small>{tz}</small></dd></div>
                  : world ? <div><dt>Local time</dt><dd>Unknown<small>{noZoneWhy(world.timezone.reason)}</small></dd></div>
                    : <div><dt>Local time</dt><dd>{worldStatus === 'failed' ? 'Unavailable' : 'Resolving…'}{worldStatus === 'failed' ? <small>The world service did not answer</small> : null}</dd></div>}
                <div><dt>Light</dt><dd>{light?.label ?? '—'}{sun && tz ? <small>{sun.kind === 'sunset' ? 'Sunset' : 'Sunrise'} {localClock(tz, sun.at)}</small> : null}</dd></div>
                <div><dt>Seller contact</dt><dd className={`is-${tone}`}>{cw ? (cw.open ? 'Open' : 'Quiet hours') : world ? 'Unknown' : worldStatus === 'failed' ? 'Unavailable' : 'Resolving…'}{cw ? <small>{cw.open ? `Closes in ${untilLabel(cw.closes_at, now)} · ${cw.window} local` : `Opens ${tz ? localClock(tz, new Date(cw.next_open_at || now)) : ''} · ${cw.window} local`}</small> : world ? <small>Needs a confident local timezone</small> : null}</dd></div>
                {place?.market ? <div><dt>Market</dt><dd>{place.market}</dd></div> : null}
              </dl>
            </>
          )}
          <button type="button" className="nxw-pop__link" onClick={openLayers}>Living Map settings<Icon name="chevron-right" size={14} /></button>
        </div>
      ) : null}
    </div>
  )
  if (isMobile) return slot && slot.isConnected ? createPortal(content, slot) : null
  return content
}
