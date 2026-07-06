import { appendRuleToRoot, createRule } from '../expression-utils'
import { useMasterFilters } from '../MasterFiltersProvider'
import type { MapFilterRegistryField } from '../types'
import { EntityRail } from '../shared/EntityRail'
import { FieldCatalog } from '../shared/FieldCatalog'
import { FieldSearch } from '../shared/FieldSearch'
import { FooterActions } from '../shared/FooterActions'
import { GroupCard } from '../shared/GroupCard'
import { QuickFilters } from '../shared/QuickFilters'
import { SavedFiltersDrawer } from '../shared/SavedFiltersDrawer'
import { ResultsPane } from '../desktop-workspace/ResultsPane'
import { MobileNav } from './MobileNav'

export function MasterFiltersMobile() {
  const {
    draftExpression,
    setDraftExpression,
    mobilePane,
    setMobilePane,
    registryLoading,
    registryError,
    showSavedDrawer,
    setShowSavedDrawer,
  } = useMasterFilters()

  const onSelectField = (field: MapFilterRegistryField) => {
    const rule = createRule(field.key, field.operators[0] ?? 'equals', '')
    setDraftExpression(appendRuleToRoot(draftExpression, rule))
    setMobilePane('stack')
  }

  return (
    <div className="mf-shell mf-shell--mobile">
      <header className="mf-topbar mf-topbar--mobile">
        <div>
          <h2 className="mf-topbar__title">Master Filters</h2>
          <p className="mf-topbar__subtitle">Property universe command workspace</p>
        </div>
      </header>

      <MobileNav />

      <div className="mf-mobile-viewport">
        {mobilePane === 'discover' ? (
          <div className="mf-pane mf-pane--discover">
            {registryLoading ? <p className="mf-pane__status">Loading registry…</p> : null}
            {registryError ? <p className="mf-pane__error">{registryError}</p> : null}
            <FieldSearch onSelectField={onSelectField} />
            <EntityRail />
            <QuickFilters />
            <FieldCatalog onSelectField={onSelectField} />
          </div>
        ) : null}

        {mobilePane === 'stack' ? (
          <div className="mf-pane mf-pane--stack">
            <GroupCard group={draftExpression} isRoot depth={0} />
          </div>
        ) : null}

        {mobilePane === 'results' ? <ResultsPane /> : null}

        {mobilePane === 'saved' ? (
          <div className="mf-pane mf-pane--saved">
            <button type="button" className="mf-btn mf-btn--ghost" onClick={() => setShowSavedDrawer(true)}>
              Open saved filters library
            </button>
          </div>
        ) : null}
      </div>

      <FooterActions mobile />
      {showSavedDrawer ? <SavedFiltersDrawer onClose={() => setShowSavedDrawer(false)} /> : null}
    </div>
  )
}