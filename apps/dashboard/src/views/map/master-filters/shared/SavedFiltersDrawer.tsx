import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  deleteMapFilterSaved,
  fetchMapFilterSavedFilters,
  saveMapFilterStack,
  updateMapFilterSaved,
} from '../api'
import { useMasterFilters } from '../MasterFiltersProvider'
import type { MapFilterSavedFilter } from '../types'
import { cls, fmtCount } from '../utils'

export interface SavedFiltersDrawerProps {
  onClose: () => void
}

export function SavedFiltersDrawer({ onClose }: SavedFiltersDrawerProps) {
  const {
    draftExpression,
    setDraftExpression,
    previewCounts,
    activeRuleCount,
    applyFilters,
  } = useMasterFilters()

  const [savedFilters, setSavedFilters] = useState<MapFilterSavedFilter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await fetchMapFilterSavedFilters()
    setLoading(false)
    if (!result.ok) {
      setError(result.message || result.error)
      return
    }
    setSavedFilters(result.data.savedFilters)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return savedFilters
    return savedFilters.filter((item) =>
      [item.name, item.description, item.summary].join(' ').toLowerCase().includes(q),
    )
  }, [savedFilters, search])

  const sections = useMemo(() => ({
    favorites: filtered.filter((f) => f.isFavorite),
    recent: filtered.filter((f) => f.lastUsedAt).sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt))).slice(0, 8),
    mine: filtered.filter((f) => !f.isSystem && f.scope === 'personal'),
    team: filtered.filter((f) => !f.isSystem && f.scope === 'organization'),
    system: filtered.filter((f) => f.isSystem),
  }), [filtered])

  const applySaved = async (item: MapFilterSavedFilter) => {
    setDraftExpression(structuredClone(item.expression))
    await updateMapFilterSaved(item.id, { action: 'record_use' })
    onClose()
    void applyFilters()
  }

  const renderList = (title: string, items: MapFilterSavedFilter[]) => {
    if (!items.length) return null
    return (
      <section className="mf-saved__section">
        <h4>{title}</h4>
        <ul className="mf-saved__list">
          {items.map((item) => (
            <li key={item.id} className="mf-saved__item">
              <button type="button" className="mf-saved__item-main" onClick={() => void applySaved(item)}>
                <strong>{item.name}</strong>
                <span>{item.summary || `${item.activeRuleCount} rules`}</span>
                {item.lastKnownPropertyCount != null ? <span>{fmtCount(item.lastKnownPropertyCount)} properties</span> : null}
              </button>
              <div className="mf-saved__item-actions">
                <button type="button" className="mf-icon-btn" aria-label="Favorite" onClick={() => void updateMapFilterSaved(item.id, { isFavorite: !item.isFavorite }).then(refresh)}>★</button>
                <button type="button" className="mf-icon-btn" aria-label="Duplicate" onClick={() => void updateMapFilterSaved(item.id, { action: 'duplicate' }).then(refresh)}>⧉</button>
                <button type="button" className="mf-icon-btn" aria-label="Rename" onClick={() => {
                  const next = window.prompt('Rename saved filter', item.name)
                  if (!next?.trim()) return
                  void updateMapFilterSaved(item.id, { name: next.trim() }).then(refresh)
                }}>✎</button>
                {!item.isSystem ? (
                  <button type="button" className="mf-icon-btn mf-icon-btn--danger" aria-label="Delete" onClick={() => void deleteMapFilterSaved(item.id).then(refresh)}>×</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="mf-saved-drawer" role="dialog" aria-label="Saved filters">
      <div className="mf-saved-drawer__backdrop" onClick={onClose} />
      <div className="mf-saved-drawer__panel">
        <header className="mf-saved-drawer__header">
          <h3>Saved Filters</h3>
          <button type="button" className="mf-icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <input className="mf-input" type="search" placeholder="Search saved filters…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {loading ? <p className="mf-muted">Loading library…</p> : null}
        {error ? <p className="mf-pane__error">{error}</p> : null}
        <div className="mf-saved-drawer__body">
          {renderList('Favorites', sections.favorites)}
          {renderList('Recent', sections.recent)}
          {renderList('My Filters', sections.mine)}
          {renderList('Team Filters', sections.team)}
          {renderList('System Presets', sections.system)}
        </div>
        <footer className="mf-saved-drawer__footer">
          <input className="mf-input" type="text" placeholder="Name for current stack" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <button
            type="button"
            className={cls('mf-btn mf-btn--primary', (activeRuleCount === 0 || saving) && 'is-disabled')}
            disabled={activeRuleCount === 0 || saving}
            onClick={async () => {
              if (activeRuleCount === 0) return
              setSaving(true)
              await saveMapFilterStack({
                name: saveName.trim() || `Filter stack · ${new Date().toLocaleDateString()}`,
                expression: draftExpression,
                lastKnownPropertyCount: previewCounts?.matchingProperties ?? null,
              })
              setSaving(false)
              setSaveName('')
              await refresh()
            }}
          >
            Save current stack
          </button>
        </footer>
      </div>
    </div>
  )
}