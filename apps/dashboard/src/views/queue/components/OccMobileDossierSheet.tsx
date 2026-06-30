import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { MobileBottomSheet } from '../../../modules/mobile/MobileBottomSheet'
import { OccPropertyInspector } from './OccPropertyInspector'
import { isNonRetryableRow, resolveSellerIdentity } from '../queue-ui-helpers'
import type { QueueItem } from '../../../domain/queue/queue.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface OccMobileDossierSheetProps {
  open: boolean
  item: QueueItem | null
  mode: 'queue' | 'event'
  index: number
  total: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onAction: (action: string, id: string) => void
}

export function OccMobileDossierSheet({
  open,
  item,
  mode,
  index,
  total,
  onClose,
  onPrev,
  onNext,
  onAction,
}: OccMobileDossierSheetProps) {
  if (!open || !item || typeof document === 'undefined') return null

  const retryBlocked = isNonRetryableRow(item)
  const identity = resolveSellerIdentity(item)
  const hasPrev = index > 0
  const hasNext = index < total - 1

  const actions = mode === 'queue' ? (
    <>
      {item.status === 'approval' && (
        <button type="button" className="occ-action-btn is-primary" onClick={() => onAction('approve', item.id)}>Approve</button>
      )}
      {(item.status === 'failed' || item.status === 'retry') && item.retryEligible && !retryBlocked && (
        <button type="button" className="occ-action-btn is-primary" onClick={() => onAction('retry', item.id)}>Retry</button>
      )}
      <button type="button" className="occ-action-btn is-danger" onClick={() => onAction('cancel', item.id)}>Suppress</button>
    </>
  ) : (
    <button type="button" className="occ-action-btn is-secondary" onClick={() => onAction('open-queue-row', item.id)}>
      Open Queue Row
    </button>
  )

  return createPortal(
    <MobileBottomSheet
      open
      snap="expanded"
      onClose={onClose}
      className="occ-mobile-dossier-sheet"
    >
      <div className="occ-mobile-dossier-sheet__chrome">
        <div className="occ-mobile-dossier-sheet__lead">
          <span className="occ-mobile-dossier-sheet__eyebrow">{mode === 'event' ? 'Event' : 'Queue item'}</span>
          <strong className="occ-mobile-dossier-sheet__title">{identity.primary}</strong>
        </div>
        <div className="occ-mobile-dossier-sheet__nav">
          <button type="button" className="occ-mobile-dossier-sheet__nav-btn" disabled={!hasPrev} onClick={onPrev} aria-label="Previous item">
            <Icon name="chevron-left" size={16} />
            <span>Prev</span>
          </button>
          <span className="occ-mobile-dossier-sheet__counter">{index + 1} / {total}</span>
          <button type="button" className="occ-mobile-dossier-sheet__nav-btn" disabled={!hasNext} onClick={onNext} aria-label="Next item">
            <span>Next</span>
            <Icon name="chevron-right" size={16} />
          </button>
        </div>
        <button type="button" className="occ-mobile-dossier-sheet__close" onClick={onClose} aria-label="Close dossier">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className={cls('occ-mobile-dossier-sheet__content', `is-mode-${mode}`)}>
        <OccPropertyInspector
          item={item}
          mode={mode}
          onOpenQueueRow={mode === 'event' ? () => onAction('open-queue-row', item.id) : undefined}
          actions={actions}
        />
      </div>
    </MobileBottomSheet>,
    document.body,
  )
}