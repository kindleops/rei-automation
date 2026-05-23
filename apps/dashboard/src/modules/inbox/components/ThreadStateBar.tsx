import { useEffect, useRef, useState } from 'react'
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

// ── DropdownPill ─────────────────────────────────────────────────────────────

interface PillOption<T extends string> {
  value: T
  visual: PillVisual
}

interface DropdownPillProps<T extends string> {
  label: string
  value: T
  options: PillOption<T>[]
  pending: boolean
  error: boolean
  disabled: boolean
  onChange: (next: T) => void
  className?: string
}

function DropdownPill<T extends string>({
  label,
  value,
  options,
  pending,
  error,
  disabled,
  onChange,
  className,
}: DropdownPillProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open])

  const pillStyle = current && !error
    ? { color: current.visual.color, background: current.visual.bg, borderColor: current.visual.border }
    : error
      ? { color: '#ff453a', background: 'rgba(255,69,58,0.1)', borderColor: 'rgba(255,69,58,0.3)' }
      : {}

  return (
    <div
      ref={rootRef}
      className={cls('nx-state-pill-wrap', open && 'is-open', pending && 'is-pending', error && 'is-error', className)}
      title={label}
    >
      <button
        type="button"
        className="nx-state-pill"
        style={pillStyle}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.visual.label}`}
        disabled={disabled}
      >
        {pending
          ? <span className="nx-state-pill__spinner" aria-hidden="true" />
          : <span className="nx-state-pill__dot" style={{ background: error ? '#ff453a' : current?.visual.color }} />
        }
        <span className="nx-state-pill__label">{error ? 'Failed' : current?.visual.label}</span>
        {!disabled && <span className="nx-state-pill__caret" aria-hidden="true">▾</span>}
      </button>

      {open && (
        <div className="nx-state-pill__dropdown" role="listbox" aria-label={label}>
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
              {opt.value === value && <span className="nx-state-pill__option-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Option lists (stable, module-level) ──────────────────────────────────────

const STATUS_OPTIONS: PillOption<ThreadStatus>[] = (Object.keys(threadStatusVisuals) as ThreadStatus[]).map(
  (v) => ({ value: v, visual: threadStatusVisuals[v] }),
)

const STAGE_OPTIONS: PillOption<ThreadStage>[] = (Object.keys(threadStageVisuals) as ThreadStage[]).map(
  (v) => ({ value: v, visual: threadStageVisuals[v] }),
)

// Temperature: Hot / Warm / Cold only (Dead is a system state, not operator-set)
const TEMP_OPTIONS: PillOption<ThreadTemperature>[] = (['hot', 'warm', 'cold'] as ThreadTemperature[]).map(
  (v) => ({ value: v, visual: threadTemperatureVisuals[v] }),
)

const AUTO_OPTIONS: PillOption<AutopilotMode>[] = (Object.keys(autopilotModeVisuals) as AutopilotMode[]).map(
  (v) => ({ value: v, visual: autopilotModeVisuals[v] }),
)

// ── Pill state with optimistic update + rollback ──────────────────────────────

type PendingField = 'status' | 'stage' | 'temperature' | 'autopilot' | null

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
      setValue(previousRef.current) // rollback
      setError(true)
      setTimeout(() => setError(false), 3000)
    }
  }

  const reset = (next: T) => { setValue(next); setPending(false); setError(false); previousRef.current = next }

  return { value, pending, error, commit, reset }
}

// ── ThreadStateBar ────────────────────────────────────────────────────────────

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

  // Reset all fields when the thread identity changes
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
    <div className={cls('nx-thread-state-bar', anyPending && 'is-syncing')} aria-label="Thread state controls">
      <DropdownPill
        label="Status"
        value={status.value}
        options={STATUS_OPTIONS}
        pending={status.pending}
        error={status.error}
        disabled={disabled}
        className="nx-pill--status"
        onChange={(next) => status.commit(next, () => persist({ conversation_status: next }))}
      />
      <DropdownPill
        label="Stage"
        value={stage.value}
        options={STAGE_OPTIONS}
        pending={stage.pending}
        error={stage.error}
        disabled={disabled}
        className="nx-pill--stage"
        onChange={(next) => stage.commit(next, () => persist({ seller_stage: next }))}
      />
      <DropdownPill
        label="Temperature"
        value={temperature.value}
        options={TEMP_OPTIONS}
        pending={temperature.pending}
        error={temperature.error}
        disabled={disabled}
        className="nx-pill--temperature"
        onChange={(next) => temperature.commit(next, () => persist({ temperature: next }))}
      />
      <DropdownPill
        label="Autopilot"
        value={autopilot.value}
        options={AUTO_OPTIONS}
        pending={autopilot.pending}
        error={autopilot.error}
        disabled={disabled}
        className="nx-pill--autopilot"
        onChange={(next) => autopilot.commit(next, () => persist({ autopilot_mode: next }))}
      />
    </div>
  )
}
