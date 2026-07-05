import { useMasterFilters } from '../MasterFiltersProvider'
import {
  createGroup,
  createRule,
  removeNodeFromTree,
  updateNodeInTree,
} from '../expression-utils'
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
    setDraftExpression(
      updateNodeInTree(draftExpression, group.id, (node) => {
        if (node.type !== 'group') return node
        return { ...node, ...patch }
      }),
    )
  }

  const addRule = () => {
    setDraftExpression(
      updateNodeInTree(draftExpression, group.id, (node) => {
        if (node.type !== 'group') return node
        return { ...node, children: [...node.children, createRule()] }
      }),
    )
  }

  const addNestedGroup = () => {
    setDraftExpression(
      updateNodeInTree(draftExpression, group.id, (node) => {
        if (node.type !== 'group') return node
        return { ...node, children: [...node.children, createGroup('AND', [])] }
      }),
    )
  }

  const renderChild = (child: AdvancedMapFilterNode) => {
    if (child.type === 'rule') {
      return <RuleCard key={child.id} rule={child} depth={depth + 1} />
    }
    return <GroupCard key={child.id} group={child} depth={depth + 1} />
  }

  return (
    <section className={cls('mf-group-card', isRoot && 'mf-group-card--root')} data-depth={depth}>
      {!isRoot ? (
        <header className="mf-group-card__header">
          <div className="mf-group-card__combinator">
            <button
              type="button"
              className={cls('mf-segmented__btn', group.combinator === 'AND' && 'is-active')}
              onClick={() => updateGroup({ combinator: 'AND' })}
            >
              AND
            </button>
            <button
              type="button"
              className={cls('mf-segmented__btn', group.combinator === 'OR' && 'is-active')}
              onClick={() => updateGroup({ combinator: 'OR' })}
            >
              OR
            </button>
          </div>
          <label className="mf-toggle">
            <input
              type="checkbox"
              checked={group.negated}
              onChange={(e) => updateGroup({ negated: e.target.checked })}
            />
            <span>Negate group</span>
          </label>
          <button
            type="button"
            className="mf-icon-btn mf-icon-btn--danger"
            aria-label="Remove group"
            onClick={() => setDraftExpression(removeNodeFromTree(draftExpression, group.id))}
          >
            ×
          </button>
        </header>
      ) : (
        <header className="mf-group-card__header mf-group-card__header--root">
          <span className="mf-group-card__title">Filter stack</span>
          <div className="mf-group-card__combinator">
            <button
              type="button"
              className={cls('mf-segmented__btn', group.combinator === 'AND' && 'is-active')}
              onClick={() => updateGroup({ combinator: 'AND' })}
            >
              Match all (AND)
            </button>
            <button
              type="button"
              className={cls('mf-segmented__btn', group.combinator === 'OR' && 'is-active')}
              onClick={() => updateGroup({ combinator: 'OR' })}
            >
              Match any (OR)
            </button>
          </div>
        </header>
      )}

      <div className="mf-group-card__children">
        {group.children.length === 0 ? (
          <div className="mf-empty-state">
            <p>No rules yet. Add a field from Discover or create a rule below.</p>
          </div>
        ) : (
          group.children.map(renderChild)
        )}
      </div>

      <footer className="mf-group-card__footer">
        <button type="button" className="mf-btn mf-btn--ghost" onClick={addRule}>
          + Add rule
        </button>
        <button type="button" className="mf-btn mf-btn--ghost" onClick={addNestedGroup}>
          + Add group
        </button>
      </footer>
    </section>
  )
}