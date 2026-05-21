import { useState, useEffect, useCallback, useMemo } from 'react'
import { Icon } from '../../shared/icons'
import './MetricsWarRoom.css'
import { USAMap, type StateMetrics } from './components/USAMap'
import { 
  fetchPerformanceOverview, 
  fetchPerformanceOutliers, 
  fetchAttributionCoverage,
  type PerformanceFilters
} from '../../lib/data/performanceIntelligence'
import { useOperationalKpis } from '../../lib/data/operationalKpis'
import { formatCurrency, formatCompactNumber, formatPercent } from '../../shared/formatters'

type ViewSize = '25' | '50' | '75' | '100'

export const KpiIntelligencePage = () => {
  const [viewSize, setViewSize] = useState<ViewSize>('100')
  const [filters, setFilters] = useState<PerformanceFilters>({ time_window: '7d' })
  const [isLoading, setIsLoading] = useState(true)
  
  const [overview, setOverview] = useState<any>(null)
  const [outliers, setOutliers] = useState<any[]>([])
  const [coverage, setCoverage] = useState<any>(null)
  const [highlightedState, setHighlightedState] = useState<string | null>(null)

  useOperationalKpis(filters.time_window === 'all_time' ? '30d' : filters.time_window as any)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const [ov, out, cov] = await Promise.all([
        fetchPerformanceOverview(filters),
        fetchPerformanceOutliers(),
        fetchAttributionCoverage()
      ])
      setOverview(ov)
      setOutliers(out)
      setCoverage(cov)
    } catch (err) {
      console.error('Failed to load performance data', err)
    } finally {
      setIsLoading(false)
    }
  }, [filters])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Mock data for new sections
  const stateData = useMemo<Record<string, StateMetrics>>(() => ({
    TX: { state: 'TX', sent: 12400, delivered: 11800, replies: 1840, positive: 450, optOuts: 310, spend: 2400, activeSellers: 840, contracts: 12, performanceColor: 'var(--nx-neon-green)' },
    FL: { state: 'FL', sent: 9800, delivered: 9200, replies: 1420, positive: 380, optOuts: 240, spend: 1800, activeSellers: 620, contracts: 8, performanceColor: 'var(--nx-neon-blue)' },
    GA: { state: 'GA', sent: 8500, delivered: 8100, replies: 1200, positive: 310, optOuts: 190, spend: 1600, activeSellers: 540, contracts: 6, performanceColor: 'var(--nx-neon-blue)' },
    AZ: { state: 'AZ', sent: 7200, delivered: 6800, replies: 980, positive: 220, optOuts: 150, spend: 1400, activeSellers: 420, contracts: 4, performanceColor: 'var(--nx-neon-yellow)' },
    NV: { state: 'NV', sent: 5400, delivered: 5100, replies: 720, positive: 160, optOuts: 110, spend: 1100, activeSellers: 310, contracts: 3, performanceColor: 'var(--nx-neon-yellow)' },
    NC: { state: 'NC', sent: 6800, delivered: 6400, replies: 890, positive: 210, optOuts: 140, spend: 1300, activeSellers: 380, contracts: 5, performanceColor: 'var(--nx-neon-blue)' },
    MN: { state: 'MN', sent: 4200, delivered: 4000, replies: 540, positive: 130, optOuts: 85, spend: 900, activeSellers: 240, contracts: 2, performanceColor: 'var(--nx-neon-green)' },
    CA: { state: 'CA', sent: 3200, delivered: 2800, replies: 410, positive: 90, optOuts: 120, spend: 850, activeSellers: 180, contracts: 1, performanceColor: 'var(--nx-neon-red)' },
  }), [])

  const funnelSteps = [
    { label: 'Queued', count: 45200, conversion: 100, color: '#94a3b8' },
    { label: 'Sent', count: 42100, conversion: 93.1, color: 'var(--nx-neon-blue)' },
    { label: 'Delivered', count: 39800, conversion: 94.5, color: 'var(--nx-neon-blue)' },
    { label: 'Replied', count: 6840, conversion: 17.2, color: '#6366f1' },
    { label: 'Positive Intent', count: 1250, conversion: 18.3, color: 'var(--nx-neon-green)' },
    { label: 'Qualified', count: 840, conversion: 67.2, color: 'var(--nx-neon-green)' },
    { label: 'Underwritten', count: 620, conversion: 73.8, color: 'var(--nx-neon-purple)' },
    { label: 'Offer Created', count: 450, conversion: 72.5, color: 'var(--nx-neon-purple)' },
    { label: 'Offer Sent', count: 410, conversion: 91.1, color: 'var(--nx-neon-purple)' },
    { label: 'Contract Sent', count: 125, conversion: 30.5, color: 'var(--nx-neon-yellow)' },
    { label: 'Under Contract', count: 42, conversion: 33.6, color: '#f97316' },
    { label: 'Closed', count: 18, conversion: 42.8, color: 'var(--nx-neon-green)' },
  ]

  const KpiCard = ({ label, value, trend, trendDir, status }: any) => (
    <article className={`nx-kpi-card ${status ? `is-${status}` : ''}`}>
      <span className="nx-kpi-card__label">{label}</span>
      <strong className="nx-kpi-card__value">{value}</strong>
      {trend && (
        <span className={`nx-kpi-card__trend ${trendDir === 'up' ? 'text-green' : 'text-red'}`}>
          {trendDir === 'up' ? '↑' : '↓'} {trend}
        </span>
      )}
    </article>
  )

  const Section = ({ title, children, className, action }: any) => (
    <section className={`nx-card-section ${className || ''}`}>
      <header className="nx-card-section__header">
        <h3>{title}</h3>
        {action}
      </header>
      <div className="nx-card-section__body">
        {children}
      </div>
    </section>
  )

  const revenueMetrics = [
    { label: 'Offers Created', value: '450', color: 'var(--nx-neon-blue)' },
    { label: 'Offers Sent', value: '410', color: 'var(--nx-neon-blue)' },
    { label: 'Contracts Sent', value: '125', color: 'var(--nx-neon-yellow)' },
    { label: 'Fully Executed', value: '42', color: 'var(--nx-neon-green)' },
    { label: 'Routed to Title', value: '38', color: 'var(--nx-neon-purple)' },
    { label: 'Closings Scheduled', value: '24', color: 'var(--nx-neon-purple)' },
    { label: 'Closed', value: '18', color: 'var(--nx-neon-green)' },
    { label: 'Gross Revenue', value: '$452,000', color: '#fff' },
    { label: 'Projected', value: '$1.2M', color: 'var(--nx-neon-blue)' },
    { label: 'Avg Deal Size', value: '$25,110', color: '#fff' },
  ]

  const tgHealthData = [
    { number: '(469) 313-1600', market: 'Dallas', sent: 142, del: '96%', opt: '1.2%', status: 'healthy' },
    { number: '(713) 487-1200', market: 'Houston', sent: 128, del: '94%', opt: '2.1%', status: 'healthy' },
    { number: '(404) 991-4500', market: 'Atlanta', sent: 156, del: '89%', opt: '4.5%', status: 'warning' },
    { number: '(702) 881-2300', market: 'Las Vegas', sent: 94, del: '91%', opt: '3.2%', status: 'warning' },
    { number: '(612) 420-1100', market: 'Minneapolis', sent: 112, del: '97%', opt: '0.8%', status: 'healthy' },
    { number: '(980) 451-9900', market: 'Charlotte', sent: 135, del: '72%', opt: '8.4%', status: 'critical' },
  ]

  return (
    <main className={`nx-metrics-war-room ${isLoading ? 'is-loading' : ''}`} data-view={viewSize}>
      {isLoading && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          backdropFilter: 'blur(4px)'
        }}>
          <Icon name="refresh-cw" className="spin" style={{ width: '40px', height: '40px', color: 'var(--nx-neon-blue)' }} />
        </div>
      )}
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <h1>Metrics War Room</h1>
          {coverage && (
            <div className="nx-kpi-status-pulse">
              System Active • {coverage.coverage_pct.toFixed(1)}% Coverage
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <div className="nx-view-controls">
            {(['25', '50', '75', '100'] as ViewSize[]).map(s => (
              <button
                key={s}
                className={`nx-view-btn ${viewSize === s ? 'is-active' : ''}`}
                onClick={() => setViewSize(s)}
              >
                {s}%
              </button>
            ))}
          </div>

          <select 
            className="nx-kpi-filter-chip" 
            value={filters.time_window} 
            onChange={e => setFilters(p => ({ ...p, time_window: e.target.value as any }))}
          >
            <option value="today">Today</option>
            <option value="24h">24 Hours</option>
            <option value="7d">7 Days</option>
            <option value="30d">30 Days</option>
            <option value="all_time">All Time</option>
          </select>

          <button className="nx-kpi-btn" onClick={loadData}>
            <Icon name="refresh-cw" />
          </button>
        </div>
      </header>

      {/* TOP KPI COMMAND STRIP */}
      <section className="nx-kpi-command-strip">
        <KpiCard label="Sent" value={formatCompactNumber(overview?.sends || 0)} trend="+12%" trendDir="up" />
        <KpiCard label="Delivered" value={formatPercent((overview?.delivery_rate_pct || 0) / 100)} status={overview?.delivery_rate_pct < 90 ? 'critical' : 'success'} />
        <KpiCard label="Replies" value={formatCompactNumber(overview?.replies || 0)} trend="+5.4%" trendDir="up" />
        <KpiCard label="Positive" value={formatPercent((overview?.positive_rate_pct || 0) / 100)} status={overview?.positive_rate_pct > 15 ? 'success' : ''} />
        <KpiCard label="Opt-Out Rate" value={formatPercent((overview?.opt_out_rate_pct || 0) / 100)} status={overview?.opt_out_rate_pct > 3 ? 'warning' : 'success'} />
        <KpiCard label="Cost / Period" value={formatCurrency(1240.50)} />
        <KpiCard label="Cost / Reply" value={formatCurrency(4.20)} />
        <KpiCard label="Cost / Positive" value={formatCurrency(18.50)} />
        <KpiCard label="Queue Health" value="98.2%" status="success" />
        <KpiCard label="Auto Health" value="Nominal" status="success" />
        <KpiCard label="Buyer Demand" value="High" status="success" />
      </section>

      <div className="nx-metrics-grid">
        {/* NATIONWIDE PERFORMANCE MAP */}
        <Section title="Nationwide Performance" className="nx-grid-map">
          <div className="nx-map-container">
            <USAMap 
              data={stateData} 
              onHoverState={setHighlightedState}
              highlightedState={highlightedState}
            />
            {highlightedState && stateData[highlightedState] && (
              <div style={{
                position: 'absolute',
                top: '20px',
                right: '20px',
                background: 'rgba(5, 7, 10, 0.9)',
                padding: '16px',
                borderRadius: '8px',
                border: '1px solid var(--nx-border)',
                minWidth: '180px',
                backdropFilter: 'blur(10px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
              }}>
                <h4 style={{ margin: '0 0 8px 0', borderBottom: '1px solid var(--nx-border)', paddingBottom: '4px', fontSize: '14px' }}>
                  {highlightedState} Intelligence
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Sent:</span> <strong>{stateData[highlightedState].sent.toLocaleString()}</strong></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Replies:</span> <strong>{stateData[highlightedState].replies.toLocaleString()}</strong></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Positive:</span> <strong className="text-green">{stateData[highlightedState].positive.toLocaleString()}</strong></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Contracts:</span> <strong className="text-purple">{stateData[highlightedState].contracts}</strong></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Spend:</span> <strong>{formatCurrency(stateData[highlightedState].spend)}</strong></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Opt-Outs:</span> <strong className="text-red">{stateData[highlightedState].optOuts.toLocaleString()}</strong></div>
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ACQUISITION FUNNEL */}
        <Section title="Acquisition Funnel" className="nx-grid-funnel">
          <div className="nx-funnel">
            {funnelSteps.map((step, idx) => (
              <div key={idx} className="nx-funnel-step">
                <div className="nx-funnel-step__info">
                  <span className="nx-funnel-step__label">{step.label}</span>
                  <span className="nx-funnel-step__count">{step.count.toLocaleString()} <small style={{ opacity: 0.5, fontWeight: 400 }}>({step.conversion}%)</small></span>
                </div>
                <div className="nx-funnel-step__bar-wrap">
                  <div className="nx-funnel-step__bar" style={{ width: `${step.conversion}%`, backgroundColor: step.color }} />
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* LEADERBOARDS */}
        <Section title="Elite Leaderboards" className="nx-grid-leaderboards">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '24px' }}>
            <div>
              <h4 style={{ fontSize: '11px', color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>TOP MARKETS</h4>
              <table className="nx-leaderboard-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Sent</th>
                    <th>Reply%</th>
                    <th>Pos%</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {overview?.markets.slice(0, 5).map((m: any) => (
                    <tr key={m.market}>
                      <td style={{ fontWeight: 600 }}>{m.market}</td>
                      <td>{m.sends}</td>
                      <td>{m.reply_rate_pct.toFixed(1)}%</td>
                      <td className="text-green">{m.positive_rate_pct.toFixed(1)}%</td>
                      <td><span className="nx-status-badge healthy">SCALE</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h4 style={{ fontSize: '11px', color: '#64748b', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>TOP TEMPLATES</h4>
              <table className="nx-leaderboard-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Sent</th>
                    <th>Pos%</th>
                    <th>Opt-Out%</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {overview?.templates.slice(0, 5).map((t: any) => (
                    <tr key={t.template_key}>
                      <td style={{ fontWeight: 600 }}>{t.template_key}</td>
                      <td>{t.sends}</td>
                      <td className="text-green">{t.positive_rate_pct.toFixed(1)}%</td>
                      <td className={t.opt_out_rate_pct > 3 ? 'text-red' : ''}>{t.opt_out_rate_pct.toFixed(1)}%</td>
                      <td>
                        <span className={`nx-status-badge ${t.opt_out_rate_pct > 4 ? 'critical' : 'healthy'}`}>
                          {t.opt_out_rate_pct > 4 ? 'PAUSE' : 'STABLE'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        {/* REVENUE PIPELINE */}
        <Section title="Revenue & Pipeline" className="nx-grid-revenue">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {revenueMetrics.map((m, idx) => (
              <div key={idx} style={{ 
                padding: '12px', 
                background: 'rgba(255,255,255,0.02)', 
                borderRadius: '8px',
                border: '1px solid var(--nx-border)'
              }}>
                <div style={{ fontSize: '10px', color: 'var(--nx-text-3)', textTransform: 'uppercase', marginBottom: '4px' }}>{m.label}</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: m.color }}>{m.value}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* TEXTGRID HEALTH */}
        <Section title="TextGrid Number Health" className="nx-grid-tg-health">
          <table className="nx-leaderboard-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Market</th>
                <th>Sent Today</th>
                <th>Delivery %</th>
                <th>Opt-Out %</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {tgHealthData.map((row, idx) => (
                <tr key={idx}>
                  <td style={{ fontFamily: 'var(--nx-font-mono)', fontSize: '11px' }}>{row.number}</td>
                  <td>{row.market}</td>
                  <td>{row.sent}</td>
                  <td className={row.del.includes('9') ? 'text-green' : 'text-yellow'}>{row.del}</td>
                  <td className={Number(row.opt.replace('%','')) > 4 ? 'text-red' : ''}>{row.opt}</td>
                  <td><span className={`nx-status-badge ${row.status}`}>{row.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* CHANNELS */}
        <Section title="Channel Performance" className="nx-grid-channels">
          <div className="nx-channel-grid" style={{ gridTemplateColumns: '1fr' }}>
            <div className="nx-channel-card" style={{ borderLeft: '3px solid var(--nx-neon-blue)' }}>
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 12px 0', fontSize: '13px' }}><Icon name="inbox" /> SMS OUTREACH</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
                <div>Sent: <strong className="text-blue">{formatCompactNumber(overview?.sends || 0)}</strong></div>
                <div>Deliv: <strong className="text-green">{formatPercent((overview?.delivery_rate_pct || 0) / 100)}</strong></div>
                <div>Replies: <strong>{formatCompactNumber(overview?.replies || 0)}</strong></div>
                <div>Pos: <strong className="text-green">{formatPercent((overview?.positive_rate_pct || 0) / 100)}</strong></div>
              </div>
            </div>
            <div className="nx-channel-card" style={{ opacity: 0.4, background: 'rgba(255,255,255,0.01)' }}>
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 4px 0', fontSize: '13px' }}><Icon name="file-text" /> EMAIL</h4>
              <p style={{ fontSize: '10px', fontStyle: 'italic', margin: 0 }}>Tracking not wired yet — connect email events to message_events.</p>
            </div>
            <div className="nx-channel-card" style={{ opacity: 0.4, background: 'rgba(255,255,255,0.01)' }}>
              <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 4px 0', fontSize: '13px' }}><Icon name="phone" /> VOICE / RVM</h4>
              <p style={{ fontSize: '10px', fontStyle: 'italic', margin: 0 }}>Future placeholder — awaiting RVM integration.</p>
            </div>
          </div>
        </Section>

        {/* CARRIER INTELLIGENCE */}
        <Section title="Carrier Intelligence" className="nx-grid-carrier">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {['T-Mobile', 'Verizon', 'AT&T', 'US Cellular'].map((c, idx) => (
              <div key={idx} style={{ fontSize: '12px', padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <strong>{c}</strong>
                  <span className="text-green">94%</span>
                </div>
                <div className="nx-funnel-step__bar-wrap"><div className="nx-funnel-step__bar" style={{ width: '94%', height: '4px' }} /></div>
              </div>
            ))}
            <p style={{ fontSize: '10px', opacity: 0.5, fontStyle: 'italic', marginTop: '4px' }}>
              Carrier-level tracking not wired yet. Add carrier_name and line_type to message_events.
            </p>
          </div>
        </Section>

        {/* BUYER DEMAND */}
        <Section title="Buyer Demand" className="nx-grid-buyer">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ padding: '12px', background: 'rgba(56, 208, 240, 0.05)', borderRadius: '8px', border: '1px solid rgba(56, 208, 240, 0.1)' }}>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--nx-neon-blue)', marginBottom: '4px' }}>Avg Buyer Score</div>
              <div style={{ fontSize: '24px', fontWeight: 800 }}>84.5</div>
            </div>
            <div style={{ fontSize: '12px', padding: '8px' }}>
              <div>Top Market: <strong>DFW</strong></div>
              <div>Active Matches: <strong>1,240</strong></div>
              <div>Interest 30d: <strong className="text-green">+18%</strong></div>
            </div>
            <p style={{ fontSize: '10px', opacity: 0.5, fontStyle: 'italic', margin: '4px 0 0 0' }}>
              Connect buyer_match table to surface real-time buyer demand.
            </p>
          </div>
        </Section>

        {/* OPERATION HEALTH */}
        <Section title="System Health Cockpit" className="nx-grid-health">
          <div className="nx-health-grid">
            <div className="nx-health-item"><span className="nx-health-item__label">Queue Runner</span><span className="nx-health-item__status text-green">ONLINE</span></div>
            <div className="nx-health-item"><span className="nx-health-item__label">Webhook GW</span><span className="nx-health-item__status text-green">NOMINAL</span></div>
            <div className="nx-health-item"><span className="nx-health-item__label">Failed Queue</span><span className="nx-health-item__status text-red">24</span></div>
            <div className="nx-health-item"><span className="nx-health-item__label">Routing Blocks</span><span className="nx-health-item__status text-yellow">12</span></div>
            <div className="nx-health-item"><span className="nx-health-item__label">Last Send</span><span className="nx-health-item__status">2m ago</span></div>
            <div className="nx-health-item"><span className="nx-health-item__label">DNC Count</span><span className="nx-health-item__status">1,402</span></div>
          </div>
        </Section>
      </div>

      {/* INTELLIGENCE ALERTS */}
      <Section title="Intelligence Alert Feed" action={<span className="text-blue" style={{ fontSize: '10px', cursor: 'pointer' }}>VIEW ALL</span>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {outliers.length > 0 ? outliers.slice(0, 4).map((o, idx) => (
            <div key={idx} style={{ 
              padding: '14px', 
              background: 'rgba(255,255,255,0.02)', 
              borderRadius: '8px',
              borderLeft: `4px solid ${o.performance_label === 'winner' ? 'var(--nx-neon-green)' : (o.performance_label === 'risky' ? 'var(--nx-neon-red)' : 'var(--nx-neon-yellow)')}`,
              fontSize: '13px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <strong style={{ textTransform: 'uppercase', fontSize: '11px', color: 'var(--nx-text-3)' }}>{o.outlier_type.replace(/_/g, ' ')}</strong>
                <div style={{ marginTop: '2px' }}>{o.key} is showing {o.performance_label} levels (Score: {o.score.toFixed(1)})</div>
              </div>
              <Icon name="chevron-right" />
            </div>
          )) : (
            <div className="nx-empty-state">No active alerts — system operating normally.</div>
          )}
        </div>
      </Section>
    </main>
  )
}
