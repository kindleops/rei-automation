import type { AdvancedMapFilterGroup, AdvancedMapFilterNode, AdvancedMapFilterRule, MapFilterRegistryField } from './types'
import { isGroupNode, isRuleNode } from './expression-utils'

const NO_VALUE_OPERATORS = new Set([
  'is_blank', 'is_not_blank', 'is_empty', 'is_not_empty',
  'has_data', 'has_no_data', 'is_true', 'is_false', 'is_unknown',
])

export interface ExpressionValidationIssue {
  ruleId: string
  fieldKey: string
  code: string
  message: string
}

export interface ExpressionValidationResult {
  ok: boolean
  issues: ExpressionValidationIssue[]
  completeRuleCount: number
  incompleteRuleCount: number
}

function isValuePresent(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => item !== '' && item != null)
  return true
}

function validateRule(rule: AdvancedMapFilterRule, fieldsByKey: Map<string, MapFilterRegistryField>): ExpressionValidationIssue[] {
  if (rule.enabled === false || !rule.fieldKey.trim()) return []

  const field = fieldsByKey.get(rule.fieldKey)
  if (!field) {
    return [{
      ruleId: rule.id,
      fieldKey: rule.fieldKey,
      code: 'unknown_field',
      message: 'Select a supported filter field.',
    }]
  }

  if (!rule.operator.trim()) {
    return [{
      ruleId: rule.id,
      fieldKey: rule.fieldKey,
      code: 'missing_operator',
      message: `Choose an operator for ${field.label}.`,
    }]
  }

  if (NO_VALUE_OPERATORS.has(rule.operator)) return []

  if (rule.operator === 'between' || rule.operator === 'outside_range') {
    if (!Array.isArray(rule.value) || rule.value.length !== 2 || !isValuePresent(rule.value[0]) || !isValuePresent(rule.value[1])) {
      return [{
        ruleId: rule.id,
        fieldKey: rule.fieldKey,
        code: 'missing_rule_value',
        message: `Enter both minimum and maximum values for ${field.label}.`,
      }]
    }
    return []
  }

  if (!isValuePresent(rule.value)) {
    return [{
      ruleId: rule.id,
      fieldKey: rule.fieldKey,
      code: 'missing_rule_value',
      message: `Enter a value for ${field.label}.`,
    }]
  }

  return []
}

function walk(node: AdvancedMapFilterNode, fieldsByKey: Map<string, MapFilterRegistryField>): ExpressionValidationIssue[] {
  if (isRuleNode(node)) return validateRule(node, fieldsByKey)
  if (!isGroupNode(node)) return []
  return (node.children || []).flatMap((child) => walk(child, fieldsByKey))
}

export function validateDraftExpression(
  expression: AdvancedMapFilterGroup,
  fields: MapFilterRegistryField[],
): ExpressionValidationResult {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]))
  const issues = walk(expression, fieldsByKey)

  let completeRuleCount = 0
  let incompleteRuleCount = 0
  const countRules = (node: AdvancedMapFilterNode) => {
    if (isRuleNode(node)) {
      if (node.enabled === false || !node.fieldKey.trim()) return
      const ruleIssues = validateRule(node, fieldsByKey)
      if (ruleIssues.length) incompleteRuleCount += 1
      else completeRuleCount += 1
      return
    }
    if (isGroupNode(node)) (node.children || []).forEach(countRules)
  }
  countRules(expression)

  return {
    ok: issues.length === 0,
    issues,
    completeRuleCount,
    incompleteRuleCount,
  }
}

export function expressionIsPreviewable(
  expression: AdvancedMapFilterGroup,
  fields: MapFilterRegistryField[],
): boolean {
  const validation = validateDraftExpression(expression, fields)
  return validation.completeRuleCount === 0 || validation.ok
}