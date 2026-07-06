import { useMasterFilters } from '../MasterFiltersProvider'
import { SavedFiltersDrawer } from '../shared/SavedFiltersDrawer'
import { FooterActions } from '../shared/FooterActions'
import { DiscoverPane } from './DiscoverPane'
import { FilterStackPane } from './FilterStackPane'
import { ResultsPane } from './ResultsPane'

export function MasterFiltersDesktop() {
  const { showSavedDrawer, setShowSavedDrawer } = useMasterFilters()

  return (
    <div className="mf-shell mf-shell--desktop">
      <header className="mf-topbar">
        <div>
          <h2 className="mf-topbar__title">Master Filters</h2>
          <p className="mf-topbar__subtitle">Build the exact property universe shown on the map</p>
        </div>
        <button type="button" className="mf-btn mf-btn--ghost" onClick={() => setShowSavedDrawer(true)}>
          Saved Filters
        </button>
      </header>

      <div className="mf-command-grid">
        <DiscoverPane />
        <FilterStackPane />
        <ResultsPane />
      </div>

      <FooterActions />
      {showSavedDrawer ? <SavedFiltersDrawer onClose={() => setShowSavedDrawer(false)} /> : null}
    </div>
  )
}