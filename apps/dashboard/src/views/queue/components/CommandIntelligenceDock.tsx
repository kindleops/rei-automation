import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import {
  buildOperationsPulse,
  displayName,
  isNonRetryableRow,
  resolveSellerIdentity,
  resolveStatusPresentation,
  type ExceptionItem,
  type QueueKpiCounts,
  type QueueSection,
} from '../queue-ui-helpers'
import type { QueueItem } from '../../../domain/queue/queue.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const InspRow = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
  <div className="occ-insp-row">
    <span className="occ-insp-label">{label}</span>
    <span className={cls('occ-insp-value', tone && `is-${tone}`)}>{value || '—'}</span>
  </div>
)

interface CommandIntelligenceDockProps {
  section: QueueSection
  items: QueueItem[]
  kpi: QueueKpiCounts
  model: { sentTodayCount?: number; safeCapacityRemaining?: number } | null
  selectedItem: QueueItem | null
  selectedTemplate: { id: string; name: string; sent: number; delivered: number; failed: number; healthLabel: string; sampleBody?: string } | null
  selectedSender: { phone: string; market: string; state: string; deliveryPct: number; failPct: number; violations21610: number } | null
  selectedMarket: { market: string; total: number; deliveryPct: number; health: string; senderExists: boolean } | null
  selectedFailure: { cause: string; label: string; count: number; retryable: boolean; action: string } | null
  selectedEvent: QueueItem | null
  topException: ExceptionItem | null
  onAction: (action: string, id: string) => void
  onViewFailureRows: (cause: string) => void
}

export function CommandIntelligenceDock(props: CommandIntelligenceDockProps) {
  const [collapsed, setCollapsed] = useState(false)
  const ops = buildOperationsPulse(props.items, props.kpi, props.model)

  if (collapsed) {
    return (
      <aside className="occ-cmd-dock is-collapsed">
        <button type="button" className="occ-cmd-dock__expand" onClick={() => setCollapsed(false)} aria-label="Expand intelligence">
          <Icon name="chevron-left" size={14} />
        </button>
        <div className="occ-cmd-dock__mini">
          <span className={cls('occ-cmd-dock__pulse', `is-${ops.processorState}`)}>{ops.processorLabel}</span>
          {props.kpi.failed > 0 && <span className="is-red">{props.kpi.failed}</span>}
        </div>
      </aside>
    )
  }

  const { selectedItem, onAction } = props

  if (selectedItem) {
    const identity = resolveSellerIdentity(selectedItem)
    const statusView = resolveStatusPresentation(selectedItem)
    const retryBlocked = isNonRetryableRow(selectedItem)
    return (
      <aside className="occ-cmd-dock occ-dossier">
        <header className="occ-cmd-dock__head">
          <div>
            <strong>{identity.primary}</strong>
            <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
          </div>
          <div className="occ-cmd-dock__head-actions">
            <button type="button" onClick={() => onAction('deselect', selectedItem.id)} aria-label="Close"><Icon name="close" size={12} /></button>
            <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse"><Icon name="chevron-right" size={12} /></button>
          </div>
        </header>
        <div className="occ-cmd-dock__body">
          <InspRow label="Property" value={selectedItem.propertyAddress} />
          <InspRow label="Stage" value={`${selectedItem.stageLabel ?? '—'} · T${selectedItem.touchNumber}`} />
          <InspRow label="Campaign" value={selectedItem.campaignName} />
          <InspRow label="Template" value={selectedItem.templateName} />
          <InspRow label="Sender" value={selectedItem.fromPhoneNumber} />
          {selectedItem.messageText && (
            <div className="occ-insp-section">
              <div className="occ-insp-section-title">Message</div>
              <p className="occ-insp-message">{selectedItem.messageText}</p>
            </div>
          )}
          <InspRow label="Provider" value={selectedItem.deliveryStatus} />
          <InspRow label="Retry" value={retryBlocked ? 'Non-retryable' : selectedItem.retryEligible ? 'Eligible' : 'No'} tone={selectedItem.retryEligible && !retryBlocked ? 'green' : undefined} />
          {statusView.blocking && <InspRow label="Blocking" value={statusView.blocking} tone="red" />}
        </div>
        <footer className="occ-cmd-dock__actions">
          {selectedItem.status === 'approval' && <button className="occ-action-btn is-primary" onClick={() => onAction('approve', selectedItem.id)}>Approve</button>}
          {(selectedItem.status === 'failed' || selectedItem.status === 'retry') && selectedItem.retryEligible && !retryBlocked && (
            <button className="occ-action-btn is-primary" onClick={() => onAction('retry', selectedItem.id)}>Retry</button>
          )}
          <button className="occ-action-btn is-danger" onClick={() => onAction('cancel', selectedItem.id)}>Suppress</button>
        </footer>
      </aside>
    )
  }

  return (
    <aside className={cls('occ-cmd-dock', `is-tab-${props.section}`)}>
      <header className="occ-cmd-dock__head">
        <span className="occ-cmd-dock__title">Command Intelligence</span>
        <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse"><Icon name="chevron-right" size={12} /></button>
      </header>
      <div className="occ-cmd-dock__body">
        <div className="occ-cmd-dock__ops">
          <span className={cls('occ-cmd-dock__proc', `is-${ops.processorState}`)}>
            <span className="occ-cmd-dock__dot" />{ops.processorLabel}
          </span>
          <div className="occ-cmd-dock__ops-grid">
            <span>{ops.jobsLastHour}/hr</span>
            <span>{ops.activeSenders} senders</span>
            <span>{ops.pendingRetries} retry</span>
            <span>{ops.blockedRows} blocked</span>
          </div>
          {ops.nextScheduled && <small>Next: {new Date(ops.nextScheduled).toLocaleString()}</small>}
          {ops.throughputLabel && <small>{ops.throughputLabel}</small>}
        </div>

        {props.topException && (
          <button
            type="button"
            className="occ-cmd-dock__urgent"
            onClick={() => props.topException?.causeKey && props.onViewFailureRows(props.topException.causeKey)}
          >
            <span className="is-red">{props.topException.count}</span> {props.topException.label}
          </button>
        )}

        {props.section === 'templates' && props.selectedTemplate && (
          <div className="occ-insp-section">
            <InspRow label="Template" value={props.selectedTemplate.name} />
            <InspRow label="Health" value={props.selectedTemplate.healthLabel} />
            <InspRow label="Sent/Del" value={`${props.selectedTemplate.sent} / ${props.selectedTemplate.delivered}`} />
            <InspRow label="Failed" value={props.selectedTemplate.failed} tone={props.selectedTemplate.failed > 0 ? 'red' : undefined} />
          </div>
        )}
        {props.section === 'senders' && props.selectedSender && (
          <div className="occ-insp-section">
            <InspRow label="Number" value={props.selectedSender.phone} />
            <InspRow label="Market" value={props.selectedSender.market} />
            <InspRow label="21610" value={props.selectedSender.violations21610} tone={props.selectedSender.violations21610 > 0 ? 'red' : undefined} />
            <InspRow label="Delivery" value={`${props.selectedSender.deliveryPct}%`} />
          </div>
        )}
        {props.section === 'market' && props.selectedMarket && (
          <div className="occ-insp-section">
            <InspRow label="Market" value={props.selectedMarket.market} />
            <InspRow label="Rows" value={props.selectedMarket.total} />
            <InspRow label="Delivery" value={`${props.selectedMarket.deliveryPct}%`} />
          </div>
        )}
        {props.section === 'failures' && props.selectedFailure && (
          <div className="occ-insp-section">
            <InspRow label="Cause" value={props.selectedFailure.label} tone="red" />
            <InspRow label="Affected" value={props.selectedFailure.count} />
            <p className="occ-failure-card__action">{props.selectedFailure.action}</p>
          </div>
        )}
        {props.section === 'events' && props.selectedEvent && (
          <div className="occ-insp-section">
            <InspRow label="Seller" value={displayName(props.selectedEvent)} />
            <InspRow label="Event" value={props.selectedEvent.lastEventType ?? props.selectedEvent.status} />
            <InspRow label="Market" value={props.selectedEvent.market} />
          </div>
        )}
      </div>
    </aside>
  )
}