import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import type { IconName } from '../../shared/icons'
import { patchLeadStateFromView } from '../../domain/lead-state/persistUniversalLeadState'
import { useDealDeskControlsForThread } from '../inbox/deal-desk-controls-context'
import type { LifecycleStageCode } from '../../domain/lead-state/universal-lead-state-registry'
import {
  LEAD_TEMPERATURE_META,
  LEAD_TEMPERATURE_ORDER,
  normalizeLeadTemperature,
  type LeadTemperatureCode,
} from '../../domain/lead-state/universal-lead-state-registry'
import { StageChangeConfirmModal } from '../inbox/components/StageChangeConfirmModal'
// The lenient `resolveThread*` helpers are deliberately not imported: they coerce an
// unrecognised value into a canonical neighbour, which is fine for a list pill and wrong
// for anything that can be written. Values come from the canonical control handles.
import {
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
  value: string
  options: PillOption<T>[]
  pending: boolean
  /** Localised operator-facing reason, or null. Never a raw error. */
  errorMessage: string | null
  disabled: boolean
  /** The stored value has no canonical equivalent — show it verbatim, do not guess. */
  unsupportedValue?: boolean
  onChange: (next: T) => void
  className?: string
  lockActive?: boolean
  layout?: 'stacked' | 'card'
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
  className,
  lockActive = false,
  layout = 'stacked',
}: GlassControlProps<T>) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const error = Boolean(errorMessage)
  // No `?? options[0]`: an unmatched value is reported verbatim, never substituted.
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

  const dotColor = error ? '#ff453a' : current?.visual.color ?? 'var(--di25-accent, #5096f5)'
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

  const valueLabel = error
    ? 'Failed'
    : current && !unsupportedValue
      ? current.visual.label
      : (value ? `Unsupported: ${value}` : 'Not set')

  return (
    <div className={cls(
      'nx-conv-glass-control',
      'nx-di25-glass-control',
      layout === 'card' && 'is-card',
      open && 'is-open',
      pending && 'is-syncing',
      className,
    )}>
      {layout === 'stacked' ? <span className="nx-di25-glass-control__label">{label}</span> : null}
      <button
        ref={btnRef}
        type="button"
        className={cls('nx-conv-glass-btn', 'nx-di25-glass-btn', layout === 'card' && 'is-card')}
        style={btnStyle}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${valueLabel}`}
        disabled={disabled}
      >
        {layout === 'card' ? (
          <>
            <span className="nx-di25-glass-btn__accent" style={{ background: dotColor }} aria-hidden="true" />
            <span className="nx-di25-glass-btn__card-body">
              <span className="nx-di25-glass-btn__card-head">
                <em>{label}</em>
                {!disabled ? <span className="nx-conv-glass-btn__caret" aria-hidden="true">▾</span> : null}
              </span>
              <span className="nx-di25-glass-btn__card-value">
                {pending
                  ? <span className="nx-conv-glass-btn__spinner" aria-hidden="true" />
                  : <span className="nx-conv-glass-btn__dot" style={{ background: dotColor }} />
                }
                <strong>{valueLabel}</strong>
                {lockActive ? <Icon name="key" className="nx-di25-glass-btn__lock" aria-label="Manual lock active" /> : null}
              </span>
            </span>
          </>
        ) : (
          <>
            {pending
              ? <span className="nx-conv-glass-btn__spinner" aria-hidden="true" />
              : <span className="nx-conv-glass-btn__dot" style={{ background: dotColor }} />
            }
            <span className="nx-di25-glass-btn__label">{valueLabel}</span>
            {lockActive ? <Icon name="key" className="nx-di25-glass-btn__lock" aria-label="Manual lock active" /> : null}
            {!disabled && <span className="nx-conv-glass-btn__caret" aria-hidden="true">▾</span>}
          </>
        )}
      </button>
      {menu}
      {errorMessage ? (
        <div className="nx-conv-control-error" role="alert">
          <span>{errorMessage}</span>
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

const TEMP_OPTIONS: PillOption<ThreadTemperature>[] = LEAD_TEMPERATURE_ORDER.map(
  (v) => ({ value: v, visual: threadTemperatureVisuals[v] }),
)

/**
 * Flag state for the header actions (star / pin / archive / snooze / locks).
 *
 * Status, stage and temperature are deliberately absent: they are canonical control
 * fields owned by `DealDeskControlsContext`, and holding a second copy here is what let
 * this panel's optimistic value disagree with the conversation state bar's.
 */
function useLeadStateFlags(data: DealIntelligenceLeadStateData) {
  const [starred, setStarred] = useState(Boolean(data.is_starred))
  const [pinned, setPinned] = useState(Boolean(data.is_pinned))
  const [archived, setArchived] = useState(Boolean(data.is_archived))
  const [snoozedUntil, setSnoozedUntil] = useState(String(data.snoozed_until || ''))
  const [manualStageLock, setManualStageLock] = useState(Boolean(data.manual_stage_lock))
  const [manualTemperatureLock, setManualTemperatureLock] = useState(Boolean(data.manual_temperature_lock))
  const [actionPending, setActionPending] = useState(false)

  useEffect(() => {
    if (actionPending) return
    setStarred(Boolean(data.is_starred))
    setPinned(Boolean(data.is_pinned))
    setArchived(Boolean(data.is_archived))
    setSnoozedUntil(String(data.snoozed_until || ''))
    setManualStageLock(Boolean(data.manual_stage_lock))
    setManualTemperatureLock(Boolean(data.manual_temperature_lock))
  }, [
    data.threadKey,
    data.is_starred,
    data.is_pinned,
    data.is_archived,
    data.snoozed_until,
    data.manual_stage_lock,
    data.manual_temperature_lock,
    actionPending,
  ])

  return {
    starred, setStarred,
    pinned, setPinned,
    archived, setArchived,
    snoozedUntil, setSnoozedUntil,
    manualStageLock, setManualStageLock,
    manualTemperatureLock, setManualTemperatureLock,
    actionPending, setActionPending,
  }
}

export interface DealIntelligenceCommandRowProps {
  data: DealIntelligenceLeadStateData
  /** @deprecated Reconciliation is owned by the canonical control handles. */
  onPatched?: () => void
  disabled?: boolean
}

export function DealIntelligenceCommandRow({ data, disabled = false }: DealIntelligenceCommandRowProps) {
  const controls = useDealDeskControlsForThread(data.threadKey)
  const [stageConfirm, setStageConfirm] = useState<{ open: boolean; next: ThreadStage | null }>(
    { open: false, next: null },
  )

  // A thread switch cancels a pending confirmation so it cannot be applied to the next
  // conversation. Derived from state during render rather than through a ref, so it is
  // safe under concurrent rendering.
  const [confirmThreadKey, setConfirmThreadKey] = useState(data.threadKey)
  if (confirmThreadKey !== data.threadKey) {
    setConfirmThreadKey(data.threadKey)
    if (stageConfirm.open) setStageConfirm({ open: false, next: null })
  }

  if (!controls) {
    // The provider is bound to a different conversation. Render nothing rather than fall
    // back to a private mutation path.
    return null
  }

  const handleStageConfirm = async () => {
    const next = stageConfirm.next
    if (!next) return
    setStageConfirm({ open: false, next: null })
    await controls.stage.commit(next)
  }

  const anyPending = controls.status.pending || controls.stage.pending

  return (
    <>
      <div className="nx-di25-pipeline-console">
        {controls.manualStageLock ? (
          <div className="nx-di25-pipeline-console__lock" role="status">
            <Icon name="key" />
            <span>Manual stage lock active</span>
          </div>
        ) : null}
        <div
          className={cls('nx-di25-lead-command', anyPending && 'is-syncing')}
          aria-label="Lead lifecycle controls"
        >
          <GlassControl
            label="Stage"
            value={controls.stage.value}
            options={STAGE_OPTIONS}
            pending={controls.stage.pending}
            errorMessage={controls.stage.errorMessage}
            unsupportedValue={controls.stage.current.unsupported}
            disabled={disabled || controls.unsupported}
            className="nx-di25-ctrl--stage"
            lockActive={controls.manualStageLock}
            layout="card"
            onChange={(next) => {
              if (next === controls.stage.value) return
              setStageConfirm({ open: true, next })
            }}
          />
          <span className="nx-di25-lead-command__bridge" aria-hidden="true">
            <Icon name="chevron-right" />
          </span>
          <GlassControl
            label="Status"
            value={controls.status.value}
            options={STATUS_OPTIONS}
            pending={controls.status.pending}
            errorMessage={controls.status.errorMessage}
            unsupportedValue={controls.status.current.unsupported}
            disabled={disabled || controls.unsupported}
            className="nx-di25-ctrl--status"
            layout="card"
            onChange={(next) => void controls.status.commit(next)}
          />
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
  // Operational status has exactly one owner. Snooze/unsnooze needs to move it, so it asks
  // the canonical control rather than adding `operational_status` to its own patch.
  const controls = useDealDeskControlsForThread(threadKey)
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
  } = useLeadStateFlags(data)

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
        // Clearing the snooze does not move the status server-side (`buildRowPatch` only
        // sets `snoozed` when `snoozed_until` is truthy), so the status change is an
        // explicit second step through its single owner.
        const cleared = await runAction({ snoozed_until: null, snooze_reason: null })
        if (cleared) await controls?.status.commit('needs_review')
        return
      }
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      setSnoozedUntil(until)
      // `operational_status: 'snoozed'` is NOT sent: `buildRowPatch` already sets it as a
      // documented coupled transition of `snoozed_until`. Sending it too would make this
      // panel a second status writer.
      await runAction({ snoozed_until: until })
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
              <Icon name="key" />
              <span>Manual stage lock active</span>
            </div>
          ) : null}
          {manualTemperatureLock ? (
            <div className="nx-di25-more-menu__row">
              <Icon name="key" />
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
                // The locks travel in the PATCH body, not in meta. As meta-only they were
                // unreachable: `buildRowPatch` read `meta.manual_stage_lock` solely inside
                // its `lifecycle_stage` branch, and this call sends no stage — so the
                // request carried an empty patch and the server refused it with
                // `no_allowed_patch_fields`. Releasing a lock never worked.
                void runAction(
                  { manual_stage_lock: false, manual_temperature_lock: false },
                  { resume_automatic_scoring: true },
                )
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
  /** Display fallback only, used when the provider names a different conversation. */
  temperature?: string | null
  manualTemperatureLock?: boolean | null
  /** @deprecated Reconciliation is owned by the canonical control handles. */
  onPatched?: () => void
  disabled?: boolean
}

export function DealIntelligenceTemperatureBadge({
  threadKey,
  temperature,
  manualTemperatureLock = false,
  disabled = false,
}: DealIntelligenceTemperatureBadgeProps) {
  const controls = useDealDeskControlsForThread(threadKey)
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Falls back to the passed-in value only for DISPLAY when the provider names a different
  // conversation. In that case the badge is not interactive — it never writes on its own.
  const displayValue = controls ? controls.temperature.value : normalizeLeadTemperature(temperature)
  const normalized = normalizeLeadTemperature(displayValue)
  const visual = threadTemperatureVisuals[normalized]
  const meta = LEAD_TEMPERATURE_META[normalized as LeadTemperatureCode]
  const pending = controls?.temperature.pending ?? false
  const interactive = Boolean(controls) && !disabled && !controls?.unsupported

  const handleSelect = async (next: ThreadTemperature) => {
    if (!controls || next === controls.temperature.value) return
    // No local optimistic state: the canonical handle owns pending, rollback and
    // serialization, so three rapid clicks resolve to the last one.
    const outcome = await controls.temperature.commit(next)
    if (outcome.ok) setOpen(false)
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
        disabled={!interactive || pending}
        onClick={() => setOpen((v) => !v)}
      >
        {manualTemperatureLock ? <Icon name="key" className="nx-di25-temp-badge__lock" /> : null}
        <span>{visual.label}</span>
      </button>

      {controls?.temperature.errorMessage ? (
        <div className="nx-conv-control-error" role="alert">
          <span>{controls.temperature.errorMessage}</span>
          <button type="button" className="nx-conv-control-error__dismiss" onClick={controls.temperature.dismissError} aria-label="Dismiss">×</button>
        </div>
      ) : null}

      {open && interactive ? (
        <div className="nx-di25-temp-popover" role="listbox" aria-label="Edit temperature">
          {TEMP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === displayValue}
              className={cls('nx-di25-temp-popover__opt', opt.value === displayValue && 'is-selected')}
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
