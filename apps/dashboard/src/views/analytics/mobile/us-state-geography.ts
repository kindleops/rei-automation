/**
 * REAL-WORLD COORDINATES FOR US STATES.
 *
 * The mobile geographic view used to render `USA_STATE_PATHS` — a hand-simplified
 * SVG outline set — which put the metrics on a drawing of the country rather than
 * on the country. This table is what lets the same numbers sit on an actual
 * MapLibre basemap instead: one geographic centre per state, plus the zoom that
 * frames it.
 *
 * It is REFERENCE GEOGRAPHY, not business data. Nothing here is derived from, or
 * can stand in for, a metric — a state with no measured activity is absent from
 * the map entirely rather than drawn at zero.
 *
 * `USA_STATE_PATHS` is deliberately left alone: three desktop surfaces still
 * render it, and this pass is mobile-only.
 *
 * Centres are the states' geographic centres in [longitude, latitude]. `zoom` is
 * banded by land area rather than computed from a bounding box on purpose — a
 * slightly loose frame is a harmless one, whereas a wrong bbox frames the wrong
 * part of the country with no visible tell.
 */

export interface StateGeography {
  /** [longitude, latitude] */
  center: [number, number]
  /** Map zoom that frames the whole state on a phone. */
  zoom: number
}

export const US_STATE_GEOGRAPHY: Record<string, StateGeography> = {
  AK: { center: [-152.40, 63.59], zoom: 3.3 },
  AL: { center: [-86.79, 32.81], zoom: 5.9 },
  AR: { center: [-92.44, 34.97], zoom: 6.0 },
  AZ: { center: [-111.43, 34.05], zoom: 5.5 },
  CA: { center: [-119.42, 36.78], zoom: 4.8 },
  CO: { center: [-105.78, 39.55], zoom: 5.6 },
  CT: { center: [-72.76, 41.60], zoom: 7.6 },
  DC: { center: [-77.04, 38.91], zoom: 10.0 },
  DE: { center: [-75.53, 38.91], zoom: 7.8 },
  FL: { center: [-81.52, 27.77], zoom: 5.4 },
  GA: { center: [-83.44, 32.16], zoom: 5.8 },
  HI: { center: [-157.50, 20.60], zoom: 5.8 },
  IA: { center: [-93.10, 41.88], zoom: 5.9 },
  ID: { center: [-114.48, 44.07], zoom: 5.2 },
  IL: { center: [-89.40, 40.05], zoom: 5.6 },
  IN: { center: [-86.13, 39.85], zoom: 6.1 },
  KS: { center: [-98.48, 38.50], zoom: 5.7 },
  KY: { center: [-85.30, 37.67], zoom: 5.9 },
  LA: { center: [-91.96, 31.17], zoom: 5.9 },
  MA: { center: [-71.80, 42.31], zoom: 7.2 },
  MD: { center: [-76.80, 39.05], zoom: 6.9 },
  ME: { center: [-69.24, 45.37], zoom: 5.9 },
  MI: { center: [-85.40, 44.31], zoom: 5.4 },
  MN: { center: [-94.30, 46.28], zoom: 5.3 },
  MO: { center: [-92.46, 38.36], zoom: 5.7 },
  MS: { center: [-89.66, 32.74], zoom: 5.9 },
  MT: { center: [-109.63, 47.05], zoom: 5.0 },
  NC: { center: [-79.39, 35.56], zoom: 5.7 },
  ND: { center: [-100.47, 47.45], zoom: 5.6 },
  NE: { center: [-99.80, 41.50], zoom: 5.6 },
  NH: { center: [-71.58, 43.69], zoom: 6.8 },
  NJ: { center: [-74.66, 40.19], zoom: 6.9 },
  NM: { center: [-106.02, 34.42], zoom: 5.4 },
  NV: { center: [-116.63, 39.33], zoom: 5.2 },
  NY: { center: [-75.50, 42.95], zoom: 5.6 },
  OH: { center: [-82.79, 40.29], zoom: 6.0 },
  OK: { center: [-97.51, 35.57], zoom: 5.7 },
  OR: { center: [-120.55, 43.94], zoom: 5.4 },
  PA: { center: [-77.80, 40.99], zoom: 5.9 },
  RI: { center: [-71.51, 41.68], zoom: 8.4 },
  SC: { center: [-80.90, 33.86], zoom: 6.2 },
  SD: { center: [-100.23, 44.30], zoom: 5.6 },
  TN: { center: [-86.34, 35.75], zoom: 5.8 },
  TX: { center: [-99.34, 31.47], zoom: 4.8 },
  UT: { center: [-111.68, 39.32], zoom: 5.5 },
  VA: { center: [-78.45, 37.52], zoom: 5.8 },
  VT: { center: [-72.58, 44.07], zoom: 6.8 },
  WA: { center: [-120.50, 47.38], zoom: 5.6 },
  WI: { center: [-89.62, 44.50], zoom: 5.6 },
  WV: { center: [-80.61, 38.64], zoom: 6.2 },
  WY: { center: [-107.55, 43.08], zoom: 5.5 },
}

/** Frames the lower 48 on a phone-shaped viewport. */
export const NATIONAL_VIEW: StateGeography = { center: [-96.5, 38.6], zoom: 2.6 }

/**
 * The lower 48, as [[west, south], [east, north]].
 *
 * The national view is FITTED to this rather than flown to NATIONAL_VIEW's zoom,
 * because a zoom that frames the country on a 390x844 phone clips the Florida
 * peninsula on a shorter one — and Florida is where the current activity is.
 * NATIONAL_VIEW survives as the initial camera, before the map knows its size.
 */
export const CONUS_BOUNDS: [[number, number], [number, number]] = [[-125.0, 24.4], [-66.9, 49.4]]

export const stateGeography = (abbr: string | null | undefined): StateGeography | null =>
  (abbr && US_STATE_GEOGRAPHY[abbr.toUpperCase()]) || null
