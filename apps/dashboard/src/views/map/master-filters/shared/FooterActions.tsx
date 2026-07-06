import { useMasterFilters } from '../MasterFiltersProvider'
import { fmtCount } from '../utils'

export function FooterActions({ mobile = false }: { mobile?: boolean }) {
  const {
    clearFilters,
    applyFilters,
    applyLoading,
    activeRuleCount,
    matchingPropertyCount,
    appliedToken,
    isDraftDirty,
    setShowSavedDrawer,
  } = useMasterFilters()

  const countLabel = fmtCount(matchingPropertyCount)
  const primaryLabel = appliedToken && !isDraftDirty && activeRuleCount > 0
    ? `Update Map · ${countLabel} Properties`
    : `Show ${countLabel} Properties`

  return (
    <footer className={mobile ? 'mf-footer mf-footer--mobile' : 'mf-footer'}>
      <button type="button" className="mf-btn mf-btn--ghost" onClick={clearFilters}>Clear All</button>
      {!mobile ? (
        <button type="button" className="mf-btn mf-btn--ghost" onClick={() => setShowSavedDrawer(true)}>Save Filter</button>
      ) : null}
      <button
        type="button"
        className="mf-btn mf-btn--primary"
        disabled={applyLoading}
        onClick={() => void applyFilters()}
      >
        {applyLoading ? 'Applying…' : primaryLabel}
      </button>
    </footer>
  )
}