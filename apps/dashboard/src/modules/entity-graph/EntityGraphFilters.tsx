import { useEffect, useState } from 'react'
import type { EntityGraphFilters as Filters, EntityGraphTab } from '../../domain/entity-graph/entity-graph.types'
import { EMPTY_ENTITY_GRAPH_FILTERS } from '../../domain/entity-graph/entity-graph.types'
import type {
  EntityGraphFieldFilter,
  EntityGraphFilterCatalog,
} from '../../domain/entity-graph/entity-graph-field-filters'
import { fetchEntityGraphFilterCatalog } from '../../domain/entity-graph/entity-graph-field-filters'
import { EntityGraphFieldFilterBuilder } from './EntityGraphFieldFilterBuilder'

type Props = {
  open: boolean
  tab: EntityGraphTab
  filters: Filters
  fieldFilters: EntityGraphFieldFilter[]
  onChange: (filters: Filters) => void
  onFieldFiltersChange: (filters: EntityGraphFieldFilter[]) => void
  onClose: () => void
  onApply: () => void
  onClear: () => void
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <label className="eg-filter-field">
      <span>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export function EntityGraphFiltersPanel({
  open,
  tab,
  filters,
  fieldFilters,
  onChange,
  onFieldFiltersChange,
  onClose,
  onApply,
  onClear,
}: Props) {
  const [catalog, setCatalog] = useState<EntityGraphFilterCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(null)
    fetchEntityGraphFilterCatalog(tab, controller.signal)
      .then((next) => setCatalog(next))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setCatalog(null)
        setCatalogError(error instanceof Error ? error.message : 'filter_catalog_unavailable')
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false)
      })
    return () => controller.abort()
  }, [open, tab])

  if (!open) return null

  const patch = (key: keyof Filters, value: string | boolean) => {
    onChange({ ...filters, [key]: value })
  }

  return (
    <div className="eg-filters-backdrop" onClick={onClose}>
      <aside className="eg-filters-drawer nx-liquid-surface" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Entity Graph filters">
        <header className="eg-filters-drawer__header">
          <div>
            <strong>Filters</strong>
            <span>Refine {tab.replace(/_/g, ' ')} without leaving this view</span>
          </div>
          <button type="button" className="eg-glass-btn" onClick={onClose}>Close</button>
        </header>

        <div className="eg-filters-drawer__body">
          <div className="eg-filters-section">
            <EntityGraphFieldFilterBuilder
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              filters={fieldFilters}
              onChange={onFieldFiltersChange}
            />
          </div>

          <div className="eg-filters-section">
            {/* Shortcuts, not a second catalog: each of these spans more than one
                column on purpose (Market matches market OR market_region, ZIP
                matches both zip columns), which a single catalog field cannot
                express. Everything else lives in the field builder above. */}
            <h4>Quick filters</h4>
            <div className="eg-filters-grid">
              <Field label="Market" value={filters.market} onChange={(v) => patch('market', v)} placeholder="Los Angeles, CA" />
              <Field label="City" value={filters.city} onChange={(v) => patch('city', v)} />
              <Field label="State" value={filters.state} onChange={(v) => patch('state', v)} placeholder="CA" />
              <Field label="ZIP" value={filters.zip} onChange={(v) => patch('zip', v)} />
            </div>
          </div>

          {(tab === 'properties' || tab === 'zips') && (
            <div className="eg-filters-section">
              <h4>Property</h4>
              <div className="eg-filters-grid">
                <Field label="Asset type" value={filters.assetType} onChange={(v) => patch('assetType', v)} />
                <Field label="Units min" value={filters.unitsMin} onChange={(v) => patch('unitsMin', v)} type="number" />
                <Field label="Units max" value={filters.unitsMax} onChange={(v) => patch('unitsMax', v)} type="number" />
                <Field label="Score min" value={filters.scoreMin} onChange={(v) => patch('scoreMin', v)} type="number" />
                <Field label="Score max" value={filters.scoreMax} onChange={(v) => patch('scoreMax', v)} type="number" />
              </div>
            </div>
          )}

          {tab === 'master_owners' && (
            <div className="eg-filters-section">
              <h4>Owner</h4>
              <div className="eg-filters-grid">
                <Field label="Owner type" value={filters.ownerType} onChange={(v) => patch('ownerType', v)} />
                <Field label="Priority tier" value={filters.priorityTier} onChange={(v) => patch('priorityTier', v)} />
                <Field label="Contact coverage min %" value={filters.coverageMin} onChange={(v) => patch('coverageMin', v)} type="number" />
              </div>
            </div>
          )}

          {tab === 'people' && (
            <div className="eg-filters-section">
              <h4>People</h4>
              <div className="eg-filters-grid">
                <Field label="Language" value={filters.language} onChange={(v) => patch('language', v)} />
                <label className="eg-filter-check">
                  <input type="checkbox" checked={filters.reachable} onChange={(e) => patch('reachable', e.target.checked)} />
                  <span>Reachable / has contact methods</span>
                </label>
              </div>
            </div>
          )}

          {tab === 'contact_methods' && (
            <div className="eg-filters-section">
              <h4>Contact</h4>
              <div className="eg-filters-grid">
                <label className="eg-filter-field">
                  <span>Status</span>
                  <select value={filters.contactStatus} onChange={(e) => patch('contactStatus', e.target.value)}>
                    <option value="">Any</option>
                    <option value="eligible">Eligible</option>
                    <option value="wrong">Wrong / failed</option>
                  </select>
                </label>
                <label className="eg-filter-check">
                  <input type="checkbox" checked={filters.reachable} onChange={(e) => patch('reachable', e.target.checked)} />
                  <span>Reachable only</span>
                </label>
              </div>
            </div>
          )}

          {tab === 'organizations' && (
            <div className="eg-filters-section">
              <h4>Entity</h4>
              <Field label="Entity type" value={filters.entityType} onChange={(v) => patch('entityType', v)} />
            </div>
          )}
        </div>

        <footer className="eg-filters-drawer__footer">
          <button
            type="button"
            className="eg-glass-btn"
            onClick={() => {
              onChange({ ...EMPTY_ENTITY_GRAPH_FILTERS })
              onFieldFiltersChange([])
            }}
          >
            Reset
          </button>
          <button type="button" className="eg-glass-btn" onClick={onClear}>Clear all</button>
          <button type="button" className="eg-glass-btn is-primary" onClick={onApply}>Apply filters</button>
        </footer>
      </aside>
    </div>
  )
}