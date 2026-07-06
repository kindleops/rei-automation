import { useMemo } from 'react'

import type { MapFilterRegistryField } from '../types'
import { cls } from '../utils'

export interface RuleValueControlProps {
  field: MapFilterRegistryField | null
  operator: string
  value: unknown
  onChange: (value: unknown) => void
  onOperatorChange?: (operator: string) => void
  disabled?: boolean
}

function isNoValueOperator(operator: string): boolean {
  return [
    'is_blank', 'is_not_blank', 'is_empty', 'is_not_empty',
    'has_data', 'has_no_data', 'is_true', 'is_false', 'is_unknown',
  ].includes(operator)
}

function isBetweenOperator(operator: string): boolean {
  return operator === 'between' || operator === 'outside_range'
}

export function RuleValueControl({
  field,
  operator,
  value,
  onChange,
  onOperatorChange,
  disabled = false,
}: RuleValueControlProps) {
  const controlKind = useMemo(() => {
    if (!field || isNoValueOperator(operator)) return 'none'
    if (field.dataType === 'boolean' || field.valueSource === 'boolean') return 'boolean'
    if (isBetweenOperator(operator)) return 'between'
    if (field.dataType === 'number') return 'number'
    return 'text'
  }, [field, operator])

  if (controlKind === 'none') {
    return <span className="mf-muted">No value required</span>
  }

  if (controlKind === 'boolean') {
    const tri = operator === 'is_false' ? 'no' : operator === 'is_unknown' ? 'either' : 'yes'
    return (
      <div className="mf-segmented mf-segmented--compact" role="group" aria-label="Boolean value">
        {(['yes', 'no', 'either'] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            className={cls('mf-segmented__btn', tri === opt && 'is-active')}
            disabled={disabled}
            onClick={() => {
              const op = opt === 'yes' ? 'is_true' : opt === 'no' ? 'is_false' : 'is_unknown'
              onOperatorChange?.(op)
              onChange(null)
            }}
          >
            {opt === 'yes' ? 'Yes' : opt === 'no' ? 'No' : 'Either'}
          </button>
        ))}
      </div>
    )
  }

  if (controlKind === 'between') {
    const pair = Array.isArray(value) ? value : ['', '']
    return (
      <div className="mf-between">
        <input className="mf-input" type="number" value={String(pair[0] ?? '')} disabled={disabled} placeholder="Min" onChange={(e) => onChange([e.target.value, pair[1]])} />
        <span>to</span>
        <input className="mf-input" type="number" value={String(pair[1] ?? '')} disabled={disabled} placeholder="Max" onChange={(e) => onChange([pair[0], e.target.value])} />
      </div>
    )
  }

  if (controlKind === 'number') {
    return (
      <input
        className="mf-input"
        type="number"
        value={value == null ? '' : String(value)}
        disabled={disabled}
        placeholder="Enter value"
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }

  return (
    <input
      className="mf-input"
      type="text"
      value={value == null ? '' : String(value)}
      disabled={disabled}
      placeholder="Enter value"
      onChange={(e) => onChange(e.target.value)}
    />
  )
}