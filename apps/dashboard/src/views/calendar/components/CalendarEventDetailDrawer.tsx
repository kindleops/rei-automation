import type { CalendarEvent } from '../../../lib/data/calendarData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { formatCurrency, formatRelativeTime } from '../../../shared/formatters'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export type CalendarDrawerAction =
  | 'inbox'
  | 'conversation'
  | 'pipeline'
  | 'property'
  | 'map'
  | 'deal'
  | 'comp'
  | 'buyer'
  | 'queue'
  | 'campaign'
  | 'workflow'
  | 'contract'
  | 'entity_graph'
  | 'complete'
  | 'reschedule'
  | 'cancel'
  | 'retry'

type CalendarEventDetailDrawerProps = {
  event: CalendarEvent | null
  selectedThread: InboxWorkflowThread | null
  relatedEvents?: CalendarEvent[]
  developerMode?: boolean
  onAction: (action: CalendarDrawerAction) => void
  onClose: () => void
}

export function CalendarEventDetailDrawer({
  event,
  selectedThread,
  relatedEvents = [],
  developerMode = false,
  onAction,
  onClose,
}: CalendarEventDetailDrawerProps) {
  if (!event) return null

  const actions: Array<{ id: CalendarDrawerAction; label: string; danger?: boolean; disabled?: boolean }> = [
    { id: 'inbox', label: 'Open Inbox Thread' },
    { id: 'conversation', label: 'Open Conversation' },
    { id: 'pipeline', label: 'Open Pipeline' },
    { id: 'property', label: 'Open Property' },
    { id: 'map', label: 'Open Map' },
    { id: 'deal', label: 'Open Deal Intelligence' },
    { id: 'comp', label: 'Open Comp Intelligence' },
    { id: 'buyer', label: 'Open Buyer Match' },
    { id: 'queue', label: 'Open Queue Row', disabled: !event.deepLinkContext?.queue_row_id },
    { id: 'campaign', label: 'Open Campaign', disabled: !event.deepLinkContext?.campaign_id },
    { id: 'workflow', label: 'Open Workflow Run', disabled: !event.deepLinkContext?.workflow_enrollment_id },
    { id: 'contract', label: 'Open Contract / Closing' },
    { id: 'entity_graph', label: 'Open Entity Graph' },
    { id: 'reschedule', label: 'Reschedule', disabled: !event.reschedulable },
    { id: 'complete', label: 'Mark Complete', disabled: !event.editable },
    { id: 'cancel', label: 'Cancel', disabled: !event.cancellable, danger: true },
    { id: 'retry', label: 'Retry', disabled: event.type !== 'sms_failed' && event.type !== 'queue_retry' },
  ]

  return (
    <aside className="nx-cal__drawer">
      <div className="nx-cal__drawer-head">
        <div>
          <span className="nx-cal__eyebrow">{event.sourceTable.replace(/_/g, ' ')}</span>
          <strong>{event.title}</strong>
        </div>
        <button type="button" className="nx-cal__icon-btn" onClick={onClose} aria-label="Close event drawer">
          <Icon name="close" />
        </button>
      </div>

      <div className="nx-cal__drawer-grid">
        <div><label>Date / Time</label><strong>{new Date(event.timestamp).toLocaleString()}</strong></div>
        <div><label>Timezone</label><strong>{event.timezone || 'UTC'}</strong></div>
        <div><label>Status</label><strong>{event.status.replace(/_/g, ' ')}</strong></div>
        <div><label>Risk</label><strong>{event.riskState || (event.overdue ? 'overdue' : 'on_track')}</strong></div>
        <div><label>Seller</label><strong>{event.sellerName}</strong></div>
        <div><label>Property</label><strong>{event.propertyAddress}</strong></div>
        <div><label>Market</label><strong>{event.market}</strong></div>
        <div><label>Stage</label><strong>{event.metadata?.stage ? String(event.metadata.stage) : selectedThread?.conversationStage || '—'}</strong></div>
        <div><label>Resolution</label><strong>{event.resolutionSource || event.unresolvedReason || 'canonical'}</strong></div>
        <div><label>Source</label><strong>{event.sourceDomain || event.sourceTable}</strong></div>
      </div>

      <p className="nx-cal__drawer-copy">{event.description}</p>
      {event.metadata?.amount ? (
        <div className="nx-cal__drawer-money">{formatCurrency(Number(event.metadata.amount))}</div>
      ) : null}

      {relatedEvents.length > 1 ? (
        <div className="nx-cal__drawer-chain">
          <span className="nx-cal__eyebrow">Related chain</span>
          <ol>
            {relatedEvents.map((related) => (
              <li key={related.id}>
                <strong>{related.title}</strong>
                <span>{formatRelativeTime(related.timestamp)} · {related.status}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {developerMode ? (
        <pre className="nx-cal__drawer-dev">{JSON.stringify({ id: event.id, deepLink: event.deepLinkContext, sourceRecordId: event.sourceRecordId }, null, 2)}</pre>
      ) : null}

      <div className="nx-cal__drawer-actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={cls('nx-cal__drawer-action', action.danger && 'is-danger')}
            disabled={action.disabled}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </aside>
  )
}