import { useMasterFilters } from '../MasterFiltersProvider'
import { appendRuleToRoot, createRule } from '../expression-utils'
import type { MapFilterRegistryField } from '../types'
import { cls, fmtCount } from '../utils'
import { EntityRail } from '../shared/EntityRail'
import { FieldCatalog } from '../shared/FieldCatalog'
import { FieldSearch } from '../shared/FieldSearch'
import { GroupCard } from '../shared/GroupCard'
import { QuickFilters } from '../shared/QuickFilters'
import { ResultsPanel } from '../shared/ResultsPanel'
import { SavedFiltersLibrary } from '../shared/SavedFiltersLibrary'

export function MasterFiltersDesktop() {
  const {
    draftExpression,
    setDraftExpression,
    clearFilters,
    applyFilters,
    applyLoading,
    activeRuleCount,
    previewCounts,
    registryLoading,
    registryError,
    showSavedLibrary,
    setShowSavedLibrary,
  } = useMasterFilters()

  const onSelectField = (field: MapFilterRegistryField) => {
    const rule = createRule(field.key, field.operators[0] ?? 'equals', '')
    setDraftExpression(appendRuleToRoot(draftExpression, rule))
  }

  return (
    <div className="mf-workspace mf-workspace--desktop">
      <header className="mf-header">
        <div className="mf-header__title">
          <h2>Master Filters</h2>
          <p className="mf-header__subtitle">Filters the full property universe — contacted and uncontacted.</p>
        </div>
        <button
          type="button"
          className={cls('mf-btn mf-btn--ghost', showSavedLibrary && 'is-active')}
          onClick={() => setShowSavedLibrary(!showSavedLibrary)}
        >
          Saved Filters
        </button>
      </header>

      <div className="mf-desktop-layout">
        <aside className="mf-pane mf-pane--discover">
          <h3 className="mf-pane__title">Discover</h3>
          {registryLoading ? <p className="mf-pane__status">Loading registry…</p> : null}
          {registryError ? <p className="mf-pane__error">{registryError}</p> : null}
          <EntityRail />
          <FieldSearch onSelectField={onSelectField} />
          <QuickFilters />
          <FieldCatalog onSelectField={onSelectField} />
        </aside>

        <main className="mf-pane mf-pane--stack">
          <GroupCard group={draftExpression} isRoot depth={0} />
        </main>

        <aside className="mf-pane mf-pane--results">
          {showSavedLibrary ? <SavedFiltersLibrary /> : <ResultsPanel />}
        </aside>
      </div>

      <footer className="mf-footer">
        <button type="button" className="mf-btn mf-btn--ghost" onClick={clearFilters}>
          Clear All
        </button>
        <button
          type="button"
          className="mf-btn mf-btn--primary"
          disabled={activeRuleCount === 0 || applyLoading}
          onClick={() => void applyFilters()}
        >
          {applyLoading
            ? 'Applying…'
            : `Apply ${activeRuleCount} Filter${activeRuleCount === 1 ? '' : 's'}`}
          {activeRuleCount > 0 ? ` · ${fmtCount(previewCounts?.matchingProperties)}` : ''}
        </button>
      </footer>
    </div>
  )
}