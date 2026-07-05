import { useMasterFilters } from '../MasterFiltersProvider'

export function SavedFiltersLibrary() {
  const { setShowSavedLibrary } = useMasterFilters()

  return (
    <section className="mf-saved-library">
      <header className="mf-saved-library__header">
        <h3>Saved filters</h3>
        <button
          type="button"
          className="mf-icon-btn"
          aria-label="Close saved filters"
          onClick={() => setShowSavedLibrary(false)}
        >
          ×
        </button>
      </header>
      <div className="mf-empty-state mf-empty-state--centered">
        <p className="mf-empty-state__title">No saved filters yet</p>
        <p className="mf-empty-state__body">
          Saved filter library arrives in commit 6. Apply a stack to the map now, then save presets here later.
        </p>
      </div>
    </section>
  )
}