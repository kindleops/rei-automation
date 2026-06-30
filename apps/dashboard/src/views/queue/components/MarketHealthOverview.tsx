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
  performanceHealth?: string
  senderReadiness?: string
}

interface MarketHealthOverviewProps {
  markets: MarketOverviewData[]
}

export function MarketHealthOverview({ markets }: MarketHealthOverviewProps) {
  const buckets = {
    healthy: markets.filter(m => m.health === 'healthy' && m.total > 0 && m.senderExists && m.active).length,
    watch: markets.filter(m => m.health === 'watch').length,
    degraded: markets.filter(m => m.health === 'degraded' || m.health === 'critical').length,
    noSender: markets.filter(m => !m.senderExists).length,
    idle: markets.filter(m => m.total === 0).length,
  }

  const withActivity = markets.filter(m => m.total > 0).length
  const tiles = [
    { label: 'Tracked', val: markets.length, tone: 'primary' },
    { label: 'With Activity', val: withActivity, tone: 'cyan' },
    { label: 'Healthy', val: buckets.healthy, tone: 'green' },
    { label: 'Watch', val: buckets.watch, tone: 'amber' },
    { label: 'Degraded', val: buckets.degraded, tone: 'red' },
    { label: 'No Sender', val: buckets.noSender, tone: 'red' },
    { label: 'Idle', val: buckets.idle, tone: 'muted' },
  ]

  return (
    <div className="occ-metric-strip occ-metric-strip--market">
      <span className="occ-metric-strip__title">Market Intelligence</span>
      <div className="occ-metric-strip__tiles">
        {tiles.map(t => (
          <div key={t.label} className={cls('occ-metric-strip__tile', `is-${t.tone}`)}>
            <span className="occ-metric-strip__val">{t.val}</span>
            <span className="occ-metric-strip__lbl">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}