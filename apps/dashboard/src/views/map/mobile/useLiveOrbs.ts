/**
 * The living map.
 *
 * Every property with real activity in the last 24 hours (the realtime stream:
 * replies, opt-outs, sends, deliveries, failures, stage moves) carries a glowing
 * orb in the colour of what happened; the orb fades as the event ages and the
 * freshest ones breathe. A brand-new event lands with a shockwave and a label
 * that rises off the property. Nothing here is decorative data — no event, no
 * orb.
 */
import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { LiveActivityEvent } from '../live-activity-engine'

const SRC = 'nx-orbs'
const L_HALO = 'nx-orbs-halo'
const L_CORE = 'nx-orbs-core'
const DAY_MS = 24 * 3600_000

/** What happened → colour. */
export function orbColor(type: string): string {
  switch (type) {
    case 'new_reply':
    case 'positive_reply': return '#3ee6ff'
    case 'hot_lead':
    case 'offer':
    case 'contract':
    case 'closing': return '#ffc53d'
    case 'opt_out':
    case 'message_failed': return '#ff4d5e'
    case 'message_delivered': return '#34e89e'
    case 'stage_change': return '#b18cff'
    default: return '#8fb3ff'
  }
}

export const ORB_LABEL: Record<string, string> = {
  new_reply: 'Reply', positive_reply: 'Reply', opt_out: 'Opt-out', message_failed: 'Failed', message_delivered: 'Delivered',
  message_sent: 'Sent', stage_change: 'Stage move', hot_lead: 'Hot', offer: 'Offer', contract: 'Contract', closing: 'Closing',
}

/** One orb per property: its most important recent event wins (replies over sends). */
export function orbFeatures(events: LiveActivityEvent[], now: number): GeoJSON.Feature[] {
  const rank = (t: string) => (t === 'opt_out' ? 6 : t === 'new_reply' || t === 'positive_reply' ? 5 : t === 'hot_lead' || t === 'offer' || t === 'contract' ? 4 : t === 'stage_change' ? 3 : t === 'message_failed' ? 2 : 1)
  const best = new Map<string, { e: LiveActivityEvent; at: number }>()
  for (const e of events) {
    if (typeof e.lat !== 'number' || typeof e.lng !== 'number') continue
    const at = Date.parse(e.occurredAt || e.createdAt || '')
    if (!Number.isFinite(at) || now - at > DAY_MS) continue
    const key = e.propertyId || `${e.lat.toFixed(5)},${e.lng.toFixed(5)}`
    const cur = best.get(key)
    if (!cur || rank(e.type) > rank(cur.e.type) || (rank(e.type) === rank(cur.e.type) && at > cur.at)) best.set(key, { e, at })
  }
  return [...best.values()].map(({ e, at }) => {
    const ageMin = Math.max(0, (now - at) / 60_000)
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [e.lng!, e.lat!] },
      properties: {
        color: orbColor(e.type),
        // 1 fresh → 0.15 a day old
        fresh: Math.max(0.15, 1 - Math.log10(1 + ageMin) / Math.log10(1 + 24 * 60)),
        live: ageMin < 15 ? 1 : 0,
        type: e.type,
      },
    }
  })
}

function ensure(map: maplibregl.Map) {
  if (!map.style) return
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  if (!map.getLayer(L_HALO)) {
    map.addLayer({
      id: L_HALO, type: 'circle', source: SRC,
      paint: {
        'circle-radius': ['*', ['interpolate', ['linear'], ['zoom'], 3, 10, 9, 18, 14, 28], ['+', 0.6, ['*', 0.6, ['get', 'fresh']]]] as never,
        'circle-color': ['get', 'color'] as never,
        'circle-blur': 1,
        'circle-opacity': ['*', 0.55, ['get', 'fresh']] as never,
        'circle-pitch-alignment': 'map',
      },
    })
  }
  if (!map.getLayer(L_CORE)) {
    map.addLayer({
      id: L_CORE, type: 'circle', source: SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 9, 4, 14, 6] as never,
        'circle-color': '#ffffff',
        'circle-opacity': ['+', 0.35, ['*', 0.65, ['get', 'fresh']]] as never,
        'circle-stroke-color': ['get', 'color'] as never,
        'circle-stroke-width': 2,
        'circle-stroke-opacity': ['get', 'fresh'] as never,
      },
    })
  }
}

export function useLiveOrbs(map: maplibregl.Map | null, epoch: number, events: LiveActivityEvent[], on: boolean, reducedMotion: boolean) {
  const eventsRef = useRef(events)
  eventsRef.current = events

  // Orbs: rebuilt on new events and every 30s as they age.
  useEffect(() => {
    if (!map) return
    const draw = () => {
      try {
        ensure(map)
        const vis = on ? 'visible' : 'none'
        for (const id of [L_HALO, L_CORE]) map.setLayoutProperty(id, 'visibility', vis)
        ;(map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: on ? orbFeatures(eventsRef.current, Date.now()) : [] })
      } catch { /* style mid-swap */ }
    }
    draw()
    map.on('styledata', draw)
    const t = window.setInterval(draw, 30_000)
    return () => { map.off('styledata', draw); window.clearInterval(t) }
  }, [map, epoch, on, events])

  // Breathing: the freshest orbs swell and settle (~2.6s), 20 fps.
  useEffect(() => {
    if (!map || !on || reducedMotion) return
    let raf = 0
    let last = 0
    const start = window.performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 50) return
      last = now
      const k = 0.5 + 0.5 * Math.sin(((now - start) / 2600) * Math.PI * 2)
      try {
        if (map.getLayer(L_HALO)) {
          map.setPaintProperty(L_HALO, 'circle-opacity', ['*', ['case', ['==', ['get', 'live'], 1], 0.4 + 0.45 * k, 0.55], ['get', 'fresh']] as never)
        }
      } catch { /* style mid-swap */ }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [map, epoch, on, reducedMotion])
}

/** A new event lands: shockwave rings and a label that rises off the property. */
export function landEvent(map: maplibregl.Map, e: LiveActivityEvent) {
  if (typeof e.lng !== 'number' || typeof e.lat !== 'number') return
  const el = document.createElement('div')
  el.className = 'mx-land'
  el.style.setProperty('--land', orbColor(e.type))
  el.innerHTML = '<i></i><i></i><i></i><span></span>'
  const label = el.querySelector('span')
  if (label) label.textContent = ORB_LABEL[e.type] ?? 'Activity'
  const marker = new maplibregl.Marker({ element: el }).setLngLat([e.lng, e.lat]).addTo(map)
  window.setTimeout(() => marker.remove(), 2600)
}
