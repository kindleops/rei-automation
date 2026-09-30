/**
 * BUYER MATCH — portaled sheets: buyer inspector (lazy Entity Graph profile),
 * compare, and search/filter controls. Portaled to <body>, so each root
 * carries the theme tokens itself (.bmx-sheet).
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { BuyerMatchWorkspace, MatchedBuyer } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { ago, daysSince, money } from '../../../domain/buyer-match/buyer-match-workspace-api'
import type { BuyerProfile } from '../../../domain/entity-graph/entity-graph-intel-api'
import { fetchBuyerProfile } from '../../../domain/entity-graph/entity-graph-intel-api'
import { FitTable, PriceBar, TIER_LABEL, buyerTitle, cls } from './BuyerMatchParts'

type InspectorTab = 'why' | 'box' | 'activity' | 'portfolio' | 'geo' | 'entity'
const TABS: Array<[InspectorTab, string]> = [['why', 'Why'], ['box', 'Buy box'], ['activity', 'Activity'], ['portfolio', 'Portfolio'], ['geo', 'Geography'], ['entity', 'Entity']]

const FAMILY: Record<string, string> = { sfr: 'Single family', small_multifamily_2_4: 'Multifamily 2–4', multifamily_unspecified: 'Multifamily', apartments_5plus: 'Apartments 5+', commercial_other: 'Commercial', self_storage: 'Self storage', retail_strip: 'Retail', land: 'Land', industrial: 'Industrial' }
const METHOD: Record<string, string> = {
  exact_registry_company_identity: 'Exact state-registry company match', seller_transaction_registry_exact: 'Registry match via recorded transaction',
  seller_transaction_company_corroboration: 'Company corroborated across transactions', officer_operator_corroboration: 'Officer / operator corroboration',
  transaction_linked_company_evidence: 'Company evidence on linked transactions', transaction_linked_contact_evidence: 'Contact evidence on linked transactions',
  property_linked_contact_tokenset: 'Property-linked contact evidence',
}

function Bars({ rows, max = 6 }: { rows: Array<{ label: string; count: number; share: number | null }>; max?: number }) {
  const top = rows.slice(0, max)
  const peak = Math.max(1, ...top.map((r) => r.count))
  if (!top.length) return <p className="bmx-note">No evidence recorded.</p>
  return (
    <ul className="bmx-bars">
      {top.map((r, i) => (
        <li key={r.label} style={{ '--w': `${(r.count / peak) * 100}%`, '--i': i } as CSSProperties}>
          <span>{r.label}</span><b>{r.count}{r.share !== null ? <em> · {Math.round(r.share * 100)}%</em> : null}</b><i />
        </li>
      ))}
    </ul>
  )
}

function Gauge({ value, label }: { value: number | null; label: string }) {
  const v = value === null ? null : Math.max(0, Math.min(1, value))
  return (
    <div className="bmx-gauge" style={{ '--v': v ?? 0 } as CSSProperties}>
      <div className="bmx-gauge__ring"><b>{v === null ? '—' : `${Math.round(v * 100)}%`}</b></div>
      <span>{label}</span>
    </div>
  )
}

export function BuyerInspector({ b, w, theme, shortlisted, docked = false, onShortlist, onClose, onGraph, onMap, onProperty }: {
  b: MatchedBuyer; w: BuyerMatchWorkspace; theme: string; shortlisted: boolean
  /** Desk: render inline beside the buyer list (not portalled, no scrim). */
  docked?: boolean
  onShortlist: () => void; onClose: () => void; onGraph: () => void
  onMap: (label: string, tone: 'buyer' | 'portfolio', points: Array<{ lat: number | null | undefined; lng: number | null | undefined; label?: string | null; id?: string }>) => void
  onProperty: (propertyId: string) => void
}) {
  const [tab, setTab] = useState<InspectorTab>('why')
  const [profile, setProfile] = useState<BuyerProfile | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    const ctl = new AbortController()
    setState('loading')
    fetchBuyerProfile(b.id, ctl.signal)
      .then((p) => { setProfile(p); setState(p ? 'ready' : 'failed') })
      .catch(() => { if (!ctl.signal.aborted) setState('failed') })
    return () => ctl.abort()
  }, [b.id])

  // Docked on a desk there is no scrim to click away: Escape closes it, unless
  // a modal sheet (compare, filters) is on top, or the key was meant for
  // another pane / a field elsewhere (split panes all listen for Escape).
  const dockRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!docked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.bmx-sheet:not(.is-docked)')) return
      const root = dockRef.current
      const target = e.target instanceof HTMLElement ? e.target : null
      if (root && target && target !== document.body && !root.contains(target)) {
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return
        const pane = root.closest('.dsk-pane')
        if (pane && !pane.contains(target)) return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [docked, onClose])

  // Docked, the inspector stays mounted while the operator walks the list, so
  // a different buyer starts at its evidence (and the top), not where the
  // previous buyer was left.
  useEffect(() => {
    if (!docked) return
    setTab('why')
    dockRef.current?.parentElement?.scrollTo({ top: 0 })
  }, [b.id, docked])

  const title = buyerTitle(b)
  const purchases = [...(profile?.purchases ?? [])].sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')))
  const win = w.subject.window

  const panel = (
      <div className="bmx-sheet__panel">
        {docked ? null : <div className="bmx-sheet__grab" />}
        <div className={cls('bmx-insp__head', `t-${b.tier}`)}>
          <div>
            <span className={cls('bmx-tier', `t-${b.tier}`)}>{TIER_LABEL[b.tier]}</span>
            <h3>{title}</h3>
            <p>{[b.identity.label, b.kind === 'company' ? 'Company' : 'Individual', b.identity.jurisdiction?.replace('us_', '').toUpperCase(), b.behavior.archetype].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="bmx-x" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="bmx-insp__kpis">
          <div><b>{b.activity.acquisitions}</b><span>purchases</span></div>
          <div><b>{b.activity.t365}</b><span>last 12 mo</span></div>
          <div><b>{b.activity.daysSince !== null ? (b.activity.daysSince < 45 ? `${b.activity.daysSince}d` : ago(b.activity.daysSince)?.replace(' ago', '')) : '—'}</b><span>last buy</span></div>
          <div><b>{b.nearby?.sameFamily ?? 0}</b><span>same-type near</span></div>
        </div>
        <nav className="bmx-tabs" role="tablist">
          {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={cls(tab === k && 'is-on')} onClick={() => setTab(k)}>{label}</button>)}
        </nav>

        {tab === 'why' ? (
          <div className="bmx-insp__body">
            {b.exclusions.length ? (
              <div className="bmx-callout is-not"><b>Why not this buyer</b><ul>{b.exclusions.map((e) => <li key={e.code}>{e.label}</li>)}</ul></div>
            ) : (
              <div className="bmx-callout"><b>{TIER_LABEL[b.tier]} — the rule</b><p>{b.tier !== 'excluded' ? w.tierRules[b.tier] : ''}</p></div>
            )}
            <span className="bmx-sub">Evidence</span>
            <ul className="bmx-evidence">{b.evidence.map((e, i) => <li key={e.k} style={{ '--i': i } as CSSProperties}><i /><b>{e.text}</b>{e.sub ? <em>{e.sub}</em> : null}</li>)}</ul>
            <span className="bmx-sub">Subject vs buyer</span>
            <FitTable b={b} w={w} />
            {b.recent.length ? (
              <>
                <span className="bmx-sub">Their purchases near this property</span>
                <ul className="bmx-tx">
                  {b.recent.map((r) => (
                    <li key={`${r.txnId}`}>
                      <button type="button" onClick={() => r.propertyId && onProperty(r.propertyId)} disabled={!r.propertyId}>
                        <span className="d">{r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</span>
                        <span className="a"><b>{r.address ?? 'Recorded purchase'}</b><em>{[r.family, r.beds ? `${r.beds} bd` : null, r.sqft ? `${Math.round(r.sqft).toLocaleString('en-US')} sf` : null, r.miles !== null ? `${r.miles.toFixed(1)} mi` : null].filter(Boolean).join(' · ')}</em></span>
                        <span className="p">{money(r.price) ?? '—'}{r.cash ? <em>cash</em> : null}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="bmx-btn" onClick={() => onMap(`${title} · purchases near subject`, 'buyer', b.recent)}><Icon name="map" />Show these on the map</button>
              </>
            ) : null}
            <div className={cls('bmx-callout', 'is-contact')}><b>{b.contact.label}</b><p>{w.contactability.note}</p></div>
          </div>
        ) : null}

        {tab === 'box' ? (
          <div className="bmx-insp__body">
            <p className="bmx-note">Observed from {b.activity.acquisitions} recorded purchase{b.activity.acquisitions === 1 ? '' : 's'}{profile?.buybox ? ' · derived buy box on record' : ''}. Only dimensions with evidence are shown.</p>
            <div className="bmx-box">
              <div className="bmx-box__cell is-wide"><span>Markets</span><div className="bmx-chips">{(profile?.geography.primaryMarkets.length ? profile.geography.primaryMarkets : b.buyBox.markets).slice(0, 5).map((m) => <i key={m}>{m}</i>)}</div></div>
              <div className="bmx-box__cell is-wide"><span>Asset types</span>{profile?.assets.families.length ? <Bars rows={profile.assets.families.map((f) => ({ ...f, label: FAMILY[f.key] ?? f.label }))} max={4} /> : <div className="bmx-chips">{b.buyBox.families.map((f) => <i key={f}>{f}</i>)}</div>}</div>
              {b.buyBox.priceLow && b.buyBox.priceHigh ? (
                <div className="bmx-box__cell is-wide"><span>Purchase range · p25–p75</span><b className="bmx-big">{money(b.buyBox.priceLow)} — {money(b.buyBox.priceHigh)}</b>{win ? <PriceBar bandLow={b.buyBox.priceLow} bandHigh={b.buyBox.priceHigh} winLow={win.low} winHigh={win.high} /> : null}{profile?.price.recentMedian ? <em>Last 12 months median {money(profile.price.recentMedian)} ({profile.price.recentCount} purchases)</em> : null}</div>
              ) : null}
              {b.buyBox.sqftLow && b.buyBox.sqftHigh ? <div className="bmx-box__cell"><span>Size</span><b>{Math.round(b.buyBox.sqftLow).toLocaleString('en-US')}–{Math.round(b.buyBox.sqftHigh).toLocaleString('en-US')} sf</b>{b.buyBox.beds ? <em>median {b.buyBox.beds} bd</em> : null}</div> : null}
              <div className="bmx-box__cell"><span>Recency</span><b>{b.fit.recency === 'active' ? 'Active' : b.fit.recency === 'recent' ? 'Recent' : b.fit.recency === 'slowing' ? 'Slowing' : '—'}</b><em>{b.activity.t90} in 90d · {b.activity.t365} in 12 mo</em></div>
              <div className="bmx-box__cell"><Gauge value={b.activity.acquisitions >= 3 ? b.buyBox.cashShare : null} label="observed cash" /></div>
              <div className="bmx-box__cell"><span>Exit behaviour</span><b>{b.behavior.holdFlip ?? 'No resale evidence'}</b>{profile?.behavior.medianHoldDays ? <em>median hold {Math.round(profile.behavior.medianHoldDays)} days</em> : null}</div>
            </div>
            {profile?.buybox ? <p className="bmx-note">Derived buy box: {profile.buybox.families.map((f) => FAMILY[f] ?? f).join(', ') || 'any type'} · {profile.buybox.counties.slice(0, 3).map((c) => c.replace('|', ' ')).join(', ')} · evidence depth {profile.buybox.evidenceDepth ?? '—'}.</p> : null}
          </div>
        ) : null}

        {tab === 'activity' ? (
          <div className="bmx-insp__body">
            <div className="bmx-cadence">
              <div><b>{b.activity.t90}</b><span>90 days</span></div>
              <div><b>{b.activity.t180}</b><span>180 days</span></div>
              <div><b>{b.activity.t365}</b><span>12 months</span></div>
              <div><b>{b.activity.acquisitions}</b><span>all observed</span></div>
            </div>
            {profile?.activity.byYear.length ? (
              <div className="bmx-years">
                {(() => { const peak = Math.max(1, ...profile.activity.byYear.map((y) => y.count)); return profile.activity.byYear.slice(-6).map((y, i) => (
                  <div key={y.year} style={{ '--h': `${(y.count / peak) * 100}%`, '--i': i } as CSSProperties}><i /><b>{y.count}</b><span>{y.year}</span></div>
                )) })()}
              </div>
            ) : null}
            <span className="bmx-sub">Purchase timeline</span>
            {state === 'loading' ? <div className="bmx-skel" /> : purchases.length ? (
              <ol className="bmx-timeline">
                {purchases.slice(0, 14).map((p, i) => (
                  <li key={String(p.id)} style={{ '--i': i } as CSSProperties}>
                    <button type="button" onClick={() => p.propertyId && onProperty(p.propertyId)} disabled={!p.propertyId}>
                      <span className="d">{p.date ? new Date(p.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}</span>
                      <span className="a"><b>{p.address ?? (p.city ? `Purchase in ${p.city}` : 'Recorded purchase')}</b><em>{[p.city, p.propertyType, p.cash ? 'cash' : p.cash === false ? 'financed' : null, p.docType].filter(Boolean).join(' · ')}</em></span>
                      <span className="p">{money(p.price) ?? '—'}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="bmx-note">No linked purchases returned.</p>}
            {purchases.some((p) => p.lat && p.lng) ? <button type="button" className="bmx-btn" onClick={() => onMap(`${title} · purchases`, 'buyer', purchases.map((p) => ({ lat: p.lat, lng: p.lng, label: p.address, id: p.propertyId ?? undefined })))}><Icon name="map" />Show all purchases on the map</button> : null}
          </div>
        ) : null}

        {tab === 'portfolio' ? (
          <div className="bmx-insp__body">
            <div className="bmx-cadence">
              <div><b>{profile?.roles.purchases ?? b.activity.acquisitions}</b><span>bought</span></div>
              <div><b>{profile?.roles.sold ?? b.portfolio.sold}</b><span>sold</span></div>
              <div><b>{profile?.roles.owned ?? b.portfolio.owned}</b><span>owns now</span></div>
              <div><b>{profile?.roles.portfolio ?? b.portfolio.observed}</b><span>portfolio obs.</span></div>
            </div>
            {b.portfolio.crossover ? <div className="bmx-callout"><b>Also a seller / owner in our records</b><p>This entity appears on the ownership side too — see its full role history in Entity Graph.</p></div> : null}
            {profile?.roles.portfolioValue ? <p className="bmx-note">Observed portfolio value {money(profile.roles.portfolioValue)}.</p> : null}
            <span className="bmx-sub">Holdings on record</span>
            {state === 'loading' ? <div className="bmx-skel" /> : (profile?.owned.length || profile?.portfolio.length) ? (
              <ul className="bmx-holdings">
                {[...(profile?.owned ?? []).map((o) => ({ id: o.propertyId, address: o.address, sub: [o.propertyType, o.market].filter(Boolean).join(' · '), value: o.value })),
                  ...(profile?.portfolio ?? []).map((o) => ({ id: o.propertyId, address: o.address, sub: o.propertyType ?? '', value: o.value }))].slice(0, 12).map((o) => (
                  <li key={o.id}><button type="button" onClick={() => onProperty(o.id)}><b>{o.address ?? o.id}</b><em>{o.sub}</em><span>{money(o.value) ?? ''}</span></button></li>
                ))}
              </ul>
            ) : <p className="bmx-note">No current holdings linked in the property record — observed purchases are under Activity.</p>}
            {profile && [...profile.owned, ...profile.portfolio].some((o) => o.lat && o.lng) ? <button type="button" className="bmx-btn" onClick={() => onMap(`${title} · portfolio`, 'portfolio', [...profile.owned, ...profile.portfolio].map((o) => ({ lat: o.lat, lng: o.lng, label: o.address, id: o.propertyId })))}><Icon name="map" />Show portfolio on the map</button> : null}
          </div>
        ) : null}

        {tab === 'geo' ? (
          <div className="bmx-insp__body">
            {state === 'loading' ? <div className="bmx-skel" /> : profile ? (
              <>
                {profile.geography.concentration !== null ? <p className="bmx-note">Concentration index {profile.geography.concentration.toFixed(2)} (1 = all purchases in one county).</p> : null}
                <span className="bmx-sub">Counties</span><Bars rows={profile.geography.counties} />
                <span className="bmx-sub">Cities</span><Bars rows={profile.geography.cities} />
                <span className="bmx-sub">ZIP codes</span><Bars rows={profile.geography.zips} max={8} />
              </>
            ) : <p className="bmx-note">Geography unavailable.</p>}
          </div>
        ) : null}

        {tab === 'entity' ? (
          <div className="bmx-insp__body">
            <div className="bmx-idcard">
              <span className={cls('bmx-idtier', `i-${b.identity.tier}`)}>{b.identity.label}</span>
              <b>{METHOD[b.identity.method ?? ''] ?? 'Resolved identity'}</b>
              {profile?.registry?.company_number ? <em>{profile.registry.jurisdiction?.toUpperCase()} #{profile.registry.company_number}{profile.registry.status ? ` · ${profile.registry.status}` : ''}{profile.registry.incorporated ? ` · since ${profile.registry.incorporated.slice(0, 4)}` : ''}</em> : null}
              {b.nameWithheld || b.kind === 'person' ? <em>Name withheld — individuals are never named in Buyer Match.</em> : null}
            </div>
            {profile?.aliases.length ? (<><span className="bmx-sub">Aliases collapsed into this entity</span><div className="bmx-chips">{profile.aliases.slice(0, 8).map((a) => <i key={a.name}>{a.name}{a.provisional ? ' · provisional' : ''}</i>)}</div></>) : null}
            {profile?.network.length ? (<><span className="bmx-sub">Company relationships</span><ul className="bmx-holdings">{profile.network.slice(0, 8).map((n, i) => <li key={`${n.other?.id}-${i}`}><div><b>{n.other?.name}</b><em>{[n.role, n.basis].filter(Boolean).join(' · ')}</em></div></li>)}</ul></>) : null}
            <div className="bmx-callout"><b>Evidence behind this identity</b><p>{b.identity.aliases} name form{b.identity.aliases === 1 ? '' : 's'} · {b.behavior.linkedTransactions} linked recorded transaction{b.behavior.linkedTransactions === 1 ? '' : 's'}{b.behavior.foreclosureDeeds ? ` · ${b.behavior.foreclosureDeeds} on foreclosure deeds` : ''}.</p></div>
            <button type="button" className="bmx-btn is-primary" onClick={onGraph}><Icon name="radar" />Open in Entity Graph</button>
          </div>
        ) : null}

        {state === 'failed' && tab !== 'why' ? <p className="bmx-note">The full buyer profile couldn’t load — the match evidence above is unaffected.</p> : null}
        <div className="bmx-insp__actions">
          <button type="button" className={cls('bmx-btn', shortlisted && 'is-gold')} onClick={onShortlist}><Icon name="star" />{shortlisted ? 'On your shortlist' : 'Shortlist'}</button>
          <button type="button" className="bmx-btn" onClick={onGraph}><Icon name="radar" />Entity Graph</button>
        </div>
      </div>
  )

  if (docked) {
    return (
      <div ref={dockRef} className="bmx-sheet is-inspector is-docked" data-theme={theme} role="region" aria-label={`${title} — buyer intelligence`}>
        {panel}
      </div>
    )
  }

  return createPortal(
    <div className="bmx-sheet is-inspector" data-theme={theme} role="dialog" aria-label={`${title} — buyer intelligence`}>
      <button type="button" className="bmx-sheet__scrim" aria-label="Close" onClick={onClose} />
      {panel}
    </div>,
    document.body,
  )
}

export function CompareSheet({ buyers, w, theme, onClose, onOpen }: { buyers: MatchedBuyer[]; w: BuyerMatchWorkspace; theme: string; onClose: () => void; onOpen: (b: MatchedBuyer) => void }) {
  const rows: Array<[string, (b: MatchedBuyer) => string]> = [
    ['Fit', (b) => TIER_LABEL[b.tier]],
    ['Same-type nearby', (b) => String(b.nearby?.sameFamily ?? 0)],
    ['Last 12 months', (b) => `${b.activity.t365} buys`],
    ['Last purchase', (b) => ago(b.activity.daysSince) ?? '—'],
    ['Pays', (b) => (b.buyBox.priceLow && b.buyBox.priceHigh ? `${money(b.buyBox.priceLow)}–${money(b.buyBox.priceHigh)}` : money(b.buyBox.priceMid) ?? '—')],
    ['Price fit', (b) => ({ inside: 'Inside window', near: 'Close', outside: 'Outside', unknown: 'No evidence' } as Record<string, string>)[b.fit.price.verdict] ?? b.fit.price.verdict],
    ['Asset focus', (b) => b.buyBox.dominant ?? '—'],
    ['Cash', (b) => (b.buyBox.cashShare !== null && b.activity.acquisitions >= 3 ? `${Math.round(b.buyBox.cashShare * 100)}%` : '—')],
    ['Exit', (b) => b.behavior.holdFlip ?? '—'],
    ['Identity', (b) => b.identity.label],
    ['Contact', (b) => b.contact.label],
  ]
  return createPortal(
    <div className="bmx-sheet" data-theme={theme} role="dialog" aria-label="Compare buyers">
      <button type="button" className="bmx-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className="bmx-sheet__panel">
        <div className="bmx-sheet__grab" />
        <div className="bmx-insp__head"><div><span className="bmx-eyebrow is-aqua"><i />Compare</span><h3>{buyers.length} buyers for {w.subject.address?.split(',')[0]}</h3></div><button type="button" className="bmx-x" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        <div className="bmx-compare" style={{ '--n': buyers.length } as CSSProperties}>
          <div className="bmx-compare__row is-head"><span />{buyers.map((b) => <button key={b.id} type="button" className={`t-${b.tier}`} onClick={() => onOpen(b)}>{buyerTitle(b)}</button>)}</div>
          {rows.map(([k, f], i) => (
            <div key={k} className="bmx-compare__row" style={{ '--i': i } as CSSProperties}><span>{k}</span>{buyers.map((b) => <b key={b.id}>{f(b)}</b>)}</div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export type Filters = { tiers: Set<string>; kind: 'all' | 'company' | 'person'; registryOnly: boolean; active90: boolean; priceInside: boolean }
export const DEFAULT_FILTERS: Filters = { tiers: new Set(['strong', 'moderate', 'exploratory']), kind: 'all', registryOnly: false, active90: false, priceInside: false }

export function ControlsSheet({ w, theme, filters, setFilters, onRadius, onMonths, onClose }: {
  w: BuyerMatchWorkspace; theme: string; filters: Filters; setFilters: (f: Filters) => void
  onRadius: (r: number) => void; onMonths: (m: number) => void; onClose: () => void
}) {
  const toggleTier = (t: string) => { const next = new Set(filters.tiers); if (next.has(t)) next.delete(t); else next.add(t); setFilters({ ...filters, tiers: next }) }
  return createPortal(
    <div className="bmx-sheet" data-theme={theme} role="dialog" aria-label="Search and filters">
      <button type="button" className="bmx-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className="bmx-sheet__panel">
        <div className="bmx-sheet__grab" />
        <div className="bmx-insp__head"><div><span className="bmx-eyebrow is-aqua"><i />Search area</span><h3>Where and how far back</h3></div><button type="button" className="bmx-x" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        <span className="bmx-sub">Radius around the subject</span>
        <div className="bmx-seg">{w.query.radiusOptions.map((r) => <button key={r} type="button" className={cls(w.query.radiusMiles === r && 'is-on')} onClick={() => onRadius(r)}>{r} mi</button>)}</div>
        <span className="bmx-sub">Purchase window</span>
        <div className="bmx-seg">{w.query.monthOptions.map((m) => <button key={m} type="button" className={cls(w.query.months === m && 'is-on')} onClick={() => onMonths(m)}>{m} mo</button>)}</div>
        <span className="bmx-sub">Fit</span>
        <div className="bmx-seg">{(['strong', 'moderate', 'exploratory'] as const).map((t) => <button key={t} type="button" className={cls(filters.tiers.has(t) && 'is-on')} onClick={() => toggleTier(t)}>{TIER_LABEL[t]} · {w.counts[t]}</button>)}</div>
        <span className="bmx-sub">Buyer</span>
        <div className="bmx-seg">{([['all', 'All'], ['company', 'Companies'], ['person', 'Individuals']] as const).map(([k, l]) => <button key={k} type="button" className={cls(filters.kind === k && 'is-on')} onClick={() => setFilters({ ...filters, kind: k })}>{l}</button>)}</div>
        <span className="bmx-sub">Evidence</span>
        <div className="bmx-seg">
          <button type="button" className={cls(filters.registryOnly && 'is-on')} onClick={() => setFilters({ ...filters, registryOnly: !filters.registryOnly })}>Registry resolved</button>
          <button type="button" className={cls(filters.active90 && 'is-on')} onClick={() => setFilters({ ...filters, active90: !filters.active90 })}>Bought in 90 days</button>
          <button type="button" className={cls(filters.priceInside && 'is-on')} onClick={() => setFilters({ ...filters, priceInside: !filters.priceInside })}>Price inside window</button>
        </div>
        <button type="button" className="bmx-btn is-primary" onClick={onClose}>Show buyers</button>
      </div>
    </div>,
    document.body,
  )
}

export { daysSince }
