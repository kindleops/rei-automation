import { useMasterFilters } from '../MasterFiltersProvider'
import { CANONICAL_PROPERTY_BASELINE } from '../constants'
import { fmtCount } from '../utils'

export function FooterActions({ mobile = false }: { mobile?: boolean }) {
  const {
    clearFilters,
    applyFilters,
    applyLoading,
    activeRuleCount,
    matchingPropertyCount,
    matchingPropertyCountLabel,
    appliedToken,
    isDraftDirty,
    canApply,
    previewStatus,
    setShowSavedDrawer,
  } = useMasterFilters()

  const countLabel = activeRuleCount === 0
    ? fmtCount(matchingPropertyCount ?? CANONICAL_PROPERTY_BASELINE)
    : matchingPropertyCount == null
      ? '—'
      : fmtCount(matchingPropertyCount)

  let primaryLabel = `Show ${countLabel} Properties`
  if (!canApply && activeRuleCount > 0) {
    if (previewStatus === 'incomplete') primaryLabel = 'Complete rule to apply'
    else if (previewStatus === 'failed') primaryLabel = 'Fix rule to apply'
    else if (previewStatus === 'loading' || previewStatus === 'stale') primaryLabel = 'Refreshing count…'
    else primaryLabel = matchingPropertyCountLabel
  } else if (appliedToken && !isDraftDirty && activeRuleCount > 0) {
    primaryLabel = `Update Map · ${countLabel} Properties`
  }

  return (
    <footer className={mobile ? 'mf-footer mf-footer--mobile' : 'mf-footer'}>
      <button type="button" className="mf-btn mf-btn--ghost" onClick={clearFilters}>Clear All</button>
      {!mobile ? (
        <button type="button" className="mf-btn mf-btn--ghost" onClick={() => setShowSavedDrawer(true)}>Save Filter</button>
      ) : null}
      <button
        type="button"
        className="mf-btn mf-btn--primary"
        disabled={applyLoading || !canApply}
        onClick={() => void applyFilters()}
      >
        {applyLoading ? 'Applying…' : primaryLabel}
      </button>
    </footer>
  )
}