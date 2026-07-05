import { useMemo } from 'react'

import { useMasterFilters } from '../MasterFiltersProvider'
import { isRuleNode } from '../expression-utils'
import type { AdvancedMapFilterNode } from '../types'

function summarizeNode(node: AdvancedMapFilterNode, fieldsByKey: Map<string, string>): string {
  if (isRuleNode(node)) {
    if (!node.fieldKey) return 'Empty rule'
    const label = fieldsByKey.get(node.fieldKey) ?? node.fieldKey
    const op = node.operator.replace(/_/g, ' ')
    const val = node.value == null || node.value === '' ? '' : ` ${String(node.value)}`
    return `${label} ${op}${val}`.trim()
  }
  const parts = (node.children || []).map((c) => summarizeNode(c, fieldsByKey))
  const joined = parts.filter(Boolean).join(` ${node.combinator} `)
  return node.negated ? `NOT (${joined})` : `(${joined})`
}

export function ExpressionSummary() {
  const { draftExpression, fields, appliedToken, activeRuleCount } = useMasterFilters()

  const fieldsByKey = useMemo(
    () => new Map(fields.map((f) => [f.key, f.label])),
    [fields],
  )

  const summary = useMemo(
    () => summarizeNode(draftExpression, fieldsByKey),
    [draftExpression, fieldsByKey],
  )

  return (
    <section className="mf-expression-summary">
      <header className="mf-expression-summary__header">
        <h3>Expression</h3>
        <span className="mf-expression-summary__count">{activeRuleCount} active rules</span>
      </header>
      <p className="mf-expression-summary__text">
        {activeRuleCount === 0 ? 'No filters applied to the draft stack.' : summary}
      </p>
      {appliedToken ? (
        <p className="mf-expression-summary__token">
          Applied token: <code>{appliedToken.slice(0, 12)}…</code>
        </p>
      ) : null}
    </section>
  )
}