import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  baselinePropertyCount,
  buildMapFilterChips,
  buildMapFilterExpression,
  clearAllMapFilters,
  countActiveMapFilters,
  DEFAULT_MAP_ADVANCED_FILTERS,
  MAP_FILTER_FIELD_SPECS,
  MAP_FILTER_GROUPS,
  type MapAdvancedFilters,
  type MapFilterFieldSpec,
  type MapFilterGroupId,
  type TriValue,
} from '../../../domain/map/map-advanced-filter-engine'
import { Icon } from '../../../shared/icons'
import { createMapFilterToken, previewMapFilter, saveMapFilterStack } from '../master-filters/api'
import type { MapFilterBounds } from '../master-filters/types'
import { countActiveRules } from '../master-filters/expression-utils'
import '../../../modules/inbox/inbox-polish.css'
import '../map-advanced-filters.css'

export interface MapAdvancedFiltersModalProps {
  open: boolean
  bounds?: MapFilterBounds | null
  onClose: () => void
  onApply: (payload: {
    token: string | null
    activeRuleCount: number
    matchingProperties: number
  }) => void
  onClear: () => void
}

const num = (v: number | undefined) => (v === undefined ? '' : String(v))
const asNum = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() && Number.isFinite(n) ? n : undefined
}

export function MapAdvancedFiltersModal({
  open,
  bounds = null,
  onClose,
  onApply,
  onClear,
}: MapAdvancedFiltersModalProps) {
  const [activeGroup, setActiveGroup] = useState<MapFilterGroupId>('map_status')
  const [local, setLocal] = useState<MapAdvancedFilters>(DEFAULT_MAP_ADVANCED_FILTERS)
  const [search, setSearch] = useState('')
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [applying, setApplying] = useState(false)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    setLocal(DEFAULT_MAP_ADVANCED_FILTERS)
    setSearch('')
    setPreviewError(null)
    setActiveGroup('map_status')
  }, [open])

  const expression = useMemo(() => buildMapFilterExpression(local), [local])
  const activeCount = useMemo(() => countActiveMapFilters(local), [local])
  const chips = useMemo(() => buildMapFilterChips(local), [local])
  const hasActiveFilters = activeCount > 0

  useEffect(() => {
    if (!open) return
    if (previewTimer.current) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      setPreviewLoading(true)
      setPreviewError(null)
      void previewMapFilter(expression, bounds)
        .then((result) => {
          if (!result.ok) {
            setPreviewError(result.message || result.error)
            setPreviewCount(null)
            return
          }
          setPreviewCount(result.data.counts.matchingProperties)
        })
        .catch(() => {
          setPreviewError('Unable to calculate matching properties')
          setPreviewCount(null)
        })
        .finally(() => setPreviewLoading(false))
    }, 350)
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current) }
  }, [open, expression, bounds])

  const patch = useCallback((p: Partial<MapAdvancedFilters>) => {
    setLocal((current) => ({ ...current, ...p }))
  }, [])

  const headerCountLabel = useMemo(() => {
    if (previewLoading) return 'Updating matching properties…'
    if (previewError && hasActiveFilters) return 'Unable to calculate matching properties'
    if (previewCount != null) return `${previewCount.toLocaleString()} matching properties`
    if (!hasActiveFilters) return `${baselinePropertyCount().toLocaleString()} matching properties`
    return '—'
  }, [hasActiveFilters, previewCount, previewError, previewLoading])

  const canApply = !applying && !previewLoading && (!hasActiveFilters || (previewCount != null && !previewError))

  const handleClearAll = useCallback(() => {
    const fresh = clearAllMapFilters()
    setLocal(fresh)
    onClear()
  }, [onClear])

  const handleApply = useCallback(async () => {
    if (!canApply) return
    setApplying(true)
    try {
      if (!hasActiveFilters) {
        onApply({ token: null, activeRuleCount: 0, matchingProperties: baselinePropertyCount() })
        onClose()
        return
      }
      const tokenResult = await createMapFilterToken(expression)
      if (!tokenResult.ok) {
        setPreviewError(tokenResult.message || tokenResult.error)
        return
      }
      onApply({
        token: tokenResult.data.filterToken,
        activeRuleCount: countActiveRules(expression),
        matchingProperties: previewCount ?? baselinePropertyCount(),
      })
      onClose()
    } finally {
      setApplying(false)
    }
  }, [canApply, expression, hasActiveFilters, onApply, onClose, previewCount])

  const handleSave = useCallback(async () => {
    if (!saveName.trim() || previewCount == null) return
    await saveMapFilterStack({
      name: saveName.trim(),
      expression,
      lastKnownPropertyCount: previewCount,
    })
    setSaveName('')
    setSaveOpen(false)
  }, [expression, previewCount, saveName])

  const groupFields = useMemo(() => {
    const q = search.trim().toLowerCase()
    return MAP_FILTER_FIELD_SPECS.filter((field) => {
      if (field.group !== activeGroup) return false
      if (!q) return true
      return field.label.toLowerCase().includes(q)
    })
  }, [activeGroup, search])

  const renderField = (field: MapFilterFieldSpec, index: number) => {
    const fieldKey = `${field.group}-${field.id}-${index}`

    if (field.kind === 'mapStatus' || field.kind === 'select') {
      const key = field.id
      const value = (local[key] as string) ?? ''
      return (
        <label key={fieldKey} className="nx-ifm-field">
          <span>{field.label}</span>
          <select value={value} onChange={(e) => patch({ [key]: e.target.value } as Partial<MapAdvancedFilters>)}>
            {field.kind !== 'mapStatus' ? <option value="">Any</option> : null}
            {(field.options ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      )
    }

    if (field.kind === 'numberRange') {
      const minKey = field.minKey!
      const maxKey = field.maxKey
      return (
        <label key={fieldKey} className="nx-ifm-field">
          <span>{field.label}</span>
          <div className="nx-ifm-range">
            <input
              type="number"
              placeholder="Min"
              value={num(local[minKey] as number | undefined)}
              onChange={(e) => patch({ [minKey]: asNum(e.target.value) } as Partial<MapAdvancedFilters>)}
            />
            {maxKey ? (
              <>
                <span>–</span>
                <input
                  type="number"
                  placeholder="Max"
                  value={num(local[maxKey] as number | undefined)}
                  onChange={(e) => patch({ [maxKey]: asNum(e.target.value) } as Partial<MapAdvancedFilters>)}
                />
              </>
            ) : null}
          </div>
        </label>
      )
    }

    if (field.kind === 'tri') {
      const key = field.id
      const value = (local[key] as TriValue) ?? ''
      return (
        <label key={fieldKey} className="nx-ifm-field">
          <span>{field.label}</span>
          <select value={value} onChange={(e) => patch({ [key]: e.target.value as TriValue } as Partial<MapAdvancedFilters>)}>
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      )
    }

    return null
  }

  if (!open) return null

  const applyLabel = applying
    ? 'Applying…'
    : previewLoading && hasActiveFilters
      ? 'Refreshing…'
      : previewCount != null && hasActiveFilters
        ? `Apply · ${previewCount.toLocaleString()} Properties`
        : 'Apply'

  return createPortal(
    <div className="nx-ifm-overlay nx-ifm-overlay--map" role="presentation" onMouseDown={onClose}>
      <section
        className="nx-ifm-modal nx-ifm-modal--map"
        role="dialog"
        aria-modal="true"
        aria-label="Advanced Map Filters"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="nx-ifm-liquid-edge" aria-hidden="true" />

        <header className="nx-ifm-header">
          <div>
            <strong>Advanced Filters</strong>
            <span className={previewError && hasActiveFilters ? 'is-error' : undefined}>{headerCountLabel}</span>
          </div>
          <div className="nx-ifm-header-actions">
            {activeCount > 0 && <span className="nx-ifm-badge">{activeCount}</span>}
            <button type="button" className="nx-ifm-close" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="nx-ifm-body">
          <nav className="nx-ifm-rail">
            {MAP_FILTER_GROUPS.map((group) => (
              <button
                key={group.id}
                type="button"
                className={`nx-ifm-rail-item${activeGroup === group.id ? ' is-active' : ''}`}
                onClick={() => setActiveGroup(group.id)}
              >
                <span className="nx-ifm-rail-icon">{group.icon}</span>
                <span>{group.label}</span>
              </button>
            ))}
          </nav>

          <div className="nx-ifm-main">
            <div className="nx-ifm-search">
              <svg className="nx-ifm-search-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
              <input
                type="text"
                className="nx-ifm-search-input"
                placeholder="Search filters in this group…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="nx-ifm-fields">{groupFields.map(renderField)}</div>
          </div>

          <aside className="nx-ifm-active">
            <h4>Active Filters</h4>
            {chips.length === 0 ? (
              <p className="nx-ifm-empty">No filters applied</p>
            ) : (
              <div className="nx-ifm-chips">
                {chips.map((chip) => (
                  <span key={chip.key} className="nx-ifm-chip">
                    {chip.label}
                    <button
                      type="button"
                      onClick={() => setLocal(chip.clear(local))}
                      aria-label={`Remove ${chip.label}`}
                    >
                      <Icon name="x" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </aside>
        </div>

        <footer className="nx-ifm-footer">
          <button type="button" className="nx-ifm-btn-ghost" onClick={handleClearAll}>Clear All</button>
          <div className="nx-ifm-footer-right">
            {saveOpen ? (
              <>
                <input
                  className="nx-ifm-save-input"
                  value={saveName}
                  placeholder="View name…"
                  onChange={(e) => setSaveName(e.target.value)}
                  autoFocus
                />
                <button type="button" className="nx-ifm-btn-secondary" onClick={() => void handleSave()} disabled={!saveName.trim()}>
                  Save
                </button>
                <button type="button" className="nx-ifm-btn-ghost" onClick={() => setSaveOpen(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="nx-ifm-btn-secondary" onClick={() => setSaveOpen(true)} disabled={!hasActiveFilters || previewCount == null}>
                Save View
              </button>
            )}
            <button type="button" className="nx-ifm-btn-primary" onClick={() => void handleApply()} disabled={!canApply}>
              {applyLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  )
}