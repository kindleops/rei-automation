import { useCallback, useEffect, useRef, useState } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { fieldMatchesEntity } from '../entity-utils'
import type { MapFilterRegistryField } from '../types'
import { cls } from '../utils'

export interface FieldSearchProps {
  onSelectField: (field: MapFilterRegistryField) => void
}

export function FieldSearch({ onSelectField }: FieldSearchProps) {
  const { fields, selectedEntity, refreshRegistry, recordRecentField } = useMasterFilters()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [highlightIndex, setHighlightIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    void refreshRegistry(debouncedQuery)
  }, [debouncedQuery, refreshRegistry])

  const results = fields
    .filter((f) => fieldMatchesEntity(f, selectedEntity))
    .slice(0, 24)

  useEffect(() => {
    setHighlightIndex(0)
  }, [debouncedQuery, selectedEntity])

  const selectAt = useCallback((index: number) => {
    const field = results[index]
    if (!field) return
    recordRecentField(field.key)
    onSelectField(field)
    setQuery('')
    setDebouncedQuery('')
  }, [onSelectField, recordRecentField, results])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selectAt(highlightIndex)
    } else if (e.key === 'Escape') {
      setQuery('')
    }
  }

  return (
    <div className="mf-field-search">
      <label className="mf-field-search__label" htmlFor="mf-field-search-input">
        Search fields
      </label>
      <input
        ref={inputRef}
        id="mf-field-search-input"
        className="mf-input mf-field-search__input"
        type="search"
        value={query}
        placeholder="Search by name, category, or synonym…"
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {query.trim().length > 0 && results.length > 0 ? (
        <ul className="mf-field-search__results" role="listbox">
          {results.map((field, index) => (
            <li key={field.key}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlightIndex}
                className={cls('mf-field-search__result', index === highlightIndex && 'is-highlighted')}
                onMouseEnter={() => setHighlightIndex(index)}
                onClick={() => selectAt(index)}
              >
                <span className="mf-field-search__result-label">{field.label}</span>
                <span className="mf-field-search__result-meta">{field.category}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}