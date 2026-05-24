import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { type OperationalKpi } from '../../../lib/data/inboxKpis'
import { useOperationalKpis } from '../../../lib/data/operationalKpis'
import { usePerformanceIntelligence, type TimeWindow } from '../../../lib/data/performanceIntelligence'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

type KpiTone = 'good' | 'warning' | 'critical' | 'neutral'

const resolveKpiTone = (kpi: OperationalKpi): KpiTone => {
  if (kpi.status === 'good' || kpi.status === 'warning' || kpi.status === 'critical') return kpi.status
  return 'neutral'
}

export const InboxKpiOrb = () => {
  const [isOpen, setIsOpen] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [timeWindow, setTimeWindow] = useState<OperationalKpi['timeWindow']>('24h')
  const [pinnedKpiId, setPinnedKpiId] = useState<string>(() => localStorage.getItem('nexus.pinnedInboxKpi') || 'reply-rate')
  const [updatedKpiIds, setUpdatedKpiIds] = useState<Record<string, number>>({})
  const previousKpiSnapshotRef = useRef<Record<string, string>>({})
  const updateTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const { kpis, isLive, recommendations, error: kpiError, refresh: refreshKpis } = useOperationalKpis(timeWindow)
  const { outliers, coverage } = usePerformanceIntelligence(timeWindow as TimeWindow)

  const error = kpiError

  const allKpisList = useMemo(() => {
    if (!kpis) return []
    return [
      ...kpis.messaging,
      ...kpis.quality,
      ...kpis.automation,
      ...kpis.pipeline,
      ...kpis.financial
    ]
  }, [kpis])

  const pinnedKpi = useMemo(() => {
    return allKpisList.find(k => k.id === pinnedKpiId) || allKpisList[0]
  }, [allKpisList, pinnedKpiId])

  useEffect(() => {
    if (typeof window === 'undefined' || !kpis) return

    const nextSnapshot: Record<string, string> = {}
    const nextUpdated: Record<string, number> = {}

    allKpisList.forEach((kpi) => {
      const signature = `${kpi.value}|${kpi.unit ?? ''}|${kpi.status ?? ''}|${kpi.trend ?? ''}`
      nextSnapshot[kpi.id] = signature
      const previous = previousKpiSnapshotRef.current[kpi.id]
      if (previous && previous !== signature) {
        nextUpdated[kpi.id] = Date.now()
        const existingTimer = updateTimersRef.current[kpi.id]
        if (existingTimer) window.clearTimeout(existingTimer)
        updateTimersRef.current[kpi.id] = window.setTimeout(() => {
          setUpdatedKpiIds((current) => {
            if (!(kpi.id in current)) return current
            const copy = { ...current }
            delete copy[kpi.id]
            return copy
          })
          delete updateTimersRef.current[kpi.id]
        }, 2200)
      }
    })

    previousKpiSnapshotRef.current = nextSnapshot
    if (Object.keys(nextUpdated).length > 0) {
      setUpdatedKpiIds((current) => ({ ...current, ...nextUpdated }))
    }
  }, [allKpisList, kpis])

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      Object.values(updateTimersRef.current).forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  const handlePinKpi = (id: string) => {
    setPinnedKpiId(id)
    localStorage.setItem('nexus.pinnedInboxKpi', id)
  }

  const renderKpiCard = (kpi: OperationalKpi) => {
    const tone = resolveKpiTone(kpi)
    let trendIcon: IconName | null = null
    if (kpi.trend === 'up') trendIcon = 'trending-up'
    if (kpi.trend === 'down') trendIcon = 'chevron-down'

    return (
      <div 
        key={kpi.id} 
        className={cls(
          'nx-orb-dashboard__card',
          `is-${tone}`,
          kpi.id === pinnedKpiId && 'is-pinned',
          Boolean(updatedKpiIds[kpi.id]) && 'is-updated',
          !kpi.isAvailable && 'is-unavailable'
        )}
        onClick={() => kpi.isAvailable && handlePinKpi(kpi.id)}
      >
        <div className="nx-orb-dashboard__card-tint" />
        <div className="nx-orb-dashboard__card-top">
          <div className="nx-orb-dashboard__card-label-stack">
            <span className="nx-orb-dashboard__card-label">{kpi.label}</span>
            {kpi.description && <span className="nx-orb-dashboard__card-meta">{kpi.description}</span>}
          </div>
          <div className="nx-orb-dashboard__card-signals">
            {kpi.status && <div className={cls('nx-orb-dashboard__status-dot', `is-${kpi.status}`)} />}
            <span className={cls('nx-orb-dashboard__status-pill', `is-${tone}`)}>{tone}</span>
          </div>
        </div>
        <div className="nx-orb-dashboard__card-main">
          <div className="nx-orb-dashboard__card-value">
            {kpi.value}{kpi.unit}
          </div>
          {trendIcon && (
            <div className={cls('nx-orb-dashboard__card-trend', `is-${kpi.trend}`)}>
              <Icon name={trendIcon} />
              <span>{kpi.trend === 'up' ? 'Rising' : 'Falling'}</span>
            </div>
          )}
        </div>
        <div className="nx-orb-dashboard__card-footer">
          <span>{kpi.category}</span>
          <span>{updatedKpiIds[kpi.id] ? 'Updated now' : `Window ${kpi.timeWindow.toUpperCase()}`}</span>
        </div>
      </div>
    )
  }

  const volumeCards = kpis?.volume ?? []

  return (
    <div 
      className={cls('nx-kpi-orb-container', (isOpen || isPinned) && 'is-open')}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => !isPinned && setIsOpen(false)}
    >
      {/* The Orb / Capsule */}
      <div 
        className={cls(
          'nx-kpi-orb', 
          isPinned && 'is-pinned-active',
          isLive && 'is-live-pulsing',
          pinnedKpi && `is-${resolveKpiTone(pinnedKpi)}`
        )}
        onClick={() => setIsPinned(!isPinned)}
      >
        <div className="nx-kpi-orb__glow" />
        <div className="nx-kpi-orb__inner">
          <div className={cls('nx-kpi-orb__icon-box', isLive && 'is-active')}>
            <Icon name={isLive ? 'zap' : 'activity'} />
          </div>
          {pinnedKpi && (
            <span className="nx-kpi-orb__mini-value">{pinnedKpi.value}{pinnedKpi.unit || '%'}</span>
          )}
          {isLive && <div className="nx-kpi-orb__live-tag">•</div>}
        </div>
      </div>

      {/* Expanded Dashboard */}
      {(isOpen || isPinned) && (
        <div className="nx-orb-dashboard nx-liquid-popover">
          <header className="nx-orb-dashboard__header">
            <div className="nx-orb-dashboard__title-stack">
              <div className="nx-orb-dashboard__title">Operational Intelligence</div>
              <div className="nx-orb-dashboard__subtitle">System Telemetry v2.0</div>
              {pinnedKpi && (
                <div className={cls('nx-orb-dashboard__hero-pill', `is-${resolveKpiTone(pinnedKpi)}`)}>
                  Pinned KPI: {pinnedKpi.label} {pinnedKpi.value}{pinnedKpi.unit || ''} ({resolveKpiTone(pinnedKpi)})
                </div>
              )}
            </div>
            <div className="nx-orb-dashboard__windows">
              {(['today', '24h', '7d', '30d'] as const).map(w => (
                <button 
                  key={w} 
                  className={cls('nx-orb-dashboard__window-btn', timeWindow === w && 'is-active')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setTimeWindow(w)
                  }}
                >
                  {w.toUpperCase()}
                </button>
              ))}
            </div>
          </header>

          <div className="nx-orb-dashboard__content">
            {error && (
              <div style={{
                margin: '16px',
                padding: '12px',
                background: 'rgba(255, 0, 0, 0.1)',
                border: '1px solid rgba(255, 0, 0, 0.3)',
                borderRadius: '8px',
                color: '#ff6b6b',
                fontSize: '12px'
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Icon name="alert" />
                  Telemetry Link Failure
                </div>
                <div style={{ fontFamily: 'monospace', opacity: 0.9 }}>
                  {error instanceof Error ? error.message : String(error)}
                </div>
                <button 
                  onClick={() => refreshKpis()}
                  style={{
                    marginTop: '8px',
                    background: 'rgba(255,255,255,0.1)',
                    border: 'none',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '10px'
                  }}
                >
                  Retry Connection
                </button>
              </div>
            )}
            <div className="nx-orb-dashboard__scroll-area">
              {volumeCards.length > 0 && (
                <section className="nx-orb-dashboard__section">
                  <label>Message Flow</label>
                  <div className="nx-orb-dashboard__flow-strip">
                    {volumeCards.map((item) => (
                      <div key={item.id} className={cls('nx-orb-dashboard__flow-card', `is-${item.tone}`)}>
                        <span className="nx-orb-dashboard__flow-label">{item.label}</span>
                        <strong className="nx-orb-dashboard__flow-value">{item.value.toLocaleString()}</strong>
                        <span className="nx-orb-dashboard__flow-meta">{timeWindow.toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="nx-orb-dashboard__section">
                <label>Messaging & Response</label>
                <div className="nx-orb-dashboard__grid">
                  {kpis?.messaging.map(renderKpiCard)}
                </div>
              </section>

              <section className="nx-orb-dashboard__section">
                <label>Automation & Quality</label>
                <div className="nx-orb-dashboard__grid">
                  {[...(kpis?.automation || []), ...(kpis?.quality || [])].map(renderKpiCard)}
                </div>
              </section>

              <section className="nx-orb-dashboard__section">
                <label>Pipeline & Financials</label>
                <div className="nx-orb-dashboard__grid">
                  {[...(kpis?.pipeline || []), ...(kpis?.financial || [])].map(renderKpiCard)}
                </div>
              </section>

              {/* Performance Intelligence Section */}
              <section className="nx-orb-dashboard__section">
                <label>Performance Outliers</label>
                <div className="nx-orb-dashboard__outliers">
                  {outliers?.bestTemplate && (
                    <div className="nx-outlier-card is-winner">
                      <div className="nx-outlier-card__header">
                        <Icon name="star" />
                        <span>Best Template</span>
                      </div>
                      <div className="nx-outlier-card__body">
                        <div className="nx-outlier-card__key">{outliers.bestTemplate.template_key}</div>
                        <div className="nx-outlier-card__stats">
                          {(outliers.bestTemplate.positive_rate_pct ?? 0).toFixed(1)}% pos rate • {outliers.bestTemplate.sends} sends
                        </div>
                        <div className="nx-outlier-card__rec">Rec: Increase weight for similar leads.</div>
                      </div>
                    </div>
                  )}

                  {outliers?.riskiestTemplate && (
                    <div className="nx-outlier-card is-risky">
                      <div className="nx-outlier-card__header">
                        <Icon name="alert" />
                        <span>Riskiest Template</span>
                      </div>
                      <div className="nx-outlier-card__body">
                        <div className="nx-outlier-card__key">{outliers.riskiestTemplate.template_key}</div>
                        <div className="nx-outlier-card__stats">
                          {(outliers.riskiestTemplate.opt_out_rate_pct ?? 0).toFixed(1)}% opt-out rate
                        </div>
                        <div className="nx-outlier-card__rec">Rec: Rewrite or reduce volume.</div>
                      </div>
                    </div>
                  )}

                  {outliers?.bestNumber && (
                    <div className="nx-outlier-card is-healthy">
                      <div className="nx-outlier-card__header">
                        <Icon name="check" />
                        <span>Best Number</span>
                      </div>
                      <div className="nx-outlier-card__body">
                        <div className="nx-outlier-card__key">{outliers.bestNumber.textgrid_number_key}</div>
                        <div className="nx-outlier-card__stat">
                          Delivery: {(outliers.bestNumber.delivery_rate_pct ?? 0).toFixed(0)}% • {(outliers.bestNumber.reply_rate_pct ?? 0).toFixed(1)}% reply
                        </div>
                      </div>
                    </div>
                  )}

                  {outliers?.riskiestNumber && (
                    <div className="nx-outlier-card is-risky">
                      <div className="nx-outlier-card__header">
                        <Icon name="alert" />
                        <span>Riskiest Number</span>
                      </div>
                      <div className="nx-outlier-card__body">
                        <div className="nx-outlier-card__key">{outliers.riskiestNumber.textgrid_number_key}</div>
                        <div className="nx-outlier-card__stat">
                          Failure: {(outliers.riskiestNumber.failure_rate_pct ?? 0).toFixed(1)}% • {(outliers.riskiestNumber.opt_out_rate_pct ?? 0).toFixed(1)}% opt-out
                        </div>
                      </div>
                    </div>
                  )}

                  {coverage && (
                    <div className="nx-outlier-card is-coverage">
                      <div className="nx-outlier-card__header">
                        <Icon name="search" />
                        <span>Attribution Coverage</span>
                      </div>
                      <div className="nx-outlier-card__body">
                        <div className="nx-outlier-card__value">{(coverage.coverage_pct ?? 0).toFixed(1)}%</div>
                        <div className="nx-outlier-card__rec">Rec: Recover missing IDs from send_queue.</div>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* AI Recommendation Strip */}
            {recommendations.length > 0 && (
              <div className="nx-orb-dashboard__recs">
                <div className="nx-orb-dashboard__recs-header">
                  <Icon name="brain" />
                  <span>AI Recommendations</span>
                </div>
                <div className="nx-orb-dashboard__recs-list">
                  {recommendations.map((rec, i) => (
                    <div key={i} className="nx-orb-dashboard__rec-item">
                      {rec}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* KPI Proof Strip */}
            {kpis?.diagnostics?.metric_source_debug && (
              <div style={{
                margin: '16px 24px',
                padding: '12px',
                background: 'rgba(56, 208, 240, 0.05)',
                border: '1px solid rgba(56, 208, 240, 0.2)',
                borderRadius: '8px',
                fontSize: '11px',
                color: 'var(--nx-text-2)',
                fontFamily: 'var(--nx-font-mono)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: 'var(--nx-neon-blue)', fontWeight: 'bold' }}>
                  <Icon name="check" /> Canonical Backend Verification
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div><strong>Generated At:</strong> {new Date(kpis.diagnostics.metric_source_debug.metrics_generated_at).toLocaleString()}</div>
                  <div><strong>Window (UTC):</strong> {new Date(kpis.diagnostics.metric_source_debug.window_start).toLocaleDateString()} - {new Date(kpis.diagnostics.metric_source_debug.window_end).toLocaleDateString()}</div>
                  <div><strong>Backend Core:</strong> {kpis.diagnostics.metric_source_debug.backend_version}</div>
                  <div><strong>Cache Status:</strong> {kpis.diagnostics.metric_source_debug.cached ? 'HIT' : 'MISS (Live DB)'}</div>
                  <div><strong>Execution Time:</strong> {kpis.diagnostics.metric_source_debug.aggregation_runtime_ms}ms</div>
                  <div><strong>Duplicates Detected:</strong> {kpis.diagnostics.metric_source_debug.duplicate_rows_detected}</div>
                </div>
                <div style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Canonical Source Tables:</div>
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                    <span><span style={{ color: 'var(--nx-cyan)' }}>inbox_thread_state</span> (Threads)</span>
                    <span><span style={{ color: 'var(--nx-cyan)' }}>message_events</span> (Volumes, Rates)</span>
                    <span><span style={{ color: 'var(--nx-cyan)' }}>send_queue</span> (Ops Health)</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="nx-orb-dashboard__footer">
            <div className="nx-orb-dashboard__status">
              <div className="nx-orb-dashboard__status-indicator is-healthy" />
              <span>System Nominal</span>
            </div>
            <div className="nx-orb-dashboard__last-updated">
              {kpis?.lastUpdated ? `Sync: ${new Date(kpis.lastUpdated).toLocaleTimeString()}` : 'Connecting...'}
            </div>
          </footer>
        </div>
      )}
    </div>
  )
}
