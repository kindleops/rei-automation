import { useMemo, useState } from 'react'
import type { ConfiguredMarket, QueueItem, TextgridFleetNumber } from '../../../../domain/queue/queue.types'
import {
  buildMarketStats,
  filterMarketStats,
  summarizeMarketFleet,
  type MarketHealthFilter,
} from '../../market-fleet-stats'
import { MarketFleetCards } from './MarketFleetCards'
import { MarketHealthOverview } from '../MarketHealthOverview'
import { MarketIntelligenceHeader } from './MarketIntelligenceHeader'
import './market-intelligence.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '—' : s.length > max ? s.slice(0, max) + '…' : s

const HEALTH_TONE: Record<string, string> = {
  healthy: 'green', watch: 'cyan', degraded: 'amber', critical: 'red', idle: 'muted',
}

interface MarketIntelligenceModuleProps {
  items: QueueItem[]
  directory: ConfiguredMarket[]
  fleet: TextgridFleetNumber[]
  selectedMarket: string | null
  onSelectMarket: (market: string | null) => void
  onViewRows: (market: string) => void
  isMobileLayout?: boolean
  globalRangeLabel?: string
}

export function MarketIntelligenceModule({
  items,
  directory,
  fleet,
  selectedMarket,
  onSelectMarket,
  onViewRows,
  isMobileLayout = false,
  globalRangeLabel = 'selected range',
}: MarketIntelligenceModuleProps) {
  const [healthFilter, setHealthFilter] = useState<MarketHealthFilter>('configured')

  const stats = useMemo(
    () => buildMarketStats(items, directory, fleet),
    [items, directory, fleet],
  )
  const filtered = useMemo(
    () => filterMarketStats(stats, healthFilter),
    [stats, healthFilter],
  )
  const summary = useMemo(() => summarizeMarketFleet(stats), [stats])
  const configuredCount = summary.configuredCount

  return (
    <div className={cls('occ-market-intel', isMobileLayout && 'occ-market-intel--mobile')}>
      <MarketIntelligenceHeader
        summary={summary}
        rangeLabel={globalRangeLabel}
        isMobileLayout={isMobileLayout}
        healthFilter={healthFilter}
        onHealthFilter={setHealthFilter}
      />

      {!isMobileLayout && (
        <MarketHealthOverview markets={stats.map((s) => ({
          market: s.market,
          total: s.total,
          health: s.health,
          deliveryPct: s.deliveryPct,
          senderExists: s.senderExists,
          active: s.active,
          failed: s.failed,
          optOuts: s.optOuts,
          performanceHealth: s.performanceHealth,
          senderReadiness: s.senderReadiness,
        }))} />
      )}

      {isMobileLayout ? (
        <MarketFleetCards
          markets={filtered}
          selectedMarket={selectedMarket}
          onSelect={onSelectMarket}
          onViewRows={onViewRows}
        />
      ) : (
        <div className="occ-module occ-module--market occ-module--market-v2">
          <div className="occ-module-head occ-module-head--market">
            <div className="occ-module-col occ-col-name">Market</div>
            <div className="occ-module-col occ-col-badge">Sender Pool</div>
            <div className="occ-module-col occ-col-num">Today</div>
            <div className="occ-module-col occ-col-num">Rows</div>
            <div className="occ-module-col occ-col-num">Sent</div>
            <div className="occ-module-col occ-col-num">Del</div>
            <div className="occ-module-col occ-col-num">Fail</div>
            <div className="occ-module-col occ-col-num">Blk</div>
            <div className="occ-module-col occ-col-num">Opt</div>
            <div className="occ-module-col occ-col-num">21610</div>
            <div className="occ-module-col occ-col-pct">Del%</div>
            <div className="occ-module-col occ-col-pct">Fail%</div>
            <div className="occ-module-col occ-col-badge">Health</div>
            <div className="occ-module-col occ-col-action">Rows</div>
          </div>
          <div className="occ-module-body">
            {filtered.length === 0 && (
              <div className="occ-module-empty">No markets match this filter.</div>
            )}
            {filtered.map((s) => (
              <button
                key={s.market}
                type="button"
                className={cls(
                  'occ-module-row occ-module-row--market occ-module-row--clickable',
                  s.total === 0 && 'is-empty',
                  !s.configured && 'is-unregistered',
                  selectedMarket === s.market && 'is-selected',
                  `is-health-${s.health}`,
                )}
                onClick={() => onSelectMarket(selectedMarket === s.market ? null : s.market)}
              >
                <div className="occ-module-col occ-col-name occ-col-name--strong">
                  <span>{truncate(s.market, 22)}</span>
                  {s.stateCode && <small className="occ-market-row__state">{s.stateCode}</small>}
                  {!s.configured && <small className="occ-tag is-muted">unregistered</small>}
                </div>
                <div className="occ-module-col occ-col-badge">
                  {s.senderExists ? (
                    <span className={cls('occ-state-badge', s.active ? 'is-green' : 'is-amber')}>
                      {s.activeSenderCount}/{s.senderCount} active
                    </span>
                  ) : (
                    <span className="occ-state-badge is-red">none</span>
                  )}
                  <small className="occ-seller-meta">{truncate(s.senderReadiness, 24)}</small>
                </div>
                <div className={cls('occ-module-col occ-col-num', s.messagesSentToday > 0 && 'is-cyan')}>{s.messagesSentToday}</div>
                <div className="occ-module-col occ-col-num">{s.total}</div>
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
                  <span className={cls('occ-health-badge', `is-${HEALTH_TONE[s.health] ?? 'muted'}`)}>
                    {s.total === 0 ? 'idle' : s.health}
                  </span>
                  <small>{s.performanceHealth}</small>
                </div>
                <div className="occ-module-col occ-col-action">
                  <span
                    role="button"
                    tabIndex={0}
                    className="occ-mini-btn"
                    onClick={(e) => { e.stopPropagation(); if (s.total > 0) onViewRows(s.market) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (s.total > 0) onViewRows(s.market) }}
                    }
                  >
                    View
                  </span>
                </div>
              </button>
            ))}
          </div>
          <div className="occ-module-foot">
            {configuredCount} configured market{configuredCount === 1 ? '' : 's'}
            {summary.unregisteredActivityCount > 0 && ` · ${summary.unregisteredActivityCount} with unregistered activity`}
            {' · '}counts reflect {globalRangeLabel} queue activity
          </div>
        </div>
      )}
    </div>
  )
}