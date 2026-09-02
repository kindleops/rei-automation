import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface QueueSelectionCapability {
  retry: number
  reschedule: number
  pause: number
  cancel: number
  suppress: number
  excluded: number
}

interface QueueMobileSelectionBarProps {
  selectedCount: number
  capability: QueueSelectionCapability
  onRetry: () => void
  onReschedule: () => void
  onPause: () => void
  onCancel: () => void
  onSuppress: () => void
  onOpenFailures: () => void
  onClear: () => void
}

/**
 * Deliberate selection mode. Sits above the mobile dock, enables only the
 * actions valid for the current selection, and keeps destructive work behind
 * More so a mis-tap cannot suppress live rows.
 */
export function QueueMobileSelectionBar({
  selectedCount,
  capability,
  onRetry,
  onReschedule,
  onPause,
  onCancel,
  onSuppress,
  onOpenFailures,
  onClear,
}: QueueMobileSelectionBarProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  if (selectedCount === 0) return null

  const run = (fn: () => void) => () => { setMoreOpen(false); fn() }

  const more = moreOpen && typeof document !== 'undefined' ? createPortal(
    <MobileBottomSheet open snap="half" onClose={() => setMoreOpen(false)} className="qm-more-sheet">
      <div className="qm-more">
        {/* The shared sheet backdrop is globally display:none, so every sheet
            needs its own explicit dismiss. */}
        <header className="qm-more__head">
          <strong>{selectedCount} selected</strong>
          <span className="qm-more__head-trail">
            {capability.excluded > 0 && <span className="qm-more__excluded">{capability.excluded} excluded from retry</span>}
            <button type="button" className="qms-chrome__btn is-close" onClick={() => setMoreOpen(false)} aria-label="Close actions">
              <Icon name="close" size={14} />
            </button>
          </span>
        </header>
        <button type="button" className="qm-more__action" disabled={capability.cancel === 0} onClick={run(onCancel)}>
          <Icon name="close" size={14} />
          <span><strong>Cancel</strong><em>Stop {capability.cancel} row{capability.cancel === 1 ? '' : 's'} before send</em></span>
        </button>
        <button type="button" className="qm-more__action is-danger" disabled={capability.suppress === 0} onClick={run(onSuppress)}>
          <Icon name="shield" size={14} />
          <span><strong>Suppress</strong><em>Irreversible — blocks future sends to these contacts</em></span>
        </button>
        <button type="button" className="qm-more__action" onClick={run(onOpenFailures)}>
          <Icon name="alert-circle" size={14} />
          <span><strong>Failure details</strong><em>Open the failure taxonomy for these rows</em></span>
        </button>
        <button type="button" className="qm-more__action is-quiet" onClick={run(onClear)}>
          <Icon name="check" size={14} />
          <span><strong>Clear selection</strong></span>
        </button>
      </div>
    </MobileBottomSheet>,
    document.body,
  ) : null

  return (
    <>
      <div className="qm-selbar" role="toolbar" aria-label="Selection actions">
        <div className="qm-selbar__count">
          <strong>{selectedCount}</strong>
          <span>selected</span>
        </div>
        <div className="qm-selbar__actions">
          <button type="button" className="qm-selbtn is-primary" disabled={capability.retry === 0} onClick={onRetry}>
            <Icon name="zap" size={12} />
            Retry
          </button>
          <button type="button" className="qm-selbtn" disabled={capability.reschedule === 0} onClick={onReschedule}>
            <Icon name="clock" size={12} />
            Reschedule
          </button>
          <button type="button" className="qm-selbtn" disabled={capability.pause === 0} onClick={onPause}>
            <Icon name="pause" size={12} />
            Pause
          </button>
          <button type="button" className={cls('qm-selbtn', 'is-more', moreOpen && 'is-active')} onClick={() => setMoreOpen(true)}>
            More
            <Icon name="chevron-up" size={12} />
          </button>
        </div>
      </div>
      {more}
    </>
  )
}
