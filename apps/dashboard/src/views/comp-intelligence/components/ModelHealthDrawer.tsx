import type { CompModelHealth } from '../../../domain/comp-intelligence/v3-types'

interface Props {
  health: CompModelHealth
  open: boolean
  onClose: () => void
}

export function ModelHealthDrawer({ health, open, onClose }: Props) {
  if (!open) return null

  return (
    <aside className="ci-model-health" role="dialog" aria-label="Model health">
      <header>
        <h3>Model Health</h3>
        <button type="button" onClick={onClose} aria-label="Close model health">×</button>
      </header>
      <dl className="ci-model-health__grid">
        <div><dt>Total clean evidence</dt><dd>{health.total_clean_evidence ?? '—'}</dd></div>
        <div><dt>Wholesale pricing ESS</dt><dd>{health.wholesale_pricing_ess ?? '—'}</dd></div>
        <div><dt>Dominant cap</dt><dd>{health.dominant_universe_cap ?? '—'}</dd></div>
        <div><dt>Model disagreement</dt><dd>{health.model_disagreement != null ? `${Math.round(health.model_disagreement)}%` : '—'}</dd></div>
      </dl>
      {health.anomaly_materiality && (
        <section>
          <h4>Anomaly materiality</h4>
          <p>{health.anomaly_materiality.transaction_anomaly_material ? 'Material' : 'Non-material'}</p>
          <ul>
            {(health.anomaly_materiality.material_anomaly_reasons ?? []).map((r) => <li key={r}>{r}</li>)}
          </ul>
        </section>
      )}
      {health.feature_flags && (
        <section>
          <h4>Feature flags</h4>
          <ul>
            {Object.entries(health.feature_flags).map(([k, v]) => (
              <li key={k}>{k}: {String(v)}</li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}