import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushRoutePath, replaceRoutePath, useRouteLocation } from '../../app/router'
import { LCEmpty, LCSegmented, LCSelect, LCTabs } from '../../shared/lc'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { dataOf, miUrl, useMiQuery } from './mi-api'
import { MiContext, type MiCtx } from './mi-context'
import { MI_OPEN_GEO_EVENT } from './mi-handoffs'
import { MI_TABS, miPath, parseMiLocation, type MiRouteState, type MiTab } from './mi-route-state'
import type { MiDossier, MiGeoSummary, MiMetric, MiRegistry, MiStatusPayload } from './mi-types'
import { GeoInspector } from './ui/inspector'
import { ExploreBar, Provenance, QueryState, Warming } from './ui/parts'
import { Hero, MapModeSurface, OverviewSurface, RankingsSurface } from './ui/surfaces-core'
import { DemographicsSurface, InvestorsSurface, MultifamilySurface, TrendsSurface } from './ui/surfaces-detail'
import { CompareSurface, ScreenerSurface } from './ui/surfaces-tools'
import './market-intelligence.css'

/**
 * LEADCOMMAND MARKET INTELLIGENCE V1: "Where should we be hunting, what is
 * happening there, and why?" The primary object is a GEOGRAPHY (ZIP, city,
 * county, market, state, nationwide).
 *
 * Desktop instrument. Every number comes from GET /api/cockpit/market-intel
 * (one metric registry, one in-memory sales index, read-only). The app renders
 * values, samples and statuses and decides nothing: no eligibility, no
 * audience, no scores. Hand-offs open other apps; nothing here writes.
 */
const TAB_LABEL: Record<MiTab, string> = { overview: 'Overview', rankings: 'Rankings', map: 'Map', trends: 'Trends', investors: 'Investors', multifamily: 'Multifamily', demographics: 'Demographics', compare: 'Compare', screener: 'Screener' }
const WALL_MIN = 2400

function useRootWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    ro.current = new ResizeObserver((e) => setW(Math.round(e[0]?.contentRect.width ?? 0)))
    ro.current.observe(el)
  }, [])
  return [ref, w]
}

export default function MarketIntelligenceApp() {
  const { isPhone } = useBreakpoint()
  if (isPhone) return <LCEmpty title="Market Intelligence is a desktop instrument" body="Open LeadCommand on a desktop to rank, compare and screen markets." icon="grid" />
  return <MarketIntelligenceDesk />
}

function MarketIntelligenceDesk() {
  const location = useRouteLocation()
  const state = useMemo(() => parseMiLocation(location), [location])
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  const set = useCallback((patch: Partial<MiRouteState>, mode: 'replace' | 'push' = 'replace') => {
    const path = miPath({ ...stateRef.current, ...patch })
    if (mode === 'push') pushRoutePath(path)
    else replaceRoutePath(path)
  }, [])
  const [inspect, setInspect] = useState<string | null>(null)
  const regQ = useMiQuery<MiRegistry>(miUrl('registry'))
  const statusQ = useMiQuery<MiStatusPayload>(miUrl('status'))
  const registry = dataOf(regQ)
  const status = dataOf(statusQ)
  const byId = useMemo(() => new Map((registry?.metrics ?? []).map((m) => [m.id, m])), [registry])
  const metric = useCallback((id: string): MiMetric | undefined => byId.get(id), [byId])
  const openGeo = useCallback((id: string) => set({ geo: id, rl: null }, 'push'), [set])
  const addToCompare = useCallback((id: string) => set({ cmp: [...new Set([...stateRef.current.cmp, id])].slice(0, 6), tab: 'compare' }), [set])

  // A typed place from the Command Deck (?q=): open its best match.
  const resolveQ = useMiQuery<{ results: MiGeoSummary[] }>(state.q && status ? miUrl('search', { q: state.q, limit: 1 }) : null)
  useEffect(() => {
    if (!state.q || resolveQ.kind !== 'ready') return
    const hit = resolveQ.data.results[0]
    set(hit ? (state.tab === 'screener' ? { sw: hit.id, geo: hit.id, q: null } : { geo: hit.id, q: null }) : { q: null })
  }, [resolveQ, state.q, state.tab, set])

  // The Map's MI lens: a clicked area opens here (this instance).
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<{ id?: string }>).detail?.id; if (id) setInspect(id) }
    window.addEventListener(MI_OPEN_GEO_EVENT, on)
    return () => window.removeEventListener(MI_OPEN_GEO_EVENT, on)
  }, [])

  const dossierQ = useMiQuery<MiDossier>(status ? miUrl('dossier', { id: state.geo, period: state.period, asset: state.asset }) : null)
  const d = dataOf(dossierQ)
  const [rootRef, width] = useRootWidth()
  const wall = width >= WALL_MIN
  const wallMode = wall && state.tab === 'overview'
  const fill = state.tab === 'rankings' || state.tab === 'screener'
  const ctx: MiCtx = { state, set, registry, metric, status, inspect, setInspect, openGeo, addToCompare }
  const assets = status?.asset_filters ?? [{ id: 'all', label: 'All', available: true }]

  return (
    <MiContext.Provider value={ctx}>
      <div className={`mi${wall ? ' is-wall' : ''}`} ref={rootRef}>
        <div className="mi-top">
          <div className="mi-top__brand"><span className="mi-mark" aria-hidden="true" />Market Intelligence</div>
          <ExploreBar onPick={openGeo} />
          <LCSegmented label="Period" size="sm" value={state.period} onChange={(v) => set({ period: v })} options={(status?.periods ?? [{ id: '1y', label: '1Y' }]).map((p) => ({ value: p.id, label: p.label }))} />
          <LCSelect label="Asset class" prefix="Asset" variant="chip" size="sm" value={state.asset} onChange={(v) => set({ asset: v })}
            options={assets.map((a) => ({ value: a.id, label: a.label, disabled: !a.available, hint: a.available ? undefined : 'No sale of this class in the corpus' }))} />
        </div>
        <LCTabs label="Market Intelligence sections" value={state.tab} onChange={(t) => set({ tab: t as MiTab })} items={MI_TABS.map((t) => ({ id: t, label: TAB_LABEL[t], count: t === 'compare' && state.cmp.length ? state.cmp.length : undefined }))} />
        <div className="mi-body">
          {/* ONE scroll root per surface. Grid surfaces (Rankings, Screener) and the ultrawide wall
              do not scroll the page: the grid / each wall column is the scroll root, so a wheel over a
              grid is never trapped inside a page that also scrolls. */}
          <main className={`mi-main${fill ? ' is-fill' : ''}${wallMode ? ' is-wall' : ''}`} aria-label={TAB_LABEL[state.tab]} key={`${state.tab}|${state.geo}`}>
            {statusQ.kind === 'warming' ? <Warming w={statusQ.warming} /> : (
              <QueryState q={dossierQ}>{(dd) => (
                <>
                  {state.tab !== 'compare' ? <Hero d={dd} compact={fill || wallMode} /> : null}
                  {state.tab === 'overview' ? (wallMode ? (
                    <div className="mi-wall">
                      <div className="mi-wall__col mi-wall__rank"><RankingsSurface geo={dd.geography} /></div>
                      <div className="mi-wall__col mi-wall__mid"><OverviewSurface d={dd} wall /><TrendsSurface d={dd} /></div>
                      <div className="mi-wall__col mi-wall__side"><InvestorsSurface d={dd} /><DemographicsSurface d={dd} /></div>
                    </div>
                  ) : <OverviewSurface d={dd} />) : null}
                  {state.tab === 'rankings' ? <RankingsSurface geo={dd.geography} /> : null}
                  {state.tab === 'map' ? <MapModeSurface geo={dd.geography} /> : null}
                  {state.tab === 'trends' ? <TrendsSurface d={dd} /> : null}
                  {state.tab === 'investors' ? <InvestorsSurface d={dd} /> : null}
                  {state.tab === 'multifamily' ? <MultifamilySurface geo={dd.geography} /> : null}
                  {state.tab === 'demographics' ? <DemographicsSurface d={dd} /> : null}
                  {state.tab === 'compare' ? <CompareSurface /> : null}
                  {state.tab === 'screener' ? <ScreenerSurface geo={dd.geography} /> : null}
                </>
              )}</QueryState>
            )}
          </main>
          {inspect ? <aside className="mi-side"><GeoInspector id={inspect} /></aside> : null}
        </div>
        <footer className="mi-foot"><Provenance extra={d ? <span>{d.window.from} → {d.window.to} · {d.window.asset_label}</span> : null} /></footer>
      </div>
    </MiContext.Provider>
  )
}
