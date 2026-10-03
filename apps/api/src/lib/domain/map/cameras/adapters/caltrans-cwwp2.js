/**
 * Caltrans CWWP2 — California's official CCTV status feeds, Districts 1–12.
 *
 * Source: https://cwwp2.dot.ca.gov/data/d{N}/cctv/cctvStatusD{NN}.json — static
 * JSON published by Caltrans "for integration into your application"; data
 * is public domain. Fair use: "Usage that risks degrading the availability of
 * the CCTV streaming service is prohibited." So:
 *   · stills are proxied with a short in-memory TTL (one upstream fetch per
 *     image per cadence, however many operators look)
 *   · live video is referenced at Caltrans's own official HLS URL
 *     (streamingVideoURL, Wowza) and only ever started by an operator's click
 *     — never prefetched, never pre-opened, never re-streamed by LeadCommand.
 * Caltrans: "traffic camera video footage and still images are neither
 * retained nor archived" — and neither are they here.
 *
 * Feed quirks handled (2026-09-30 discovery): every value is a string;
 * `county` is wrong on some rows (lat/lon is trusted instead); `direction` can
 * be "" or "Median"; `currentImageUpdateFrequency` is minutes or
 * "Not Reported"; a few stream URLs carry an explicit `:443`.
 */

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())
const num = (v) => { const n = Number(clean(v)); return clean(v) !== '' && Number.isFinite(n) ? n : null }

export const CALTRANS_DISTRICTS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
export const caltransFeedUrl = (n) => `https://cwwp2.dot.ca.gov/data/d${n}/cctv/cctvStatusD${String(n).padStart(2, '0')}.json`

/** "true"/"false"/"Not Reported" → canonical. inService is Caltrans's own word. */
export function caltransStatus(v) {
  const s = clean(v).toLowerCase()
  if (s === 'true') return 'LIVE'
  if (s === 'false') return 'OFFLINE'
  return 'UNKNOWN'
}

/** The official per-camera player page, from the still's own folder name. */
export function caltransPageUrl(district, imageUrl) {
  const m = /\/data\/d(\d{1,2})\/cctv\/image\/([a-z0-9-]+)\//i.exec(clean(imageUrl))
  return m ? `https://cwwp2.dot.ca.gov/vm/loc/d${m[1]}/${m[2]}.htm` : district ? 'https://cwwp2.dot.ca.gov/vm/streamlist.htm' : null
}

/** An official HLS URL, normalised (":443" dropped), or null. */
export function caltransStream(url) {
  const s = clean(url)
  if (!/^https:\/\/wzmedia\.dot\.ca\.gov(:443)?\/[^\s]+\.m3u8$/i.test(s)) return null
  return s.replace('wzmedia.dot.ca.gov:443/', 'wzmedia.dot.ca.gov/')
}

export const caltransCwwp2Adapter = {
  async listRaw({ fetch, provider }) {
    const districts = provider?.adapter_config?.districts || CALTRANS_DISTRICTS
    const out = []
    let ok = 0
    for (const n of districts) {
      try {
        const body = await fetch.json(caltransFeedUrl(n))
        const rows = Array.isArray(body?.data) ? body.data : []
        for (const r of rows) if (r?.cctv) out.push({ ...r.cctv, __district: n })
        ok += 1
      } catch { /* one district down never empties the others */ }
    }
    if (!ok) throw new Error('caltrans_all_districts_failed')
    return out
  },
  normalize(raw) {
    if (!raw || typeof raw !== 'object') return null
    const district = Number(raw.__district || raw.location?.district)
    const index = clean(raw.index)
    const loc = raw.location || {}
    if (!district || !index) return null
    const still = clean(raw.imageData?.static?.currentImageURL)
    const stream = caltransStream(raw.imageData?.streamingVideoURL)
    const freqMin = num(raw.imageData?.static?.currentImageUpdateFrequency)
    const route = clean(loc.route) ? `${clean(loc.route)}${clean(loc.routeSuffix)}` : null
    return {
      external_camera_id: `D${district}-${index}`,
      name: clean(loc.locationName) || `Caltrans D${district} camera ${index}`,
      road: route,
      route,
      direction: clean(loc.direction) || null, // "Median" / "" → no direction (normalizeDirection)
      mile_marker: num(loc.milepost),
      latitude: loc.latitude,
      longitude: loc.longitude,
      city: clean(loc.nearbyPlace) || null,
      status: caltransStatus(raw.inService),
      feed_type: stream ? 'HLS' : 'REFRESHING_STILL',
      still_url: /^https:\/\/cwwp2\.dot\.ca\.gov\//.test(still) ? still : null,
      stream_url: stream,
      provider_page_url: caltransPageUrl(district, still),
      snapshot_cadence_sec: freqMin ? freqMin * 60 : null,
      metadata: { district },
    }
  },
}
