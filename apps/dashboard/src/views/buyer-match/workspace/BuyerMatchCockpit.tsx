/**
 * BUYER MATCH · DESKTOP COCKPIT — institutional buyer intelligence for ONE
 * subject, in three planes under a slim context strip:
 *
 *   BUYER UNIVERSE   every buyer the model matched (or ruled out), as dense
 *                    ranked rows — scan, don't read
 *   SELECTED BUYER   one buyer: identity, a thesis built only from evidence
 *                    that passed, four figures, and the purchases themselves
 *                    (footprint · price · activity)
 *   EVIDENCE         why this buyer, dimension by dimension, each expanding
 *                    to the transactions that prove it — or the market around
 *                    the subject
 *
 * Desktop only (the phone keeps BuyerMatchSurface's single column). Read-only:
 * the only local state written is the operator's shortlist on this device.
 * Every figure appears once; every mark is a recorded purchase or a holding
 * the model links to the buyer; nothing is inferred on this side.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { BuyerMatchWorkspace, MatchedBuyer } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { money } from '../../../domain/buyer-match/buyer-match-workspace-api'
import type { BuyerProfile } from '../../../domain/entity-graph/entity-graph-intel-api'
import { fetchBuyerProfile } from '../../../domain/entity-graph/entity-graph-intel-api'
import { staticStreetViewUrl } from '../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'
import { PriceBar, TIER_LABEL, buyerTitle, cls, stageLabel } from './BuyerMatchParts'
import { ActivityReceipts, Footprint, PriceScatter } from './BuyerMatchCockpitVisuals'
import type { Mark, MarkAction, OpenMark } from './BuyerMatchCockpitVisuals'
import type { Dim, Holding, Receipt } from './buyer-match-cockpit-model'
import { DIM_LABEL, ageShort, asOfLabel, buildReceipts, fitIndicators, holdingsOf, modelAsOf, shortFamily, strength, street, thesis, verdictOf } from './buyer-match-cockpit-model'

type MapTone = 'buyer' | 'portfolio' | 'property'
type MapPoint = { lat: number | null | undefined; lng: number | null | undefined; label?: string | null; id?: string }

export type CockpitView = { key: string; label: string; count: number }

export type CockpitProps = {
  w: BuyerMatchWorkspace
  loading: boolean
  theme: string
  visible: MatchedBuyer[]
  views: CockpitView[]
  view: string
  onView: (key: string) => void
  sorts: Array<[string, string]>
  sort: string
  onSort: (key: string) => void
  filtersOn: boolean
  onResetFilters: () => void
  onControls: () => void
  onRefresh: () => void
  shortlist: string[]
  onShortlist: (id: string) => void
  compare: string[]
  onCompare: (id: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  onDeal: () => void
  onComps: () => void
  onGraph: () => void
  onMatchedMap: () => void
  onPipeline: (() => void) | null
  onProperty: (propertyId: string) => void
  onBuyerGraph: (buyerId: string, section?: string) => void
  toMap: (label: string, tone: MapTone, points: MapPoint[]) => void
  onRadius: (r: number) => void
  onMonths: (m: number) => void
  compareDock: ReactNode
  sheets: ReactNode
}

type Visual = 'geo' | 'price' | 'activity'
const VISUALS: Array<[Visual, string]> = [['geo', 'Geography'], ['price', 'Price'], ['activity', 'Activity']]
const PRIMARY_VIEWS = ['best', 'nearby', 'active']
const EXCLUSION_SHORT: Record<string, string> = { lender_or_agency: 'Lenders, servicers & agencies', type_mismatch: 'Buy a different asset type', stale: 'Inactive 24+ months', price_outside: 'Price band far from this deal' }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const sfRange = (lo: number | null, hi: number | null) => (lo && hi ? `${Math.round(lo).toLocaleString('en-US')}–${Math.round(hi).toLocaleString('en-US')} sf` : null)
const monthYear = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null)
const shortDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—')

/* ══ strip ═══════════════════════════════════════════════════════════════ */

function ContextStrip({ w, onDeal, onComps, onGraph, onMap, onPipeline }: { w: BuyerMatchWorkspace; onDeal: () => void; onComps: () => void; onGraph: () => void; onMap: () => void; onPipeline: (() => void) | null }) {
  const s = w.subject
  const [ok, setOk] = useState<boolean | null>(null)
  const photo = staticStreetViewUrl(s.address, s.lat, s.lng)
  const [line, ...rest] = (s.address ?? '').split(',')
  const city = s.city ?? rest[0]?.trim() ?? null
  const spec = [
    city,
    s.county ? `${s.county} County` : null,
    shortFamily(s.familyLabel),
    s.units && s.units > 1 ? `${s.units} units` : null,
    s.beds !== null || s.baths !== null ? `${s.beds ?? '—'}/${s.baths ?? '—'}` : null,
    s.sqft ? `${s.sqft.toLocaleString('en-US')} sf` : null,
    s.yearBuilt ? `Built ${s.yearBuilt}` : null,
  ].filter(Boolean) as string[]
  return (
    <header className="bmc-strip">
      <div className="bmc-strip__id">
        <span className={cls('bmc-strip__photo', ok === true && 'is-ready')} aria-hidden="true">
          <Icon name="home" />
          {photo && ok !== false ? <img src={photo} alt="" onLoad={() => setOk(true)} onError={() => setOk(false)} /> : null}
        </span>
        <div className="bmc-strip__txt">
          <h1>{line || 'Subject property'}{s.stage ? <span className={cls('bmc-stage', s.stage === 'closed' && 'is-lost')}>{stageLabel(s.stage)}</span> : null}</h1>
          <p>{spec.join('\u00a0· ')}</p>
        </div>
      </div>
      <dl className="bmc-strip__figs">
        {s.value ? <div><dt>{s.valueBasis === 'deal_intelligence' ? 'Deal value' : 'AVM'}</dt><dd>{money(s.value)}</dd></div> : null}
        {s.offer ? <div><dt>Offer</dt><dd>{money(s.offer)}</dd></div> : null}
        {s.ask ? <div><dt>Seller ask</dt><dd>{money(s.ask)}</dd></div> : null}
        {s.window ? <div className="is-dispo"><dt>Dispo</dt><dd>{money(s.window.low)}–{money(s.window.high)}</dd></div> : null}
      </dl>
      <nav className="bmc-strip__acts" aria-label="Subject">
        <button type="button" onClick={onDeal} title="Deal Intelligence"><Icon name="target" />Deal</button>
        <button type="button" onClick={onComps} title="Comps"><Icon name="layers" />Comps</button>
        <button type="button" onClick={onGraph} title="Entity Graph"><Icon name="radar" />Graph</button>
        <button type="button" onClick={onMap} title="Matched buyers on the Map"><Icon name="map" />Map</button>
        {onPipeline ? <button type="button" onClick={onPipeline} title="Pipeline"><Icon name="list" />Pipeline</button> : null}
      </nav>
    </header>
  )
}

/* ══ universe ════════════════════════════════════════════════════════════ */

function nearbyLine(b: MatchedBuyer, w: BuyerMatchWorkspace): string {
  if (b.tier === 'excluded') return (b.exclusions[0]?.label ?? 'Ruled out').split(' — ')[0]
  if (b.nearby && b.nearby.sameFamily > 0) return `${b.nearby.sameFamily} same-type nearby`
  if (b.nearby && b.nearby.purchases > 0) return `${b.nearby.purchases} nearby, other types`
  return `${b.countyPurchases} in ${w.subject.county ? `${w.subject.county} Co.` : 'county'}`
}

function UniverseRow({ b, w, selected, shortlisted, comparing, onSelect, onShortlist, onCompare, i }: {
  b: MatchedBuyer; w: BuyerMatchWorkspace; selected: boolean; shortlisted: boolean; comparing: boolean
  onSelect: () => void; onShortlist: () => void; onCompare: () => void; i: number
}) {
  const age = ageShort(b.activity.daysSince)
  const price = money(b.buyBox.priceMid ?? b.buyBox.priceLow)
  return (
    <li className={cls('bmc-row', `t-${b.tier}`, selected && 'is-sel', shortlisted && 'is-short')} style={{ '--i': Math.min(i, 12) } as CSSProperties} data-id={b.id}>
      <button type="button" className="bmc-row__open" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <span className="bmc-row__l1">
          <b>{buyerTitle(b)}</b>
          <span className="bmc-ind" aria-label={fitIndicators(b).map((f) => `${f.label}: ${f.word}`).join(', ')}>
            {fitIndicators(b).map((f) => <i key={f.dim} className={`f-${f.tone}`} title={`${f.label} · ${f.word}`} />)}
          </span>
        </span>
        <span className="bmc-row__l2"><em>{TIER_LABEL[b.tier].replace(/ fit$/, '')}{/ fit$/.test(TIER_LABEL[b.tier]) ? <span className="bmc-fitsfx"> fit</span> : null}</em> · {nearbyLine(b, w)}{age ? ` · last buy ${age}` : ''}</span>
        <span className="bmc-row__l3">{price ? `${price} observed` : 'No priced purchase'} · {b.activity.t365} {b.activity.t365 === 1 ? 'purchase' : 'purchases'} / 12mo</span>
      </button>
      <span className="bmc-row__acts">
        <button type="button" className={cls('bmc-iconbtn', shortlisted && 'is-gold')} onClick={onShortlist} aria-pressed={shortlisted} aria-label={shortlisted ? 'Remove from shortlist' : 'Shortlist'} title={shortlisted ? 'On your shortlist (this device)' : 'Shortlist (this device)'}><Icon name="star" /></button>
        <button type="button" className={cls('bmc-iconbtn', comparing && 'is-on')} onClick={onCompare} aria-pressed={comparing} aria-label="Compare" title="Compare"><Icon name="layout-split" /></button>
      </span>
    </li>
  )
}

function Universe(p: CockpitProps & { scope: 'listed' | 'ruledout'; setScope: (s: 'listed' | 'ruledout') => void; selId: string | null }) {
  const { w, scope, setScope } = p
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    if (!menu) return
    const off = (e: PointerEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setMenu(false) } }
    window.addEventListener('pointerdown', off)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', off); window.removeEventListener('keydown', esc) }
  }, [menu])

  const rows = scope === 'ruledout' ? w.excluded : p.visible
  const c = w.counts
  const listed = w.buyers.length
  const primary = p.views.filter((v) => PRIMARY_VIEWS.includes(v.key))
  const more = p.views.filter((v) => !PRIMARY_VIEWS.includes(v.key) && v.count > 0)
  const moreOn = scope === 'ruledout' ? null : more.find((v) => v.key === p.view) ?? null
  const scopeText = (v: CockpitView) => (v.key === 'best' ? (listed < c.matched ? `Top ${listed}` : `All ${listed}`) : v.key === 'active' ? `${v.count} bought in 90d` : `${v.count} ${v.label.toLowerCase()}`)

  // ↑ / ↓ walk the list and select as they go
  const onKeys = (e: ReactKeyboardEvent<HTMLOListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const btns = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.bmc-row__open') ?? [])]
    const at = btns.indexOf(document.activeElement as HTMLButtonElement)
    const next = btns[Math.max(0, Math.min(btns.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    e.preventDefault()
    next.focus()
    next.click()
  }

  return (
    <section className="bmc-plane bmc-universe" aria-label="Buyer universe">
      <header className="bmc-uhead">
        <div className="bmc-eyebrow"><span>Buyer universe</span><em>{w.query.radiusMiles} mi · {w.query.months} mo</em></div>
        <div className="bmc-tierline" aria-label={`${c.matched} matched: ${c.strong} strong, ${c.moderate} moderate, ${c.exploratory} exploratory`}>
          <b>{c.matched}</b><span>matched</span>
          <span className="bmc-tierline__br" aria-hidden="true" />
          <span className="bmc-tierline__t t-strong"><i />{c.strong} strong</span>
          <span className="bmc-tierline__t t-moderate"><i />{c.moderate} moderate</span>
          <span className="bmc-tierline__t t-exploratory"><i />{c.exploratory} exploratory</span>
        </div>
        <div className="bmc-scopes" role="toolbar" aria-label="Buyer views">
          {primary.map((v) => (
            <button key={v.key} type="button" className={cls('bmc-scope', scope === 'listed' && p.view === v.key && 'is-on')} aria-pressed={scope === 'listed' && p.view === v.key} onClick={() => { setScope('listed'); p.onView(v.key) }}>{scopeText(v)}</button>
          ))}
          {moreOn ? <button type="button" className="bmc-scope is-on" aria-pressed="true" onClick={() => p.onView('best')}>{scopeText(moreOn)}<Icon name="close" /></button> : null}
          {scope === 'ruledout' ? <button type="button" className="bmc-scope is-on is-out" aria-pressed="true" onClick={() => setScope('listed')}>{c.excluded} ruled out<Icon name="close" /></button> : null}
          <div className="bmc-more" ref={menuRef}>
            <button type="button" className={cls('bmc-scope is-more', menu && 'is-open')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>More<Icon name="chevron-down" /></button>
            {menu ? (
              <div className="bmc-menu" role="menu">
                {more.map((v) => (
                  <button key={v.key} type="button" role="menuitemradio" aria-checked={scope === 'listed' && p.view === v.key} className={cls(scope === 'listed' && p.view === v.key && 'is-on')} onClick={() => { setScope('listed'); p.onView(v.key); setMenu(false) }}>
                    <span>{v.label}</span><b>{v.count}</b>
                  </button>
                ))}
                {w.excluded.length ? (
                  <button type="button" role="menuitemradio" aria-checked={scope === 'ruledout'} className={cls('is-out', scope === 'ruledout' && 'is-on')} onClick={() => { setScope('ruledout'); setMenu(false) }}>
                    <span>Ruled out</span><b>{c.excluded}</b>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="bmc-utools">
          <label className="bmc-sort">
            <span>Sort</span>
            <select value={p.sort} onChange={(e) => p.onSort(e.target.value)} disabled={scope === 'ruledout'}>
              {p.sorts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <Icon name="chevron-down" />
          </label>
          <button type="button" className={cls('bmc-tool', p.filtersOn && 'is-on')} onClick={p.onControls}><Icon name="filter" />{w.query.radiusMiles} mi · {w.query.months} mo{p.filtersOn ? ' · filtered' : ''}</button>
          <button type="button" className="bmc-tool is-icon" onClick={p.onRefresh} aria-label="Refresh evidence" title="Refresh evidence"><Icon name="refresh-cw" /></button>
        </div>
      </header>

      {scope === 'ruledout' ? (
        <div className="bmc-outwhy">
          {Object.entries(c.exclusions).sort((a, b) => b[1] - a[1]).map(([k, n]) => <span key={k}><b>{n}</b>{EXCLUSION_SHORT[k] ?? k}</span>)}
        </div>
      ) : null}

      {w.counts.matched === 0 && scope === 'listed' ? (
        <div className="bmc-uempty">
          <p>{w.market.buyersInRadius
            ? `${w.market.buyersInRadius} resolved buyers purchased within ${w.query.radiusMiles} mi, but none bought ${w.subject.familyLabel.toLowerCase()} at a price and recency that fits this deal — every one is explained under Ruled out.`
            : `No resolved buyer has a recorded purchase within ${w.query.radiusMiles} mi in the last ${w.query.months} months.`}</p>
          <div className="bmc-uempty__acts">
            {w.query.radiusMiles < 25 ? <button type="button" className="bmc-tool" onClick={() => p.onRadius(w.query.radiusOptions.find((r) => r > w.query.radiusMiles) ?? 25)}>Expand radius</button> : null}
            {w.query.months < 60 ? <button type="button" className="bmc-tool" onClick={() => p.onMonths(w.query.monthOptions.find((m) => m > w.query.months) ?? 60)}>Longer window</button> : null}
          </div>
        </div>
      ) : (
        <ol className="bmc-list" ref={listRef} onKeyDown={onKeys} aria-label={scope === 'ruledout' ? 'Ruled-out acquirers' : 'Matched buyers'}>
          {rows.map((b, i) => (
            <UniverseRow
              key={b.id} b={b} w={w} i={i} selected={p.selId === b.id}
              shortlisted={p.shortlist.includes(b.id)} comparing={p.compare.includes(b.id)}
              onSelect={() => p.onSelect(b.id)} onShortlist={() => p.onShortlist(b.id)} onCompare={() => p.onCompare(b.id)}
            />
          ))}
          {!rows.length ? (
            <li className="bmc-uempty is-inline">
              <p>No buyers in this view with the current filters.</p>
              <div className="bmc-uempty__acts"><button type="button" className="bmc-tool" onClick={() => { setScope('listed'); p.onView('best'); p.onResetFilters() }}>Show all matches</button></div>
            </li>
          ) : null}
        </ol>
      )}

      <footer className="bmc-ufoot">
        {scope === 'ruledout'
          ? <>Ruled out by rule, never by score — each reason is on the buyer.{c.oneTimeIndividuals ? ` ${c.oneTimeIndividuals} one-time individual buyers (owner-occupant pattern) aren’t listed.` : ''}</>
          : <>{listed < c.matched ? `Top ${listed} of ${c.matched} by evidence rank. ` : ''}{c.oneTimeIndividuals ? `${c.oneTimeIndividuals} one-time individual buyers aren’t listed. ` : ''}{c.excluded ? <button type="button" onClick={() => setScope('ruledout')}>{c.excluded} ruled out</button> : null}</>}
      </footer>
    </section>
  )
}

/* ══ selected buyer ══════════════════════════════════════════════════════ */

function Selected({ b, w, set, holdings, profileState, visual, setVisual, shortlisted, onShortlist, open, action, windowLabel, onBuyerGraph, toMap, asOf }: {
  b: MatchedBuyer; w: BuyerMatchWorkspace; set: ReturnType<typeof buildReceipts>; holdings: Holding[]; profileState: 'loading' | 'ready' | 'failed'
  asOf: number | null
  visual: Visual; setVisual: (v: Visual) => void; shortlisted: boolean; onShortlist: () => void
  open: OpenMark; action: MarkAction; windowLabel: string
  onBuyerGraph: (id: string, section?: string) => void; toMap: CockpitProps['toMap']
}) {
  const title = buyerTitle(b)
  const line = thesis(b, w)
  const chips = [
    b.identity.label,
    b.kind === 'company' ? 'Company' : 'Individual',
    b.identity.jurisdiction ? b.identity.jurisdiction.replace(/^us_/, '').toUpperCase() : null,
    b.behavior.archetype,
    b.nameWithheld || b.kind === 'person' ? 'Name withheld' : null,
  ].filter(Boolean) as string[]
  const days = b.activity.daysSince
  const priceFig = money(b.buyBox.priceMid ?? b.buyBox.priceLow)
  const mappedPurchases = set.receipts.filter((r) => r.lat !== null && r.lng !== null)
  const mappedHoldings = holdings.filter((h) => h.lat !== null && h.lng !== null)
  const hasPortfolio = b.portfolio.owned + b.portfolio.observed > 0
  const tabsRef = useRef<HTMLDivElement | null>(null)
  const onTabKeys = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = VISUALS.findIndex(([k]) => k === visual)
    const next = VISUALS[(i + (e.key === 'ArrowRight' ? 1 : VISUALS.length - 1)) % VISUALS.length][0]
    setVisual(next)
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>(`[data-k="${next}"]`)?.focus())
  }

  return (
    <section className="bmc-plane bmc-selected" aria-label={`Selected buyer — ${title}`}>
      <div className="bmc-sel" key={b.id}>
        <header className="bmc-sel__head">
          <div className="bmc-eyebrow"><span>Selected buyer</span></div>
          <div className="bmc-sel__title">
            <h2>{title}</h2>
            <span className={cls('bmc-fit', `t-${b.tier}`)}><i />{TIER_LABEL[b.tier]}</span>
          </div>
          <div className="bmc-idchips">{chips.map((c) => <span key={c}>{c}</span>)}</div>
        </header>
        {line ? <p className="bmc-thesis">{line}</p> : null}

        <dl className="bmc-figs">
          <div><dt>Same-type buys within {w.query.radiusMiles}&nbsp;mi</dt><dd>{b.nearby?.sameFamily ?? 0}</dd></div>
          <div><dt>{b.activity.acquisitions >= 3 ? 'Median observed price' : 'Observed price'}</dt><dd>{priceFig ?? '—'}</dd></div>
          <div><dt>Purchases in the last 12&nbsp;months</dt><dd>{b.activity.t365}</dd></div>
          <div><dt>Since last purchase{asOf !== null ? <> · as of {asOfLabel(asOf)?.replace(/, \d{4}$/, '')}</> : null}</dt><dd>{days === null ? '—' : ageShort(days)}</dd></div>
        </dl>

        <div className="bmc-visbar">
          <div className="bmc-seg" role="tablist" aria-label="Purchase view" ref={tabsRef} onKeyDown={onTabKeys}>
            {VISUALS.map(([k, l]) => (
              <button key={k} data-k={k} type="button" role="tab" aria-selected={visual === k} tabIndex={visual === k ? 0 : -1} className={cls(visual === k && 'is-on')} onClick={() => setVisual(k)}>{l}</button>
            ))}
          </div>
          <span className="bmc-visbar__src">{profileState === 'loading' ? 'Loading purchases…' : `${plural(set.receipts.length, 'recorded purchase')}`}</span>
        </div>
        <div className="bmc-visframe">
          {visual === 'geo' ? <Footprint w={w} set={set} holdings={holdings} open={open} action={action} windowLabel={windowLabel} loading={profileState === 'loading'} asOf={asOf} /> : null}
          {visual === 'price' ? <PriceScatter w={w} set={set} open={open} action={action} loading={profileState === 'loading'} asOf={asOf} /> : null}
          {visual === 'activity' ? <ActivityReceipts w={w} set={set} open={open} action={action} windowLabel={windowLabel} loading={profileState === 'loading'} loadFailed={profileState === 'failed'} asOf={asOf} asOfText={asOfLabel(asOf)} /> : null}
        </div>

        <div className="bmc-railbar">
        <p className="bmc-contact"><i className={`c-${b.contact.state}`} />{b.contact.label}</p>
        <nav className="bmc-rail" aria-label="Buyer actions">
          <button type="button" className="bmc-btn is-primary" onClick={() => onBuyerGraph(b.id)}><Icon name="radar" />Open buyer</button>
          {hasPortfolio ? <button type="button" className="bmc-btn" onClick={() => onBuyerGraph(b.id, b.portfolio.owned ? 'owned' : 'portfolio')}><Icon name="layers" />View portfolio</button> : null}
          <button
            type="button"
            className="bmc-btn"
            disabled={!mappedPurchases.length && !mappedHoldings.length}
            onClick={() => toMap(`${title} · purchases`, 'buyer', [
              ...mappedPurchases.map((r) => ({ lat: r.lat, lng: r.lng, label: r.address, id: r.propertyId ?? undefined })),
              ...mappedHoldings.map((h) => ({ lat: h.lat, lng: h.lng, label: h.address, id: h.propertyId })),
            ])}
          ><Icon name="map" />Show on Map</button>
          <button type="button" className={cls('bmc-btn is-quiet', shortlisted && 'is-gold')} onClick={onShortlist} aria-pressed={shortlisted}><Icon name="star" />{shortlisted ? 'Shortlisted' : 'Shortlist'}</button>
        </nav>
        </div>
      </div>
    </section>
  )
}

/* ══ evidence ════════════════════════════════════════════════════════════ */

function ProofList({ rows, open, action, empty }: { rows: Receipt[]; open: OpenMark; action: MarkAction; empty?: string }) {
  if (!rows.length) return empty ? <p className="bmc-ev__none">{empty}</p> : null
  return (
    <ul className="bmc-proof">
      {rows.map((r) => {
        const m: Mark = { kind: 'receipt', r }
        const act = action(m)
        const body = (
          <>
            <span className="d">{shortDate(r.date)}</span>
            <span className="a">{street(r.address) ?? 'Recorded purchase'}<em>{[shortFamily(r.family), r.sqft ? `${Math.round(r.sqft).toLocaleString('en-US')} sf` : null].filter(Boolean).join(' · ')}</em></span>
            <span className="p">{r.price ? money(r.price) : '—'}</span>
            <span className="m">{r.miles !== null ? `${r.miles < 10 ? r.miles.toFixed(1) : Math.round(r.miles)} mi` : '—'}</span>
          </>
        )
        return <li key={r.key}>{act ? <button type="button" onClick={() => open(m)} title={act.label}>{body}</button> : <div>{body}</div>}</li>
      })}
    </ul>
  )
}

function ShareBars({ rows, max = 5 }: { rows: Array<{ key?: string; label: string; count: number; share: number | null }>; max?: number }) {
  const top = rows.slice(0, max)
  const peak = Math.max(1, ...top.map((r) => r.count))
  if (!top.length) return null
  return (
    <ul className="bmc-bars">
      {top.map((r) => (
        <li key={r.key ?? r.label} style={{ '--w': `${(r.count / peak) * 100}%` } as CSSProperties}>
          <span>{r.label}</span><b>{r.count}{r.share !== null ? <em> · {Math.round(r.share * 100)}%</em> : null}</b><i />
        </li>
      ))}
    </ul>
  )
}

const FAMILY_NAME: Record<string, string> = { sfr: 'Single family', small_multifamily_2_4: 'Multifamily 2–4', multifamily_unspecified: 'Multifamily', apartments_5plus: 'Apartments 5+', commercial_other: 'Commercial', self_storage: 'Self storage', retail_strip: 'Retail', land: 'Land', industrial: 'Industrial' }
const METHOD: Record<string, string> = {
  exact_registry_company_identity: 'Exact state-registry company match', seller_transaction_registry_exact: 'Registry match via recorded transaction',
  seller_transaction_company_corroboration: 'Company corroborated across transactions', officer_operator_corroboration: 'Officer / operator corroboration',
  transaction_linked_company_evidence: 'Company evidence on linked transactions', transaction_linked_contact_evidence: 'Contact evidence on linked transactions',
  property_linked_contact_tokenset: 'Property-linked contact evidence',
}

function EvRow({ id, label, finding, word, tone, isOpen, onToggle, children }: { id: string; label: string; finding: ReactNode; word?: string | null; tone?: string; isOpen: boolean; onToggle: (id: string) => void; children: ReactNode }) {
  return (
    <div className={cls('bmc-ev', tone && `f-${tone}`, isOpen && 'is-open')}>
      <button type="button" className="bmc-ev__head" aria-expanded={isOpen} aria-controls={`bmc-ev-${id}`} onClick={() => onToggle(id)}>
        <span className="bmc-ev__k">{label}</span>
        {word ? <span className="bmc-ev__s"><i />{word}</span> : null}
        <span className="bmc-ev__v">{finding}</span>
        <Icon name="chevron-down" />
      </button>
      {isOpen ? <div className="bmc-ev__body" id={`bmc-ev-${id}`}>{children}</div> : null}
    </div>
  )
}

function WhyThisBuyer({ b, w, set, holdings, profile, profileState, open, action, onBuyerGraph, asOf }: {
  b: MatchedBuyer; w: BuyerMatchWorkspace; set: ReturnType<typeof buildReceipts>; holdings: Holding[]; profile: BuyerProfile | null; profileState: 'loading' | 'ready' | 'failed'
  open: OpenMark; action: MarkAction; onBuyerGraph: (id: string, section?: string) => void; asOf: number | null
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())
  useEffect(() => { setOpenIds(new Set()) }, [b.id])
  const toggle = (id: string) => setOpenIds((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const s = w.subject
  const win = s.window
  const R = w.query.radiusMiles
  const rs = set.receipts
  const sw = (dim: Dim) => strength(dim, verdictOf(b, dim))
  const pending = profileState === 'loading' ? <p className="bmc-ev__none">Loading the buyer’s profile…</p> : null

  // PROPERTY TYPE
  const typeFinding = b.fit.type === 'dominant' ? `${b.buyBox.dominant ?? s.familyLabel} is their focus`
    : b.fit.type === 'present' ? `${s.familyLabel} in their mix`
    : b.fit.type === 'absent' ? `Buys ${b.buyBox.dominant ?? 'other asset types'}` : 'No asset-type evidence'
  const sameType = rs.filter((r) => r.sameFamily === true)
  // PRICE
  const band = b.buyBox.priceLow && b.buyBox.priceHigh && b.activity.acquisitions >= 3 && b.buyBox.priceLow !== b.buyBox.priceHigh
  const priceFinding = band ? `Pays ${money(b.buyBox.priceLow)}–${money(b.buyBox.priceHigh)}` : b.buyBox.priceMid ? `Paid ${money(b.buyBox.priceMid)}` : 'No priced purchases'
  const inWin = win ? rs.filter((r) => r.price !== null && !r.nominal && r.price >= win.low && r.price <= win.high) : []
  const pricedN = rs.filter((r) => r.price !== null && !r.nominal).length
  // GEOGRAPHY
  const nb = b.nearby
  const geoFinding = nb && nb.purchases > 0
    ? [nb.nearestMiles !== null ? `Nearest ${nb.nearestMiles.toFixed(1)} mi` : null, nb.sameZip ? `${nb.sameZip} in ZIP ${s.zip ?? ''}`.trim() : nb.within1mi ? `${nb.within1mi} within 1 mi` : null].filter(Boolean).join(' · ')
    : b.countyPurchases ? `${b.countyPurchases} in ${s.county ? `${s.county} County` : 'the county'}` : 'No purchases near the subject'
  const nearRows = rs.filter((r) => r.inWindow).sort((x, y) => (x.miles ?? 99) - (y.miles ?? 99))
  const countyUsed = !(nb && nb.purchases > 0)
  const geoNote = [
    nb?.medianPrice ? `Median ${money(nb.medianPrice)} within ${R} mi` : null,
    nb && nb.cashShare !== null && nb.purchases >= 3 ? `${Math.round(nb.cashShare * 100)}% cash nearby` : null,
    !countyUsed && b.countyPurchases ? `${b.countyPurchases} in ${s.county ? `${s.county} County` : 'the county'}` : null,
  ].filter(Boolean).join(' · ')
  // RECENCY
  const a = b.activity
  const recFinding = a.t90 > 0 ? `${plural(a.t90, 'purchase')} in the last 90 days` : a.t180 > 0 ? `${plural(a.t180, 'purchase')} in the last 180 days` : 'None in the last 180 days'
  // SIZE
  const sizeFinding = sfRange(b.buyBox.sqftLow, b.buyBox.sqftHigh) ? `Buys ${sfRange(b.buyBox.sqftLow, b.buyBox.sqftHigh)}` : 'No size evidence'
  const sized = rs.filter((r) => r.sqft !== null).sort((x, y) => Math.abs((x.sqft as number) - (s.sqft ?? 0)) - Math.abs((y.sqft as number) - (s.sqft ?? 0)))
  // CASH & EXIT
  const cashShare = b.activity.acquisitions >= 3 ? b.buyBox.cashShare : null
  const exitFinding = [b.behavior.holdFlip ?? 'No resale evidence', cashShare !== null ? `${Math.round(cashShare * 100)}% cash` : null].filter(Boolean).join(' · ')
  const auction = b.evidence.find((e) => e.k === 'auction')
  // HOLDINGS
  const holdFinding = [`Owns ${b.portfolio.owned}`, `sold ${b.portfolio.sold}`, b.portfolio.observed ? `portfolio ${b.portfolio.observed}` : null].filter(Boolean).join(' · ')
  // IDENTITY
  const reg = profile?.registry
  const idFinding = METHOD[b.identity.method ?? ''] ?? b.identity.label

  return (
    <div className="bmc-why">
      {b.tier !== 'excluded' ? <p className="bmc-rule"><b>{TIER_LABEL[b.tier]}</b> — {w.tierRules[b.tier]}</p> : null}
      <EvRow id="type" label={DIM_LABEL.type} finding={typeFinding} word={sw('type').word} tone={sw('type').tone} isOpen={openIds.has('type')} onToggle={toggle}>
        {profile?.assets.families.length ? <ShareBars rows={profile.assets.families.map((f) => ({ ...f, label: FAMILY_NAME[f.key] ?? f.label }))} max={4} /> : b.buyBox.families.length ? <p className="bmc-ev__note">{b.buyBox.families.join(' · ')}</p> : pending}
        <span className="bmc-ev__sub">Same-type purchases on record</span>
        <ProofList rows={sameType.slice(0, 5)} open={open} action={action} empty={set.complete ? 'None of the located purchases is the subject’s type.' : undefined} />
      </EvRow>
      <EvRow id="price" label={DIM_LABEL.price} finding={priceFinding} word={sw('price').word} tone={sw('price').tone} isOpen={openIds.has('price')} onToggle={toggle}>
        {win && b.buyBox.priceLow && b.buyBox.priceHigh ? (
          <div className="bmc-ev__bar"><PriceBar bandLow={b.buyBox.priceLow} bandHigh={b.buyBox.priceHigh} winLow={win.low} winHigh={win.high} /><span><i className="k-band" />their p25–p75</span><span><i className="k-win" />dispo window</span></div>
        ) : null}
        {win && pricedN ? <p className="bmc-ev__note">{inWin.length} of {plural(pricedN, 'priced purchase')} fell inside the dispo window.</p> : null}
        {profile?.price.recentMedian ? <p className="bmc-ev__note">Last 12 months median {money(profile.price.recentMedian)}.</p> : null}
        <ProofList rows={inWin.slice(0, 5)} open={open} action={action} />
      </EvRow>
      <EvRow id="geo" label={DIM_LABEL.market} finding={geoFinding} word={sw('market').word} tone={sw('market').tone} isOpen={openIds.has('geo')} onToggle={toggle}>
        {geoNote ? <p className="bmc-ev__note">{geoNote}</p> : null}
        <span className="bmc-ev__sub">Purchases within {R} mi</span>
        <ProofList rows={nearRows.slice(0, 6)} open={open} action={action} empty="No located purchase inside the radius." />
        {profile?.geography.counties.length ? <><span className="bmc-ev__sub">Where they buy</span><ShareBars rows={profile.geography.counties} max={4} /></> : null}
        {profile?.geography.zips.length ? <ShareBars rows={profile.geography.zips.map((z) => ({ ...z, label: `ZIP ${z.label}` }))} max={4} /> : null}
      </EvRow>
      <EvRow id="recency" label={DIM_LABEL.recency} finding={recFinding} word={sw('recency').word} tone={sw('recency').tone} isOpen={openIds.has('recency')} onToggle={toggle}>
        <p className="bmc-ev__note">{[a.t90 > 0 && a.t180 > 0 ? `${a.t180} in 180 days` : null, a.first ? `Buying since ${monthYear(a.first)}` : null, a.status ? a.status.replace(/_/g, ' ') : null].filter(Boolean).join(' · ') || 'No cadence recorded beyond the last purchase.'}</p>
        {asOf !== null ? <p className="bmc-ev__none">Counted to {asOfLabel(asOf)}, the buyer model’s date.</p> : null}
        {profile?.activity.byYear.length ? (
          <div className="bmc-years">
            {(() => { const peak = Math.max(1, ...profile.activity.byYear.map((y) => y.count)); return profile.activity.byYear.slice(-6).map((y) => <div key={y.year} style={{ '--h': `${(y.count / peak) * 100}%` } as CSSProperties}><i /><b>{y.count}</b><span>{y.year}</span></div>) })()}
          </div>
        ) : null}
        <ProofList rows={rs.slice(0, 4)} open={open} action={action} />
      </EvRow>
      <EvRow id="size" label={DIM_LABEL.size} finding={sizeFinding} word={sw('size').word} tone={sw('size').tone} isOpen={openIds.has('size')} onToggle={toggle}>
        <p className="bmc-ev__note">{[s.sqft ? `Subject ${s.sqft.toLocaleString('en-US')} sf` : null, b.buyBox.beds ? `their median ${b.buyBox.beds} bd` : null, b.buyBox.units && b.buyBox.units > 1 ? `median ${b.buyBox.units} units` : null].filter(Boolean).join(' · ')}</p>
        <ProofList rows={sized.slice(0, 5)} open={open} action={action} empty={set.complete ? 'No located purchase records a size.' : undefined} />
      </EvRow>

      <div className="bmc-why__group">Profile</div>
      <EvRow id="exit" label="Cash & exit" finding={exitFinding} isOpen={openIds.has('exit')} onToggle={toggle}>
        <p className="bmc-ev__note">{[profile?.behavior.medianHoldDays ? `Median hold ${Math.round(profile.behavior.medianHoldDays)} days` : null, nb && nb.cashShare !== null && nb.purchases >= 3 ? `${Math.round(nb.cashShare * 100)}% cash nearby` : null].filter(Boolean).join(' · ') || 'No hold-period or nearby cash evidence recorded.'}</p>
        {auction ? <p className="bmc-ev__note"><b>{auction.text}</b>{auction.sub ? ` — ${auction.sub}` : ''}</p> : null}
        {profile?.buybox ? <p className="bmc-ev__note">Derived buy box: {profile.buybox.families.map((f) => FAMILY_NAME[f] ?? f).join(', ') || 'any type'} · {profile.buybox.counties.slice(0, 3).map((c) => c.replace('|', ' ')).join(', ')}{profile.buybox.evidenceDepth ? ` · evidence depth ${profile.buybox.evidenceDepth}` : ''}.</p> : null}
      </EvRow>
      <EvRow id="hold" label="Holdings" finding={holdFinding} isOpen={openIds.has('hold')} onToggle={toggle}>
        {b.portfolio.crossover ? <p className="bmc-ev__note"><b>Also a seller / owner in our records</b> — see its full role history in Entity Graph.</p> : null}
        {holdings.length ? (
          <ul className="bmc-proof">
            {holdings.slice(0, 8).map((h) => (
              <li key={h.key}><button type="button" onClick={() => open({ kind: 'holding', h })} title="Open in Entity Graph">
                <span className="d">{h.basis.startsWith('Owns') ? 'Owns' : 'Portfolio'}</span>
                <span className="a">{street(h.address) ?? h.propertyId}<em>{[h.address?.split(',').slice(1).join(',').trim(), h.propertyType].filter(Boolean).join(' · ')}</em></span>
                <span className="p">{money(h.value) ?? '—'}</span>
                <span className="m">{h.miles !== null ? `${h.miles < 10 ? h.miles.toFixed(1) : Math.round(h.miles)} mi` : '—'}</span>
              </button></li>
            ))}
          </ul>
        ) : profileState === 'loading' ? pending : <p className="bmc-ev__none">No current holdings linked in the property record.</p>}
        {b.portfolio.owned + b.portfolio.observed > 0 ? <button type="button" className="bmc-btn is-inline" onClick={() => onBuyerGraph(b.id, b.portfolio.owned ? 'owned' : 'portfolio')}><Icon name="layers" />Portfolio in Entity Graph</button> : null}
      </EvRow>
      <EvRow id="identity" label="Identity" finding={idFinding} word={b.identity.label} tone={b.identity.tier === 'registry' || b.identity.tier === 'corroborated' ? 'good' : 'unk'} isOpen={openIds.has('identity')} onToggle={toggle}>
        {reg?.company_number ? <p className="bmc-ev__note">{reg.jurisdiction?.toUpperCase()} #{reg.company_number}{reg.status ? ` · ${reg.status}` : ''}{reg.incorporated ? ` · since ${reg.incorporated.slice(0, 4)}` : ''}</p> : null}
        <p className="bmc-ev__note">Resolved across {plural(b.identity.aliases, 'name form')} and its linked recorded transactions{b.behavior.foreclosureDeeds ? ` — ${b.behavior.foreclosureDeeds} of them on foreclosure deeds` : ''}.</p>
        {b.nameWithheld || b.kind === 'person' ? <p className="bmc-ev__note">Name withheld — individuals are never named in Buyer Match.</p> : null}
        {profile?.aliases.length ? <p className="bmc-ev__note">Aliases: {profile.aliases.slice(0, 8).map((x) => `${x.name}${x.provisional ? ' (provisional)' : ''}`).join(' · ')}</p> : null}
        {profile?.network.length ? (
          <ul className="bmc-rel">{profile.network.slice(0, 6).map((n, i) => <li key={`${n.other?.id}-${i}`}><b>{n.other?.name}</b><em>{[n.role, n.basis].filter(Boolean).join(' · ')}</em></li>)}</ul>
        ) : null}
      </EvRow>
      {b.exclusions.length ? (
        <div className="bmc-out"><b>Why not this buyer</b><ul>{b.exclusions.map((e) => <li key={e.code}>{e.label}</li>)}</ul></div>
      ) : null}
    </div>
  )
}

function MarketContext({ w, shortlisted }: { w: BuyerMatchWorkspace; shortlisted: number }) {
  const m = w.market
  const win = w.subject.window
  const d = w.disposition
  const steps: Array<[string, number, string]> = [
    ['Matched', w.counts.matched, 'system evidence'],
    ['Shortlisted', shortlisted, 'you · this device'],
    ['Contacted', d.contacted, 'outreach sent'],
    ['Interested', d.replied + d.markedInterested, 'replied or marked'],
    ['Offered', d.offers, 'buyer offers'],
    ['Selected', d.selectedBuyer ? 1 : 0, 'chosen buyer'],
    ['Committed', d.committed, 'commitment evidence'],
    ['Agreement', d.agreementExecuted, 'fully executed'],
    ['EMD', d.emdReceived, 'receipt verified'],
  ]
  return (
    <div className="bmc-market">
      <div className="bmc-mgroup">
        <div className="bmc-mgroup__h"><span>Observed buyer activity</span><em>{w.query.radiusMiles} mi · {w.query.months} mo</em></div>
        <dl className="bmc-mfigs">
          <div><dt>resolved buyers purchased here</dt><dd>{m.buyersInRadius}</dd></div>
          <div><dt>{w.subject.familyLabel.toLowerCase()} purchases</dt><dd>{m.sameTypeTransactionsInRadius}</dd></div>
          <div><dt>bought same type ≤ 2 mi</dt><dd>{m.nearbySimilarBuyers}</dd></div>
          <div><dt>matched buyers active in 90 days</dt><dd>{m.activeLast90}</dd></div>
        </dl>
        {m.countyBuyersActive24m !== null ? <p className="bmc-ev__note">{m.countyBuyersActive24m.toLocaleString('en-US')} buyers purchased in {w.subject.county ? `${w.subject.county} County` : 'the county'} in the last 24 months.</p> : null}
        {m.matchedPriceBand && win ? (
          <div className="bmc-mband">
            <p><span>Matched buyers typically pay</span><b>{money(m.matchedPriceBand.low)}–{money(m.matchedPriceBand.high)}</b></p>
            <div className="bmc-ev__bar"><PriceBar bandLow={m.matchedPriceBand.low} bandHigh={m.matchedPriceBand.high} winLow={win.low} winHigh={win.high} /></div>
            <p className="bmc-ev__note">Median of the strong and moderate buyers’ p25–p75 purchase prices ({m.matchedPriceBand.buyers} buyers) against this deal’s {win.basis === 'offer_to_value' ? 'offer → value' : 'value'} window. Observed behaviour, not a disposition guarantee.</p>
          </div>
        ) : null}
      </div>
      <div className="bmc-mgroup">
        <div className="bmc-mgroup__h"><span>Disposition state</span><em>read from outreach, offers &amp; agreements</em></div>
        <ol className="bmc-states">
          {steps.map(([k, v, sub]) => <li key={k} className={cls(v > 0 && 'is-on')}><b>{v}</b><span>{k}</span><em>{sub}</em></li>)}
        </ol>
        <p className="bmc-ev__note">A match or shortlist never advances a buyer. Commitment, agreement and EMD appear only from their own records.</p>
      </div>
      <div className="bmc-mgroup">
        <div className="bmc-mgroup__h"><span>Buyer outreach</span><em>{w.contactability.verified} verified contacts</em></div>
        <p className="bmc-ev__note">{w.contactability.note}</p>
      </div>
      <details className="bmc-mgroup bmc-method">
        <summary><span>Evidence &amp; method</span><Icon name="chevron-down" /></summary>
        <dl>
          <div><dt>Identity</dt><dd>{w.lineage.identity}</dd></div>
          <div><dt>Evidence</dt><dd>{w.lineage.evidence}</dd></div>
          <div><dt>Window</dt><dd>{w.lineage.window}</dd></div>
          {w.transactions ? <div><dt>Purchases</dt><dd>{w.transactions.available ? `Located purchases from the ${w.transactions.radiusMiles} mi · ${w.transactions.months} mo market read (${w.transactions.returned} of ${w.transactions.total} recorded transactions${w.transactions.truncated ? ', nearest first' : ''}); full purchase lists from the Entity Graph buyer model.` : 'The located-purchase read is unavailable right now; purchase lists come from the Entity Graph buyer model.'}</dd></div> : null}
          <div><dt>Strong</dt><dd>{w.tierRules.strong}</dd></div>
          <div><dt>Moderate</dt><dd>{w.tierRules.moderate}</dd></div>
          <div><dt>Exploratory</dt><dd>{w.tierRules.exploratory}</dd></div>
          <div><dt>Computed</dt><dd>{new Date(w.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — live on every visit, no stored run</dd></div>
        </dl>
      </details>
    </div>
  )
}

/* ══ cockpit ═════════════════════════════════════════════════════════════ */

export function BuyerMatchCockpit(p: CockpitProps) {
  const { w } = p
  const [scope, setScope] = useState<'listed' | 'ruledout'>('listed')
  const [visual, setVisual] = useState<Visual>('geo')
  const [evTab, setEvTab] = useState<'buyer' | 'market'>('buyer')
  const all = useMemo(() => [...w.buyers, ...w.excluded], [w])
  const sel = all.find((b) => b.id === p.selectedId) ?? p.visible[0] ?? w.buyers[0] ?? w.excluded[0] ?? null

  const [prof, setProf] = useState<{ id: string; state: 'loading' | 'ready' | 'failed'; profile: BuyerProfile | null }>({ id: '', state: 'loading', profile: null })
  const selId = sel?.id ?? null
  useEffect(() => {
    if (!selId) return
    const ctl = new AbortController()
    setProf({ id: selId, state: 'loading', profile: null })
    fetchBuyerProfile(selId, ctl.signal)
      .then((pr) => { if (!ctl.signal.aborted) setProf({ id: selId, state: pr ? 'ready' : 'failed', profile: pr }) })
      .catch(() => { if (!ctl.signal.aborted) setProf({ id: selId, state: 'failed', profile: null }) })
    return () => ctl.abort()
  }, [selId])
  const profile = prof.id === selId ? prof.profile : null
  const profileState = prof.id === selId ? prof.state : 'loading'

  const set = useMemo(() => (sel ? buildReceipts(sel, w, profile) : null), [sel, w, profile])
  const asOf = useMemo(() => modelAsOf(w), [w])
  const holdings = useMemo(() => holdingsOf(profile, w.subject), [profile, w.subject])
  const tx = w.transactions
  const windowLabel = tx?.truncated ? `the ${tx.returned} nearest loaded` : `${w.query.radiusMiles} mi · ${w.query.months} mo`
  const title = sel ? buyerTitle(sel) : ''

  const action: MarkAction = (m) => {
    if (m.kind === 'holding') return { label: 'Open in Entity Graph', icon: 'radar' }
    if (m.r.inUniverse && m.r.propertyId) return { label: 'Open in Entity Graph', icon: 'radar' }
    if (m.r.lat !== null && m.r.lng !== null) return { label: 'Show on Map', icon: 'map' }
    return null
  }
  const open: OpenMark = (m) => {
    if (m.kind === 'holding') { p.onProperty(m.h.propertyId); return }
    const r = m.r
    if (r.inUniverse && r.propertyId) { p.onProperty(r.propertyId); return }
    if (r.lat !== null && r.lng !== null) p.toMap(`${title} · ${street(r.address) ?? 'purchase'}`, 'buyer', [{ lat: r.lat, lng: r.lng, label: r.address, id: r.propertyId ?? undefined }])
  }

  const shortlisted = p.shortlist.filter((id) => w.buyers.some((b) => b.id === id)).length

  return (
    <div className={cls('bmx', 'is-desk', 'is-cockpit', p.loading && 'is-refreshing')} data-theme={p.theme}>
      <ContextStrip w={w} onDeal={p.onDeal} onComps={p.onComps} onGraph={p.onGraph} onMap={p.onMatchedMap} onPipeline={p.onPipeline} />
      <div className="bmc-planes">
        <Universe {...p} scope={scope} setScope={setScope} selId={sel?.id ?? null} />
        <div className="bmc-detail">
          {sel && set ? (
            <Selected
              b={sel} w={w} set={set} holdings={holdings} profileState={profileState}
              visual={visual} setVisual={setVisual}
              shortlisted={p.shortlist.includes(sel.id)} onShortlist={() => p.onShortlist(sel.id)}
              open={open} action={action} windowLabel={windowLabel}
              onBuyerGraph={p.onBuyerGraph} toMap={p.toMap} asOf={asOf}
            />
          ) : (
            <section className="bmc-plane bmc-selected is-empty" aria-label="Selected buyer">
              <p>No buyer to show yet. Widen the radius or the window — or see who was ruled out and why.</p>
            </section>
          )}
          <section className="bmc-plane bmc-evidence" aria-label="Evidence">
            <header className="bmc-evhead">
              <div className="bmc-seg" role="tablist" aria-label="Evidence">
                <button type="button" role="tab" aria-selected={evTab === 'buyer'} className={cls(evTab === 'buyer' && 'is-on')} onClick={() => setEvTab('buyer')} disabled={!sel}>Why this buyer</button>
                <button type="button" role="tab" aria-selected={evTab === 'market'} className={cls(evTab === 'market' && 'is-on')} onClick={() => setEvTab('market')}>Market</button>
              </div>
            </header>
            {evTab === 'buyer' && sel && set ? (
              <WhyThisBuyer b={sel} w={w} set={set} holdings={holdings} profile={profile} profileState={profileState} open={open} action={action} onBuyerGraph={p.onBuyerGraph} asOf={asOf} />
            ) : (
              <MarketContext w={w} shortlisted={shortlisted} />
            )}
          </section>
        </div>
      </div>
      {p.compareDock}
      {p.sheets}
    </div>
  )
}

export default BuyerMatchCockpit
