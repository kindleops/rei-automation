import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
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
  refreshing?: boolean
  busy?: boolean
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

export const WorkflowNavigatorV2 = ({
  workflows,
  selectedId,
  loading,
  refreshing = false,
  busy,
  onSelect,
  onCreate,
  onAction,
}: WorkflowNavigatorV2Props) => {
  const [tab, setTab] = useState<NavigatorTab>('all')
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

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

  return (
    <div className="wfs2-nav">
      <div className="wfs2-nav__tabs" role="tablist" aria-label="Workflow filters">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={cls('wfs2-nav__tab', tab === item.id && 'is-active')}
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

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

      {refreshing ? <div className="wfs2-nav__refresh" aria-live="polite">Refreshing catalog…</div> : null}

      <div className="wfs2-nav__list" ref={listRef}>
        {loading && filtered.length === 0 ? (
          <div className="wfs2-nav__skeletons" aria-hidden>
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="wfs2-nav__card is-skeleton" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="wfs2__empty">No workflows in this view.</div>
        ) : (
          filtered.map((workflow) => {
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
                        setMenuId(null)
                        setMenuAnchor(null)
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
          })
        )}
      </div>

      {menuId && menuAnchor && (() => {
        const workflow = workflows.find((row) => row.id === menuId)
        if (!workflow) return null
        return createPortal(
          <menu
            className="wfs2-nav__menu is-portal"
            style={{
              top: menuAnchor.bottom + 6,
              left: Math.max(12, menuAnchor.right - 196),
            }}
          >
            {menuActions(workflow).map((action) => (
              <li key={action}>
                <button
                  type="button"
                  className={cls(action === 'delete-draft' && 'is-danger')}
                  disabled={busy || (workflow.is_system_template && action === 'rename')}
                  onClick={() => {
                    setMenuId(null)
                    setMenuAnchor(null)
                    onAction(workflow, action)
                  }}
                >
                  {ACTION_LABELS[action]}
                </button>
              </li>
            ))}
          </menu>,
          document.body,
        )
      })()}
    </div>
  )
}