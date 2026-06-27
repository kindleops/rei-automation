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
  previousRadius?: number | null
  nextRadius?: number | null
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
  previousRadius,
  nextRadius,
}: Props) {
  const radiusLabel = `${radius.toFixed(radius < 1 ? 2 : 1)} MI`

  return (
    <div className="ci-map-controls" role="toolbar" aria-label="Map controls">
      {/* Small persistent radius label per spec */}
      <div className="ci-radius-label" aria-live="polite">
        {radiusLabel} SEARCH RADIUS
      </div>

      <div className="ci-map-control-group ci-map-control-group--radius" role="group" aria-label="Search radius">
        <span className="ci-map-group-label">Radius</span>
        {RADII.map((r) => (
          <button
            key={r}
            type="button"
            className={`ci-map-ctrl-btn${radius === r ? ' is-active' : ''}`}
            onClick={() => setRadius(r)}
            disabled={loading}
            title={`${r} miles`}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="ci-map-control-group" role="group" aria-label="Map tools">
        <button type="button" className="ci-map-ctrl-btn" onClick={onRecenter} title="Recenter on subject">Recenter</button>
        <button type="button" className="ci-map-ctrl-btn" onClick={onFitComps} title="Fit visible comps + subject">Fit Comps</button>
        <button type="button" className="ci-map-ctrl-btn" onClick={onResetBounds} title="Reset map camera only">Reset View</button>
        <button
          type="button"
          className="ci-map-ctrl-btn is-accent"
          onClick={onFindMoreComps}
          disabled={loading || !canExpand}
          title={canExpand ? `Expand search (next ${nextRadius ?? ''}mi)` : 'No further expansion'}
        >
          EXPAND SEARCH
        </button>
      </div>

      {(loading || expansionLog) && (
        <div className="ci-map-control-status" aria-live="polite">
          {loading ? `${visibleCount} comps · searching…` : expansionLog}
        </div>
      )}

      {expansionLog && previousRadius != null && (
        <div className="ci-expansion-summary" role="status">
          {previousRadius}mi → {nextRadius ?? radius}mi
        </div>
      )}
    </div>
  )
}