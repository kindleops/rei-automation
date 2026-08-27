import { Icon } from '../../../../shared/icons'

interface QueueMobilePagerProps {
  rowStart: number
  rowEnd: number
  totalCount: number
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
}

/** Mobile pagination: position + forward motion. Previous only when relevant. */
export function QueueMobilePager({
  rowStart,
  rowEnd,
  totalCount,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: QueueMobilePagerProps) {
  if (totalCount === 0) return null
  return (
    <div className="qm-pager">
      <span className="qm-pager__count">
        Showing {rowStart.toLocaleString()}–{rowEnd.toLocaleString()} of {totalCount.toLocaleString()}
      </span>
      <div className="qm-pager__nav">
        {hasPrev && (
          <button type="button" className="qm-pager__btn" onClick={onPrev}>
            <Icon name="chevron-left" size={13} />
            Prev
          </button>
        )}
        {hasNext && (
          <button type="button" className="qm-pager__btn is-next" onClick={onNext}>
            Next
            <Icon name="chevron-right" size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
