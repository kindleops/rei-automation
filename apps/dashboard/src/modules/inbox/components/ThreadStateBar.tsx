import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import {
  patchLeadStateFromView,
  type LeadStateSourceView,
  type UniversalLeadStateMeta,
  type UniversalLeadStateMutationResult,
} from '../../../domain/lead-state/persistUniversalLeadState'
import {
  AUTOMATION_MODE_META,
  OPERATOR_SELECTABLE_AUTOMATION_MODES,
  resolveLeadTemperatureForWrite,
  resolveLifecycleStageForWrite,
  resolveOperationalStatusForWrite,
  resolveOperatorAutomationMode,
  type VocabularyResolution,
} from '../../../domain/lead-state/canonical-control-vocabularies'
import {
  LEAD_TEMPERATURE_ORDER,
  LIFECYCLE_STAGE_ORDER,
  OPERATIONAL_STATUS_ORDER,
  type LifecycleStageCode,
} from '../../../domain/lead-state/universal-lead-state-registry'
import {
  buildOperatorAutomationPatch,
  getAutomationResumeBlock,
  readBooleanFromRow,
  resolveAutomationModeFromRow,
  resolveStageFromRow,
  resolveStatusFromRow,
  resolveTemperatureFromRow,
  type OperatorAutomationMode,
  type ThreadControlRow,
} from '../../../domain/lead-state/deal-desk-control-contract'
import { useCanonicalControlMutations, type CanonicalControlSpec, type CanonicalControlValue } from '../useCanonicalControlMutation'
import { CANONICAL_THREAD_CONTROL_FOCUS_EVENT, type CanonicalThreadControlField } from '../canonical-thread-control-focus'
import { StageChangeConfirmModal } from './StageChangeConfirmModal'
import {
  threadStageVisuals,
  threadStatusVisuals,
  threadTemperatureVisuals,
  type PillVisual,
} from '../status-visuals'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

interface PillOption<T extends string> {
  value: T
  visual: PillVisual
}

interface GlassControlProps<T extends string> {
  label: string
  value: T
  options: PillOption<T>[]
  pending: boolean
  errorMessage: string | null
  disabled: boolean
  onChange: (next: T) => void
  className?: string
  compact?: boolean
  icon?: IconName
  field: CanonicalThreadControlField
}

function GlassControl<T extends string>({
  label,
  value,
  options,
  pending,
  errorMessage,
  disabled,
  onChange,
  className,
  compact = false,
  icon,
  field,
}: GlassControlProps<T>) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.value === value) ?? options[0]

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setMenuPos(null)
      return
    }
    const update = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({ top: rect.bottom + 6, left: rect.left, minWidth: Math.max(rect.width, 188) })
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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onDown = (event: MouseEvent) => {
      if (btnRef.current?.contains(event.target as Node)) return
      // The menu is a PORTAL into document.body, so it is outside `btnRef`. Without this
      // check, mousedown on an option closed the menu and unmounted the option before its
      // click could fire — every option in every dropdown was unselectable with a real
      // mouse, and the stage confirm dialog never opened. That is what the browser job was
      // failing on ("getByRole('dialog', { name: /Confirm Stage Change/i }) not found").
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const hasError = Boolean(errorMessage)
  const dotColor = hasError ? '#ff453a' : current?.visual.color ?? '#94a3b8'
  const buttonStyle = current && !hasError
    ? ({
        '--ctrl-color': current.visual.color,
        '--ctrl-bg': current.visual.bg,
        '--ctrl-border': current.visual.border,
        color: current.visual.color,
        borderColor: current.visual.border,
        background: `color-mix(in srgb, ${current.visual.bg} 72%, transparent)`,
      } as React.CSSProperties)
    : hasError
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
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            className={cls('nx-conv-dropdown-option', option.value === value && 'is-selected')}
            onClick={() => { onChange(option.value); setOpen(false) }}
          >
            <span className="nx-conv-dropdown-option__dot" style={{ background: option.visual.color }} />
            <span>{option.visual.label}</span>
            {option.value === value ? <span className="nx-conv-dropdown-option__check">✓</span> : null}
          </button>
        ))}
      </div>,
      document.body,
    )
    : null

  return (
    <div className={cls('nx-conv-glass-control', open && 'is-open', hasError && 'has-error', className)} data-canonical-field={field}>
      <button
        ref={btnRef}
        type="button"
        className={cls('nx-conv-glass-btn', compact && 'is-compact')}
        style={buttonStyle}
        onClick={() => !disabled && setOpen((currentOpen) => !currentOpen)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.visual.label ?? 'Unsupported'}`}
        aria-invalid={hasError || undefined}
        disabled={disabled}
      >
        {pending
          ? <span className="nx-conv-glass-btn__spinner" aria-hidden="true" />
          : icon
            ? <Icon name={icon} />
            : <span className="nx-conv-glass-btn__dot" style={{ background: dotColor }} />}
        <span>{current?.visual.label ?? 'Unsupported'}</span>
        {!disabled ? <span className="nx-conv-glass-btn__caret" aria-hidden="true">▾</span> : null}
      </button>
      {hasError ? <span className="nx-conv-control-error" role="alert">{errorMessage}</span> : null}
      {menu}
    </div>
  )
}

const unsupportedValue = (dimension: string, raw: unknown): string =>
  `__unsupported__:${dimension}:${String(raw ?? '').trim() || 'empty'}`

const unsupportedOption = (value: string, raw: unknown): PillOption<string> => ({
  value,
  visual: {
    label: `Unsupported legacy: ${String(raw ?? '').trim() || 'empty'}`,
    color: '#ff9f43',
    bg: 'rgba(255,159,67,0.10)',
    border: 'rgba(255,159,67,0.34)',
  },
})

const stageOptions: PillOption<string>[] = LIFECYCLE_STAGE_ORDER.map((value) => ({ value, visual: threadStageVisuals[value] }))
const statusOptions: PillOption<string>[] = OPERATIONAL_STATUS_ORDER.map((value) => ({ value, visual: threadStatusVisuals[value] }))
const temperatureOptions: PillOption<string>[] = LEAD_TEMPERATURE_ORDER.map((value) => ({ value, visual: threadTemperatureVisuals[value] }))
const automationOptions: PillOption<string>[] = OPERATOR_SELECTABLE_AUTOMATION_MODES.map((value) => ({
  value,
  visual: {
    label: AUTOMATION_MODE_META[value].label,
    color: value === 'active' ? '#30d158' : value === 'paused' ? '#ffd60a' : '#9ba8c0',
    bg: value === 'active' ? 'rgba(48,209,88,0.12)' : value === 'paused' ? 'rgba(255,214,10,0.11)' : 'rgba(155,168,192,0.10)',
    border: value === 'active' ? 'rgba(48,209,88,0.34)' : value === 'paused' ? 'rgba(255,214,10,0.32)' : 'rgba(155,168,192,0.26)',
  },
}))

const booleanResolution = (value: unknown): VocabularyResolution<boolean> => {
  if (value === true || value === false) return { ok: true, value, viaAlias: false }
  return { ok: false, dimension: 'boolean', input: String(value ?? ''), reason: 'unknown' }
}

const rowText = (row: ThreadControlRow, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return null
}

const canonicalRowFromThread = (thread: InboxWorkflowThread): ThreadControlRow => {
  const row = thread as unknown as ThreadControlRow
  return {
    ...row,
    lifecycle_stage: rowText(row, 'lifecycle_stage', 'lifecycleStage', 'universal_stage'),
    operational_status: rowText(row, 'operational_status', 'operationalStatus', 'universal_status'),
    lead_temperature: rowText(row, 'lead_temperature', 'leadTemperature', 'temperature'),
    automation_state: rowText(row, 'automation_state', 'automationStatePersisted'),
    autopilot_mode: rowText(row, 'autopilot_mode', 'autopilotMode'),
    automation_status: rowText(row, 'automation_status'),
    queue_status: rowText(row, 'queue_status', 'queueStatus'),
    manual_stage_lock: rowText(row, 'manual_stage_lock', 'manualStageLock'),
    is_read: rowText(row, 'is_read', 'isRead'),
    is_archived: rowText(row, 'is_archived', 'isArchived'),
    is_suppressed: rowText(row, 'is_suppressed', 'isSuppressed'),
    contactability_status: rowText(row, 'contactability_status', 'contactabilityStatus'),
  }
}

const valueOrUnsupported = <T extends string>(
  resolution: VocabularyResolution<T>,
  dimension: string,
  raw: unknown,
): string => resolution.ok ? resolution.value : unsupportedValue(dimension, raw)

const optionsWithUnsupported = (options: PillOption<string>[], value: string, raw: unknown): PillOption<string>[] =>
  value.startsWith('__unsupported__:') ? [unsupportedOption(value, raw), ...options] : options

export interface ThreadStateBarProps {
  thread: InboxWorkflowThread
  onRefetch?: (threadKey: string) => void
  /** @deprecated State controls remain editable; only automation may be disabled separately. */
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
  const rootRef = useRef<HTMLDivElement>(null)
  const stageExecuteNextActionRef = useRef(false)
  const row = useMemo(() => canonicalRowFromThread(thread), [thread])

  const stageResolution = resolveStageFromRow(row)
  const statusResolution = resolveStatusFromRow(row)
  const temperatureResolution = resolveTemperatureFromRow(row)
  const automationResolution = resolveAutomationModeFromRow(row)

  const stageServerValue = valueOrUnsupported(stageResolution, 'stage', row.lifecycle_stage)
  const statusServerValue = valueOrUnsupported(statusResolution, 'status', row.operational_status)
  const temperatureServerValue = valueOrUnsupported(temperatureResolution, 'temperature', row.lead_temperature)
  const automationServerValue = valueOrUnsupported(automationResolution, 'automation', row.automation_state || row.autopilot_mode)
  const readServerValue = readBooleanFromRow(row, 'is_read')
  const manualStageLockServerValue = readBooleanFromRow(row, 'manual_stage_lock')

  const persist = async (
    patch: Record<string, unknown>,
    meta: UniversalLeadStateMeta = {},
  ): Promise<UniversalLeadStateMutationResult> => {
    const result = await patchLeadStateFromView(sourceView, String(thread.threadKey || thread.id || ''), patch, meta)
    if (result.ok) onRefetch?.(result.threadKey)
    return result
  }

  const specs = useMemo<CanonicalControlSpec<CanonicalControlValue>[]>(() => [
    {
      field: 'lifecycle_stage',
      serverValue: stageServerValue,
      resolve: resolveLifecycleStageForWrite,
      persist: (value) => persist(
        { lifecycle_stage: value },
        { execute_next_action: stageExecuteNextActionRef.current, manual_stage_lock: true },
      ),
      readBack: (serverRow) => {
        const resolved = resolveStageFromRow(serverRow || {})
        return resolved.ok ? resolved.value : null
      },
    },
    {
      field: 'operational_status',
      serverValue: statusServerValue,
      resolve: resolveOperationalStatusForWrite,
      persist: (value) => persist({ operational_status: value }),
      readBack: (serverRow) => {
        const resolved = resolveStatusFromRow(serverRow || {})
        return resolved.ok ? resolved.value : null
      },
    },
    {
      field: 'lead_temperature',
      serverValue: temperatureServerValue,
      resolve: resolveLeadTemperatureForWrite,
      persist: (value) => persist({ lead_temperature: value }, { manual_temperature_lock: true }),
      readBack: (serverRow) => {
        const resolved = resolveTemperatureFromRow(serverRow || {})
        return resolved.ok ? resolved.value : null
      },
    },
    {
      field: 'automation_state',
      serverValue: automationServerValue,
      resolve: resolveOperatorAutomationMode,
      preflight: (value) => value === 'active' ? getAutomationResumeBlock(row).reason : null,
      persist: async (value) => {
        const patch = buildOperatorAutomationPatch(value as OperatorAutomationMode, row)
        if (!patch.ok) return { ok: false, threadKey: '', errorMessage: patch.reason, errorCode: 'AUTOMATION_RESUME_BLOCKED', mutationPayload: null, writeTarget: 'none' }
        return persist(patch.patch)
      },
      readBack: (serverRow) => {
        const resolved = resolveAutomationModeFromRow(serverRow || {})
        return resolved.ok ? resolved.value : null
      },
    },
    {
      field: 'manual_stage_lock',
      serverValue: manualStageLockServerValue,
      resolve: booleanResolution,
      persist: (value) => persist({ manual_stage_lock: Boolean(value) }, { manual_stage_lock: Boolean(value) }),
      readBack: (serverRow) => serverRow && Object.hasOwn(serverRow, 'manual_stage_lock')
        ? readBooleanFromRow(serverRow, 'manual_stage_lock')
        : null,
    },
    {
      field: 'is_read',
      serverValue: readServerValue,
      resolve: booleanResolution,
      persist: (value) => persist({ is_read: value }),
      readBack: (serverRow) => serverRow && Object.hasOwn(serverRow, 'is_read')
        ? readBooleanFromRow(serverRow, 'is_read')
        : null,
    },
  ], [
    automationServerValue,
    manualStageLockServerValue,
    readServerValue,
    row,
    sourceView,
    stageServerValue,
    statusServerValue,
    temperatureServerValue,
    thread.id,
    thread.threadKey,
  ])

  const controls = useCanonicalControlMutations(thread, specs, {
    onTelemetry: (event) => console.warn('[DEAL_DESK_CANONICAL_CONTROL]', event),
  })

  const stage = controls.lifecycle_stage
  const status = controls.operational_status
  const temperature = controls.lead_temperature
  const automation = controls.automation_state
  const manualStageLock = controls.manual_stage_lock
  const isRead = controls.is_read

  const [stageConfirm, setStageConfirm] = useState<{ open: boolean; next: LifecycleStageCode | null }>({ open: false, next: null })

  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ field?: CanonicalThreadControlField | null }>).detail
      const field = detail?.field || null
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const target = field
        ? rootRef.current?.querySelector<HTMLElement>(`[data-canonical-field="${field}"] button`)
        : rootRef.current?.querySelector<HTMLElement>('button')
      target?.focus({ preventScroll: true })
      rootRef.current?.classList.add('is-attention')
      window.setTimeout(() => rootRef.current?.classList.remove('is-attention'), 1200)
    }
    window.addEventListener(CANONICAL_THREAD_CONTROL_FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(CANONICAL_THREAD_CONTROL_FOCUS_EVENT, onFocus)
  }, [])

  const requestStage = (next: string) => {
    const resolved = resolveLifecycleStageForWrite(next)
    if (!resolved.ok) return
    if (stageResolution.ok) {
      setStageConfirm({ open: true, next: resolved.value })
      return
    }
    stageExecuteNextActionRef.current = false
    void stage.commit(resolved.value)
  }

  const confirmStage = (executeNextAction: boolean) => {
    if (!stageConfirm.next) return
    stageExecuteNextActionRef.current = executeNextAction
    const next = stageConfirm.next
    setStageConfirm({ open: false, next: null })
    void stage.commit(next)
  }

  const anyPending = Object.values(controls).some((control) => control.pending)
  const sharedUnsupported = Object.values(controls).find((control) => control.unsupported)?.unsupportedReason || null
  const queueStatus = String(row.automation_status || row.queue_status || '').trim()

  return (
    <>
      <div
        ref={rootRef}
        className={cls('nx-conv-command-strip', compact && 'is-compact', anyPending && 'is-syncing')}
        aria-label="Canonical universal thread controls"
        data-canonical-thread-state-bar
      >
        <div className="nx-conv-command-strip__primary">
          <GlassControl
            label="Conversation status"
            value={String(status.value)}
            options={optionsWithUnsupported(statusOptions, String(status.value), row.operational_status)}
            pending={status.pending}
            errorMessage={status.errorMessage}
            disabled={disabled}
            className="nx-ctrl--status"
            compact={compact}
            field="operational_status"
            onChange={(next) => void status.commit(next)}
          />
          <GlassControl
            label="Acquisition stage"
            value={String(stage.value)}
            options={optionsWithUnsupported(stageOptions, String(stage.value), row.lifecycle_stage)}
            pending={stage.pending}
            errorMessage={stage.errorMessage}
            disabled={disabled}
            className="nx-ctrl--stage"
            compact={compact}
            field="lifecycle_stage"
            onChange={requestStage}
          />
          <GlassControl
            label="Lead temperature"
            value={String(temperature.value)}
            options={optionsWithUnsupported(temperatureOptions, String(temperature.value), row.lead_temperature)}
            pending={temperature.pending}
            errorMessage={temperature.errorMessage}
            disabled={disabled}
            className="nx-ctrl--temperature"
            compact={compact}
            field="lead_temperature"
            onChange={(next) => void temperature.commit(next)}
          />
        </div>

        {!compact ? <div className="nx-conv-command-strip__spacer" aria-hidden="true" /> : null}

        <GlassControl
          label="Automation mode"
          value={String(automation.value)}
          options={optionsWithUnsupported(automationOptions, String(automation.value), row.automation_state || row.autopilot_mode)}
          pending={automation.pending}
          errorMessage={automation.errorMessage}
          disabled={disabled || autopilotDisabled}
          className="nx-conv-auto-control"
          compact
          icon="zap"
          field="automation_state"
          onChange={(next) => void automation.commit(next)}
        />

        <button
          type="button"
          className={cls('nx-conv-state-action', Boolean(manualStageLock.value) && 'is-active')}
          data-canonical-field="manual_stage_lock"
          disabled={disabled || manualStageLock.pending}
          aria-pressed={Boolean(manualStageLock.value)}
          onClick={() => void manualStageLock.commit(!Boolean(manualStageLock.value))}
        >
          <Icon name="key" />
          <span>{manualStageLock.pending ? 'Saving…' : Boolean(manualStageLock.value) ? 'Stage locked' : 'Lock stage'}</span>
        </button>

        <button
          type="button"
          className={cls('nx-conv-state-action', !Boolean(isRead.value) && 'is-active')}
          data-canonical-field="is_read"
          disabled={disabled || isRead.pending}
          aria-pressed={!Boolean(isRead.value)}
          onClick={() => void isRead.commit(!Boolean(isRead.value))}
        >
          <Icon name={Boolean(isRead.value) ? 'mail' : 'eye'} />
          <span>{isRead.pending ? 'Saving…' : Boolean(isRead.value) ? 'Mark unread' : 'Mark read'}</span>
        </button>

        {queueStatus ? (
          <span className="nx-conv-queue-status" title="Read-only execution status">
            Queue: {queueStatus.replaceAll('_', ' ')}
          </span>
        ) : null}

        {sharedUnsupported ? <p className="nx-conv-command-strip__error" role="alert">{sharedUnsupported}</p> : null}
      </div>

      <StageChangeConfirmModal
        open={stageConfirm.open}
        fromStage={stageResolution.ok ? stageResolution.value : null}
        toStage={stageConfirm.next}
        pending={stage.pending}
        onCancel={() => setStageConfirm({ open: false, next: null })}
        onChangeStageOnly={() => confirmStage(false)}
        onChangeStageAndRunAction={() => confirmStage(true)}
      />

      <style>{`
        [data-canonical-thread-state-bar].is-attention { outline: 2px solid color-mix(in srgb, var(--nx-accent, #5096f5) 58%, transparent); outline-offset: 4px; }
        .nx-conv-control-error { display: block; max-width: 250px; margin-top: 4px; color: #ff8a80; font-size: 10px; line-height: 1.3; }
        .nx-conv-state-action { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 5px 9px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; background: rgba(255,255,255,.04); color: var(--nx-muted, #9ba8c0); font-size: 11px; }
        .nx-conv-state-action.is-active { color: #7bc6ff; border-color: rgba(123,198,255,.36); background: rgba(123,198,255,.10); }
        .nx-conv-queue-status { font-size: 10px; color: var(--nx-muted, #7d8797); text-transform: capitalize; white-space: nowrap; }
        .nx-conv-command-strip__error { flex-basis: 100%; margin: 2px 0 0; color: #ff8a80; font-size: 11px; }
      `}</style>
    </>
  )
}
