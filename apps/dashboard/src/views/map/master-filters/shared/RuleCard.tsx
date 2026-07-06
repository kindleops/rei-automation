import { useMemo } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { duplicateNodeInTree, removeNodeFromTree, updateNodeInTree } from '../expression-utils'
import type { AdvancedMapFilterRule } from '../types'
import { ENTITY_LABELS } from '../types'
import { normalizeRegistryEntity } from '../entity-utils'
import { cls } from '../utils'
import { RuleValueControl } from './RuleValueControl'
import { GlassSelect } from './GlassSelect'

export interface RuleCardProps {
  rule: AdvancedMapFilterRule
  depth?: number
}

export function RuleCard({ rule, depth = 0 }: RuleCardProps) {
  const { draftExpression, setDraftExpression, fields, validationIssues } = useMasterFilters()

  const field = useMemo(() => fields.find((f) => f.key === rule.fieldKey) ?? null, [fields, rule.fieldKey])
  const entityLabel = useMemo(() => {
    const entity = field ? normalizeRegistryEntity(field.entity) : null
    return entity ? ENTITY_LABELS[entity] : 'Field'
  }, [field])

  const ruleIssues = useMemo(
    () => validationIssues.filter((issue) => issue.ruleId === rule.id),
    [rule.id, validationIssues],
  )

  const updateRule = (patch: Partial<AdvancedMapFilterRule>) => {
    setDraftExpression(updateNodeInTree(draftExpression, rule.id, (node) => {
      if (node.type !== 'rule') return node
      return { ...node, ...patch }
    }))
  }

  const fieldOptions = fields.map((f) => ({ label: f.label, value: f.key }))
  const operatorOptions = (field?.operators ?? ['equals']).map((op) => ({
    label: op.replace(/_/g, ' '),
    value: op,
  }))

  return (
    <article className={cls('mf-rule', depth > 0 && 'mf-rule--nested', ruleIssues.length > 0 && 'is-invalid')}>
      <div className="mf-rule__top">
        <span className="mf-rule__entity">{entityLabel}</span>
        <div className="mf-rule__actions">
          <button type="button" className="mf-icon-btn" aria-label="Duplicate rule" onClick={() => setDraftExpression(duplicateNodeInTree(draftExpression, rule.id))}>⧉</button>
          <button type="button" className="mf-icon-btn mf-icon-btn--danger" aria-label="Remove rule" onClick={() => setDraftExpression(removeNodeFromTree(draftExpression, rule.id))}>×</button>
        </div>
      </div>
      <div className="mf-rule__grid">
        <label className="mf-label">
          <span>Field</span>
          <GlassSelect
            value={rule.fieldKey}
            options={fieldOptions}
            placeholder="Select field…"
            aria-label="Filter field"
            onChange={(fieldKey) => {
              const next = fields.find((f) => f.key === fieldKey)
              updateRule({
                fieldKey,
                operator: next?.defaultOperator ?? next?.operators[0] ?? 'equals',
                value: '',
              })
            }}
          />
        </label>
        <label className="mf-label">
          <span>Operator</span>
          <GlassSelect
            value={rule.operator}
            options={operatorOptions}
            aria-label="Filter operator"
            onChange={(operator) => updateRule({ operator })}
          />
        </label>
        <label className="mf-label mf-label--value">
          <span>Value</span>
          <RuleValueControl
            field={field}
            operator={rule.operator}
            value={rule.value}
            onChange={(value) => updateRule({ value })}
            onOperatorChange={(operator) => updateRule({ operator })}
          />
        </label>
      </div>
      {ruleIssues.map((issue) => (
        <p key={`${issue.code}-${issue.fieldKey}`} className="mf-rule__issue">{issue.message}</p>
      ))}
    </article>
  )
}