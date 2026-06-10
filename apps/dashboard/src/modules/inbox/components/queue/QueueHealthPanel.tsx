import { useState, type FC } from 'react'
import type { QueueProcessorHealth } from '../../../../lib/data/inboxData'
import type { QueueCommandMode } from '../QueueCommandCenter'

interface QueueHealthPanelProps {
  processorHealth: QueueProcessorHealth | null
  queueCommandMode: QueueCommandMode
  items: import('../../../../views/queue/queue.types').QueueItem[]
  readyCount: number
  scheduledCount: number
  sentTodayCount: number
  deliveredTodayCount: number
}

const modeLabel = (mode: QueueCommandMode) =>
  mode === 'automatic' ? 'Automatic' : mode === 'assisted' ? 'Assisted Autopilot' : 'Paused'

const modeTone = (mode: QueueCommandMode) =>
  mode === 'automatic' ? 'green' : mode === 'assisted' ? 'blue' : 'muted'

export const QueueHealthPanel: FC<QueueHealthPanelProps> = ({
  processorHealth,
  queueCommandMode,
  items,
  readyCount,
  scheduledCount,
  sentTodayCount,
  deliveredTodayCount,
}) => {
  const [whyCriticalOpen, setWhyCriticalOpen] = useState(true)

  const health = processorHealth?.status ?? 'unknown'
  const healthTone = health === 'healthy' ? 'green' : health === 'warning' ? 'amber' : health === 'critical' ? 'red' : 'muted'
  const healthLabel = health === 'healthy' ? 'Healthy' : health === 'warning' ? 'Caution' : health === 'critical' ? 'Critical' : 'Unknown'
  const failedToday = processorHealth?.failedTodayCount ?? 0
  const routingBlocked = processorHealth?.routingBlockedCount ?? 0
  const webhookHealthy = processorHealth?.webhookHealthy ?? true

  // Compute derived stats from hydrated rows
  let missingEvents = 0
  let missingProperties = 0
  let missingOwners = 0
  let unknownFailures = 0
  let missingTemplates = 0
  let blankBodies = 0
  
  for (const item of items) {
    if (item.diagnosticFlags.includes('MISSING_MESSAGE_EVENT')) missingEvents++
    if (item.diagnosticFlags.includes('MISSING_PROPERTY')) missingProperties++
    if (item.diagnosticFlags.includes('MISSING_OWNER')) missingOwners++
    if (item.diagnosticFlags.includes('MISSING_TEMPLATE')) missingTemplates++
    if (item.failureCategory === 'unknown') unknownFailures++
    if (item.failureCategory === 'blank_message_body') blankBodies++
  }

  const criticalReasons = [
    { label: 'Unknown failures',          count: unknownFailures, tone: 'red'   as const, active: unknownFailures > 0 },
    { label: 'Failed today',              count: failedToday,     tone: 'red'   as const, active: failedToday > 0 },
    { label: 'Missing message events',    count: missingEvents,   tone: 'amber' as const, active: missingEvents > 0 },
    { label: 'Missing property hydration',count: missingProperties,tone: 'amber' as const, active: missingProperties > 0 },
    { label: 'Missing seller hydration',  count: missingOwners,   tone: 'amber' as const, active: missingOwners > 0 },
    { label: 'Webhook issues',            count: webhookHealthy ? 0 : 1, tone: 'red'   as const, active: !webhookHealthy },
    { label: 'Routing / template gaps',   count: routingBlocked + missingTemplates + blankBodies, tone: 'amber' as const, active: (routingBlocked + missingTemplates + blankBodies) > 0 },
  ]

  const activeReasons = criticalReasons.filter(r => r.active)

  const hcards = [
    { label: 'Queue Health', val: healthLabel,              tone: healthTone,                                                    isStatus: true },
    { label: 'System Mode',  val: modeLabel(queueCommandMode), tone: modeTone(queueCommandMode),                               isStatus: false },
    { label: 'Ready',        val: readyCount ?? '—',        tone: readyCount > 0 ? 'cyan' : undefined as any,                  isStatus: false },
    { label: 'Scheduled',    val: scheduledCount ?? '—',    tone: 'blue' as const,                                             isStatus: false },
    { label: 'Sent Today',   val: sentTodayCount ?? '—',    tone: sentTodayCount > 0 ? 'green' as const : undefined as any,   isStatus: false },
    { label: 'Delivered',    val: deliveredTodayCount ?? '—', tone: deliveredTodayCount > 0 ? 'green' as const : undefined as any, isStatus: false },
    { label: 'Failed Today', val: failedToday,              tone: failedToday > 0 ? 'red' as const : undefined as any,        isStatus: false },
    { label: 'Routing Blk', val: routingBlocked,            tone: routingBlocked > 0 ? 'amber' as const : undefined as any,  isStatus: false },
    { label: 'Webhook',      val: webhookHealthy ? 'OK' : 'Error', tone: webhookHealthy ? 'green' as const : 'red' as const,  isStatus: false },
  ]

  return (
    <>
      {/* Health Cards Row */}
      <div className="sqd-health-row">
        {hcards.map(({ label, val, tone, isStatus }) => (
          <div key={label} className={`sqd-hcard${isStatus ? ' sqd-hcard--status' : ''}${tone ? ` is-${tone}` : ''}`}>
            {isStatus && <div className={`sqd-hcard__dot is-${tone}`} />}
            <span className="sqd-hcard__label">{label}</span>
            <strong className={`sqd-hcard__value${tone ? ` is-${tone}` : ''}`}>{String(val)}</strong>
          </div>
        ))}
      </div>

      {/* Why Critical? Panel */}
      {health === 'critical' && (
        <div className="sqd-why-critical">
          <button
            type="button"
            className="sqd-why-critical__toggle"
            onClick={() => setWhyCriticalOpen(v => !v)}
          >
            <span className="sqd-why-critical__dot" />
            <span className="sqd-why-critical__title">Why Critical?</span>
            <span className="sqd-why-critical__count">{activeReasons.length} reason{activeReasons.length !== 1 ? 's' : ''}</span>
            <span className="sqd-why-critical__chevron">{whyCriticalOpen ? '▲' : '▼'}</span>
          </button>
          {whyCriticalOpen && (
            <div className="sqd-why-critical__body">
              {criticalReasons.map(reason => (
                <div
                  key={reason.label}
                  className={`sqd-why-critical__row${reason.active ? ` is-${reason.tone}` : ' is-inactive'}`}
                >
                  <span className={`sqd-why-critical__row-dot is-${reason.active ? reason.tone : 'muted'}`} />
                  <span className="sqd-why-critical__row-label">{reason.label}</span>
                  <span className={`sqd-why-critical__row-count${reason.active ? ` is-${reason.tone}` : ''}`}>
                    {reason.count > 0 ? reason.count : reason.active ? '!' : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
