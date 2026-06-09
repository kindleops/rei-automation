import { useMemo, useState } from 'react'
import { workflowNodeCategories, type WorkflowNodeLibraryItem } from '../WorkflowList'

const SAFETY_TYPES = new Set([
  'suppress_phone',
  'suppress_owner',
  'pause_workflow',
  'stop_workflow',
  'cancel_queue',
  'require_approval',
])

const CATEGORY_MAP: Record<string, string> = {
  Triggers: 'Triggers',
  Communication: 'Communication',
  Timing: 'Timing',
  Conditions: 'Conditions',
  'Deal Intelligence': 'AI / Intelligence',
  'State & Ops': 'Operations',
}

const CATEGORY_META: Record<string, { icon: string; tone: string; hint: string }> = {
  Triggers: { icon: '⚡', tone: 'trigger', hint: 'Start events' },
  Communication: { icon: '➤', tone: 'communication', hint: 'SMS, email, RVM' },
  Conditions: { icon: 'Ⅱ', tone: 'condition', hint: 'Branches & logic' },
  Timing: { icon: '◷', tone: 'timing', hint: 'Waits & delays' },
  'AI / Intelligence': { icon: '✦', tone: 'ai', hint: 'AI decisions' },
  Operations: { icon: '⌘', tone: 'ops', hint: 'CRM updates' },
  Safety: { icon: '◇', tone: 'safety', hint: 'Guards & approvals' },
}

const V2_CATEGORY_ORDER = [
  'Triggers',
  'Communication',
  'Conditions',
  'Timing',
  'AI / Intelligence',
  'Operations',
  'Safety',
] as const

type V2Category = (typeof V2_CATEGORY_ORDER)[number]

function resolveCategory(item: WorkflowNodeLibraryItem, sourceTitle: string): V2Category {
  if (SAFETY_TYPES.has(item.type)) return 'Safety'
  return (CATEGORY_MAP[sourceTitle] ?? sourceTitle) as V2Category
}

interface PaletteCategory {
  title: V2Category
  items: WorkflowNodeLibraryItem[]
}

interface WorkflowNodePaletteV2Props {
  onAddNode: (item: WorkflowNodeLibraryItem) => void
  disabled?: boolean
}

export const WorkflowNodePaletteV2 = ({ onAddNode, disabled }: WorkflowNodePaletteV2Props) => {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const categories = useMemo(() => {
    const bucket = new Map<string, WorkflowNodeLibraryItem[]>()

    for (const category of workflowNodeCategories) {
      for (const item of category.items) {
        const title = resolveCategory(item, category.title)
        bucket.set(title, [...(bucket.get(title) ?? []), item])
      }
    }

    return V2_CATEGORY_ORDER
      .map((title) => ({ title, items: bucket.get(title) ?? [] }))
      .filter((category) => category.items.length > 0) as PaletteCategory[]
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

  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>, item: WorkflowNodeLibraryItem) => {
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
          const meta = CATEGORY_META[category.title]

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