import { useState } from 'react'

interface Props {
  radius: number
  setRadius: (radius: number) => void
  visibleCount: number
  loading: boolean
  onResetBounds: () => void
  onFitComps: () => void
  onRecenter: () => void
  onFindMoreComps: () => void
  expansionLog: string | null
  canExpand: boolean
}

const RADII = [0.25, 0.5, 1, 1.5, 3, 5]

export function MapCommandRail({
  radius,
  setRadius,
  visibleCount,
  loading,
  onResetBounds,
  onFitComps,
  onRecenter,
  onFindMoreComps,
  expansionLog,
  canExpand,
}: Props) {
  const [mapStyle, setMapStyle] = useState<'dark' | 'satellite'>('dark')

  return (
    <div className="ci-map-controls ci-map-controls--property" role="toolbar" aria-label="Map controls">
      <div className="ci-map-control-topline">
        <span className="ci-map-kicker">Search Radius</span>
        <span className="ci-map-health">{loading ? 'Searching…' : `${visibleCount} comps`}</span>
      </div>

      <div className="ci-map-control-group ci-map-control-group--radius" role="group" aria-label="Search radius">
        {RADII.map((r) => (
          <button
            key={r}
            type="button"
            className={`ci-map-ctrl-btn${radius === r ? ' is-active' : ''}`}
            onClick={() => setRadius(r)}
            disabled={loading}
          >
            {r} mi
          </button>
        ))}
      </div>

      <div className="ci-map-control-group" role="group" aria-label="Map view">
        <button
          type="button"
          className={`ci-map-ctrl-btn${mapStyle === 'dark' ? ' is-active' : ''}`}
          onClick={() => setMapStyle('dark')}
        >
          Map
        </button>
        <button
          type="button"
          className={`ci-map-ctrl-btn${mapStyle === 'satellite' ? ' is-active' : ''}`}
          onClick={() => setMapStyle('satellite')}
        >
          Satellite
        </button>
        <button type="button" className="ci-map-ctrl-btn" onClick={onRecenter}>Recenter</button>
        <button type="button" className="ci-map-ctrl-btn" onClick={onFitComps}>Fit comps</button>
        <button type="button" className="ci-map-ctrl-btn" onClick={onResetBounds}>Reset view</button>
      </div>

      <button
        type="button"
        className="ci-find-more-btn"
        onClick={onFindMoreComps}
        disabled={loading || !canExpand}
      >
        Find More Comps
      </button>

      {expansionLog && (
        <p className="ci-expansion-log" role="status">{expansionLog}</p>
      )}
    </div>
  )
}