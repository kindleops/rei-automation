import { useMemo, useState } from 'react'
import type { PropertyFilterClause } from '../../lib/data/propertyData'
import {
  PROPERTY_FIELD_REGISTRY,
  PROPERTY_FIELD_REGISTRY_MAP,
  searchPropertyFieldRegistry,
} from './propertyFieldRegistry'
import type { SavedPropertyView } from './propertyFilters'

interface PropertyFilterBuilderProps {
  filters: PropertyFilterClause[]
  onChange: (filters: PropertyFilterClause[]) => void
  savedViews: SavedPropertyView[]
  onSaveView: (label: string) => void
  onLoadView: (id: string) => void
  onClear: () => void
}

const createClause = (): PropertyFilterClause => ({
  id: `filter-${Math.random().toString(36).slice(2, 8)}`,
  fieldKey: PROPERTY_FIELD_REGISTRY[0]?.key ?? 'market',
  operator: 'contains',
  value: '',
})

export const PropertyFilterBuilder = ({
  filters,
  onChange,
  savedViews,
  onSaveView,
  onLoadView,
  onClear,
}: PropertyFilterBuilderProps) => {
  const [open, setOpen] = useState(false)
  const [fieldSearch, setFieldSearch] = useState('')
  const [saveLabel, setSaveLabel] = useState('')

  const visibleFields = useMemo(
    () => searchPropertyFieldRegistry(fieldSearch),
    [fieldSearch],
  )

  const updateClause = (id: string, patch: Partial<PropertyFilterClause>) => {
    onChange(filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)))
  }

  const removeClause = (id: string) => {
    onChange(filters.filter((filter) => filter.id !== id))
  }

  const addClause = () => {
    onChange([...filters, createClause()])
  }

  return (
    <section className="pi-advanced-filters">
      <header className="pi-advanced-filters__header">
        <button
          type="button"
          className="pi-filter-toggle"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Hide Advanced Filters' : 'Add Filter'}
        </button>
        <div className="pi-advanced-filters__actions">
          <button type="button" onClick={addClause}>Add Rule</button>
          <button type="button" onClick={onClear}>Clear All</button>
        </div>
      </header>

      <div className="pi-active-filter-chips">
        {filters.map((filter) => {
          const field = PROPERTY_FIELD_REGISTRY_MAP.get(filter.fieldKey)
          return (
            <span key={filter.id} className="pi-filter-chip">
              {field?.label ?? filter.fieldKey} · {filter.operator}
              {filter.value !== undefined && filter.value !== '' ? ` · ${String(filter.value)}` : ''}
            </span>
          )
        })}
      </div>

      {open && (
        <div className="pi-advanced-filters__panel">
          <label className="pi-filter-field-search">
            <span>Search Fields</span>
            <input
              value={fieldSearch}
              onChange={(event) => setFieldSearch(event.target.value)}
              placeholder="Search by field label/category"
            />
          </label>

          {filters.map((filter) => {
            const field = PROPERTY_FIELD_REGISTRY_MAP.get(filter.fieldKey)
            const operators = field?.operators ?? ['contains']

            return (
              <article key={filter.id} className="pi-filter-rule">
                <label>
                  <span>Field</span>
                  <select
                    value={filter.fieldKey}
                    onChange={(event) => {
                      const nextField = PROPERTY_FIELD_REGISTRY_MAP.get(event.target.value)
                      updateClause(filter.id, {
                        fieldKey: event.target.value,
                        operator: (nextField?.operators[0] ?? 'contains') as any,
                        value: '',
                        valueTo: undefined,
                      })
                    }}
                  >
                    {visibleFields.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.category} · {entry.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Operator</span>
                  <select
                    value={filter.operator}
                    onChange={(event) => updateClause(filter.id, { operator: event.target.value as any })}
                  >
                    {operators.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Value</span>
                  <input
                    value={filter.value === undefined ? '' : String(filter.value)}
                    onChange={(event) => updateClause(filter.id, { value: event.target.value })}
                    placeholder="Value"
                    disabled={['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(filter.operator)}
                  />
                </label>

                {filter.operator === 'between' && (
                  <label>
                    <span>To</span>
                    <input
                      value={filter.valueTo === undefined ? '' : String(filter.valueTo)}
                      onChange={(event) => updateClause(filter.id, { valueTo: event.target.value })}
                      placeholder="Value to"
                    />
                  </label>
                )}

                <button type="button" onClick={() => removeClause(filter.id)}>
                  Remove
                </button>
              </article>
            )
          })}

          <div className="pi-saved-views">
            <label>
              <span>Save Current Filter Set</span>
              <input
                value={saveLabel}
                onChange={(event) => setSaveLabel(event.target.value)}
                placeholder="Saved view name"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const label = saveLabel.trim()
                if (!label) return
                onSaveView(label)
                setSaveLabel('')
              }}
            >
              Save View
            </button>

            <label>
              <span>Load Saved View</span>
              <select onChange={(event) => event.target.value && onLoadView(event.target.value)} defaultValue="">
                <option value="">Select saved view</option>
                {savedViews.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
    </section>
  )
}
