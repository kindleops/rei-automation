/**
 * BUYER MATCH — mobile disposition intelligence for ONE subject property.
 *
 *   A. SUBJECT    what we are selling (anchored, with handoffs)
 *   B. MATCHES    who fits, ranked by the server's evidence tiers
 *   C. EVIDENCE   why each buyer fits (or doesn't), from recorded purchases
 *
 * The server (buyer-match-workspace-service) ranks and explains; this surface
 * only re-orders and filters what it returned. The shortlist is operator
 * attention on this device — it never advances a buyer-side state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import type { BuyerMatchWorkspace, MatchedBuyer } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { fetchBuyerMatchWorkspace, readShortlist, writeShortlist } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { useBreakpoint } from '../../../modules/mobile/useBreakpoint'
import { BuyerCard, MarketSignals, MatchHero, StateRail, SubjectHero, WhyNot, cls } from './BuyerMatchParts'
import { BuyerInspector, CompareSheet, ControlsSheet, DEFAULT_FILTERS, type Filters } from './BuyerMatchSheets'
import { BuyerMatchCockpit } from './BuyerMatchCockpit'
import './buyer-match-surface.css'

type View = 'best' | 'shortlist' | 'nearby' | 'active' | 'repeat' | 'cash' | 'flip' | 'hold'
type Sort = 'best' | 'recent' | 'volume' | 'nearest' | 'price'

const VIEWS: Array<[View, string, (b: MatchedBuyer) => boolean]> = [
  ['best', 'Best matches', () => true],
  ['nearby', 'Nearby', (b) => (b.nearby?.sameFamily ?? 0) >= 1 && (b.nearby?.nearestMiles ?? 99) <= 2],
  ['active', 'Bought in 90d', (b) => b.activity.t90 > 0],
  ['repeat', 'Repeat buyers', (b) => b.activity.acquisitions >= 5],
  ['cash', 'Cash-heavy', (b) => b.activity.acquisitions >= 3 && (b.buyBox.cashShare ?? 0) >= 0.6],
  ['flip', 'Resellers', (b) => /resell|flip/i.test(b.behavior.holdFlip ?? '')],
  ['hold', 'Holders', (b) => /holds \(/i.test(b.behavior.holdFlip ?? '')],
]
const SORTS: Array<[Sort, string]> = [['best', 'Best'], ['recent', 'Most recent'], ['volume', 'Most active'], ['nearest', 'Nearest'], ['price', 'Closest price']]

const readTheme = () => (typeof document === 'undefined' ? 'dark' : document.documentElement.getAttribute('data-nexus-theme') || 'dark')

export function BuyerMatchSurface({ propertyId }: { propertyId: string }) {
  const [radius, setRadius] = useState(5)
  const [months, setMonths] = useState(36)
  const [w, setW] = useState<BuyerMatchWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [view, setView] = useState<View>('best')
  const [sort, setSort] = useState<Sort>('best')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [inspect, setInspect] = useState<MatchedBuyer | null>(null)
  const [compare, setCompare] = useState<string[]>([])
  const [sheet, setSheet] = useState<'controls' | 'compare' | null>(null)
  const [shortlist, setShortlist] = useState<string[]>(() => readShortlist(propertyId))
  const [theme, setTheme] = useState(readTheme)
  /**
   * DESK. The disposition cockpit (BuyerMatchCockpit, buyer-match-desktop.css):
   * a context strip over three planes — the buyer universe, the selected
   * buyer, and the evidence. It asks the server for the located purchases
   * behind the evidence (`include: 'transactions'`); the phone does not, and
   * keeps the single-column flow below, element for element.
   */
  const { isModernDesktop } = useBreakpoint()
  // the cockpit's selected buyer (the phone's `inspect` is a sheet with a back handler)
  const [deskSel, setDeskSel] = useState<string | null>(null)

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    fetchBuyerMatchWorkspace({ propertyId, radius, months, include: isModernDesktop ? 'transactions' : undefined }, ctl.signal)
      .then((data) => { if (!ctl.signal.aborted) { setW(data); setLoading(false) } })
      .catch((e) => { if (!ctl.signal.aborted) { setError(String(e?.message || e)); setLoading(false) } })
    return () => ctl.abort()
  }, [propertyId, radius, months, nonce, isModernDesktop])

  useBackHandler(Boolean(inspect), 'bmx:inspect', 'Buyer', () => { setInspect(null); return true })
  useBackHandler(sheet !== null, 'bmx:sheet', 'Buyer Match', () => { setSheet(null); return true })

  const toggleShort = useCallback((id: string) => {
    setShortlist((cur) => { const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; writeShortlist(propertyId, next); return next })
  }, [propertyId])
  const toggleCompare = (id: string) => setCompare((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur.slice(-2), id]))

  const visible = useMemo(() => {
    if (!w) return []
    const pred = VIEWS.find(([k]) => k === view)?.[2] ?? (() => true)
    let rows = w.buyers.filter((b) => (view === 'shortlist' ? shortlist.includes(b.id) : pred(b)))
      .filter((b) => filters.tiers.has(b.tier))
      .filter((b) => filters.kind === 'all' || b.kind === filters.kind)
      .filter((b) => !filters.registryOnly || b.identity.tier === 'registry')
      .filter((b) => !filters.active90 || b.activity.t90 > 0)
      .filter((b) => !filters.priceInside || b.fit.price.verdict === 'inside')
    const mid = w.subject.window ? (w.subject.window.low + w.subject.window.high) / 2 : null
    if (sort === 'recent') rows = [...rows].sort((a, b) => (a.activity.daysSince ?? 1e9) - (b.activity.daysSince ?? 1e9))
    if (sort === 'volume') rows = [...rows].sort((a, b) => b.activity.t365 - a.activity.t365 || b.activity.acquisitions - a.activity.acquisitions)
    if (sort === 'nearest') rows = [...rows].sort((a, b) => (a.nearby?.nearestMiles ?? 99) - (b.nearby?.nearestMiles ?? 99))
    if (sort === 'price' && mid) rows = [...rows].sort((a, b) => Math.abs((a.buyBox.priceMid ?? 1e12) - mid) - Math.abs((b.buyBox.priceMid ?? 1e12) - mid))
    return rows
  }, [w, view, sort, filters, shortlist])

  const filtersOn = filters.tiers.size < 3 || filters.kind !== 'all' || filters.registryOnly || filters.active90 || filters.priceInside

  const pid = w?.subject.propertyId ?? propertyId
  const openDeal = () => pushRoutePath(`/deal-intelligence?property_id=${encodeURIComponent(pid)}`)
  const openComps = () => pushRoutePath(`/comp-intelligence?property_id=${encodeURIComponent(pid)}`)
  const openGraph = () => pushRoutePath(`/entity-graph/property/${encodeURIComponent(pid)}`)
  const openPipeline = w?.subject.opportunityId ? () => pushRoutePath(`/pipeline?opp=${encodeURIComponent(w.subject.opportunityId as string)}`) : null
  const openProperty = (id: string) => pushRoutePath(`/entity-graph/property/${encodeURIComponent(id)}`)
  const openBuyerGraph = (id: string, section?: string) => pushRoutePath(`/entity-graph?buyer=${encodeURIComponent(id)}${section ? `&section=${encodeURIComponent(section)}` : ''}`)
  const toMap = (label: string, tone: 'buyer' | 'portfolio' | 'property', points: Array<{ lat: number | null | undefined; lng: number | null | undefined; label?: string | null; id?: string }>) => {
    const pts = points.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number').map((p) => ({ lat: p.lat as number, lng: p.lng as number, label: p.label ?? null, id: p.id }))
    if (w?.subject.lat && w.subject.lng) pts.unshift({ lat: w.subject.lat, lng: w.subject.lng, label: w.subject.address, id: pid })
    if (writeMapFocusSet({ label, tone, points: pts })) pushRoutePath('/map')
  }
  const openMatchedOnMap = () => {
    if (!w) return
    toMap(`Matched buyers around ${w.subject.address?.split(',')[0] ?? 'subject'}`, 'buyer', w.buyers.flatMap((b) => b.recent.map((r) => ({ lat: r.lat, lng: r.lng, label: `${b.name ?? 'Buyer'} · ${r.address ?? ''}`, id: r.propertyId ?? undefined }))))
  }
  const focusFromOrbit = (id: string) => {
    setFocusId(id)
    setView('best')
    requestAnimationFrame(() => document.querySelector(`.bmx-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  if (!w && isModernDesktop && loading) {
    return (
      <div className="bmx is-desk is-cockpit is-boot" data-theme={theme} aria-busy="true">
        <div className="bmc-strip is-boot"><p>Resolving buyers who bought near this property…</p></div>
        <div className="bmc-planes">
          <div className="bmc-plane bmc-universe is-boot"><i /><i /><i /><i /><i /></div>
          <div className="bmc-detail">
            <div className="bmc-plane bmc-selected is-boot"><i /><i /><i /></div>
            <div className="bmc-plane bmc-evidence is-boot"><i /><i /><i /><i /></div>
          </div>
        </div>
      </div>
    )
  }

  if (!w) {
    return (
      <div className={cls('bmx', isModernDesktop && 'is-desk')} data-theme={theme}>
        {loading ? (
          <div className="bmx-boot" aria-busy="true">
            <div className="bmx-boot__hero"><p><i />Resolving buyers who bought near this property…</p></div>
            <div className="bmx-boot__orbit"><span /><span /><span /></div>
            <div className="bmx-boot__row" /><div className="bmx-boot__row" />
          </div>
        ) : (
          <div className="bmx-empty"><Icon name="alert-circle" /><p>{error === 'property_not_found' ? 'This property isn’t in the property record.' : 'Buyer evidence couldn’t load. No buyers are shown rather than guessed ones.'}</p><button type="button" className="bmx-btn" onClick={() => setNonce((n) => n + 1)}><Icon name="refresh-cw" />Try again</button></div>
        )}
      </div>
    )
  }

  const compared = compare.map((id) => w.buyers.find((b) => b.id === id)).filter(Boolean) as MatchedBuyer[]
  const viewCounts = Object.fromEntries(VIEWS.map(([k, , f]) => [k, w.buyers.filter(f).length])) as Record<View, number>

  const subjectHero = <SubjectHero w={w} onDeal={openDeal} onComps={openComps} onGraph={openGraph} onMap={openMatchedOnMap} onPipeline={openPipeline} />

  const matchHero = <MatchHero w={w} onFocus={focusFromOrbit} focusId={focusId} />

  const noneSection = w.counts.matched === 0 ? (
    <section className="bmx-panel bmx-none">
      <div className="bmx-panel__head"><span>No buyers fit yet</span><em>{w.query.radiusMiles} mi · {w.query.months} mo</em></div>
      <p>{w.market.buyersInRadius
        ? `${w.market.buyersInRadius} resolved buyers purchased within ${w.query.radiusMiles} mi, but none bought ${w.subject.familyLabel.toLowerCase()} at a price and recency that fits this deal — every one is explained under “Why not”.`
        : `No resolved buyer has a recorded purchase within ${w.query.radiusMiles} mi in the last ${w.query.months} months.`}</p>
      <div className="bmx-chiprow">
        {w.query.radiusMiles < 25 ? <button type="button" className="bmx-chip is-on" onClick={() => setRadius(w.query.radiusOptions.find((r) => r > w.query.radiusMiles) ?? 25)}>Expand radius</button> : null}
        {w.query.months < 60 ? <button type="button" className="bmx-chip" onClick={() => setMonths(w.query.monthOptions.find((m) => m > w.query.months) ?? 60)}>Longer window</button> : null}
      </div>
    </section>
  ) : null

  const buyersSection = w.counts.matched > 0 ? (
    <>
      <div className="bmx-chapter"><span className="n">01</span><span className="t">Buyers</span><i /><em>{visible.length} shown</em></div>
      <nav className="bmx-views" aria-label="Buyer views">
        {VIEWS.filter(([k]) => k === 'best' || viewCounts[k] > 0).map(([k, label]) => (
          <button key={k} type="button" className={cls('bmx-chip', view === k && 'is-on')} onClick={() => setView(k)}>{label}<b>{viewCounts[k]}</b></button>
        ))}
        {shortlist.length ? <button type="button" className={cls('bmx-chip', 'is-gold', view === 'shortlist' && 'is-on')} onClick={() => setView('shortlist')}><Icon name="star" />Shortlist<b>{shortlist.filter((id) => w.buyers.some((b) => b.id === id)).length}</b></button> : null}
      </nav>
      <div className="bmx-toolbar">
        <div className="bmx-sorts">{SORTS.map(([k, l]) => <button key={k} type="button" className={cls(sort === k && 'is-on')} onClick={() => setSort(k)}>{l}</button>)}</div>
        <button type="button" className={cls('bmx-chip', filtersOn && 'is-on')} onClick={() => setSheet('controls')}><Icon name="filter" />{w.query.radiusMiles} mi</button>
        <button type="button" className="bmx-chip is-ghost" onClick={() => setNonce((n) => n + 1)} aria-label="Refresh evidence"><Icon name="refresh-cw" /></button>
      </div>
      <div className="bmx-list">
        {visible.map((b, i) => (
          <BuyerCard
            key={b.id} b={b} w={w} rank={i} focus={focusId === b.id}
            shortlisted={shortlist.includes(b.id)} comparing={compare.includes(b.id)}
            onOpen={() => { setFocusId(b.id); setInspect(b) }}
            onShortlist={() => toggleShort(b.id)}
            onCompare={() => toggleCompare(b.id)}
          />
        ))}
        {!visible.length ? <div className="bmx-panel bmx-none"><p>No buyers in this view with the current filters.</p><div className="bmx-chiprow"><button type="button" className="bmx-chip is-on" onClick={() => { setView('best'); setFilters(DEFAULT_FILTERS) }}>Show all matches</button></div></div> : null}
      </div>
    </>
  ) : null

  const marketBlock = (
    <>
      <div className="bmx-chapter"><span className="n">02</span><span className="t">Market</span><i /><em>observed demand</em></div>
      <MarketSignals w={w} />
    </>
  )

  const dispositionBlock = (
    <>
      <div className="bmx-chapter"><span className="n">03</span><span className="t">Disposition</span><i /><em>buyer-side states</em></div>
      <StateRail w={w} shortlisted={shortlist.filter((id) => w.buyers.some((b) => b.id === id)).length} />
      <section className="bmx-panel bmx-outreach">
        <div className="bmx-panel__head"><span>Buyer outreach</span><em>{w.contactability.verified} verified contacts</em></div>
        <p>{w.contactability.note}</p>
      </section>
    </>
  )

  const whyNotBlock = (
    <>
      <div className="bmx-chapter"><span className="n">04</span><span className="t">Why not</span><i /><em>explained exclusions</em></div>
      <WhyNot w={w} onOpen={(b) => { setFocusId(b.id); setInspect(b) }} />

      <details className="bmx-panel bmx-lineage">
        <summary><span>Evidence &amp; method</span><Icon name="chevron-down" /></summary>
        <dl>
          <div><dt>Identity</dt><dd>{w.lineage.identity}</dd></div>
          <div><dt>Evidence</dt><dd>{w.lineage.evidence}</dd></div>
          <div><dt>Window</dt><dd>{w.lineage.window}</dd></div>
          <div><dt>Strong</dt><dd>{w.tierRules.strong}</dd></div>
          <div><dt>Moderate</dt><dd>{w.tierRules.moderate}</dd></div>
          <div><dt>Exploratory</dt><dd>{w.tierRules.exploratory}</dd></div>
          <div><dt>Computed</dt><dd>{new Date(w.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — live on every visit, no stored run</dd></div>
        </dl>
      </details>
    </>
  )

  const compareDock = compare.length ? (
    <div className="bmx-dock" style={{ '--n': compare.length } as CSSProperties}>
      <span><b>{compare.length}</b> to compare</span>
      <button type="button" className="bmx-btn is-primary" onClick={() => setSheet('compare')} disabled={compare.length < 2}><Icon name="layout-split" />Compare</button>
      <button type="button" className="bmx-x" onClick={() => setCompare([])} aria-label="Clear compare"><Icon name="close" /></button>
    </div>
  ) : null

  const inspector = inspect ? (
    <BuyerInspector
      b={inspect} w={w} theme={theme} shortlisted={shortlist.includes(inspect.id)}
      docked={isModernDesktop}
      onShortlist={() => toggleShort(inspect.id)} onClose={() => setInspect(null)}
      onGraph={() => openBuyerGraph(inspect.id)} onMap={toMap} onProperty={openProperty}
    />
  ) : null

  const sheets = (
    <>
      {sheet === 'compare' && compared.length ? <CompareSheet buyers={compared} w={w} theme={theme} onClose={() => setSheet(null)} onOpen={(b) => { setSheet(null); if (isModernDesktop) setDeskSel(b.id); else setInspect(b) }} /> : null}
      {sheet === 'controls' ? (
        <ControlsSheet w={w} theme={theme} filters={filters} setFilters={setFilters} onRadius={(r) => setRadius(r)} onMonths={(m) => setMonths(m)} onClose={() => setSheet(null)} />
      ) : null}
    </>
  )

  if (isModernDesktop) {
    return (
      <BuyerMatchCockpit
        w={w} loading={loading} theme={theme}
        visible={visible}
        views={[...VIEWS.map(([k, label]) => ({ key: k, label, count: viewCounts[k] })), { key: 'shortlist', label: 'Shortlist', count: shortlist.filter((id) => w.buyers.some((b) => b.id === id)).length }]}
        view={view} onView={(k) => setView(k as View)}
        sorts={SORTS} sort={sort} onSort={(k) => setSort(k as Sort)}
        filtersOn={filtersOn} onResetFilters={() => setFilters(DEFAULT_FILTERS)}
        onControls={() => setSheet('controls')} onRefresh={() => setNonce((n) => n + 1)}
        shortlist={shortlist} onShortlist={toggleShort}
        compare={compare} onCompare={toggleCompare}
        selectedId={deskSel} onSelect={setDeskSel}
        onDeal={openDeal} onComps={openComps} onGraph={openGraph} onMatchedMap={openMatchedOnMap} onPipeline={openPipeline}
        onProperty={openProperty} onBuyerGraph={openBuyerGraph} toMap={toMap}
        onRadius={(r) => setRadius(r)} onMonths={(m) => setMonths(m)}
        compareDock={compareDock} sheets={sheets}
      />
    )
  }

  return (
    <div className={cls('bmx', loading && 'is-refreshing')} data-theme={theme}>
      {subjectHero}
      {matchHero}
      {noneSection}
      {buyersSection}
      {marketBlock}
      {dispositionBlock}
      {whyNotBlock}
      {compareDock}
      {inspector}
      {sheets}
    </div>
  )
}

export default BuyerMatchSurface
