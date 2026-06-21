import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import type { IconName } from '../../../shared/icons'
import { workflowNodeCategories, type WorkflowNodeLibraryItem } from '../WorkflowList'
import { listNodeTypes } from '../workflowStudio.adapter'
import type { WorkflowNodeTypeSchema } from '../workflow.types'

const CATEGORY_META: Record<string, { icon: string; tone: string; hint: string }> = {
  triggers: { icon: '⚡', tone: 'trigger', hint: 'Start events' },
  communication: { icon: '➤', tone: 'communication', hint: 'SMS, email, RVM' },
  conditions: { icon: 'Ⅱ', tone: 'condition', hint: 'Branches & logic' },
  timing: { icon: '◷', tone: 'timing', hint: 'Waits & delays' },
  intelligence: { icon: '✦', tone: 'ai', hint: 'AI decisions' },
  operations: { icon: '⌘', tone: 'ops', hint: 'CRM updates' },
  control: { icon: '◎', tone: 'ops', hint: 'Flow control' },
  safety: { icon: '◇', tone: 'safety', hint: 'Guards & approvals' },
  guards: { icon: '◇', tone: 'safety', hint: 'Safety gates' },
}

const KIND_ICON: Record<string, IconName> = {
  trigger: 'bolt',
  action: 'send',
  condition: 'layout-split',
  timing: 'clock',
  guard: 'shield',
}

interface PaletteCategory {
  title: string
  items: WorkflowNodeLibraryItem[]
}

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\./g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function mapApiNode(node: WorkflowNodeTypeSchema): WorkflowNodeLibraryItem {
  const kind = node.node_kind ?? 'action'
  return {
    label: node.label,
    type: node.node_type,
    icon: KIND_ICON[kind] ?? 'settings',
    description: node.description ?? `${titleCase(kind)} node`,
    category: node.category,
  }
}

function fallbackCategories(): PaletteCategory[] {
  return workflowNodeCategories.map((category) => ({
    title: category.title,
    items: category.items,
  }))
}

interface WorkflowNodePaletteV2Props {
  onAddNode: (item: WorkflowNodeLibraryItem) => void
  disabled?: boolean
}

export const WorkflowNodePaletteV2 = ({ onAddNode, disabled }: WorkflowNodePaletteV2Props) => {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [categories, setCategories] = useState<PaletteCategory[]>(fallbackCategories)
  const [source, setSource] = useState<'api' | 'fallback'>('fallback')

  useEffect(() => {
    let cancelled = false
    void listNodeTypes(true)
      .then((response) => {
        if (cancelled) return
        const grouped = response.categories
        if (!grouped || !Object.keys(grouped).length) return

        const next = Object.entries(grouped).map(([title, nodes]) => ({
          title: titleCase(title),
          items: nodes.map(mapApiNode),
        }))
        setCategories(next)
        setSource('api')
      })
      .catch(() => {
        if (!cancelled) {
          setCategories(fallbackCategories())
          setSource('fallback')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return categories

    return categories
      .map((category) => ({
        ...category,
        items: category.items.filter((item) =>
          [item.label, item.type, item.description].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        ),
      }))
      .filter((category) => category.items.length > 0)
  }, [categories, query])

  const totalCount = categories.reduce((sum, category) => sum + category.items.length, 0)

  const toggleCategory = (title: string) => {
    setCollapsed((current) => ({ ...current, [title]: !current[title] }))
  }

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, item: WorkflowNodeLibraryItem) => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-workflow-node', JSON.stringify(item))
    event.dataTransfer.setData('text/plain', item.type)
  }

  return (
    <aside className="wfs2-palette">
      <header className="wfs2-palette__header">
        <div>
          <span className="wfs2-palette__kicker">Node Library</span>
          <strong>Drag or click to add</strong>
        </div>
        <span className="wfs2-palette__count">{totalCount}</span>
      </header>

      <div className="wfs2-palette__source">
        {source === 'api' ? 'Registry API' : 'Embedded fallback'}
      </div>

      <div className="wfs2-palette__search-wrap">
        <span>⌕</span>
        <input
          className="wfs2__search"
          type="search"
          placeholder="Search trigger, SMS, wait…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="wfs2__empty">
          <strong>No nodes found</strong>
          <span>Try “sms”, “wait”, “reply”, or “approval”.</span>
        </div>
      ) : (
        filtered.map((category) => {
          const isCollapsed = collapsed[category.title] ?? false
          const key = category.title.toLowerCase()
          const meta = CATEGORY_META[key] ?? { icon: '•', tone: 'ops', hint: 'Workflow node' }

          return (
            <section key={category.title} className={`wfs2-palette__category is-${meta.tone}`}>
              <button
                type="button"
                className="wfs2-palette__category-head"
                onClick={() => toggleCategory(category.title)}
                aria-expanded={!isCollapsed}
              >
                <span className="wfs2-palette__category-title">
                  <span className="wfs2-palette__category-icon">{meta.icon}</span>
                  <span>
                    <strong>{category.title}</strong>
                    <small>{meta.hint}</small>
                  </span>
                </span>
                <span className="wfs2-palette__category-meta">
                  <em>{category.items.length}</em>
                  <b>{isCollapsed ? '+' : '−'}</b>
                </span>
              </button>

              {!isCollapsed && (
                <div className="wfs2-palette__nodes">
                  {category.items.map((item) => (
                    <button
                      key={item.type}
                      type="button"
                      className={`wfs2-palette__node is-${meta.tone}`}
                      disabled={disabled}
                      draggable={!disabled}
                      onDragStart={(event) => handleDragStart(event, item)}
                      onClick={() => onAddNode(item)}
                      title={item.description}
                    >
                      <span className="wfs2-palette__node-icon">{meta.icon}</span>
                      <span className="wfs2-palette__node-main">
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className="wfs2-palette__node-grip">⋮⋮</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )
        })
      )}
    </aside>
  )
}