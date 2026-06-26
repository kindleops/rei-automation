import type { CompIntelligenceDecisionProjection } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  address: string
  projection: CompIntelligenceDecisionProjection | null
  dataSourceLabel: string
}

export function CompDecisionHeader({ address, projection, dataSourceLabel }: Props) {
  const lane = projection?.canonical_asset_lane ?? 'Lane unresolved'
  const state = projection?.execution_state ?? 'Loading'

  return (
    <header className="ci-decision-header ci-decision-header--compact" role="banner">
      <div className="ci-decision-header__primary">
        <h1 className="ci-decision-header__address">{address || 'Subject property'}</h1>
        <div className="ci-decision-header__lane">
          <span className="ci-chip ci-chip--lane">{lane}</span>
          <span className={`ci-chip ci-chip--state ci-chip--${state.toLowerCase()}`}>{state}</span>
          <span className="ci-chip ci-chip--muted">{dataSourceLabel}</span>
        </div>
      </div>
    </header>
  )
}