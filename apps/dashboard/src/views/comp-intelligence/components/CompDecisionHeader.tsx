import type { CompIntelligenceDecisionProjection } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  address: string
  projection: CompIntelligenceDecisionProjection | null
  dataSourceLabel: string
}

const fmtPct = (n: number | null | undefined) => (n != null ? `${Math.round(n)}%` : '—')

export function CompDecisionHeader({ address, projection, dataSourceLabel }: Props) {
  const shadow = projection?.shadow_mode
  const liveOff = !projection?.offer_authorization?.authorized_recommended_offer

  return (
    <header className="ci-decision-header" role="banner">
      <div className="ci-decision-header__primary">
        <h1 className="ci-decision-header__address">{address || 'Subject property'}</h1>
        <div className="ci-decision-header__lane">
          <span className="ci-chip ci-chip--lane">{projection?.canonical_asset_lane ?? 'Lane unresolved'}</span>
          <span className="ci-chip">Lane confidence {fmtPct(projection?.asset_lane_confidence)}</span>
        </div>
      </div>
      <div className="ci-decision-header__status">
        <span className={`ci-chip ci-chip--state ci-chip--${(projection?.execution_state || 'unknown').toLowerCase()}`}>
          {projection?.execution_state ?? 'Loading'}
        </span>
        <span className="ci-chip">{projection?.value_classification ?? '—'}</span>
        <span className="ci-chip">Confidence {fmtPct(projection?.final_confidence)}</span>
        <span className="ci-chip">Universe {projection?.dominant_model_universe ?? '—'}</span>
        <span className="ci-chip">ESS {projection?.dominant_model_ess ?? '—'}</span>
        <span className="ci-chip">Basis {projection?.execution_state_basis?.basis_strategy ?? '—'}</span>
        <span className="ci-chip ci-chip--muted">
          {projection?.engine_version ?? '—'} / {projection?.formula_version ?? '—'}
        </span>
        {shadow && <span className="ci-chip ci-chip--amber">Shadow Mode</span>}
        {liveOff && <span className="ci-chip ci-chip--red">Live Authorization Off</span>}
        <span className="ci-chip ci-chip--muted">{dataSourceLabel}</span>
      </div>
    </header>
  )
}