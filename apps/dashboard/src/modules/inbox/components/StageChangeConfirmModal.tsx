import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import {
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  type LifecycleStageCode,
} from '../../../domain/lead-state/universal-lead-state-registry'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export interface StageChangeConfirmModalProps {
  open: boolean
  fromStage: LifecycleStageCode | null
  toStage: LifecycleStageCode | null
  pending?: boolean
  onChangeStageOnly: (reason: string) => void
  onChangeStageAndRunAction: (reason: string) => void
  onCancel: () => void
}

/**
 * WHEN THE SERVER WILL DEMAND A REASON.
 *
 * validateStageTransition refuses a backward or stage-skipping move, and any
 * move out of a terminal stage, unless a reason is supplied. It did so
 * silently: the patch dropped `lifecycle_stage`, kept the rest, and answered
 * ok -- so the pill showed the new stage, nothing was stored, and the old one
 * returned on the next visit. Mirroring the rule here lets the operator supply
 * what the write actually requires instead of discovering it by regression.
 */
const TERMINAL_STAGES = new Set<string>(['closed'])

export function stageChangeNeedsReason(
  from: LifecycleStageCode | null,
  to: LifecycleStageCode | null,
): boolean {
  if (!from || !to || from === to) return false
  if (TERMINAL_STAGES.has(from)) return true
  const order = LIFECYCLE_STAGE_ORDER as readonly string[]
  const fromIndex = order.indexOf(from)
  const toIndex = order.indexOf(to)
  if (fromIndex < 0 || toIndex < 0) return false
  const backward = toIndex < fromIndex
  const skipped = Math.abs(toIndex - fromIndex) - 1 > 0
  return backward || skipped
}

function stageLabel(code: LifecycleStageCode | null): string {
  if (!code) return 'Unknown'
  const meta = LIFECYCLE_STAGE_META[code]
  return meta ? `${meta.shortLabel} ${meta.label}` : code
}

export function StageChangeConfirmModal({
  open,
  fromStage,
  toStage,
  pending = false,
  onChangeStageOnly,
  onChangeStageAndRunAction,
  onCancel,
}: StageChangeConfirmModalProps) {
  const [reason, setReason] = useState('')
  const needsReason = stageChangeNeedsReason(fromStage, toStage)
  const reasonReady = !needsReason || reason.trim().length >= 3

  // A reason must not survive into the next, unrelated stage change.
  useEffect(() => { if (!open) setReason('') }, [open])

  if (!open || !toStage || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="nx-modal-overlay nx-stage-change-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nx-stage-change-title"
      onClick={onCancel}
    >
      <div
        className="nx-modal-content nx-status-menu-modal nx-stage-change-modal__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="nx-status-menu-modal__hdr">
          <div className="nx-stage-change-modal__title-wrap">
            <Icon name="layers" size={16} />
            <span id="nx-stage-change-title">Confirm Stage Change</span>
          </div>
          <button type="button" onClick={onCancel} disabled={pending} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="nx-stage-change-modal__body">
          <p className="nx-stage-change-modal__copy">
            Move this lead from <strong>{stageLabel(fromStage)}</strong> to <strong>{stageLabel(toStage)}</strong>?
          </p>
          <p className="nx-stage-change-modal__hint">
            Choose whether to update the stage only, or also run the next automatic action for the new stage.
          </p>

          {needsReason ? (
            <label className="nx-stage-change-modal__reason">
              <span>
                {TERMINAL_STAGES.has(String(fromStage))
                  ? 'Reopening a closed stage needs a reason'
                  : 'Moving backward or skipping stages needs a reason'}
              </span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. seller re-engaged after price drop"
                rows={2}
                disabled={pending}
                autoFocus
              />
            </label>
          ) : null}
        </div>

        <footer className="nx-stage-change-modal__actions">
          <button
            type="button"
            className="nx-btn nx-btn--secondary"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={cls('nx-btn', 'nx-btn--secondary', pending && 'is-busy')}
            onClick={() => onChangeStageOnly(reason.trim())}
            disabled={pending || !reasonReady}
          >
            Change Stage Only
          </button>
          <button
            type="button"
            className={cls('nx-btn', 'nx-btn--primary', pending && 'is-busy')}
            onClick={() => onChangeStageAndRunAction(reason.trim())}
            disabled={pending || !reasonReady}
          >
            <Icon name="zap" size={14} />
            Change Stage + Run Next Action
          </button>
        </footer>
      </div>

      <style>{`
        .nx-stage-change-modal__panel {
          width: min(480px, 92vw);
        }
        .nx-stage-change-modal__title-wrap {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .nx-stage-change-modal__body {
          padding: 16px;
          display: grid;
          gap: 10px;
        }
        .nx-stage-change-modal__copy,
        .nx-stage-change-modal__hint {
          margin: 0;
          font-size: 13px;
          line-height: 1.45;
          color: var(--nexus-text, #e8edf7);
        }
        .nx-stage-change-modal__hint {
          color: var(--nexus-muted, #9ba8c0);
          font-size: 12px;
        }
        .nx-stage-change-modal__reason {
          display: grid;
          gap: 6px;
          font-size: 12px;
          color: var(--nexus-muted, #9ba8c0);
        }
        .nx-stage-change-modal__reason textarea {
          width: 100%;
          resize: vertical;
          min-height: 52px;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.05);
          color: var(--nexus-text, #e8edf7);
          font: inherit;
        }
        .nx-stage-change-modal__actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 16px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .nx-stage-change-modal__actions .nx-btn--primary {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
      `}</style>
    </div>,
    document.body,
  )
}