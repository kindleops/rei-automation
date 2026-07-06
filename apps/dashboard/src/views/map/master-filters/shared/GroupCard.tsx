import { useMasterFilters } from '../MasterFiltersProvider'
import { createGroup, createRule, removeNodeFromTree, updateNodeInTree } from '../expression-utils'
import type { AdvancedMapFilterGroup, AdvancedMapFilterNode } from '../types'
import { cls } from '../utils'
import { RuleCard } from './RuleCard'

export interface GroupCardProps {
  group: AdvancedMapFilterGroup
  depth?: number
  isRoot?: boolean
}

export function GroupCard({ group, depth = 0, isRoot = false }: GroupCardProps) {
  const { draftExpression, setDraftExpression } = useMasterFilters()

  const updateGroup = (patch: Partial<AdvancedMapFilterGroup>) => {
    setDraftExpression(updateNodeInTree(draftExpression, group.id, (node) => {
      if (node.type !== 'group') return node
      return { ...node, ...patch }
    }))
  }

  const addRule = () => {
    setDraftExpression(updateNodeInTree(draftExpression, group.id, (node) => {
      if (node.type !== 'group') return node
      return { ...node, children: [...node.children, createRule()] }
    }))
  }

  const addNestedGroup = () => {
    setDraftExpression(updateNodeInTree(draftExpression, group.id, (node) => {
      if (node.type !== 'group') return node
      return { ...node, children: [...node.children, createGroup('AND', [])] }
    }))
  }

  const renderChild = (child: AdvancedMapFilterNode) =>
    child.type === 'rule'
      ? <RuleCard key={child.id} rule={child} depth={depth + 1} />
      : <GroupCard key={child.id} group={child} depth={depth + 1} />

  return (
    <section className={cls('mf-group', isRoot && 'mf-group--root')}>
      <header className="mf-group__header">
        <div className="mf-segmented mf-segmented--compact" role="group" aria-label="Combinator">
          <button type="button" className={cls('mf-segmented__btn', group.combinator === 'AND' && 'is-active')} onClick={() => updateGroup({ combinator: 'AND' })}>Match all</button>
          <button type="button" className={cls('mf-segmented__btn', group.combinator === 'OR' && 'is-active')} onClick={() => updateGroup({ combinator: 'OR' })}>Match any</button>
        </div>
        {!isRoot ? (
          <div className="mf-group__meta">
            <label className="mf-check"><input type="checkbox" checked={group.negated} onChange={(e) => updateGroup({ negated: e.target.checked })} />NOT</label>
            <button type="button" className="mf-text-btn mf-text-btn--danger" onClick={() => setDraftExpression(removeNodeFromTree(draftExpression, group.id))}>Remove group</button>
          </div>
        ) : null}
      </header>

      {group.children.length === 0 ? (
        <p className="mf-empty-inline">No rules yet. Add a rule or quick filter to build the stack.</p>
      ) : (
        <div className="mf-group__children">{group.children.map(renderChild)}</div>
      )}

      <footer className="mf-group__footer">
        <button type="button" className="mf-text-btn" onClick={addRule}>+ Add rule</button>
        <button type="button" className="mf-text-btn" onClick={addNestedGroup}>+ Add group</button>
      </footer>
    </section>
  )
}