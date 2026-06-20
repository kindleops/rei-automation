const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface MarketOverviewData {
  market: string
  total: number
  health: string
  deliveryPct: number
  senderExists: boolean
  active: boolean
  failed: number
  optOuts: number
}

interface MarketHealthOverviewProps {
  markets: MarketOverviewData[]
}

export function MarketHealthOverview({ markets }: MarketHealthOverviewProps) {
  const buckets = {
    healthy: markets.filter(m => m.health === 'healthy' && m.total > 0).length,
    watch: markets.filter(m => m.health === 'watch').length,
    degraded: markets.filter(m => m.health === 'degraded' || m.health === 'critical').length,
    noSender: markets.filter(m => !m.senderExists).length,
    idle: markets.filter(m => m.total === 0).length,
  }
  const total = markets.length || 1

  return (
    <div className="occ-market-overview">
      <header className="occ-market-overview__head">
        <span>Market Intelligence</span>
        <span>{markets.length} markets</span>
      </header>
      <div className="occ-market-overview__buckets">
        {[
          { key: 'healthy', label: 'Healthy', count: buckets.healthy, tone: 'green' },
          { key: 'watch', label: 'Watch', count: buckets.watch, tone: 'amber' },
          { key: 'degraded', label: 'Degraded', count: buckets.degraded, tone: 'red' },
          { key: 'noSender', label: 'No Sender', count: buckets.noSender, tone: 'red' },
          { key: 'idle', label: 'No Activity', count: buckets.idle, tone: 'muted' },
        ].map(b => (
          <div key={b.key} className={cls('occ-market-bucket', `is-${b.tone}`)}>
            <span className="occ-market-bucket__val">{b.count}</span>
            <span className="occ-market-bucket__lbl">{b.label}</span>
          </div>
        ))}
      </div>
      <div className="occ-market-dist-bar" aria-hidden="true">
        {buckets.healthy > 0 && <span className="is-green" style={{ flex: buckets.healthy }} />}
        {buckets.watch > 0 && <span className="is-amber" style={{ flex: buckets.watch }} />}
        {buckets.degraded > 0 && <span className="is-red" style={{ flex: buckets.degraded }} />}
        {buckets.noSender > 0 && <span className="is-muted" style={{ flex: buckets.noSender }} />}
      </div>
      <p className="occ-market-overview__note">Distribution from loaded page/range · {total} configured</p>
    </div>
  )
}