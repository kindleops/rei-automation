import { type FC } from 'react'

interface RoutingCoverage {
  marketsWithSenders: number
  marketsBlocked: number
  routingBlockedTotal: number
  tier1Count: number; tier1Pct: number
  tier2Count: number; tier2Pct: number
  tier3Count: number; tier3Pct: number
  tier4Count: number; tier4Pct: number
  sendersByMarket: Array<{ market: string; senderCount: number; blocked: number }>
}

interface RoutingCoveragePanelProps {
  coverage: RoutingCoverage
  blockedRows: Array<{ id: string; sellerName: string; market: string; reason: string }>
}

const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s

export const RoutingCoveragePanel: FC<RoutingCoveragePanelProps> = ({ coverage, blockedRows }) => {
  const tiers = [
    { label: 'Exact market match',       count: coverage.tier1Count, pct: coverage.tier1Pct, tone: 'green' },
    { label: 'Same state fallback',       count: coverage.tier2Count, pct: coverage.tier2Pct, tone: 'blue'  },
    { label: 'Approved cluster fallback', count: coverage.tier3Count, pct: coverage.tier3Pct, tone: 'amber' },
    { label: 'Blocked / no route',        count: coverage.tier4Count, pct: coverage.tier4Pct, tone: 'red'   },
  ]

  return (
    <div className="sqd-panel">
      <div className="sqd-panel__head">
        <span className="sqd-panel__eyebrow">Routing Coverage</span>
      </div>

      {/* Summary metrics */}
      <div className="sqd-rmetrics">
        <div className="sqd-rmetric">
          <span className="sqd-rmetric__label">Markets w/ Senders</span>
          <strong className="sqd-rmetric__val is-green">{coverage.marketsWithSenders}</strong>
        </div>
        <div className="sqd-rmetric">
          <span className="sqd-rmetric__label">Markets Blocked</span>
          <strong className={`sqd-rmetric__val${coverage.marketsBlocked > 0 ? ' is-red' : ''}`}>{coverage.marketsBlocked}</strong>
        </div>
        <div className="sqd-rmetric">
          <span className="sqd-rmetric__label">Routing Blocked</span>
          <strong className={`sqd-rmetric__val${coverage.routingBlockedTotal > 0 ? ' is-amber' : ''}`}>{coverage.routingBlockedTotal}</strong>
        </div>
      </div>

      {/* Tier bars */}
      <div className="sqd-tier-bars">
        {tiers.map(({ label, count, pct, tone }) => (
          <div key={label} className="sqd-tier-bar">
            <span className="sqd-tier-bar__label">{label}</span>
            <div className="sqd-tier-bar__track">
              <div className={`sqd-tier-bar__fill is-${tone}`} style={{ width: `${Math.max(pct, 1)}%` }} />
            </div>
            <span className="sqd-tier-bar__n">{count}</span>
            <span className="sqd-tier-bar__pct">{pct}%</span>
          </div>
        ))}
      </div>

      {/* Per-market sender table */}
      {coverage.sendersByMarket.length > 0 && (
        <div className="sqd-sender-table">
          {coverage.sendersByMarket.map(({ market, senderCount, blocked }) => (
            <div key={market} className="sqd-sender-row">
              <span className="sqd-sender-row__market">{market}</span>
              <span className="sqd-sender-row__senders">{senderCount} sender{senderCount !== 1 ? 's' : ''}</span>
              {blocked > 0 && <span className="sqd-sender-row__blocked">{blocked} blocked</span>}
            </div>
          ))}
        </div>
      )}

      {/* Blocked rows detail */}
      {blockedRows.length > 0 && (
        <div className="sqd-routing-blocked">
          <div className="sqd-routing-blocked__head">Blocked Rows</div>
          {blockedRows.slice(0, 5).map(row => (
            <div key={row.id} className="sqd-routing-blocked__row">
              <span>{truncate(row.sellerName, 18)}</span>
              <span className="sqd-routing-blocked__market">{row.market}</span>
              <span className="sqd-routing-blocked__reason">{truncate(row.reason, 24)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
