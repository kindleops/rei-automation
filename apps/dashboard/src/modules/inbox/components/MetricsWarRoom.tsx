/**
 * MetricsWarRoom — NEXUS metrics command center.
 * Renders one of four named layouts based on layoutMode:
 *   25%  → MetricsRail25     (KPI command rail)
 *   50%  → MetricsCockpit50  (compact cockpit)
 *   75%  → MetricsCommand75  (two-column command view)
 *   100% → MetricsWarRoom100 (full war room)
 */

import { useState, useCallback, useEffect, useRef, useMemo, useId } from 'react'
import type { ViewLayoutMode, ViewWidthPercent } from '../view-layout'
import {
  loadKpiDashboardSummary,
  loadKpiTimeSeries,
  loadStatePerformance,
  loadMarketPerformance,
  loadAgentPerformance,
  loadTemplatePerformance,
  loadChannelPerformance,
  loadSpendPerformance,
  loadFunnelPerformance,
  loadDataQualityMetrics,
  loadBuyerDemandMetrics,
  loadOfferContractMetrics,
  loadTextgridNumberHealth,
  loadCarrierPerformance,
  loadKpiAlerts,
  STATE_NAMES,
  type KpiFilters,
  type KpiTimeRange,
  type KpiSummary,
  type TimeSeriesPoint,
  type StatePerformance,
  type MarketPerformance,
  type AgentPerformance,
  type TemplatePerformance,
  type ChannelPerformance,
  type SpendPerformance,
  type FunnelStage,
  type DataQualityMetrics,
  type BuyerDemandMetrics,
  type OfferContractMetrics,
  type TextgridNumberHealth,
  type CarrierPerformance,
  type KpiAlert,
  type KpiAlertsInput,
} from '../../../lib/data/kpiDashboardData'
import { USA_STATE_PATHS } from '../../../lib/data/usaStatePaths'
import './metrics-war-room.css'

// ── Utilities ─────────────────────────────────────────────────────────────────

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const fmt = {
  int: (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString()),
  pct: (n: number | null | undefined) => (n == null ? '—' : `${n}%`),
  usd: (n: number | null | undefined) =>
    n == null
      ? '—'
      : `$${n < 1000 ? n.toFixed(2) : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${(n / 1000).toFixed(1)}K`}`,
}

const TIME_RANGE_LABELS: Record<KpiTimeRange, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: '7 Days',
  last_30_days: '30 Days',
  last_40_days: '40 Days',
  custom: 'Custom',
}

// ── WrSkeleton ────────────────────────────────────────────────────────────────

function WrSkeleton({ w = '100%', h = 14 }: { w?: string | number; h?: number }) {
  return <span className="wr-skel" style={{ width: w, height: h, display: 'block', borderRadius: 3 }} />
}

// ── WrMiniLine ────────────────────────────────────────────────────────────────

function WrMiniLine({
  data,
  color = 'rgba(14,207,206,0.85)',
  w = 80,
  h = 24,
}: {
  data: number[]
  color?: string
  w?: number
  h?: number
}) {
  // useId MUST be called before any early returns
  const uid = useId()
  const gId = `wrl-${uid.replace(/:/g, '')}`

  if (!data.length || data.every(v => v === 0)) {
    return <span style={{ display: 'block', width: w, height: h, opacity: 0.08, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }} />
  }
  const max = Math.max(...data, 0.001)
  const min = Math.min(...data)
  const range = max - min || 0.001
  const pad = 2
  const pts = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * (w - pad * 2) + pad
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return [x, y] as [number, number]
  })
  const pStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const first = pts[0]
  const last = pts[pts.length - 1]
  const fillD = `M${first[0].toFixed(1)},${h} ${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} L${last[0].toFixed(1)},${h} Z`
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={fillD} fill={`url(#${gId})`} stroke="none" />
      <polyline points={pStr} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 2px ${color}55)` }} />
      {last && <circle cx={last[0]} cy={last[1]} r="2.2" fill="#fff" stroke={color} strokeWidth="1" />}
    </svg>
  )
}

// ── WrTrend ───────────────────────────────────────────────────────────────────

function WrTrend({ current, prev, invert = false }: { current: number; prev: number; invert?: boolean }) {
  if (prev === 0 || current === prev) return null
  const up = current > prev
  const good = invert ? !up : up
  const pct = Math.abs(Math.round(((current - prev) / prev) * 100))
  return (
    <span className={cls('wr-trend', good ? 'wr-trend--up' : 'wr-trend--down')}>
      {up ? '▲' : '▼'} {pct}%
    </span>
  )
}

// ── Choropleth helpers ────────────────────────────────────────────────────────

function choroFill(d: StatePerformance | undefined): string {
  if (!d || d.sent === 0 || d.status === 'quiet') return 'rgba(15,30,85,0.85)'
  switch (d.status) {
    case 'strong':      return 'rgba(14,212,138,0.32)'
    case 'active':      return 'rgba(14,207,206,0.28)'
    case 'contracting': return 'rgba(168,85,247,0.32)'
    case 'warning':     return 'rgba(245,166,35,0.32)'
    case 'blocked':     return 'rgba(224,82,82,0.32)'
    default:            return 'rgba(15,30,85,0.85)'
  }
}

function choroStroke(d: StatePerformance | undefined, sel: boolean, hov: boolean): string {
  if (sel) return 'rgba(255,255,255,0.95)'
  if (hov) return 'rgba(255,255,255,0.75)'
  if (!d || d.sent === 0 || d.status === 'quiet') return 'rgba(80,140,220,0.5)'
  switch (d.status) {
    case 'strong':      return 'rgba(14,212,138,0.85)'
    case 'active':      return 'rgba(14,207,206,0.80)'
    case 'contracting': return 'rgba(168,85,247,0.85)'
    case 'warning':     return 'rgba(245,166,35,0.80)'
    case 'blocked':     return 'rgba(224,82,82,0.85)'
    default:            return 'rgba(80,140,220,0.5)'
  }
}

// ── WrFilterBar ───────────────────────────────────────────────────────────────

function WrFilterBar({
  filters,
  onChange,
  loading,
  selectedState,
  onClearState,
  widthMode,
}: {
  filters: KpiFilters
  onChange: (p: Partial<KpiFilters>) => void
  loading: boolean
  selectedState: string | null
  onClearState: () => void
  widthMode: ViewWidthPercent
}) {
  const ranges: KpiTimeRange[] = ['today', 'last_7_days', 'last_30_days', 'last_40_days']
  return (
    <div className="wr-header">
      <div className="wr-header__brand">
        <span className="wr-header__title">NEXUS METRICS</span>
        <span className="wr-header__subtitle">
          {widthMode === '25' && 'KPI COMMAND'}
          {widthMode === '50' && 'METRICS COCKPIT'}
          {widthMode === '75' && 'PERFORMANCE COMMAND'}
          {widthMode === '100' && 'WAR ROOM · REAL ESTATE ACQUISITIONS'}
        </span>
      </div>
      <div className="wr-header__spacer" />
      {selectedState && (
        <button type="button" className="wr-state-chip" onClick={onClearState}>
          {selectedState} ✕
        </button>
      )}
      <div className="wr-header__range">
        {ranges.map(r => (
          <button
            key={r}
            type="button"
            className={cls('wr-header__range-btn', filters.timeRange === r && 'is-active')}
            onClick={() => onChange({ timeRange: r })}
            disabled={loading}
          >
            {TIME_RANGE_LABELS[r]}
          </button>
        ))}
      </div>
      <div className="wr-header__live">
        <span className="wr-header__live-dot" />
        LIVE
      </div>
    </div>
  )
}

// ── WrKpiStrip ────────────────────────────────────────────────────────────────

interface KpiCardDef {
  label: string
  value: string
  sub: string | null
  color: string
  tone: string
  series: number[]
  trendCurrent: number
  trendPrev: number
}

function buildKpiCards(summary: KpiSummary, sentSeries: number[], repliedSeries: number[], posSeries: number[]): KpiCardDef[] {
  return [
    { label: 'Sent',          value: fmt.int(summary.sentCount),          sub: null,                          color: 'var(--wr-teal)',   tone: 'teal',  series: sentSeries,    trendCurrent: summary.sentCount,       trendPrev: summary.prevSentCount },
    { label: 'Delivered',     value: fmt.int(summary.deliveredCount),      sub: fmt.pct(summary.deliveryRate), color: 'var(--wr-blue)',   tone: '',      series: sentSeries,    trendCurrent: 0, trendPrev: 0 },
    { label: 'Replies',       value: fmt.int(summary.repliedCount),        sub: null,                          color: 'var(--wr-teal)',   tone: '',      series: repliedSeries, trendCurrent: summary.repliedCount,    trendPrev: summary.prevRepliedCount },
    { label: 'Positive',      value: fmt.int(summary.positiveReplies),     sub: fmt.pct(summary.positiveRate), color: 'var(--wr-green)',  tone: 'green', series: posSeries,     trendCurrent: summary.positiveReplies, trendPrev: summary.prevPositiveReplies },
    { label: 'Opt-Out Rate',  value: fmt.pct(summary.optOutRate),          sub: fmt.int(summary.optOutCount),  color: summary.optOutRate > 2 ? 'var(--wr-amber)' : 'var(--wr-muted)', tone: summary.optOutRate > 2 ? 'amber' : '', series: [], trendCurrent: 0, trendPrev: 0 },
    { label: 'Delivery Rate', value: fmt.pct(summary.deliveryRate),        sub: null,                          color: 'var(--wr-blue)',   tone: '',      series: [],            trendCurrent: 0, trendPrev: 0 },
    { label: 'Cost / Period', value: fmt.usd(summary.spendPeriod),         sub: null,                          color: 'var(--wr-muted)',  tone: '',      series: [],            trendCurrent: 0, trendPrev: 0 },
    { label: 'Cost / Reply',  value: fmt.usd(summary.costPerReply),        sub: null,                          color: 'var(--wr-amber)',  tone: '',      series: [],            trendCurrent: 0, trendPrev: 0 },
    { label: 'Cost / Pos.',   value: fmt.usd(summary.costPerPositive),     sub: null,                          color: 'var(--wr-amber)',  tone: '',      series: [],            trendCurrent: 0, trendPrev: 0 },
    { label: 'Queue Health',  value: summary.queueHealth === 'good' ? 'Good' : summary.queueHealth === 'warning' ? 'Warn' : 'Crit', sub: null, color: summary.queueHealth === 'good' ? 'var(--wr-green)' : summary.queueHealth === 'warning' ? 'var(--wr-amber)' : 'var(--wr-red)', tone: summary.queueHealth === 'critical' ? 'red' : summary.queueHealth === 'warning' ? 'amber' : 'green', series: [], trendCurrent: 0, trendPrev: 0 },
    { label: 'Auto Health',   value: String(summary.automationHealthScore), sub: '/100',                        color: 'var(--wr-teal)',   tone: '',      series: [],            trendCurrent: 0, trendPrev: 0 },
    { label: 'Buyer Demand',  value: summary.buyerDemandScore > 0 ? String(summary.buyerDemandScore) : '—', sub: null, color: 'var(--wr-purple)', tone: '', series: [], trendCurrent: 0, trendPrev: 0 },
  ]
}

function WrKpiStrip({
  summary,
  timeSeries,
  loading,
  maxCards,
}: {
  summary: KpiSummary | null
  timeSeries: TimeSeriesPoint[]
  loading: boolean
  maxCards?: number
}) {
  const sentSeries = timeSeries.map(p => p.sent)
  const repliedSeries = timeSeries.map(p => p.replied)
  const posSeries = timeSeries.map(p => p.positive)
  const cards = summary ? buildKpiCards(summary, sentSeries, repliedSeries, posSeries) : null
  const visible = cards ? (maxCards ? cards.slice(0, maxCards) : cards) : []

  return (
    <div className="wr-kpi-strip">
      {loading || !cards
        ? Array.from({ length: maxCards ?? 12 }).map((_, i) => (
            <div key={i} className="wr-kpi-card">
              <WrSkeleton h={9} w={60} />
              <WrSkeleton h={28} w={50} />
              <WrSkeleton h={18} w={70} />
            </div>
          ))
        : visible.map(c => (
            <div key={c.label} className={cls('wr-kpi-card', c.tone && `is-${c.tone}`)}>
              <span className="wr-kpi-card__label">{c.label}</span>
              <strong className={cls('wr-kpi-card__value', c.tone && `is-${c.tone}`)} style={{ color: c.tone ? undefined : c.color }}>
                {c.value}
              </strong>
              <div className="wr-kpi-card__sub">
                {c.sub && <span>{c.sub}</span>}
                {c.trendPrev > 0 && <WrTrend current={c.trendCurrent} prev={c.trendPrev} />}
              </div>
              {c.series.length > 1 && (
                <div style={{ marginTop: 4 }}>
                  <WrMiniLine data={c.series} color={c.color} w={88} h={22} />
                </div>
              )}
            </div>
          ))}
    </div>
  )
}

// ── WrUsaMap ──────────────────────────────────────────────────────────────────

function WrUsaMap({
  states,
  selectedState,
  onStateClick,
  loading,
}: {
  states: StatePerformance[]
  selectedState: string | null
  onStateClick: (abbr: string) => void
  loading: boolean
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)

  const stateMap = useMemo(() => new Map(states.map(s => [s.state, s])), [states])
  const hovData = hovered ? stateMap.get(hovered) : null

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [])

  if (loading) {
    return (
      <div className="wr-panel wr-map-panel">
        <div className="wr-panel__header"><span className="wr-panel__title">Nationwide Performance Map</span></div>
        <div className="wr-panel__body"><WrSkeleton h={260} /></div>
      </div>
    )
  }

  return (
    <div className="wr-panel wr-map-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">NATIONWIDE PERFORMANCE MAP</span>
        {selectedState && (
          <button type="button" className="wr-map__clear" onClick={() => onStateClick('')}>
            {STATE_NAMES[selectedState] ?? selectedState} ✕
          </button>
        )}
      </div>
      <div className="wr-panel__body wr-map-body">
        <div className="wr-map__svg-wrap">
          <svg
            viewBox="0 0 960 600"
            className="wr-map__svg"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => { setHovered(null); setTip(null) }}
          >
            <defs>
              <pattern id="wr-map-grid" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="0.5" cy="0.5" r="0.8" fill="rgba(14,207,206,0.06)" />
              </pattern>
            </defs>
            <rect width="960" height="600" fill="#020814" />
            <rect width="960" height="600" fill="url(#wr-map-grid)" />
            {Object.entries(USA_STATE_PATHS).map(([abbr, sp]) => {
              const d = stateMap.get(abbr)
              const isSel = selectedState === abbr
              const isHov = hovered === abbr
              return (
                <g key={abbr}>
                  <path
                    d={sp.path}
                    fill={choroFill(d)}
                    className="wr-map__state"
                    vectorEffect="non-scaling-stroke"
                    style={{
                      opacity: isHov ? 0.85 : 1,
                      stroke: choroStroke(d, isSel, isHov),
                      strokeWidth: isSel ? 2.5 : isHov ? 1.8 : 1,
                    }}
                    onClick={() => onStateClick(isSel ? '' : abbr)}
                    onMouseEnter={() => setHovered(abbr)}
                  />
                  {abbr !== 'HI' && (
                    <text x={sp.cx} y={sp.cy} className="wr-map__state-label" style={{ fontSize: abbr === 'DC' ? 6 : 9 }}>
                      {abbr}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {hovData && tip && (
            <div
              className="wr-map__tooltip"
              style={{ left: Math.min(tip.x + 12, 560), top: Math.max(tip.y - 80, 8) }}
            >
              <strong>{STATE_NAMES[hovData.state] ?? hovData.state}</strong>
              {[
                ['Sent', fmt.int(hovData.sent)],
                ['Replies', fmt.int(hovData.replied)],
                ['Positive', String(hovData.positive)],
                ['Opt-Out', fmt.pct(hovData.optOutRate)],
                ['Top Market', hovData.topMarket],
                ['Action', hovData.recommendation],
              ].map(([k, v]) => (
                <div key={k} className="wr-map__tooltip-row">
                  <span>{k}</span><span>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="wr-map__legend">
          {[
            ['#0ed48a', 'Strong'],
            ['#0ecfce', 'Active'],
            ['#a855f7', 'Contracting'],
            ['#f5a623', 'Warning'],
            ['#e05252', 'Blocked'],
            ['rgba(80,140,220,0.5)', 'Quiet'],
          ].map(([c, label]) => (
            <span key={label} className="wr-map__legend-item">
              <i style={{ background: `${c}`, border: `1px solid ${c}` }} /> {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── WrFunnel ──────────────────────────────────────────────────────────────────

function WrFunnel({ stages, loading, compact = false }: { stages: FunnelStage[]; loading: boolean; compact?: boolean }) {
  // Split wired stages (have real data) from unwired pipeline stages (count=0, not an estimate).
  // Find the last stage index that has count > 0 or is an estimate derived from real data.
  const lastWiredIdx = useMemo(() => {
    let idx = -1
    stages.forEach((s, i) => { if (s.count > 0 || s.isEstimate) idx = i })
    return idx
  }, [stages])

  const wiredStages = lastWiredIdx >= 0 ? stages.slice(0, lastWiredIdx + 1) : stages
  const hasPendingStages = lastWiredIdx < stages.length - 1 && stages.length > 0

  const visibleWired = compact ? wiredStages.slice(0, 7) : wiredStages
  const maxCount = useMemo(() => Math.max(...wiredStages.map(s => s.count), 1), [wiredStages])

  if (loading) {
    return (
      <div className="wr-panel">
        <div className="wr-panel__header"><span className="wr-panel__title">Acquisition Funnel</span></div>
        <div className="wr-panel__body wr-funnel">
          {Array.from({ length: compact ? 6 : 8 }).map((_, i) => (
            <div key={i} className="wr-funnel__stage">
              <WrSkeleton h={9} w={90} /><WrSkeleton h={4} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Acquisition Funnel</span>
      </div>
      <div className="wr-panel__body wr-funnel">
        {visibleWired.map((stage, i) => {
          const widthPct = maxCount > 0 ? Math.max(2, Math.round((stage.count / maxCount) * 100)) : 2
          const barColor = i < 4 ? 'rgba(14,207,206,0.55)' : 'rgba(14,212,138,0.55)'
          return (
            <div key={stage.id} className="wr-funnel__stage">
              <div className="wr-funnel__stage-head">
                <span className="wr-funnel__label">{stage.label}</span>
                <span className="wr-funnel__count">{stage.count.toLocaleString()}{stage.isEstimate && <em> ~</em>}</span>
                {stage.conversionRate !== null && i > 0 && (
                  <span className={cls('wr-funnel__rate', stage.conversionRate < 50 && 'is-amber')}>{stage.conversionRate}%</span>
                )}
              </div>
              <div className="wr-funnel__track">
                <div className="wr-funnel__bar" style={{ width: `${widthPct}%`, background: barColor }} />
              </div>
            </div>
          )
        })}
        {hasPendingStages && (
          <div className="wr-funnel__pending-note">
            Offer / contract stages not yet wired.
          </div>
        )}
      </div>
    </div>
  )
}

// ── WrRevenue ─────────────────────────────────────────────────────────────────

function WrRevenue({ spend, offerMetrics, loading }: {
  spend: SpendPerformance | null
  offerMetrics: OfferContractMetrics | null
  loading: boolean
}) {
  const rows = offerMetrics
    ? [
        { label: 'Offers Created',  value: fmt.int(offerMetrics.offersCreated),   color: 'var(--wr-blue)' },
        { label: 'Offers Sent',     value: fmt.int(offerMetrics.offersSent),       color: 'var(--wr-blue)' },
        { label: 'Contracts Sent',  value: fmt.int(offerMetrics.contractsSent),    color: 'var(--wr-amber)' },
        { label: 'Fully Executed',  value: fmt.int(offerMetrics.fullyExecuted),    color: 'var(--wr-teal)' },
        { label: 'Closed',          value: fmt.int(offerMetrics.closed),           color: 'var(--wr-green)' },
        { label: 'Projected Rev.',  value: fmt.usd(offerMetrics.projectedRevenue), color: 'var(--wr-blue)' },
      ]
    : []

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Revenue Forecast</span>
        {spend && <span className="wr-panel__badge">{fmt.usd(spend.totalSpend)} spend</span>}
      </div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <WrSkeleton key={i} h={14} />)
        ) : !offerMetrics || !offerMetrics.isWired ? (
          <div className="wr-empty">Offer &amp; contract pipeline not wired yet.<br /><span style={{ fontSize: 9, opacity: 0.6 }}>Connect offers / contracts / closings tables.</span></div>
        ) : rows.length === 0 ? (
          <div className="wr-empty">No offer/contract activity in this period.</div>
        ) : (
          <div className="wr-revenue-rows">
            {rows.map(r => (
              <div key={r.label} className="wr-revenue-row">
                <span className="wr-revenue-row__label">{r.label}</span>
                <strong className="wr-revenue-row__val" style={{ color: r.color }}>{r.value}</strong>
              </div>
            ))}
          </div>
        )}
        {spend && !loading && (
          <div className="wr-spend-row" style={{ marginTop: 10 }}>
            <div className="wr-spend-item">
              <span className="wr-spend-item__label">Total Spend</span>
              <span className="wr-spend-item__value">{fmt.usd(spend.totalSpend)}</span>
            </div>
            <div className="wr-spend-item">
              <span className="wr-spend-item__label">Proj. ROI</span>
              <span className="wr-spend-item__value" style={{ color: 'var(--wr-green)' }}>
                {spend.projectedROI != null ? `${spend.projectedROI}x` : '—'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── WrAlerts ──────────────────────────────────────────────────────────────────

function WrAlerts({ alerts, loading }: { alerts: KpiAlert[]; loading: boolean }) {
  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Intelligence + Alerts</span>
        {alerts.length > 0 && <span className="wr-panel__badge" style={{ color: 'var(--wr-red)' }}>{alerts.length}</span>}
      </div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <WrSkeleton key={i} h={36} />)
        ) : alerts.length === 0 ? (
          <div className="wr-empty">No active alerts.</div>
        ) : (
          alerts.slice(0, 6).map((a, i) => (
            <div key={i} className={cls('wr-alert', a.severity === 'critical' ? 'wr-alert--critical' : a.severity === 'warning' ? 'wr-alert--warning' : 'wr-alert--info')}>
              <span className="wr-alert__msg">{a.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── WrLineChart ───────────────────────────────────────────────────────────────
// Full multi-line SVG area chart for messaging volume over time

function WrLineChart({ timeSeries, loading }: { timeSeries: TimeSeriesPoint[]; loading: boolean }) {
  const chartId = useId()
  const lineKeys: Array<{ key: keyof TimeSeriesPoint; label: string; color: string; gradId: string }> = [
    { key: 'sent',    label: 'Sent',     color: 'rgba(14,207,206,0.9)',  gradId: `wrlc-sent-${chartId.replace(/:/g,'')}` },
    { key: 'replied', label: 'Replies',  color: 'rgba(14,212,138,0.9)',  gradId: `wrlc-rep-${chartId.replace(/:/g,'')}` },
    { key: 'positive',label: 'Positive', color: 'rgba(168,85,247,0.9)',  gradId: `wrlc-pos-${chartId.replace(/:/g,'')}` },
    { key: 'optOut',  label: 'Opt-Out',  color: 'rgba(224,82,82,0.85)', gradId: `wrlc-opt-${chartId.replace(/:/g,'')}` },
  ]

  if (loading) {
    return (
      <div className="wr-panel">
        <div className="wr-panel__header"><span className="wr-panel__title">Messaging Volume Over Time</span></div>
        <div className="wr-panel__body"><WrSkeleton h={140} /></div>
      </div>
    )
  }

  const hasData = timeSeries.length > 1

  // Build paths
  const W = 800, H = 160
  const padL = 38, padR = 12, padT = 8, padB = 24
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const allVals = hasData
    ? timeSeries.flatMap(p => lineKeys.map(lk => p[lk.key] as number))
    : [0]
  const maxVal = Math.max(...allVals, 1)

  const xOf = (i: number) => padL + (i / Math.max(timeSeries.length - 1, 1)) * plotW
  const yOf = (v: number) => padT + plotH - (v / maxVal) * plotH

  const buildPath = (key: keyof TimeSeriesPoint) => {
    if (!hasData) return ''
    return timeSeries
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p[key] as number).toFixed(1)}`)
      .join(' ')
  }

  const buildFill = (key: keyof TimeSeriesPoint) => {
    if (!hasData) return ''
    const lastI = timeSeries.length - 1
    return (
      `M${padL.toFixed(1)},${(padT + plotH).toFixed(1)} ` +
      timeSeries.map((p, i) => `L${xOf(i).toFixed(1)},${yOf(p[key] as number).toFixed(1)}`).join(' ') +
      ` L${xOf(lastI).toFixed(1)},${(padT + plotH).toFixed(1)} Z`
    )
  }

  // Y axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    y: padT + plotH - f * plotH,
    label: f === 0 ? '0' : f === 1 ? fmt.int(Math.round(maxVal)) : fmt.int(Math.round(maxVal * f)),
  }))

  // X axis dates (show up to 6 labels)
  const xTickIndices: number[] = []
  if (hasData) {
    const step = Math.max(1, Math.floor(timeSeries.length / 6))
    for (let i = 0; i < timeSeries.length; i += step) xTickIndices.push(i)
    if (xTickIndices[xTickIndices.length - 1] !== timeSeries.length - 1)
      xTickIndices.push(timeSeries.length - 1)
  }

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Messaging Volume Over Time</span>
        <div className="wr-linechart-legend">
          {lineKeys.map(lk => (
            <span key={lk.key} className="wr-linechart-legend__item">
              <i style={{ background: lk.color }} />
              {lk.label}
            </span>
          ))}
        </div>
        {hasData && (
          <span className="wr-panel__badge">
            {timeSeries[0]?.date?.slice(5)} – {timeSeries[timeSeries.length - 1]?.date?.slice(5)}
          </span>
        )}
      </div>
      <div className="wr-panel__body wr-linechart-body">
        {!hasData ? (
          <div className="wr-empty">No time-series data for this period.</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="wr-linechart-svg" preserveAspectRatio="none">
            <defs>
              {lineKeys.map(lk => (
                <linearGradient key={lk.gradId} id={lk.gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lk.color} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={lk.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>

            {/* Grid lines */}
            {yTicks.map(t => (
              <line key={t.y} x1={padL} y1={t.y} x2={W - padR} y2={t.y}
                stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            ))}

            {/* Y axis labels */}
            {yTicks.map(t => (
              <text key={t.y} x={padL - 4} y={t.y + 3} textAnchor="end"
                fill="rgba(160,190,240,0.45)" fontSize="8" fontFamily="inherit">{t.label}</text>
            ))}

            {/* X axis labels */}
            {xTickIndices.map(i => (
              <text key={i} x={xOf(i)} y={H - 4} textAnchor="middle"
                fill="rgba(160,190,240,0.45)" fontSize="8" fontFamily="inherit">
                {timeSeries[i]?.date?.slice(5) ?? ''}
              </text>
            ))}

            {/* Area fills (rendered first, behind lines) */}
            {lineKeys.map(lk => (
              <path key={`fill-${String(lk.key)}`} d={buildFill(lk.key)} fill={`url(#${lk.gradId})`} stroke="none" />
            ))}

            {/* Lines */}
            {lineKeys.map(lk => (
              <path
                key={`line-${String(lk.key)}`}
                d={buildPath(lk.key)}
                fill="none"
                stroke={lk.color}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ filter: `drop-shadow(0 0 3px ${lk.color}66)` }}
              />
            ))}

            {/* Dot on last point */}
            {lineKeys.map(lk => {
              const last = timeSeries[timeSeries.length - 1]
              return (
                <circle
                  key={`dot-${String(lk.key)}`}
                  cx={xOf(timeSeries.length - 1)}
                  cy={yOf(last[lk.key] as number)}
                  r="2.5"
                  fill="#fff"
                  stroke={lk.color}
                  strokeWidth="1.2"
                />
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}

// ── WrChannelPerf ─────────────────────────────────────────────────────────────

function WrChannelPerf({ channels, loading }: { channels: ChannelPerformance[]; loading: boolean }) {
  return (
    <div className="wr-panel">
      <div className="wr-panel__header"><span className="wr-panel__title">Channel Performance</span></div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <WrSkeleton key={i} h={20} />)
        ) : !channels.length ? (
          <div className="wr-empty">No channel data for this period.</div>
        ) : (
          <div className="wr-channel-table">
            <div className="wr-channel-header">
              <span>Channel</span><span>Sent</span><span>Del%</span><span>Reply%</span><span>Pos%</span><span>Opt%</span><span>$/Reply</span>
            </div>
            {channels.map(ch => (
              <div key={ch.channel} className="wr-channel-row">
                <span className="wr-channel-name">{ch.channel.toUpperCase()}</span>
                <span>{fmt.int(ch.sent)}</span>
                <span>{fmt.pct(ch.deliveryRate)}</span>
                <span style={{ color: 'var(--wr-teal)' }}>{fmt.pct(ch.replyRate)}</span>
                <span style={{ color: 'var(--wr-green)' }}>{fmt.pct(ch.positiveRate)}</span>
                <span style={{ color: ch.sent > 0 && (ch.optOut / ch.sent * 100) > 2 ? 'var(--wr-amber)' : 'inherit' }}>
                  {ch.sent > 0 ? `${(ch.optOut / ch.sent * 100).toFixed(1)}%` : '—'}
                </span>
                <span style={{ color: 'var(--wr-muted)' }}>{fmt.usd(ch.costPerReply)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── WrLeaderboard ─────────────────────────────────────────────────────────────

type LbRow = { key: string; label: string; sent: number; replies: number; positive: number; optOutRate: number }

function WrLeaderboard({
  title,
  rows,
  loading,
  maxRows = 8,
  emptyMessage,
}: {
  title: string
  rows: LbRow[]
  loading: boolean
  maxRows?: number
  emptyMessage?: string
}) {
  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">{title}</span>
        {rows.length > 0 && !loading && <span className="wr-panel__badge">{rows.length}</span>}
      </div>
      <div className="wr-panel__body" style={{ padding: '0' }}>
        {loading ? (
          <div style={{ padding: '8px 12px' }}>
            {Array.from({ length: 4 }).map((_, i) => <WrSkeleton key={i} h={14} />)}
          </div>
        ) : !rows.length ? (
          <div className="wr-lb__empty">{emptyMessage ?? 'No data for this period.'}</div>
        ) : (
          rows.slice(0, maxRows).map((r, i) => (
            <div key={r.key} className="wr-lb__row">
              <span className="wr-lb__rank">{i + 1}</span>
              <span className="wr-lb__name">{r.label}</span>
              <span className="wr-lb__val">{fmt.int(r.sent)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── WrCarrierIntel ────────────────────────────────────────────────────────────

function WrCarrierIntel({ carriers, loading }: { carriers: CarrierPerformance[]; loading: boolean }) {
  const maxSent = useMemo(() => Math.max(...carriers.map(c => c.sent), 1), [carriers])
  return (
    <div className="wr-panel">
      <div className="wr-panel__header"><span className="wr-panel__title">Carrier Intelligence</span></div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <WrSkeleton key={i} h={18} />)
        ) : !carriers.length ? (
          <div className="wr-empty">Carrier data not available.<br />
            <span style={{ fontSize: 9, opacity: 0.6 }}>Populate <code>carrier_name</code> in <code>message_events</code> to enable.</span>
          </div>
        ) : (
          carriers.map(c => (
            <div key={c.carrier} className="wr-carrier-row">
              <span className="wr-carrier-row__name">{c.carrier}</span>
              <div className="wr-carrier-row__bar-wrap">
                <div
                  className="wr-carrier-row__bar"
                  style={{ width: `${Math.round((c.sent / maxSent) * 100)}%` }}
                />
              </div>
              <span className="wr-carrier-row__del" style={{ color: c.deliveryRate > 90 ? 'var(--wr-green)' : c.deliveryRate > 75 ? 'var(--wr-amber)' : 'var(--wr-red)' }}>
                {fmt.pct(c.deliveryRate)}
              </span>
              <span className="wr-carrier-row__opt" style={{ color: c.optOutRate > 3 ? 'var(--wr-red)' : 'var(--wr-muted)' }}>
                {fmt.pct(c.optOutRate)} opt
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── WrNumbersHealth ───────────────────────────────────────────────────────────

function WrNumbersHealth({ numbers, loading }: { numbers: TextgridNumberHealth[]; loading: boolean }) {
  const totalActive   = numbers.filter(n => n.isActive).length
  const totalHealthy  = numbers.filter(n => n.recommendation === 'Healthy').length
  const totalWarning  = numbers.filter(n => n.recommendation === 'Watch' || n.recommendation === 'Throttle').length
  const totalCritical = numbers.filter(n => n.recommendation === 'Pause' || n.recommendation === 'Replace').length

  const cardStatus = (n: TextgridNumberHealth) =>
    n.recommendation === 'Healthy' ? 'healthy' :
    n.recommendation === 'Watch' || n.recommendation === 'Throttle' ? 'warning' : 'critical'

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">TextGrid Numbers Health</span>
        <span className="wr-panel__badge" style={{ color: totalCritical > 0 ? 'var(--wr-red)' : 'var(--wr-green)' }}>
          {totalActive} active
        </span>
      </div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <WrSkeleton key={i} h={16} />)
        ) : !numbers.length ? (
          <div className="wr-empty">No TextGrid numbers configured.<br />
            <span style={{ fontSize: 9, opacity: 0.6 }}>Check the <code>textgrid_numbers</code> table.</span>
          </div>
        ) : (
          <>
            <div className="wr-numbers-summary">
              <div className="wr-numbers-summary__item">
                <strong style={{ color: 'var(--wr-green)' }}>{totalHealthy}</strong>
                <span>Healthy</span>
              </div>
              <div className="wr-numbers-summary__item">
                <strong style={{ color: 'var(--wr-amber)' }}>{totalWarning}</strong>
                <span>Watch</span>
              </div>
              <div className="wr-numbers-summary__item">
                <strong style={{ color: 'var(--wr-red)' }}>{totalCritical}</strong>
                <span>Critical</span>
              </div>
              <div className="wr-numbers-summary__item">
                <strong style={{ color: 'var(--wr-muted)' }}>{numbers.length}</strong>
                <span>Total</span>
              </div>
            </div>
            <div className="wr-numbers-grid">
              {numbers.slice(0, 12).map(n => {
                const s = cardStatus(n)
                return (
                  <div key={n.phoneNumber} className={cls('wr-number-card', `wr-number-card--${s}`)}>
                    <span className="wr-number-card__num">{n.phoneNumber}</span>
                    <span className="wr-number-card__label">{n.market}</span>
                    <span className={cls('wr-number-card__stat', s === 'healthy' ? 'ok' : s === 'warning' ? 'warn' : 'bad')}>
                      {fmt.int(n.sentToday)} sent · {fmt.pct(n.deliveryRate)} del · {fmt.pct(n.optOutRate)} opt
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── WrDataQuality ─────────────────────────────────────────────────────────────

function WrDataQuality({ quality, loading }: { quality: DataQualityMetrics | null; loading: boolean }) {
  const score = quality?.healthScore ?? 0
  const scoreColor = score > 75 ? 'var(--wr-green)' : score > 50 ? 'var(--wr-amber)' : 'var(--wr-red)'
  const r = 28, cx = 36, cy = 36, circ = 2 * Math.PI * r
  const dash = (score / 100) * circ

  return (
    <div className="wr-panel">
      <div className="wr-panel__header"><span className="wr-panel__title">Data + Automation Health</span></div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <WrSkeleton key={i} h={14} />)
        ) : !quality ? (
          <div className="wr-empty">No quality data.</div>
        ) : (
          <div className="wr-quality-layout">
            <div className="wr-gauge-cluster">
              <div className="wr-gauge">
                <svg className="wr-gauge__svg" viewBox="0 0 72 72">
                  <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
                  <circle
                    cx={cx} cy={cy} r={r}
                    fill="none"
                    stroke={scoreColor}
                    strokeWidth="5"
                    strokeDasharray={`${dash} ${circ}`}
                    strokeLinecap="round"
                    transform={`rotate(-90 ${cx} ${cy})`}
                    style={{ filter: `drop-shadow(0 0 4px ${scoreColor}80)` }}
                  />
                  <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill={scoreColor} fontSize="14" fontWeight="800">{score}</text>
                </svg>
                <span className="wr-gauge__label">Health</span>
              </div>
            </div>
            <div className="wr-quality-rows">
              {[
                ['Failed Queue',    quality.failedQueueRows,    'wr-red'],
                ['Blank Body',      quality.blankBody,          'wr-amber'],
                ['Routing Blocked', quality.routingBlocked,     'wr-amber'],
                ['Wrong Number',    quality.wrongNumber,        'wr-red'],
                ['DNC Count',       quality.dncCount,           'wr-red'],
                ['Missing Phone',   quality.missingPhone,       'wr-amber'],
                ['Manual Review',   quality.manualReviewCount,  ''],
                ['Auto Blocked',    quality.autoReplyBlocked,   'wr-red'],
              ].filter(([, v]) => (v as number) != null).map(([label, val, tone]) => (
                <div key={label as string} className="wr-quality-row">
                  <span className="wr-quality-row__label">{label as string}</span>
                  <strong className="wr-quality-row__val" style={{ color: (val as number) > 0 && tone ? `var(--${tone as string})` : 'var(--wr-muted)' }}>
                    {fmt.int(val as number)}
                  </strong>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── WrBuyerDemand ─────────────────────────────────────────────────────────────

function WrBuyerDemand({ metrics, loading }: { metrics: BuyerDemandMetrics | null; loading: boolean }) {
  const confidence = metrics?.avgConfidence ?? 0
  const scoreColor = confidence > 66 ? 'var(--wr-green)' : confidence > 33 ? 'var(--wr-amber)' : 'var(--wr-red)'
  const r = 28, cx = 36, cy = 36, circ = 2 * Math.PI * r
  const dash = (confidence / 100) * circ

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Buyer Demand</span>
        {metrics && (
          <span className="wr-panel__badge" style={{ color: scoreColor }}>
            {metrics.totalMatches} matches
          </span>
        )}
      </div>
      <div className="wr-panel__body">
        {loading ? (
          <WrSkeleton h={80} />
        ) : !metrics || !metrics.isWired ? (
          <div className="wr-empty">Buyer match data not wired yet.<br />
            <span style={{ fontSize: 9, opacity: 0.6 }}>Connect buyer_matches / buyer_criteria tables.</span>
          </div>
        ) : (
          <div className="wr-buyer-layout">
            <div className="wr-gauge-cluster">
              <div className="wr-gauge">
                <svg className="wr-gauge__svg" viewBox="0 0 72 72">
                  <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
                  <circle
                    cx={cx} cy={cy} r={r}
                    fill="none" stroke={scoreColor} strokeWidth="5"
                    strokeDasharray={`${dash} ${circ}`}
                    strokeLinecap="round"
                    transform={`rotate(-90 ${cx} ${cy})`}
                    style={{ filter: `drop-shadow(0 0 4px ${scoreColor}80)` }}
                  />
                  <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill={scoreColor} fontSize="12" fontWeight="800">
                    {Math.round(confidence)}
                  </text>
                </svg>
                <span className="wr-gauge__label">Confidence</span>
              </div>
            </div>
            <div className="wr-buyer-breakdown">
              <div className="wr-buyer-row">
                <span className="wr-buyer-row__dot" style={{ background: 'var(--wr-green)' }} />
                <span className="wr-buyer-row__label">Total Matches</span>
                <strong className="wr-buyer-row__val" style={{ color: 'var(--wr-green)' }}>{fmt.int(metrics.totalMatches)}</strong>
              </div>
              <div className="wr-buyer-row">
                <span className="wr-buyer-row__dot" style={{ background: 'var(--wr-teal)' }} />
                <span className="wr-buyer-row__label">Assigned</span>
                <strong className="wr-buyer-row__val" style={{ color: 'var(--wr-teal)' }}>{fmt.int(metrics.assignedCount)}</strong>
              </div>
              <div className="wr-buyer-row">
                <span className="wr-buyer-row__dot" style={{ background: 'var(--wr-amber)' }} />
                <span className="wr-buyer-row__label">Response Rate</span>
                <strong className="wr-buyer-row__val" style={{ color: 'var(--wr-amber)' }}>
                  {metrics.buyerResponseRate != null ? fmt.pct(metrics.buyerResponseRate) : '—'}
                </strong>
              </div>
              {metrics.topMarkets.slice(0, 3).map(m => (
                <div key={m.market} className="wr-buyer-row">
                  <span className="wr-buyer-row__dot" style={{ background: 'var(--wr-purple)' }} />
                  <span className="wr-buyer-row__label">{m.market}</span>
                  <strong className="wr-buyer-row__val" style={{ color: 'var(--wr-purple)' }}>{m.matches}</strong>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── useMetricsData hook ───────────────────────────────────────────────────────

function useMetricsData(filters: KpiFilters, layoutMode: ViewLayoutMode, paused = false) {
  const [summary,      setSummary]      = useState<KpiSummary | null>(null)
  const [timeSeries,   setTimeSeries]   = useState<TimeSeriesPoint[]>([])
  const [statePerf,    setStatePerf]    = useState<StatePerformance[]>([])
  const [marketPerf,   setMarketPerf]   = useState<MarketPerformance[]>([])
  const [agentPerf,    setAgentPerf]    = useState<AgentPerformance[]>([])
  const [templatePerf, setTemplatePerf] = useState<TemplatePerformance[]>([])
  const [channelPerf,  setChannelPerf]  = useState<ChannelPerformance[]>([])
  const [spend,        setSpend]        = useState<SpendPerformance | null>(null)
  const [funnel,       setFunnel]       = useState<FunnelStage[]>([])
  const [dataQuality,  setDataQuality]  = useState<DataQualityMetrics | null>(null)
  const [buyerMetrics, setBuyerMetrics] = useState<BuyerDemandMetrics | null>(null)
  const [offerMetrics, setOfferMetrics] = useState<OfferContractMetrics | null>(null)
  const [numberHealth, setNumberHealth] = useState<TextgridNumberHealth[]>([])
  const [carrierPerf,  setCarrierPerf]  = useState<CarrierPerformance[]>([])
  const [alerts,       setAlerts]       = useState<KpiAlert[]>([])
  const [loading,      setLoading]      = useState(true)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // mode is passed as an argument so the callback stays stable (no dep re-creation).
  const load = useCallback(async (f: KpiFilters, mode: ViewLayoutMode) => {
    if (paused) {
       if (import.meta.env.DEV) console.log('[HeavyPanelLoadSkipped] MetricsWarRoom: paused')
       return
    }
    setLoading(true)
    try {
      if (mode === 'compact') {
        // Compact rail only renders: summary, timeSeries. Skip statePerf and all of Batch 2.
        const [sumRes, tsRes] = await Promise.all([
          loadKpiDashboardSummary(f),
          loadKpiTimeSeries(f),
        ])
        setSummary(sumRes)
        setTimeSeries(tsRes)
        setLoading(false)
        return
      }

      const [sumRes, tsRes, stateRes] = await Promise.all([
        loadKpiDashboardSummary(f),
        loadKpiTimeSeries(f),
        loadStatePerformance(f),
      ])
      setSummary(sumRes)
      setTimeSeries(tsRes)
      setStatePerf(stateRes)
      setLoading(false)

      const [mktRes, agentRes, tplRes, chRes, spendRes, funnelRes, qualRes, buyerRes, offerRes, numRes, carrierRes] =
        await Promise.all([
          loadMarketPerformance(f),
          loadAgentPerformance(f),
          loadTemplatePerformance(f),
          loadChannelPerformance(f),
          loadSpendPerformance(f, sumRes),
          loadFunnelPerformance(f),
          loadDataQualityMetrics(f),
          loadBuyerDemandMetrics(f),
          loadOfferContractMetrics(f),
          loadTextgridNumberHealth(f),
          loadCarrierPerformance(f),
        ])

      const alertPrefetch: KpiAlertsInput = {
        states: stateRes,
        templates: tplRes,
        numbers: numRes,
        quality: qualRes,
      }
      const alertRes = await loadKpiAlerts(f, alertPrefetch)
      setMarketPerf(mktRes)
      setAgentPerf(agentRes)
      setTemplatePerf(tplRes)
      setChannelPerf(chRes)
      setSpend(spendRes)
      setFunnel(funnelRes)
      setDataQuality(qualRes)
      setBuyerMetrics(buyerRes)
      setOfferMetrics(offerRes)
      setNumberHealth(numRes)
      setCarrierPerf(carrierRes)
      setAlerts(alertRes)
    } catch {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(filters, layoutMode), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.timeRange, filters.state, filters.market, layoutMode, paused])

  const stateLbRows: LbRow[] = statePerf.map(s => ({
    key: s.state,
    label: `${STATE_NAMES[s.state] ?? s.state} (${s.state})`,
    sent: s.sent,
    replies: s.replied,
    positive: s.positive,
    optOutRate: s.optOutRate,
  }))

  const marketLbRows: LbRow[] = marketPerf.map(m => ({
    key: m.market,
    label: m.market,
    sent: m.sent,
    replies: m.sent > 0 ? Math.round(m.sent * (m.replyRate / 100)) : 0,
    positive: m.sent > 0 ? Math.round(m.sent * (m.positiveRate / 100)) : 0,
    optOutRate: m.optOutRate,
  }))

  const agentLbRows: LbRow[] = agentPerf.map(a => ({
    key: a.agentId,
    label: a.agentName || a.agentId,
    sent: a.sent,
    replies: a.replied,
    positive: a.positive,
    optOutRate: a.optOutRate,
  }))

  const templateLbRows: LbRow[] = templatePerf.map(t => ({
    key: t.templateId,
    label: t.preview ? t.preview.slice(0, 32) : t.templateId,
    sent: t.sent,
    replies: t.replied,
    positive: t.positive,
    optOutRate: t.stopRate,
  }))

  return {
    summary, timeSeries, statePerf, marketPerf, agentPerf, templatePerf,
    channelPerf, spend, funnel, dataQuality, buyerMetrics, offerMetrics,
    numberHealth, carrierPerf, alerts, loading,
    stateLbRows, marketLbRows, agentLbRows, templateLbRows,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MetricsRail25 — 25% compact KPI command rail
// ════════════════════════════════════════════════════════════════════════════

export function MetricsRail25({
  summary,
  timeSeries,
  alerts,
  loading,
}: {
  summary: KpiSummary | null
  timeSeries: TimeSeriesPoint[]
  alerts: KpiAlert[]
  loading: boolean
}) {
  const sentSeries = timeSeries.map(p => p.sent)
  const repliedSeries = timeSeries.map(p => p.replied)
  const posSeries = timeSeries.map(p => p.positive)
  const cards = summary ? buildKpiCards(summary, sentSeries, repliedSeries, posSeries) : null
  const railCards = [0, 1, 2, 3, 4, 6, 7, 9, 10, 11]

  return (
    <div className="wr wr--rail">
      <div className="wr-rail__header">
        <span className="wr-rail__title">KPI COMMAND</span>
      </div>
      <div className="wr-rail__scroll">
        {alerts.slice(0, 1).map((a, i) => (
          <div key={i} className={cls('wr-alert', a.severity === 'critical' ? 'wr-alert--critical' : a.severity === 'warning' ? 'wr-alert--warning' : 'wr-alert--info')} style={{ margin: '6px 8px 0', fontSize: 10 }}>
            <span className="wr-alert__msg">{a.message.slice(0, 55)}{a.message.length > 55 && '…'}</span>
          </div>
        ))}
        {loading || !cards
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="wr-rail__kpi">
                <WrSkeleton h={9} w={60} />
                <WrSkeleton h={20} w={44} />
              </div>
            ))
          : railCards.map(idx => {
              const c = cards[idx]
              return (
                <div key={c.label} className={cls('wr-rail__kpi', c.tone && `is-${c.tone}`)}>
                  <span className="wr-rail__kpi-label">{c.label}</span>
                  <div className="wr-rail__kpi-row">
                    <strong className="wr-rail__kpi-value" style={{ color: c.tone ? undefined : c.color }}>
                      {c.value}
                    </strong>
                    {c.series.length > 1 && <WrMiniLine data={c.series} color={c.color} w={44} h={18} />}
                    {c.trendPrev > 0 && <WrTrend current={c.trendCurrent} prev={c.trendPrev} />}
                  </div>
                  {c.sub && <span className="wr-rail__kpi-sub">{c.sub}</span>}
                </div>
              )
            })}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// MetricsCockpit50 — 50% compact cockpit, no map
// ════════════════════════════════════════════════════════════════════════════

export function MetricsCockpit50({
  summary,
  timeSeries,
  funnel,
  statePerf,
  templateLbRows,
  spend,
  offerMetrics,
  dataQuality,
  alerts,
  filters,
  onFilterChange,
  loading,
}: {
  summary: KpiSummary | null
  timeSeries: TimeSeriesPoint[]
  funnel: FunnelStage[]
  statePerf: StatePerformance[]
  templateLbRows: LbRow[]
  spend: SpendPerformance | null
  offerMetrics: OfferContractMetrics | null
  dataQuality: DataQualityMetrics | null
  alerts: KpiAlert[]
  filters: KpiFilters
  onFilterChange: (p: Partial<KpiFilters>) => void
  loading: boolean
}) {
  const stateLbRows: LbRow[] = statePerf.map(s => ({
    key: s.state,
    label: STATE_NAMES[s.state] ?? s.state,
    sent: s.sent,
    replies: s.replied,
    positive: s.positive,
    optOutRate: s.optOutRate,
  }))

  return (
    <div className="wr wr--cockpit">
      <WrFilterBar filters={filters} onChange={onFilterChange} loading={loading} selectedState={null} onClearState={() => {}} widthMode="50" />
      <WrKpiStrip summary={summary} timeSeries={timeSeries} loading={loading} maxCards={8} />
      <div className="wr-scroll">
        <div className="wr-cockpit-grid">
          <WrFunnel stages={funnel} loading={loading} compact />
          <WrRevenue spend={spend} offerMetrics={offerMetrics} loading={loading} />
        </div>
        <div style={{ padding: '0 18px 4px' }}>
          <WrLineChart timeSeries={timeSeries} loading={loading} />
        </div>
        <div className="wr-cockpit-grid">
          <WrLeaderboard title="Template Leaderboard" rows={templateLbRows} loading={loading} maxRows={5} emptyMessage="No template sends in this period." />
          <WrLeaderboard title="State Leaderboard" rows={stateLbRows} loading={loading} maxRows={5} emptyMessage="No state-level data in this period." />
        </div>
        {alerts.length > 0 && (
          <div style={{ padding: '0 18px 4px' }}>
            <WrAlerts alerts={alerts} loading={loading} />
          </div>
        )}
        <div style={{ padding: '0 18px 4px' }}>
          <WrDataQuality quality={dataQuality} loading={loading} />
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// MetricsCommand75 — 75% command dashboard with map
// ════════════════════════════════════════════════════════════════════════════

export function MetricsCommand75({
  summary,
  timeSeries,
  statePerf,
  channelPerf,
  funnel,
  numberHealth,
  carrierPerf,
  alerts,
  filters,
  onFilterChange,
  selectedState,
  onStateClick,
  loading,
  stateLbRows,
  marketLbRows,
  agentLbRows,
  templateLbRows,
}: {
  summary: KpiSummary | null
  timeSeries: TimeSeriesPoint[]
  statePerf: StatePerformance[]
  channelPerf: ChannelPerformance[]
  funnel: FunnelStage[]
  numberHealth: TextgridNumberHealth[]
  carrierPerf: CarrierPerformance[]
  alerts: KpiAlert[]
  filters: KpiFilters
  onFilterChange: (p: Partial<KpiFilters>) => void
  selectedState: string | null
  onStateClick: (abbr: string) => void
  loading: boolean
  stateLbRows: LbRow[]
  marketLbRows: LbRow[]
  agentLbRows: LbRow[]
  templateLbRows: LbRow[]
}) {
  return (
    <div className="wr wr--command">
      <WrFilterBar filters={filters} onChange={onFilterChange} loading={loading} selectedState={selectedState} onClearState={() => onStateClick('')} widthMode="75" />
      <WrKpiStrip summary={summary} timeSeries={timeSeries} loading={loading} />
      <div className="wr-scroll">
        <div className="wr-command-above">
          <WrUsaMap states={statePerf} selectedState={selectedState} onStateClick={onStateClick} loading={loading} />
          <WrFunnel stages={funnel} loading={loading} />
        </div>
        <div style={{ padding: '0 18px 4px' }}>
          <WrLineChart timeSeries={timeSeries} loading={loading} />
        </div>
        <div className="wr-command-lbs">
          <WrLeaderboard title="State" rows={stateLbRows} loading={loading} maxRows={6} emptyMessage="No state-level data in this period." />
          <WrLeaderboard title="Market" rows={marketLbRows} loading={loading} maxRows={6} emptyMessage="No market data in this period." />
          <WrLeaderboard title="Agent" rows={agentLbRows} loading={loading} maxRows={6} emptyMessage="No agent activity in this period." />
          <WrLeaderboard title="Template" rows={templateLbRows} loading={loading} maxRows={6} emptyMessage="No template sends in this period." />
        </div>
        <div style={{ padding: '0 18px 4px' }}>
          <WrChannelPerf channels={channelPerf} loading={loading} />
        </div>
        <div className="wr-command-bottom">
          <WrCarrierIntel carriers={carrierPerf} loading={loading} />
          <WrNumbersHealth numbers={numberHealth} loading={loading} />
        </div>
        {alerts.length > 0 && (
          <div style={{ padding: '0 18px 4px' }}>
            <WrAlerts alerts={alerts} loading={loading} />
          </div>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// MetricsWarRoom100 — 100% full war room
// ════════════════════════════════════════════════════════════════════════════

export function MetricsWarRoom100({
  summary,
  timeSeries,
  statePerf,
  channelPerf,
  funnel,
  spend,
  offerMetrics,
  buyerMetrics,
  dataQuality,
  numberHealth,
  carrierPerf,
  alerts,
  filters,
  onFilterChange,
  selectedState,
  onStateClick,
  loading,
  stateLbRows,
  marketLbRows,
  agentLbRows,
  templateLbRows,
}: {
  summary: KpiSummary | null
  timeSeries: TimeSeriesPoint[]
  statePerf: StatePerformance[]
  channelPerf: ChannelPerformance[]
  funnel: FunnelStage[]
  spend: SpendPerformance | null
  offerMetrics: OfferContractMetrics | null
  buyerMetrics: BuyerDemandMetrics | null
  dataQuality: DataQualityMetrics | null
  numberHealth: TextgridNumberHealth[]
  carrierPerf: CarrierPerformance[]
  alerts: KpiAlert[]
  filters: KpiFilters
  onFilterChange: (p: Partial<KpiFilters>) => void
  selectedState: string | null
  onStateClick: (abbr: string) => void
  loading: boolean
  stateLbRows: LbRow[]
  marketLbRows: LbRow[]
  agentLbRows: LbRow[]
  templateLbRows: LbRow[]
}) {
  return (
    <div className="wr wr--warroom">
      <WrFilterBar filters={filters} onChange={onFilterChange} loading={loading} selectedState={selectedState} onClearState={() => onStateClick('')} widthMode="100" />
      <WrKpiStrip summary={summary} timeSeries={timeSeries} loading={loading} />
      <div className="wr-scroll">
        {/* Row 1: Map 40% + Funnel+Revenue 35% + Alerts+Spend 25% */}
        <div className="wr-section-label">PERFORMANCE OVERVIEW</div>
        <div className="wr-warroom-row1">
          <WrUsaMap states={statePerf} selectedState={selectedState} onStateClick={onStateClick} loading={loading} />
          <WrFunnel stages={funnel} loading={loading} />
          <div className="wr-warroom-right-col">
            <WrAlerts alerts={alerts} loading={loading} />
            <WrRevenue spend={spend} offerMetrics={offerMetrics} loading={loading} />
          </div>
        </div>

        {/* Row 2: Line Chart + Channel Perf */}
        <div className="wr-section-label">MESSAGING INTELLIGENCE</div>
        <div className="wr-warroom-row2">
          <WrLineChart timeSeries={timeSeries} loading={loading} />
          <WrChannelPerf channels={channelPerf} loading={loading} />
        </div>

        {/* Row 3: Leaderboards + Buyer Demand */}
        <div className="wr-section-label">LEADERBOARDS</div>
        <div className="wr-warroom-lbs">
          <WrLeaderboard title="State" rows={stateLbRows} loading={loading} emptyMessage="No state-level data in this period." />
          <WrLeaderboard title="Market" rows={marketLbRows} loading={loading} emptyMessage="No market data in this period." />
          <WrLeaderboard title="Agent" rows={agentLbRows} loading={loading} emptyMessage="No agent activity in this period." />
          <WrLeaderboard title="Template" rows={templateLbRows} loading={loading} emptyMessage="No template sends in this period." />
          <WrBuyerDemand metrics={buyerMetrics} loading={loading} />
        </div>

        {/* Row 4: Carrier + Numbers + Quality */}
        <div className="wr-section-label">INFRASTRUCTURE + DEMAND</div>
        <div className="wr-warroom-row4">
          <WrCarrierIntel carriers={carrierPerf} loading={loading} />
          <WrNumbersHealth numbers={numberHealth} loading={loading} />
          <WrDataQuality quality={dataQuality} loading={loading} />
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// MetricsWarRoom — main orchestrator
// ════════════════════════════════════════════════════════════════════════════

interface MetricsWarRoomProps {
  layoutMode: ViewLayoutMode
  paneWidth: ViewWidthPercent
  paused?: boolean
}

export function MetricsWarRoom({ layoutMode, paused = false }: MetricsWarRoomProps) {
  const [filters, setFilters] = useState<KpiFilters>({ timeRange: 'last_7_days', channel: 'all' })
  const [selectedState, setSelectedState] = useState<string | null>(null)

  const activeFilters = useMemo(
    () => ({ ...filters, state: selectedState ?? undefined }),
    [filters, selectedState]
  )

  const data = useMetricsData(activeFilters, layoutMode, paused)

  const handleFilterChange = useCallback((patch: Partial<KpiFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }))
  }, [])

  const handleStateClick = useCallback((abbr: string) => {
    setSelectedState(abbr || null)
  }, [])

  return (
    <div style={{ position: 'relative', flex: '1 1 0', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {layoutMode === 'compact' && (
        <MetricsRail25
          summary={data.summary}
          timeSeries={data.timeSeries}
          alerts={data.alerts}
          loading={data.loading}
        />
      )}

      {layoutMode === 'medium' && (
        <MetricsCockpit50
          summary={data.summary}
          timeSeries={data.timeSeries}
          funnel={data.funnel}
          statePerf={data.statePerf}
          templateLbRows={data.templateLbRows}
          spend={data.spend}
          offerMetrics={data.offerMetrics}
          dataQuality={data.dataQuality}
          alerts={data.alerts}
          filters={filters}
          onFilterChange={handleFilterChange}
          loading={data.loading}
        />
      )}

      {layoutMode === 'expanded' && (
        <MetricsCommand75
          summary={data.summary}
          timeSeries={data.timeSeries}
          statePerf={data.statePerf}
          channelPerf={data.channelPerf}
          funnel={data.funnel}
          numberHealth={data.numberHealth}
          carrierPerf={data.carrierPerf}
          alerts={data.alerts}
          filters={filters}
          onFilterChange={handleFilterChange}
          selectedState={selectedState}
          onStateClick={handleStateClick}
          loading={data.loading}
          stateLbRows={data.stateLbRows}
          marketLbRows={data.marketLbRows}
          agentLbRows={data.agentLbRows}
          templateLbRows={data.templateLbRows}
        />
      )}

      {layoutMode === 'full' && (
        <MetricsWarRoom100
          summary={data.summary}
          timeSeries={data.timeSeries}
          statePerf={data.statePerf}
          channelPerf={data.channelPerf}
          funnel={data.funnel}
          spend={data.spend}
          offerMetrics={data.offerMetrics}
          buyerMetrics={data.buyerMetrics}
          dataQuality={data.dataQuality}
          numberHealth={data.numberHealth}
          carrierPerf={data.carrierPerf}
          alerts={data.alerts}
          filters={filters}
          onFilterChange={handleFilterChange}
          selectedState={selectedState}
          onStateClick={handleStateClick}
          loading={data.loading}
          stateLbRows={data.stateLbRows}
          marketLbRows={data.marketLbRows}
          agentLbRows={data.agentLbRows}
          templateLbRows={data.templateLbRows}
        />
      )}
    </div>
  )
}
