import { useMemo } from 'react'

import type { MapFilterRegistryField } from '../types'
import { cls } from '../utils'
import { GlassSelect } from './GlassSelect'

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

function resolveControlKind(field: MapFilterRegistryField | null, operator: string) {
  if (!field || isNoValueOperator(operator)) return 'none'
  if (
    field.controlType === 'boolean_segment'
    || field.dataType === 'boolean'
    || field.valueSource === 'boolean'
    || (field.dataType === 'derived_presence' && ['has_data', 'has_no_data'].includes(operator))
  ) {
    return 'boolean'
  }
  if (
    field.controlType === 'enum_picker'
    || field.controlType === 'status_segment'
    || field.controlType === 'tag_picker'
    || (field.valueSource === 'distinct' && (field.valueOptions?.length || field.enumOptions?.length))
  ) {
    return 'enum'
  }
  if (field.controlType === 'geo_picker' || field.dataType === 'geo') return 'geo'
  if (isBetweenOperator(operator)) return 'between'
  if (
    field.controlType === 'currency_range'
    || field.controlType === 'number_range'
    || field.dataType === 'number'
  ) {
    return 'number'
  }
  if (field.controlType === 'date_range' || field.dataType === 'date') return 'date'
  return 'text'
}

function buildEnumOptions(field: MapFilterRegistryField | null) {
  if (!field) return []
  if (field.valueOptions?.length) {
    return field.valueOptions.map((option) => ({
      label: option.label,
      value: String(option.value),
    }))
  }
  return (field.enumOptions ?? []).map((option) => ({ label: option, value: option }))
}

export function RuleValueControl({
  field,
  operator,
  value,
  onChange,
  onOperatorChange,
  disabled = false,
}: RuleValueControlProps) {
  const controlKind = useMemo(
    () => resolveControlKind(field, operator),
    [field, operator],
  )

  if (controlKind === 'none') {
    return <span className="mf-muted">No value required</span>
  }

  if (controlKind === 'boolean') {
    const tri = operator === 'is_false' || operator === 'has_no_data' ? 'no' : operator === 'is_unknown' ? 'either' : 'yes'
    return (
      <div className="mf-segmented mf-segmented--compact" role="group" aria-label="Boolean value">
        {(['yes', 'no', 'either'] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            className={cls('mf-segmented__btn', tri === opt && 'is-active')}
            disabled={disabled}
            onClick={() => {
              let op = 'is_true'
              if (opt === 'no') {
                op = field?.dataType === 'derived_presence' ? 'has_no_data' : 'is_false'
              } else if (opt === 'either') {
                op = 'is_unknown'
              } else if (field?.dataType === 'derived_presence') {
                op = 'has_data'
              }
              onOperatorChange?.(op)
              onChange(null)
            }}
          >
            {opt === 'yes' ? 'Yes' : opt === 'no' ? 'No' : 'Any'}
          </button>
        ))}
      </div>
    )
  }

  if (controlKind === 'enum') {
    const options = buildEnumOptions(field)
    if (!options.length) {
      return <span className="mf-muted">No preset values</span>
    }
    return (
      <GlassSelect
        value={value == null ? '' : String(value)}
        options={options}
        disabled={disabled}
        aria-label={field?.label ? `Value for ${field.label}` : 'Filter value'}
        onChange={(next) => {
          const matched = field?.valueOptions?.find((option) => String(option.value) === next)
          onChange(matched ? matched.value : next)
        }}
      />
    )
  }

  if (controlKind === 'geo') {
    return <span className="mf-muted">Uses current map bounds</span>
  }

  if (controlKind === 'between') {
    const pair = Array.isArray(value) ? value : ['', '']
    return (
      <div className="mf-between">
        <input className="mf-input mf-input--glass" type="number" inputMode="decimal" value={String(pair[0] ?? '')} disabled={disabled} placeholder="Min" onChange={(e) => onChange([e.target.value, pair[1]])} />
        <span>to</span>
        <input className="mf-input mf-input--glass" type="number" inputMode="decimal" value={String(pair[1] ?? '')} disabled={disabled} placeholder="Max" onChange={(e) => onChange([pair[0], e.target.value])} />
      </div>
    )
  }

  if (controlKind === 'number') {
    const isCurrency = field?.controlType === 'currency_range'
    const placeholder = isCurrency ? 'Amount' : 'Enter value'
    return (
      <input
        className={cls('mf-input', 'mf-input--glass', isCurrency && 'mf-input--currency')}
        type="number"
        inputMode="decimal"
        value={value == null ? '' : String(value)}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }

  if (controlKind === 'date') {
    return (
      <input
        className="mf-input mf-input--glass"
        type="date"
        value={value == null ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <input
      className="mf-input mf-input--glass"
      type="text"
      value={value == null ? '' : String(value)}
      disabled={disabled}
      placeholder="Enter value"
      onChange={(e) => onChange(e.target.value)}
    />
  )
}