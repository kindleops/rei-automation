import { useMasterFilters } from '../MasterFiltersProvider'
import { ENTITY_LABELS } from '../types'
import { cls, fmtCount } from '../utils'
import { ExpressionSummary } from './ExpressionSummary'

const COUNT_ROWS = [
  { key: 'matchingProperties' as const, label: ENTITY_LABELS.property },
  { key: 'matchingProspects' as const, label: ENTITY_LABELS.prospect },
  { key: 'matchingMasterOwners' as const, label: ENTITY_LABELS.master_owner },
  { key: 'matchingPhones' as const, label: ENTITY_LABELS.phone },
]

export function ResultsPanel() {
  const {
    previewCounts,
    previewLoading,
    previewError,
    activeRuleCount,
    applyFilters,
    applyLoading,
    applyError,
    appliedToken,
  } = useMasterFilters()

  return (
    <section className="mf-results-panel">
      <header className="mf-results-panel__header">
        <h3>Results</h3>
        {previewLoading ? <span className="mf-results-panel__status">Updating…</span> : null}
      </header>

      <div className="mf-results-panel__counts">
        {COUNT_ROWS.map((row) => (
          <div key={row.key} className="mf-count-card">
            <span className="mf-count-card__label">{row.label}</span>
            <span className={cls('mf-count-card__value', previewLoading && 'is-loading')}>
              {activeRuleCount === 0 ? '—' : fmtCount(previewCounts?.[row.key])}
            </span>
          </div>
        ))}
      </div>

      {previewError ? <p className="mf-results-panel__error">{previewError}</p> : null}
      {applyError ? <p className="mf-results-panel__error">{applyError}</p> : null}

      <ExpressionSummary />

      <div className="mf-results-panel__actions">
        <button
          type="button"
          className="mf-btn mf-btn--primary"
          disabled={activeRuleCount === 0 || applyLoading}
          onClick={() => void applyFilters()}
        >
          {applyLoading ? 'Applying…' : appliedToken ? 'Re-apply filters' : 'Save & apply'}
        </button>
      </div>
    </section>
  )
}