import type { MarketFleetSummary, MarketHealthFilter } from '../../market-fleet-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const FILTERS: Array<{ key: MarketHealthFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'configured', label: 'Configured' },
  { key: 'ready', label: 'Ready' },
  { key: 'watch', label: 'Watch' },
  { key: 'degraded', label: 'Degraded' },
  { key: 'no-sender', label: 'No Sender' },
  { key: 'idle', label: 'Idle' },
]

interface MarketIntelligenceHeaderProps {
  summary: MarketFleetSummary
  rangeLabel: string
  isMobileLayout?: boolean
  healthFilter: MarketHealthFilter
  onHealthFilter: (filter: MarketHealthFilter) => void
}

interface KpiDef {
  key: string
  label: string
  value: string | number
  sub?: string
  tone?: string
}

export function MarketIntelligenceHeader({
  summary,
  rangeLabel,
  isMobileLayout = false,
  healthFilter,
  onHealthFilter,
}: MarketIntelligenceHeaderProps) {
  const cards: KpiDef[] = isMobileLayout
    ? [
        { key: 'mkts', label: 'Mkts', value: summary.configuredCount, sub: `${summary.senderTotal} senders` },
        { key: 'ready', label: 'Ready', value: summary.readyCount, tone: 'green' },
        { key: 'del', label: 'Del%', value: summary.sent > 0 ? `${summary.deliveryPct}%` : '—', tone: summary.deliveryPct > 70 ? 'green' : summary.sent > 0 ? 'amber' : 'muted' },
        { key: 'rows', label: 'Rows', value: summary.totalRows, sub: `${summary.sent} sent` },
        { key: 'risk', label: 'Risk', value: summary.degradedCount + summary.noSenderCount, tone: summary.degradedCount + summary.noSenderCount > 0 ? 'red' : 'muted' },
      ]
    : [
        { key: 'configured', label: 'Configured Markets', value: summary.configuredCount, sub: `${summary.senderTotal} senders` },
        { key: 'ready', label: 'Routing Ready', value: summary.readyCount, tone: 'green' },
        { key: 'watch', label: 'Watch', value: summary.watchCount, tone: summary.watchCount > 0 ? 'amber' : 'muted' },
        { key: 'degraded', label: 'Degraded', value: summary.degradedCount, tone: summary.degradedCount > 0 ? 'red' : 'muted' },
        { key: 'no-sender', label: 'No Sender', value: summary.noSenderCount, tone: summary.noSenderCount > 0 ? 'red' : 'muted' },
        { key: 'sent', label: 'Range Sent', value: summary.sent, sub: `${summary.delivered} delivered` },
        { key: 'delivery', label: 'Delivery Rate', value: summary.sent > 0 ? `${summary.deliveryPct}%` : '—', tone: summary.deliveryPct > 70 ? 'green' : summary.sent > 0 ? 'amber' : 'muted' },
        { key: 'today', label: 'Sent Today', value: summary.sentTodayTotal, sub: 'TextGrid registry' },
        { key: 'optouts', label: 'Opt-Outs', value: summary.optOuts, tone: summary.optOuts > 0 ? 'red' : undefined },
        { key: 'exceptions', label: 'Exceptions', value: summary.exceptions, tone: summary.exceptions > 0 ? 'amber' : undefined },
      ]

  return (
    <header className={cls('occ-market-intel-header', isMobileLayout && 'occ-market-intel-header--mobile')}>
      <div className={cls('occ-market-kpi-rail', isMobileLayout && 'occ-market-kpi-rail--mobile')}>
        {cards.map((card) => (
          <div key={card.key} className={cls('occ-market-kpi-card', card.tone && `is-${card.tone}`)}>
            <span className="occ-market-kpi-card__label">{card.label}</span>
            <span className="occ-market-kpi-card__value">{card.value}</span>
            {card.sub && <span className="occ-market-kpi-card__sub">{card.sub}</span>}
          </div>
        ))}
      </div>

      {!isMobileLayout && (
        <p className="occ-market-intel-header__sub">
          TextGrid-backed market registry · queue metrics reflect {rangeLabel}
          {summary.dailyCapTotal != null && ` · ${summary.dailyCapTotal.toLocaleString()} combined daily cap`}
          {summary.unregisteredActivityCount > 0 && ` · ${summary.unregisteredActivityCount} unregistered market${summary.unregisteredActivityCount === 1 ? '' : 's'} with activity`}
        </p>
      )}

      <div className="occ-market-filter-chips" role="tablist" aria-label="Filter markets by health">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={healthFilter === f.key}
            className={cls('occ-market-fchip', healthFilter === f.key && 'is-active')}
            onClick={() => onHealthFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </header>
  )
}