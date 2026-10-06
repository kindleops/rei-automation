/**
 * Command Wall map model — pure helpers for framing and GeoJSON (§11, §13, §41).
 */
import type { WallCampaign, WallEvent, WallMarket, WallMiMarket, WallThemeId } from '../wall-types'
import type { MarketActivity } from '../wall-feed-model'
import { CONUS_BOUNDS } from '../wall-presets'

/** Display theme → the Map engine's own theme id. Dark Satellite stays out (§33). */
export function mapThemeFor(theme: WallThemeId): string {
  if (theme === 'light') return 'light_street'
  if (theme === 'red_ops') return 'red_ops'
  return 'dark_ops'
}

export type Bounds = [[number, number], [number, number]]

/** Bounds around a set of points with a minimum span, or CONUS when there are none. */
export function boundsFor(points: { lng: number | null; lat: number | null }[], { minSpanDeg = 6, pad = 0.18 } = {}): Bounds {
  const pts = points.filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)) as { lng: number; lat: number }[]
  if (!pts.length) return CONUS_BOUNDS
  let w = Math.min(...pts.map((p) => p.lng)); let e = Math.max(...pts.map((p) => p.lng))
  let s = Math.min(...pts.map((p) => p.lat)); let n = Math.max(...pts.map((p) => p.lat))
  const cx = (w + e) / 2; const cy = (s + n) / 2
  const spanX = Math.max(minSpanDeg * 1.6, (e - w) * (1 + pad * 2))
  const spanY = Math.max(minSpanDeg, (n - s) * (1 + pad * 2))
  w = cx - spanX / 2; e = cx + spanX / 2; s = cy - spanY / 2; n = cy + spanY / 2
  return [[Math.max(-170, w), Math.max(15, s)], [Math.min(-50, e), Math.min(72, n)]]
}

/** Markets that are operating right now, from REAL market-level events (send aggregates carry market centroids). */
export function activityMarkets(events: Iterable<WallEvent>): WallMarket[] {
  const out = new Map<string, WallMarket>()
  for (const ev of events) {
    const g = ev.geo
    if (!g?.market_id || g.precision !== 'market' || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) continue
    if (!out.has(g.market_id)) out.set(g.market_id, { id: g.market_id, name: g.market_name || g.market_id, state: null, lat: g.lat, lng: g.lng })
  }
  return [...out.values()]
}

/** The operating footprint: live campaign markets + watched markets + markets with live activity. */
export function footprintMarkets(markets: WallMarket[], campaigns: WallCampaign[], watched: string[], active: WallMarket[] = []): WallMarket[] {
  const ids = new Set<string>([...campaigns.map((c) => c.market_id).filter(Boolean) as string[], ...watched])
  const out = new Map<string, WallMarket>()
  for (const m of markets) if (ids.has(m.id) && Number.isFinite(m.lat) && Number.isFinite(m.lng)) out.set(m.id, m)
  for (const m of active) if (!out.has(m.id)) out.set(m.id, m)
  return [...out.values()]
}

/** Market glow (§13 "campaign → aggregate market glow"): intensity from REAL recent activity. */
export function marketGlowFeatures(markets: WallMarket[], campaigns: WallCampaign[], activity: Map<string, MarketActivity>): GeoJSON.FeatureCollection {
  const live = new Map<string, number>()
  for (const c of campaigns) if (c.market_id && c.status === 'active') live.set(c.market_id, (live.get(c.market_id) || 0) + 1)
  return {
    type: 'FeatureCollection',
    features: markets.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng)).map((m) => {
      const a = activity.get(m.id)
      const sends = a?.sends || 0
      const replies = a?.replies || 0
      // 0 = present but quiet, 1 = busy. Quiet markets are a dim ring, never a fake glow.
      const energy = Math.min(1, Math.log10(1 + sends) / 2.2 + replies * 0.08)
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [m.lng as number, m.lat as number] },
        properties: { id: m.id, name: m.name, campaigns: live.get(m.id) || 0, energy: Math.round(energy * 100) / 100, active: (live.get(m.id) || 0) > 0 || sends > 0 ? 1 : 0, sends, replies },
      }
    }),
  }
}

/** MI ZIPs (§20): single-hue size-by-sales, opacity by RECORDED investor share; no rainbow ramp. */
export function miZipFeatures(markets: WallMiMarket[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const m of markets) {
    for (const z of m.top_zips || []) {
      if (!Number.isFinite(z.lat) || !Number.isFinite(z.lng)) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [z.lng as number, z.lat as number] },
        properties: { zip: z.zip, sales: z.sales ?? 0, inv: z.investor_recorded_share ?? -1, market: m.id },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Recent high-value events as quiet resident dots (they pulse once on arrival, then rest). */
export function activityFeatures(events: Iterable<WallEvent>, now: number, windowMs = 6 * 3600_000): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const ev of events) {
    if (ev.priority > 1 || !ev.geo || !Number.isFinite(ev.geo.lat) || !Number.isFinite(ev.geo.lng)) continue
    const age = now - Date.parse(ev.occurred_at)
    if (age > windowMs || age < 0) continue
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ev.geo.lng as number, ev.geo.lat as number] }, properties: { kind: ev.kind, fresh: Math.round(Math.max(0, 1 - age / windowMs) * 100) / 100 } })
  }
  return { type: 'FeatureCollection', features }
}

/** CSS color (rgb triple var) per event tone — semantic, never the accent. */
export function toneVar(tone: WallEvent['tone']): string {
  switch (tone) {
    case 'green': return 'var(--lc-ok-rgb)'
    case 'gold': return 'var(--lc-attn-rgb)'
    case 'violet': return 'var(--lc-flow-rgb)'
    case 'red': return 'var(--lc-crit-rgb)'
    case 'neutral': return 'var(--lc-neutral-rgb)'
    default: return 'var(--lc-exec-rgb)'
  }
}
