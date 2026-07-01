import type { MapPropertyFetchMode } from '../map-property-source'

export type MapPropertyDiagnostics = {
  mode: string
  fetchMode?: MapPropertyFetchMode
  zoom: number
  source: string
  sourceMode?: string
  totalCanonical?: number
  totalInBounds?: number
  aggregateTotal?: number
  returnedFeatures: number
  representedFeatures: number
  representedPropertyTotal?: number
  clipped: boolean
  paginationBoundary?: string | null
  tileBacked?: boolean
  coveringTiles?: number
  decodedTileFeatures?: number
  uniqueTilePropertyIds?: number
  duplicateIds?: number
  tileCanonicalDifference?: number
  renderedIndividualIcons?: number
  renderedClusters?: number
  clusteredPropertyTotal?: number
  renderedHalos?: number
  collisionHiddenEstimate?: number
  selectedBreakouts?: number
  liveBreakouts?: number
  invariantViolations?: number
  duplicateRenderedMarkers?: number
}

type Props = {
  diagnostics: MapPropertyDiagnostics | null
  visible?: boolean
}

export function MapPropertyDiagnosticsOverlay({ diagnostics, visible = true }: Props) {
  if (!visible || !diagnostics) return null

  return (
    <div className="nx-icm__map-diagnostics" data-testid="map-property-diagnostics">
      <div className="nx-icm__map-diagnostics-title">Map Source Diagnostics</div>
      <dl>
        <div><dt>zoom</dt><dd>{diagnostics.zoom.toFixed(2)}</dd></div>
        <div><dt>source_mode</dt><dd>{diagnostics.sourceMode ?? diagnostics.fetchMode ?? diagnostics.mode}</dd></div>
        <div><dt>source</dt><dd>{diagnostics.source}</dd></div>
        <div><dt>total_canonical</dt><dd>{diagnostics.totalCanonical ?? '—'}</dd></div>
        <div><dt>total_in_bounds</dt><dd>{diagnostics.totalInBounds ?? '—'}</dd></div>
        {diagnostics.aggregateTotal != null ? (
          <div><dt>aggregate_total</dt><dd>{diagnostics.aggregateTotal}</dd></div>
        ) : null}
        <div><dt>returned_features</dt><dd>{diagnostics.returnedFeatures}</dd></div>
        <div><dt>represented_features</dt><dd>{diagnostics.representedFeatures}</dd></div>
        {diagnostics.representedPropertyTotal != null ? (
          <div><dt>represented_property_total</dt><dd>{diagnostics.representedPropertyTotal}</dd></div>
        ) : null}
        {diagnostics.coveringTiles != null ? (
          <div><dt>covering_tiles</dt><dd>{diagnostics.coveringTiles}</dd></div>
        ) : null}
        {diagnostics.decodedTileFeatures != null ? (
          <div><dt>decoded_tile_features</dt><dd>{diagnostics.decodedTileFeatures}</dd></div>
        ) : null}
        {diagnostics.uniqueTilePropertyIds != null ? (
          <div><dt>unique_tile_property_ids</dt><dd>{diagnostics.uniqueTilePropertyIds}</dd></div>
        ) : null}
        {diagnostics.duplicateIds != null ? (
          <div><dt>duplicate_ids</dt><dd>{diagnostics.duplicateIds}</dd></div>
        ) : null}
        {diagnostics.tileCanonicalDifference != null ? (
          <div><dt>tile_vs_canonical_delta</dt><dd>{diagnostics.tileCanonicalDifference}</dd></div>
        ) : null}
        {diagnostics.renderedIndividualIcons != null ? (
          <div><dt>rendered_individual_icons</dt><dd>{diagnostics.renderedIndividualIcons}</dd></div>
        ) : null}
        {diagnostics.renderedClusters != null ? (
          <div><dt>rendered_clusters</dt><dd>{diagnostics.renderedClusters}</dd></div>
        ) : null}
        {diagnostics.clusteredPropertyTotal != null ? (
          <div><dt>clustered_property_total</dt><dd>{diagnostics.clusteredPropertyTotal}</dd></div>
        ) : null}
        {diagnostics.renderedHalos != null ? (
          <div><dt>halo_count</dt><dd>{diagnostics.renderedHalos}</dd></div>
        ) : null}
        {diagnostics.collisionHiddenEstimate != null ? (
          <div><dt>collision_hidden_symbols</dt><dd>{diagnostics.collisionHiddenEstimate}</dd></div>
        ) : null}
        <div><dt>clipped</dt><dd>{diagnostics.clipped ? 'true' : 'false'}</dd></div>
        <div><dt>tile_backed</dt><dd>{diagnostics.tileBacked ? 'true' : 'false'}</dd></div>
        {diagnostics.invariantViolations != null ? (
          <div><dt>invariant_violations</dt><dd>{diagnostics.invariantViolations}</dd></div>
        ) : null}
        {diagnostics.duplicateRenderedMarkers != null ? (
          <div><dt>duplicate_rendered_markers</dt><dd>{diagnostics.duplicateRenderedMarkers}</dd></div>
        ) : null}
        {diagnostics.paginationBoundary ? (
          <div><dt>pagination_boundary</dt><dd>{diagnostics.paginationBoundary}</dd></div>
        ) : null}
      </dl>
    </div>
  )
}