import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../../shared/icons'
import type { Workflow } from '../workflow.types'
import { workflowKindBadge } from './workflow-studio-mode'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type NavigatorTab =
  | 'all'
  | 'system'
  | 'custom'
  | 'draft'
  | 'armed'
  | 'live'
  | 'paused'
  | 'failed'
  | 'archived'

const TABS: Array<{ id: NavigatorTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System' },
  { id: 'custom', label: 'Custom' },
  { id: 'draft', label: 'Draft' },
  { id: 'armed', label: 'Armed' },
  { id: 'live', label: 'Live' },
  { id: 'paused', label: 'Paused' },
  { id: 'failed', label: 'Failed' },
  { id: 'archived', label: 'Archived' },
]

export type NavigatorAction =
  | 'open'
  | 'rename'
  | 'duplicate'
  | 'view-runs'
  | 'view-analytics'
  | 'version-history'
  | 'enable'
  | 'pause'
  | 'archive'
  | 'restore'
  | 'delete-draft'
  | 'clone-legacy'

interface WorkflowNavigatorV2Props {
  workflows: Workflow[]
  selectedId: string | null
  loading?: boolean
  busy?: boolean
  variant?: 'desktop' | 'mobile'
  onSelect: (workflowId: string) => void
  onCreate: () => void
  onAction: (workflow: Workflow, action: NavigatorAction) => void
}

function formatTimestamp(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function lifecycleLabel(workflow: Workflow) {
  if (workflow.operational_mode) {
    return workflow.operational_mode.replace(/_/g, ' ')
  }
  return workflow.status
}

function matchesTab(workflow: Workflow, tab: NavigatorTab) {
  if (tab === 'all') return true
  if (tab === 'system') return workflow.is_system_template === true
  if (tab === 'custom') return workflow.is_system_template !== true
  if (tab === 'draft') return workflow.status === 'draft'
  if (tab === 'armed') return workflow.operational_mode === 'armed'
  if (tab === 'live') {
    return workflow.operational_mode === 'live' || (workflow.status === 'active' && workflow.live_send_enabled)
  }
  if (tab === 'paused') return workflow.status === 'paused' || workflow.operational_mode === 'paused'
  if (tab === 'failed') return workflow.operational_mode === 'failed'
  if (tab === 'archived') return workflow.status === 'archived' || workflow.operational_mode === 'archived'
  return true
}

function menuActions(workflow: Workflow): NavigatorAction[] {
  const actions: NavigatorAction[] = ['open', 'duplicate', 'view-runs', 'view-analytics', 'version-history']

  if (workflow.is_legacy) {
    actions.push('clone-legacy', 'archive')
    return actions
  }

  actions.splice(1, 0, 'rename')

  if (workflow.is_system_template) {
    actions.push('pause')
    return actions
  }

  if (workflow.status === 'archived') {
    actions.push('restore')
    return actions
  }

  if (workflow.status === 'draft') {
    actions.push('enable', 'archive', 'delete-draft')
    return actions
  }

  if (workflow.status === 'paused' || workflow.operational_mode === 'paused') {
    actions.push('enable', 'archive')
    return actions
  }

  actions.push('pause', 'archive')
  return actions
}

const ACTION_LABELS: Record<NavigatorAction, string> = {
  open: 'Open',
  rename: 'Rename',
  duplicate: 'Duplicate',
  'view-runs': 'View Runs',
  'view-analytics': 'View Analytics',
  'version-history': 'Version History',
  enable: 'Enable',
  pause: 'Pause',
  archive: 'Archive',
  restore: 'Restore',
  'delete-draft': 'Delete Draft',
  'clone-legacy': 'Clone Legacy to V2',
}

const ACTION_ICONS: Partial<Record<NavigatorAction, IconName>> = {
  open: 'grid',
  rename: 'file-text',
  duplicate: 'layers',
  'view-runs': 'activity',
  'view-analytics': 'stats',
  'version-history': 'clock',
  enable: 'zap',
  pause: 'pause',
  archive: 'archive',
  restore: 'refresh-cw',
  'delete-draft': 'x',
  'clone-legacy': 'layers',
}

export const WorkflowNavigatorV2 = ({
  workflows,
  selectedId,
  loading,
  busy,
  variant = 'desktop',
  onSelect,
  onCreate,
  onAction,
}: WorkflowNavigatorV2Props) => {
  const isMobile = variant === 'mobile'
  const [tab, setTab] = useState<NavigatorTab>('all')
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const menuWorkflow = menuId ? workflows.find((row) => row.id === menuId) ?? null : null

  useEffect(() => {
    if (!menuId) return
    const close = () => {
      setMenuId(null)
      setMenuAnchor(null)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menuId])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return workflows.filter((workflow) => {
      if (!matchesTab(workflow, tab)) return false
      if (!needle) return true
      return (
        workflow.name.toLowerCase().includes(needle) ||
        workflow.workflow_key.toLowerCase().includes(needle) ||
        workflow.channel.toLowerCase().includes(needle) ||
        workflow.status.toLowerCase().includes(needle)
      )
    })
  }, [query, tab, workflows])

  const tabCounts = useMemo(() => {
    const counts: Partial<Record<NavigatorTab, number>> = {}
    for (const item of TABS) {
      counts[item.id] = workflows.filter((workflow) => matchesTab(workflow, item.id)).length
    }
    return counts
  }, [workflows])

  const closeMenu = () => {
    setMenuId(null)
    setMenuAnchor(null)
  }

  const renderDesktopCard = (workflow: Workflow) => {
    const stats = workflow.stats ?? {}
    const menuOpen = menuId === workflow.id

    return (
      <article
        key={workflow.id}
        className={cls('wfs2-nav__card', selectedId === workflow.id && 'is-selected')}
      >
        <button
          type="button"
          className="wfs2-nav__card-main"
          onClick={() => onSelect(workflow.id)}
        >
          <div className="wfs2-nav__card-head">
            <strong>{workflow.name}</strong>
            <span className={cls(
              'wfs2-nav__badge',
              workflow.is_legacy ? 'is-legacy' : workflow.is_system_template ? 'is-system' : 'is-custom',
            )}>
              {workflowKindBadge(workflow)}
            </span>
          </div>

          <div className="wfs2-nav__meta">
            <span>v{workflow.version ?? '1'}</span>
            <span>{workflow.channel}</span>
            <span className={cls('wfs2__badge', `is-${workflow.status}`)}>{lifecycleLabel(workflow)}</span>
            <span className={cls('wfs2-nav__live', workflow.live_send_enabled && 'is-on')}>
              {workflow.live_send_enabled ? 'Live send' : 'Guarded'}
            </span>
          </div>

          <div className="wfs2-nav__stats">
            <span><b>{stats.active ?? 0}</b> active</span>
            <span><b>{stats.waiting ?? 0}</b> waiting</span>
            <span><b>{stats.blocked ?? 0}</b> blocked</span>
            <span><b>{stats.completed_today ?? 0}</b> done today</span>
            <span><b>{stats.failed_today ?? 0}</b> failed today</span>
          </div>

          <div className="wfs2-nav__foot">
            <small>Last run {formatTimestamp(workflow.last_execution_at)}</small>
            <small>Published {formatTimestamp(workflow.last_published_at)}</small>
          </div>
        </button>

        <div className="wfs2-nav__menu-wrap">
          <button
            type="button"
            className="wfs2-nav__menu-btn"
            aria-label="Workflow actions"
            onClick={(event) => {
              if (menuOpen) {
                closeMenu()
                return
              }
              const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect()
              setMenuAnchor(rect)
              setMenuId(workflow.id)
            }}
          >
            <Icon name="more" />
          </button>
        </div>
      </article>
    )
  }

  const renderMobileRow = (workflow: Workflow) => {
    const stats = workflow.stats ?? {}
    const activeCount = stats.active ?? 0
    const waitingCount = stats.waiting ?? 0

    return (
      <article
        key={workflow.id}
        className={cls('wfs2-nav__row', selectedId === workflow.id && 'is-selected')}
      >
        <button
          type="button"
          className="wfs2-nav__row-main"
          onClick={() => onSelect(workflow.id)}
        >
          <div className="wfs2-nav__row-copy">
            <strong>{workflow.name}</strong>
            <span className="wfs2-nav__row-meta">
              <span className={cls(
                'wfs2-nav__badge',
                workflow.is_legacy ? 'is-legacy' : workflow.is_system_template ? 'is-system' : 'is-custom',
              )}>
                {workflowKindBadge(workflow)}
              </span>
              <span>{workflow.channel}</span>
              <span className={cls('wfs2-nav__row-status', `is-${workflow.status}`)}>
                {lifecycleLabel(workflow)}
              </span>
            </span>
          </div>
          <div className="wfs2-nav__row-trail">
            {(activeCount > 0 || waitingCount > 0) && (
              <span className="wfs2-nav__row-kpi">
                {activeCount > 0 ? `${activeCount} active` : `${waitingCount} waiting`}
              </span>
            )}
            {selectedId === workflow.id ? (
              <span className="wfs2-nav__row-selected" aria-hidden>
                <Icon name="check" size={14} />
              </span>
            ) : (
              <span className="wfs2-nav__row-chevron" aria-hidden>
                <Icon name="chevron-right" size={14} />
              </span>
            )}
          </div>
        </button>

        <button
          type="button"
          className="wfs2-nav__row-menu"
          aria-label={`Actions for ${workflow.name}`}
          onClick={() => setMenuId(workflow.id)}
        >
          <Icon name="more" size={14} />
        </button>
      </article>
    )
  }

  const filterTabs = (
    <div className="wfs2-nav__tabs-scroll">
      <div className="wfs2-nav__tabs" role="tablist" aria-label="Workflow filters">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={cls('wfs2-nav__tab', tab === item.id && 'is-active')}
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id)
              closeMenu()
            }}
          >
            {item.label}
            {isMobile && (
              <span className="wfs2-nav__tab-count">{tabCounts[item.id] ?? 0}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className={cls('wfs2-nav', isMobile && 'wfs2-nav--mobile')}>
      <div className="wfs2-nav__sticky">
        {!isMobile && filterTabs}

        {isMobile ? (
          <div className="wfs2-nav__toolbar">
            <label className="wfs2-nav__search">
              <Icon name="search" size={14} />
              <input
                type="search"
                placeholder="Search flows…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search workflows"
              />
              {query && (
                <button
                  type="button"
                  className="wfs2-nav__search-clear"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </label>
            <button
              type="button"
              className="wfs2-nav__create-icon"
              disabled={busy}
              aria-label="New workflow"
              onClick={onCreate}
            >
              <Icon name="spark" size={16} />
            </button>
          </div>
        ) : (
          <>
            <input
              className="wfs2__search"
              type="search"
              placeholder="Search workflows…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className="wfs2__btn is-primary wfs2-nav__create"
              disabled={busy}
              onClick={onCreate}
            >
              <Icon name="grid" /> New Workflow
            </button>
          </>
        )}

        {isMobile && filterTabs}
      </div>

      {isMobile && menuWorkflow ? (
        <div className="wfs2-nav__action-panel">
          <button type="button" className="wfs2-nav__action-back" onClick={closeMenu}>
            <Icon name="chevron-left" size={14} />
            Back to flows
          </button>
          <div className="wfs2-nav__action-head">
            <strong>{menuWorkflow.name}</strong>
            <span>{workflowKindBadge(menuWorkflow)} · {lifecycleLabel(menuWorkflow)}</span>
          </div>
          <div className="wfs2-nav__action-list">
            {menuActions(menuWorkflow).map((action) => (
              <button
                key={action}
                type="button"
                className={cls('wfs2-nav__action-item', action === 'delete-draft' && 'is-danger')}
                disabled={busy || (menuWorkflow.is_system_template && action === 'rename')}
                onClick={() => {
                  closeMenu()
                  onAction(menuWorkflow, action)
                }}
              >
                <Icon name={ACTION_ICONS[action] ?? 'settings'} size={14} />
                <span>{ACTION_LABELS[action]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="wfs2-nav__list" ref={listRef}>
          {loading && filtered.length === 0 ? (
            <div className="wfs2__empty">Loading workflows…</div>
          ) : filtered.length === 0 ? (
            <div className="wfs2-mobile-empty">
              <Icon name="layers" size={20} />
              <strong>No flows in this view</strong>
              <p>Try another filter or create a new workflow.</p>
            </div>
          ) : (
            filtered.map((workflow) => (
              isMobile ? renderMobileRow(workflow) : renderDesktopCard(workflow)
            ))
          )}
        </div>
      )}

      {!isMobile && menuId && menuAnchor && menuWorkflow && createPortal(
        <menu
          className="wfs2-nav__menu is-portal"
          style={{
            top: menuAnchor.bottom + 6,
            left: Math.max(12, menuAnchor.right - 196),
          }}
        >
          {menuActions(menuWorkflow).map((action) => (
            <li key={action}>
              <button
                type="button"
                className={cls(action === 'delete-draft' && 'is-danger')}
                disabled={busy || (menuWorkflow.is_system_template && action === 'rename')}
                onClick={() => {
                  closeMenu()
                  onAction(menuWorkflow, action)
                }}
              >
                {ACTION_LABELS[action]}
              </button>
            </li>
          ))}
        </menu>,
        document.body,
      )}
    </div>
  )
}