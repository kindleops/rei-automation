import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import { OccPropertyInspector } from './OccPropertyInspector'
import {
  buildOperationsPulse,
  isNonRetryableRow,
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

interface TemplateDockData {
  id: string
  name: string
  sent: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  usage: number
  deliveryPct: number
  failPct: number
  healthLabel: string
  healthReason: string
  sampleBody?: string
  stageLabel: string | null
  useCase: string
  language: string
  markets: string[]
  senders: string[]
  firstSeen: string | null
  lastSeen: string | null
  isManual: boolean
}

interface SenderDockData {
  phone: string
  market: string
  state: string
  operationalLabel: string
  performanceLabel: string
  sent: number
  delivered: number
  failed: number
  deliveryPct: number
  failPct: number
  violations21610: number
  optOuts: number
  lastUsed: string | null
}

interface MarketDockData {
  market: string
  total: number
  sent: number
  delivered: number
  failed: number
  failPct?: number
  deliveryPct: number
  health: string
  performanceHealth: string
  senderReadiness: string
  senderExists: boolean
  active: boolean
  senderCount?: number
  messagesSentToday?: number
  optOuts: number
  violations21610?: number
  exceptionCount: number
  suggestedAction: string
}

interface FailureDockData {
  cause: string
  label: string
  count: number
  retryable: boolean
  suppression?: boolean
  severity?: string
  action: string
  category: string
  markets: string[]
  senders: string[]
  templates?: string[]
  pctOfTotal?: number
  blockedCount?: number
  failedCount?: number
}

interface TabOverviewData {
  templates: { total: number; healthy: number; degraded: number; lowest?: string }
  senders: { active: number; paused: number; blocked: number; capacity?: number }
  markets: { ready: number; degraded: number; noSender: number }
  failures: { retryable: number; nonRetryable: number; top?: string }
  events: { perHour: number; delivered: number; failed: number; latest?: string }
}

interface CommandIntelligenceDockProps {
  section: QueueSection
  items: QueueItem[]
  kpi: QueueKpiCounts
  model: { sentTodayCount?: number; safeCapacityRemaining?: number } | null
  runnableCount: number
  selectedItem: QueueItem | null
  selectedTemplate: TemplateDockData | null
  selectedSender: SenderDockData | null
  selectedMarket: MarketDockData | null
  selectedFailure: FailureDockData | null
  selectedEvent: QueueItem | null
  tabOverview: TabOverviewData
  onAction: (action: string, id: string) => void
  onViewFailureRows: (cause: string) => void
}

export function CommandIntelligenceDock(props: CommandIntelligenceDockProps) {
  const [collapsed, setCollapsed] = useState(false)
  const ops = buildOperationsPulse(props.items, props.kpi, props.model)

  const CollapseBtn = () => (
    <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse"><Icon name="chevron-right" size={12} /></button>
  )

  if (collapsed) {
    return (
      <aside className="occ-cmd-dock is-collapsed">
        <button type="button" className="occ-cmd-dock__expand" onClick={() => setCollapsed(false)} aria-label="Expand intelligence">
          <Icon name="chevron-left" size={14} />
        </button>
        <div className="occ-cmd-dock__mini">
          <span className={cls('occ-cmd-dock__pulse', `is-${ops.processorState}`)}>{ops.processorLabel}</span>
          {props.section === 'queue' && props.kpi.failed > 0 && <span className="is-red">{props.kpi.failed}</span>}
        </div>
      </aside>
    )
  }

  const { onAction } = props

  if (props.section === 'queue' && props.selectedItem) {
    const item = props.selectedItem
    const retryBlocked = isNonRetryableRow(item)
    return (
      <OccPropertyInspector
        item={item}
        mode="queue"
        onClose={() => onAction('deselect', item.id)}
        actions={(
          <>
            {item.status === 'approval' && <button type="button" className="occ-action-btn is-primary" onClick={() => onAction('approve', item.id)}>Approve</button>}
            {(item.status === 'failed' || item.status === 'retry') && item.retryEligible && !retryBlocked && (
              <button type="button" className="occ-action-btn is-primary" onClick={() => onAction('retry', item.id)}>Retry</button>
            )}
            <button type="button" className="occ-action-btn is-danger" onClick={() => onAction('cancel', item.id)}>Suppress</button>
          </>
        )}
      />
    )
  }

  if (props.section === 'templates' && props.selectedTemplate) {
    const t = props.selectedTemplate
    return (
      <aside className="occ-cmd-dock occ-dossier">
        <header className="occ-cmd-dock__head">
          <div><strong>{t.name}</strong><span className={cls('occ-health-badge', `is-${t.healthLabel === 'Critical' ? 'red' : 'green'}`)}>{t.healthLabel}</span></div>
          <CollapseBtn />
        </header>
        <div className="occ-cmd-dock__body">
          {t.id !== 'no-template' && <InspRow label="Template ID" value={t.id} />}
          <InspRow label="Stage" value={t.stageLabel} />
          <InspRow label="Source" value={t.useCase || (t.isManual ? 'Manual Reply' : '—')} />
          <InspRow label="Language" value={t.language} />
          <InspRow label="Channel" value="SMS" />
          <InspRow label="Usage" value={t.usage} />
          <InspRow label="Sent / Del" value={`${t.sent} / ${t.delivered}`} />
          <InspRow label="Failed" value={t.failed} tone={t.failed > 0 ? 'red' : undefined} />
          <InspRow label="Blocked" value={t.blocked} />
          <InspRow label="Opt-outs" value={t.optOuts} />
          <InspRow label="Delivery rate" value={`${t.deliveryPct}%`} />
          <InspRow label="Failure rate" value={`${t.failPct}%`} />
          <InspRow label="Sample size" value={t.sent} />
          <InspRow label="Health reason" value={t.healthReason} />
          {t.sampleBody ? (
            <div className="occ-insp-section">
              <div className="occ-insp-section-title">{t.isManual ? 'Operator-authored body' : 'Message body'}</div>
              <p className="occ-insp-message">{t.sampleBody}</p>
            </div>
          ) : t.isManual && <p className="occ-insp-hist">Manual Reply — dynamic operator-authored content.</p>}
          {t.markets.length > 0 && <InspRow label="Markets" value={t.markets.slice(0, 4).join(', ')} />}
          {t.senders.length > 0 && <InspRow label="Senders" value={t.senders.map(p => `…${p.slice(-4)}`).join(', ')} />}
        </div>
      </aside>
    )
  }

  if (props.section === 'senders' && props.selectedSender) {
    const s = props.selectedSender
    return (
      <aside className="occ-cmd-dock occ-dossier">
        <header className="occ-cmd-dock__head">
          <div><strong>{s.phone}</strong><span className={cls('occ-state-badge', `is-${s.state === 'active' ? 'green' : 'amber'}`)}>{s.state}</span></div>
          <CollapseBtn />
        </header>
        <div className="occ-cmd-dock__body">
          <InspRow label="Market" value={s.market} />
          <InspRow label="Operational" value={s.operationalLabel} tone={s.state === 'blocked' ? 'red' : undefined} />
          <InspRow label="Performance" value={s.performanceLabel} />
          <InspRow label="Sent" value={s.sent} />
          <InspRow label="Delivered" value={s.delivered} tone="green" />
          <InspRow label="Failed" value={s.failed} tone={s.failed > 0 ? 'red' : undefined} />
          <InspRow label="Delivery rate" value={`${s.deliveryPct}%`} />
          <InspRow label="Failure rate" value={`${s.failPct}%`} />
          <InspRow label="21610" value={s.violations21610} tone={s.violations21610 > 0 ? 'red' : undefined} />
          <InspRow label="Opt-outs" value={s.optOuts} />
          {s.lastUsed && <InspRow label="Last used" value={s.lastUsed} />}
        </div>
      </aside>
    )
  }

  if (props.section === 'market' && props.selectedMarket) {
    const m = props.selectedMarket
    return (
      <aside className="occ-cmd-dock occ-dossier">
        <header className="occ-cmd-dock__head">
          <div><strong>{m.market}</strong><span className="occ-health-badge">{m.health}</span></div>
          <CollapseBtn />
        </header>
        <div className="occ-cmd-dock__body">
          <InspRow label="Sender readiness" value={m.senderReadiness} tone={!m.senderExists ? 'red' : m.active ? 'green' : 'amber'} />
          <InspRow label="Performance" value={m.performanceHealth} />
          <InspRow label="Queue volume" value={m.total} />
          <InspRow label="Sent / Del / Fail" value={`${m.sent} / ${m.delivered} / ${m.failed}`} />
          <InspRow label="Delivery rate" value={`${m.deliveryPct}%`} />
          {m.failPct != null && <InspRow label="Fail rate" value={`${m.failPct}%`} />}
          {m.senderCount != null && <InspRow label="Sender pool" value={`${m.senderCount} number${m.senderCount === 1 ? '' : 's'}`} />}
          {m.messagesSentToday != null && <InspRow label="Sent today" value={m.messagesSentToday} />}
          <InspRow label="Opt-outs" value={m.optOuts} />
          {m.violations21610 != null && m.violations21610 > 0 && (
            <InspRow label="21610 violations" value={m.violations21610} tone="red" />
          )}
          <InspRow label="Exceptions" value={m.exceptionCount} tone={m.exceptionCount > 0 ? 'amber' : undefined} />
          <InspRow label="Action" value={m.suggestedAction} />
        </div>
      </aside>
    )
  }

  if (props.section === 'failures' && props.selectedFailure) {
    const f = props.selectedFailure
    return (
      <aside className="occ-cmd-dock occ-dossier">
        <header className="occ-cmd-dock__head">
          <div><strong>{f.label}</strong><span className="is-red">{f.count}</span></div>
          <CollapseBtn />
        </header>
        <div className="occ-cmd-dock__body">
          <InspRow label="Category" value={f.category} tone="red" />
          <InspRow label="Retryable" value={f.retryable ? 'Yes' : 'No'} tone={f.retryable ? 'green' : 'red'} />
          {f.suppression && <InspRow label="Disposition" value="Suppress required" tone="red" />}
          {f.pctOfTotal != null && <InspRow label="Share of failures" value={`${f.pctOfTotal}%`} />}
          {f.failedCount != null && <InspRow label="Failed / Blocked" value={`${f.failedCount} / ${f.blockedCount ?? 0}`} />}
          <InspRow label="Markets" value={f.markets.slice(0, 5).join(', ') || '—'} />
          <InspRow label="Senders" value={f.senders.slice(0, 5).map(p => `…${p.slice(-4)}`).join(', ') || '—'} />
          {f.templates && f.templates.length > 0 && (
            <InspRow label="Templates" value={f.templates.slice(0, 3).join(', ')} />
          )}
          <p className="occ-failure-card__action">{f.action}</p>
          <button type="button" className="occ-action-btn is-primary" onClick={() => props.onViewFailureRows(f.cause)}>View rows</button>
        </div>
      </aside>
    )
  }

  if (props.section === 'events' && props.selectedEvent) {
    const item = props.selectedEvent
    return (
      <OccPropertyInspector
        item={item}
        mode="event"
        onClose={() => onAction('deselect-event', item.id)}
        onOpenQueueRow={() => onAction('open-queue-row', item.id)}
      />
    )
  }

  const ov = props.tabOverview

  return (
    <aside className={cls('occ-cmd-dock', `is-tab-${props.section}`)}>
      <header className="occ-cmd-dock__head">
        <span className="occ-cmd-dock__title">Command Intelligence</span>
        <CollapseBtn />
      </header>
      <div className="occ-cmd-dock__body">
        {props.section === 'queue' && (
          <>
            <div className="occ-cmd-dock__ops">
              <span className={cls('occ-cmd-dock__proc', `is-${ops.processorState}`)}>
                <span className="occ-cmd-dock__dot" />{ops.processorLabel}
              </span>
              <div className="occ-cmd-dock__ops-grid">
                <span>{props.runnableCount} runnable</span>
                <span>{props.kpi.blocked} blocked</span>
                <span>{props.items.filter(i => i.status === 'failed' && i.retryEligible).length} retryable</span>
                <span>{ops.activeSenders} senders</span>
              </div>
              {ops.nextScheduled && <small>Next: {new Date(ops.nextScheduled).toLocaleString()}</small>}
            </div>
          </>
        )}
        {props.section === 'templates' && (
          <div className="occ-insp-section">
            <InspRow label="Tracked" value={ov.templates.total} />
            <InspRow label="Healthy" value={ov.templates.healthy} tone="green" />
            <InspRow label="Degraded" value={ov.templates.degraded} tone="amber" />
            {ov.templates.lowest && <InspRow label="Lowest performer" value={ov.templates.lowest} tone="red" />}
          </div>
        )}
        {props.section === 'senders' && (
          <div className="occ-insp-section">
            <InspRow label="Active" value={ov.senders.active} tone="green" />
            <InspRow label="Paused" value={ov.senders.paused} tone="amber" />
            <InspRow label="Blocked" value={ov.senders.blocked} tone="red" />
            {ov.senders.capacity != null && <InspRow label="Capacity" value={ov.senders.capacity} />}
          </div>
        )}
        {props.section === 'market' && (
          <div className="occ-insp-section">
            <InspRow label="Ready markets" value={ov.markets.ready} tone="green" />
            <InspRow label="Degraded" value={ov.markets.degraded} tone="amber" />
            <InspRow label="No sender" value={ov.markets.noSender} tone="red" />
          </div>
        )}
        {props.section === 'failures' && (
          <div className="occ-insp-section">
            <InspRow label="Retryable" value={ov.failures.retryable} tone="green" />
            <InspRow label="Non-retryable" value={ov.failures.nonRetryable} tone="red" />
            {ov.failures.top && <InspRow label="Highest impact" value={ov.failures.top} tone="red" />}
          </div>
        )}
        {props.section === 'events' && (
          <div className="occ-insp-section">
            <InspRow label="Events/hr" value={ov.events.perHour} />
            <InspRow label="Delivered" value={ov.events.delivered} tone="green" />
            <InspRow label="Failed" value={ov.events.failed} tone="red" />
            {ov.events.latest && <InspRow label="Latest" value={ov.events.latest} />}
          </div>
        )}
      </div>
    </aside>
  )
}