import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Workflow, WorkflowDetail } from '../workflow.types'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type WorkflowMobilePanel = 'canvas' | 'workflows' | 'nodes' | 'inspect' | 'console'

interface WorkflowMobileHeaderProps {
  detail: WorkflowDetail | null
  busy?: boolean
  validationCount: number
  liveMode: boolean
  consoleOpen: boolean
  onDryRun: () => void
  onToggleConsole: () => void
  onToggleLiveMode: () => void
  onOpenActions: () => void
}

function formatStatus(workflow?: Workflow) {
  return workflow?.operational_mode ?? workflow?.status ?? 'draft'
}

export function WorkflowMobileHeader({
  detail,
  busy,
  validationCount,
  liveMode,
  consoleOpen,
  onDryRun,
  onToggleConsole,
  onToggleLiveMode,
  onOpenActions,
}: WorkflowMobileHeaderProps) {
  const workflow = detail?.workflow

  return (
    <header className="wfs2-mobile-hero">
      <div className="wfs2-mobile-hero__top">
        <div className="wfs2-mobile-hero__identity">
          <Icon name="grid" size={16} />
          <div>
            <strong>{workflow?.name ?? 'Workflow Studio'}</strong>
            <span>
              {workflow?.channel ?? 'sms'} · v{workflow?.version ?? '1'}
              {validationCount > 0 ? ` · ${validationCount} issues` : ''}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="wfs2-mobile-hero__menu"
          onClick={onOpenActions}
          aria-label="Workflow actions"
        >
          <Icon name="more" size={16} />
        </button>
      </div>

      <div className="wfs2-mobile-hero__chips">
        <span className={cls('wfs2-mobile-hero__badge', workflow && `is-${workflow.status}`)}>
          {formatStatus(workflow)}
        </span>
        {workflow?.is_system_template && <span className="wfs2-mobile-hero__chip">System</span>}
        {workflow?.live_send_enabled === false && (
          <span className="wfs2-mobile-hero__chip is-safe">Live blocked</span>
        )}
        {liveMode && <span className="wfs2-mobile-hero__chip is-live">Live overlay</span>}
        {consoleOpen && <span className="wfs2-mobile-hero__chip is-console">Console</span>}
      </div>

      <div className="wfs2-mobile-hero__actions">
        <button type="button" className="wfs2-mobile-hero__action" disabled={busy || !detail} onClick={onDryRun}>
          <Icon name="eye" size={14} />
          Dry run
        </button>
        <button
          type="button"
          className={cls('wfs2-mobile-hero__action', liveMode && 'is-active')}
          disabled={!detail}
          onClick={onToggleLiveMode}
        >
          <Icon name="radar" size={14} />
          Live
        </button>
        <button
          type="button"
          className={cls('wfs2-mobile-hero__action', consoleOpen && 'is-active')}
          disabled={!detail}
          onClick={onToggleConsole}
        >
          <Icon name="activity" size={14} />
          Console
        </button>
      </div>
    </header>
  )
}

interface WorkflowMobileDockProps {
  active: WorkflowMobilePanel
  hasSelection: boolean
  onSelect: (panel: WorkflowMobilePanel) => void
}

const DOCK_ITEMS: Array<{ id: WorkflowMobilePanel; label: string; icon: 'grid' | 'layers' | 'bolt' | 'settings' | 'activity' }> = [
  { id: 'canvas', label: 'Canvas', icon: 'grid' },
  { id: 'workflows', label: 'Flows', icon: 'layers' },
  { id: 'nodes', label: 'Nodes', icon: 'bolt' },
  { id: 'inspect', label: 'Inspect', icon: 'settings' },
  { id: 'console', label: 'Log', icon: 'activity' },
]

const DOCK_HINTS: Partial<Record<WorkflowMobilePanel, string>> = {
  workflows: 'Switch flow',
  nodes: 'Add step',
  inspect: 'Node config',
  console: 'Run log',
}

export function WorkflowMobileDock({ active, hasSelection, onSelect }: WorkflowMobileDockProps) {
  return (
    <nav className="wfs2-mobile-dock" aria-label="Workflow studio sections">
      <div className="wfs2-mobile-dock__inner">
        {DOCK_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cls(
              'wfs2-mobile-dock__btn',
              active === item.id && 'is-active',
              item.id === 'inspect' && hasSelection && 'has-selection',
            )}
            onClick={() => onSelect(item.id)}
            aria-label={DOCK_HINTS[item.id] ? `${item.label} — ${DOCK_HINTS[item.id]}` : item.label}
          >
            <span className="wfs2-mobile-dock__icon">
              <Icon name={item.icon} size={17} />
              {item.id === 'inspect' && hasSelection && (
                <span className="wfs2-mobile-dock__dot" aria-hidden />
              )}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

interface WorkflowMobileSheetProps {
  open: boolean
  title: string
  subtitle?: string
  badge?: string | number
  tone?: 'default' | 'flows' | 'nodes' | 'inspect'
  onClose: () => void
  children: ReactNode
}

export function WorkflowMobileSheet({
  open,
  title,
  subtitle,
  badge,
  tone = 'default',
  onClose,
  children,
}: WorkflowMobileSheetProps) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="wfs2-mobile-sheet-root" role="presentation">
      <button type="button" className="wfs2-mobile-sheet__backdrop" aria-label="Close panel" onClick={onClose} />
      <div className={cls('wfs2-mobile-sheet', `is-tone-${tone}`)} role="dialog" aria-label={title}>
        <div className="wfs2-mobile-sheet__handle" aria-hidden />
        <header className="wfs2-mobile-sheet__header">
          <div>
            <div className="wfs2-mobile-sheet__title-row">
              <strong>{title}</strong>
              {badge != null && badge !== '' && (
                <span className="wfs2-mobile-sheet__badge">{badge}</span>
              )}
            </div>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button type="button" className="wfs2-mobile-sheet__close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="wfs2-mobile-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

interface WorkflowMobileActionsSheetProps {
  open: boolean
  busy?: boolean
  detail: WorkflowDetail | null
  validationCount: number
  onClose: () => void
  onClone: () => void
  onPause: () => void
  onResume: () => void
  onPublish: () => void
  onGoLive: () => void
}

export function WorkflowMobileActionsSheet({
  open,
  busy,
  detail,
  validationCount,
  onClose,
  onClone,
  onPause,
  onResume,
  onPublish,
  onGoLive,
}: WorkflowMobileActionsSheetProps) {
  const workflow = detail?.workflow
  const paused = workflow?.status === 'paused' || workflow?.operational_mode === 'paused'
  const publishable = workflow?.status === 'draft' || workflow?.operational_mode === 'draft'
  const liveReady = workflow && !workflow.is_system_template
    && (workflow.status === 'active' || workflow.operational_mode === 'armed')
    && workflow.live_send_enabled === true

  return (
    <WorkflowMobileSheet open={open} title="Workflow actions" subtitle={workflow?.name} tone="inspect" onClose={onClose}>
      <div className="wfs2-mobile-actions">
        <button type="button" className="wfs2-mobile-actions__btn is-primary" disabled={busy || !detail || !liveReady} onClick={() => { onGoLive(); onClose() }}>
          <span className="wfs2-mobile-actions__icon"><Icon name="zap" size={15} /></span>
          <span className="wfs2-mobile-actions__copy">
            <strong>Go live</strong>
            <small>Enable live sends for this workflow</small>
          </span>
        </button>
        <button type="button" className="wfs2-mobile-actions__btn" disabled={busy || !detail || !publishable} onClick={() => { onPublish(); onClose() }}>
          <span className="wfs2-mobile-actions__icon"><Icon name="check-double" size={15} /></span>
          <span className="wfs2-mobile-actions__copy">
            <strong>Publish {validationCount > 0 ? `(${validationCount})` : ''}</strong>
            <small>Validate and publish draft changes</small>
          </span>
        </button>
        <button type="button" className="wfs2-mobile-actions__btn" disabled={busy || !detail} onClick={() => { onClone(); onClose() }}>
          <span className="wfs2-mobile-actions__icon"><Icon name="layers" size={15} /></span>
          <span className="wfs2-mobile-actions__copy">
            <strong>Clone workflow</strong>
            <small>Create an editable copy</small>
          </span>
        </button>
        {paused ? (
          <button type="button" className="wfs2-mobile-actions__btn" disabled={busy || !detail} onClick={() => { onResume(); onClose() }}>
            <span className="wfs2-mobile-actions__icon"><Icon name="play" size={15} /></span>
            <span className="wfs2-mobile-actions__copy">
              <strong>Resume</strong>
              <small>Restart paused enrollments</small>
            </span>
          </button>
        ) : (
          <button type="button" className="wfs2-mobile-actions__btn" disabled={busy || !detail} onClick={() => { onPause(); onClose() }}>
            <span className="wfs2-mobile-actions__icon"><Icon name="pause" size={15} /></span>
            <span className="wfs2-mobile-actions__copy">
              <strong>Pause</strong>
              <small>Hold new runs without losing state</small>
            </span>
          </button>
        )}
      </div>
    </WorkflowMobileSheet>
  )
}