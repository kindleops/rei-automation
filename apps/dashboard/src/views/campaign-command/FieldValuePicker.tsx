/**
 * The Composer's "is any of / is not any of" value picker (mobile builder and
 * the legacy desktop builder). A checkable list, not a native <select multiple>:
 * on iOS that control collapses to "0 Items", never showed what was selected
 * and hid every count. Each option names both numbers it has
 * ("7,814 properties · 3,740 eligible"), and an empty list says why.
 */
import { useState } from 'react'
import { Icon } from '../../shared/icons'
import { describeOptionCounts, pickerSummary, toggleOptionValue, type FieldOptionValue, type FieldValuesState } from './field-option-values'

const DEFAULT_EMPTY_MESSAGE = 'Values for this field haven’t been counted for the campaign audience yet. You can still type a value.'

export interface FieldValuePickerProps {
  fieldLabel: string
  options: FieldOptionValue[]
  selected: string[]
  loading?: boolean
  state?: FieldValuesState
  message?: string | null
  search: string
  onSearch: (search: string) => void
  onChange: (next: string[]) => void
  onRetry?: () => void
  format: (n: number) => string
}

export function FieldValuePicker({
  fieldLabel,
  options,
  selected,
  loading = false,
  state,
  message,
  search,
  onSearch,
  onChange,
  onRetry,
  format,
}: FieldValuePickerProps) {
  const [typed, setTyped] = useState('')
  const listed = new Set(options.map((option) => option.value))
  // A value chosen earlier (or typed) that the current list doesn't show stays
  // visible and removable.
  const unlisted = selected.filter((value) => !listed.has(value)).map((value) => ({ value, label: value }) as FieldOptionValue)
  const rows = [...unlisted, ...options]
  const canType = !loading && options.length === 0 && state !== 'unavailable'
  const summary = pickerSummary(options, selected, format)
  const addTyped = () => {
    const value = typed.trim()
    if (!value) return
    if (!selected.includes(value)) onChange([...selected, value])
    setTyped('')
  }

  return (
    <div className="cmp-filter-value-cell">
      <div className="cmp-option-search">
        <Icon name="search" size={12} />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search values"
          aria-label={`Search ${fieldLabel} values`}
        />
        {loading && <span className="cmp-option-state">Loading</span>}
      </div>
      {summary && <div className="cmp-option-summary" aria-live="polite">{summary}</div>}
      <div className="cmp-option-list" role="group" aria-label={`${fieldLabel} values`}>
        {loading && options.length === 0 && <div className="cmp-option-empty">Loading values…</div>}
        {!loading && options.length === 0 && (
          <div className={`cmp-option-empty${state === 'unavailable' ? ' is-error' : ''}`} role="status">
            {message || DEFAULT_EMPTY_MESSAGE}
            {state === 'unavailable' && onRetry && (
              <button type="button" className="cmp-option-retry" onClick={onRetry}>Retry</button>
            )}
          </div>
        )}
        {rows.map((option) => {
          const checked = selected.includes(option.value)
          const counts = describeOptionCounts(option, format)
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={checked}
              className={`cmp-option-item${checked ? ' is-checked' : ''}`}
              onClick={() => onChange(toggleOptionValue(selected, option.value))}
            >
              <span className="cmp-option-check" aria-hidden="true">{checked && <Icon name="check" size={11} />}</span>
              <span className="cmp-option-label">{option.label}</span>
              {counts && <span className="cmp-option-counts">{counts}</span>}
            </button>
          )
        })}
      </div>
      {canType && (
        <div className="cmp-option-typed">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTyped()
              }
            }}
            placeholder="Type an exact value"
            aria-label={`Type a ${fieldLabel} value`}
          />
          <button type="button" onClick={addTyped} disabled={!typed.trim()}>Add</button>
        </div>
      )}
    </div>
  )
}
