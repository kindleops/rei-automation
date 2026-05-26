import { type FC } from 'react'
import { emitNotification } from '../../../../shared/NotificationToast'

import type { QueueItem } from '../../../queue/queue.types'

export interface SenderNumberHealth {
  number: string
  market: string
  sentToday: number
  delivered: number
  failed: number
  blocked: number
  optOuts: number
  blacklistPairs: number
  deliveryPct: number
  replyPct: number
  health: 'healthy' | 'caution' | 'critical'
}

interface SenderNumberHealthPanelProps {
  items: QueueItem[]
}

const healthTone = (h: SenderNumberHealth['health']) =>
  h === 'healthy' ? 'green' : h === 'caution' ? 'amber' : 'red'

export const SenderNumberHealthPanel: FC<SenderNumberHealthPanelProps> = ({ items }) => {
  const handleAction = (action: string, number: string) => {
    // TODO: wire each action to backend API endpoints
    emitNotification({
      title: `${action}: ${number.slice(-4)}…`,
      detail: 'TODO: wire to sender management API',
      severity: 'warning',
      sound: 'notification',
    })
  }

  return (
    <div className="sqd-section">
      <div className="sqd-section__head">
        <span className="sqd-section-eyebrow">Sender Number Health</span>
      </div>
      <div className="sqd-sender-health-table">
        <div className="sqd-sender-health-table__head">
          <span>Number</span>
          <span>Market</span>
          <span>Sent</span>
          <span>Delivered</span>
          <span>Failed</span>
          <span>Blocked</span>
          <span>Opt-outs</span>
          <span>BL Pairs</span>
          <span>Del%</span>
          <span>Reply%</span>
          <span>Health</span>
          <span>Actions</span>
        </div>
        <div className="sqd-sender-health-table__body">
          {(() => {
            const map = new Map<string, SenderNumberHealth>()
            for (const item of items) {
              const num = item.textgridNumber
              if (!num) continue
              if (!map.has(num)) {
                map.set(num, {
                  number: num,
                  market: item.market || 'Unknown',
                  sentToday: 0, delivered: 0, failed: 0, blocked: 0, optOuts: 0, blacklistPairs: 0,
                  deliveryPct: 0, replyPct: 0, health: 'healthy'
                })
              }
              const e = map.get(num)!
              if (item.status === 'sent' || item.status === 'delivered') e.sentToday++
              if (item.status === 'delivered') e.delivered++
              if (item.status === 'failed' || item.status === 'retry') e.failed++
              if (item.status === 'blocked' || item.status === 'held') e.blocked++
              if (item.failureCategory === 'recipient_opted_out') e.optOuts++
              if (item.failureCategory === 'blacklist_pair_21610') e.blacklistPairs++
            }
            return Array.from(map.values()).map(sn => {
              sn.deliveryPct = sn.sentToday > 0 ? Math.round((sn.delivered / sn.sentToday) * 100) : 0
              sn.replyPct = 0 // Needs reply events
              if (sn.sentToday === 0) sn.health = 'healthy'
              else if (sn.deliveryPct < 70 || sn.blacklistPairs > 0) sn.health = 'critical'
              else if (sn.deliveryPct < 85 || sn.optOuts > 2) sn.health = 'caution'
              
              return (
                <div
                  key={sn.number}
                  className={`sqd-sender-health-row is-health-${sn.health}`}
                >
              <span className="sqd-sender-health-row__number sqd-cell--mono">…{sn.number.slice(-7)}</span>
              <span className="sqd-sender-health-row__market">{sn.market}</span>
              <span className="sqd-sender-health-row__num">{sn.sentToday}</span>
              <span className={`sqd-sender-health-row__num is-${sn.deliveryPct > 85 ? 'green' : sn.deliveryPct > 70 ? 'amber' : 'red'}`}>{sn.delivered}</span>
              <span className={`sqd-sender-health-row__num${sn.failed > 5 ? ' is-red' : sn.failed > 2 ? ' is-amber' : ''}`}>{sn.failed}</span>
              <span className={`sqd-sender-health-row__num${sn.blocked > 0 ? ' is-amber' : ''}`}>{sn.blocked}</span>
              <span className={`sqd-sender-health-row__num${sn.optOuts > 0 ? ' is-red' : ''}`}>{sn.optOuts}</span>
              <span className={`sqd-sender-health-row__num${sn.blacklistPairs > 0 ? ' is-red' : ''}`}>{sn.blacklistPairs}</span>
              <span className={`sqd-sender-health-row__pct is-${sn.deliveryPct > 85 ? 'green' : sn.deliveryPct > 70 ? 'amber' : 'red'}`}>{sn.deliveryPct}%</span>
              <span className="sqd-sender-health-row__pct">{sn.replyPct}%</span>
              <span className={`sqd-sender-health-badge is-${healthTone(sn.health)}`}>{sn.health}</span>
              <div className="sqd-sender-health-row__actions">
                <button className="sqd-icon-action" title="Pause number" onClick={() => handleAction('Pause', sn.number)}>⏸</button>
                <button className="sqd-icon-action" title="Limit number" onClick={() => handleAction('Limit', sn.number)}>⚡</button>
                <button className="sqd-icon-action is-corrective" title="Recycle number" onClick={() => handleAction('Recycle', sn.number)}>↻</button>
                <button className="sqd-icon-action is-danger" title="View failures" onClick={() => handleAction('View Failures', sn.number)}>⚠</button>
              </div>
            </div>
              )
            })
          })()}
        </div>
      </div>
    </div>
  )
}
