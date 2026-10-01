/**
 * ANALYTICS — the telemetry of the acquisition machine, on a phone.
 *
 *   A. SUMMARY        what happened (hero, story of the period)
 *   B. DRIVERS        what changed and where (changes, geography, campaigns)
 *   C. FLOW           where deals move and stall (S1–S9, dwell, bottleneck)
 *   D. INVESTIGATION  exact cohorts → Inbox / Pipeline / Campaigns / Map / Queue
 *
 * One server read per (range, market); the page never aggregates. Scoping to a
 * market re-reads every property-attributed section for that market; sections
 * without geographic attribution say so.
 */
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { useBreakpoint } from '../../../modules/mobile/useBreakpoint'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import type { AnalyticsPerformance, RangeKey, Stage } from '../../../domain/analytics/analytics-performance-api'
import { RANGES, fetchAnalyticsPerformance } from '../../../domain/analytics/analytics-performance-api'
import { AnalyticsGeo, type GeoSelection, type GeoView, type GeoViz } from './AnalyticsGeo'
import { Campaigns, Changes, CohortSheet, Count, DownFunnel, Flow, Hero, MarketInspector, Method, Operations, Story, Trend, cls, periodLabel, type CohortItem } from './AnalyticsParts'
import './analytics-surface.css'
import './analytics-desktop.css'

const readTheme = () => (typeof document === 'undefined' ? 'dark' : document.documentElement.getAttribute('data-nexus-theme') || 'dark')
const RANGE_KEY = 'anx:range:v1'
const STAGE_SHORT: Record<string, string> = { ownership_confirmation: 'S1', offer_interest: 'S2', asking_price: 'S3', property_condition: 'S4', offer: 'S5', formal_contract: 'S6', disposition: 'S7', under_contract: 'S8', prepared_to_close: 'S9', closed: 'S10' }

type Cohort = { title: string; eyebrow: string; items: CohortItem[]; note?: string; points?: Array<{ lat: number | null; lng: number | null; label: string | null; id?: string }> }

/**
 * DESKTOP 4.0 — the modern desktop renders THE INTELLIGENCE LAB
 * (views/analytics/intelligence). Phones keep this surface exactly as it was.
 * If the Lab bundle fails to load or throws, the desktop falls back to this
 * surface (styled by analytics-desktop.css) rather than to a blank pane.
 */
const AnalyticsLab = lazy(() => import('../intelligence/IntelligenceLab'))
class LabBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error('analytics.lab_crashed', error) }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}
export function AnalyticsSurface() {
  const { isModernDesktop } = useBreakpoint()
  if (!isModernDesktop) return <AnalyticsPhoneSurface />
  return (
    <LabBoundary fallback={<AnalyticsPhoneSurface />}>
      <Suspense fallback={<div className="anx" aria-busy="true" />}>
        <AnalyticsLab />
      </Suspense>
    </LabBoundary>
  )
}

function AnalyticsPhoneSurface() {
  const [range, setRange] = useState<RangeKey>(() => (localStorage.getItem(RANGE_KEY) as RangeKey) || '30d')
  const [scope, setScope] = useState<string | null>(null)
  const [w, setW] = useState<AnalyticsPerformance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [geoSel, setGeoSel] = useState<GeoSelection>({ state: null, market: null })
  const [metricKey, setMetricKey] = useState('replied')
  const [view, setView] = useState<GeoView>('count')
  const [viz, setViz] = useState<GeoViz>('dots')
  const [fullscreen, setFullscreen] = useState(false)
  const [inspect, setInspect] = useState<string | null>(null)
  const [cohort, setCohort] = useState<Cohort | null>(null)
  const [theme, setTheme] = useState(readTheme)

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    fetchAnalyticsPerformance({ range, market: scope }, ctl.signal)
      .then((d) => { if (!ctl.signal.aborted) { setW(d); setLoading(false) } })
      .catch((e) => { if (!ctl.signal.aborted) { setError(String(e?.message || e)); setLoading(false) } })
    return () => ctl.abort()
  }, [range, scope, nonce])

  useEffect(() => { try { localStorage.setItem(RANGE_KEY, range) } catch { /* private mode */ } }, [range])

  useBackHandler(Boolean(inspect), 'anx:inspect', 'Market', () => { setInspect(null); return true })
  useBackHandler(Boolean(cohort), 'anx:cohort', 'Cohort', () => { setCohort(null); return true })
  useBackHandler(fullscreen, 'anx:full', 'Map', () => { setFullscreen(false); return true })
  useBackHandler(Boolean(geoSel.state || geoSel.market) && !inspect && !cohort, 'anx:geo', 'Geography', () => { setGeoSel((s) => (s.market ? { state: s.state, market: null } : { state: null, market: null })); return true })

  const toMap = useCallback((label: string, points: Array<{ lat: number | null; lng: number | null; label: string | null; id?: string }>) => {
    const pts = points.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number').map((p) => ({ lat: p.lat as number, lng: p.lng as number, label: p.label, id: p.id }))
    if (writeMapFocusSet({ label, tone: 'property', points: pts })) pushRoutePath('/map')
    else pushRoutePath('/map')
  }, [])

  const replyCohort = useCallback((marketId?: string | null) => {
    if (!w) return
    const mName = marketId ? w.markets.find((m) => m.id === marketId)?.name ?? null : null
    const rows = w.cohorts.replies.filter((r) => !mName || r.market === mName)
    setCohort({
      title: 'sellers replied', eyebrow: `${mName ?? w.scope.marketName ?? 'All markets'} · ${periodLabel(w)}`,
      items: rows.map((r) => ({
        key: r.threadKey, title: r.address ?? 'Seller conversation', sub: [r.market, r.intent ? r.intent.replace(/_/g, ' ') : null].filter(Boolean).join(' · '), at: r.at,
        tag: r.optOut ? 'opt-out' : r.positive ? 'interested' : undefined, tone: r.optOut ? 'bad' : r.positive ? 'good' : undefined,
        onOpen: () => pushRoutePath(`/inbox?thread=${encodeURIComponent(r.threadKey)}`),
      })),
      note: rows.length >= 120 ? 'Showing the 120 most recent.' : undefined,
      points: rows.map((r) => ({ lat: r.lat, lng: r.lng, label: r.address, id: r.propertyId ?? undefined })),
    })
  }, [w])

  const stageCohort = useCallback((s: Stage, kind: 'entered' | 'stalled') => {
    if (!w) return
    const rows = kind === 'stalled'
      ? w.cohorts.stalled.filter((o) => o.stage === s.code).map((o) => ({ key: o.opportunityId, title: o.address ?? 'Opportunity', sub: `${STAGE_SHORT[s.code]} · in stage since ${o.stageEnteredAt ? new Date(o.stageEnteredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}${o.market ? ` · ${o.market}` : ''}`, at: o.stageEnteredAt, tag: 'stalled', tone: 'bad' as const, onOpen: () => pushRoutePath(`/pipeline?opp=${encodeURIComponent(o.opportunityId)}`), p: o }))
      : w.cohorts.transitions.filter((t) => t.to === s.code).map((t, i) => ({ key: `${t.opportunityId}-${i}`, title: t.address ?? 'Opportunity', sub: `${STAGE_SHORT[t.from ?? ''] ?? '—'} → ${STAGE_SHORT[s.code]} · ${/autopilot|orchestrator/i.test(`${t.source} ${t.reason}`) ? 'autopilot' : 'operator'}${t.market ? ` · ${t.market}` : ''}`, at: t.at, onOpen: () => pushRoutePath(`/pipeline?opp=${encodeURIComponent(t.opportunityId)}`), p: t }))
    setCohort({
      title: kind === 'stalled' ? `stalled in ${s.label}` : `entered ${s.label}`, eyebrow: `S${s.index} · ${kind === 'stalled' ? `past ${s.stallThresholdDays} days · now` : periodLabel(w)}`,
      items: rows, points: rows.map((r) => ({ lat: r.p.lat, lng: r.p.lng, label: r.p.address, id: r.p.propertyId ?? undefined })),
    })
  }, [w])

  const inspected = useMemo(() => (w && inspect ? w.markets.find((m) => m.id === inspect) ?? null : null), [w, inspect])

  if (!w) {
    return (
      <div className="anx" data-theme={theme}>
        {loading ? (
          <div className="anx-boot" aria-busy="true"><div className="anx-boot__hero"><p><i />Reading the machine’s telemetry…</p></div><div className="anx-boot__map" /><div className="anx-boot__row" /></div>
        ) : (
          <div className="anx-empty"><Icon name="alert-circle" /><p>Analytics couldn’t load{error ? ` (${error})` : ''}. Nothing is shown rather than estimated numbers.</p><button type="button" className="anx-btn" onClick={() => setNonce((n) => n + 1)}><Icon name="refresh-cw" />Try again</button></div>
        )}
      </div>
    )
  }

  return (
    <div className={cls('anx', loading && 'is-refreshing', fullscreen && 'has-full')} data-theme={theme}>
      <header className="anx-top">
        <div className="anx-top__title">
          <span className="anx-eyebrow is-quiet"><i />Analytics</span>
          <h1>{w.scope.marketName ?? 'The machine'}</h1>
        </div>
        <div className="anx-ranges" role="tablist" aria-label="Period">
          {RANGES.map((r) => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} className={cls(range === r.key && 'is-on')} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
        <div className="anx-top__meta">
          <span>{periodLabel(w)} · vs prior {Math.round(w.period.days)}d</span>
          {w.scope.market ? <button type="button" className="anx-scope" onClick={() => setScope(null)}>{w.scope.marketName}<Icon name="close" /></button> : null}
          <span className="fresh"><i />live · {new Date(w.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
      </header>

      <Hero w={w} onCohort={() => replyCohort(scope)} />
      <Story w={w} />
      <Changes w={w} onMarket={(id) => { setGeoSel({ state: w.markets.find((m) => m.id === id)?.state ?? null, market: id }); setInspect(id) }} />

      <div className="anx-chapter"><span className="n">01</span><span className="t">Geography</span><i /><em>canonical markets</em></div>
      <AnalyticsGeo
        w={w} theme={theme}
        selection={geoSel} onSelect={setGeoSel}
        metricKey={metricKey} setMetricKey={setMetricKey}
        view={view} setView={setView} viz={viz} setViz={setViz}
        fullscreen={fullscreen} onFullscreen={() => setFullscreen((f) => !f)}
        onInspect={(id) => { setGeoSel({ state: w.markets.find((m) => m.id === id)?.state ?? null, market: id }); setInspect(id) }}
        onOpenMap={() => toMap(`Analytics · ${geoSel.market ? w.markets.find((m) => m.id === geoSel.market)?.name : 'seller replies'}`, w.cohorts.replies.filter((r) => !geoSel.market || r.market === w.markets.find((m) => m.id === geoSel.market)?.name).map((r) => ({ lat: r.lat, lng: r.lng, label: r.address, id: r.propertyId ?? undefined })))}
      />

      <div className="anx-chapter"><span className="n">02</span><span className="t">Momentum</span><i /><em>over the period</em></div>
      <Trend w={w} />

      <div className="anx-chapter"><span className="n">03</span><span className="t">Flow</span><i /><em>S1 → S9</em></div>
      <Flow w={w} onStage={stageCohort} />

      <div className="anx-chapter"><span className="n">04</span><span className="t">Campaigns</span><i /><em>quality, not volume</em></div>
      <Campaigns w={w} onOpen={(id) => pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(id)}`)} />

      <div className="anx-chapter"><span className="n">05</span><span className="t">Deals</span><i /><em>down-funnel truth</em></div>
      <DownFunnel w={w} onClosing={() => pushRoutePath('/closing-desk')} />

      <div className="anx-chapter"><span className="n">06</span><span className="t">Machine</span><i /><em>automation · transport</em></div>
      <Operations w={w} onQueue={() => pushRoutePath('/queue')} />

      <section className="anx-panel anx-buyers">
        <div className="anx-head"><span>Observed buyer activity</span><em>{w.buyers.dataThrough ? `data through ${new Date(w.buyers.dataThrough).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</em></div>
        <div className="anx-grid">
          <div><b><Count value={w.buyers.purchases} /></b><span>recorded purchases</span></div>
          <div><b><Count value={w.buyers.entities} /></b><span>distinct buyers</span></div>
          <div><b><Count value={w.buyers.repeatPurchases} /></b><span>by repeat buyers</span></div>
        </div>
        <p className="anx-note">Identity-resolved buyers’ arm’s-length purchases in the period{w.buyers.dataThrough && new Date(w.buyers.dataThrough) < new Date(w.period.start) ? ' — the recorded corpus ends before this period starts, so zero here means “not yet recorded”, not “no buyers”' : ''}. Not a demand score.</p>
      </section>

      <Method w={w} />

      {inspected ? (
        <MarketInspector
          m={inspected} w={w} theme={theme} onClose={() => setInspect(null)}
          onScope={() => { setScope(inspected.id); setInspect(null) }}
          onReplies={() => { setInspect(null); replyCohort(inspected.id) }}
          onMap={() => toMap(`Analytics · ${inspected.name}`, w.zips.filter((z) => z.market === inspected.id).map((z) => ({ lat: z.lat, lng: z.lng, label: `ZIP ${z.zip}` })))}
          onPipeline={() => pushRoutePath('/pipeline')}
          onCampaigns={() => pushRoutePath('/campaign-command')}
        />
      ) : null}
      {cohort ? <CohortSheet theme={theme} title={cohort.title} eyebrow={cohort.eyebrow} items={cohort.items} note={cohort.note} onClose={() => setCohort(null)} onMap={cohort.points?.some((p) => p.lat) ? () => toMap(`Analytics · ${cohort.title}`, cohort.points ?? []) : undefined} /> : null}
    </div>
  )
}

export default AnalyticsSurface
