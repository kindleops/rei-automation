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
import { ExceptionsCenter } from './ExceptionsCenter'

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
  exceptions: ExceptionItem[]
  onAction: (action: string, id: string) => void
  onRequestConfirm: (action: string) => void
  onViewFailureRows: (cause: string) => void
  onClose: () => void
}

export function CommandIntelligenceDock(props: CommandIntelligenceDockProps) {
  const [collapsed, setCollapsed] = useState(false)
  const ops = buildOperationsPulse(props.items, props.kpi, props.model)

  if (collapsed) {
    return (
      <aside className="occ-cmd-dock is-collapsed">
        <button type="button" className="occ-cmd-dock__expand" onClick={() => setCollapsed(false)} aria-label="Expand intelligence dock">
          <Icon name="chevron-left" size={14} />
        </button>
        <div className="occ-cmd-dock__mini">
          <span className={cls('occ-cmd-dock__pulse', `is-${ops.processorState}`)}>{ops.processorLabel}</span>
          {props.kpi.failed > 0 && <span className="is-red">{props.kpi.failed}</span>}
          {props.kpi.approval > 0 && <span className="is-amber">{props.kpi.approval}</span>}
        </div>
      </aside>
    )
  }

  const { selectedItem, onAction, onClose } = props

  if (selectedItem) {
    const identity = resolveSellerIdentity(selectedItem)
    const statusView = resolveStatusPresentation(selectedItem)
    const retryBlocked = isNonRetryableRow(selectedItem)
    return (
      <aside className="occ-cmd-dock occ-dossier is-expanded">
        <div className="occ-dossier__atmo" aria-hidden="true" />
        <header className="occ-cmd-dock__head">
          <div>
            <strong>{identity.primary}</strong>
            <span className={cls('occ-status-pill', `is-${statusView.tone}`)}>{statusView.primary}</span>
          </div>
          <button type="button" onClick={() => onAction('deselect', selectedItem.id)} aria-label="Close dossier"><Icon name="close" size={12} /></button>
        </header>
        <div className="occ-cmd-dock__body">
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Identity</div>
            <InspRow label="Seller" value={identity.primary} />
            {identity.masterOwner && <InspRow label="Master Owner" value={identity.masterOwner} />}
            <InspRow label="Property" value={selectedItem.propertyAddress} />
            <InspRow label="Market" value={selectedItem.market} />
          </div>
          <div className="occ-insp-section">
            <div className="occ-insp-section-title">Delivery Progression</div>
            <InspRow label="Status" value={statusView.primary} tone={statusView.tone} />
            <InspRow label="Provider" value={selectedItem.deliveryStatus} />
            <InspRow label="Retries" value={`${selectedItem.retryCount}/${selectedItem.maxRetries}`} />
            <InspRow label="Retry" value={retryBlocked ? 'Non-retryable' : selectedItem.retryEligible ? 'Eligible' : 'No'} tone={selectedItem.retryEligible && !retryBlocked ? 'green' : undefined} />
          </div>
          {selectedItem.messageText && (
            <div className="occ-insp-section">
              <div className="occ-insp-section-title">Message</div>
              <p className="occ-insp-message">{selectedItem.messageText}</p>
            </div>
          )}
          {statusView.blocking && (
            <div className="occ-insp-section occ-insp-section--failure">
              <InspRow label="Blocking" value={statusView.blocking} tone="red" />
            </div>
          )}
        </div>
        <footer className="occ-cmd-dock__actions">
          {selectedItem.status === 'approval' && <button className="occ-action-btn is-primary" onClick={() => onAction('approve', selectedItem.id)}>Approve</button>}
          {(selectedItem.status === 'failed' || selectedItem.status === 'retry') && selectedItem.retryEligible && !retryBlocked && (
            <button className="occ-action-btn is-primary" onClick={() => onAction('retry', selectedItem.id)}>Retry</button>
          )}
          <button className="occ-action-btn is-danger" onClick={() => onAction('cancel', selectedItem.id)}>Suppress</button>
        </footer>
        <button type="button" className="occ-cmd-dock__collapse" onClick={() => setCollapsed(true)}>Collapse</button>
      </aside>
    )
  }

  return (
    <aside className={cls('occ-cmd-dock', `is-tab-${props.section}`)}>
      <header className="occ-cmd-dock__head">
        <span className="occ-cmd-dock__title">Command Intelligence</span>
        <button type="button" onClick={onClose} aria-label="Collapse dock"><Icon name="chevron-right" size={12} /></button>
      </header>
      <div className="occ-cmd-dock__body">
        {props.section === 'queue' && (
          <>
            <div className="occ-insp-section">
              <div className="occ-insp-section-title">Processor</div>
              <InspRow label="State" value={ops.processorLabel} tone={ops.processorState === 'running' ? 'cyan' : ops.processorState === 'degraded' ? 'amber' : undefined} />
              <InspRow label="Next operation" value={ops.nextScheduled ? new Date(ops.nextScheduled).toLocaleString() : '—'} />
              <InspRow label="Throughput" value={ops.throughputLabel ?? '—'} />
            </div>
            <ExceptionsCenter
              exceptions={props.exceptions.slice(0, 4)}
              selectedCause={null}
              onSelect={() => {}}
              onViewRows={props.onViewFailureRows}
              compact
            />
          </>
        )}
        {props.section === 'templates' && props.selectedTemplate && (
          <div className="occ-insp-section">
            <InspRow label="Template" value={props.selectedTemplate.name} />
            <InspRow label="Health" value={props.selectedTemplate.healthLabel} />
            <InspRow label="Sent" value={props.selectedTemplate.sent} />
            <InspRow label="Delivered" value={props.selectedTemplate.delivered} tone="green" />
            <InspRow label="Failed" value={props.selectedTemplate.failed} tone={props.selectedTemplate.failed > 0 ? 'red' : undefined} />
          </div>
        )}
        {props.section === 'senders' && props.selectedSender && (
          <div className="occ-insp-section">
            <InspRow label="Number" value={props.selectedSender.phone} />
            <InspRow label="Market" value={props.selectedSender.market} />
            <InspRow label="State" value={props.selectedSender.state} />
            <InspRow label="21610" value={props.selectedSender.violations21610} tone={props.selectedSender.violations21610 > 0 ? 'red' : undefined} />
            <InspRow label="Delivery %" value={`${props.selectedSender.deliveryPct}%`} />
          </div>
        )}
        {props.section === 'market' && props.selectedMarket && (
          <div className="occ-insp-section">
            <InspRow label="Market" value={props.selectedMarket.market} />
            <InspRow label="Rows" value={props.selectedMarket.total} />
            <InspRow label="Delivery %" value={`${props.selectedMarket.deliveryPct}%`} />
            <InspRow label="Sender" value={props.selectedMarket.senderExists ? 'Registered' : 'None'} tone={props.selectedMarket.senderExists ? 'green' : 'red'} />
          </div>
        )}
        {props.section === 'failures' && props.selectedFailure && (
          <div className="occ-insp-section">
            <InspRow label="Cause" value={props.selectedFailure.label} tone="red" />
            <InspRow label="Affected" value={props.selectedFailure.count} />
            <InspRow label="Retryable" value={props.selectedFailure.retryable ? 'Yes' : 'No'} />
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
        <div className="occ-insp-section">
          <div className="occ-insp-section-title">Global</div>
          <div className="occ-intel-actions">
            <button className="occ-action-btn is-primary" onClick={() => props.onRequestConfirm('retry-all-failed')}>Retry All Failed</button>
            <button className="occ-action-btn is-secondary" onClick={() => props.onRequestConfirm('run-queue-now')}>Run Queue</button>
          </div>
        </div>
      </div>
      <button type="button" className="occ-cmd-dock__collapse" onClick={() => setCollapsed(true)}>Collapse</button>
    </aside>
  )
}