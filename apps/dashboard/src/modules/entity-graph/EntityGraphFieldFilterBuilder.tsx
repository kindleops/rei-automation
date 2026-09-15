import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  EntityGraphFieldFilter,
  EntityGraphFilterCatalog,
  EntityGraphFilterField,
} from '../../domain/entity-graph/entity-graph-field-filters'
import {
  defaultOperatorFor,
  defaultValueFor,
  describeFieldFilter,
  findCatalogField,
  operatorIsMultiValue,
  operatorIsRange,
  operatorNeedsValue,
  searchCatalogFields,
} from '../../domain/entity-graph/entity-graph-field-filters'

/**
 * THE FILTER BUILDER RENDERS WHATEVER THE CATALOG SAYS.
 *
 * There is no field list in this component. Every control -- which fields
 * exist, which operators each accepts, whether a value is a number, a date, a
 * boolean or a list -- comes from the catalog the backend serves, which is the
 * same catalog the campaign builder targets from. Adding a column to
 * FIELD_GROUPS puts it here; removing one takes it out of both places at once.
 *
 * Deliberately NOT a hundred hard-coded inputs: with 101 property fields a
 * fixed form is unreadable and unmaintainable, and it is exactly how the two
 * surfaces drifted apart in the first place.
 */

type Props = {
  catalog: EntityGraphFilterCatalog | null
  loading: boolean
  error: string | null
  filters: EntityGraphFieldFilter[]
  onChange: (filters: EntityGraphFieldFilter[]) => void
}

function ValueInput({
  field,
  filter,
  onValue,
}: {
  field: EntityGraphFilterField
  filter: EntityGraphFieldFilter
  onValue: (value: unknown) => void
}) {
  const { operator } = filter

  if (!operatorNeedsValue(operator)) return null

  if (operatorIsRange(operator)) {
    const pair = Array.isArray(filter.value) ? filter.value : ['', '']
    const inputType = field.type === 'date' ? 'date' : 'number'
    return (
      <div className="eg-ff-row__range">
        <input
          type={inputType}
          value={String(pair[0] ?? '')}
          placeholder="From"
          onChange={(event) => onValue([event.target.value, pair[1] ?? ''])}
        />
        <span aria-hidden="true">–</span>
        <input
          type={inputType}
          value={String(pair[1] ?? '')}
          placeholder="To"
          onChange={(event) => onValue([pair[0] ?? '', event.target.value])}
        />
      </div>
    )
  }

  if (operatorIsMultiValue(operator)) {
    // Comma-separated is the honest editor for `is_any_of` until the options
    // endpoint is wired: it sends a real list, and it does not pretend to know
    // the column's distinct values.
    const values = Array.isArray(filter.value) ? filter.value : []
    return (
      <input
        type="text"
        className="eg-ff-row__value"
        value={values.map((entry) => String(entry ?? '')).join(', ')}
        placeholder="Value, value, value"
        onChange={(event) =>
          onValue(event.target.value.split(',').map((part) => part.trim()).filter(Boolean))
        }
      />
    )
  }

  if (field.type === 'number' || field.type === 'date') {
    return (
      <input
        type={field.type === 'date' ? 'date' : 'number'}
        className="eg-ff-row__value"
        value={String(filter.value ?? '')}
        onChange={(event) => onValue(event.target.value)}
      />
    )
  }

  return (
    <input
      type="text"
      className="eg-ff-row__value"
      value={String(filter.value ?? '')}
      placeholder={field.label}
      onChange={(event) => onValue(event.target.value)}
    />
  )
}

export function EntityGraphFieldFilterBuilder({ catalog, loading, error, filters, onChange }: Props) {
  const [picker, setPicker] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(() => searchCatalogFields(catalog, picker).slice(0, 60), [catalog, picker])

  useEffect(() => {
    if (!pickerOpen) return undefined
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', onDocumentPointerDown)
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown)
  }, [pickerOpen])

  const addField = (field: EntityGraphFilterField) => {
    const operator = defaultOperatorFor(field)
    onChange([
      ...filters,
      { field_key: field.key, operator, value: defaultValueFor(field, operator) },
    ])
    setPicker('')
    setPickerOpen(false)
  }

  const patch = (index: number, next: Partial<EntityGraphFieldFilter>) => {
    onChange(filters.map((filter, i) => (i === index ? { ...filter, ...next } : filter)))
  }

  const remove = (index: number) => {
    onChange(filters.filter((_, i) => i !== index))
  }

  if (!catalog && !loading) {
    return (
      <div className="eg-ff-empty">
        {error
          ? `Field filters unavailable: ${error}`
          : 'This tab is an aggregate view — column filters cannot be applied to it.'}
      </div>
    )
  }

  return (
    <div className="eg-ff">
      <div className="eg-ff__head">
        <div>
          <strong>Field filters</strong>
          <span>
            {loading
              ? 'Loading fields…'
              : `${catalog?.total_fields ?? 0} fields on ${catalog?.source ?? ''} — the same catalog campaigns target from`}
          </span>
        </div>
      </div>

      {filters.length > 0 && (
        <ul className="eg-ff__list">
          {filters.map((filter, index) => {
            const field = findCatalogField(catalog, filter.field_key)
            if (!field) {
              // A saved cohort can carry a field the catalog no longer has. Say
              // so instead of rendering a control that cannot be executed --
              // the request would fail closed with `unknown_campaign_field`.
              return (
                <li className="eg-ff-row is-unknown" key={`${filter.field_key}-${index}`}>
                  <span className="eg-ff-row__unknown">
                    {filter.field_key} is not a filterable field on this tab
                  </span>
                  <button type="button" className="eg-ff-row__remove" onClick={() => remove(index)}>
                    Remove
                  </button>
                </li>
              )
            }
            return (
              <li className="eg-ff-row" key={`${filter.field_key}-${index}`}>
                <div className="eg-ff-row__field">
                  <strong>{field.label}</strong>
                  <span>{field.category}</span>
                </div>
                <select
                  className="eg-ff-row__operator"
                  value={filter.operator}
                  onChange={(event) => {
                    const operator = event.target.value
                    patch(index, { operator, value: defaultValueFor(field, operator) })
                  }}
                  aria-label={`${field.label} operator`}
                >
                  {field.operators.map((operator) => (
                    <option key={operator.key} value={operator.key}>
                      {operator.label}
                    </option>
                  ))}
                </select>
                <ValueInput field={field} filter={filter} onValue={(value) => patch(index, { value })} />
                <button
                  type="button"
                  className="eg-ff-row__remove"
                  onClick={() => remove(index)}
                  aria-label={`Remove ${field.label} filter`}
                >
                  ×
                </button>
                {field.data_coverage === 'empty' && (
                  <p className="eg-ff-row__warning">
                    This column holds no data ({field.data_coverage_note}) — it can only return 0 records.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="eg-ff__picker" ref={pickerRef}>
        <input
          type="text"
          value={picker}
          placeholder="Add a filter — search equity, tax, flood, units…"
          onChange={(event) => {
            setPicker(event.target.value)
            setPickerOpen(true)
          }}
          onFocus={() => setPickerOpen(true)}
          aria-label="Search filter fields"
        />
        {pickerOpen && (
          <ul className="eg-ff__options" role="listbox">
            {matches.length === 0 && <li className="eg-ff__option is-empty">No field matches that</li>}
            {matches.map((field) => (
              <li key={field.key}>
                <button type="button" className="eg-ff__option" onClick={() => addField(field)}>
                  <span className="eg-ff__option-label">{field.label}</span>
                  <span className="eg-ff__option-meta">
                    {field.category}
                    {field.data_coverage === 'empty' ? ' · no data' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {filters.length > 0 && (
        <p className="eg-ff__summary">
          {filters
            .map((filter) => describeFieldFilter(filter, findCatalogField(catalog, filter.field_key)))
            .join(' · ')}
        </p>
      )}
    </div>
  )
}
