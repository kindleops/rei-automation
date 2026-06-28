import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import type { IconName } from '../../shared/icons'
import { patchLeadStateFromView } from '../../domain/lead-state/persistUniversalLeadState'
import type { LifecycleStageCode } from '../../domain/lead-state/universal-lead-state-registry'
import {
  LEAD_TEMPERATURE_META,
  LEAD_TEMPERATURE_ORDER,
  normalizeLeadTemperature,
  type LeadTemperatureCode,
} from '../../domain/lead-state/universal-lead-state-registry'
import { StageChangeConfirmModal } from '../inbox/components/StageChangeConfirmModal'
import {
  resolveThreadStage,
  resolveThreadStatus,
  resolveThreadTemperature,
  threadStageVisuals,
  threadStatusVisuals,
  threadTemperatureVisuals,
  type PillVisual,
  type ThreadStage,
  type ThreadStatus,
  type ThreadTemperature,
} from '../inbox/status-visuals'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export interface DealIntelligenceLeadStateData {
  threadKey: string
  lifecycle_stage?: string | null
  operational_status?: string | null
  lead_temperature?: string | null
  is_starred?: boolean | null
  is_pinned?: boolean | null
  is_archived?: boolean | null
  snoozed_until?: string | null
  manual_stage_lock?: boolean | null
  manual_temperature_lock?: boolean | null
}

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
  lockActive?: boolean
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
  lockActive = false,
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

  const dotColor = error ? '#ff453a' : current?.visual.color ?? 'var(--di25-accent, #5096f5)'
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
    <div className={cls('nx-conv-glass-control', 'nx-di25-glass-control', open && 'is-open', className)}>
      <button
        ref={btnRef}
        type="button"
        className="nx-conv-glass-btn nx-di25-glass-btn"
        style={btnStyle}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${error ? 'Failed' : current?.visual.label}`}
        disabled={disabled}
      >
        {pending
          ? <span className="nx-conv-glass-btn__spinner" aria-hidden="true" />
          : <span className="nx-conv-glass-btn__dot" style={{ background: dotColor }} />
        }
        <span className="nx-di25-glass-btn__label">{error ? 'Failed' : current?.visual.label}</span>
        {lockActive ? <Icon name="lock" className="nx-di25-glass-btn__lock" aria-label="Manual lock active" /> : null}
        {!disabled && <span className="nx-conv-glass-btn__caret" aria-hidden="true">▾</span>}
      </button>
      {menu}
    </div>
  )
}

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

const STATUS_OPTIONS: PillOption<ThreadStatus>[] = (Object.keys(threadStatusVisuals) as ThreadStatus[]).map(
  (v) => ({ value: v, visual: threadStatusVisuals[v] }),
)

const STAGE_OPTIONS: PillOption<ThreadStage>[] = (Object.keys(threadStageVisuals) as ThreadStage[]).map(
  (v) => ({ value: v, visual: threadStageVisuals[v] }),
)

const TEMP_OPTIONS: PillOption<ThreadTemperature>[] = LEAD_TEMPERATURE_ORDER.map(
  (v) => ({ value: v, visual: threadTemperatureVisuals[v] }),
)

function toThreadShape(data: DealIntelligenceLeadStateData) {
  return {
    lifecycle_stage: data.lifecycle_stage ?? undefined,
    operational_status: data.operational_status ?? undefined,
    lead_temperature: data.lead_temperature ?? undefined,
    is_starred: data.is_starred ?? undefined,
    is_pinned: data.is_pinned ?? undefined,
    is_archived: data.is_archived ?? undefined,
    snoozed_until: data.snoozed_until ?? undefined,
    manual_stage_lock: data.manual_stage_lock ?? undefined,
    manual_temperature_lock: data.manual_temperature_lock ?? undefined,
  }
}

function useLeadStateSync(data: DealIntelligenceLeadStateData) {
  const threadKey = data.threadKey
  const shape = toThreadShape(data)

  const status = useOptimisticField<ThreadStatus>(resolveThreadStatus(shape))
  const stage = useOptimisticField<ThreadStage>(resolveThreadStage(shape))
  const temperature = useOptimisticField<ThreadTemperature>(resolveThreadTemperature(shape))

  const [starred, setStarred] = useState(Boolean(data.is_starred))
  const [pinned, setPinned] = useState(Boolean(data.is_pinned))
  const [archived, setArchived] = useState(Boolean(data.is_archived))
  const [snoozedUntil, setSnoozedUntil] = useState(String(data.snoozed_until || ''))
  const [manualStageLock, setManualStageLock] = useState(Boolean(data.manual_stage_lock))
  const [manualTemperatureLock, setManualTemperatureLock] = useState(Boolean(data.manual_temperature_lock))
  const [actionPending, setActionPending] = useState(false)

  const prevKeyRef = useRef(threadKey)
  useEffect(() => {
    if (prevKeyRef.current !== threadKey) {
      prevKeyRef.current = threadKey
      status.reset(resolveThreadStatus(shape))
      stage.reset(resolveThreadStage(shape))
      temperature.reset(resolveThreadTemperature(shape))
    } else if (!status.pending && !stage.pending && !temperature.pending && !actionPending) {
      status.reset(resolveThreadStatus(shape))
      stage.reset(resolveThreadStage(shape))
      temperature.reset(resolveThreadTemperature(shape))
    }
    if (!actionPending) {
      setStarred(Boolean(data.is_starred))
      setPinned(Boolean(data.is_pinned))
      setArchived(Boolean(data.is_archived))
      setSnoozedUntil(String(data.snoozed_until || ''))
      setManualStageLock(Boolean(data.manual_stage_lock))
      setManualTemperatureLock(Boolean(data.manual_temperature_lock))
    }
  }, [
    threadKey,
    data.lifecycle_stage,
    data.operational_status,
    data.lead_temperature,
    data.is_starred,
    data.is_pinned,
    data.is_archived,
    data.snoozed_until,
    data.manual_stage_lock,
    data.manual_temperature_lock,
    actionPending,
  ])

  return {
    status,
    stage,
    temperature,
    starred,
    setStarred,
    pinned,
    setPinned,
    archived,
    setArchived,
    snoozedUntil,
    setSnoozedUntil,
    manualStageLock,
    setManualStageLock,
    manualTemperatureLock,
    setManualTemperatureLock,
    actionPending,
    setActionPending,
  }
}

export interface DealIntelligenceCommandRowProps {
  data: DealIntelligenceLeadStateData
  onPatched?: () => void
  disabled?: boolean
}

export function DealIntelligenceCommandRow({ data, onPatched, disabled = false }: DealIntelligenceCommandRowProps) {
  const threadKey = data.threadKey
  const {
    status,
    stage,
    manualStageLock,
  } = useLeadStateSync(data)

  const [stageConfirm, setStageConfirm] = useState<{
    open: boolean
    next: ThreadStage | null
  }>({ open: false, next: null })

  const persist = async (patch: Record<string, string>, executeNextAction = false) => {
    const result = await patchLeadStateFromView('deal_intelligence', threadKey, patch, {
      execute_next_action: executeNextAction,
    })
    if (result.ok) onPatched?.()
    return { ok: result.ok }
  }

  const handleStageChangeRequest = (next: ThreadStage) => {
    if (next === stage.value) return
    setStageConfirm({ open: true, next })
  }

  const handleStageConfirm = async (executeNextAction: boolean) => {
    const next = stageConfirm.next
    if (!next) return
    setStageConfirm({ open: false, next: null })
    await stage.commit(next, () => persist({ lifecycle_stage: next }, executeNextAction))
  }

  const anyPending = status.pending || stage.pending

  return (
    <>
      <div
        className={cls('nx-di25-lead-command', anyPending && 'is-syncing')}
        aria-label="Lead lifecycle controls"
      >
        <GlassControl
          label="Lifecycle stage"
          value={stage.value}
          options={STAGE_OPTIONS}
          pending={stage.pending}
          error={stage.error}
          disabled={disabled}
          className="nx-di25-ctrl--stage"
          lockActive={manualStageLock}
          onChange={handleStageChangeRequest}
        />
        <GlassControl
          label="Operational status"
          value={status.value}
          options={STATUS_OPTIONS}
          pending={status.pending}
          error={status.error}
          disabled={disabled}
          className="nx-di25-ctrl--status"
          onChange={(next) => status.commit(next, () => persist({ operational_status: next }))}
        />
      </div>

      <StageChangeConfirmModal
        open={stageConfirm.open}
        fromStage={stage.value as LifecycleStageCode}
        toStage={stageConfirm.next as LifecycleStageCode | null}
        pending={stage.pending}
        onCancel={() => setStageConfirm({ open: false, next: null })}
        onChangeStageOnly={() => void handleStageConfirm(false)}
        onChangeStageAndRunAction={() => void handleStageConfirm(true)}
      />
    </>
  )
}

const HEADER_ICONS: Array<{ key: 'star' | 'pin' | 'snooze' | 'archive' | 'more'; icon: IconName; title: string }> = [
  { key: 'star', icon: 'star', title: 'Star' },
  { key: 'pin', icon: 'pin', title: 'Pin' },
  { key: 'snooze', icon: 'moon', title: 'Snooze' },
  { key: 'archive', icon: 'archive', title: 'Archive' },
  { key: 'more', icon: 'more', title: 'More' },
]

export interface DealIntelligenceHeaderActionsProps {
  data: DealIntelligenceLeadStateData
  onPatched?: () => void
  disabled?: boolean
}

export function DealIntelligenceHeaderActions({ data, onPatched, disabled = false }: DealIntelligenceHeaderActionsProps) {
  const threadKey = data.threadKey
  const {
    starred,
    setStarred,
    pinned,
    setPinned,
    archived,
    setArchived,
    snoozedUntil,
    setSnoozedUntil,
    manualStageLock,
    setManualStageLock,
    manualTemperatureLock,
    setManualTemperatureLock,
    actionPending,
    setActionPending,
  } = useLeadStateSync(data)

  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent) => {
      if (moreRef.current?.contains(e.target as Node)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [moreOpen])

  const isSnoozed = Boolean(snoozedUntil) && new Date(snoozedUntil).getTime() > Date.now()

  const runAction = async (patch: Record<string, unknown>, meta: Record<string, unknown> = {}) => {
    setActionPending(true)
    const result = await patchLeadStateFromView('deal_intelligence', threadKey, patch, meta)
    setActionPending(false)
    if (result.ok) onPatched?.()
    return result.ok
  }

  const handleIconClick = async (key: typeof HEADER_ICONS[number]['key']) => {
    if (disabled || actionPending) return
    if (key === 'more') {
      setMoreOpen((v) => !v)
      return
    }
    if (key === 'star') {
      const next = !starred
      setStarred(next)
      await runAction({ is_starred: next })
      return
    }
    if (key === 'pin') {
      const next = !pinned
      setPinned(next)
      await runAction({ is_pinned: next })
      return
    }
    if (key === 'archive') {
      const next = !archived
      setArchived(next)
      await runAction(next
        ? { is_archived: true, archive_scope: 'conversation' }
        : { is_archived: false, archive_scope: null })
      return
    }
    if (key === 'snooze') {
      if (isSnoozed) {
        setSnoozedUntil('')
        await runAction({ snoozed_until: null, snooze_reason: null, operational_status: 'needs_review' })
        return
      }
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      setSnoozedUntil(until)
      await runAction({ snoozed_until: until, operational_status: 'snoozed' })
    }
  }

  const activeMap: Record<string, boolean> = {
    star: starred,
    pin: pinned,
    snooze: isSnoozed,
    archive: archived,
    more: moreOpen || manualStageLock || manualTemperatureLock,
  }

  return (
    <div className="nx-di25-header-actions" ref={moreRef}>
      {HEADER_ICONS.map(({ key, icon, title }) => (
        <button
          key={key}
          type="button"
          className={cls('nx-di25-header-action', activeMap[key] && 'is-active', key === 'more' && moreOpen && 'is-open')}
          title={title}
          aria-label={title}
          disabled={disabled || actionPending}
          onClick={() => void handleIconClick(key)}
        >
          <Icon name={icon} />
        </button>
      ))}

      {moreOpen ? (
        <div className="nx-di25-more-menu" role="menu">
          {manualStageLock ? (
            <div className="nx-di25-more-menu__row">
              <Icon name="lock" />
              <span>Manual stage lock active</span>
            </div>
          ) : null}
          {manualTemperatureLock ? (
            <div className="nx-di25-more-menu__row">
              <Icon name="lock" />
              <span>Manual temperature lock active</span>
            </div>
          ) : null}
          {!manualStageLock && !manualTemperatureLock ? (
            <div className="nx-di25-more-menu__row is-muted">No manual locks active</div>
          ) : null}
          {(manualStageLock || manualTemperatureLock) ? (
            <button
              type="button"
              className="nx-di25-more-menu__action"
              role="menuitem"
              disabled={disabled || actionPending}
              onClick={() => {
                setMoreOpen(false)
                setManualStageLock(false)
                setManualTemperatureLock(false)
                void runAction({}, { resume_automatic_scoring: true, manual_stage_lock: false, manual_temperature_lock: false })
              }}
            >
              <Icon name="zap" />
              Resume Automatic Scoring
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export interface DealIntelligenceTemperatureBadgeProps {
  threadKey: string
  temperature?: string | null
  manualTemperatureLock?: boolean | null
  onPatched?: () => void
  disabled?: boolean
}

export function DealIntelligenceTemperatureBadge({
  threadKey,
  temperature,
  manualTemperatureLock = false,
  onPatched,
  disabled = false,
}: DealIntelligenceTemperatureBadgeProps) {
  const normalized = normalizeLeadTemperature(temperature)
  const visual = threadTemperatureVisuals[normalized]
  const meta = LEAD_TEMPERATURE_META[normalized as LeadTemperatureCode]

  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [value, setValue] = useState<ThreadTemperature>(normalized)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setValue(normalizeLeadTemperature(temperature))
  }, [temperature, threadKey])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handleSelect = async (next: ThreadTemperature) => {
    if (next === value || disabled) return
    const prev = value
    setValue(next)
    setPending(true)
    const result = await patchLeadStateFromView('deal_intelligence', threadKey, { lead_temperature: next })
    setPending(false)
    if (!result.ok) {
      setValue(prev)
      return
    }
    setOpen(false)
    onPatched?.()
  }

  return (
    <div className="nx-di25-temp-badge-wrap" ref={popoverRef}>
      <button
        type="button"
        className={cls('nx-di25-temp-badge', `is-${normalized}`, pending && 'is-syncing')}
        style={{
          color: meta?.color ?? visual.color,
          borderColor: `color-mix(in srgb, ${meta?.color ?? visual.color} 38%, transparent)`,
          background: `color-mix(in srgb, ${meta?.color ?? visual.color} 14%, transparent)`,
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Lead temperature: ${visual.label}`}
        disabled={disabled || pending}
        onClick={() => setOpen((v) => !v)}
      >
        {manualTemperatureLock ? <Icon name="lock" className="nx-di25-temp-badge__lock" /> : null}
        <span>{visual.label}</span>
      </button>

      {open ? (
        <div className="nx-di25-temp-popover" role="listbox" aria-label="Edit temperature">
          {TEMP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={cls('nx-di25-temp-popover__opt', opt.value === value && 'is-selected')}
              onClick={() => void handleSelect(opt.value)}
            >
              <span className="nx-conv-dropdown-option__dot" style={{ background: opt.visual.color }} />
              <span>{opt.visual.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}