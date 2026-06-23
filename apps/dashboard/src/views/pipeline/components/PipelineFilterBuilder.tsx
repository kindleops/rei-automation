import { useState } from 'react'
import type { PipelineFilterClause, PipelineFilterGroup } from '../../../domain/pipeline/pipeline-card-design.types'
import { getFilterableFields } from '../../../domain/pipeline/pipeline-display-field-registry'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface PipelineFilterBuilderProps {
  filters: PipelineFilterGroup
  onChange: (filters: PipelineFilterGroup) => void
}

function isClause(item: PipelineFilterClause | PipelineFilterGroup): item is PipelineFilterClause {
  return 'field' in item && !('clauses' in item)
}

export function PipelineFilterBuilder({ filters, onChange }: PipelineFilterBuilderProps) {
  const [open, setOpen] = useState(false)
  const filterable = getFilterableFields()
  const clauses = filters.clauses.filter(isClause)

  const addClause = () => {
    const field = filterable[0]
    if (!field) return
    onChange({
      ...filters,
      clauses: [...filters.clauses, { field: field.key, operator: field.operators[0] ?? 'equals', value: '' }],
    })
  }

  const updateClause = (index: number, patch: Partial<PipelineFilterClause>) => {
    const next = [...filters.clauses]
    const current = next[index]
    if (!current || !isClause(current)) return
    next[index] = { ...current, ...patch }
    onChange({ ...filters, clauses: next })
  }

  const removeClause = (index: number) => {
    onChange({ ...filters, clauses: filters.clauses.filter((_, i) => i !== index) })
  }

  const toggleLogic = () => {
    onChange({ ...filters, logic: filters.logic === 'and' ? 'or' : 'and' })
  }

  return (
    <div className="plv-filter-builder">
      <button type="button" className={cls('plv-filter-chip', clauses.length > 0 && 'is-active')} onClick={() => setOpen((v) => !v)}>
        Filters{clauses.length > 0 ? ` (${clauses.length})` : ''}
      </button>
      {clauses.length > 0 && (
        <div className="plv-filter-chips">
          {clauses.map((c, i) => {
            const field = filterable.find((f) => f.key === c.field)
            return (
              <span key={i} className="plv-filter-active-chip nx-glass-menu">
                {field?.label ?? c.field} {c.operator} {String(c.value ?? '')}
                <button type="button" onClick={() => removeClause(i)} aria-label="Remove filter">×</button>
              </span>
            )
          })}
        </div>
      )}
      {open && (
        <div className="plv-filter-builder__panel nx-glass-menu" role="dialog" aria-label="Filter builder">
          <header className="plv-filter-builder__header">
            <strong>Filter Builder</strong>
            <button type="button" className="plv-glass-toggle" onClick={toggleLogic}>
              Match {filters.logic.toUpperCase()}
            </button>
          </header>
          {clauses.map((clause, index) => {
            const field = filterable.find((f) => f.key === clause.field) ?? filterable[0]
            return (
              <div key={index} className="plv-filter-builder__row">
                <button
                  type="button"
                  className="plv-glass-select"
                  onClick={() => {
                    const idx = filterable.findIndex((f) => f.key === clause.field)
                    const next = filterable[(idx + 1) % filterable.length]
                    updateClause(index, { field: next.key, operator: next.operators[0] })
                  }}
                >
                  {field?.label}
                </button>
                <button
                  type="button"
                  className="plv-glass-select"
                  onClick={() => {
                    const ops = field?.operators ?? ['equals']
                    const opIdx = ops.indexOf(clause.operator)
                    updateClause(index, { operator: ops[(opIdx + 1) % ops.length] })
                  }}
                >
                  {clause.operator}
                </button>
                {!['is_known', 'is_unknown', 'overdue', 'today'].includes(clause.operator) && (
                  <input
                    className="plv-glass-input"
                    value={String(clause.value ?? '')}
                    onChange={(e) => updateClause(index, { value: e.target.value })}
                    placeholder="Value"
                  />
                )}
                <button type="button" className="plv-glass-btn plv-glass-btn--ghost" onClick={() => removeClause(index)}>×</button>
              </div>
            )
          })}
          <footer className="plv-filter-builder__footer">
            <button type="button" className="plv-glass-btn" onClick={addClause}>Add condition</button>
            <button type="button" className="plv-glass-btn plv-glass-btn--primary" onClick={() => setOpen(false)}>Apply</button>
          </footer>
        </div>
      )}
    </div>
  )
}