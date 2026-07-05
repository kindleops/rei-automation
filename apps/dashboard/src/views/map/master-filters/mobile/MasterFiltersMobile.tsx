import { useMasterFilters } from '../MasterFiltersProvider'
import { appendRuleToRoot, createRule } from '../expression-utils'
import type { MapFilterRegistryField, MasterFiltersMobilePane } from '../types'
import { cls } from '../utils'
import { EntityRail } from '../shared/EntityRail'
import { FieldCatalog } from '../shared/FieldCatalog'
import { FieldSearch } from '../shared/FieldSearch'
import { GroupCard } from '../shared/GroupCard'
import { QuickFilters } from '../shared/QuickFilters'
import { ResultsPanel } from '../shared/ResultsPanel'
import { SavedFiltersLibrary } from '../shared/SavedFiltersLibrary'

const MOBILE_TABS: Array<{ key: MasterFiltersMobilePane; label: string }> = [
  { key: 'discover', label: 'Discover' },
  { key: 'stack', label: 'Stack' },
  { key: 'results', label: 'Results' },
  { key: 'saved', label: 'Saved' },
]

export function MasterFiltersMobile() {
  const {
    draftExpression,
    setDraftExpression,
    clearFilters,
    applyFilters,
    applyLoading,
    activeRuleCount,
    mobilePane,
    setMobilePane,
    registryLoading,
    registryError,
  } = useMasterFilters()

  const onSelectField = (field: MapFilterRegistryField) => {
    const rule = createRule(field.key, field.operators[0] ?? 'equals', '')
    setDraftExpression(appendRuleToRoot(draftExpression, rule))
    setMobilePane('stack')
  }

  return (
    <div className="mf-workspace mf-workspace--mobile">
      <header className="mf-header mf-header--mobile">
        <div className="mf-header__title">
          <h2>Master Filters</h2>
        </div>
      </header>

      <nav className="mf-mobile-nav" aria-label="Master filters sections">
        {MOBILE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={cls('mf-mobile-nav__tab', mobilePane === tab.key && 'is-active')}
            onClick={() => setMobilePane(tab.key)}
          >
            {tab.label}
            {tab.key === 'stack' && activeRuleCount > 0 ? (
              <span className="mf-mobile-nav__badge">{activeRuleCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="mf-mobile-scroll">
        {mobilePane === 'discover' ? (
          <section className="mf-pane mf-pane--discover">
            {registryLoading ? <p className="mf-pane__status">Loading registry…</p> : null}
            {registryError ? <p className="mf-pane__error">{registryError}</p> : null}
            <EntityRail />
            <FieldSearch onSelectField={onSelectField} />
            <QuickFilters />
            <FieldCatalog onSelectField={onSelectField} />
          </section>
        ) : null}

        {mobilePane === 'stack' ? (
          <section className="mf-pane mf-pane--stack">
            <GroupCard group={draftExpression} isRoot depth={0} />
          </section>
        ) : null}

        {mobilePane === 'results' ? (
          <section className="mf-pane mf-pane--results">
            <ResultsPanel />
          </section>
        ) : null}

        {mobilePane === 'saved' ? (
          <section className="mf-pane mf-pane--saved">
            <SavedFiltersLibrary />
          </section>
        ) : null}
      </div>

      <footer className="mf-footer mf-footer--mobile">
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
        </button>
      </footer>
    </div>
  )
}