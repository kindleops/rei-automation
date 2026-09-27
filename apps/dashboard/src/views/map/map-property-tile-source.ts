import type maplibregl from 'maplibre-gl'
import type { CommandMapThemeId } from './commandMapThemes'
import { buildMarkerKeyIconColorExpr, buildMarkerKeyIconImageExpr } from './canonical-map-asset-marker'
import { getMapPinThemeTokens } from './map-pin-theme-tokens'
import { PIN_HIT_RADIUS_EXPR, PIN_ICON_SCALE_EXPR, PIN_RING_STROKE_EXPR, PIN_RING_WIDTH_EXPR } from './acquisition-radar-pin-renderer'
import { getBackendBaseUrl, getBackendSecret, getLiveSessionToken, primeLiveSessionToken } from '../../lib/api/backendClient'

const PROPERTY_TILE_URL_FRAGMENT = '/api/internal/dashboard/ops/map/tiles/'

/**
 * Inject the operator's SESSION for MapLibre MVT fetches (no custom headers by
 * default). In production the Worker gates /api/internal/dashboard/* on
 * `Authorization: Bearer <session>` and strips the legacy secret header, so a
 * tile without the bearer is a 401 — the map drew no property pins. The legacy
 * secret is still sent for local dev servers that read it.
 */
export const buildPropertyTileTransformRequest = (): maplibregl.RequestTransformFunction => {
  const secret = getBackendSecret()
  void primeLiveSessionToken()
  return (url, resourceType) => {
    if (resourceType === 'Tile' && url.includes(PROPERTY_TILE_URL_FRAGMENT)) {
      const token = getLiveSessionToken()
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      if (secret) headers['x-ops-dashboard-secret'] = secret
      return { url, credentials: 'include', headers }
    }
    return { url }
  }
}

export const PROPERTY_TILES_SOURCE_ID = 'property-map-tiles'
export const PROPERTY_TILES_LAYER_IDS = {
  hit: 'prop-tiles-hit',
  halo: 'prop-tiles-halo',
  glass: 'prop-tiles-glass',
  ring: 'prop-tiles-ring',
  pulse: 'prop-tiles-pulse',
  icon: 'prop-tiles-icon',
} as const

export const PROPERTY_TILES_SOURCE_LAYER = 'properties'

export const buildPropertyTilesUrlTemplate = (filterToken?: string | null): string => {
  const base = getBackendBaseUrl()
  let prefix = base ? `${base}/api/internal/dashboard/ops/map/tiles` : '/api/internal/dashboard/ops/map/tiles'
  // MapLibre resolves relative tile URLs against the style spec origin (Carto CDN),
  // not the dashboard origin — always absolutize for same-origin API tiles in browser.
  if (typeof window !== 'undefined' && prefix.startsWith('/')) {
    prefix = `${window.location.origin}${prefix}`
  }
  const tilePath = `${prefix}/{z}/{x}/{y}`
  if (!filterToken) return tilePath
  return `${tilePath}?filter=${encodeURIComponent(filterToken)}`
}

export const buildPropertyTileLayerPaint = (themeId: CommandMapThemeId) => {
  const tokens = getMapPinThemeTokens(themeId)
  return {
    glassColor: ['coalesce', ['feature-state', 'glass_color'], tokens.glassFill],
    ringColor: ['coalesce', ['feature-state', 'ring_color'], '#7A8FA8'],
    iconColor: buildMarkerKeyIconColorExpr(),
    iconImage: buildMarkerKeyIconImageExpr(),
  }
}

export const PROPERTY_TILE_ICON_LAYOUT = {
  'icon-image': buildMarkerKeyIconImageExpr(),
  'icon-size': PIN_ICON_SCALE_EXPR,
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
} as const

export const PROPERTY_TILE_HIT_RADIUS = PIN_HIT_RADIUS_EXPR
export const PROPERTY_TILE_RING_WIDTH = PIN_RING_WIDTH_EXPR
export const PROPERTY_TILE_RING_STROKE = PIN_RING_STROKE_EXPR