import { useMemo } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import {
  duplicateNodeInTree,
  removeNodeFromTree,
  updateNodeInTree,
} from '../expression-utils'
import type { AdvancedMapFilterRule, MapFilterRegistryField } from '../types'
import { ENTITY_LABELS } from '../types'
import { normalizeRegistryEntity } from '../entity-utils'
import { cls } from '../utils'
import { RuleValueControl } from './RuleValueControl'

export interface RuleCardProps {
  rule: AdvancedMapFilterRule
  depth?: number
}

export function RuleCard({ rule, depth = 0 }: RuleCardProps) {
  const { draftExpression, setDraftExpression, fields } = useMasterFilters()

  const field = useMemo(
    () => fields.find((f) => f.key === rule.fieldKey) ?? null,
    [fields, rule.fieldKey],
  )

  const entityLabel = useMemo(() => {
    const entity = field ? normalizeRegistryEntity(field.entity) : null
    return entity ? ENTITY_LABELS[entity] : 'Unknown'
  }, [field])

  const operators = field?.operators ?? ['equals']

  const updateRule = (patch: Partial<AdvancedMapFilterRule>) => {
    setDraftExpression(
      updateNodeInTree(draftExpression, rule.id, (node) => {
        if (node.type !== 'rule') return node
        return { ...node, ...patch }
      }),
    )
  }

  const onFieldChange = (fieldKey: string) => {
    const nextField = fields.find((f) => f.key === fieldKey)
    const defaultOperator = nextField?.operators[0] ?? 'equals'
    updateRule({ fieldKey, operator: defaultOperator, value: '' })
  }

  return (
    <article className={cls('mf-rule-card', depth > 0 && 'mf-rule-card--nested')} data-depth={depth}>
      <header className="mf-rule-card__header">
        <span className="mf-rule-card__entity">{entityLabel}</span>
        <div className="mf-rule-card__actions">
          <button
            type="button"
            className="mf-icon-btn"
            aria-label="Duplicate rule"
            onClick={() => setDraftExpression(duplicateNodeInTree(draftExpression, rule.id))}
          >
            ⧉
          </button>
          <button
            type="button"
            className="mf-icon-btn mf-icon-btn--danger"
            aria-label="Remove rule"
            onClick={() => setDraftExpression(removeNodeFromTree(draftExpression, rule.id))}
          >
            ×
          </button>
        </div>
      </header>

      <div className="mf-rule-card__grid">
        <label className="mf-field">
          <span className="mf-field__label">Field</span>
          <select
            className="mf-select"
            value={rule.fieldKey}
            onChange={(e) => onFieldChange(e.target.value)}
          >
            <option value="">Select field…</option>
            {fields.map((f: MapFilterRegistryField) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </label>

        <label className="mf-field">
          <span className="mf-field__label">Operator</span>
          <select
            className="mf-select"
            value={rule.operator}
            onChange={(e) => updateRule({ operator: e.target.value })}
          >
            {operators.map((op) => (
              <option key={op} value={op}>{op.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>

        <div className="mf-field mf-field--value">
          <span className="mf-field__label">Value</span>
          <RuleValueControl
            field={field}
            operator={rule.operator}
            value={rule.value}
            onChange={(value) => updateRule({ value })}
            onOperatorChange={(operator) => updateRule({ operator })}
          />
        </div>
      </div>
    </article>
  )
}