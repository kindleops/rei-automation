/**
 * The canonical Deal Desk operator control surface.
 *
 * This bar is the ONE writer for lifecycle stage, operational status, lead temperature,
 * automation mode and read state. It owns no mutation logic of its own: every control is
 * a handle from `DealDeskControlsContext`, so a second surface rendering the same field
 * shares this bar's in-flight state instead of racing it.
 *
 * What changed from the pre-N.2 version, and why:
 *   - `useOptimisticField` is gone. It reassigned `previousRef.current` on every commit,
 *     so a rollback after two rapid changes restored an optimistic value the server never
 *     held; it kept the *requested* value on success rather than the server's; it did no
 *     validation; and it did not serialize, so two rapid writes raced.
 *   - `persist({ autopilot_mode })` is gone. `autopilot_mode` is a view alias on
 *     `canonical_inbox_threads`, not a column — `buildRowPatch` had no branch for it, so
 *     every automation write was accepted and dropped. The write target is
 *     `automation_state`.
 *   - The value shown for an unmapped legacy stage is now the stored value itself. The old
 *     `options.find(...) ?? options[0]` fallback rendered `mf_suppressed` as
 *     "S1 Ownership Check" — a suppression value displayed as a lifecycle position.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { LeadStateSourceView } from '../../../domain/lead-state/persistUniversalLeadState'
import type { LifecycleStageCode } from '../../../domain/lead-state/universal-lead-state-registry'
import {
  AUTOMATION_MODE_META,
  OPERATOR_SELECTABLE_AUTOMATION_MODES,
  type AutomationModeCode,
} from '../../../domain/lead-state/canonical-control-vocabularies'
import { useDealDeskControlsForThread } from '../deal-desk-controls-context'
import type { DealDeskControls } from '../useDealDeskThreadControls'
import { StageChangeConfirmModal } from './StageChangeConfirmModal'
import {
  threadStageVisuals,
  threadStatusVisuals,
  threadTemperatureVisuals,
  type PillVisual,
  type ThreadStage,
  type ThreadStatus,
  type ThreadTemperature,
} from '../status-visuals'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** Render a stored-but-unmapped value as itself, never as a canonical neighbour. */
const legacyValueLabel = (raw: string): string => (raw ? `Unsupported: ${raw}` : 'Not set')

interface PillOption<T extends string> {
  value: T
  visual: PillVisual
}

interface GlassControlProps<T extends string> {
  label: string
  value: string
  options: PillOption<T>[]
  pending: boolean
  errorMessage: string | null
  disabled: boolean
  /** The stored value has no canonical equivalent — show it verbatim, do not guess. */
  unsupportedValue?: boolean
  onChange: (next: T) => void
  onDismissError?: () => void
  className?: string
  compact?: boolean
  icon?: IconName
  testId?: string
}

function GlassControl<T extends string>({
  label,
  value,
  options,
  pending,
  errorMessage,
  disabled,
  unsupportedValue = false,
  onChange,
  onDismissError,
  className,
  compact = false,
  icon,
  testId,
}: GlassControlProps<T>) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const error = Boolean(errorMessage)
  // No `?? options[0]`: an unmatched value is reported, never substituted.
  const current = options.find((o) => o.value === value) ?? null

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
      // The menu is a PORTAL into document.body, so it is outside `btnRef`. Without this
      // check, mousedown on an option closed the menu and unmounted the option before its
      // click event could fire — every option in the dropdown was unselectable with a real
      // mouse. Component tests missed it because they dispatch `click` alone; the browser
      // verification caught it.
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const displayLabel = unsupportedValue || !current ? legacyValueLabel(value) : current.visual.label
  const dotColor = error ? '#ff453a' : current?.visual.color ?? '#9ba8c0'
  const btnStyle = current && !error && !unsupportedValue
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
        ref={menuRef}
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
    <div className={cls('nx-conv-glass-control', open && 'is-open', error && 'has-error', className)}>
      <button
        ref={btnRef}
        type="button"
        data-testid={testId}
        data-pending={pending ? 'true' : 'false'}
        data-failed={error ? 'true' : 'false'}
        data-value={value}
        className={cls('nx-conv-glass-btn', compact && 'is-compact')}
        style={btnStyle}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${displayLabel}`}
        disabled={disabled}
      >
        {pending
          ? <span className="nx-conv-glass-btn__spinner" aria-hidden="true" />
          : icon
            ? <Icon name={icon} />
            : <span className="nx-conv-glass-btn__dot" style={{ background: dotColor }} />
        }
        <span>{displayLabel}</span>
        {!disabled && <span className="nx-conv-glass-btn__caret" aria-hidden="true">▾</span>}
      </button>
      {menu}
      {errorMessage ? (
        <div className="nx-conv-control-error" role="alert" data-testid={testId ? `${testId}-error` : undefined}>
          <span>{errorMessage}</span>
          {onDismissError ? (
            <button type="button" className="nx-conv-control-error__dismiss" onClick={onDismissError} aria-label="Dismiss">
              ×
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
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

const AUTOMATION_MODE_COLORS: Record<AutomationModeCode, string> = {
  active: '#30d158',
  paused: '#ffd60a',
  human_controlled: '#9ba8c0',
  review_required: '#ff9f43',
  disabled: '#7d8797',
  completed: '#7d8797',
}

/**
 * Only operator-selectable modes are offered. `review_required`, `disabled` and
 * `completed` are system-owned: they describe a consequence of the engine's own state, and
 * they have no located `automation_state` value to persist.
 */
const AUTOMATION_OPTIONS: PillOption<AutomationModeCode>[] = OPERATOR_SELECTABLE_AUTOMATION_MODES.map((mode) => ({
  value: mode,
  visual: {
    label: AUTOMATION_MODE_META[mode].label,
    color: AUTOMATION_MODE_COLORS[mode],
    bg: `color-mix(in srgb, ${AUTOMATION_MODE_COLORS[mode]} 12%, transparent)`,
    border: `color-mix(in srgb, ${AUTOMATION_MODE_COLORS[mode]} 30%, transparent)`,
  },
}))

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

export interface ThreadStateBarProps {
  thread: InboxWorkflowThread
  /** @deprecated The provider refreshes through `onPersisted`; kept for call-site compat. */
  onRefetch?: (threadKey: string) => void
  /** @deprecated Use autopilotDisabled — state controls stay editable for universal lead state */
  disabled?: boolean
  autopilotDisabled?: boolean
  compact?: boolean
  /** @deprecated Source view is fixed to `deal_desk` for canonical writes. */
  sourceView?: LeadStateSourceView
}

export const ThreadStateBar = ({
  thread,
  disabled = false,
  autopilotDisabled = false,
  compact = false,
}: ThreadStateBarProps) => {
  const controls = useDealDeskControlsForThread(thread)

  const [stageConfirm, setStageConfirm] = useState<{ open: boolean; next: ThreadStage | null }>(
    { open: false, next: null },
  )

  // A thread switch cancels a pending stage confirmation, so a confirmation opened for one
  // conversation can never be applied to the next one. Derived from state during render
  // rather than through a ref, so it is safe under concurrent rendering.
  const threadKey = controls?.threadReference?.selectionKey ?? null
  const [confirmThreadKey, setConfirmThreadKey] = useState(threadKey)
  if (confirmThreadKey !== threadKey) {
    setConfirmThreadKey(threadKey)
    if (stageConfirm.open) setStageConfirm({ open: false, next: null })
  }

  const statusOptions = compact
    ? compactOptions(STATUS_OPTIONS, (value) => STATUS_COMPACT_LABELS[value])
    : STATUS_OPTIONS
  const stageOptions = compact
    ? compactOptions(STAGE_OPTIONS, (_value, visual) => visual.shortLabel || visual.label)
    : STAGE_OPTIONS
  const tempOptions = compact
    ? compactOptions(TEMP_OPTIONS, (value) => TEMP_COMPACT_LABELS[value])
    : TEMP_OPTIONS

  if (!controls) {
    // No provider for this conversation. Render nothing rather than fall back to a private
    // mutation path — a second writer is the defect this lane removes.
    return null
  }

  const handleStageConfirm = async () => {
    const next = stageConfirm.next
    if (!next) return
    setStageConfirm({ open: false, next: null })
    await controls.stage.commit(next)
  }

  return (
    <>
      <div
        className={cls('nx-conv-command-strip', compact && 'is-compact', controls.anyPending && 'is-syncing')}
        aria-label="Universal thread controls"
        data-testid="thread-state-bar"
      >
        {controls.unsupported ? (
          <div className="nx-conv-command-strip__unsupported" role="status" data-testid="thread-state-unsupported">
            <Icon name="alert-circle" />
            <span>{controls.unsupportedReason}</span>
          </div>
        ) : null}

        <div className="nx-conv-command-strip__primary">
          <GlassControl
            label="Conversation status"
            testId="control-operational-status"
            value={controls.status.value}
            options={statusOptions}
            pending={controls.status.pending}
            errorMessage={controls.status.errorMessage}
            unsupportedValue={controls.status.current.unsupported}
            disabled={controls.unsupported}
            className="nx-ctrl--status"
            compact={compact}
            onChange={(next) => void controls.status.commit(next)}
            onDismissError={controls.status.dismissError}
          />
          <GlassControl
            label="Acquisition stage"
            testId="control-lifecycle-stage"
            value={controls.stage.value}
            options={stageOptions}
            pending={controls.stage.pending}
            errorMessage={controls.stage.errorMessage}
            unsupportedValue={controls.stage.current.unsupported}
            disabled={controls.unsupported}
            className="nx-ctrl--stage"
            compact={compact}
            onChange={(next) => {
              if (next === controls.stage.value) return
              setStageConfirm({ open: true, next })
            }}
            onDismissError={controls.stage.dismissError}
          />
          <GlassControl
            label="Lead temperature"
            testId="control-lead-temperature"
            value={controls.temperature.value}
            options={tempOptions}
            pending={controls.temperature.pending}
            errorMessage={controls.temperature.errorMessage}
            unsupportedValue={controls.temperature.current.unsupported}
            disabled={controls.unsupported}
            className="nx-ctrl--temperature"
            compact={compact}
            onChange={(next) => void controls.temperature.commit(next)}
            onDismissError={controls.temperature.dismissError}
          />
        </div>

        {!compact && <div className="nx-conv-command-strip__spacer" aria-hidden="true" />}

        <div className="nx-conv-command-strip__automation">
          {controls.manualStageLock ? (
            <span className="nx-conv-lock-pill" title="Manual stage lock active" data-testid="manual-stage-lock">
              <Icon name="key" />
            </span>
          ) : null}
          <GlassControl
            label="Automation mode"
            testId="control-automation-mode"
            value={controls.automation.value}
            options={AUTOMATION_OPTIONS}
            pending={controls.automation.pending}
            errorMessage={controls.automation.errorMessage}
            unsupportedValue={controls.automation.current.unsupported}
            disabled={autopilotDisabled || disabled || controls.unsupported}
            className="nx-conv-auto-control"
            compact
            icon="zap"
            onChange={(next) => void controls.automation.commit(next)}
            onDismissError={controls.automation.dismissError}
          />
          {/* Queue/execution status is a different dimension from automation mode and is
              shown, never edited, beside it. */}
          {controls.queueStatus ? (
            <span className="nx-conv-queue-pill" title="Queue status" data-testid="queue-status">
              {controls.queueStatus.replace(/_/g, ' ')}
            </span>
          ) : null}
          <button
            type="button"
            className={cls('nx-conv-read-toggle', controls.read.value === 'read' && 'is-read')}
            data-testid="control-read-state"
            data-pending={controls.read.pending ? 'true' : 'false'}
            data-value={controls.read.value}
            disabled={controls.unsupported || controls.read.pending}
            aria-label={controls.read.value === 'read' ? 'Mark unread' : 'Mark read'}
            onClick={() => void (controls.read.value === 'read' ? controls.markUnread() : controls.markRead())}
          >
            <Icon name={controls.read.value === 'read' ? 'check' : 'mail'} />
            <span>{controls.read.value === 'read' ? 'Read' : 'Unread'}</span>
          </button>
          {controls.read.errorMessage ? (
            <div className="nx-conv-control-error" role="alert" data-testid="control-read-state-error">
              <span>{controls.read.errorMessage}</span>
              <button type="button" className="nx-conv-control-error__dismiss" onClick={controls.read.dismissError} aria-label="Dismiss">×</button>
            </div>
          ) : null}
        </div>
      </div>

      <StageChangeConfirmModal
        open={stageConfirm.open}
        fromStage={controls.stage.value as LifecycleStageCode}
        toStage={stageConfirm.next as LifecycleStageCode | null}
        pending={controls.stage.pending}
        onCancel={() => setStageConfirm({ open: false, next: null })}
        onChangeStageOnly={() => void handleStageConfirm()}
        onChangeStageAndRunAction={() => void handleStageConfirm()}
      />
    </>
  )
}

/**
 * Read-only mirror of the canonical state, for surfaces that display the same fields but
 * must not write them. Renders from the same handles, so it can never disagree with the
 * bar or hold its own optimistic value.
 */
export const ThreadStateMirror = ({ controls }: { controls: DealDeskControls }) => {
  const pills = useMemo(() => ([
    { key: 'stage', label: 'Stage', handle: controls.stage, visuals: threadStageVisuals as Record<string, PillVisual> },
    { key: 'status', label: 'Status', handle: controls.status, visuals: threadStatusVisuals as Record<string, PillVisual> },
    { key: 'temperature', label: 'Temperature', handle: controls.temperature, visuals: threadTemperatureVisuals as Record<string, PillVisual> },
  ]), [controls.stage, controls.status, controls.temperature])

  return (
    <div className="nx-conv-state-mirror" data-testid="thread-state-mirror">
      {pills.map(({ key, label, handle, visuals }) => {
        const visual = visuals[handle.value]
        return (
          <span
            key={key}
            className="nx-conv-state-mirror__pill"
            data-testid={`mirror-${key}`}
            data-value={handle.value}
            data-pending={handle.pending ? 'true' : 'false'}
            style={visual ? { color: visual.color, borderColor: visual.border } : undefined}
          >
            <em>{label}</em>
            <strong>{visual ? visual.label : legacyValueLabel(handle.value)}</strong>
          </span>
        )
      })}
    </div>
  )
}
