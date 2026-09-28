/**
 * COMPS INTELLIGENCE — mobile valuation-evidence surface.
 *
 *   SUBJECT    anchored hero; never lost while exploring
 *   EVIDENCE   map + synced comp gallery; System vs Your set; candidates and
 *              excluded sales with the engine's own reasons
 *   CONCLUSION evidence range + $/sq ft distribution beside (never merged
 *              with) the Deal Intelligence value
 *
 * The operator's set is a local evidence preview: it starts as the engine's
 * pricing set, changes with every tap, resets on demand, and is never
 * written back or presented as the canonical valuation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import type { CompsWorkspace, EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { ageLabel, fetchCompsWorkspace, money, statsFor } from '../../../domain/comp-intelligence/comps-evidence-api'
import { CompCard, EvidenceReadout, EvidenceStrip, SubjectHero, cls } from './CompsEvidenceParts'
import { CompsEvidenceMap } from './CompsEvidenceMap'
import { InteractiveStreetViewPanorama } from '../../../modules/deal-intelligence/InteractiveStreetViewPanorama'
import './comps-evidence.css'
import './comps-evidence-liquid.css'

type View = 'set' | 'candidates' | 'excluded' | 'all'
type Sort = 'engine' | 'nearest' | 'newest' | 'price' | 'ppsf' | 'size' | 'year'
type Preset = 'none' | 'tight' | 'recent' | 'same_zip' | 'arms' | 'cash' | 'company'

const SORTS: Array<{ key: Sort; label: string }> = [
  { key: 'engine', label: 'Engine rank' },
  { key: 'nearest', label: 'Nearest' },
  { key: 'newest', label: 'Newest' },
  { key: 'price', label: 'Price' },
  { key: 'ppsf', label: '$/sq ft' },
  { key: 'size', label: 'Size match' },
  { key: 'year', label: 'Age match' },
]

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'tight', label: 'Tight' },
  { key: 'recent', label: 'Last 12 mo' },
  { key: 'same_zip', label: 'Same ZIP' },
  { key: 'arms', label: 'Arm’s-length' },
  { key: 'cash', label: 'Cash' },
  { key: 'company', label: 'Company buyer' },
]

function readTheme(): string {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-nexus-theme') || 'dark'
}

export function CompsEvidenceSurface({ propertyId }: { propertyId: string }) {
  const [radius, setRadius] = useState(1)
  const [months, setMonths] = useState(24)
  const [w, setW] = useState<CompsWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inSet, setInSet] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>('set')
  const [sort, setSort] = useState<Sort>('engine')
  const [preset, setPreset] = useState<Preset>('none')
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [inspect, setInspect] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const [imagery, setImagery] = useState(false)
  const [tilt, setTilt] = useState(true)
  const [lookAround, setLookAround] = useState(false)
  const [theme, setTheme] = useState(readTheme)
  const railRef = useRef<HTMLDivElement | null>(null)
  const firstLoad = useRef(true)

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => mo.disconnect()
  }, [])

  // A subject change is a fresh start; radius/window changes keep the operator's set.
  useEffect(() => { firstLoad.current = true; setRadius(1); setMonths(24); setFocusKey(null); setInspect(null) }, [propertyId])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    fetchCompsWorkspace({ propertyId, radius, months }, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return
        setW(data)
        const systemKeys = data.comps.filter((c) => c.state === 'system').map((c) => c.key)
        setInSet((cur) => {
          if (firstLoad.current || !cur.size) return new Set(systemKeys)
          const keep = new Set([...cur].filter((k) => data.comps.some((c) => c.key === k)))
          return keep.size ? keep : new Set(systemKeys)
        })
        if (firstLoad.current) {
          setView('set')
          // A subject with no engine set still needs evidence to look at.
          if (!systemKeys.length) setInSet(new Set(data.comps.filter((c) => c.state === 'candidate').sort((a, b) => (b.engine?.weight ?? -1) - (a.engine?.weight ?? -1)).slice(0, 6).map((c) => c.key)))
        }
        firstLoad.current = false
      })
      .catch((e: Error) => { if (!ctrl.signal.aborted) setError(e.message) })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [propertyId, radius, months])

  const systemKeys = useMemo(() => new Set((w?.comps ?? []).filter((c) => c.state === 'system').map((c) => c.key)), [w])
  // With no engine analysis there is no System set; the baseline is the engine's
  // top-ranked eligible candidates, labelled as a starter set, never as "system".
  const baselineKeys = useMemo(() => (systemKeys.size ? systemKeys : new Set((w?.comps ?? [])
    .filter((c) => c.state === 'candidate')
    .sort((a, b) => (b.engine?.weight ?? -1) - (a.engine?.weight ?? -1))
    .slice(0, 6).map((c) => c.key))), [systemKeys, w])
  const isSystem = useMemo(() => baselineKeys.size === inSet.size && [...inSet].every((k) => baselineKeys.has(k)), [baselineKeys, inSet])
  const setComps = useMemo(() => (w?.comps ?? []).filter((c) => inSet.has(c.key)), [w, inSet])
  const stats = useMemo(() => statsFor(setComps), [setComps])
  const multi = ['multifamily', 'apartment'].includes(w?.subject.family ?? '')

  const visible = useMemo(() => {
    if (!w) return []
    const s = w.subject
    let rows = w.comps.filter((c) => (
      view === 'all' ? true
        : view === 'set' ? inSet.has(c.key)
          : view === 'candidates' ? c.state !== 'excluded' && !inSet.has(c.key)
            : c.state === 'excluded'))
    if (preset === 'tight') rows = rows.filter((c) => (c.distanceMiles ?? 9) <= 0.75 && c.assetMatch && (c.compare.sqftPct === null || Math.abs(c.compare.sqftPct) <= 20))
    if (preset === 'recent') rows = rows.filter((c) => (c.compare.days ?? 9999) <= 365)
    if (preset === 'same_zip') rows = rows.filter((c) => c.zip && s.zip && c.zip.slice(0, 5) === s.zip.slice(0, 5))
    if (preset === 'arms') rows = rows.filter((c) => c.armsLength === true)
    if (preset === 'cash') rows = rows.filter((c) => c.cash === true)
    if (preset === 'company') rows = rows.filter((c) => c.buyerKind === 'company')
    const by: Record<Sort, (a: EvidenceComp, b: EvidenceComp) => number> = {
      engine: (a, b) => (b.engine?.weight ?? -1) - (a.engine?.weight ?? -1) || (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99),
      nearest: (a, b) => (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99),
      newest: (a, b) => (a.compare.days ?? 1e6) - (b.compare.days ?? 1e6),
      price: (a, b) => (b.salePrice ?? 0) - (a.salePrice ?? 0),
      ppsf: (a, b) => (b.ppsf ?? 0) - (a.ppsf ?? 0),
      size: (a, b) => Math.abs(a.compare.sqftPct ?? 999) - Math.abs(b.compare.sqftPct ?? 999),
      year: (a, b) => Math.abs(a.compare.years ?? 999) - Math.abs(b.compare.years ?? 999),
    }
    return [...rows].sort(by[sort])
  }, [w, view, inSet, preset, sort])

  const toggle = useCallback((key: string) => {
    setInSet((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) try { navigator.vibrate(8) } catch { /* ignore */ }
  }, [])

  // Map / chart tap → bring the card into view.
  const focusFromMap = useCallback((key: string) => {
    setFocusKey(key)
    const inView = visible.some((c) => c.key === key)
    if (!inView) setView('all')
    window.setTimeout(() => {
      const el = railRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }, inView ? 0 : 80)
  }, [visible])

  // Swiping the gallery quietly updates map focus.
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    let t = 0
    const onScroll = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        const mid = rail.scrollLeft + rail.clientWidth / 2
        let best: string | null = null
        let bestD = Infinity
        rail.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => {
          const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid)
          if (d < bestD) { bestD = d; best = el.dataset.key ?? null }
        })
        if (best) setFocusKey(best)
      }, 90)
    }
    rail.addEventListener('scroll', onScroll, { passive: true })
    return () => rail.removeEventListener('scroll', onScroll)
  }, [visible])

  useBackHandler(Boolean(inspect), 'comps:inspect', 'Comp', () => { setInspect(null); return true })
  useBackHandler(sheet, 'comps:filters', 'Filters', () => { setSheet(false); return true })
  useBackHandler(lookAround, 'comps:look', 'Street View', () => { setLookAround(false); return true })

  const openMap = () => {
    if (!w) return
    const pts = [
      ...(w.subject.lat !== null && w.subject.lng !== null ? [{ lat: w.subject.lat, lng: w.subject.lng, id: w.subject.propertyId, label: `Subject · ${w.subject.address ?? ''}` }] : []),
      ...setComps.filter((c) => c.lat !== null && c.lng !== null).map((c) => ({ lat: c.lat as number, lng: c.lng as number, id: c.propertyId ?? c.key, label: `${money(c.salePrice) ?? ''} · ${c.address ?? ''}` })),
    ]
    writeMapFocusSet({ label: `Comps for ${w.subject.address ?? 'subject'}`, tone: 'property', points: pts })
    pushRoutePath('/map')
  }
  const openGraph = (pid?: string | null) => { const id = pid ?? w?.subject.propertyId; if (id) pushRoutePath(`/entity-graph/property/${encodeURIComponent(id)}`) }
  const openBuyer = (buyerId: string) => pushRoutePath(`/entity-graph?buyer=${encodeURIComponent(buyerId)}`)
  const openDeal = () => { if (w) pushRoutePath(`/deal-intelligence?property_id=${encodeURIComponent(w.subject.propertyId)}`) }

  if (!w) {
    return (
      <div className="cev" data-theme={theme}>
        {loading ? (
          <div className="cev-boot" aria-busy="true"><div className="cev-boot__hero"><p className="cev-boot__label"><i />Gathering recorded sales around the subject…</p></div><div className="cev-boot__map" /><div className="cev-boot__row" /></div>
        ) : (
          <div className="cev-empty"><Icon name="alert-circle" /><p>{error === 'property_not_found' ? 'This property isn’t in the property record.' : 'Couldn’t load comparable sales.'}</p></div>
        )}
      </div>
    )
  }

  const inspected = w.comps.find((c) => c.key === inspect) ?? null
  const focusIndex = Math.max(0, visible.findIndex((c) => c.key === focusKey))
  const dotsPrice = w.comps.filter((c) => c.salePrice).map((c) => ({ key: c.key, v: c.salePrice as number, inSet: inSet.has(c.key), excluded: c.state === 'excluded' }))
  const unitMetric = multi ? 'ppu' : 'ppsf'
  const dotsUnit = w.comps.filter((c) => c[unitMetric]).map((c) => ({ key: c.key, v: c[unitMetric] as number, inSet: inSet.has(c.key), excluded: c.state === 'excluded' }))
  const subjectImplied = !multi && w.conclusion?.valueMid && w.subject.sqft ? Math.round(w.conclusion.valueMid / w.subject.sqft) : multi && w.conclusion?.valueMid && w.subject.units ? Math.round(w.conclusion.valueMid / w.subject.units) : null
  const counts = {
    set: inSet.size,
    candidates: w.comps.filter((c) => c.state !== 'excluded' && !inSet.has(c.key)).length,
    excluded: w.comps.filter((c) => c.state === 'excluded').length,
    all: w.comps.length,
  }

  return (
    <div className={cls('cev', loading && 'is-refreshing')} data-theme={theme}>
      <SubjectHero w={w} onMap={openMap} onGraph={() => openGraph()} onDeal={openDeal} onLookAround={() => setLookAround(true)} />

      <Chapter n="01" title="Evidence" note={isSystem ? (systemKeys.size ? 'engine pricing set' : 'starter set') : 'your set'} />
      <EvidenceReadout w={w} stats={stats} isSystem={isSystem} hasSystem={systemKeys.size > 0} setCount={inSet.size} onReset={() => setInSet(new Set(baselineKeys))} />

      <Chapter n="02" title="Location" note={`${w.query.radiusMiles} mi · ${w.query.months} mo`} />
      <section className="cev-mapwrap">
        <CompsEvidenceMap
          subject={{ lat: w.subject.lat, lng: w.subject.lng, address: w.subject.address }}
          comps={w.comps}
          inSet={inSet}
          focusKey={focusKey}
          onFocus={focusFromMap}
          radiusMiles={w.query.radiusMiles}
          imagery={imagery}
          theme={theme}
          tilt={tilt}
        />
        <div className="cev-mapbar">
          <button type="button" className={cls('cev-chip', imagery && 'is-on')} onClick={() => setImagery((v) => !v)}><Icon name="globe" />{imagery ? 'Imagery' : 'Streets'}</button>
          <button type="button" className={cls('cev-chip', tilt && 'is-on')} onClick={() => setTilt((v) => !v)}>{tilt ? '3D' : '2D'}</button>
          <button type="button" className="cev-chip" onClick={() => setSheet(true)}><Icon name="filter" />{w.query.radiusMiles} mi · {w.query.months} mo</button>
        </div>
      </section>

      <Chapter n="03" title="Comparables" note={`${counts.all} sales judged`} />
      <nav className="cev-views" role="tablist" aria-label="Comparable sets" style={{ '--vi': (['set', 'candidates', 'excluded', 'all'] as View[]).indexOf(view) } as CSSProperties}>
        <span className="cev-views__ink" aria-hidden="true" />
        {([['set', 'Your set'], ['candidates', 'Candidates'], ['excluded', 'Excluded'], ['all', 'All']] as Array<[View, string]>).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={cls('cev-views__tab', view === k && 'is-on')} onClick={() => setView(k)}>
            {label}<b>{counts[k]}</b>
          </button>
        ))}
      </nav>

      <div className="cev-chipbar" role="toolbar" aria-label="Refine">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" className={cls('cev-chip', preset === p.key && 'is-on')} onClick={() => setPreset((cur) => (cur === p.key ? 'none' : p.key))}>{p.label}</button>
        ))}
      </div>
      <div className="cev-sortbar">
        <span>Sort</span>
        <div className="cev-sortbar__opts">
          {SORTS.map((s) => <button key={s.key} type="button" className={cls(sort === s.key && 'is-on')} onClick={() => setSort(s.key)}>{s.label}</button>)}
        </div>
      </div>

      {visible.length ? (
        <div className="cev-rail" ref={railRef} role="list" aria-label="Comparable sales">
          {visible.map((c, i) => (
            <div role="listitem" key={c.key} style={{ '--i': Math.min(i, 8) } as CSSProperties}>
              <CompCard c={c} inSet={inSet.has(c.key)} focus={focusKey === c.key} near={Math.abs(i - focusIndex) <= 2} multi={multi} onToggle={() => toggle(c.key)} onOpen={() => { setFocusKey(c.key); setInspect(c.key) }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="cev-none">
          <p>{view === 'set' && counts.candidates > 0 ? 'Your set is empty — add candidates to build evidence.' : counts.candidates === 0 && counts.excluded > 0 && view !== 'excluded' ? `No admissible same-type sales within ${w.query.radiusMiles} mi / ${w.query.months} mo — ${counts.excluded} nearby sales were rejected. Open Excluded to see why each one can’t price this property.` : 'No comparable sales match this view within the current radius and window.'}</p>
          <div>
            {w.query.radiusMiles < 10 ? <button type="button" className="cev-chip is-on" onClick={() => setRadius(w.query.radiusOptions.find((r) => r > w.query.radiusMiles) ?? 10)}>Expand radius</button> : null}
            {w.query.months < 36 ? <button type="button" className="cev-chip" onClick={() => setMonths(w.query.monthOptions.find((m) => m > w.query.months) ?? 36)}>Expand window</button> : null}
            {preset !== 'none' ? <button type="button" className="cev-chip" onClick={() => setPreset('none')}>Clear preset</button> : null}
            {view !== 'excluded' && counts.excluded > 0 ? <button type="button" className="cev-chip" onClick={() => setView('excluded')}>Why excluded</button> : null}
          </div>
        </div>
      )}

      {dotsPrice.length || dotsUnit.length ? <Chapter n="04" title="Distribution" note="where the evidence sits" /> : null}
      <EvidenceStrip
        title="Sale price evidence"
        dots={dotsPrice}
        fmt={(n) => money(n) ?? ''}
        focusKey={focusKey}
        onFocus={focusFromMap}
        markers={[
          { key: 'value', label: 'Deal value', v: w.conclusion?.valueMid ?? null, tone: 'value' },
          { key: 'ask', label: 'Ask', v: w.conclusion?.ask ?? null, tone: 'ask' },
          { key: 'offer', label: 'Offer', v: w.conclusion?.recommendedOffer ?? null, tone: 'offer' },
        ]}
        note={<>Filled dots are your set; hollow dots are excluded. Deal value, ask and offer are shown for context — the comp median is not the subject’s value.</>}
      />
      <EvidenceStrip
        title={multi ? 'Price per unit' : 'Price per sq ft'}
        dots={dotsUnit}
        fmt={(n) => (multi ? money(n) ?? '' : `$${Math.round(n)}`)}
        focusKey={focusKey}
        onFocus={focusFromMap}
        markers={subjectImplied ? [{ key: 'implied', label: 'Subject implied', v: subjectImplied, tone: 'value' }] : []}
        note={subjectImplied ? <>Subject implied = Deal Intelligence value ÷ subject {multi ? 'units' : 'sq ft'}.</> : null}
      />

      {w.market ? <Chapter n="05" title="Market" note={`ZIP ${w.market.zip}`} /> : null}
      {w.market ? (
        <section className="cev-market">
          <div className="cev-market__head"><span>ZIP {w.market.zip} · last {Math.round((w.market.windowDays ?? 365) / 30.4)} months</span><em>{w.market.admissible ? 'canonical market cell' : 'low sample'}</em></div>
          <div className="cev-market__grid">
            <div><span>Sales</span><b>{w.market.sales ?? '—'}</b></div>
            <div><span>Median</span><b>{money(w.market.medianPrice) ?? '—'}</b></div>
            <div><span>{multi ? '$/unit' : '$/sq ft'}</span><b>{multi ? money(w.market.medianPpu) ?? '—' : w.market.medianPpsf ? `$${w.market.medianPpsf}` : '—'}</b></div>
            <div><span>Cash</span><b>{w.market.cashShare !== null ? `${Math.round(w.market.cashShare * 100)}%` : '—'}</b></div>
            <div><span>Corporate buyers</span><b>{w.market.corporateBuyerShare !== null ? `${Math.round(w.market.corporateBuyerShare * 100)}%` : '—'}</b></div>
            <div><span>Median age</span><b>{ageLabel(w.market.recencyDaysMedian) ?? '—'}</b></div>
          </div>
        </section>
      ) : null}

      <p className="cev-footnote cev-sources">
        {w.counts.enginePool} engine-pool sales · {w.counts.transactions} recorded transactions{w.counts.transactionsInRadius !== null && w.counts.transactionsReturned !== null && w.counts.transactionsInRadius > w.counts.transactionsReturned ? ` (nearest ${w.counts.transactionsReturned} of ${w.counts.transactionsInRadius})` : ''} within {w.query.radiusMiles} mi, last {w.query.months} months. Candidates are judged by the acquisition engine’s own comparability rules.
      </p>

      {lookAround ? createPortal(
        <div className="cev-look" data-theme={theme} role="dialog" aria-label="Street View">
          <InteractiveStreetViewPanorama address={w.subject.address} lat={w.subject.lat} lng={w.subject.lng} visible />
          <div className="cev-look__bar">
            <div><span className="cev-eyebrow"><i />Street View</span><b>{w.subject.address}</b></div>
            <button type="button" className="cev-x" onClick={() => setLookAround(false)} aria-label="Close"><Icon name="close" /></button>
          </div>
        </div>,
        document.body,
      ) : null}

      {sheet ? createPortal(
        <div className="cev-sheet" data-theme={theme} role="dialog" aria-label="Search area">
          <button type="button" className="cev-sheet__scrim" aria-label="Close" onClick={() => setSheet(false)} />
          <div className="cev-sheet__panel">
            <div className="cev-sheet__grab" />
            <h3>Search area</h3>
            <span className="cev-sub">Radius</span>
            <div className="cev-seg">{w.query.radiusOptions.map((r) => <button key={r} type="button" className={cls(r === w.query.radiusMiles && 'is-on')} onClick={() => setRadius(r)}>{r} mi</button>)}</div>
            <span className="cev-sub">Sold within</span>
            <div className="cev-seg">{w.query.monthOptions.map((m) => <button key={m} type="button" className={cls(m === w.query.months && 'is-on')} onClick={() => setMonths(m)}>{m} mo</button>)}</div>
            <p className="cev-footnote">Rural subjects often need 5–10 mi. The engine’s own pricing window for this asset type is fixed; this only changes what you can review.</p>
            <button type="button" className="cev-btn is-primary" onClick={() => setSheet(false)}>Done</button>
          </div>
        </div>,
        document.body,
      ) : null}

      {inspected ? createPortal(
        <CompInspector
          c={inspected}
          w={w}
          theme={theme}
          inSet={inSet.has(inspected.key)}
          onToggle={() => toggle(inspected.key)}
          onClose={() => setInspect(null)}
          onGraph={() => openGraph(inspected.propertyId)}
          onBuyer={inspected.buyerId ? () => openBuyer(inspected.buyerId as string) : null}
        />,
        document.body,
      ) : null}
    </div>
  )
}

/* ── inspector ────────────────────────────────────────────────────────── */

function Chapter({ n, title, note }: { n: string; title: string; note?: string }) {
  return (
    <div className="cev-chapter" aria-hidden="true">
      <span className="cev-chapter__n">{n}</span>
      <span className="cev-chapter__t">{title}</span>
      <i />
      {note ? <em>{note}</em> : null}
    </div>
  )
}

const DIM_LABEL: Record<string, string> = { asset_type: 'Asset type', units: 'Units', sqft: 'Size', beds: 'Beds', baths: 'Baths', year_built: 'Year built', lot_sqft: 'Lot', distance_miles: 'Distance', condition: 'Condition', zip: 'ZIP', subdivision: 'Subdivision' }
// Each engine basis re-prices the SUBJECT from this sale (per unit × subject
// units, per sq ft × subject sq ft …); weights are relative within the blend.
const ADJ_LABEL: Record<string, string> = { sale_price: 'Sale price as-is', price_per_unit: 'Per unit × subject units', price_per_sqft: 'Per sq ft × subject sq ft', price_per_building_sqft: 'Per sq ft × subject sq ft', price_per_lot_sqft: 'Per lot sq ft × subject lot', bedroom_ratio: 'Bedroom ratio', bedroom_count: 'Bedroom count', repair_difference: 'Repair difference' }
const humanKey = (k: string) => ADJ_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase())

function CompInspector({ c, w, theme, inSet, onToggle, onClose, onGraph, onBuyer }: {
  c: EvidenceComp; w: CompsWorkspace; theme: string; inSet: boolean; onToggle: () => void; onClose: () => void; onGraph: () => void; onBuyer: (() => void) | null
}) {
  const s = w.subject
  const rows: Array<[string, string | null, string | null, string | null]> = [
    ['Type', s.propertyType, c.propertyType, c.assetMatch ? 'same' : 'different'],
    ...(s.units && s.units > 1 || (c.units ?? 0) > 1 ? [['Units', s.units ? String(s.units) : null, c.units ? String(c.units) : null, c.compare.units !== null ? `${c.compare.units > 0 ? '+' : ''}${c.compare.units}` : null] as [string, string | null, string | null, string | null]] : []),
    ['Sq ft', s.sqft ? s.sqft.toLocaleString('en-US') : null, c.sqft ? Math.round(c.sqft).toLocaleString('en-US') : null, c.compare.sqftPct !== null ? `${c.compare.sqftPct > 0 ? '+' : ''}${c.compare.sqftPct}%` : null],
    ['Beds / baths', s.beds !== null ? `${s.beds} / ${s.baths ?? '—'}` : null, c.beds !== null ? `${c.beds} / ${c.baths ?? '—'}` : null, c.compare.beds !== null ? `${c.compare.beds > 0 ? '+' : ''}${c.compare.beds} bd` : null],
    ['Year built', s.yearBuilt ? String(s.yearBuilt) : null, c.yearBuilt ? String(c.yearBuilt) : null, c.compare.years !== null ? `${c.compare.years > 0 ? '+' : ''}${c.compare.years} yrs` : null],
    ['Lot', s.lotSqft ? `${Math.round(s.lotSqft).toLocaleString('en-US')} sf` : null, c.lotSqft ? `${Math.round(c.lotSqft).toLocaleString('en-US')} sf` : null, c.compare.lotPct !== null ? `${c.compare.lotPct > 0 ? '+' : ''}${c.compare.lotPct}%` : null],
    ['Distance', '—', c.distanceMiles !== null ? `${c.distanceMiles.toFixed(2)} mi` : null, null],
    ['Sold', '—', c.saleDate, c.compare.days !== null ? `${ageLabel(c.compare.days)} ago` : null],
  ]
  return (
    <div className="cev-sheet is-inspector" data-theme={theme} role="dialog" aria-label="Comparable detail">
      <button type="button" className="cev-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className="cev-sheet__panel">
        <div className="cev-sheet__grab" />
        <div className="cev-insp__head">
          <div>
            <span className={cls('cev-card__state', `is-${c.state}`)}>{c.state === 'system' ? 'System set' : c.state === 'excluded' ? 'Excluded' : 'Candidate'}</span>
            <h3>{c.address}</h3>
            <p>{money(c.salePrice, true)} · {c.saleDate ?? 'undated'} · {c.source}</p>
          </div>
          <button type="button" className="cev-x" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>

        {c.reasons.length ? (
          <div className={cls('cev-why', c.state === 'excluded' ? 'is-not' : 'is-note')}>
            <b>{c.state === 'excluded' ? 'Why not this comp' : 'Engine notes'}</b>
            <ul>{c.reasons.map((r) => <li key={r.code}>{r.label}</li>)}</ul>
          </div>
        ) : null}

        <span className="cev-sub">Comparability — subject vs comp</span>
        <table className="cev-vs">
          <thead><tr><th /><th>Subject</th><th>Comp</th><th>Δ</th></tr></thead>
          <tbody>{rows.filter(([, a, b]) => a || b).map(([k, a, b, d]) => <tr key={k}><th>{k}</th><td>{a ?? '—'}</td><td>{b ?? '—'}</td><td>{d ?? ''}</td></tr>)}</tbody>
        </table>

        {c.engine?.eligible ? (
          <>
            <span className="cev-sub">Engine assessment {c.engine.origin === 'stored' ? '· as priced' : '· today'}</span>
            <div className="cev-eng">
              <div><span>Score</span><b>{c.engine.score !== null && c.engine.score !== undefined ? Math.round(c.engine.score) : '—'}</b></div>
              <div><span>Weight</span><b>{c.engine.weight !== null && c.engine.weight !== undefined ? `${Math.round(c.engine.weight * 100)}%` : '—'}</b></div>
              <div><span>Adjusted to subject</span><b>{money(c.engine.adjustedPrice) ?? '—'}</b></div>
            </div>
            {c.engine.dims?.length ? (
              <div className="cev-dims">{c.engine.dims.map((d) => <span key={d.f} className={`st-${d.st}`}>{DIM_LABEL[d.f] ?? d.f}</span>)}</div>
            ) : null}
            {c.engine.adjustments?.length ? (
              <ul className="cev-adj">
                {c.engine.adjustments.map((a, i, all) => {
                  const total = all.reduce((t, x) => t + (x.amount === null && x.weight ? x.weight : 0), 0)
                  return (
                    <li key={`${a.basis}-${i}`}><span>{humanKey(a.basis)}</span><b>{a.amount !== null ? `${a.amount > 0 ? '+' : ''}${money(a.amount)}` : money(a.value)}</b>{a.amount === null && a.weight !== null && total > 0 ? <em>{Math.round((a.weight / total) * 100)}% of blend</em> : null}</li>
                  )
                })}
              </ul>
            ) : null}
          </>
        ) : null}

        <span className="cev-sub">Transaction</span>
        <dl className="cev-kv">
          <div><dt>Source</dt><dd>{c.source ?? '—'}</dd></div>
          <div><dt>Arm’s-length</dt><dd>{c.armsLength === true ? 'Yes' : c.armsLength === false ? 'No' : 'Not recorded'}</dd></div>
          <div><dt>Financing</dt><dd>{c.cash === true ? 'Cash' : c.cash === false ? 'Financed' : 'Not recorded'}</dd></div>
          {c.docType ? <div><dt>Deed</dt><dd>{c.docType}</dd></div> : null}
          {c.condition ? <div><dt>Condition</dt><dd>{c.condition}</dd></div> : null}
          {c.renovation ? <div><dt>Renovation</dt><dd>{c.renovation}</dd></div> : null}
          <div><dt>Buyer</dt><dd>{c.buyerKind === 'company' ? c.buyerCompany ?? 'Company' : c.buyerKind === 'person' ? 'Individual' : 'Not recorded'}{c.buyerAcquisitions && c.buyerAcquisitions > 1 ? ` · ${c.buyerAcquisitions} acquisitions` : ''}{c.buyerActivity ? ` · ${c.buyerActivity}` : ''}</dd></div>
          {c.sellerKind ? <div><dt>Seller</dt><dd>{c.sellerKind === 'company' ? 'Company' : 'Individual'}</dd></div> : null}
        </dl>

        <div className="cev-insp__actions">
          <button type="button" className={cls('cev-btn', inSet ? 'is-on' : 'is-primary')} onClick={onToggle}><Icon name={inSet ? 'check' : 'bolt'} />{inSet ? 'Remove from your set' : 'Add to your set'}</button>
          <div className="cev-insp__links">
            {c.propertyId ? <button type="button" className="cev-btn" onClick={onGraph}><Icon name="radar" />Property record</button> : null}
            {onBuyer ? <button type="button" className="cev-btn" onClick={onBuyer}><Icon name="briefcase" />View buyer</button> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
