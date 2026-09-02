import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { patchLeadStateFromView } from '../../../domain/lead-state/persistUniversalLeadState'
import type { LifecycleStageCode } from '../../../domain/lead-state/universal-lead-state-registry'
import { StageChangeConfirmModal } from '../../inbox/components/StageChangeConfirmModal'
import type { ThreadStage, ThreadStatus, ThreadTemperature } from '../../inbox/status-visuals'
import {
  STAGE_OPTIONS,
  STATUS_OPTIONS,
  TEMP_OPTIONS,
  useLeadStateSync,
  type DealIntelligenceLeadStateData,
  type PillOption,
} from '../DealIntelligenceLeadStateBar'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * Stage / Status / Temperature on mobile.
 *
 * Deliberately built on the same `useLeadStateSync` + `patchLeadStateFromView`
 * path the desktop bar uses — same canonical fields, same optimistic commit,
 * same stage-change confirmation. Only the presentation is mobile-native: a
 * full-width sheet instead of an anchored dropdown, because a portal menu
 * positioned off a 110px-wide button is unusable at 375px.
 */

interface SheetState<T extends string> {
  title: string
  value: T
  options: PillOption<T>[]
  onPick: (next: T) => void
}

function OptionSheet<T extends string>({ sheet, onClose }: { sheet: SheetState<T>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="msc-sheet-root" role="dialog" aria-modal="true" aria-label={sheet.title}>
      <button type="button" className="msc-sheet-scrim" aria-label="Close" onClick={onClose} />
      <div className="msc-sheet">
        <div className="msc-sheet__grip" aria-hidden="true" />
        <h3 className="msc-sheet__title">{sheet.title}</h3>
        <div className="msc-sheet__options">
          {sheet.options.map((opt) => {
            const selected = opt.value === sheet.value
            return (
              <button
                key={opt.value}
                type="button"
                className={cls('msc-sheet__option', selected && 'is-selected')}
                aria-pressed={selected}
                onClick={() => { sheet.onPick(opt.value); onClose() }}
              >
                <span className="msc-sheet__dot" style={{ background: opt.visual.color }} aria-hidden="true" />
                <span className="msc-sheet__label">{opt.visual.label}</span>
                {selected ? <Icon name="check" className="msc-sheet__check" /> : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ControlPill({
  label,
  value,
  color,
  pending,
  error,
  locked,
  onOpen,
}: {
  label: string
  value: string
  color: string
  pending: boolean
  error: boolean
  locked?: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={cls('msc-ctrl', pending && 'is-pending', error && 'is-error')}
      // Only the raw hue goes inline. An inline `--msc-ctrl-color` would outrank
      // the light-theme rule that derives a darker variant from it.
      style={{ ['--msc-ctrl-raw' as string]: color }}
      onClick={onOpen}
    >
      <span className="msc-ctrl__label">{label}</span>
      <span className="msc-ctrl__value">
        {value}
        {locked ? <Icon name="key" className="msc-ctrl__lock" /> : null}
      </span>
    </button>
  )
}

export function MobileWorkflowControls({
  data,
  onPatched,
}: {
  data: DealIntelligenceLeadStateData
  onPatched?: () => void
}) {
  const { status, stage, temperature, manualStageLock, manualTemperatureLock } = useLeadStateSync(data)
  const [sheet, setSheet] = useState<SheetState<string> | null>(null)
  const [stageConfirm, setStageConfirm] = useState<{ open: boolean; next: ThreadStage | null }>({
    open: false, next: null,
  })

  const persist = async (patch: Record<string, string>, executeNextAction = false) => {
    const result = await patchLeadStateFromView('deal_intelligence', data.threadKey, patch, {
      execute_next_action: executeNextAction,
    })
    if (result.ok) onPatched?.()
    return { ok: result.ok }
  }

  const handleStageConfirm = async (executeNextAction: boolean) => {
    const next = stageConfirm.next
    if (!next) return
    setStageConfirm({ open: false, next: null })
    await stage.commit(next, () => persist({ lifecycle_stage: next }, executeNextAction))
  }

  const visualFor = <T extends string>(options: PillOption<T>[], value: T) =>
    options.find((o) => o.value === value)?.visual ?? options[0]?.visual

  const stageVisual = visualFor(STAGE_OPTIONS, stage.value)
  const statusVisual = visualFor(STATUS_OPTIONS, status.value)
  const tempVisual = visualFor(TEMP_OPTIONS, temperature.value)

  return (
    <>
      <div className="msc-controls" aria-label="Workflow controls">
        <ControlPill
          label="Stage"
          value={stageVisual?.label ?? '—'}
          /* Stage is a position in a pipeline, not an alarm. Giving each of the
             ten stages its own hue is the "rainbow semantics" the rebuild is
             meant to remove, and those hues are fixed dark-theme blues that
             clash on red_ops and wash out on light. The theme accent carries it;
             temperature keeps its own colour because Cold/Warm/Hot really is
             encoded by hue. */
          color="var(--msc-accent)"
          pending={stage.pending}
          error={stage.error}
          locked={manualStageLock}
          onOpen={() => setSheet({
            title: 'Lifecycle stage',
            value: stage.value,
            options: STAGE_OPTIONS as PillOption<string>[],
            onPick: (next) => {
              if (next === stage.value) return
              setStageConfirm({ open: true, next: next as ThreadStage })
            },
          })}
        />
        <ControlPill
          label="Status"
          value={statusVisual?.label ?? '—'}
          color={statusVisual?.color ?? 'var(--msc-accent)'}
          pending={status.pending}
          error={status.error}
          onOpen={() => setSheet({
            title: 'Operational status',
            value: status.value,
            options: STATUS_OPTIONS as PillOption<string>[],
            onPick: (next) => void status.commit(next as ThreadStatus, () =>
              persist({ operational_status: next })),
          })}
        />
        <ControlPill
          label="Temp"
          value={tempVisual?.label ?? '—'}
          color={tempVisual?.color ?? 'var(--msc-accent)'}
          pending={temperature.pending}
          error={temperature.error}
          locked={manualTemperatureLock}
          onOpen={() => setSheet({
            title: 'Lead temperature',
            value: temperature.value,
            options: TEMP_OPTIONS as PillOption<string>[],
            onPick: (next) => void temperature.commit(next as ThreadTemperature, () =>
              persist({ lead_temperature: next })),
          })}
        />
      </div>

      {sheet ? <OptionSheet sheet={sheet} onClose={() => setSheet(null)} /> : null}

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
