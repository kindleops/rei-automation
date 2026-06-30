import { useMemo, useState } from 'react'
import type { QueueItem, TextgridFleetNumber } from '../../../../domain/queue/queue.types'
import { buildSenderStats, summarizeSenderFleet } from '../../sender-fleet-stats'
import { SenderFleetCards } from './SenderFleetCards'
import { SenderFleetOverview } from '../SenderFleetOverview'
import { SenderIntelligenceHeader } from './SenderIntelligenceHeader'
import './sender-intelligence.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '—' : s.length > max ? s.slice(0, max) + '…' : s

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

interface SenderIntelligenceModuleProps {
  items: QueueItem[]
  fleet: TextgridFleetNumber[]
  selectedPhone: string | null
  onSelectPhone: (phone: string | null) => void
  isMobileLayout?: boolean
  globalRangeLabel?: string
}

export function SenderIntelligenceModule({
  items,
  fleet,
  selectedPhone,
  onSelectPhone,
  isMobileLayout = false,
  globalRangeLabel = 'selected range',
}: SenderIntelligenceModuleProps) {
  const [marketFilter, setMarketFilter] = useState<string | null>(null)

  const stats = useMemo(() => buildSenderStats(items, fleet), [items, fleet])
  const filtered = useMemo(
    () => (marketFilter ? stats.filter((s) => s.market === marketFilter) : stats),
    [stats, marketFilter],
  )
  const summary = useMemo(() => summarizeSenderFleet(stats), [stats])

  const STATE_TONE: Record<string, string> = {
    active: 'green', paused: 'muted', degraded: 'amber', blocked: 'red', unregistered: 'muted',
  }

  return (
    <div className={cls('occ-sender-intel', isMobileLayout && 'occ-sender-intel--mobile')}>
      <SenderIntelligenceHeader
        summary={summary}
        rangeLabel={globalRangeLabel}
        isMobileLayout={isMobileLayout}
        marketFilter={marketFilter}
        onMarketFilter={setMarketFilter}
      />

      {!isMobileLayout && (
        <SenderFleetOverview
          senders={filtered.map((s) => ({
            phone: s.phone,
            friendlyName: s.friendlyName,
            market: s.market,
            stateCode: s.stateCode,
            sent: s.sent,
            delivered: s.delivered,
            failed: s.failed,
            blocked: s.blocked,
            deliveryPct: s.deliveryPct,
            failPct: s.failPct,
            violations21610: s.violations21610,
            optOuts: s.optOuts,
            state: s.state,
            health: s.health,
            performanceLabel: s.performanceLabel,
            operationalLabel: s.operationalLabel,
            lastUsed: s.lastUsed ? relTime(s.lastUsed) : null,
            dailyCap: s.dailyCap,
            messagesSentToday: s.messagesSentToday,
            rangeRows: s.rangeRows,
          }))}
          selectedPhone={selectedPhone}
          onSelect={onSelectPhone}
        />
      )}

      {isMobileLayout ? (
        <SenderFleetCards
          senders={filtered}
          selectedPhone={selectedPhone}
          onSelect={onSelectPhone}
          lastUsedLabel={relTime}
        />
      ) : (
        <div className="occ-module occ-module--senders occ-module--senders-v2">
          <div className="occ-module-head occ-module-head--senders">
            <div className="occ-module-col occ-col-phone">Number</div>
            <div className="occ-module-col occ-col-market">Market</div>
            <div className="occ-module-col occ-col-num">Today</div>
            <div className="occ-module-col occ-col-num">Sent</div>
            <div className="occ-module-col occ-col-num">Del</div>
            <div className="occ-module-col occ-col-num">Fail</div>
            <div className="occ-module-col occ-col-num">Blk</div>
            <div className="occ-module-col occ-col-num">Opt</div>
            <div className="occ-module-col occ-col-num">21610</div>
            <div className="occ-module-col occ-col-pct">Del%</div>
            <div className="occ-module-col occ-col-pct">Fail%</div>
            <div className="occ-module-col occ-col-badge">Health</div>
            <div className="occ-module-col occ-col-small">Last Used</div>
            <div className="occ-module-col occ-col-badge">State</div>
          </div>
          <div className="occ-module-body">
            {filtered.length === 0 && (
              <div className="occ-module-empty">No TextGrid numbers match this filter.</div>
            )}
            {filtered.map((s) => (
              <button
                key={s.phone}
                type="button"
                className={cls(
                  'occ-module-row occ-module-row--clickable occ-module-row--sender',
                  `is-${s.state}`,
                  selectedPhone === s.phone && 'is-selected',
                  s.violations21610 > 0 && 'is-critical',
                )}
                onClick={() => onSelectPhone(selectedPhone === s.phone ? null : s.phone)}
              >
                <div className="occ-module-col occ-col-phone">
                  <span className="occ-mono occ-sender-row__phone">{s.phone}</span>
                  {s.friendlyName && <small className="occ-sender-row__alias">{truncate(s.friendlyName, 18)}</small>}
                </div>
                <div className="occ-module-col occ-col-market">
                  <span>{truncate(s.market, 14)}</span>
                  {s.stateCode && <small className="occ-sender-row__state">{s.stateCode}</small>}
                </div>
                <div className={cls('occ-module-col occ-col-num', s.messagesSentToday > 0 && 'is-cyan')}>{s.messagesSentToday}</div>
                <div className="occ-module-col occ-col-num">{s.sent}</div>
                <div className="occ-module-col occ-col-num is-green">{s.delivered}</div>
                <div className={cls('occ-module-col occ-col-num', s.failed > 0 && 'is-red')}>{s.failed}</div>
                <div className={cls('occ-module-col occ-col-num', s.blocked > 0 && 'is-amber')}>{s.blocked}</div>
                <div className={cls('occ-module-col occ-col-num', s.optOuts > 0 && 'is-red')}>{s.optOuts}</div>
                <div className={cls('occ-module-col occ-col-num', s.violations21610 > 0 && 'is-red occ-bold')}>{s.violations21610}</div>
                <div className={cls('occ-module-col occ-col-pct', s.sent === 0 ? 'is-muted' : s.deliveryPct > 70 ? 'is-green' : s.deliveryPct > 40 ? 'is-amber' : 'is-red')}>
                  {s.sent === 0 ? '—' : `${s.deliveryPct}%`}
                </div>
                <div className={cls('occ-module-col occ-col-pct', s.sent === 0 ? 'is-muted' : s.failPct > 15 ? 'is-red' : s.failPct > 5 ? 'is-amber' : 'is-green')}>
                  {s.sent === 0 ? '—' : `${s.failPct}%`}
                </div>
                <div className="occ-module-col occ-col-badge">
                  <span className={cls('occ-health-badge', `is-${STATE_TONE[s.state] ?? 'muted'}`)}>{s.health}</span>
                  <small>{s.performanceLabel}</small>
                </div>
                <div className="occ-module-col occ-col-small">{relTime(s.lastUsed || s.registryLastUsedAt)}</div>
                <div className="occ-module-col occ-col-badge">
                  <span className={cls('occ-state-badge', `is-${STATE_TONE[s.state] ?? 'muted'}`)}>{s.state}</span>
                  <small className="occ-seller-meta">{s.operationalLabel}</small>
                </div>
              </button>
            ))}
          </div>
          <div className="occ-module-foot">
            {summary.fleetTotal} registered number{summary.fleetTotal === 1 ? '' : 's'}
            {summary.unregistered > 0 && ` · ${summary.unregistered} unregistered in range`}
            {' · '}counts reflect {globalRangeLabel} queue activity
          </div>
        </div>
      )}
    </div>
  )
}