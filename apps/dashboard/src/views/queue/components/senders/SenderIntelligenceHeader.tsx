import type { SenderFleetSummary } from '../../sender-fleet-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface SenderIntelligenceHeaderProps {
  summary: SenderFleetSummary
  rangeLabel: string
  isMobileLayout?: boolean
  marketFilter: string | null
  onMarketFilter: (market: string | null) => void
}

interface KpiDef {
  key: string
  label: string
  value: string | number
  sub?: string
  tone?: string
}

export function SenderIntelligenceHeader({
  summary,
  rangeLabel,
  isMobileLayout = false,
  marketFilter,
  onMarketFilter,
}: SenderIntelligenceHeaderProps) {
  const cards: KpiDef[] = isMobileLayout
    ? [
        { key: 'fleet', label: 'Fleet', value: summary.fleetTotal, sub: `${summary.markets.length} mkts` },
        { key: 'active', label: 'Active', value: summary.active, tone: 'green' },
        { key: 'delivery', label: 'Del%', value: summary.sent > 0 ? `${summary.deliveryPct}%` : '—', tone: summary.deliveryPct > 70 ? 'green' : summary.deliveryPct > 40 ? 'amber' : summary.sent > 0 ? 'red' : 'muted' },
        { key: 'today', label: 'Today', value: summary.sentTodayTotal, sub: 'registry' },
        { key: 'sent', label: 'Sent', value: summary.sent, sub: `${summary.delivered} del` },
      ]
    : [
        { key: 'fleet', label: 'Registered Numbers', value: summary.fleetTotal, sub: `${summary.markets.length} markets` },
        { key: 'active', label: 'Routing Active', value: summary.active, tone: 'green' },
        { key: 'paused', label: 'Paused / Idle', value: summary.paused, tone: 'muted' },
        { key: 'blocked', label: 'Blocked / 21610', value: summary.blocked, sub: summary.violations21610 > 0 ? `${summary.violations21610} violations` : undefined, tone: summary.blocked > 0 ? 'red' : undefined },
        { key: 'today', label: 'Sent Today', value: summary.sentTodayTotal, sub: 'TextGrid registry' },
        { key: 'sent', label: 'Range Sent', value: summary.sent, sub: `${summary.delivered} delivered` },
        { key: 'delivery', label: 'Delivery Rate', value: summary.sent > 0 ? `${summary.deliveryPct}%` : '—', tone: summary.deliveryPct > 70 ? 'green' : summary.deliveryPct > 40 ? 'amber' : summary.sent > 0 ? 'red' : 'muted' },
        { key: 'fail', label: 'Fail Rate', value: summary.sent > 0 ? `${summary.failPct}%` : '—', tone: summary.failPct > 15 ? 'red' : summary.failPct > 5 ? 'amber' : 'muted' },
        { key: 'optouts', label: 'Opt-Outs', value: summary.optOuts, tone: summary.optOuts > 0 ? 'red' : undefined },
      ]

  return (
    <header className={cls('occ-sender-intel-header', isMobileLayout && 'occ-sender-intel-header--mobile')}>
      <div className={cls('occ-sender-kpi-rail', isMobileLayout && 'occ-sender-kpi-rail--mobile')}>
        {cards.map((card) => (
          <div
            key={card.key}
            className={cls('occ-sender-kpi-card', card.tone && `is-${card.tone}`)}
          >
            <span className="occ-sender-kpi-card__label">{card.label}</span>
            <span className="occ-sender-kpi-card__value">{card.value}</span>
            {card.sub && <span className="occ-sender-kpi-card__sub">{card.sub}</span>}
          </div>
        ))}
      </div>

      {!isMobileLayout && (
        <p className="occ-sender-intel-header__sub">
          Full TextGrid registry · performance metrics reflect {rangeLabel} queue activity
          {summary.dailyCapTotal != null && ` · ${summary.dailyCapTotal.toLocaleString()} combined daily cap`}
        </p>
      )}

      {summary.markets.length > 1 && (
        <div className="occ-sender-market-chips" role="tablist" aria-label="Filter by market">
          <button
            type="button"
            role="tab"
            aria-selected={!marketFilter}
            className={cls('occ-sender-mchip', !marketFilter && 'is-active')}
            onClick={() => onMarketFilter(null)}
          >
            All markets
          </button>
          {summary.markets.map((market) => (
            <button
              key={market}
              type="button"
              role="tab"
              aria-selected={marketFilter === market}
              className={cls('occ-sender-mchip', marketFilter === market && 'is-active')}
              onClick={() => onMarketFilter(marketFilter === market ? null : market)}
            >
              {market}
            </button>
          ))}
        </div>
      )}
    </header>
  )
}