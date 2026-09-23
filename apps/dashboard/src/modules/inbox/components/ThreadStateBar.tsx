import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resolveDealDeskWritableThreadKey } from '../../../domain/inbox/deal-desk-thread-reference'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { patchLeadStateFromView, type LeadStateSourceView } from '../../../domain/lead-state/persistUniversalLeadState'
import type { LifecycleStageCode } from '../../../domain/lead-state/universal-lead-state-registry'
import { StageChangeConfirmModal } from './StageChangeConfirmModal'
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
  const panelRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setMenuPos(null)
      return
    }
    const update = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.max(rect.width, 168)

      /*
       * §30 -- OPEN INWARD, NOT OFF THE EDGE.
       *
       * `left: rect.left` anchors every menu to the LEFT of its trigger, which
       * is fine until the trigger is the automation button at the right edge
       * of the strip: a 168px menu from there runs past a 390pt viewport and
       * the actions on its right half are simply unreachable. The menu now
       * right-aligns to the trigger when there is not room to the right --
       * i.e. it opens leftward, inward -- and is clamped inside the safe area
       * either way so neither edge can clip it.
       */
      const readInset = (name: string) => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
        const n = parseFloat(raw)
        return Number.isFinite(n) ? n : 0
      }
      const safeL = readInset('--nx-mobile-safe-left') || 0
      const safeR = readInset('--nx-mobile-safe-right') || 0
      const margin = 8
      const minLeft = safeL + margin
      const maxLeft = window.innerWidth - safeR - margin - width

      let left = rect.left
      if (left > maxLeft) left = rect.right - width  // flip: open leftward
      left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft))

      // A menu opened from a control low in the viewport would otherwise run
      // under the composer and the dock.
      const top = rect.bottom + 6

      setMenuPos({ top, left, minWidth: width })
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
    const onDown = (e: Event) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      // The menu is rendered through a portal into document.body, so it is
      // NEVER inside btnRef. Checking only the trigger meant that pressing an
      // option fired mousedown -> setOpen(false) -> the option unmounted, and
      // the click never landed, so onChange never ran. Every real press of
      // Stage / Status / Temperature silently did nothing; only a synthetic
      // .click() (which skips mousedown) appeared to work.
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    // Touch devices never fire mousedown before the tap resolves, so the menu
    // also needs the touch/pointer equivalents to dismiss correctly.
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('pointerdown', onDown)
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
        ref={panelRef}
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
            onPointerDown={(e) => { e.preventDefault(); onChange(opt.value); setOpen(false) }}
            onClick={(e) => { e.preventDefault() }}
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

const STATUS_COMPACT_LABELS: Record<ThreadStatus, string> = {
  not_contacted: 'New',
  scheduled: 'Sched',
  new_reply: 'Reply',
  active_communication: 'Active',
  waiting_on_seller: 'Wait',
  follow_up_due: 'Follow',
  needs_review: 'Review',
  snoozed: 'Snooze',
  paused: 'Pause',
}

const TEMP_COMPACT_LABELS: Record<ThreadTemperature, string> = {
  unscored: '—',
  cold: 'Cold',
  warm: 'Warm',
  hot: 'Hot',
}

const compactOptions = <T extends string>(
  options: PillOption<T>[],
  labelFor: (value: T, visual: PillVisual) => string,
): PillOption<T>[] => options.map((opt) => ({
  ...opt,
  visual: { ...opt.visual, label: labelFor(opt.value, opt.visual) },
}))

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
  /** @deprecated Use autopilotDisabled — state controls stay editable for universal lead state */
  disabled?: boolean
  autopilotDisabled?: boolean
  compact?: boolean
  sourceView?: LeadStateSourceView
}

export const ThreadStateBar = ({
  thread,
  onRefetch,
  disabled = false,
  autopilotDisabled = false,
  compact = false,
  sourceView = 'thread',
}: ThreadStateBarProps) => {
  // The API rejects anything that is not a canonical phone key with
  // invalid_canonical_thread_key. thread.threadKey / thread.id can be a
  // composite selection key (ct:property:...|owner:...|phone:+1...), so passing
  // it raw meant EVERY composer state write was blocked -- and the failure was
  // swallowed, which is why changing Stage/Status/Temperature did nothing at
  // all. This is the same DD-003 resolver the read-on-open path already uses.
  const writableKey = resolveDealDeskWritableThreadKey(thread as unknown as Record<string, unknown>)
  const threadKey = writableKey?.ok ? writableKey.threadKey : (thread.threadKey || thread.id)

  const status = useOptimisticField<ThreadStatus>(resolveThreadStatus(thread))
  const stage = useOptimisticField<ThreadStage>(resolveThreadStage(thread))
  const temperature = useOptimisticField<ThreadTemperature>(resolveThreadTemperature(thread))
  const autopilot = useOptimisticField<AutopilotMode>(resolveAutopilotMode(thread))

  const [stageConfirm, setStageConfirm] = useState<{
    open: boolean
    next: ThreadStage | null
  }>({ open: false, next: null })

  const prevKeyRef = useRef(thread.id)
  if (prevKeyRef.current !== thread.id) {
    prevKeyRef.current = thread.id
    status.reset(resolveThreadStatus(thread))
    stage.reset(resolveThreadStage(thread))
    temperature.reset(resolveThreadTemperature(thread))
    autopilot.reset(resolveAutopilotMode(thread))
    setStageConfirm({ open: false, next: null })
  }

  const persist = async (
    patch: Record<string, string>,
    executeNextAction = false,
    reason = '',
  ) => {
    const result = await patchLeadStateFromView(sourceView, threadKey, patch, {
      execute_next_action: executeNextAction,
      ...(reason ? { reason } : {}),
    })

    /*
     * A GUARDED-AWAY FIELD IS NOT A SUCCESSFUL WRITE.
     *
     * The server validates a manual stage move against the canonical
     * opportunity: a backward or stage-skipping change, or any move out of a
     * terminal stage, is refused unless a reason accompanies it. On refusal it
     * DELETES lifecycle_stage from the patch, applies whatever else was in it,
     * and answers ok -- so this control showed S3, stored nothing, and snapped
     * back to S10 on the next visit. The operator was told the opposite of
     * what happened.
     *
     * The refusal is reported in `stage_guards`, so it is read here and
     * treated as the failure it is: the optimistic value is rolled back and
     * the bar resyncs against what the server actually holds.
     */
    const guards = (result as { stageGuards?: string[]; stage_guards?: string[] } | null)
    const stageGuards = guards?.stageGuards ?? guards?.stage_guards ?? []
    const stageRefused = 'lifecycle_stage' in patch
      && stageGuards.some((guard) => /stage|transition|reason/i.test(String(guard)))

    if (stageRefused) {
      onRefetch?.(threadKey)
      return { ok: false, refusal: stageGuards[0] ?? 'stage_change_refused' }
    }
    // Deliberately NOT refetching on success. useOptimisticField has already
    // committed the chosen value and the server has confirmed it, so the
    // control is correct. Refetching re-rendered this bar from the list row,
    // and the list row does not carry operational_status / seller_stage /
    // lead_temperature -- so the refresh replaced a correct value with a stale
    // one and the control snapped back. That is exactly what "nothing changes"
    // looked like: the write landed every time, the refresh undid the display.
    //
    // Only a FAILED write refetches, to resync against whatever the server
    // actually holds.
    if (!result.ok) onRefetch?.(threadKey)
    return { ok: result.ok }
  }

  const handleStageChangeRequest = (next: ThreadStage) => {
    if (next === stage.value) return
    setStageConfirm({ open: true, next })
  }

  const handleStageCancel = () => {
    setStageConfirm({ open: false, next: null })
  }

  const handleStageConfirm = async (executeNextAction: boolean, reason = '') => {
    const next = stageConfirm.next
    if (!next) return
    setStageConfirm({ open: false, next: null })
    await stage.commit(next, () => persist({ lifecycle_stage: next }, executeNextAction, reason))
  }

  const anyPending = status.pending || stage.pending || temperature.pending || autopilot.pending
  const statusOptions = compact
    ? compactOptions(STATUS_OPTIONS, (value) => STATUS_COMPACT_LABELS[value])
    : STATUS_OPTIONS
  /*
   * §11 -- "S2" ON ITS OWN IS A MACHINE ENUM.
   *
   * The compact bar was rendering only the short code, so the surface where an
   * operator decides what to say next said "S2" and nothing else. The full
   * label already exists on the same visual -- this is the canonical lifecycle
   * definition, unchanged -- so the pill reads "S2 · Interest Probe". The code
   * stays in front because operators use it as the handle.
   */
  const stageOptions = compact
    ? compactOptions(STAGE_OPTIONS, (_value, visual) => (
      visual.shortLabel && visual.label && visual.label !== visual.shortLabel
        ? `${visual.shortLabel} · ${visual.label.replace(`${visual.shortLabel} `, '')}`
        : visual.shortLabel || visual.label
    ))
    : STAGE_OPTIONS
  const tempOptions = compact
    ? compactOptions(TEMP_OPTIONS, (value) => TEMP_COMPACT_LABELS[value])
    : TEMP_OPTIONS

  return (
    <>
      <div className={cls(
        'nx-conv-command-strip',
        compact && 'is-compact',
        anyPending && 'is-syncing',
      )} aria-label="Universal thread controls">
        <div className="nx-conv-command-strip__primary">
          <GlassControl
            label="Conversation status"
            value={status.value}
            options={statusOptions}
            pending={status.pending}
            error={status.error}
            disabled={false}
            className="nx-ctrl--status"
            compact={compact}
            onChange={(next) => status.commit(next, () => persist({ operational_status: next }))}
          />
          <GlassControl
            label="Acquisition stage"
            value={stage.value}
            options={stageOptions}
            pending={stage.pending}
            error={stage.error}
            disabled={false}
            className="nx-ctrl--stage"
            compact={compact}
            onChange={handleStageChangeRequest}
          />
          <GlassControl
            label="Lead temperature"
            value={temperature.value}
            options={tempOptions}
            pending={temperature.pending}
            error={temperature.error}
            disabled={false}
            className="nx-ctrl--temperature"
            compact={compact}
            onChange={(next) => temperature.commit(next, () => persist({ lead_temperature: next }))}
          />
        </div>
        {!compact && <div className="nx-conv-command-strip__spacer" aria-hidden="true" />}
        <GlassControl
          label="Automation state"
          value={autopilot.value}
          options={AUTO_OPTIONS}
          pending={autopilot.pending}
          error={autopilot.error}
          disabled={autopilotDisabled || disabled}
          className="nx-conv-auto-control"
          compact
          icon="zap"
          onChange={(next) => autopilot.commit(next, () => persist({ autopilot_mode: next }))}
        />
      </div>

      <StageChangeConfirmModal
        open={stageConfirm.open}
        fromStage={stage.value as LifecycleStageCode}
        toStage={stageConfirm.next as LifecycleStageCode | null}
        pending={stage.pending}
        onCancel={handleStageCancel}
        onChangeStageOnly={(reason) => void handleStageConfirm(false, reason)}
        onChangeStageAndRunAction={(reason) => void handleStageConfirm(true, reason)}
      />
    </>
  )
}