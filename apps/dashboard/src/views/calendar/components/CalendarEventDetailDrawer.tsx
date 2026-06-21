import { createPortal } from 'react-dom'
import type { CalendarEvent } from '../../../lib/data/calendarData'
import { formatEntitySubtitle } from '../../../lib/calendar/calendar-entity-display'
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
  mobile?: boolean
  onAction: (action: CalendarDrawerAction) => void
  onClose: () => void
}

export function CalendarEventDetailDrawer({
  event,
  selectedThread,
  relatedEvents = [],
  developerMode = false,
  mobile = false,
  onAction,
  onClose,
}: CalendarEventDetailDrawerProps) {
  if (!event || typeof document === 'undefined') return null

  const ctx = event.deepLinkContext || {}
  const openActions: Array<{ id: CalendarDrawerAction; label: string; disabled?: boolean }> = [
    { id: 'conversation', label: 'Open Conversation', disabled: !event.threadId && !selectedThread?.id },
    { id: 'inbox', label: 'Open Inbox Thread', disabled: !event.threadId },
    { id: 'deal', label: 'Open Deal Intelligence', disabled: !event.threadId && !event.opportunityId },
    { id: 'comp', label: 'Open Comp Intelligence', disabled: !event.threadId && !event.opportunityId },
    { id: 'property', label: 'Open Property', disabled: !event.propertyId && !ctx.property_id },
    { id: 'map', label: 'Open Map' },
    { id: 'queue', label: 'Open Queue Item', disabled: !ctx.queue_row_id },
    { id: 'campaign', label: 'Open Campaign', disabled: !ctx.campaign_id },
    { id: 'workflow', label: 'Open Workflow Run', disabled: !ctx.workflow_enrollment_id },
    { id: 'contract', label: 'Open Closing Desk', disabled: !['contract_sent', 'contract_signature_deadline', 'fully_executed_contract', 'title_opened', 'title_milestone', 'clear_to_close', 'closing_scheduled'].includes(event.type) },
    { id: 'entity_graph', label: 'Open Entity Graph', disabled: !event.sellerId && !ctx.master_owner_id },
  ].filter((action) => !action.disabled)

  const operatorActions: Array<{ id: CalendarDrawerAction; label: string; danger?: boolean; disabled?: boolean }> = [
    { id: 'reschedule', label: 'Reschedule', disabled: !event.reschedulable },
    { id: 'complete', label: 'Mark Complete', disabled: !event.editable },
    { id: 'cancel', label: 'Cancel Event', disabled: !event.cancellable, danger: true },
  ]

  return createPortal(
    <div className={cls('nx-cal__event-backdrop', mobile && 'is-mobile')} role="presentation" onClick={onClose}>
      <aside
        className={cls('nx-cal__event-drawer', `is-${event.tone}`, mobile && 'is-bottom-sheet')}
        role="dialog"
        aria-label="Event details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nx-cal__event-drawer-head">
          <div className="nx-cal__event-drawer-icon" aria-hidden="true">
            <Icon name="calendar" />
          </div>
          <div>
            <strong>{event.title}</strong>
            <span>{new Date(event.timestamp).toLocaleString()} · {event.timezone || 'UTC'}</span>
            <div className="nx-cal__event-drawer-badges">
              <em>{event.status.replace(/_/g, ' ')}</em>
              <em className={event.overdue ? 'is-risk' : ''}>{event.riskState || (event.overdue ? 'overdue' : 'on track')}</em>
            </div>
          </div>
          <button type="button" className="nx-cal__icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="nx-cal__event-drawer-section">
          <span className="nx-cal__eyebrow">Entity</span>
          <p className="nx-cal__intel-meta">{formatEntitySubtitle(event)}</p>
          <div className="nx-cal__event-drawer-grid">
            <div><label>Seller / Owner</label><strong>{formatEntitySubtitle(event).split(' · ')[0]}</strong></div>
            <div><label>Property</label><strong>{event.propertyAddress || '—'}</strong></div>
            <div><label>Market</label><strong>{event.market}</strong></div>
            <div><label>Stage</label><strong>{event.metadata?.stage ? String(event.metadata.stage) : selectedThread?.conversationStage || '—'}</strong></div>
            <div><label>Status</label><strong>{event.status.replace(/_/g, ' ')}</strong></div>
            <div><label>Temperature</label><strong>{event.priority || selectedThread?.priority || 'normal'}</strong></div>
          </div>
        </div>

        <div className="nx-cal__event-drawer-section">
          <span className="nx-cal__eyebrow">Source</span>
          <strong>{event.sourceDomain || event.sourceTable}</strong>
          {event.description ? <p className="nx-cal__drawer-copy">{event.description}</p> : null}
          {event.metadata?.amount ? (
            <div className="nx-cal__drawer-money">{formatCurrency(Number(event.metadata.amount))}</div>
          ) : null}
        </div>

        {relatedEvents.length > 1 ? (
          <div className="nx-cal__event-drawer-section nx-cal__drawer-chain">
            <span className="nx-cal__eyebrow">Correlation chain</span>
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
          <pre className="nx-cal__drawer-dev">{JSON.stringify({ id: event.id, deepLink: event.deepLinkContext }, null, 2)}</pre>
        ) : null}

        {openActions.length ? (
          <div className="nx-cal__event-drawer-section">
            <span className="nx-cal__eyebrow">Open In…</span>
            <div className="nx-cal__event-drawer-actions nx-cal__event-drawer-actions--open">
              {openActions.map((action) => (
                <button key={action.id} type="button" className="nx-cal__drawer-action" onClick={() => onAction(action.id)}>
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="nx-cal__event-drawer-actions">
          {operatorActions.map((action) => (
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
    </div>,
    document.body,
  )
}