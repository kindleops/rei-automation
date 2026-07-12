import { useEffect, useRef } from 'react'
import type { ThreadMessage } from '../../../lib/data/inboxData'
import { buildMessageTimelineMeta, formatDateSeparator } from './seller-map-card-message-utils'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type ThreadEmptyState = {
  hasMessages: boolean
  recipientName: string
  canSendOwnershipCheck: boolean
  blockedReason: string | null
  onInsertOwnershipCheck?: () => void
}

export const SellerMapCardThreadList = ({
  messages,
  loading = false,
  error = null,
  onRetry,
  translations = {},
  emptyState,
}: {
  messages: ThreadMessage[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  translations?: Record<string, string>
  emptyState?: ThreadEmptyState
}) => {
  const listRef = useRef<HTMLDivElement>(null)
  const timeline = buildMessageTimelineMeta(messages)

  useEffect(() => {
    if (!loading && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, loading])

  if (loading) return null

  if (error) {
    return (
      <div className="smc-thread__state smc-thread__state--error">
        <p>{error}</p>
        {onRetry ? (
          <button type="button" className="smc-thread__retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    )
  }

  if (messages.length === 0) {
    const blocked = emptyState?.blockedReason
    const canOwnershipCheck = emptyState?.canSendOwnershipCheck && emptyState.onInsertOwnershipCheck
    return (
      <div className="smc-thread__state smc-thread__state--empty">
        <p className="smc-thread__empty-title">No messages yet.</p>
        {canOwnershipCheck ? (
          <p className="smc-thread__empty-copy">Ownership check is ready for this property.</p>
        ) : blocked ? (
          <p className="smc-thread__empty-copy">{blocked}</p>
        ) : (
          <p className="smc-thread__empty-copy">
            {emptyState?.recipientName
              ? `Resolve a valid SMS recipient before messaging ${emptyState.recipientName}.`
              : 'Resolve a valid SMS recipient before sending.'}
          </p>
        )}
        {canOwnershipCheck ? (
          <button
            type="button"
            className="smc-thread__empty-action"
            onClick={emptyState.onInsertOwnershipCheck}
          >
            Insert Ownership Check
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={listRef} className="nx-message-list smc-thread__list">
      {timeline.map(({ message, showDateSeparator, deliveryBadge, receiptMeta, formattedTime, timestampIso }) => {
        const isOutbound = message.direction === 'outbound'
        const translated = translations[message.id]
        const body = translated || message.body || ''
        return (
          <div key={message.id}>
            {showDateSeparator ? (
              <div className="nx-msg-day" role="separator" aria-label={timestampIso}>
                <span>{formatDateSeparator(timestampIso)}</span>
              </div>
            ) : null}
            <div className={cls('nx-msg-lane', isOutbound ? 'is-outbound' : 'is-inbound')}>
              <div className={cls(
                'nx-msg',
                isOutbound ? 'is-outbound' : 'is-inbound',
                deliveryBadge === 'failed' && 'is-failed',
                deliveryBadge === 'scheduled' && 'is-scheduled',
                deliveryBadge === 'sending' && 'is-sending',
              )}>
                <div className="nx-msg__bubble">
                  {body || <em>No content</em>}
                  {translated ? <span className="smc-thread__translated">Translated</span> : null}
                </div>
                <div className="nx-msg__meta">
                  <span>{formattedTime}</span>
                  {isOutbound ? (
                    <span className={cls('nx-msg__receipt', `is-${deliveryBadge}`)}>
                      {receiptMeta.icon} {receiptMeta.label}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}