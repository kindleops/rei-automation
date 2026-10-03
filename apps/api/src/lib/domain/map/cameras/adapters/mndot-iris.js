/**
 * MnDOT IRIS — Minnesota's public camera inventory.
 *
 * Source: https://data.dot.state.mn.us/iris/camera_pub — the public resource
 * served by MnDOT's open-source ATMS (IRIS "honeybee"; documented in the IRIS
 * REST API docs as an unauthenticated public resource). One JSON array, one
 * object per camera. `publish:false` cameras are MnDOT's decision not to show
 * a camera, so they are dropped here — never drawn, never proxied.
 *
 * Stills: https://video.dot.state.mn.us/video/image/metro/{name} — a live grab
 * per request (the `metro` segment serves outstate and D6 cameras too). The
 * MnDOT logo and direction are burned into every frame.
 *
 * Live video (owner-approved 2026-10-03): ONLY for cameras IRIS itself marks
 * `streamable` (the #LiveStream hashtag), at MnDOT's own HLS server
 * https://video.dot.state.mn.us/public/{name}.stream/playlist.m3u8 — the
 * pattern 511MN uses; MnDOT does not document it. CORS is open (ACAO *), so the
 * browser plays it directly on an operator's click; LeadCommand never proxies,
 * prefetches or re-streams video.
 *
 * Terms: no camera-specific licence; Minnesota government data is public by
 * default (Minn. Stat. §13.03); MnDOT's disclaimer forbids framing/misleading
 * presentation. We proxy a still for about one cadence in memory and never
 * persist imagery (camera-media.js).
 */

const STILL_BASE = 'https://video.dot.state.mn.us/video/image/metro/'
export const mndotStreamUrl = (name) => `https://video.dot.state.mn.us/public/${encodeURIComponent(name)}.stream/playlist.m3u8`
export const MNDOT_INVENTORY_URL = 'https://data.dot.state.mn.us/iris/camera_pub'

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())

/** "T.H.52" → "MN-52" (a Minnesota trunk highway); everything else goes to canonicalRoad. */
export function mndotRoad(raw) {
  const s = clean(raw)
  if (!s) return null
  const th = /^T\.?\s*H\.?\s*(\d{1,3})([A-Z])?\b/i.exec(s)
  if (th) return `MN-${th[1]}${th[2] ? th[2].toUpperCase() : ''}`
  return s
}

/** "(MP 61.7)" inside the location text is the only mile marker MnDOT publishes. */
export function mndotMilePost(location) {
  const m = /\(\s*MP\s*(\d+(?:\.\d+)?)\s*\)/i.exec(clean(location))
  return m ? Number(m[1]) : null
}

/** MnDOT road_dir: NB/SB/EB/WB, '' or "N-S"/"E-W" (a camera that watches both ways). */
export function mndotDirection(roadDir) {
  const s = clean(roadDir).toUpperCase()
  if (!s) return null
  if (s === 'N-S' || s === 'E-W') return 'BOTH'
  return { NB: 'N', SB: 'S', EB: 'E', WB: 'W' }[s] || null
}

export const mndotIrisAdapter = {
  async listRaw({ fetch, provider }) {
    const url = provider?.adapter_config?.inventory_url || MNDOT_INVENTORY_URL
    const body = await fetch.json(url)
    if (!Array.isArray(body)) throw new Error('mndot_inventory_not_an_array')
    return body
  },
  normalize(raw) {
    if (!raw || typeof raw !== 'object') return null
    if (raw.publish !== true) return null // MnDOT's call: not public
    const name = clean(raw.name)
    if (!name || !/^[A-Za-z0-9._-]{1,40}$/.test(name)) return null
    const location = clean(raw.location)
    return {
      external_camera_id: name,
      name: location || name,
      road: mndotRoad(raw.roadway),
      route: clean(raw.roadway) || null,
      direction: mndotDirection(raw.road_dir),
      mile_marker: mndotMilePost(location),
      latitude: raw.lat,
      longitude: raw.lon,
      // No public online/offline flag exists for MnDOT cameras; the still's
      // own fetch is the health check. UNKNOWN, never assumed LIVE.
      status: 'UNKNOWN',
      feed_type: raw.streamable === true ? 'HLS' : 'REFRESHING_STILL',
      still_url: `${STILL_BASE}${encodeURIComponent(name)}`,
      stream_url: raw.streamable === true ? mndotStreamUrl(name) : null,
      provider_page_url: 'https://511mn.org/',
      metadata: {
        cross_street: clean(raw.cross_street) || null,
        multi_view: Array.isArray(raw.views) && raw.views.length > 0,
      },
    }
  },
}
