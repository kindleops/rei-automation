import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { fieldMatchesEntity, normalizeRegistryEntity } from '../entity-utils'
import type { MapFilterRegistryField } from '../types'
import { ENTITY_LABELS } from '../types'
import { cls } from '../utils'

export interface FieldSearchProps {
  onSelectField: (field: MapFilterRegistryField) => void
}

function fieldSearchHaystack(field: MapFilterRegistryField): string {
  return [
    field.label,
    field.key,
    field.description,
    field.category,
    field.entity,
    ...(field.synonyms ?? []),
  ].join(' ').toLowerCase()
}

export function FieldSearch({ onSelectField }: FieldSearchProps) {
  const { fields, selectedEntity, refreshRegistry, recordRecentField } = useMasterFilters()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [highlightIndex, setHighlightIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 280)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    void refreshRegistry(debouncedQuery)
  }, [debouncedQuery, refreshRegistry])

  const results = useMemo(() => {
    const q = debouncedQuery.toLowerCase()
    const pool = q
      ? fields.filter((f) => fieldSearchHaystack(f).includes(q))
      : fields.filter((f) => fieldMatchesEntity(f, selectedEntity))
    return pool.slice(0, 20)
  }, [debouncedQuery, fields, selectedEntity])

  useEffect(() => setHighlightIndex(0), [debouncedQuery, selectedEntity])

  const selectAt = useCallback((index: number) => {
    const field = results[index]
    if (!field) return
    recordRecentField(field.key)
    onSelectField(field)
    setQuery('')
    setDebouncedQuery('')
  }, [onSelectField, recordRecentField, results])

  return (
    <div className="mf-search">
      <label className="mf-search__label" htmlFor="mf-global-search">Global field search</label>
      <input
        ref={inputRef}
        id="mf-global-search"
        className="mf-input mf-search__input"
        type="search"
        value={query}
        placeholder="Search fields, aliases, categories…"
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0))) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIndex((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); selectAt(highlightIndex) }
          else if (e.key === 'Escape') setQuery('')
        }}
      />
      {results.length > 0 ? (
        <ul className="mf-search__results" role="listbox">
          {results.map((field, index) => {
            const entity = normalizeRegistryEntity(field.entity)
            return (
              <li key={field.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlightIndex}
                  className={cls('mf-search__result', index === highlightIndex && 'is-highlighted')}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onClick={() => selectAt(index)}
                >
                  <span className="mf-search__result-main">
                    <strong>{field.label}</strong>
                    <span className="mf-search__result-entity">{entity ? ENTITY_LABELS[entity] : field.entity}</span>
                  </span>
                  <span className="mf-search__result-desc">{field.category} · {field.description}</span>
                  <span className="mf-search__result-add">Add</span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : debouncedQuery ? <p className="mf-muted mf-search__empty">No fields match this search.</p> : null}
    </div>
  )
}