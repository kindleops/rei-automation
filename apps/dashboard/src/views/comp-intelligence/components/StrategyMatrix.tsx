import type { CompStrategyEvidence } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  ranked: CompStrategyEvidence[] | undefined
}

export function StrategyMatrix({ ranked }: Props) {
  const rows = ranked ?? []
  if (!rows.length) return <p className="ci-empty">No strategy ranking available.</p>

  return (
    <div className="ci-strategy-matrix" role="table" aria-label="Strategy matrix">
      <div className="ci-strategy-matrix__head" role="row">
        <span role="columnheader">Strategy</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Underwritten</span>
        <span role="columnheader">Scenario</span>
        <span role="columnheader">Confidence</span>
        <span role="columnheader">Shadow</span>
        <span role="columnheader">Live</span>
        <span role="columnheader">Blockers</span>
      </div>
      {rows.map((row) => (
        <div key={row.strategy} className="ci-strategy-matrix__row" role="row">
          <span role="cell">{row.strategy}</span>
          <span role="cell">{row.qualification_status}</span>
          <span role="cell">{row.underwritten ? 'Yes' : 'No'}</span>
          <span role="cell">{row.scenario_only ? 'Yes' : 'No'}</span>
          <span role="cell">{row.confidence != null ? `${Math.round(row.confidence)}%` : '—'}</span>
          <span role="cell">{row.shadow_approved ? 'Yes' : 'No'}</span>
          <span role="cell">{row.live_authorized ? 'Yes' : 'No'}</span>
          <span role="cell">{(row.blockers ?? []).join(', ') || '—'}</span>
        </div>
      ))}
    </div>
  )
}