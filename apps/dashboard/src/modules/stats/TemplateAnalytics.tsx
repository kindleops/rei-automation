import { useState, useEffect } from 'react'
import { Icon } from '../../shared/icons'

export interface TemplateStat {
  template_id: string
  template_name: string
  use_case_slug: string
  stage_code: string
  language: string
  tone: string
  deal_strategy: string
  is_first_touch: boolean
  is_follow_up: boolean
  template_text: string
  active: boolean
  total_queued: number
  total_sent: number
  total_delivered: number
  total_failed: number
  total_reply_count: number
  unique_seller_replies: number
  positive_interest_count: number
  ownership_confirmed_count: number
  opt_out_count: number
  wrong_number_count: number
  hostile_or_legal_count: number
  stage_advanced_count: number
  offers_created_count: number
  contracts_created_count: number
  closed_won_count: number
  estimated_revenue: number
  overall_score: number
  recommendation: string
  risk_level: string
  delivery_rate: number
  reply_rate: number
  positive_interest_rate: number
  opt_out_rate: number
  hostile_rate: number
  top_markets: Record<string, number>
  agent_performance: any
  sample_inbound: { body: string, intent: string }[]
}

export const TemplateAnalytics = () => {
  const [stats, setStats] = useState<TemplateStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateStat | null>(null)
  
  // Filters
  const [dateRange] = useState('30d')
  const [market, setMarket] = useState('all')
  const [agentId] = useState('all')
  const [recommendationFilter, setRecommendationFilter] = useState('all')
  const [riskFilter] = useState('all')

  const fetchStats = async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        start_date: getStartDate(dateRange),
        market: market === 'all' ? '' : market,
        agent_id: agentId === 'all' ? '' : agentId,
        recommendation: recommendationFilter === 'all' ? '' : recommendationFilter,
        risk_level: riskFilter === 'all' ? '' : riskFilter
      })
      const response = await fetch(`/api/internal/analytics/templates/ownership-check?${params.toString()}`)
      const result = await response.json()
      if (result.success) {
        setStats(result.data)
      } else {
        setError(result.error || 'Failed to fetch template stats')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats()
  }, [dateRange, market, agentId, recommendationFilter, riskFilter])

  const getStartDate = (range: string) => {
    const now = new Date()
    if (range === '7d') now.setDate(now.getDate() - 7)
    else if (range === '30d') now.setDate(now.getDate() - 30)
    else if (range === '90d') now.setDate(now.getDate() - 90)
    else return ''
    return now.toISOString()
  }

  const exportCsv = () => {
    const headers = ['ID', 'Name', 'Score', 'Rec', 'Sent', 'Reply%', 'Pos%', 'Prog%', 'OptOut%', 'Revenue']
    const rows = stats.map(s => [
      s.template_id,
      s.template_name,
      Math.round(s.overall_score),
      s.recommendation,
      s.total_sent,
      s.reply_rate.toFixed(1),
      s.positive_interest_rate.toFixed(1),
      (s.unique_seller_replies > 0 ? (s.stage_advanced_count / s.unique_seller_replies) * 100 : 0).toFixed(1),
      s.opt_out_rate.toFixed(1),
      s.estimated_revenue
    ])
    const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].map(e => e.join(",")).join("\n")
    const encodedUri = encodeURI(csvContent)
    const link = document.createElement("a")
    link.setAttribute("href", encodedUri)
    link.setAttribute("download", `template_kpis_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
  }

  if (loading && stats.length === 0) return <div className="nx-stats-loading">Loading Analytics...</div>
  if (error) return <div className="nx-stats-error">Error: {error}</div>

  return (
    <div className="nx-template-analytics">
      <header className="nx-stats-header">
        <div className="nx-stats-header__title">
          <p className="cc-eyebrow">SMS Strategy</p>
          <h1>Template Performance</h1>
        </div>
        <div className="nx-stats-filters">
          <select className="nx-stats-filter-select" value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="all">All Markets</option>
            <option value="Dallas">Dallas</option>
            <option value="Houston">Houston</option>
          </select>
          <select className="nx-stats-filter-select" value={recommendationFilter} onChange={(e) => setRecommendationFilter(e.target.value)}>
            <option value="all">All Recs</option>
            <option value="SCALE">Scale</option>
            <option value="TESTING">Testing</option>
            <option value="LOW_DATA">Low Data</option>
            <option value="RISKY">Risky</option>
            <option value="PAUSE">Pause</option>
          </select>
          <button className="nx-inline-button" onClick={exportCsv}>
            <Icon name="external-link" style={{ width: 14, marginRight: 6 }} /> Export
          </button>
        </div>
      </header>

      <section className="nx-kpi-grid">
        <div className="nx-kpi-card">
          <span className="nx-kpi-card__label">Best Reply Rate</span>
          <span className="nx-kpi-card__value">
            {stats.length > 0 ? `${Math.max(...stats.map(s => s.reply_rate)).toFixed(1)}%` : '0%'}
          </span>
        </div>
        <div className="nx-kpi-card">
          <span className="nx-kpi-card__label">Top Progression</span>
          <span className="nx-kpi-card__value">
            {stats.length > 0 ? `${Math.max(...stats.map(s => s.unique_seller_replies > 0 ? (s.stage_advanced_count / s.unique_seller_replies) * 100 : 0)).toFixed(1)}%` : '0%'}
          </span>
        </div>
        <div className="nx-kpi-card">
          <span className="nx-kpi-card__label">Avg. Score</span>
          <span className="nx-kpi-card__value">
            {stats.length > 0 ? (stats.reduce((acc, s) => acc + Number(s.overall_score), 0) / stats.length).toFixed(1) : '0'}
          </span>
        </div>
        <div className="nx-kpi-card">
          <span className="nx-kpi-card__label">Revenue Generated</span>
          <span className="nx-kpi-card__value">
            ${(stats.reduce((acc, s) => acc + Number(s.estimated_revenue), 0) / 1000).toFixed(1)}k
          </span>
        </div>
      </section>

      <div className="nx-stats-table-container">
        <table className="nx-stats-table">
          <thead>
            <tr>
              <th>Template Variant</th>
              <th>Sent</th>
              <th>Reply %</th>
              <th>Pos %</th>
              <th>Prog %</th>
              <th>Opt-Out %</th>
              <th>Score</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(template => (
              <tr key={template.template_id} onClick={() => setSelectedTemplate(template)} className="is-clickable">
                <td className="nx-td-template">
                  <div className="nx-template-info">
                    <span className="nx-template-name">{template.template_name || 'Unnamed Template'}</span>
                    <span className="nx-template-preview">{template.template_text?.slice(0, 40)}...</span>
                  </div>
                </td>
                <td>{template.total_sent}</td>
                <td>{template.reply_rate.toFixed(1)}%</td>
                <td>{template.positive_interest_rate.toFixed(1)}%</td>
                <td>{template.unique_seller_replies > 0 ? ((template.stage_advanced_count / template.unique_seller_replies) * 100).toFixed(1) : 0}%</td>
                <td className={template.risk_level === 'HIGH' ? 'text-danger' : ''}>
                  {template.opt_out_rate.toFixed(1)}%
                </td>
                <td>
                  <div className="nx-score-pill" style={{ 
                    backgroundColor: `rgba(var(--score-rgb), ${Number(template.overall_score) / 100})`,
                    color: Number(template.overall_score) > 50 ? 'white' : 'inherit'
                  }}>
                    {Math.round(Number(template.overall_score))}
                  </div>
                </td>
                <td>
                  <span className={`nx-badge is-${template.recommendation.toLowerCase()}`}>
                    {template.recommendation === 'SCALE' ? 'WINNER' : template.recommendation.replace('_', ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedTemplate && (
        <div className="nx-stats-drawer-overlay" onClick={() => setSelectedTemplate(null)}>
          <div className="nx-stats-drawer" onClick={e => e.stopPropagation()}>
            <header className="nx-drawer-header">
              <div className="nx-drawer-header__title">
                <h2>{selectedTemplate.template_name || 'Template Detail'}</h2>
                <span className={`nx-badge is-${selectedTemplate.recommendation.toLowerCase()}`}>
                  {selectedTemplate.recommendation === 'SCALE' ? 'WINNER' : selectedTemplate.recommendation.replace('_', ' ')}
                </span>
              </div>
              <button className="nx-drawer-close" onClick={() => setSelectedTemplate(null)}>&times;</button>
            </header>
            <div className="nx-drawer-content">
              <div className="nx-detail-section">
                <h3>Template Text</h3>
                <div className="nx-template-bubble">{selectedTemplate.template_text}</div>
              </div>
              
              <div className="nx-detail-grid">
                <div className="nx-detail-item">
                  <label>Identity</label>
                  <span>{selectedTemplate.template_id}</span>
                </div>
                <div className="nx-detail-item">
                  <label>Overall Score</label>
                  <span className="nx-detail-value">{Math.round(selectedTemplate.overall_score)}</span>
                </div>
                <div className="nx-detail-item">
                  <label>Risk Level</label>
                  <span className={`nx-risk-indicator is-${selectedTemplate.risk_level.toLowerCase()}`}>
                    {selectedTemplate.risk_level}
                  </span>
                </div>
              </div>

              <div className="nx-detail-section">
                <h3>Recommendation Analysis</h3>
                <div className="nx-rec-reason">
                  <strong>Status: {selectedTemplate.recommendation}</strong>
                  <p>
                    {selectedTemplate.recommendation === 'SCALE' && "This template is a high-performer with sufficient data and low risk. Scale deployment."}
                    {selectedTemplate.recommendation === 'LOW_DATA' && "Insufficient data to determine performance safely. Continue testing with limited volume."}
                    {selectedTemplate.recommendation === 'RISKY' && "Elevated opt-out or hostile reply rates detected. Review and rewrite."}
                    {selectedTemplate.recommendation === 'PAUSE' && "Critical compliance risk. This variant has been automatically flagged for removal."}
                    {selectedTemplate.recommendation === 'TESTING' && "Stable performance. Keep monitoring until it reaches SCALE threshold."}
                    {selectedTemplate.recommendation === 'WATCHLIST' && "Sub-par performance or high variance. Not recommended for scaling."}
                  </p>
                </div>
              </div>

              <div className="nx-detail-section">
                <h3>Agent Pairing Performance</h3>
                <div className="nx-agent-stats">
                  <div className="nx-empty-state">No significant agent variance detected for this template.</div>
                </div>
              </div>

              <div className="nx-detail-section">
                <h3>Market Performance</h3>
                <div className="nx-market-chips">
                  {Object.entries(selectedTemplate.top_markets || {}).map(([market, count]) => (
                    <span key={market} className="nx-market-chip">{market}: {count} sends</span>
                  ))}
                </div>
              </div>

              <div className="nx-detail-section">
                <h3>Recent Sample Inbound Replies</h3>
                <div className="nx-sample-replies">
                  {selectedTemplate.sample_inbound?.length > 0 ? (
                    selectedTemplate.sample_inbound.slice(0, 5).map((reply, i) => (
                      <div key={i} className="nx-sample-reply">
                        <span className="nx-reply-intent">{reply.intent || 'unclear'}</span>
                        <p>"{reply.body}"</p>
                      </div>
                    ))
                  ) : (
                    <div className="nx-empty-state">No attributed replies yet.</div>
                  )}
                </div>
              </div>

              <div className="nx-drawer-actions">
                <button className="nx-action-button is-primary">Copy to Draft</button>
                <button className="nx-action-button is-danger">Pause Variant</button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
