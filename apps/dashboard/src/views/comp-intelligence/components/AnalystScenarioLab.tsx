import type { CompAnalystScenario } from '../../../domain/comp-intelligence/v3-types'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  scenario: CompAnalystScenario | null
  evidence: CompTransactionEvidence[]
  onToggleInclude: (id: string) => void
  onToggleExclude: (id: string) => void
  onReset: () => void
}

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : '—'

export function AnalystScenarioLab({ scenario, evidence, onToggleInclude, onToggleExclude, onReset }: Props) {
  return (
    <section className="ci-analyst-lab" aria-label="Analyst scenario lab">
      <header className="ci-analyst-lab__head">
        <h3>Analyst Scenario Lab</h3>
        <span className="ci-chip ci-chip--amber">Non-authoritative</span>
        <button type="button" onClick={onReset}>Reset to canonical V3</button>
      </header>
      <p className="ci-analyst-lab__note">
        Manual include/exclude never mutates canonical V3 decision. All resulting values are labeled ANALYST SCENARIO.
      </p>
      {scenario && (
        <div className="ci-analyst-lab__delta">
          <div>Scenario Market Value: <strong className="tabular-nums">{fmt(scenario.scenario_market_value?.mid)}</strong></div>
          <div>Scenario Offer: <strong className="tabular-nums">{fmt(scenario.scenario_offer)}</strong></div>
          <div>Δ Market: <strong className="tabular-nums">{fmt(scenario.delta_from_canonical.market_value)}</strong></div>
        </div>
      )}
      <div className="ci-analyst-lab__list">
        {evidence.slice(0, 40).map((row) => {
          const id = row.candidate_id || ''
          return (
            <div key={id} className="ci-analyst-lab__row">
              <span>{row.address}</span>
              <span>{row.qualification_status}</span>
              <button type="button" onClick={() => onToggleInclude(id)}>Include</button>
              <button type="button" onClick={() => onToggleExclude(id)}>Exclude</button>
            </div>
          )
        })}
      </div>
    </section>
  )
}