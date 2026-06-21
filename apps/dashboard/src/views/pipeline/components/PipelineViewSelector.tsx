import { useEffect, useRef, useState } from 'react'
import type { PipelineGroupByMode } from '../../../domain/pipeline/pipeline-opportunity.types'
import { PIPELINE_VIEW_OPTIONS, savePipelineGroupBy } from '../../../domain/pipeline/pipeline-display-helpers'

interface PipelineViewSelectorProps {
  value: PipelineGroupByMode
  onChange: (value: PipelineGroupByMode) => void
  compact?: boolean
}

export function PipelineViewSelector({ value, onChange, compact }: PipelineViewSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = PIPELINE_VIEW_OPTIONS.find((o) => o.value === value) ?? PIPELINE_VIEW_OPTIONS[0]

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (mode: PipelineGroupByMode) => {
    onChange(mode)
    savePipelineGroupBy(mode)
    setOpen(false)
  }

  return (
    <div className="plv-view-selector" ref={rootRef}>
      <button
        type="button"
        className="plv-view-selector__trigger nx-glass-menu"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="plv-view-selector__label">{compact ? 'View' : 'Group By'}</span>
        <strong>{selected.label}</strong>
        <span className="plv-view-selector__caret">▾</span>
      </button>
      {open && (
        <div className="plv-view-selector__menu nx-glass-menu" role="listbox">
          {PIPELINE_VIEW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`plv-view-selector__option${option.value === value ? ' is-active' : ''}`}
              onClick={() => pick(option.value)}
            >
              <span>{option.label}</span>
              {option.hint && <small>{option.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}