import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from 'react'
import { LCEmpty, LCError, LCFilterInspector, LCSkeleton, LCTabs, cx, useLcReducedMotion } from '../../../shared/lc'
import { useClaimedKeys } from '../../../shared/lc/keys'
import { pushRoutePath } from '../../../app/router'
import { useAppInstance } from '../../../modules/desktop/workspace/instance-context'
import { openApp } from '../../../modules/desktop/workspace/workspace-store'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import {
  filterCount, fmtMoney, NO_FILTERS, saleAgeDays, unitValue, type CompFilters, type ExplainContext,
} from '../../../domain/comp-intelligence/comps-workstation-model'
import { AnalyticsCharts } from './AnalyticsCharts'
import { CompareMode } from './CompareMode'
import { CompInspector } from './CompInspector'
import { deriveWorkstation, type Lens } from './derive-workstation'
import { EvidenceMode } from './EvidenceMode'
import type { CameraAction, MapPoint } from './EvidenceMap'
import { buildFilterSections } from './filter-sections'
import { createFocusStore } from './focus-store'
import { MapStage } from './MapStage'
import { robustDomain, type MapMode } from './map-style'
import { MarketMode } from './MarketMode'
import { ModelMode } from './ModelMode'
import { SubjectStrip } from './SubjectStrip'
import { useCompsSubject } from './use-comps-subject'
import { useCompsWorkspace } from './use-comps-workspace'
import { useOperatorSet } from './use-operator-set'
import { ValuationMode } from './ValuationMode'
import './comps-workstation.css'

type PlaneMode = 'evidence' | 'valuation' | 'compare' | 'market' | 'model'
type WidthTier = 'stack' | 'split' | 'wide' | 'ultra'

/** Internal layout follows the pane, not the window: a 50% pane on a 49″ screen is still a split. */
const tierFor = (w: number): WidthTier => (w < 760 ? 'stack' : w < 1560 ? 'split' : w < 2600 ? 'wide' : 'ultra')

function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
  return () => mo.disconnect()
}
const readTheme = () => document.documentElement.getAttribute('data-nexus-theme') || 'dark'

/**
 * COMP INTELLIGENCE 5.0 — the spatial valuation workstation (desktop).
 *
 *   SUBJECT    the strip: identity, record facts, the engine's value range
 *   EVIDENCE   the map: subject, the shown set, the universe, the excluded
 *   VALUATION  the plane: evidence → valuation → confidence → decision
 *              support, the operator's set priced by the engine's own
 *              formula beside the immutable system set
 *
 * Nothing here writes: the operator set lives in this browser session.
 */
export function CompsWorkstation({ hostPropertyId }: { hostPropertyId: string | null }) {
  const subject = useCompsSubject(hostPropertyId)
  const ws = useCompsWorkspace(subject.propertyId)
  const reduced = useLcReducedMotion()
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'dark')
  const [store] = useState(createFocusStore)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [plane, setPlane] = useState<PlaneMode>('evidence')
  const [lens, setLens] = useState<Lens>('operator')
  const [filters, setFilters] = useState<CompFilters>(NO_FILTERS)
  const [mapMode, setMapMode] = useState<MapMode>('evidence')
  const [imagery, setImagery] = useState(false)
  const [inspect, setInspect] = useState<string | null>(null)
  const [camera, setCamera] = useState<CameraAction | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)

  // A new subject is a fresh analysis: no inspector, no filters carried over.
  const [seenPid, setSeenPid] = useState(subject.propertyId)
  if (seenPid !== subject.propertyId) {
    setSeenPid(subject.propertyId)
    setInspect(null)
    setFilters(NO_FILTERS)
    setLens('operator')
  }

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver((e) => setWidth(Math.round(e[0]?.contentRect.width ?? 0)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const tier = tierFor(width || 1200)

  const data = ws.data && ws.data.subject.propertyId === subject.propertyId ? ws.data : null
  const systemKeys = useMemo(() => new Set((data?.comps ?? []).filter((c) => c.state === 'system').map((c) => c.key)), [data])
  const operator = useOperatorSet(subject.propertyId, systemKeys)
  const m = useMemo(() => (data ? deriveWorkstation(data, operator.state, operator.keys, lens, filters) : null), [data, operator.state, operator.keys, lens, filters])

  const ctx: ExplainContext | null = useMemo(() => (m ? {
    subject: m.w.subject,
    rules: m.rules,
    outlierBand: m.band,
    setMedianDistance: m.depth.medianDistance,
    now: m.now,
  } : null), [m])

  const points: MapPoint[] = useMemo(() => {
    if (!m) return []
    const out: MapPoint[] = []
    for (const [key, t] of m.tiers) {
      const c = m.byKey.get(key)
      if (!c || c.lat === null || c.lng === null) continue
      const adj = c.engine?.adjustedPrice ?? null
      out.push({
        key, lat: c.lat, lng: c.lng, tier: t,
        unit: unitValue(c, m.metric), price: c.salePrice, age: saleAgeDays(c, m.now), score: c.engine?.eligible ? c.engine.score ?? null : null,
        label: fmtMoney(c.salePrice) ?? '',
        flagged: Boolean(m.band && adj !== null && t !== 'excluded' && (adj < m.band.low || adj > m.band.high)),
      })
    }
    return out
  }, [m])

  const domain = useMemo(() => {
    if (mapMode === 'evidence') return null
    const vals = points.filter((p) => p.tier !== 'excluded').map((p) => (mapMode === 'ppsf' ? p.unit : mapMode === 'price' ? p.price : mapMode === 'recency' ? p.age : p.score)).filter((v): v is number => v !== null)
    return robustDomain(vals)
  }, [mapMode, points])

  const openComp = useCallback((key: string) => { store.select(key); setInspect(key) }, [store])
  const closeInspector = useCallback(() => { setInspect(null); store.select(null) }, [store])
  const { include: opInclude, exclude: opExclude, reset: opReset, start: opStart } = operator
  const include = useCallback((c: EvidenceComp) => { opInclude(c); setLens('operator') }, [opInclude])
  const exclude = useCallback((c: EvidenceComp) => { opExclude(c); setLens('operator') }, [opExclude])

  const pid = subject.propertyId
  // inside a workspace pane the hand-off opens BESIDE (Comps keeps its place); elsewhere it navigates
  const inPane = useAppInstance().instanceId !== null
  const handOff = useCallback((path: string) => { if (!inPane || openApp(path, 'beside') === 'refused') pushRoutePath(path) }, [inPane])
  const openDeal = useCallback(() => { if (pid) handOff(`/deal-intelligence?property_id=${encodeURIComponent(pid)}`) }, [pid, handOff])
  const openGraph = useCallback((id?: string | null) => { const target = id ?? pid; if (target) handOff(`/entity-graph/property/${encodeURIComponent(target)}`) }, [pid, handOff])
  const openMap = useCallback(() => {
    if (!m) return
    const s = m.w.subject
    writeMapFocusSet({
      label: `Comps for ${s.address ?? 'subject'}`,
      tone: 'property',
      points: [
        ...(s.lat !== null && s.lng !== null ? [{ lat: s.lat, lng: s.lng, id: s.propertyId, label: `Subject · ${s.address ?? ''}` }] : []),
        ...m.lensComps.filter((c) => c.lat !== null && c.lng !== null).map((c) => ({ lat: c.lat as number, lng: c.lng as number, id: c.propertyId ?? c.key, label: `${fmtMoney(c.salePrice) ?? ''} · ${c.address ?? ''}` })),
      ],
    })
    pushRoutePath('/map')
  }, [m])

  const { setWindow: requestWindow } = ws
  const setWindow = useCallback((radius: number | null, months: number | null) => {
    const ew = m?.w.query.engineWindow
    const isEngine = ew && radius === ew.radiusMiles && months === ew.months
    requestWindow(isEngine || (radius === null && months === null) ? { radius: null, months: null } : { radius, months })
  }, [m, requestWindow])

  // M focuses the map, F opens the filters — claimed only while the operator is working in this pane.
  useClaimedKeys(['m', 'f'], focusWithin)
  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="dialog"]')) return
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); rootRef.current?.querySelector<HTMLElement>('.maplibregl-canvas')?.focus() }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setPlane('evidence'); setFiltersOpen(true) }
  }

  const rootProps = {
    ref: rootRef,
    className: cx('ciw', `is-${tier}`),
    'data-comp-intelligence': 'desktop',
    'data-tier': tier,
    onFocus: () => setFocusWithin(true),
    onBlur: (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false) },
    onKeyDown: onRootKey,
  }

  if (!subject.propertyId) {
    return (
      <div {...rootProps} data-state="empty">
        <div className="ciw-center">
          <LCEmpty icon="pin" title="Choose a subject to value" body={<>Search for a property in the command bar, or open Comp Intelligence from Deal Intelligence, the Inbox, the Map or the Pipeline — it loads that property and its comparable sales.</>} />
        </div>
      </div>
    )
  }

  if (!m || !ctx) {
    const failure = ws.failure
    return (
      <div {...rootProps} data-state={failure ? 'error' : 'resolving'}>
        <header className="ciw-strip is-skeleton" aria-hidden="true">
          <span className="ciw-strip__photo" />
          <LCSkeleton shape="lines" count={3} className="ciw-strip__skel" />
        </header>
        <div className="ciw-body">
          <div className="ciw-map is-placeholder">
            <div className="ciw-center">
              {failure?.kind === 'not_found' ? (
                <LCEmpty icon="alert-circle" title="This property isn’t in the property record" body="The subject id does not resolve to a property, so there is nothing to value." />
              ) : failure ? (
                <LCError what="Comparable evidence unavailable" detail={failure.detail} onRetry={ws.retry} retryLabel="Retry" />
              ) : (
                <div className="ciw-resolving" role="status" aria-live="polite">
                  <span className="lc-eyebrow">Resolving subject</span>
                  <b>Loading the property record, the engine’s pricing set and the recorded sales around it</b>
                  <span>One read — the subject, the engine’s stored run, its candidate pool and the transaction corpus inside the engine’s own search window.</span>
                </div>
              )}
            </div>
          </div>
          <aside className="ciw-plane is-skeleton" aria-hidden="true"><LCSkeleton shape="rows" count={7} /></aside>
        </div>
      </div>
    )
  }

  const wideCharts = tier === 'wide' || tier === 'ultra'
  const inspected = inspect ? m.byKey.get(inspect) ?? null : null
  const inspectedTier = inspected ? m.tiers.get(inspected.key) ?? (inspected.state === 'excluded' ? 'excluded' : 'candidate') : null
  const changes = operator.state ? operator.state.versions.length : 0
  const broaden = m.w.query.radiusMiles < 10 ? () => setWindow(m.w.query.radiusOptions.find((r) => r > m.w.query.radiusMiles) ?? 10, Math.max(m.w.query.months, 36)) : null
  const bgCount = points.filter((p) => p.tier === 'candidate' || p.tier === 'excluded').length

  const filterPanel = (
    <LCFilterInspector
      sections={buildFilterSections(filters, setFilters, m.kind)}
      activeCount={filterCount(filters)}
      cohort={m.candidates.length}
      cohortNoun="candidates"
      onClear={() => setFilters(NO_FILTERS)}
      onClose={() => setFiltersOpen(false)}
    />
  )

  const planeBody = plane === 'evidence' ? (
    <EvidenceMode
      m={m} ctx={ctx} store={store} filters={filters} onFilters={setFilters} filtersOpen={filtersOpen} onFiltersOpen={setFiltersOpen} filterPanel={filterPanel}
      onLens={setLens} onOpen={(c) => openComp(c.key)} onInclude={include} onExclude={exclude} onReset={opReset} onStart={() => opStart(m.candidates.slice(0, 6))} changes={changes}
    />
  ) : plane === 'valuation' ? (
    <ValuationMode m={m} store={store} charts={wideCharts ? null : <AnalyticsCharts m={m} store={store} layout="inline" />} onBroaden={broaden} onShowEvidence={() => setPlane('evidence')} onOpenMap={openMap} onOpenDeal={openDeal} />
  ) : plane === 'compare' ? (
    <CompareMode m={m} store={store} onOpen={(c) => openComp(c.key)} />
  ) : plane === 'market' ? (
    <MarketMode m={m} />
  ) : (
    <ModelMode m={m} store={store} />
  )

  return (
    <div {...rootProps} data-state="ready" data-lens={m.lens} data-subject={m.w.subject.propertyId}>
      <SubjectStrip m={m} pinned={subject.pinned} pinLabel={subject.pinLabel} onOpenDeal={openDeal} onOpenGraph={() => openGraph()} onOpenMap={openMap} onStreetView={null} refreshing={ws.loading} />
      <div className="ciw-body">
        <MapStage
          m={m} points={points} mode={mapMode} onMode={setMapMode} domain={domain} imagery={imagery} onImagery={() => setImagery((v) => !v)}
          theme={theme} store={store} onOpen={openComp} camera={camera} onCamera={(kind) => setCamera((c) => ({ kind, n: (c?.n ?? 0) + 1 }))}
          reduced={reduced} mapReady={mapReady} onMapReady={() => setMapReady(true)}
          radius={ws.request.radius ?? m.w.query.radiusMiles} months={ws.request.months ?? m.w.query.months} onWindow={setWindow}
          refreshing={ws.loading} clustered={bgCount > 80}
        >
          <CompInspector
            m={m} c={inspected} tier={inspectedTier} ctx={ctx} onClose={closeInspector} onInclude={include} onExclude={exclude}
            onGraph={(c) => openGraph(c.propertyId)} onFocusLinked={(c) => { if (c.propertyId) subject.handOff(c.propertyId, c.address) }}
          />
        </MapStage>

        <aside className="ciw-plane" aria-label="Evidence and valuation">
          <div className="ciw-plane__head">
            <LCTabs
              label="Comp Intelligence modes"
              value={plane}
              onChange={(v) => setPlane(v as PlaneMode)}
              items={[
                { id: 'evidence', label: 'Evidence' },
                { id: 'valuation', label: 'Valuation' },
                { id: 'compare', label: 'Compare' },
                { id: 'market', label: 'Market' },
                { id: 'model', label: 'Model' },
              ]}
            />
          </div>
          <div className="ciw-plane__body lc-scroll" key={plane}>{planeBody}</div>
        </aside>

        {wideCharts ? (
          <aside className="ciw-insights lc-scroll" aria-label="Evidence charts">
            <AnalyticsCharts m={m} store={store} layout={tier === 'ultra' ? 'grid' : 'column'} />
          </aside>
        ) : null}
      </div>
      <span className="ciw-sr" aria-live="polite">{m.lens === 'operator' && m.operatorReplay?.result ? `Your set: central ${fmtMoney(m.operatorReplay.result.mid)}, confidence ${m.operatorReplay.result.confidence}` : ''}</span>
    </div>
  )
}
