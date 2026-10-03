/**
 * City of Austin — Traffic Cameras (open data, public domain).
 *
 * Source: https://data.austintexas.gov/resource/b4k4-adkb.json (Socrata; the
 * official, documented open-data API). Licence: Public Domain — "offered free
 * and without restriction"; attribution to the City of Austin and the source
 * department (Transportation & Public Works). City arterial cameras, not
 * freeways. Stills: https://cctv.austinmobility.io/image/{camera_id}.jpg,
 * refreshed about every 5 minutes. Only TURNED_ON cameras are drawn (VOID
 * cameras still serve years-old images).
 */

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())

export const AUSTIN_INVENTORY_URL = "https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=5000&$where=camera_status='TURNED_ON'"

export const austinMobilityAdapter = {
  async listRaw({ fetch, provider }) {
    const body = await fetch.json(provider?.adapter_config?.inventory_url || AUSTIN_INVENTORY_URL)
    if (!Array.isArray(body)) throw new Error('austin_inventory_not_an_array')
    return body
  },
  normalize(raw) {
    if (!raw || typeof raw !== 'object') return null
    if (clean(raw.camera_status).toUpperCase() !== 'TURNED_ON') return null
    const id = clean(raw.camera_id)
    const coords = raw.location?.coordinates
    if (!id || !Array.isArray(coords) || coords.length < 2) return null
    const still = clean(raw.screenshot_address)
    return {
      external_camera_id: id,
      name: clean(raw.location_name) || `Camera ${id}`,
      road: clean(raw.primary_st) || null,
      route: clean(raw.primary_st) || null,
      direction: null, // Austin publishes no view direction
      latitude: coords[1],
      longitude: coords[0],
      status: 'UNKNOWN', // "TURNED_ON" is configuration, not health
      feed_type: 'REFRESHING_STILL',
      still_url: /^https:\/\/cctv\.austinmobility\.io\//.test(still) ? still : null,
      provider_page_url: 'https://data.austintexas.gov/Transportation-and-Mobility/Traffic-Cameras/b4k4-adkb',
      city: 'Austin',
      metadata: { cross_street: clean(raw.cross_st) || null },
    }
  },
}
