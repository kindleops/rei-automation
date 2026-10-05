/**
 * Public, keyless state DOT camera feeds (researched + probed 2026-10-05; see
 * the job's map-overlays/SOURCES.txt). Each adapter reads the agency's own
 * published inventory; stills are proxied per open with the service's short
 * TTL (or passed through), never persisted. Live video stays MnDOT + Caltrans
 * only (owner decision): these adapters never emit a stream_url.
 *
 *   IL  IDOT Gateway (ArcGIS, CC BY-SA 2.0)   stills
 *   WA  WSDOT HighwayCameras KML (disclaimer only, no use restriction)  stills
 *   MD  MDOT SHA CHART JSON ("can be freely distributed")  positions + link
 *       (CHART publishes video only; video is MN + CA only)
 *   MO  MoDOT traveler JSON (State of MO data terms; provisional)  positions
 *       + link (MoDOT publishes video only)
 *   IA  Iowa DOT (ArcGIS, CC BY 4.0) — built, OFF by default: Iowa's site
 *       terms limit site "Content" to noncommercial use; confirm first.
 */

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())
const num = (v) => { const n = typeof v === 'number' ? v : Number(clean(v)); return clean(v) !== '' && Number.isFinite(n) ? n : null }
const https = (u, host) => { const s = clean(u); return s.startsWith(`https://${host}/`) ? s : null }

/** Page an ArcGIS layer (maxRecordCount-sized pages, hard-capped). */
async function arcgisAll(fetch, layerUrl, outFields, { page = 1000, maxPages = 8, where = '1=1' } = {}) {
  const out = []
  for (let i = 0; i < maxPages; i += 1) {
    const q = new URLSearchParams({ where, outFields, returnGeometry: 'true', outSR: '4326', f: 'json', resultOffset: String(i * page), resultRecordCount: String(page), orderByFields: 'OBJECTID ASC' })
    const body = await fetch.json(`${layerUrl}/query?${q}`)
    if (body?.error) throw new Error('arcgis_query_error')
    const feats = Array.isArray(body?.features) ? body.features : []
    out.push(...feats)
    if (feats.length < page && !body?.exceededTransferLimit) break
  }
  return out
}

/* ── Illinois: IDOT Gateway Traveler Information ─────────────────────────── */

export const IL_LAYER = 'https://services2.arcgis.com/aIrBD8yn1TDTEXoz/arcgis/rest/services/TrafficCamerasTM_Public/FeatureServer/0'

export const idotGatewayAdapter = {
  async listRaw({ fetch }) {
    const rows = await arcgisAll(fetch, IL_LAYER, 'OBJECTID,CameraLocation,CameraDirection,SnapShot,ImgPath,TooOld', { page: 1000, maxPages: 6 })
    if (!rows.length) throw new Error('idot_no_cameras')
    return rows
  },
  normalize(raw) {
    const a = raw?.attributes || {}
    const lat = num(raw?.geometry?.y)
    const lng = num(raw?.geometry?.x)
    const still = https(a.SnapShot, 'cctv.travelmidwest.com')
    // The snapshot file name is the stable camera key (OBJECTID is renumbered on republish).
    const key = clean(still).split('/').pop()?.replace(/\.jpg$/i, '') || ''
    if (lat === null || lng === null || !key) return null
    const dir = clean(a.CameraDirection).toUpperCase()
    return {
      external_camera_id: key.slice(0, 120),
      name: clean(a.CameraLocation) || 'IDOT camera',
      road: null,
      route: null,
      direction: dir && dir !== 'NONE' ? dir : null,
      latitude: lat,
      longitude: lng,
      status: clean(a.TooOld).toLowerCase() === 'true' ? 'STALE' : 'UNKNOWN',
      feed_type: still ? 'REFRESHING_STILL' : 'PROVIDER_PAGE_ONLY',
      still_url: still,
      provider_page_url: https(a.ImgPath, 'travelmidwest.com'),
      snapshot_cadence_sec: 300,
    }
  },
}

/* ── Washington: WSDOT HighwayCameras KML ────────────────────────────────── */

export const WSDOT_KML = 'https://wsdot.wa.gov/traffic/api/HighwayCameras/kml.aspx'
const cdata = (s) => clean(s).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()

/** Placemarks out of the KML text — a narrow, bounded parse of WSDOT's own shape. */
export function parseWsdotKml(text) {
  const out = []
  const re = /<Placemark id="ID (\d+)">([\s\S]*?)<\/Placemark>/g
  let m
  while ((m = re.exec(String(text))) && out.length < 5000) {
    const body = m[2]
    const name = cdata((/<name>([\s\S]*?)<\/name>/.exec(body) || [])[1])
    const img = (/src="(https:\/\/images\.wsdot\.wa\.gov\/[^"]+)"/.exec(body) || [])[1] || null
    const coords = (/<coordinates>\s*([-\d.]+),([-\d.]+)/.exec(body) || [])
    out.push({ id: m[1], name, img, lng: num(coords[1]), lat: num(coords[2]) })
  }
  return out
}

export const wsdotKmlAdapter = {
  async listRaw({ fetch }) {
    const rows = parseWsdotKml(await fetch.text(WSDOT_KML))
    if (!rows.length) throw new Error('wsdot_no_placemarks')
    return rows
  },
  normalize(r) {
    if (!r?.id || r.lat === null || r.lng === null) return null
    // Airport and mountain-pass images ride in the same KML; they are still WSDOT cameras.
    return {
      external_camera_id: r.id,
      name: r.name || `WSDOT camera ${r.id}`,
      road: null, route: null, direction: null,
      latitude: r.lat, longitude: r.lng,
      status: 'UNKNOWN',
      feed_type: r.img ? 'REFRESHING_STILL' : 'PROVIDER_PAGE_ONLY',
      still_url: r.img,
      provider_page_url: 'https://wsdot.com/travel/real-time/map/',
      snapshot_cadence_sec: 120,
    }
  },
}

/* ── Maryland: MDOT SHA CHART (positions; video is published, not used) ──── */

export const CHART_JSON = 'https://chart.maryland.gov/DataFeeds/GetCamerasJson'

export const mdotChartAdapter = {
  async listRaw({ fetch }) {
    const body = await fetch.json(CHART_JSON)
    if (!Array.isArray(body) || !body.length) throw new Error('chart_no_cameras')
    return body
  },
  normalize(r) {
    const id = clean(r?.id)
    const lat = num(r?.lat)
    const lng = num(r?.lon)
    if (!id || lat === null || lng === null) return null
    const route = clean(r.routePrefix) && r.routeNumber ? `${clean(r.routePrefix)}-${r.routeNumber}` : null
    return {
      external_camera_id: id,
      name: clean(r.name) && !/^\d+$/.test(clean(r.name)) ? clean(r.name) : clean(r.description) || 'CHART camera',
      road: route, route,
      direction: null,
      mile_marker: num(r.milePost),
      latitude: lat, longitude: lng,
      status: clean(r.opStatus).toUpperCase() === 'OK' && clean(r.commMode).toUpperCase() === 'ONLINE' ? 'LIVE' : clean(r.commMode) ? 'OFFLINE' : 'UNKNOWN',
      feed_type: 'PROVIDER_PAGE_ONLY',
      still_url: null,
      provider_page_url: https(r.publicVideoURL, 'chart.maryland.gov') || 'https://chart.maryland.gov/',
    }
  },
}

/* ── Missouri: MoDOT traveler (positions; video is published, not used) ─── */

export const MODOT_JSON = 'https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json'

export const modotTravelerAdapter = {
  async listRaw({ fetch }) {
    const body = await fetch.json(MODOT_JSON)
    if (!Array.isArray(body) || !body.length) throw new Error('modot_no_cameras')
    return body
  },
  normalize(r) {
    const lat = num(r?.y)
    const lng = num(r?.x)
    // The stream path carries MoDOT's own camera id (MODOT_CAM_209); partner streams use their own.
    const key = (/\/([A-Za-z0-9_-]+)\/playlist\.m3u8/.exec(clean(r?.html)) || [])[1] || ''
    if (lat === null || lng === null || !key) return null
    return {
      external_camera_id: key,
      name: clean(r.location) || key,
      road: null, route: null, direction: null,
      latitude: lat, longitude: lng,
      status: 'UNKNOWN',
      feed_type: 'PROVIDER_PAGE_ONLY',
      still_url: null,
      provider_page_url: 'https://traveler.modot.org/map/',
    }
  },
}

/* ── Iowa: Iowa DOT (built; off by default until Iowa DOT confirms) ──────── */

export const IOWA_LAYER = 'https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0'

export const iowaDotAdapter = {
  async listRaw({ fetch }) {
    const q = new URLSearchParams({ where: '1=1', outFields: 'device_id,COMMON_ID,Desc_,Route,ImageURL,latitude,longitude', returnGeometry: 'false', f: 'json', resultRecordCount: '2000' })
    const body = await fetch.json(`${IOWA_LAYER}/query?${q}`)
    const rows = Array.isArray(body?.features) ? body.features : []
    if (!rows.length) throw new Error('iowa_no_cameras')
    return rows
  },
  normalize(raw) {
    const a = raw?.attributes || {}
    const id = clean(a.COMMON_ID) || clean(a.device_id)
    const lat = num(a.latitude)
    const lng = num(a.longitude)
    if (!id || lat === null || lng === null) return null
    const still = https(a.ImageURL, 'atmsqf.iowadot.gov')
    return {
      external_camera_id: id,
      name: clean(a.Desc_) || id,
      road: clean(a.Route) || null, route: clean(a.Route) || null,
      direction: null,
      latitude: lat, longitude: lng,
      status: 'UNKNOWN',
      feed_type: still ? 'REFRESHING_STILL' : 'PROVIDER_PAGE_ONLY',
      still_url: still,
      provider_page_url: 'https://www.511ia.org/',
    }
  },
}
