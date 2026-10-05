/**
 * KEYED camera platforms — built, configured OFF until the owner registers.
 *
 * Neither adapter runs without its key: the registry marks the provider
 * requires_api_key, effectiveProvider() disables it while the named env var
 * is empty, and the Map says "<provider> needs an API key" instead of
 * drawing nothing silently. Keys live only in server env vars; image URLs
 * from these platforms carry no key, but stills are proxied regardless.
 *
 *   ibi_511  The Iteris/IBI "511" platform shared by FL511, 511GA, DriveNC,
 *            AZ511, UDOT Traffic, NVRoads, 511LA (and ID, AK, New England):
 *            GET https://<site>/api/v2/get/cameras?key=KEY&format=json
 *            → [{ Id, Name, Roadway, Direction, Latitude, Longitude,
 *                 Views: [{ Id, Url, Status, Description }] }]
 *            Platform limit: ten calls per 60 s per key — one inventory pull
 *            per refresh_interval_sec is far below it. Field names are from
 *            the published 511GA endpoint docs; the first keyed pull must be
 *            checked against a live response before the provider is trusted.
 *   ohgo     ODOT OHGO public API: GET https://publicapi.ohgo.com/api/v1/cameras
 *            (key in the Authorization header: "APIKEY <key>")
 *            → { results: [{ id, latitude, longitude, location, description,
 *                 cameraViews: [{ direction, smallUrl, largeUrl, mainRoute }] }] }
 */

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())
const num = (v) => { const n = typeof v === 'number' ? v : Number(clean(v)); return clean(v) !== '' && Number.isFinite(n) ? n : null }
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null && o?.[k] !== '') return o[k]; return null }

export const ibi511Adapter = {
  async listRaw({ fetch, provider, apiKey }) {
    if (!apiKey) throw new Error('api_key_not_configured')
    const site = provider?.adapter_config?.site
    if (!site) throw new Error('ibi_site_missing')
    const body = await fetch.json(`https://${site}/api/v2/get/cameras?key=${encodeURIComponent(apiKey)}&format=json`)
    if (!Array.isArray(body)) throw new Error('ibi_cameras_not_an_array')
    // One record per camera VIEW: a pole with two views is two cameras (their own stills).
    const out = []
    for (const cam of body) {
      const views = Array.isArray(cam?.Views) ? cam.Views : []
      if (!views.length) out.push({ cam, view: null, n: 0 })
      views.forEach((view, n) => out.push({ cam, view, n }))
    }
    return out
  },
  normalize({ cam, view, n } = {}, { provider } = {}) {
    const id = clean(pick(cam, 'Id', 'ID', 'id'))
    const lat = num(pick(cam, 'Latitude', 'latitude'))
    const lng = num(pick(cam, 'Longitude', 'longitude'))
    if (!id || lat === null || lng === null) return null
    const site = provider?.adapter_config?.site || ''
    const url = clean(pick(view, 'Url', 'url'))
    const still = site && url.startsWith(`https://${site}/`) ? url : null
    const viewDown = /disabled|off|down/i.test(clean(pick(view, 'Status', 'status')))
    return {
      external_camera_id: view ? `${id}-${clean(pick(view, 'Id', 'id')) || n}` : id,
      name: clean(pick(cam, 'Name', 'Location')) || clean(pick(view, 'Description')) || `Camera ${id}`,
      road: clean(pick(cam, 'Roadway')) || null,
      route: clean(pick(cam, 'Roadway')) || null,
      direction: clean(pick(cam, 'Direction')) || null,
      latitude: lat,
      longitude: lng,
      status: viewDown ? 'OFFLINE' : 'UNKNOWN',
      feed_type: still ? 'REFRESHING_STILL' : 'PROVIDER_PAGE_ONLY',
      still_url: still,
      provider_page_url: site ? `https://${site}/map` : null,
    }
  },
}

export const ohgoAdapter = {
  async listRaw({ fetch, apiKey }) {
    if (!apiKey) throw new Error('api_key_not_configured')
    const body = await fetch.json('https://publicapi.ohgo.com/api/v1/cameras?page-all=true', { headers: { Authorization: `APIKEY ${apiKey}` } })
    const rows = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : []
    const out = []
    for (const cam of rows) {
      const views = Array.isArray(cam?.cameraViews) ? cam.cameraViews : []
      views.forEach((view, n) => out.push({ cam, view, n }))
    }
    if (!out.length) throw new Error('ohgo_no_cameras')
    return out
  },
  normalize({ cam, view, n } = {}) {
    const id = clean(cam?.id)
    const lat = num(cam?.latitude)
    const lng = num(cam?.longitude)
    if (!id || lat === null || lng === null) return null
    const large = clean(view?.largeUrl)
    const still = /^https:\/\/itscameras\.dot\.state\.oh\.us\//.test(large) ? large : null
    return {
      external_camera_id: `${id}-${n}`,
      name: clean(cam.location) || clean(cam.description) || `OHGO camera ${id}`,
      road: clean(view?.mainRoute) || null,
      route: clean(view?.mainRoute) || null,
      direction: clean(view?.direction) || null,
      latitude: lat,
      longitude: lng,
      status: 'UNKNOWN',
      feed_type: still ? 'REFRESHING_STILL' : 'PROVIDER_PAGE_ONLY',
      still_url: still,
      provider_page_url: 'https://ohgo.com/',
      snapshot_cadence_sec: 60,
    }
  },
}
