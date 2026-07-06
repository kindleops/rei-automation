import { useEffect, useMemo, useState } from 'react'

import { fetchMapFilterPresets } from '../api'
import { CANONICAL_QUICK_FILTER_KEYS } from '../constants'
import { useMasterFilters } from '../MasterFiltersProvider'
import { cloneExpression } from '../expression-utils'
import type { MapFilterPreset } from '../types'
export function QuickFilters() {
  const { setDraftExpression } = useMasterFilters()
  const [presets, setPresets] = useState<MapFilterPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const result = await fetchMapFilterPresets()
      if (cancelled) return
      setLoading(false)
      if (!result.ok) {
        setError(result.message || result.error)
        return
      }
      setPresets(result.data.presets)
    })()
    return () => { cancelled = true }
  }, [])

  const ordered = useMemo(() => {
    const byKey = new Map(presets.map((p) => [p.key, p]))
    return CANONICAL_QUICK_FILTER_KEYS
      .map((key) => byKey.get(key))
      .filter(Boolean) as MapFilterPreset[]
  }, [presets])

  if (loading) return <div className="mf-quick">Loading quick filters…</div>
  if (error) return <div className="mf-quick mf-quick--error">{error}</div>

  return (
    <section className="mf-quick">
      <h4 className="mf-quick__title">Quick filters</h4>
      <div className="mf-quick__list">
        {ordered.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="mf-quick__row"
            title={preset.description}
            onClick={() => setDraftExpression(cloneExpression(preset.expression))}
          >
            <span className="mf-quick__row-label">{preset.label}</span>
            <span className="mf-quick__row-desc">{preset.description}</span>
          </button>
        ))}
      </div>
    </section>
  )
}