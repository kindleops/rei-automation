import type { FeatureCollection, Point } from 'geojson'
import type { ActiveMarketConfig } from './types'

interface HeatFieldProps {
  marketId: string
  weight: number
}

const RADIAL_OFFSETS = [
  { lng: 0, lat: 0, decay: 1.0 },
  { lng: 0.35, lat: 0.12, decay: 0.82 },
  { lng: -0.35, lat: -0.12, decay: 0.82 },
  { lng: 0.26, lat: 0.28, decay: 0.74 },
  { lng: -0.26, lat: -0.28, decay: 0.74 },
  { lng: 0.54, lat: 0.02, decay: 0.64 },
  { lng: -0.54, lat: -0.02, decay: 0.64 },
  { lng: 0.16, lat: 0.45, decay: 0.60 },
  { lng: -0.16, lat: -0.45, decay: 0.60 },
  { lng: 0.74, lat: 0.24, decay: 0.48 },
  { lng: -0.74, lat: -0.24, decay: 0.48 },
  { lng: 0.58, lat: 0.58, decay: 0.42 },
  { lng: -0.58, lat: -0.58, decay: 0.42 },
]

const phaseNudge = (phase: number, scale: number) => {
  const x = Math.sin(phase) * scale
  const y = Math.cos(phase * 1.12) * scale
  return { x, y }
}

export const buildMarketHeatFieldGeoJSON = (
  markets: ActiveMarketConfig[],
  pulsePhase: number,
): FeatureCollection<Point, HeatFieldProps> => {
  const features: Array<GeoJSON.Feature<Point, HeatFieldProps>> = []

  for (const market of markets) {
    if (!Number.isFinite(market.lat) || !Number.isFinite(market.lng)) continue
    const core = Math.max(6, market.activityIntensity)
    const spread = 0.06 + (market.activityIntensity / 100) * 0.1
    const nudge = phaseNudge(pulsePhase + market.activityIntensity * 0.018, spread)

    for (const offset of RADIAL_OFFSETS) {
      const weight = Math.max(1, Math.round(core * offset.decay))
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [
            market.lng + offset.lng + nudge.x,
            market.lat + offset.lat + nudge.y,
          ],
        },
        properties: {
          marketId: market.id,
          weight,
        },
      })
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}
