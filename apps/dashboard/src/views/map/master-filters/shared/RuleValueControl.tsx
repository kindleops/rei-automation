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
    'is_blank',
    'is_not_blank',
    'is_empty',
    'is_not_empty',
    'has_data',
    'has_no_data',
    'is_true',
    'is_false',
    'is_unknown',
  ].includes(operator)
}

function isPercentField(field: MapFilterRegistryField | null): boolean {
  if (!field) return false
  return /percent|pct|_rate/i.test(field.key) || /%|percent/i.test(field.label)
}

function isCurrencyField(field: MapFilterRegistryField | null): boolean {
  if (!field) return false
  return /price|value|equity|amount|balance|rent|income|cost|worth/i.test(field.key)
}

function isEnumField(field: MapFilterRegistryField | null): boolean {
  return field?.valueSource === 'distinct'
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
    if (field.dataType === 'date' || field.dataType === 'timestamp') return 'date'
    if (isBetweenOperator(operator)) return 'between'
    if (field.dataType === 'number') {
      if (isPercentField(field)) return 'percent'
      if (isCurrencyField(field)) return 'currency'
      return 'number'
    }
    if (isEnumField(field) && ['is_any_of', 'is_none_of', 'equals', 'not_equals'].includes(operator)) {
      return 'enum'
    }
    return 'text'
  }, [field, operator])

  if (controlKind === 'none') {
    return <span className="mf-rule-value__hint">No value required</span>
  }

  if (controlKind === 'boolean') {
    const tri = operator === 'is_false' ? 'no' : operator === 'is_unknown' ? 'either' : 'yes'
    return (
      <div className="mf-segmented" role="group" aria-label="Boolean value">
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
      <div className="mf-rule-value__between">
        <input
          className="mf-input"
          type="number"
          value={String(pair[0] ?? '')}
          disabled={disabled}
          placeholder="Min"
          onChange={(e) => onChange([e.target.value, pair[1]])}
        />
        <span className="mf-rule-value__sep">to</span>
        <input
          className="mf-input"
          type="number"
          value={String(pair[1] ?? '')}
          disabled={disabled}
          placeholder="Max"
          onChange={(e) => onChange([pair[0], e.target.value])}
        />
      </div>
    )
  }

  if (controlKind === 'number' || controlKind === 'currency' || controlKind === 'percent') {
    const inputType = 'number'
    const prefix = controlKind === 'currency' ? '$' : controlKind === 'percent' ? '%' : null
    return (
      <div className="mf-rule-value__affix">
        {prefix ? <span className="mf-rule-value__prefix">{prefix}</span> : null}
        <input
          className="mf-input"
          type={inputType}
          value={value == null ? '' : String(value)}
          disabled={disabled}
          placeholder={controlKind === 'percent' ? '0–100' : 'Enter value'}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </div>
    )
  }

  if (controlKind === 'date') {
    return (
      <input
        className="mf-input"
        type="date"
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  if (controlKind === 'enum') {
    const selected = Array.isArray(value)
      ? value.map(String)
      : value != null && value !== ''
        ? [String(value)]
        : []
    return (
      <input
        className="mf-input"
        type="text"
        value={selected.join(', ')}
        disabled={disabled}
        placeholder="Comma-separated values"
        onChange={(e) => {
          const parts = e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          onChange(parts.length > 1 || ['is_any_of', 'is_none_of'].includes(operator) ? parts : parts[0] || '')
        }}
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