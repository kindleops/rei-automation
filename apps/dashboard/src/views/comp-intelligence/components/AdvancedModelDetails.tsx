import { useState } from 'react'
import type { CompIntelligenceDecisionProjection, CompModelHealth } from '../../../domain/comp-intelligence/v3-types'
import { humanizeEvidenceRole, humanizeSourcePath } from '../utils/comp-display'

interface Props {
  projection: CompIntelligenceDecisionProjection | null
  modelHealth: CompModelHealth | null
  dataSource: string | null
  executionState: string | null
  canonicalLane: string | null
}

export function AdvancedModelDetails({
  projection,
  modelHealth,
  dataSource,
  executionState,
  canonicalLane,
}: Props) {
  const [open, setOpen] = useState(false)

  return (
    <section className="ci-advanced-details">
      <button
        type="button"
        className={`ci-advanced-details__toggle${open ? ' is-open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Advanced Model Details
        <span className="ci-advanced-details__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ci-advanced-details__body">
          <dl className="ci-advanced-details__list">
            <div><dt>Data source</dt><dd>{humanizeSourcePath(dataSource)}</dd></div>
            <div><dt>Execution state</dt><dd>{humanizeExecutionState(executionState)}</dd></div>
            <div><dt>Asset lane</dt><dd>{canonicalLane ? humanizeEvidenceRole(canonicalLane) ?? canonicalLane : 'Property type not confirmed'}</dd></div>
            {projection?.dominant_model_universe && (
              <div><dt>Dominant universe</dt><dd>{projection.dominant_model_universe}</dd></div>
            )}
            {modelHealth?.dominant_universe_cap != null && (
              <div><dt>Dominant cap</dt><dd>{modelHealth.dominant_universe_cap}</dd></div>
            )}
            {modelHealth?.wholesale_pricing_ess != null && (
              <div><dt>ESS</dt><dd>{modelHealth.wholesale_pricing_ess}</dd></div>
            )}
            {modelHealth?.model_disagreement != null && (
              <div><dt>Model disagreement</dt><dd>{modelHealth.model_disagreement}</dd></div>
            )}
            {projection?.strategy_depth_gate && (
              <div><dt>Strategy depth gate</dt><dd>{JSON.stringify(projection.strategy_depth_gate)}</dd></div>
            )}
          </dl>
        </div>
      )}
    </section>
  )
}

function humanizeExecutionState(state: string | null): string {
  if (!state) return '—'
  if (state === 'V3_DISABLED' || state === 'EVIDENCE_ONLY_DEGRADED') return 'Official decision unavailable'
  return state.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}