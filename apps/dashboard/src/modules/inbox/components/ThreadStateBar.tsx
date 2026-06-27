import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { updateThreadState } from '../../../lib/api/backendClient'
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

interface PillOption<T extends string> {
  value: T
  visual: PillVisual
}

interface GlassControlProps<T extends string> {
  label: string
  value: T
  options: PillOption<T>[]
  pending: boolean
  error: boolean
  disabled: boolean
  onChange: (next: T) => void
  className?: string
  compact?: boolean
  icon?: IconName
}

function GlassControl<T extends string>({
  label,
  value,
  options,
  pending,
  error,
  disabled,
  onChange,
  className,
  compact = false,
  icon,
}: GlassControlProps<T>) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setMenuPos(null)
      return
    }
    const update = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({ top: rect.bottom + 6, left: rect.left, minWidth: Math.max(rect.width, 168) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const dotColor = error ? '#ff453a' : current?.visual.color ?? 'var(--nx-accent, #3b82f6)'
  const btnStyle = current && !error
    ? ({
        '--ctrl-color': current.visual.color,
        '--ctrl-bg': current.visual.bg,
        '--ctrl-border': current.visual.border,
        color: current.visual.color,
        borderColor: current.visual.border,
        background: `color-mix(in srgb, ${current.visual.bg} 72%, transparent)`,
      } as React.CSSProperties)
    : error
      ? { color: '#ff453a', borderColor: 'rgba(255,69,58,0.3)', background: 'rgba(255,69,58,0.08)' }
      : undefined

  const menu = open && menuPos && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="nx-conv-dropdown-portal"
        role="listbox"
        aria-label={label}
        style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.minWidth }}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={opt.value === value}
            className={cls('nx-conv-dropdown-option', opt.value === value && 'is-selected')}
            onClick={() => { onChange(opt.value); setOpen(false) }}
          >
            <span className="nx-conv-dropdown-option__dot" style={{ background: opt.visual.color }} />
            <span>{opt.visual.label}</span>
            {opt.value === value && <span className="nx-conv-dropdown-option__check">✓</span>}
          </button>
        ))}
      </div>,
      document.body,
    )
    : null

  return (
    <div className={cls('nx-conv-glass-control', open && 'is-open', className)}>
      <button
        ref={btnRef}
        type="button"
        className={cls('nx-conv-glass-btn', compact && 'is-compact')}
        style={btnStyle}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${error ? 'Failed' : current?.visual.label}`}
        disabled={disabled}
      >
        {pending
          ? <span className="nx-conv-glass-btn__spinner" aria-hidden="true" />
          : icon
            ? <Icon name={icon} />
            : <span className="nx-conv-glass-btn__dot" style={{ background: dotColor }} />
        }
        <span>{error ? 'Failed' : current?.visual.label}</span>
        {!disabled && <span className="nx-conv-glass-btn__caret" aria-hidden="true">▾</span>}
      </button>
      {menu}
    </div>
  )
}

const AUTOPILOT_SHORT_LABELS: Record<AutopilotMode, string> = {
  autopilot_on: 'Autopilot',
  autopilot_paused: 'Paused',
  manual_only: 'Manual',
}

const STATUS_OPTIONS: PillOption<ThreadStatus>[] = (Object.keys(threadStatusVisuals) as ThreadStatus[]).map(
  (v) => ({ value: v, visual: threadStatusVisuals[v] }),
)

const STAGE_OPTIONS: PillOption<ThreadStage>[] = (Object.keys(threadStageVisuals) as ThreadStage[]).map(
  (v) => ({ value: v, visual: threadStageVisuals[v] }),
)

const TEMP_OPTIONS: PillOption<ThreadTemperature>[] = (
  ['unscored', 'cold', 'warm', 'hot'] as ThreadTemperature[]
).map((v) => ({ value: v, visual: threadTemperatureVisuals[v] }))

const AUTO_OPTIONS: PillOption<AutopilotMode>[] = (Object.keys(autopilotModeVisuals) as AutopilotMode[]).map(
  (v) => ({
    value: v,
    visual: {
      ...autopilotModeVisuals[v],
      label: AUTOPILOT_SHORT_LABELS[v],
    },
  }),
)

function useOptimisticField<T extends string>(initial: T) {
  const [value, setValue] = useState<T>(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const previousRef = useRef<T>(initial)

  const commit = async (next: T, persist: () => Promise<{ ok: boolean }>) => {
    previousRef.current = value
    setValue(next)
    setPending(true)
    setError(false)
    const result = await persist()
    setPending(false)
    if (!result.ok) {
      setValue(previousRef.current)
      setError(true)
      setTimeout(() => setError(false), 3000)
    }
  }

  const reset = (next: T) => { setValue(next); setPending(false); setError(false); previousRef.current = next }

  return { value, pending, error, commit, reset }
}

export interface ThreadStateBarProps {
  thread: InboxWorkflowThread
  onRefetch?: (threadKey: string) => void
  disabled?: boolean
}

export const ThreadStateBar = ({ thread, onRefetch, disabled = false }: ThreadStateBarProps) => {
  const threadKey = thread.threadKey || thread.id

  const status = useOptimisticField<ThreadStatus>(resolveThreadStatus(thread))
  const stage = useOptimisticField<ThreadStage>(resolveThreadStage(thread))
  const temperature = useOptimisticField<ThreadTemperature>(resolveThreadTemperature(thread))
  const autopilot = useOptimisticField<AutopilotMode>(resolveAutopilotMode(thread))

  const prevKeyRef = useRef(thread.id)
  if (prevKeyRef.current !== thread.id) {
    prevKeyRef.current = thread.id
    status.reset(resolveThreadStatus(thread))
    stage.reset(resolveThreadStage(thread))
    temperature.reset(resolveThreadTemperature(thread))
    autopilot.reset(resolveAutopilotMode(thread))
  }

  const persist = async (patch: Record<string, string>) => {
    const result = await updateThreadState(threadKey, patch)
    if (result.ok) onRefetch?.(threadKey)
    return result
  }

  const anyPending = status.pending || stage.pending || temperature.pending || autopilot.pending

  return (
    <div className={cls('nx-conv-command-strip', anyPending && 'is-syncing')} aria-label="Universal thread controls">
      <div className="nx-conv-command-strip__primary">
        <GlassControl
          label="Conversation status"
          value={status.value}
          options={STATUS_OPTIONS}
          pending={status.pending}
          error={status.error}
          disabled={disabled}
          className="nx-ctrl--status"
          onChange={(next) => status.commit(next, () => persist({ operational_status: next, conversation_status: next }))}
        />
        <GlassControl
          label="Acquisition stage"
          value={stage.value}
          options={STAGE_OPTIONS}
          pending={stage.pending}
          error={stage.error}
          disabled={disabled}
          className="nx-ctrl--stage"
          onChange={(next) => stage.commit(next, () => persist({ lifecycle_stage: next, seller_stage: next }))}
        />
        <GlassControl
          label="Lead temperature"
          value={temperature.value}
          options={TEMP_OPTIONS}
          pending={temperature.pending}
          error={temperature.error}
          disabled={disabled}
          className="nx-ctrl--temperature"
          onChange={(next) => temperature.commit(next, () => persist({ lead_temperature: next, temperature: next }))}
        />
      </div>
      <div className="nx-conv-command-strip__spacer" aria-hidden="true" />
      <GlassControl
        label="Automation state"
        value={autopilot.value}
        options={AUTO_OPTIONS}
        pending={autopilot.pending}
        error={autopilot.error}
        disabled={disabled}
        className="nx-conv-auto-control"
        compact
        icon="zap"
        onChange={(next) => autopilot.commit(next, () => persist({ autopilot_mode: next }))}
      />
    </div>
  )
}