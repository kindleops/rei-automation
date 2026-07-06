import { useMasterFilters } from '../MasterFiltersProvider'
import { ENTITY_LABELS } from '../types'
import { cls, fmtCount } from '../utils'
import { ExpressionSummary } from '../shared/ExpressionSummary'
import { CANONICAL_PROPERTY_BASELINE } from '../constants'

const COUNT_ROWS = [
  { key: 'matchingProperties' as const, label: ENTITY_LABELS.property },
  { key: 'matchingProspects' as const, label: ENTITY_LABELS.prospect },
  { key: 'matchingMasterOwners' as const, label: ENTITY_LABELS.master_owner },
  { key: 'matchingPhones' as const, label: ENTITY_LABELS.phone },
]

function formatEntityCount(
  value: number | null | undefined,
  status: ReturnType<typeof useMasterFilters>['previewStatus'],
  activeRuleCount: number,
): string {
  if (activeRuleCount > 0 && (status === 'failed' || status === 'incomplete')) return '—'
  if (value == null) return '—'
  return fmtCount(value)
}

export function ResultsPane() {
  const {
    previewCounts,
    previewLoading,
    previewError,
    previewDurationMs,
    previewStatus,
    activeRuleCount,
    matchingPropertyCount,
    matchingPropertyCountLabel,
    canPreview,
    isDraftDirty,
    appliedToken,
    refreshPreview,
  } = useMasterFilters()

  const heroCount = activeRuleCount === 0
    ? fmtCount(matchingPropertyCount ?? CANONICAL_PROPERTY_BASELINE)
    : matchingPropertyCount == null
      ? '—'
      : fmtCount(matchingPropertyCount)

  return (
    <aside className="mf-pane mf-pane--results">
      <h3 className="mf-pane__title">Results</h3>
      <div className={cls('mf-results-hero', previewStatus === 'failed' && 'is-error', previewStatus === 'incomplete' && 'is-warning')}>
        <span className={cls(
          'mf-results-hero__count',
          previewLoading && canPreview && 'is-loading',
          previewStatus === 'stale' && 'is-stale',
        )}>
          {heroCount}
        </span>
        <span className="mf-results-hero__label">Properties</span>
        <p className="mf-results-hero__sub">{matchingPropertyCountLabel}</p>
      </div>

      <div className="mf-results-grid">
        {COUNT_ROWS.map((row) => (
          <div key={row.key} className="mf-results-stat">
            <span className="mf-results-stat__label">{row.label}</span>
            <span className={cls('mf-results-stat__value', previewLoading && canPreview && 'is-loading')}>
              {formatEntityCount(previewCounts?.[row.key], previewStatus, activeRuleCount)}
            </span>
          </div>
        ))}
      </div>

      <div className="mf-results-meta">
        {previewLoading && canPreview ? <span>Refreshing count…</span> : null}
        {!previewLoading && previewDurationMs != null && canPreview && previewStatus !== 'incomplete' ? (
          <span>Query {previewDurationMs}ms</span>
        ) : null}
        <span>{appliedToken ? (isDraftDirty ? 'Draft' : 'Applied') : 'Draft'}</span>
      </div>

      {previewStatus === 'failed' && previewError ? (
        <div className="mf-results-error">
          <p className="mf-pane__error">Could not preview this filter: {previewError}</p>
          <button type="button" className="mf-text-btn" onClick={() => void refreshPreview()}>Retry preview</button>
        </div>
      ) : null}
      {!canPreview && activeRuleCount > 0 ? (
        <p className="mf-pane__error">Complete the highlighted rule before previewing.</p>
      ) : null}
      <ExpressionSummary />
    </aside>
  )
}