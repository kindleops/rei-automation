import { useState } from 'react'
import type { PipelineSortSpec } from '../../../domain/pipeline/pipeline-card-design.types'
import { getSortableFields } from '../../../domain/pipeline/pipeline-display-field-registry'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface PipelineSortBuilderProps {
  sorts: PipelineSortSpec[]
  onChange: (sorts: PipelineSortSpec[]) => void
  onClose?: () => void
}

const DEFAULT_SORT: PipelineSortSpec = { field: 'last_activity_at', direction: 'desc', nulls: 'last' }

export function PipelineSortBuilder({ sorts, onChange, onClose }: PipelineSortBuilderProps) {
  const [open, setOpen] = useState(false)
  const sortable = getSortableFields()
  const active = sorts.length > 0 ? sorts : [DEFAULT_SORT]

  const updateSort = (index: number, patch: Partial<PipelineSortSpec>) => {
    const next = active.map((s, i) => (i === index ? { ...s, ...patch } : s))
    onChange(next)
  }

  const addSort = () => {
    if (active.length >= 3) return
    onChange([...active, { field: 'stage_age', direction: 'desc', nulls: 'last' }])
  }

  const removeSort = (index: number) => {
    const next = active.filter((_, i) => i !== index)
    onChange(next.length > 0 ? next : [DEFAULT_SORT])
  }

  const label = active.map((s) => {
    const f = sortable.find((x) => x.key === s.field)
    return `${f?.label ?? s.field} ${s.direction === 'asc' ? '↑' : '↓'}`
  }).join(', ')

  return (
    <div className="plv-sort-builder">
      <button
        type="button"
        className="plv-filter-chip nx-glass-menu"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Sort: {label}
      </button>
      {open && (
        <div className="plv-sort-builder__panel nx-glass-menu" role="dialog" aria-label="Sort builder">
          <header className="plv-sort-builder__header">
            <strong>Sort Builder</strong>
            <button type="button" className="plv-sort-builder__close" onClick={() => { setOpen(false); onClose?.() }}>×</button>
          </header>
          {active.map((sort, index) => (
            <div key={index} className="plv-sort-builder__row">
              <span className="plv-sort-builder__level">{index === 0 ? 'Primary' : index === 1 ? 'Secondary' : 'Tertiary'}</span>
              <div className="plv-sort-builder__selects">
                <button
                  type="button"
                  className="plv-glass-select"
                  onClick={() => {
                    const idx = sortable.findIndex((f) => f.key === sort.field)
                    const next = sortable[(idx + 1) % sortable.length]
                    updateSort(index, { field: next.key })
                  }}
                >
                  {sortable.find((f) => f.key === sort.field)?.label ?? sort.field}
                </button>
                <button
                  type="button"
                  className={cls('plv-glass-toggle', sort.direction === 'asc' && 'is-active')}
                  onClick={() => updateSort(index, { direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
                >
                  {sort.direction === 'asc' ? 'Ascending' : 'Descending'}
                </button>
                <button
                  type="button"
                  className={cls('plv-glass-toggle', sort.nulls === 'first' && 'is-active')}
                  onClick={() => updateSort(index, { nulls: sort.nulls === 'first' ? 'last' : 'first' })}
                >
                  Nulls {sort.nulls === 'first' ? 'first' : 'last'}
                </button>
                {index > 0 && (
                  <button type="button" className="plv-glass-btn plv-glass-btn--ghost" onClick={() => removeSort(index)}>Remove</button>
                )}
              </div>
            </div>
          ))}
          <footer className="plv-sort-builder__footer">
            {active.length < 3 && (
              <button type="button" className="plv-glass-btn" onClick={addSort}>Add sort level</button>
            )}
            <button type="button" className="plv-glass-btn plv-glass-btn--ghost" onClick={() => onChange([DEFAULT_SORT])}>Reset</button>
            <button type="button" className="plv-glass-btn plv-glass-btn--primary" onClick={() => setOpen(false)}>Apply</button>
          </footer>
        </div>
      )}
    </div>
  )
}