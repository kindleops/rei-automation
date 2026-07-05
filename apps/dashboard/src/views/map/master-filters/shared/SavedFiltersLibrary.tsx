import { useCallback, useEffect, useState } from 'react'

import {
  deleteMapFilterSaved,
  fetchMapFilterSavedFilters,
  saveMapFilterStack,
  updateMapFilterSaved,
} from '../api'
import { useMasterFilters } from '../MasterFiltersProvider'
import type { MapFilterSavedFilter } from '../types'
import { cls, fmtCount } from '../utils'

export function SavedFiltersLibrary() {
  const {
    draftExpression,
    setDraftExpression,
    previewCounts,
    activeRuleCount,
    setShowSavedLibrary,
    applyFilters,
  } = useMasterFilters()

  const [savedFilters, setSavedFilters] = useState<MapFilterSavedFilter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSaveCurrent = async () => {
    if (activeRuleCount === 0) return
    setSaving(true)
    const result = await saveMapFilterStack({
      name: saveName.trim() || `Filter stack · ${new Date().toLocaleDateString()}`,
      expression: draftExpression,
      lastKnownPropertyCount: previewCounts?.matchingProperties ?? null,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.message || result.error)
      return
    }
    setSaveName('')
    await refresh()
  }

  const openSaved = async (item: MapFilterSavedFilter) => {
    setDraftExpression(structuredClone(item.expression))
    void updateMapFilterSaved(item.id, { action: 'record_use' })
    setShowSavedLibrary(false)
  }

  const toggleFavorite = async (item: MapFilterSavedFilter) => {
    await updateMapFilterSaved(item.id, { isFavorite: !item.isFavorite })
    await refresh()
  }

  const duplicateSaved = async (item: MapFilterSavedFilter) => {
    await updateMapFilterSaved(item.id, { action: 'duplicate' })
    await refresh()
  }

  const renameSaved = async (item: MapFilterSavedFilter) => {
    const next = window.prompt('Rename saved filter', item.name)
    if (!next?.trim()) return
    await updateMapFilterSaved(item.id, { name: next.trim() })
    await refresh()
  }

  const removeSaved = async (item: MapFilterSavedFilter) => {
    if (!window.confirm(`Delete "${item.name}"?`)) return
    await deleteMapFilterSaved(item.id)
    await refresh()
  }

  return (
    <section className="mf-saved-library">
      <header className="mf-saved-library__header">
        <h3>Saved Filters</h3>
        <button
          type="button"
          className="mf-icon-btn"
          aria-label="Close saved filters"
          onClick={() => setShowSavedLibrary(false)}
        >
          ×
        </button>
      </header>

      <div className="mf-saved-library__save-row">
        <input
          className="mf-input"
          type="text"
          placeholder="Name this filter stack…"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
        />
        <button
          type="button"
          className="mf-btn mf-btn--primary"
          disabled={activeRuleCount === 0 || saving}
          onClick={() => void handleSaveCurrent()}
        >
          {saving ? 'Saving…' : 'Save current stack'}
        </button>
      </div>

      {loading ? <p className="mf-pane__status">Loading saved filters…</p> : null}
      {error ? <p className="mf-pane__error">{error}</p> : null}

      {!loading && savedFilters.length === 0 ? (
        <div className="mf-empty-state mf-empty-state--centered">
          <p className="mf-empty-state__title">No saved filters yet</p>
          <p className="mf-empty-state__body">Build a stack, save it here, and reopen it anytime.</p>
        </div>
      ) : null}

      <ul className="mf-saved-library__list">
        {savedFilters.map((item) => (
          <li key={item.id} className={cls('mf-saved-card', item.isFavorite && 'is-favorite')}>
            <button type="button" className="mf-saved-card__main" onClick={() => void openSaved(item)}>
              <span className="mf-saved-card__name">{item.name}</span>
              <span className="mf-saved-card__summary">{item.summary || `${item.activeRuleCount} rules`}</span>
              <span className="mf-saved-card__meta">
                {fmtCount(item.lastKnownPropertyCount)} properties · used {item.useCount}×
              </span>
            </button>
            <div className="mf-saved-card__actions">
              <button type="button" className="mf-icon-btn" title="Favorite" onClick={() => void toggleFavorite(item)}>
                {item.isFavorite ? '★' : '☆'}
              </button>
              <button type="button" className="mf-icon-btn" title="Rename" onClick={() => void renameSaved(item)}>✎</button>
              <button type="button" className="mf-icon-btn" title="Duplicate" onClick={() => void duplicateSaved(item)}>⧉</button>
              <button type="button" className="mf-icon-btn" title="Apply to map" onClick={() => {
                void openSaved(item).then(() => void applyFilters())
              }}>▶</button>
              <button type="button" className="mf-icon-btn mf-icon-btn--danger" title="Delete" onClick={() => void removeSaved(item)}>🗑</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}