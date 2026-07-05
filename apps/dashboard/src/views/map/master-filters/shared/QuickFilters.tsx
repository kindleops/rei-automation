import { useEffect, useState } from 'react'

import { fetchMapFilterPresets } from '../api'
import { useMasterFilters } from '../MasterFiltersProvider'
import { cloneExpression } from '../expression-utils'
import type { MapFilterPreset } from '../types'
import { cls } from '../utils'

export function QuickFilters() {
  const { selectedEntity, setDraftExpression } = useMasterFilters()
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

  const entityPresets = presets.filter((p) => {
    if (p.entity === selectedEntity) return true
    if (selectedEntity === 'master_owner' && p.entity === 'owner') return true
    return false
  })

  if (loading) {
    return <div className="mf-quick-filters mf-quick-filters--loading">Loading presets…</div>
  }

  if (error) {
    return <div className="mf-quick-filters mf-quick-filters--error">{error}</div>
  }

  if (entityPresets.length === 0) {
    return <div className="mf-quick-filters mf-quick-filters--empty">No quick filters for this entity.</div>
  }

  return (
    <div className="mf-quick-filters">
      <h4 className="mf-quick-filters__heading">Quick filters</h4>
      <div className="mf-quick-filters__chips">
        {entityPresets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className={cls('mf-chip')}
            title={preset.description}
            onClick={() => setDraftExpression(cloneExpression(preset.expression))}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}