import { useEffect, useRef, useState } from 'react'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import {
  autopilotModeVisuals,
  resolveAutopilotMode,
  resolveThreadStage,
  resolveThreadStatus,
  resolveThreadTemperature,
  threadStageVisuals,
  threadStatusVisuals,
  threadTemperatureVisuals,
  type AutopilotMode,
  type PillVisual,
  type ThreadStage,
  type ThreadStatus,
  type ThreadTemperature,
} from '../status-visuals'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

// ── DropdownPill ─────────────────────────────────────────────────────────────

interface PillOption<T extends string> {
  value: T
  visual: PillVisual
}

interface DropdownPillProps<T extends string> {
  value: T
  options: PillOption<T>[]
  onChange: (next: T) => void
  disabled?: boolean
  className?: string
}

function DropdownPill<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
}: DropdownPillProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const handleClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  const pillStyle = current
    ? { color: current.visual.color, background: current.visual.bg, borderColor: current.visual.border }
    : {}

  return (
    <div ref={rootRef} className={cls('nx-state-pill-wrap', open && 'is-open', className)}>
      <button
        type="button"
        className="nx-state-pill"
        style={pillStyle}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className="nx-state-pill__dot" style={{ background: current?.visual.color }} />
        <span className="nx-state-pill__label">{current?.visual.label}</span>
        {!disabled && <span className="nx-state-pill__caret" aria-hidden="true">▾</span>}
      </button>

      {open && (
        <div className="nx-state-pill__dropdown" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={cls('nx-state-pill__option', opt.value === value && 'is-selected')}
              style={{ '--opt-color': opt.visual.color, '--opt-bg': opt.visual.bg } as React.CSSProperties}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              <span className="nx-state-pill__option-dot" style={{ background: opt.visual.color }} />
              <span>{opt.visual.label}</span>
              {opt.value === value && <span className="nx-state-pill__option-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Option lists ─────────────────────────────────────────────────────────────

const STATUS_OPTIONS: PillOption<ThreadStatus>[] = (Object.keys(threadStatusVisuals) as ThreadStatus[]).map(
  (v) => ({ value: v, visual: threadStatusVisuals[v] }),
)

const STAGE_OPTIONS: PillOption<ThreadStage>[] = (Object.keys(threadStageVisuals) as ThreadStage[]).map(
  (v) => ({ value: v, visual: threadStageVisuals[v] }),
)

const TEMP_OPTIONS: PillOption<ThreadTemperature>[] = (Object.keys(threadTemperatureVisuals) as ThreadTemperature[]).map(
  (v) => ({ value: v, visual: threadTemperatureVisuals[v] }),
)

const AUTO_OPTIONS: PillOption<AutopilotMode>[] = (Object.keys(autopilotModeVisuals) as AutopilotMode[]).map(
  (v) => ({ value: v, visual: autopilotModeVisuals[v] }),
)

// ── Quick action config ───────────────────────────────────────────────────────

interface QuickAction {
  id: string
  label: string
  icon: string
  variant: 'default' | 'hot' | 'cold' | 'danger' | 'muted' | 'accent'
}

const QUICK_ACTIONS: QuickAction[] = [
  { id: 'mark_hot',    label: 'Mark Hot',   icon: '🔥', variant: 'hot' },
  { id: 'mark_cold',   label: 'Mark Cold',  icon: '🥶', variant: 'cold' },
  { id: 'follow_up',   label: 'Follow Up',  icon: '⏰', variant: 'default' },
  { id: 'archive',     label: 'Archive',    icon: '📦', variant: 'muted' },
  { id: 'dnc',         label: 'DNC',        icon: '🚫', variant: 'danger' },
  { id: 'pause',       label: 'Pause',      icon: '⏸',  variant: 'muted' },
  { id: 'autopilot',   label: 'Autopilot',  icon: '🤖', variant: 'accent' },
  { id: 'underwrite',  label: 'Underwrite', icon: '📋', variant: 'default' },
  { id: 'comps',       label: 'Comps',      icon: '🏠', variant: 'default' },
]

// ── ThreadStateBar ────────────────────────────────────────────────────────────

export interface ThreadStateBarProps {
  thread: InboxWorkflowThread
  onAction: (threadId: string, action: string, payload?: Record<string, unknown>) => void
  disabled?: boolean
}

export const ThreadStateBar = ({ thread, onAction, disabled = false }: ThreadStateBarProps) => {
  const [status, setStatus] = useState<ThreadStatus>(() => resolveThreadStatus(thread))
  const [stage, setStage] = useState<ThreadStage>(() => resolveThreadStage(thread))
  const [temperature, setTemperature] = useState<ThreadTemperature>(() => resolveThreadTemperature(thread))
  const [autopilot, setAutopilot] = useState<AutopilotMode>(() => resolveAutopilotMode(thread))

  // Sync when thread identity changes
  const prevIdRef = useRef(thread.id)
  if (prevIdRef.current !== thread.id) {
    prevIdRef.current = thread.id
    // Reset to derived values on thread switch
    setStatus(resolveThreadStatus(thread))
    setStage(resolveThreadStage(thread))
    setTemperature(resolveThreadTemperature(thread))
    setAutopilot(resolveAutopilotMode(thread))
  }

  const handleStatusChange = (next: ThreadStatus) => {
    setStatus(next)
    onAction(thread.id, 'set_status', { status: next })
  }

  const handleStageChange = (next: ThreadStage) => {
    setStage(next)
    onAction(thread.id, 'set_stage', { stage: next })
  }

  const handleTemperatureChange = (next: ThreadTemperature) => {
    setTemperature(next)
    onAction(thread.id, 'set_temperature', { temperature: next })
  }

  const handleAutopilotChange = (next: AutopilotMode) => {
    setAutopilot(next)
    onAction(thread.id, 'set_autopilot', { autopilot: next })
  }

  const handleQuickAction = (actionId: string) => {
    // Optimistic state side-effects
    if (actionId === 'mark_hot') { setTemperature('hot'); onAction(thread.id, 'set_temperature', { temperature: 'hot' }); return }
    if (actionId === 'mark_cold') { setTemperature('cold'); onAction(thread.id, 'set_temperature', { temperature: 'cold' }); return }
    if (actionId === 'follow_up') { setStatus('follow_up'); onAction(thread.id, 'set_status', { status: 'follow_up' }); return }
    if (actionId === 'pause') { setAutopilot('autopilot_paused'); onAction(thread.id, 'set_autopilot', { autopilot: 'autopilot_paused' }); return }
    if (actionId === 'autopilot') { setAutopilot('autopilot_on'); onAction(thread.id, 'set_autopilot', { autopilot: 'autopilot_on' }); return }
    if (actionId === 'dnc') { onAction(thread.id, 'suppress'); return }
    if (actionId === 'archive') { onAction(thread.id, 'archive'); return }
    onAction(thread.id, actionId)
  }

  return (
    <div className="nx-thread-state-bar">
      {/* ── Pill row ─────────────────────────────────────────────────── */}
      <div className="nx-thread-state-bar__pills" role="toolbar" aria-label="Thread state">
        <DropdownPill
          value={status}
          options={STATUS_OPTIONS}
          onChange={handleStatusChange}
          disabled={disabled}
          className="nx-pill--status"
        />
        <DropdownPill
          value={stage}
          options={STAGE_OPTIONS}
          onChange={handleStageChange}
          disabled={disabled}
          className="nx-pill--stage"
        />
        <DropdownPill
          value={temperature}
          options={TEMP_OPTIONS}
          onChange={handleTemperatureChange}
          disabled={disabled}
          className="nx-pill--temperature"
        />
        <DropdownPill
          value={autopilot}
          options={AUTO_OPTIONS}
          onChange={handleAutopilotChange}
          disabled={disabled}
          className="nx-pill--autopilot"
        />
      </div>

      {/* ── Quick action bar ──────────────────────────────────────────── */}
      <div className="nx-thread-state-bar__actions" role="toolbar" aria-label="Quick actions">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            className={cls('nx-quick-action', `nx-quick-action--${action.variant}`)}
            onClick={() => handleQuickAction(action.id)}
            title={action.label}
          >
            <span className="nx-quick-action__icon" aria-hidden="true">{action.icon}</span>
            <span className="nx-quick-action__label">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
