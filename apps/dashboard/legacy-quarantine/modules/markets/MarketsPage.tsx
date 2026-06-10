import { useState } from 'react'
import type { MarketsModel, ActiveMarket } from './markets.adapter'
import { Icon } from '../../shared/icons'
import { formatCompactNumber } from '../../shared/formatters'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const heatClass: Record<ActiveMarket['heat'], string> = {
  hot: 'is-hot',
  warm: 'is-warm',
  steady: 'is-steady',
}

const riskIcon: Record<string, string> = {
  low: 'check',
  moderate: 'alert',
  high: 'alert',
  critical: 'alert',
}

export const MarketsPage = ({ data }: { data: MarketsModel }) => {
  const [selectedId, setSelectedId] = useState<string | null>(data.markets[0]?.id ?? null)
  const [filterHeat, setFilterHeat] = useState<string>('all')
  const selected = data.markets.find((m) => m.id === selectedId) ?? null

  const filtered = filterHeat === 'all'
    ? data.markets
    : data.markets.filter(m => m.heat === filterHeat)

  const hotCount = data.markets.filter(m => m.heat === 'hot').length
  const strainedCount = data.markets.filter(m => m.capacityStrain > 80).length

  return (
    <div className="nx-markets">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="map" />
          <h1>Markets</h1>
        </div>
        <div className="nx-surface-header__stats">
          <span className="nx-badge nx-badge--success">{data.totalPipeline} pipeline</span>
          <span className="nx-badge nx-badge--primary">{data.liveCount} live</span>
          {hotCount > 0 && (
            <span className="nx-badge nx-badge--hot">{hotCount} hot</span>
          )}
          {strainedCount > 0 && (
            <span className="nx-badge nx-badge--danger">{strainedCount} strained</span>
          )}
          {data.pausedCount > 0 && (
            <span className="nx-badge nx-badge--muted">{data.pausedCount} paused</span>
          )}
        </div>
      </header>

      <div className="nx-markets__filters">
        {['all', 'hot', 'warm', 'steady'].map((heat) => (
          <button
            key={heat}
            type="button"
            className={classes('nx-filter-pill', filterHeat === heat && 'is-active')}
            onClick={() => setFilterHeat(heat)}
          >
            {heat === 'all' ? `All (${data.markets.length})` : `${heat.charAt(0).toUpperCase() + heat.slice(1)} (${data.markets.filter(m => m.heat === heat).length})`}
          </button>
        ))}
      </div>

      <div className="nx-markets__body">
        <aside className="nx-markets__list">
          {filtered.map((market) => (
            <button
              key={market.id}
              type="button"
              className={classes(
                'nx-market-row',
                selectedId === market.id && 'is-selected',
                market.campaignStatus === 'paused' && 'is-paused',
                market.heat === 'hot' && 'is-hot-market',
                market.capacityStrain > 80 && 'is-strained',
              )}
              onClick={() => setSelectedId(market.id)}
            >
              <div className="nx-market-row__top">
                <span className={classes('nx-heat-badge', heatClass[market.heat])}>
                  {market.heat.toUpperCase()}
                </span>
                <strong>{market.name}</strong>
                <span className={classes('nx-status-chip', `is-${market.campaignStatus}`)}>
                  {market.campaignStatus.toUpperCase()}
                </span>
              </div>
              <div className="nx-market-row__stats">
                <span>{market.pipelineLabel}</span>
                <span>{formatCompactNumber(market.outboundToday)} sent</span>
                <span>{market.hotLeads} hot</span>
                <span>Health {market.healthScore}</span>
              </div>
              <div className="nx-market-row__capacity">
                <div className="nx-capacity-bar nx-capacity-bar--mini">
                  <div
                    className={classes('nx-capacity-bar__fill', market.capacityStrain > 80 && 'is-danger')}
                    style={{ width: `${market.capacityStrain}%` }}
                  />
                </div>
                <span className="nx-market-row__strain">{market.capacityStrain}%</span>
              </div>
            </button>
          ))}
        </aside>

        <main className="nx-markets__detail">
          {selected ? (
            <div className="nx-market-detail">
              <div className="nx-market-detail__hero">
                <div className="nx-market-detail__hero-top">
                  <h2>{selected.label}</h2>
                  <span className={classes('nx-heat-badge nx-heat-badge--lg', heatClass[selected.heat])}>
                    {selected.heat.toUpperCase()}
                  </span>
                </div>
                <div className="nx-market-detail__hero-meta">
                  <span className="nx-market-detail__scan">{selected.scanLabel}</span>
                  <span className="nx-market-detail__sweep">Last sweep {selected.lastSweepLabel}</span>
                </div>
              </div>

              <div className="nx-market-detail__kpi-grid">
                <div className="nx-kpi-mini">
                  <span>Outbound</span>
                  <strong>{formatCompactNumber(selected.outboundToday)}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Replies</span>
                  <strong>{formatCompactNumber(selected.repliesToday)}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Hot Leads</span>
                  <strong className="nx-kpi-hot">{selected.hotLeads}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Pipeline</span>
                  <strong>{selected.pipelineLabel}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Reply Rate</span>
                  <strong>{selected.replyLabel}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Opt-Out</span>
                  <strong>{selected.optOutRate}%</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Health</span>
                  <strong>{selected.healthScore}</strong>
                </div>
                <div className="nx-kpi-mini">
                  <span>Capacity</span>
                  <strong className={selected.capacityStrain > 80 ? 'nx-kpi-danger' : ''}>{selected.capacityStrain}%</strong>
                </div>
              </div>

              <section className="nx-market-detail__section">
                <h3>
                  <Icon name={riskIcon[selected.operationalRisk] as any} className="nx-section-icon" />
                  Operational Risk
                </h3>
                <div className={classes('nx-risk-indicator', `is-${selected.operationalRisk}`)}>
                  {selected.operationalRisk.toUpperCase()}
                </div>
                <div className="nx-capacity-bar">
                  <div
                    className={classes('nx-capacity-bar__fill', selected.capacityStrain > 80 && 'is-danger')}
                    style={{ width: `${selected.capacityStrain}%` }}
                  />
                </div>
                <span className="nx-capacity-label">
                  {selected.capacityStrain}% capacity strain • {selected.alertCount} active alerts
                </span>
              </section>

              <section className="nx-market-detail__section">
                <h3>Top ZIP Codes</h3>
                <div className="nx-table-card">
                  <table className="nx-table">
                    <thead>
                      <tr>
                        <th>ZIP</th>
                        <th>Outbound</th>
                        <th>Trend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.topZips.map((z) => (
                        <tr key={z.zip}>
                          <td><span className="nx-mono">{z.zip}</span></td>
                          <td>{formatCompactNumber(z.outbound)}</td>
                          <td>
                            <span className={classes('nx-trend', z.trend === '↑' && 'is-up', z.trend === '↓' && 'is-down')}>
                              {z.trend}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="nx-market-detail__footer">
                <div className="nx-market-detail__footer-stat">
                  <Icon name="users" className="nx-footer-icon" />
                  <span>{selected.leadCount} leads</span>
                </div>
                <div className="nx-market-detail__footer-stat">
                  <Icon name="spark" className="nx-footer-icon" />
                  <span>{selected.agentCount} agents</span>
                </div>
                <div className="nx-market-detail__footer-stat">
                  <Icon name="pin" className="nx-footer-icon" />
                  <span>{selected.activeProperties.toLocaleString()} properties</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="nx-empty-state nx-empty-state--large">
              <Icon className="nx-empty-icon" name="map" />
              <p>Select a market</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
