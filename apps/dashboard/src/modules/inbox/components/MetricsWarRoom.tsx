/**
 * MetricsWarRoom — NEXUS metrics command center.
 * Renders one of four named layouts based on layoutMode:
 *   25%  → MetricsRail25     (KPI command rail)
 *   50%  → MetricsCockpit50  (compact cockpit)
 *   75%  → MetricsCommand75  (two-column command view)
 *   100% → MetricsWarRoom100 (full war room)
 */

import { useState, useCallback, useEffect, useRef, useMemo, useId } from 'react'
import type { ViewLayoutMode, ViewWidthPercent } from '../../../domain/inbox/view-layout'
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
import { playAlertSound, SOUND_LABELS, type SoundMode } from './metrics-sound'
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

// ── Sound management ──────────────────────────────────────────────────────────
// playAlertSound / SoundMode / SOUND_LABELS live in ./metrics-sound so this module
// only exports React components (required for a clean React Fast Refresh boundary).

// ── Agent status helpers ──────────────────────────────────────────────────────

function agentStatus(a: AgentPerformance): 'scale' | 'maintain' | 'pause' | 'review' {
  if (a.optOutRate > 3.5) return 'pause'
  if (a.positiveRate >= 4 && a.optOutRate <= 2) return 'scale'
  if (a.replyRate >= 8 || a.positiveRate >= 2) return 'maintain'
  return 'review'
}

function agentStatusLabel(s: ReturnType<typeof agentStatus>): string {
  return s === 'scale' ? 'Scale Up' : s === 'maintain' ? 'Maintain' : s === 'pause' ? 'Pause' : 'Review'
}

function agentRecommendation(a: AgentPerformance): string {
  if (!a.agentName || a.agentName === 'Unknown') return 'Unknown agent attribution is too high — fix mapping.'
  const s = agentStatus(a)
  if (s === 'scale') return `${a.agentName} is outperforming${a.bestMarket ? ` in ${a.bestMarket}` : ''} — scale send volume.`
  if (s === 'pause') return `${a.agentName} opt-out rate ${fmt.pct(a.optOutRate)} — pause and audit templates.`
  if (s === 'review') return `${a.agentName} volume too low to assess — increase sends.`
  return `${a.agentName} performing normally. Monitor trends.`
}

function templateRecommendationColor(r: TemplatePerformance['recommendation']): string {
  return r === 'Scale' ? 'var(--wr-green)' : r === 'Testing' ? 'var(--wr-teal)' : r === 'Pause' ? 'var(--wr-amber)' : r === 'Kill' ? 'var(--wr-red)' : 'var(--wr-dimmer)'
}

function marketRecommendationColor(r: MarketPerformance['recommendation']): string {
  return r === 'Scale' ? 'var(--wr-green)' : r === 'Watch' ? 'var(--wr-amber)' : r === 'Pause' ? 'var(--wr-red)' : r === 'Investigate' ? 'var(--wr-purple)' : 'var(--wr-dimmer)'
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
  if (!d || d.sent === 0 || d.status === 'quiet') return 'rgba(14, 207, 206, 0.05)'
  switch (d.status) {
    case 'strong':      return 'rgba(14,212,138,0.38)'
    case 'active':      return 'rgba(14,207,206,0.32)'
    case 'contracting': return 'rgba(168,85,247,0.36)'
    case 'warning':     return 'rgba(245,166,35,0.36)'
    case 'blocked':     return 'rgba(224,82,82,0.38)'
    default:            return 'rgba(14, 207, 206, 0.05)'
  }
}

function choroStroke(d: StatePerformance | undefined, sel: boolean, hov: boolean): string {
  if (sel) return 'rgba(255,255,255,0.95)'
  if (hov) return 'rgba(255,255,255,0.75)'
  if (!d || d.sent === 0 || d.status === 'quiet') return 'rgba(14,207,206,0.22)'
  switch (d.status) {
    case 'strong':      return 'rgba(14,212,138,0.9)'
    case 'active':      return 'rgba(14,207,206,0.85)'
    case 'contracting': return 'rgba(168,85,247,0.9)'
    case 'warning':     return 'rgba(245,166,35,0.85)'
    case 'blocked':     return 'rgba(224,82,82,0.9)'
    default:            return 'rgba(14,207,206,0.22)'
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
  soundMode,
  onSoundToggle,
  alertCount,
}: {
  filters: KpiFilters
  onChange: (p: Partial<KpiFilters>) => void
  loading: boolean
  selectedState: string | null
  onClearState: () => void
  widthMode: ViewWidthPercent
  soundMode: SoundMode
  onSoundToggle: () => void
  alertCount: number
}) {
  const ranges: KpiTimeRange[] = ['today', 'last_7_days', 'last_30_days', 'last_40_days']
  const channels: Array<{ v: KpiFilters['channel']; label: string }> = [
    { v: 'all', label: 'ALL' },
    { v: 'sms', label: 'SMS' },
    { v: 'email', label: 'EMAIL' },
  ]
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
      {widthMode !== '25' && (
        <div className="wr-header__range">
          {channels.map(c => (
            <button
              key={c.v}
              type="button"
              className={cls('wr-header__range-btn', (filters.channel ?? 'all') === c.v && 'is-active')}
              onClick={() => onChange({ channel: c.v })}
              disabled={loading}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {alertCount > 0 && (
        <span className="wr-header__alert-badge">{alertCount}</span>
      )}
      <button
        type="button"
        className={cls('wr-header__sound-btn', soundMode !== 'off' && 'is-active')}
        onClick={onSoundToggle}
        title={`Sound: ${SOUND_LABELS[soundMode]}`}
      >
        {SOUND_LABELS[soundMode]}
      </button>
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
        : visible.map(c => {
            const tipPrev = c.trendPrev > 0 ? ` · prev: ${c.trendPrev.toLocaleString()}` : ''
            return (
              <div
                key={c.label}
                className={cls('wr-kpi-card', c.tone && `is-${c.tone}`)}
                title={`${c.label}: ${c.value}${c.sub ? ' (' + c.sub + ')' : ''}${tipPrev}`}
              >
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
            )
          })}
    </div>
  )
}

// ── WrUsaMap ──────────────────────────────────────────────────────────────────

type MapMetric = 'status' | 'reply' | 'positive' | 'optout' | 'delivery'

const MAP_METRIC_LABELS: Record<MapMetric, string> = {
  status:   'Status',
  reply:    'Reply%',
  positive: 'Pos%',
  optout:   'Opt-Out%',
  delivery: 'Delivery%',
}

function choroFillMetric(d: StatePerformance | undefined, metric: MapMetric): string {
  if (!d || d.sent === 0) return 'rgba(14, 207, 206, 0.05)'
  if (metric === 'status') return choroFill(d)
  switch (metric) {
    case 'reply': {
      const r = d.replyRate
      if (r >= 8)  return 'rgba(14,212,138,0.48)'
      if (r >= 4)  return 'rgba(14,207,206,0.34)'
      if (r >= 2)  return 'rgba(245,166,35,0.32)'
      return 'rgba(224,82,82,0.32)'
    }
    case 'positive': {
      const p = d.positiveRate
      if (p >= 3)   return 'rgba(14,212,138,0.48)'
      if (p >= 1.5) return 'rgba(14,207,206,0.34)'
      if (p >= 0.5) return 'rgba(245,166,35,0.32)'
      return 'rgba(224,82,82,0.28)'
    }
    case 'optout': {
      const o = d.optOutRate
      if (o >= 4)   return 'rgba(224,82,82,0.48)'
      if (o >= 2)   return 'rgba(245,166,35,0.38)'
      if (o >= 0.5) return 'rgba(14,207,206,0.32)'
      return 'rgba(14,212,138,0.38)'
    }
    case 'delivery': {
      const dl = d.deliveryRate
      if (dl >= 92) return 'rgba(14,212,138,0.48)'
      if (dl >= 80) return 'rgba(14,207,206,0.34)'
      if (dl >= 65) return 'rgba(245,166,35,0.36)'
      return 'rgba(224,82,82,0.42)'
    }
  }
}

function choroStrokeMetric(d: StatePerformance | undefined, metric: MapMetric, sel: boolean, hov: boolean): string {
  if (sel) return 'rgba(255,255,255,0.95)'
  if (hov) return 'rgba(255,255,255,0.75)'
  if (!d || d.sent === 0) return 'rgba(14,207,206,0.22)'
  if (metric === 'status') return choroStroke(d, false, false)
  const fill = choroFillMetric(d, metric)
  return fill.replace(/[\d.]+\)$/, '0.9)')
}

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
  const [mapMetric, setMapMetric] = useState<MapMetric>('status')

  const stateMap = useMemo(() => new Map(states.map(s => [s.state, s])), [states])
  const hovData = hovered ? stateMap.get(hovered) : null

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [])

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.log('[WAR_ROOM_MAP_RENDERED]', {
        visibleCells: Object.keys(USA_STATE_PATHS).length,
        selectedMetric: mapMetric,
        statesWithData: states.filter(s => s.sent > 0).length,
      })
    }
  }, [states, mapMetric])

  if (loading) {
    return (
      <div className="wr-panel wr-map-panel">
        <div className="wr-panel__header"><span className="wr-panel__title">Nationwide Performance Map</span></div>
        <div className="wr-panel__body wr-map-body" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <WrSkeleton h={300} w="100%" />
        </div>
      </div>
    )
  }

  const METRIC_LEGENDS: Record<MapMetric, Array<[string, string]>> = {
    status:   [['#0ed48a','Strong'],['#0ecfce','Active'],['#a855f7','Contracting'],['#f5a623','Warning'],['#e05252','Blocked'],['rgba(80,140,220,0.5)','Quiet']],
    reply:    [['#0ed48a','≥8%'],['#0ecfce','≥4%'],['#f5a623','≥2%'],['#e05252','<2%']],
    positive: [['#0ed48a','≥3%'],['#0ecfce','≥1.5%'],['#f5a623','≥0.5%'],['#e05252','<0.5%']],
    optout:   [['#e05252','≥4%'],['#f5a623','≥2%'],['#0ecfce','≥0.5%'],['#0ed48a','<0.5%']],
    delivery: [['#0ed48a','≥92%'],['#0ecfce','≥80%'],['#f5a623','≥65%'],['#e05252','<65%']],
  }

  return (
    <div className="wr-panel wr-map-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">NATIONWIDE PERFORMANCE MAP</span>
        <div className="wr-map__metric-bar">
          {(Object.keys(MAP_METRIC_LABELS) as MapMetric[]).map(m => (
            <button
              key={m}
              type="button"
              className={cls('wr-map__metric-btn', mapMetric === m && 'is-active')}
              onClick={() => setMapMetric(m)}
            >
              {MAP_METRIC_LABELS[m]}
            </button>
          ))}
        </div>
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
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <pattern id="wr-map-grid" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="0.5" cy="0.5" r="0.6" fill="rgba(14,207,206,0.09)" />
              </pattern>
              <filter id="wr-state-glow" x="-15%" y="-15%" width="130%" height="130%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <rect width="960" height="600" fill="#030c1e" />
            <rect width="960" height="600" fill="url(#wr-map-grid)" />
            {Object.entries(USA_STATE_PATHS).map(([abbr, sp]) => {
              const d = stateMap.get(abbr)
              const isSel = selectedState === abbr
              const isHov = hovered === abbr
              const hasData = !!(d && d.sent > 0 && d.status !== 'quiet')
              return (
                <g key={abbr}>
                  <path
                    d={sp.path}
                    fill={choroFillMetric(d, mapMetric)}
                    className="wr-map__state"
                    vectorEffect="non-scaling-stroke"
                    style={{
                      opacity: isHov ? 0.85 : 1,
                      stroke: choroStrokeMetric(d, mapMetric, isSel, isHov),
                      strokeWidth: isSel ? 2.5 : isHov ? 1.8 : hasData ? 1.2 : 0.8,
                      filter: (isSel || isHov || hasData) ? 'url(#wr-state-glow)' : 'none',
                    }}
                    onClick={() => { console.log('[METRICS_MAP_STATE_CLICK]', abbr); onStateClick(isSel ? '' : abbr) }}
                    onMouseEnter={() => setHovered(abbr)}
                  />
                  {hasData && abbr !== 'HI' && abbr !== 'DC' && abbr !== 'AK' && (
                    <circle
                      cx={sp.cx}
                      cy={sp.cy - 14}
                      r="3.5"
                      fill="rgba(14,207,206,0.15)"
                      stroke="rgba(14,207,206,0.7)"
                      strokeWidth="1"
                      className="wr-map__pulse-dot"
                    />
                  )}
                  {abbr !== 'HI' && abbr !== 'DC' && (
                    <text
                      x={sp.cx}
                      y={sp.cy}
                      className="wr-map__state-label"
                      style={{
                        fontSize: 8,
                        opacity: hasData ? 0.9 : 0.45,
                        fill: hasData ? '#fff' : 'rgba(140,180,240,0.7)',
                      }}
                    >
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
                ['Sent',     fmt.int(hovData.sent)],
                ['Reply%',   fmt.pct(hovData.replyRate)],
                ['Positive', fmt.pct(hovData.positiveRate)],
                ['Delivery', fmt.pct(hovData.deliveryRate)],
                ['Opt-Out',  fmt.pct(hovData.optOutRate)],
                ['Top Mkt',  hovData.topMarket],
                ['Action',   hovData.recommendation],
              ].map(([k, v]) => (
                <div key={k} className="wr-map__tooltip-row">
                  <span>{k}</span><span>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="wr-map__legend">
          {METRIC_LEGENDS[mapMetric].map(([c, label]) => (
            <span key={label} className="wr-map__legend-item">
              <i style={{ background: c, border: `1px solid ${c}` }} /> {label}
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

const ALERT_SEV_COLOR: Record<string, string> = {
  critical: 'var(--wr-red)',
  warning: 'var(--wr-amber)',
  opportunity: 'var(--wr-green)',
  info: 'var(--wr-teal)',
}
const ALERT_SEV_ICON: Record<string, string> = {
  critical: '⚠', warning: '◉', opportunity: '▲', info: '◎',
}

function WrAlerts({ alerts, loading }: { alerts: KpiAlert[]; loading: boolean }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const sorted = [...alerts].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, warning: 1, opportunity: 2, info: 3 }
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
  })

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Intelligence + Alerts</span>
        {alerts.length > 0 && (
          <span className="wr-panel__badge" style={{ color: alerts.some(a => a.severity === 'critical') ? 'var(--wr-red)' : 'var(--wr-amber)' }}>
            {alerts.length} active
          </span>
        )}
      </div>
      <div className="wr-panel__body wr-alerts-body">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <WrSkeleton key={i} h={40} />)
        ) : sorted.length === 0 ? (
          <div className="wr-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '20px 10px' }}>
            <span style={{ fontSize: 20, opacity: 0.3 }}>✓</span>
            <span>No active alerts — system nominal.</span>
          </div>
        ) : (
          sorted.slice(0, 8).map((a, i) => {
            const color = ALERT_SEV_COLOR[a.severity] ?? 'var(--wr-teal)'
            const icon = ALERT_SEV_ICON[a.severity] ?? '◎'
            const isOpen = expanded === i
            return (
              <div
                key={i}
                className={cls('wr-alert', `wr-alert--${a.severity}`)}
                style={{ cursor: 'pointer' }}
                onClick={() => setExpanded(isOpen ? null : i)}
              >
                <div className="wr-alert__head">
                  <span className="wr-alert__icon" style={{ color }}>{icon}</span>
                  <span className="wr-alert__category" style={{ color: color + 'cc' }}>{a.category ?? a.severity.toUpperCase()}</span>
                  <span className="wr-alert__sev-badge" style={{ background: color + '18', color, border: `1px solid ${color}44` }}>
                    {a.severity.toUpperCase()}
                  </span>
                  <span className="wr-alert__chevron" style={{ opacity: 0.4 }}>{isOpen ? '▲' : '▼'}</span>
                </div>
                <span className="wr-alert__msg">{a.message}</span>
                {isOpen && a.suggestedAction && (
                  <div className="wr-alert__action" style={{ color }}>→ {a.suggestedAction}</div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── WrLineChart ───────────────────────────────────────────────────────────────
// Full multi-line SVG area chart for messaging volume over time

function WrLineChart({ timeSeries, loading }: { timeSeries: TimeSeriesPoint[]; loading: boolean }) {
  const chartId = useId()

  useEffect(() => {
    if (import.meta.env.DEV && timeSeries.length > 0) {
      console.log('[WAR_ROOM_CHART_RENDERED]', {
        points: timeSeries.length,
        width: 800,
        height: 260,
      })
    }
  }, [timeSeries])
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

  const hasData = timeSeries.length >= 1

  // For single data point, duplicate it to draw a horizontal line across the full width
  const plotData = timeSeries.length === 1
    ? [timeSeries[0], timeSeries[0]]
    : timeSeries

  // Build paths
  const W = 800, H = 260
  const padL = 44, padR = 14, padT = 12, padB = 28
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  // Per-series normalization: each line fills the full chart height independently
  // This ensures all lines are visible even when sent >> replied
  const seriesMaxes = hasData
    ? lineKeys.reduce((acc, lk) => {
        const vals = plotData.map(p => (p[lk.key] as number) || 0)
        acc[String(lk.key)] = Math.max(...vals, 1)
        return acc
      }, {} as Record<string, number>)
    : {} as Record<string, number>

  // Keep sent scale for Y-axis labels
  const sentMax = seriesMaxes['sent'] || 1

  const xOf = (i: number) => padL + (i / Math.max(plotData.length - 1, 1)) * plotW
  const yOf = (v: number, key: string) => {
    const m = seriesMaxes[key] || 1
    return padT + plotH - ((v || 0) / m) * plotH
  }

  const buildPath = (key: keyof TimeSeriesPoint) => {
    if (!hasData) return ''
    return plotData
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p[key] as number, String(key)).toFixed(1)}`)
      .join(' ')
  }

  const buildFill = (key: keyof TimeSeriesPoint) => {
    if (!hasData) return ''
    const lastI = plotData.length - 1
    return (
      `M${padL.toFixed(1)},${(padT + plotH).toFixed(1)} ` +
      plotData.map((p, i) => `L${xOf(i).toFixed(1)},${yOf(p[key] as number, String(key)).toFixed(1)}`).join(' ') +
      ` L${xOf(lastI).toFixed(1)},${(padT + plotH).toFixed(1)} Z`
    )
  }

  // Y axis ticks (based on sent series)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    y: padT + plotH - f * plotH,
    label: f === 0 ? '0' : f === 1 ? fmt.int(Math.round(sentMax)) : fmt.int(Math.round(sentMax * f)),
  }))

  // X axis dates (show up to 6 labels, based on original timeSeries not plotData)
  const xTickIndices: number[] = []
  if (hasData) {
    const n = plotData.length
    const step = Math.max(1, Math.floor(n / 6))
    for (let i = 0; i < n; i += step) xTickIndices.push(i)
    if (xTickIndices[xTickIndices.length - 1] !== n - 1) xTickIndices.push(n - 1)
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
          <div className="wr-empty">No time-series data for this period.<br /><span style={{ fontSize: 9, opacity: 0.6 }}>Send messages to generate activity data.</span></div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="wr-linechart-svg" preserveAspectRatio="xMidYMid meet">
            <defs>
              {lineKeys.map(lk => (
                <linearGradient key={lk.gradId} id={lk.gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lk.color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={lk.color} stopOpacity={0.01} />
                </linearGradient>
              ))}
            </defs>

            {/* Grid lines */}
            {yTicks.map(t => (
              <line key={t.y} x1={padL} y1={t.y} x2={W - padR} y2={t.y}
                stroke="rgba(14,207,206,0.10)" strokeWidth="1" strokeDasharray="3,5" />
            ))}

            {/* Y axis labels */}
            {yTicks.map(t => (
              <text key={t.y} x={padL - 5} y={t.y + 4} textAnchor="end"
                fill="rgba(160,190,240,0.65)" fontSize="10" fontFamily="inherit">{t.label}</text>
            ))}

            {/* X axis labels */}
            {xTickIndices.map(i => (
              <text key={i} x={xOf(i)} y={H - 5} textAnchor="middle"
                fill="rgba(160,190,240,0.5)" fontSize="9" fontFamily="inherit">
                {(timeSeries[Math.min(i, timeSeries.length - 1)]?.date ?? '').slice(5)}
              </text>
            ))}

            {/* Scale note */}
            <text x={W - padR} y={padT + 4} textAnchor="end"
              fill="rgba(160,190,240,0.3)" fontSize="8" fontFamily="inherit">each line scaled independently</text>

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
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ filter: `drop-shadow(0 0 6px ${lk.color}90)` }}
              />
            ))}

            {/* Dot on last point */}
            {lineKeys.map(lk => {
              const last = timeSeries[timeSeries.length - 1]
              if (!last) return null
              return (
                <circle
                  key={`dot-${String(lk.key)}`}
                  cx={xOf(plotData.length - 1)}
                  cy={yOf(last[lk.key] as number, String(lk.key))}
                  r="3"
                  fill="#fff"
                  stroke={lk.color}
                  strokeWidth="1.5"
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
            {Array.from({ length: 5 }).map((_, i) => <WrSkeleton key={i} h={14} />)}
          </div>
        ) : !rows.length ? (
          <div className="wr-lb__empty">{emptyMessage ?? 'No data for this period.'}</div>
        ) : (
          <>
            <div className="wr-lb__header">
              <span>#</span>
              <span>Name</span>
              <span>Sent</span>
              <span>Reply%</span>
              <span>Opt%</span>
            </div>
            {rows.slice(0, maxRows).map((r, i) => {
              const replyRate = r.sent > 0 ? (r.replies / r.sent * 100) : 0
              return (
                <div key={r.key} className="wr-lb__row wr-lb__row--full">
                  <span className="wr-lb__rank">{i + 1}</span>
                  <span className="wr-lb__name">{r.label}</span>
                  <span className="wr-lb__val">{fmt.int(r.sent)}</span>
                  <span style={{ color: replyRate > 6 ? 'var(--wr-teal)' : 'var(--wr-muted)', fontVariantNumeric: 'tabular-nums', fontSize: 10 }}>
                    {r.sent > 0 ? `${replyRate.toFixed(1)}%` : '—'}
                  </span>
                  <span style={{ color: r.optOutRate > 2 ? 'var(--wr-amber)' : 'var(--wr-dimmer)', fontVariantNumeric: 'tabular-nums', fontSize: 10 }}>
                    {fmt.pct(r.optOutRate)}
                  </span>
                </div>
              )
            })}
          </>
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

// ── WrAgentIntelligence ───────────────────────────────────────────────────────

function WrAgentIntelligence({ agents, loading, compact = false }: { agents: AgentPerformance[]; loading: boolean; compact?: boolean }) {
  const displayed = compact ? agents.slice(0, 4) : agents.slice(0, 12)
  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Agent Intelligence</span>
        {!loading && agents.length > 0 && <span className="wr-panel__badge">{agents.length} agents</span>}
      </div>
      <div className="wr-panel__body">
        {loading ? (
          Array.from({ length: compact ? 2 : 4 }).map((_, i) => <WrSkeleton key={i} h={52} />)
        ) : !agents.length ? (
          <div className="wr-empty">No agent activity in this period.<br />
            <span style={{ fontSize: 9, opacity: 0.6 }}>Populate <code>sender_name</code> in <code>message_events</code> to enable agent tracking.</span>
          </div>
        ) : (
          <>
            <div className="wr-agent-grid">
              {displayed.map(a => {
                const s = agentStatus(a)
                return (
                  <div key={a.agentId} className={cls('wr-agent-card', `wr-agent-card--${s}`)}>
                    <div className="wr-agent-card__head">
                      <span className="wr-agent-card__name">{a.agentName || 'Unknown'}</span>
                      <span className={cls('wr-agent-badge', `wr-agent-badge--${s}`)}>{agentStatusLabel(s)}</span>
                    </div>
                    <div className="wr-agent-card__stats">
                      <span><em>Sent</em> {fmt.int(a.sent)}</span>
                      <span><em>Reply</em> <b style={{ color: 'var(--wr-teal)' }}>{fmt.pct(a.replyRate)}</b></span>
                      <span><em>Pos</em> <b style={{ color: 'var(--wr-green)' }}>{fmt.pct(a.positiveRate)}</b></span>
                      <span><em>Opt</em> <b style={{ color: a.optOutRate > 2 ? 'var(--wr-amber)' : 'var(--wr-muted)' }}>{fmt.pct(a.optOutRate)}</b></span>
                    </div>
                    {a.bestMarket && (
                      <div className="wr-agent-card__market">
                        <em>Best:</em> {a.bestMarket}
                        {a.activeConversations > 0 && <span> · {a.activeConversations} active</span>}
                      </div>
                    )}
                    <div className="wr-agent-card__rec">{agentRecommendation(a)}</div>
                  </div>
                )
              })}
            </div>
            {!compact && agents.length > 0 && (
              <div className="wr-agent-table">
                <div className="wr-agent-table__header">
                  <span>Agent</span><span>Sent</span><span>Reply%</span><span>Pos%</span><span>Opt%</span><span>Best Mkt</span><span>Contracts</span><span>Status</span>
                </div>
                {agents.map(a => {
                  const s = agentStatus(a)
                  return (
                    <div key={a.agentId} className="wr-agent-table__row">
                      <span className="wr-agent-table__name">{a.agentName || 'Unknown'}</span>
                      <span>{fmt.int(a.sent)}</span>
                      <span style={{ color: 'var(--wr-teal)' }}>{fmt.pct(a.replyRate)}</span>
                      <span style={{ color: 'var(--wr-green)' }}>{fmt.pct(a.positiveRate)}</span>
                      <span style={{ color: a.optOutRate > 2 ? 'var(--wr-amber)' : 'var(--wr-muted)' }}>{fmt.pct(a.optOutRate)}</span>
                      <span style={{ color: 'var(--wr-muted)' }}>{a.bestMarket || '—'}</span>
                      <span style={{ color: 'var(--wr-purple)' }}>{fmt.int(a.contractsInfluenced)}</span>
                      <span className={cls('wr-agent-badge', `wr-agent-badge--${s}`)} style={{ fontSize: 9 }}>{agentStatusLabel(s)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── WrTemplateTable ───────────────────────────────────────────────────────────

function WrTemplateTable({ templates, loading }: { templates: TemplatePerformance[]; loading: boolean }) {
  const winners = templates.filter(t => t.recommendation === 'Scale').slice(0, 4)
  const kills   = templates.filter(t => t.recommendation === 'Kill' || t.recommendation === 'Pause').slice(0, 4)
  const allSorted = [...templates].sort((a, b) => b.sent - a.sent)

  const tplRow = (t: TemplatePerformance) => (
    <div key={t.templateId} className="wr-intel-table__row">
      <span
        className="wr-intel-table__preview"
        title={`${t.name ?? t.templateId}${t.agentPersona ? ` · ${t.agentPersona}` : ''}${t.stage ? ` · ${t.stage}` : ''}\n${t.preview}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t.preview ? t.preview.slice(0, 40) + (t.preview.length > 40 ? '…' : '') : (t.name ?? t.templateId.slice(0, 16))}
        </span>
        {t.agentPersona && (
          <span style={{ fontSize: 8, opacity: 0.55, color: 'var(--wr-purple)' }}>{t.agentPersona}{t.stage ? ` · ${t.stage}` : ''}</span>
        )}
      </span>
      <span style={{ color: 'var(--wr-muted)' }}>{t.language || 'EN'}</span>
      <span style={{ color: 'var(--wr-muted)' }}>{t.useCase || '—'}</span>
      <span>{fmt.int(t.sent)}</span>
      <span style={{ color: t.deliveryRate < 80 ? 'var(--wr-amber)' : 'var(--wr-teal)' }}>{fmt.pct(t.deliveryRate)}</span>
      <span style={{ color: 'var(--wr-teal)' }}>{fmt.pct(t.replyRate)}</span>
      <span style={{ color: 'var(--wr-green)' }}>{fmt.pct(t.positiveRate)}</span>
      <span style={{ color: t.stopRate > 2 ? 'var(--wr-amber)' : 'var(--wr-muted)' }}>{fmt.pct(t.stopRate)}</span>
      <span className="wr-intel-badge" style={{ color: templateRecommendationColor(t.recommendation), borderColor: templateRecommendationColor(t.recommendation) }}>
        {t.recommendation}
      </span>
    </div>
  )

  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Template Intelligence</span>
        {!loading && templates.length > 0 && <span className="wr-panel__badge">{templates.length} templates</span>}
      </div>
      <div className="wr-panel__body" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: '8px 12px' }}>{Array.from({ length: 4 }).map((_, i) => <WrSkeleton key={i} h={16} />)}</div>
        ) : !templates.length ? (
          <div className="wr-empty">No template data for this period.</div>
        ) : (
          <>
            {winners.length > 0 && (
              <div className="wr-tpl-section">
                <div className="wr-tpl-section__label">
                  <i style={{ background: 'var(--wr-green)' }} />
                  Top Performers
                </div>
                {winners.map(t => (
                  <div key={t.templateId} className="wr-tpl-winner-row">
                    <span className="wr-tpl-preview" title={t.preview}>{t.preview?.slice(0, 50) ?? t.templateId.slice(0, 16)}…</span>
                    <span className="wr-tpl-stat" style={{ color: 'var(--wr-teal)' }}>{fmt.pct(t.replyRate)} reply</span>
                    <span className="wr-tpl-stat" style={{ color: 'var(--wr-green)' }}>{fmt.pct(t.positiveRate)} pos</span>
                    <span className="wr-intel-badge" style={{ color: templateRecommendationColor(t.recommendation), borderColor: templateRecommendationColor(t.recommendation) }}>SCALE</span>
                  </div>
                ))}
              </div>
            )}
            {kills.length > 0 && (
              <div className="wr-tpl-section">
                <div className="wr-tpl-section__label">
                  <i style={{ background: 'var(--wr-red)' }} />
                  Review / Kill
                </div>
                {kills.map(t => (
                  <div key={t.templateId} className="wr-tpl-kill-row">
                    <span className="wr-tpl-preview" title={t.preview}>{t.preview?.slice(0, 50) ?? t.templateId.slice(0, 16)}…</span>
                    <span className="wr-tpl-stat" style={{ color: t.stopRate > 2 ? 'var(--wr-red)' : 'var(--wr-amber)' }}>{fmt.pct(t.stopRate)} opt</span>
                    <span className="wr-tpl-stat">{fmt.int(t.sent)} sent</span>
                    <span className="wr-intel-badge" style={{ color: templateRecommendationColor(t.recommendation), borderColor: templateRecommendationColor(t.recommendation) }}>{t.recommendation.toUpperCase()}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="wr-tpl-scroll">
              <div className="wr-intel-table wr-intel-table--templates">
                <div className="wr-intel-table__header">
                  <span>Template</span><span>Lang</span><span>Use</span><span>Sent</span><span>Del%</span><span>Reply%</span><span>Pos%</span><span>Opt%</span><span>Rec</span>
                </div>
                {allSorted.map(tplRow)}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── WrMarketTable ─────────────────────────────────────────────────────────────

function WrMarketTable({ markets, loading }: { markets: MarketPerformance[]; loading: boolean }) {
  return (
    <div className="wr-panel">
      <div className="wr-panel__header">
        <span className="wr-panel__title">Market Intelligence</span>
        {!loading && markets.length > 0 && <span className="wr-panel__badge">{markets.length} markets</span>}
      </div>
      <div className="wr-panel__body" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: '8px 12px' }}>{Array.from({ length: 5 }).map((_, i) => <WrSkeleton key={i} h={16} />)}</div>
        ) : !markets.length ? (
          <div className="wr-empty">No market data for this period.</div>
        ) : (
          <div className="wr-tpl-scroll">
            <div className="wr-intel-table wr-intel-table--markets">
              <div className="wr-intel-table__header">
                <span>Market</span><span>State</span><span>Sent</span><span>Del%</span><span>Reply%</span><span>Pos%</span><span>Opt%</span><span>Demand</span><span>Contracts</span><span>Rec</span>
              </div>
              {markets.map(m => (
                <div key={m.market} className="wr-intel-table__row">
                  <span className="wr-intel-table__preview">{m.market}</span>
                  <span style={{ color: 'var(--wr-muted)' }}>{m.state}</span>
                  <span>{fmt.int(m.sent)}</span>
                  <span style={{ color: m.deliveryRate < 80 ? 'var(--wr-amber)' : 'var(--wr-teal)' }}>{fmt.pct(m.deliveryRate)}</span>
                  <span style={{ color: 'var(--wr-teal)' }}>{fmt.pct(m.replyRate)}</span>
                  <span style={{ color: 'var(--wr-green)' }}>{fmt.pct(m.positiveRate)}</span>
                  <span style={{ color: m.optOutRate > 2 ? 'var(--wr-amber)' : 'var(--wr-muted)' }}>{fmt.pct(m.optOutRate)}</span>
                  <span style={{ color: m.buyerDemandScore > 60 ? 'var(--wr-green)' : m.buyerDemandScore > 30 ? 'var(--wr-amber)' : 'var(--wr-muted)' }}>{m.buyerDemandScore > 0 ? m.buyerDemandScore : '—'}</span>
                  <span style={{ color: 'var(--wr-purple)' }}>{fmt.int(m.contracts)}</span>
                  <span className="wr-intel-badge" style={{ color: marketRecommendationColor(m.recommendation), borderColor: marketRecommendationColor(m.recommendation) }}>
                    {m.recommendation}
                  </span>
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
      if (import.meta.env.DEV) {
        console.log('[WAR_ROOM_DATA_LOADED]', {
          sent: sumRes.sentCount,
          stateRows: stateRes.length,
          marketRows: mktRes.length,
          agentRows: agentRes.length,
          templateRows: tplRes.length,
          timeseriesRows: tsRes.length,
          mapRows: stateRes.length,
        })
      }
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
  agentPerf,
  filters,
  onFilterChange,
  loading,
  soundMode,
  onSoundToggle,
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
  agentPerf: AgentPerformance[]
  filters: KpiFilters
  onFilterChange: (p: Partial<KpiFilters>) => void
  loading: boolean
  soundMode: SoundMode
  onSoundToggle: () => void
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
      <WrFilterBar filters={filters} onChange={onFilterChange} loading={loading} selectedState={null} onClearState={() => {}} widthMode="50" soundMode={soundMode} onSoundToggle={onSoundToggle} alertCount={alerts.length} />
      <WrKpiStrip summary={summary} timeSeries={timeSeries} loading={loading} maxCards={8} />
      <div className="wr-scroll">
        <div className="wr-50-row1">
          <WrFunnel stages={funnel} loading={loading} compact />
          <WrRevenue spend={spend} offerMetrics={offerMetrics} loading={loading} />
        </div>
        <div className="wr-50-chart">
          <WrLineChart timeSeries={timeSeries} loading={loading} />
        </div>
        <div className="wr-50-lbs">
          <WrLeaderboard title="Template Leaderboard" rows={templateLbRows} loading={loading} maxRows={5} emptyMessage="No template sends in this period." />
          <WrLeaderboard title="State Leaderboard" rows={stateLbRows} loading={loading} maxRows={5} emptyMessage="No state-level data in this period." />
        </div>
        {alerts.length > 0 && (
          <div className="wr-50-full">
            <WrAlerts alerts={alerts} loading={loading} />
          </div>
        )}
        <div className="wr-50-full">
          <WrAgentIntelligence agents={agentPerf} loading={loading} compact />
        </div>
        <div className="wr-50-full">
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
  agentPerf,
  templatePerf,
  filters,
  onFilterChange,
  selectedState,
  onStateClick,
  loading,
  stateLbRows,
  marketLbRows,
  agentLbRows,
  templateLbRows,
  soundMode,
  onSoundToggle,
}: {
  summary: KpiSummary | null
  timeSeries: TimeSeriesPoint[]
  statePerf: StatePerformance[]
  channelPerf: ChannelPerformance[]
  funnel: FunnelStage[]
  numberHealth: TextgridNumberHealth[]
  carrierPerf: CarrierPerformance[]
  alerts: KpiAlert[]
  agentPerf: AgentPerformance[]
  templatePerf: TemplatePerformance[]
  filters: KpiFilters
  onFilterChange: (p: Partial<KpiFilters>) => void
  selectedState: string | null
  onStateClick: (abbr: string) => void
  loading: boolean
  stateLbRows: LbRow[]
  marketLbRows: LbRow[]
  agentLbRows: LbRow[]
  templateLbRows: LbRow[]
  soundMode: SoundMode
  onSoundToggle: () => void
}) {
  return (
    <div className="wr wr--command">
      <WrFilterBar filters={filters} onChange={onFilterChange} loading={loading} selectedState={selectedState} onClearState={() => onStateClick('')} widthMode="75" soundMode={soundMode} onSoundToggle={onSoundToggle} alertCount={alerts.length} />
      <WrKpiStrip summary={summary} timeSeries={timeSeries} loading={loading} />
      <div className="wr-scroll">
        <div className="wr-75-row1">
          <WrUsaMap states={statePerf} selectedState={selectedState} onStateClick={onStateClick} loading={loading} />
          <WrFunnel stages={funnel} loading={loading} />
        </div>
        <div className="wr-75-chart">
          <WrLineChart timeSeries={timeSeries} loading={loading} />
        </div>
        <div className="wr-75-lbs">
          <WrLeaderboard title="State" rows={stateLbRows} loading={loading} maxRows={6} emptyMessage="No state-level data in this period." />
          <WrLeaderboard title="Market" rows={marketLbRows} loading={loading} maxRows={6} emptyMessage="No market data in this period." />
          <WrLeaderboard title="Agent" rows={agentLbRows} loading={loading} maxRows={6} emptyMessage="No agent activity in this period." />
          <WrLeaderboard title="Template" rows={templateLbRows} loading={loading} maxRows={6} emptyMessage="No template sends in this period." />
        </div>
        <div className="wr-75-channel">
          <WrChannelPerf channels={channelPerf} loading={loading} />
        </div>
        <div className="wr-75-infra">
          <WrCarrierIntel carriers={carrierPerf} loading={loading} />
          <WrNumbersHealth numbers={numberHealth} loading={loading} />
        </div>
        {alerts.length > 0 && (
          <div className="wr-75-channel">
            <WrAlerts alerts={alerts} loading={loading} />
          </div>
        )}
        <div className="wr-75-channel">
          <WrAgentIntelligence agents={agentPerf} loading={loading} />
        </div>
        <div className="wr-75-channel">
          <WrTemplateTable templates={templatePerf} loading={loading} />
        </div>
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
  agentPerf,
  templatePerf,
  marketPerf,
  filters,
  onFilterChange,
  selectedState,
  onStateClick,
  loading,
  stateLbRows,
  marketLbRows,
  agentLbRows,
  templateLbRows,
  soundMode,
  onSoundToggle,
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
  agentPerf: AgentPerformance[]
  templatePerf: TemplatePerformance[]
  marketPerf: MarketPerformance[]
  filters: KpiFilters
  onFilterChange: (p: Partial<KpiFilters>) => void
  selectedState: string | null
  onStateClick: (abbr: string) => void
  loading: boolean
  stateLbRows: LbRow[]
  marketLbRows: LbRow[]
  agentLbRows: LbRow[]
  templateLbRows: LbRow[]
  soundMode: SoundMode
  onSoundToggle: () => void
}) {
  return (
    <div className="wr wr--warroom">
      <WrFilterBar filters={filters} onChange={onFilterChange} loading={loading} selectedState={selectedState} onClearState={() => onStateClick('')} widthMode="100" soundMode={soundMode} onSoundToggle={onSoundToggle} alertCount={alerts.length} />
      <WrKpiStrip summary={summary} timeSeries={timeSeries} loading={loading} />
      <div className="wr-scroll">
        {/* Row 1: Map + Funnel + Alerts/Revenue stack */}
        <div className="wr-section-label">PERFORMANCE OVERVIEW</div>
        <div className="wr-100-row1">
          <WrUsaMap states={statePerf} selectedState={selectedState} onStateClick={onStateClick} loading={loading} />
          <WrFunnel stages={funnel} loading={loading} />
          <div className="wr-100-right-col">
            <WrAlerts alerts={alerts} loading={loading} />
            <WrRevenue spend={spend} offerMetrics={offerMetrics} loading={loading} />
          </div>
        </div>

        {/* Row 2: Line Chart + Channel Perf */}
        <div className="wr-section-label">MESSAGING INTELLIGENCE</div>
        <div className="wr-100-row2">
          <WrLineChart timeSeries={timeSeries} loading={loading} />
          <WrChannelPerf channels={channelPerf} loading={loading} />
        </div>

        {/* Row 3: Leaderboards + Buyer Demand */}
        <div className="wr-section-label">LEADERBOARDS</div>
        <div className="wr-100-lbs">
          <WrLeaderboard title="State" rows={stateLbRows} loading={loading} emptyMessage="No state-level data in this period." />
          <WrLeaderboard title="Market" rows={marketLbRows} loading={loading} emptyMessage="No market data in this period." />
          <WrLeaderboard title="Agent" rows={agentLbRows} loading={loading} emptyMessage="No agent activity in this period." />
          <WrLeaderboard title="Template" rows={templateLbRows} loading={loading} emptyMessage="No template sends in this period." />
          <WrBuyerDemand metrics={buyerMetrics} loading={loading} />
        </div>

        {/* Row 4: Carrier + Numbers + Quality */}
        <div className="wr-section-label">INFRASTRUCTURE + DEMAND</div>
        <div className="wr-100-row4">
          <WrCarrierIntel carriers={carrierPerf} loading={loading} />
          <WrNumbersHealth numbers={numberHealth} loading={loading} />
          <WrDataQuality quality={dataQuality} loading={loading} />
        </div>

        {/* Row 5: Agent Intelligence */}
        <div className="wr-section-label">AGENT INTELLIGENCE</div>
        <div className="wr-100-full">
          <WrAgentIntelligence agents={agentPerf} loading={loading} />
        </div>

        {/* Row 6: Market Intelligence */}
        <div className="wr-section-label">MARKET INTELLIGENCE</div>
        <div className="wr-100-full">
          <WrMarketTable markets={marketPerf} loading={loading} />
        </div>

        {/* Row 7: Template Intelligence */}
        <div className="wr-section-label">TEMPLATE INTELLIGENCE</div>
        <div className="wr-100-full">
          <WrTemplateTable templates={templatePerf} loading={loading} />
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
  const [soundMode, setSoundMode] = useState<SoundMode>('off')
  const prevAlertCountRef = useRef(0)

  const activeFilters = useMemo(
    () => ({ ...filters, state: selectedState ?? undefined }),
    [filters, selectedState]
  )

  const data = useMetricsData(activeFilters, layoutMode, paused)

  useEffect(() => {
    if (soundMode === 'off') return
    const n = data.alerts.length
    if (n > prevAlertCountRef.current && data.alerts[0]) {
      playAlertSound(data.alerts[0].severity, soundMode)
    }
    prevAlertCountRef.current = n
  }, [data.alerts, soundMode])

  const handleFilterChange = useCallback((patch: Partial<KpiFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }))
  }, [])

  const handleStateClick = useCallback((abbr: string) => {
    setSelectedState(abbr || null)
  }, [])

  const handleSoundToggle = useCallback(() => {
    setSoundMode(prev => {
      const modes: SoundMode[] = ['off', 'critical', 'war_room', 'soft']
      return modes[(modes.indexOf(prev) + 1) % modes.length]
    })
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
          agentPerf={data.agentPerf}
          filters={filters}
          onFilterChange={handleFilterChange}
          loading={data.loading}
          soundMode={soundMode}
          onSoundToggle={handleSoundToggle}
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
          agentPerf={data.agentPerf}
          templatePerf={data.templatePerf}
          filters={filters}
          onFilterChange={handleFilterChange}
          selectedState={selectedState}
          onStateClick={handleStateClick}
          loading={data.loading}
          stateLbRows={data.stateLbRows}
          marketLbRows={data.marketLbRows}
          agentLbRows={data.agentLbRows}
          templateLbRows={data.templateLbRows}
          soundMode={soundMode}
          onSoundToggle={handleSoundToggle}
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
          agentPerf={data.agentPerf}
          templatePerf={data.templatePerf}
          marketPerf={data.marketPerf}
          filters={filters}
          onFilterChange={handleFilterChange}
          selectedState={selectedState}
          onStateClick={handleStateClick}
          loading={data.loading}
          stateLbRows={data.stateLbRows}
          marketLbRows={data.marketLbRows}
          agentLbRows={data.agentLbRows}
          templateLbRows={data.templateLbRows}
          soundMode={soundMode}
          onSoundToggle={handleSoundToggle}
        />
      )}
    </div>
  )
}
