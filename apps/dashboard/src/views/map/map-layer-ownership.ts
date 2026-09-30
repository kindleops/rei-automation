/**
 * Which style layers LeadCommand draws itself, as opposed to the basemap's own.
 *
 * The basemap painter recolours — and the roads / buildings / labels overlay
 * toggles show or hide — ONLY basemap layers. Anything owned here keeps its
 * own paint and visibility: when the nx- family was missing from this list,
 * the painter flattened a translucent band of real daylight into an opaque
 * land-colour sheet over the whole map, and the roads toggle hid lens lines.
 *
 * The Esri reference tiles and the terrain relief (nx-hybrid-*, nx-relief-*)
 * are basemap add-ons, so they keep the basemap treatment.
 */
export const isOwnedMapLayer = (id?: string): boolean => !id ? false : (
  id.startsWith('command-') ||
  id.startsWith('census-') ||
  id.startsWith('buyer-demand-') ||
  id.startsWith('sold-comps-') ||
  id.startsWith('prop-univ-') ||
  id.startsWith('prop-tiles-') ||
  id.startsWith('map-agg-') ||
  id.startsWith('seller-pins-') ||
  id.startsWith('nx-icm-hybrid-') ||
  (id.startsWith('nx-') && !id.startsWith('nx-hybrid-') && !id.startsWith('nx-relief-'))
)
