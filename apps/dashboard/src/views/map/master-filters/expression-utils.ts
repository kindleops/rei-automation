import type {
  AdvancedMapFilterGroup,
  AdvancedMapFilterNode,
  AdvancedMapFilterRule,
  MapFilterCombinator,
} from './types'

function newId(prefix = 'node'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

export function createEmptyExpression(): AdvancedMapFilterGroup {
  return {
    id: 'root',
    type: 'group',
    combinator: 'AND',
    negated: false,
    enabled: true,
    children: [],
  }
}

export function createRule(fieldKey = '', operator = 'equals', value: unknown = ''): AdvancedMapFilterRule {
  return {
    id: newId('rule'),
    type: 'rule',
    fieldKey,
    operator,
    value,
    enabled: true,
  }
}

export function createGroup(
  combinator: MapFilterCombinator = 'AND',
  children: AdvancedMapFilterNode[] = [],
): AdvancedMapFilterGroup {
  return {
    id: newId('group'),
    type: 'group',
    combinator,
    negated: false,
    enabled: true,
    children,
  }
}

export function isRuleNode(node: AdvancedMapFilterNode): node is AdvancedMapFilterRule {
  return node.type === 'rule'
}

export function isGroupNode(node: AdvancedMapFilterNode): node is AdvancedMapFilterGroup {
  return node.type === 'group'
}

export function countActiveRules(node: AdvancedMapFilterNode | null | undefined): number {
  if (!node) return 0
  if (isRuleNode(node)) {
    return node.enabled !== false && node.fieldKey.trim().length > 0 ? 1 : 0
  }
  return (node.children || []).reduce((sum, child) => sum + countActiveRules(child), 0)
}

export function cloneExpression<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function updateNodeInTree(
  root: AdvancedMapFilterGroup,
  nodeId: string,
  updater: (node: AdvancedMapFilterNode) => AdvancedMapFilterNode | null,
): AdvancedMapFilterGroup {
  const walk = (node: AdvancedMapFilterNode): AdvancedMapFilterNode | null => {
    if (node.id === nodeId) return updater(node)
    if (!isGroupNode(node)) return node
    const children = node.children
      .map((child) => walk(child))
      .filter((child): child is AdvancedMapFilterNode => child != null)
    return { ...node, children }
  }

  const next = walk(root)
  return (next && isGroupNode(next) ? next : root) as AdvancedMapFilterGroup
}

export function removeNodeFromTree(root: AdvancedMapFilterGroup, nodeId: string): AdvancedMapFilterGroup {
  return updateNodeInTree(root, nodeId, () => null)
}

export function duplicateNodeInTree(root: AdvancedMapFilterGroup, nodeId: string): AdvancedMapFilterGroup {
  let duplicated: AdvancedMapFilterNode | null = null

  const cloneNode = (node: AdvancedMapFilterNode): AdvancedMapFilterNode => {
    const cloned = cloneExpression(node)
    cloned.id = newId(node.type)
    if (isGroupNode(cloned)) {
      cloned.children = cloned.children.map(cloneNode)
    }
    return cloned
  }

  const insertSibling = (group: AdvancedMapFilterGroup): AdvancedMapFilterGroup => {
    const idx = group.children.findIndex((c) => c.id === nodeId)
    if (idx >= 0 && duplicated) {
      const children = [...group.children]
      children.splice(idx + 1, 0, duplicated)
      return { ...group, children }
    }
    return {
      ...group,
      children: group.children.map((child) =>
        isGroupNode(child) ? insertSibling(child) : child,
      ),
    }
  }

  const find = (node: AdvancedMapFilterNode): void => {
    if (node.id === nodeId) duplicated = cloneNode(node)
    if (isGroupNode(node)) node.children.forEach(find)
  }
  find(root)

  return duplicated ? insertSibling(root) : root
}

export function appendRuleToRoot(
  root: AdvancedMapFilterGroup,
  rule: AdvancedMapFilterRule,
): AdvancedMapFilterGroup {
  return {
    ...root,
    children: [...root.children, rule],
  }
}

export function appendGroupToRoot(
  root: AdvancedMapFilterGroup,
  group: AdvancedMapFilterGroup,
): AdvancedMapFilterGroup {
  return {
    ...root,
    children: [...root.children, group],
  }
}