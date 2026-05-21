import { useState, useMemo } from 'react'
import type { AgentsModel } from './agents.adapter'
import { Icon } from '../../shared/icons'
import './agents.css'

export const AgentsPage = ({ data }: { data: AgentsModel }) => {
  const [filterStrategy, setFilterStrategy] = useState<string>('All')

  const { performance, attribution } = data

  const filtered = useMemo(() => {
    return performance.filter(row => {
      if (filterStrategy !== 'All' && row.strategy !== filterStrategy) return false
      // Market filter would require market to be part of the view, assuming all for now
      return true
    })
  }, [performance, filterStrategy])

  // Fake recommendation engine
  const recommendations = useMemo(() => {
    const recs: string[] = []
    
    // Find best asking price converter
    const bestAsking = [...performance].sort((a, b) => b.asking_price_replies - a.asking_price_replies)[0]
    if (bestAsking && bestAsking.asking_price_replies > 0) {
      recs.push(`Agent ${bestAsking.agent_name || bestAsking.sms_agent_id} has strong asking-price conversion with ${bestAsking.persona} personas.`)
    }

    // Find opt out risks
    const risky = performance.filter(a => a.auto_pause_candidate)
    for (const r of risky) {
      recs.push(`Reduce volume for Agent ${r.agent_name || r.sms_agent_id} due to rising stop rate (${r.opt_out_rate_pct.toFixed(1)}%).`)
    }
    
    // Default rec if none
    if (recs.length === 0) {
      const top = performance[0]
      if (top) {
        recs.push(`Agent ${top.agent_name || top.sms_agent_id} performs exceptionally well overall.`)
      }
    }

    return recs
  }, [performance])

  return (
    <div className="nx-agents-page">
      <header className="nx-stats-header">
        <div className="nx-stats-header__title">
          <p className="cc-eyebrow">Agent Intelligence</p>
          <h1>AI Agent Performance</h1>
        </div>
        <div className="nx-stats-filters">
          <select className="nx-stats-filter-select" value={filterStrategy} onChange={e => setFilterStrategy(e.target.value)}>
            <option value="All">All Strategies</option>
            <option value="general">General</option>
            <option value="aggressive">Aggressive</option>
            <option value="nurture">Nurture</option>
          </select>
          <button className="nx-quick-filter-btn is-active">
            <Icon name="filter" style={{ width: 12, marginRight: 6 }} />
            Advanced Filters
          </button>
        </div>
      </header>

      {attribution && (
        <div className="nx-agent-attribution-bar">
          <div className="nx-agent-attribution-metric">
            <span className="label">Attribution Coverage</span>
            <span className="value">{(attribution.attribution_coverage_pct || 0).toFixed(1)}%</span>
            <span className={`confidence is-${attribution.agent_attribution_confidence}`}>{attribution.agent_attribution_confidence} confidence</span>
          </div>
          <div className="nx-agent-attribution-metric">
            <span className="label">Unknown Agent</span>
            <span className="value">{(attribution.unknown_agent_pct || 0).toFixed(1)}%</span>
          </div>
        </div>
      )}

      <div className="nx-agent-recommendations">
        <h3><Icon name="zap" style={{ width: 16, marginRight: 8 }} /> Recommendation Engine</h3>
        <ul>
          {recommendations.map((rec, i) => (
            <li key={i}>{rec}</li>
          ))}
        </ul>
      </div>

      <section className="nx-agent-leaderboard">
        <div className="nx-agent-leaderboard-header">
          <div className="col-rank">Rank</div>
          <div className="col-agent">Agent</div>
          <div className="col-metrics">Volume</div>
          <div className="col-metrics">Reply %</div>
          <div className="col-metrics">Positive %</div>
          <div className="col-metrics">Opt-Out %</div>
          <div className="col-metrics">Status</div>
        </div>

        <div className="nx-agent-leaderboard-list">
          {filtered.map((agent, i) => {
            const isTop = i < 3
            const isWarning = agent.auto_pause_candidate || agent.recommended_status === 'scale_down'
            return (
              <div key={`${agent.sms_agent_id}-${agent.strategy}`} className={`nx-agent-row ${isTop ? 'is-top' : ''} ${isWarning ? 'is-warning' : ''}`}>
                <div className="col-rank">
                  {isTop ? <span className={`nx-glowing-badge rank-${i+1}`}>#{i+1}</span> : <span className="nx-rank-text">{i+1}</span>}
                </div>
                <div className="col-agent">
                  <div className="nx-agent-avatar">
                    <Icon name="users" style={{width: 16}} />
                  </div>
                  <div className="nx-agent-details">
                    <div className="nx-agent-name">{agent.agent_name || agent.sms_agent_id}</div>
                    <div className="nx-agent-meta">
                      <span>{agent.persona}</span> • <span>{agent.tone}</span> • <span>{agent.language}</span>
                    </div>
                  </div>
                </div>
                <div className="col-metrics">
                  <span className="nx-metric-primary">{agent.sends.toLocaleString()}</span>
                  <span className="nx-metric-secondary">{agent.replies.toLocaleString()} replies</span>
                </div>
                <div className="col-metrics">
                  <span className="nx-metric-primary">{agent.reply_rate_pct.toFixed(1)}%</span>
                  {agent.reply_rate_pct > 20 && <Icon name="trending-up" className="nx-trend-arrow is-up" />}
                </div>
                <div className="col-metrics">
                  <span className="nx-metric-primary">{agent.positive_rate_pct.toFixed(1)}%</span>
                  {agent.positive_rate_pct > 10 ? <Icon name="trending-up" className="nx-trend-arrow is-up" /> : <Icon name="trending-up" className="nx-trend-arrow is-down" style={{transform: 'rotate(180deg)'}} />}
                </div>
                <div className="col-metrics">
                  <span className={`nx-metric-primary ${agent.opt_out_rate_pct > 8 ? 'is-danger' : ''}`}>{agent.opt_out_rate_pct.toFixed(1)}%</span>
                </div>
                <div className="col-metrics nx-agent-status-col">
                  {agent.recommended_status === 'scale_up' && <span className="nx-status-badge is-scale-up"><span className="nx-live-pulse" /> Scale Up</span>}
                  {agent.recommended_status === 'maintain' && <span className="nx-status-badge is-maintain">Maintain</span>}
                  {agent.recommended_status === 'scale_down' && <span className="nx-status-badge is-scale-down">Scale Down</span>}
                </div>
                
                {/* Hover Details */}
                <div className="nx-agent-hover-card">
                  <h4>{agent.agent_name || agent.sms_agent_id}</h4>
                  <div className="nx-hover-grid">
                    <div>
                      <label>Confidence</label>
                      <span>{agent.confidence_bucket.replace('_', ' ')}</span>
                    </div>
                    <div>
                      <label>Avg Response</label>
                      <span>{agent.avg_response_hours ? `${agent.avg_response_hours.toFixed(1)}h` : 'N/A'}</span>
                    </div>
                    <div>
                      <label>Qualified</label>
                      <span>{agent.qualification_rate_pct.toFixed(1)}%</span>
                    </div>
                    <div>
                      <label>Current Vol. Weight</label>
                      <span>{agent.current_volume_weight.toFixed(1)}x</span>
                    </div>
                    <div>
                      <label>Recommended Weight</label>
                      <span>{agent.recommended_volume_weight.toFixed(1)}x</span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          
          {filtered.length === 0 && (
            <div className="nx-agent-empty">No agent data available for this selection.</div>
          )}
        </div>
      </section>
    </div>
  )
}
