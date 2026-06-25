import type { EvidenceFilters, EvidenceMapMode } from '../hooks/useCompEvidenceFilters'

interface Props {
  mapMode: EvidenceMapMode
  setMapMode: (mode: EvidenceMapMode) => void
  radius: number
  setRadius: (radius: number) => void
  filters: EvidenceFilters
  setFilters: (filters: EvidenceFilters) => void
  visibleCount: number
  totalCount: number
  loading: boolean
  onResetBounds: () => void
  universes: string[]
}

const RADII = [0.25, 0.5, 1, 1.5, 3, 5]

export function MapCommandRail({
  mapMode,
  setMapMode,
  radius,
  setRadius,
  filters,
  setFilters,
  visibleCount,
  totalCount,
  loading,
  onResetBounds,
  universes,
}: Props) {
  return (
    <div className="ci-map-controls ci-map-controls--v3" role="toolbar" aria-label="Map controls">
      <div className="ci-map-control-topline">
        <span className="ci-map-kicker">Evidence Map</span>
        <span className="ci-map-health">{visibleCount}/{totalCount} visible</span>
      </div>

      <div className="ci-map-control-group" role="group" aria-label="Map mode">
        {(['PRICING', 'DEMAND', 'RISK'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`ci-map-ctrl-btn${mapMode === mode ? ' is-active' : ''}`}
            onClick={() => setMapMode(mode)}
          >
            {mode}
          </button>
        ))}
      </div>

      <div className="ci-map-control-group ci-map-control-group--radius" role="group" aria-label="Radius">
        {RADII.map((r) => (
          <button
            key={r}
            type="button"
            className={`ci-map-ctrl-btn${radius === r ? ' is-active' : ''}`}
            onClick={() => setRadius(r)}
          >
            {r}mi
          </button>
        ))}
      </div>

      <div className="ci-map-control-group" role="group" aria-label="Evidence status">
        {(['all', 'accepted', 'review', 'rejected'] as const).map((status) => (
          <button
            key={status}
            type="button"
            className={`ci-map-ctrl-btn${filters.status === status ? ' is-active' : ''}`}
            onClick={() => setFilters({ ...filters, status })}
          >
            {status}
          </button>
        ))}
      </div>

      {universes.length > 0 && (
        <select
          className="ci-map-select"
          aria-label="Valuation universe filter"
          value={filters.universe ?? ''}
          onChange={(e) => setFilters({ ...filters, universe: e.target.value || null })}
        >
          <option value="">All universes</option>
          {universes.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      )}

      <div className="ci-map-control-group">
        <button
          type="button"
          className={`ci-map-ctrl-btn${filters.packageOnly ? ' is-active' : ''}`}
          onClick={() => setFilters({ ...filters, packageOnly: !filters.packageOnly, singleAssetOnly: false })}
        >
          Package
        </button>
        <button
          type="button"
          className={`ci-map-ctrl-btn${filters.singleAssetOnly ? ' is-active' : ''}`}
          onClick={() => setFilters({ ...filters, singleAssetOnly: !filters.singleAssetOnly, packageOnly: false })}
        >
          Single
        </button>
        <button type="button" className="ci-map-ctrl-btn" onClick={onResetBounds}>
          Reset bounds
        </button>
      </div>

      {loading && <span className="ci-map-loading">Updating evidence…</span>}
    </div>
  )
}