import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { LIFECYCLE_STAGE_META, type LifecycleStageCode } from '../../../domain/lead-state/universal-lead-state-registry'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export interface StageChangeConfirmModalProps {
  open: boolean
  fromStage: LifecycleStageCode | null
  toStage: LifecycleStageCode | null
  pending?: boolean
  onChangeStageOnly: () => void
  onChangeStageAndRunAction: () => void
  onCancel: () => void
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
            onClick={onChangeStageOnly}
            disabled={pending}
          >
            Change Stage Only
          </button>
          <button
            type="button"
            className={cls('nx-btn', 'nx-btn--primary', pending && 'is-busy')}
            onClick={onChangeStageAndRunAction}
            disabled={pending}
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