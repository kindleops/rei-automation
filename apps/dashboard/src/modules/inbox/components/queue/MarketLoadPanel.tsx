import { type FC } from 'react'

interface MarketLoad {
  market: string
  scheduled: number
  ready: number
  sent: number
  delivered: number
  failed: number
  blocked: number
  replied: number
  optOuts: number
  deliveryRate: number
  failureRate: number
  health: 'green' | 'amber' | 'red' | 'muted'
  total: number
  activeSender?: string
}

interface MarketLoadPanelProps {
  marketLoad: MarketLoad[]
  activeFilter: string
  onFilterChange: (market: string) => void
  isOps?: boolean
}

const marketHealth = (m: MarketLoad) => m.health

export const MarketLoadPanel: FC<MarketLoadPanelProps> = ({
  marketLoad,
  activeFilter,
  onFilterChange,
  isOps = false,
}) => {
  if (marketLoad.length === 0) return null

  return (
    <div className="sqd-section">
      <div className="sqd-section__head">
        <span className="sqd-section-eyebrow">Market Load</span>
        {activeFilter !== 'all' && (
          <button type="button" className="sqd-clear-chip" onClick={() => onFilterChange('all')}>
            {activeFilter} ×
          </button>
        )}
      </div>
      <div className={`sqd-market-grid${isOps ? ' sqd-market-grid--compact' : ''}`}>
        {marketLoad.map(m => {
          const tone = marketHealth(m)
          return (
            <button
              key={m.market}
              type="button"
              className={`sqd-market-card${activeFilter === m.market ? ' is-active' : ''}`}
              onClick={() => onFilterChange(activeFilter === m.market ? 'all' : m.market)}
            >
              <div className="sqd-market-card__header">
                <span className="sqd-market-card__name">{m.market}</span>
                <span className={`sqd-market-card__health-dot is-${tone}`} />
              </div>
              <div className="sqd-market-card__stats">
                {m.ready     > 0 && <span className="is-cyan">{m.ready} ready</span>}
                {m.scheduled > 0 && <span className="is-blue">{m.scheduled} sched</span>}
                {m.sent      > 0 && <span className="is-green">{m.sent} sent</span>}
                {m.delivered > 0 && <span className="is-green">{m.delivered} dlvd</span>}
                {m.failed    > 0 && <span className="is-red">{m.failed} fail</span>}
                {m.blocked   > 0 && <span className="is-amber">{m.blocked} blkd</span>}
                {m.replied   > 0 && <span className="is-green">{m.replied} replied</span>}
                {m.optOuts   > 0 && <span className="is-red">{m.optOuts} opt-out</span>}
              </div>
              <div className="sqd-market-card__footer">
                {m.activeSender && <span className="sqd-market-card__sender">via {m.activeSender}</span>}
                <span className="sqd-market-card__total">{m.total} total</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
