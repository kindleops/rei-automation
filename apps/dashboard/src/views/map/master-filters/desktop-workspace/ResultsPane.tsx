import { useMasterFilters } from '../MasterFiltersProvider'
import { ENTITY_LABELS } from '../types'
import { cls, fmtCount } from '../utils'
import { ExpressionSummary } from '../shared/ExpressionSummary'

const COUNT_ROWS = [
  { key: 'matchingProperties' as const, label: ENTITY_LABELS.property },
  { key: 'matchingProspects' as const, label: ENTITY_LABELS.prospect },
  { key: 'matchingMasterOwners' as const, label: ENTITY_LABELS.master_owner },
  { key: 'matchingPhones' as const, label: ENTITY_LABELS.phone },
]

export function ResultsPane() {
  const {
    previewCounts,
    previewLoading,
    previewError,
    previewDurationMs,
    activeRuleCount,
    matchingPropertyCount,
    isDraftDirty,
    appliedToken,
  } = useMasterFilters()

  return (
    <aside className="mf-pane mf-pane--results">
      <h3 className="mf-pane__title">Results</h3>
      <div className="mf-results-hero">
        <span className={cls('mf-results-hero__count', previewLoading && 'is-loading')}>
          {fmtCount(matchingPropertyCount)}
        </span>
        <span className="mf-results-hero__label">Properties</span>
        <p className="mf-results-hero__sub">
          {activeRuleCount === 0
            ? 'All authorized properties'
            : `${activeRuleCount} active rule${activeRuleCount === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="mf-results-grid">
        {COUNT_ROWS.map((row) => (
          <div key={row.key} className="mf-results-stat">
            <span className="mf-results-stat__label">{row.label}</span>
            <span className={cls('mf-results-stat__value', previewLoading && 'is-loading')}>
              {fmtCount(previewCounts?.[row.key])}
            </span>
          </div>
        ))}
      </div>

      <div className="mf-results-meta">
        {previewLoading ? <span>Preview loading…</span> : null}
        {!previewLoading && previewDurationMs != null ? <span>Query {previewDurationMs}ms</span> : null}
        <span>{appliedToken ? (isDraftDirty ? 'Draft' : 'Applied') : 'Draft'}</span>
      </div>

      {previewError ? <p className="mf-pane__error">{previewError}</p> : null}
      <ExpressionSummary />
    </aside>
  )
}