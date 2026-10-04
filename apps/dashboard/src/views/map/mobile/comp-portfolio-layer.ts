/**
 * A portfolio sale's parcels as gold dots on the Map (null clears them).
 * Shared by the phone comp sheet and the desktop comp card.
 */
import type maplibregl from 'maplibre-gl'

const PORTFOLIO_SRC = 'nx-comps-portfolio'

/** The portfolio's parcels as gold dots (null clears them). Shared with the desktop comp card. */
export function showPortfolio(map: maplibregl.Map, comp: { portfolio?: Array<{ lng: number; lat: number }> | null } | null) {
  try {
    if (!map.getSource(PORTFOLIO_SRC)) {
      map.addSource(PORTFOLIO_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: `${PORTFOLIO_SRC}-glow`, type: 'circle', source: PORTFOLIO_SRC, paint: { 'circle-radius': 16, 'circle-color': '#f5c542', 'circle-blur': 1, 'circle-opacity': 0.4 } })
      map.addLayer({ id: `${PORTFOLIO_SRC}-dot`, type: 'circle', source: PORTFOLIO_SRC, paint: { 'circle-radius': 5.5, 'circle-color': '#f5c542', 'circle-stroke-color': '#2a1400', 'circle-stroke-width': 1.5 } })
    }
    const src = map.getSource(PORTFOLIO_SRC) as maplibregl.GeoJSONSource
    const pts = comp?.portfolio ?? []
    src.setData({
      type: 'FeatureCollection',
      features: pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} })),
    })
  } catch { /* style mid-swap */ }
}
