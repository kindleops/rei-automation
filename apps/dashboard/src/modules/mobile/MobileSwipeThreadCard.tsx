import { useRef, useState, type PointerEvent } from 'react'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { ConversationDecision } from '../../domain/inbox/inbox-decisioning'
import { MobileThreadCard } from './MobileThreadCard'

const SWIPE_THRESHOLD = 56

interface MobileSwipeThreadCardProps {
  thread: InboxWorkflowThread
  decision: ConversationDecision
  selected?: boolean
  onSelect: (id: string) => void
  onAction?: (id: string, action: string) => void
}

export const MobileSwipeThreadCard = ({
  thread,
  decision,
  selected,
  onSelect,
  onAction,
}: MobileSwipeThreadCardProps) => {
  const [offsetX, setOffsetX] = useState(0)
  const dragRef = useRef<{ startX: number; baseOffset: number } | null>(null)

  const reset = () => setOffsetX(0)

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, baseOffset: offsetX }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const delta = event.clientX - drag.startX
    const next = Math.max(-120, Math.min(120, drag.baseOffset + delta))
    setOffsetX(next)
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || !onAction) {
      reset()
      return
    }
    if (offsetX <= -SWIPE_THRESHOLD) {
      onAction(thread.id, thread.isArchived ? 'unarchive' : 'archive')
    } else if (offsetX >= SWIPE_THRESHOLD) {
      onAction(thread.id, thread.isStarred ? 'unstar' : 'star')
    }
    reset()
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="nx-mobile-swipe-card">
      <div className="nx-mobile-swipe-card__actions" aria-hidden>
        <span className="nx-mobile-swipe-card__action is-star">
          {thread.isStarred ? 'Unstar' : 'Star'}
        </span>
        <span className="nx-mobile-swipe-card__action is-archive">
          {thread.isArchived ? 'Restore' : 'Archive'}
        </span>
      </div>
      <div
        className="nx-mobile-swipe-card__surface"
        style={{ transform: offsetX ? `translateX(${offsetX}px)` : undefined }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={reset}
      >
        <MobileThreadCard
          thread={thread}
          decision={decision}
          selected={selected}
          onSelect={onSelect}
        />
      </div>
    </div>
  )
}