import { useMemo } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { duplicateNodeInTree, removeNodeFromTree, updateNodeInTree } from '../expression-utils'
import type { AdvancedMapFilterRule } from '../types'
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

  const field = useMemo(() => fields.find((f) => f.key === rule.fieldKey) ?? null, [fields, rule.fieldKey])
  const entityLabel = useMemo(() => {
    const entity = field ? normalizeRegistryEntity(field.entity) : null
    return entity ? ENTITY_LABELS[entity] : 'Field'
  }, [field])

  const updateRule = (patch: Partial<AdvancedMapFilterRule>) => {
    setDraftExpression(updateNodeInTree(draftExpression, rule.id, (node) => {
      if (node.type !== 'rule') return node
      return { ...node, ...patch }
    }))
  }

  return (
    <article className={cls('mf-rule', depth > 0 && 'mf-rule--nested')}>
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
          <select className="mf-select" value={rule.fieldKey} onChange={(e) => {
            const next = fields.find((f) => f.key === e.target.value)
            updateRule({ fieldKey: e.target.value, operator: next?.operators[0] ?? 'equals', value: '' })
          }}>
            <option value="">Select field…</option>
            {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
        <label className="mf-label">
          <span>Operator</span>
          <select className="mf-select" value={rule.operator} onChange={(e) => updateRule({ operator: e.target.value })}>
            {(field?.operators ?? ['equals']).map((op) => <option key={op} value={op}>{op.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label className="mf-label mf-label--value">
          <span>Value</span>
          <RuleValueControl field={field} operator={rule.operator} value={rule.value} onChange={(value) => updateRule({ value })} onOperatorChange={(operator) => updateRule({ operator })} />
        </label>
      </div>
    </article>
  )
}