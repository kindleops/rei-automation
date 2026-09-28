/**
 * BUYER MATCH — presentational parts. Every number is read from the server's
 * evidence; nothing here scores, tiers or invents a reason.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { BuyerMatchWorkspace, MatchedBuyer, Tier } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { ago, money } from '../../../domain/buyer-match/buyer-match-workspace-api'
import { staticStreetViewUrl } from '../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'

export const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** acquisition_opportunities.acquisition_stage — `closed` is closed-LOST here, never "sold". */
const STAGE_LABEL: Record<string, string> = { ownership_confirmation: 'Ownership check', asking_price: 'Asking price', property_condition: 'Condition', offer_interest: 'Offer interest', offer: 'Offer', contract: 'Under contract', disposition: 'Disposition', closing: 'Closing', closed: 'Closed · lost' }
export const stageLabel = (s: string | null) => (s ? STAGE_LABEL[s] ?? s.replace(/_/g, ' ') : null)

export const TIER_LABEL: Record<Tier, string> = { strong: 'Strong fit', moderate: 'Moderate fit', exploratory: 'Exploratory', excluded: 'Not a fit' }

/** Animated count — glides, instant under reduced motion. */
export function Count({ value, fmt = (n: number) => String(Math.round(n)) }: { value: number | null | undefined; fmt?: (n: number) => string }) {
  const [v, setV] = useState(value ?? 0)
  const from = useRef(0)
  useEffect(() => {
    if (value === null || value === undefined) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(value); from.current = value; return }
    const a = from.current
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 900)
      const e = 1 - (1 - p) ** 4
      setV(a + (value - a) * e)
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  if (value === null || value === undefined) return <>—</>
  return <>{fmt(v)}</>
}

export const buyerTitle = (b: MatchedBuyer) => b.name || (b.kind === 'person' ? 'Private individual' : 'Registered entity')
const initials = (b: MatchedBuyer) => {
  if (!b.name) return b.kind === 'person' ? '◆' : '▲'
  const words = b.name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !/^(llc|l|c|inc|corp|co|the|of|and|lp|ltd)$/i.test(w))
  return (words[0]?.[0] || '') + (words[1]?.[0] || '')
}

/* ── subject ── */

export function SubjectHero({ w, onDeal, onComps, onGraph, onMap, onPipeline }: { w: BuyerMatchWorkspace; onDeal: () => void; onComps: () => void; onGraph: () => void; onMap: () => void; onPipeline: (() => void) | null }) {
  const s = w.subject
  const photo = staticStreetViewUrl(s.address, s.lat, s.lng)
  const [ok, setOk] = useState<boolean | null>(null)
  const [street, ...rest] = (s.address ?? '').split(',')
  const specs = [s.familyLabel, s.units && s.units > 1 ? `${s.units} units` : null, s.beds ? `${s.beds} bd` : null, s.baths ? `${s.baths} ba` : null, s.sqft ? `${s.sqft.toLocaleString('en-US')} sf` : null, s.yearBuilt ? `Built ${s.yearBuilt}` : null].filter(Boolean) as string[]
  return (
    <header className="bmx-subject">
      <div className={cls('bmx-subject__photo', ok === true && 'is-ready')} aria-hidden="true">
        <div className="bmx-subject__mesh" />
        {photo && ok !== false ? <img src={photo} alt="" onLoad={() => setOk(true)} onError={() => setOk(false)} /> : null}
        <div className="bmx-subject__scrim" />
        <div className="bmx-subject__sweep" />
      </div>
      <div className="bmx-subject__body">
        <div className="bmx-subject__top">
          <span className="bmx-eyebrow"><i />Disposition subject</span>
          {s.stage ? <span className={cls('bmx-stage', s.stage === 'closed' && 'is-lost')}>{stageLabel(s.stage)}</span> : null}
        </div>
        <h2>{street || 'Subject property'}</h2>
        <p>{[rest.join(',').trim(), s.county ? `${s.county} County` : null].filter(Boolean).join(' · ')}</p>
        <div className="bmx-subject__specs">{specs.map((x) => <span key={x}>{x}</span>)}</div>
        <div className="bmx-subject__values">
          {s.value ? <div className="is-lead"><span>{s.valueBasis === 'deal_intelligence' ? 'Deal value' : 'AVM'}</span><b>{money(s.value)}</b></div> : null}
          {s.offer ? <div><span>Offer</span><b>{money(s.offer)}</b></div> : null}
          {s.ask ? <div><span>Seller ask</span><b>{money(s.ask)}</b></div> : null}
          {s.window ? <div><span>Dispo window</span><b>{money(s.window.low)}–{money(s.window.high)}</b></div> : null}
        </div>
        <div className="bmx-subject__actions">
          <button type="button" onClick={onDeal}><Icon name="target" />Deal</button>
          <button type="button" onClick={onComps}><Icon name="layers" />Comps</button>
          <button type="button" onClick={onGraph}><Icon name="radar" />Graph</button>
          <button type="button" onClick={onMap}><Icon name="map" />Map</button>
          {onPipeline ? <button type="button" onClick={onPipeline}><Icon name="list" />Pipeline</button> : null}
        </div>
      </div>
    </header>
  )
}

/* ── match hero: count, tier flow, orbit ── */

export function MatchHero({ w, onFocus, focusId }: { w: BuyerMatchWorkspace; onFocus: (id: string) => void; focusId: string | null }) {
  const c = w.counts
  const total = Math.max(1, c.strong + c.moderate + c.exploratory)
  return (
    <section className="bmx-hero">
      <div className="bmx-hero__glow" aria-hidden="true" />
      <div className="bmx-hero__head">
        <span className="bmx-eyebrow is-aqua"><i />Buyer match</span>
        <span className="bmx-hero__window">{w.query.radiusMiles} mi · {w.query.months} mo</span>
      </div>
      <div className="bmx-hero__count">
        <strong><Count value={c.matched} /></strong>
        <span>buyers with observed<br />acquisitions that fit</span>
      </div>
      <div className="bmx-flow" role="img" aria-label={`${c.strong} strong, ${c.moderate} moderate, ${c.exploratory} exploratory`}>
        {(['strong', 'moderate', 'exploratory'] as const).map((t, i) => (
          <i key={t} className={`t-${t}`} style={{ '--w': `${Math.max(c[t] ? 6 : 0, (c[t] / total) * 100)}%`, '--d': `${i * 120}ms` } as CSSProperties} />
        ))}
      </div>
      <div className="bmx-tiers">
        {(['strong', 'moderate', 'exploratory'] as const).map((t) => (
          <div key={t} className={`t-${t}`}><b><Count value={c[t]} /></b><span>{TIER_LABEL[t]}</span></div>
        ))}
      </div>
      <Orbit w={w} onFocus={onFocus} focusId={focusId} />
      <p className="bmx-foot">
        Tiers are rules over recorded purchases, not a score. {c.oneTimeIndividuals ? <>{c.oneTimeIndividuals} one-time individual buyers (owner-occupant pattern) aren’t listed. </> : null}
        {c.excluded ? <>{c.excluded} nearby acquirers ruled out — see why below.</> : null}
      </p>
    </section>
  )
}

/**
 * Distance orbit. Radius = distance of the buyer's nearest purchase to the
 * subject (sqrt scale to the search radius); county-only buyers sit on the
 * outer dashed ring. Position AROUND the ring is rank order, not bearing —
 * the legend says so. Dot size = same-type purchases nearby.
 */
function Orbit({ w, onFocus, focusId }: { w: BuyerMatchWorkspace; onFocus: (id: string) => void; focusId: string | null }) {
  const R = w.query.radiusMiles
  const rings = [1, 2, 5, 10, 25].filter((m) => m < R)
  const rad = (miles: number | null) => (miles === null ? 146 : 18 + 112 * Math.sqrt(Math.min(1, Math.max(0, miles) / R)))
  const dots = w.buyers.slice(0, 48).map((b, i) => {
    const r = rad(b.nearby?.nearestMiles ?? null)
    const a = (i * 137.508 * Math.PI) / 180 - Math.PI / 2
    return { b, x: 160 + r * Math.cos(a), y: 160 + r * Math.sin(a), size: 3.2 + Math.min(7, (b.nearby?.sameFamily ?? 0) * 1.1), i }
  })
  return (
    <figure className="bmx-orbit">
      <svg viewBox="0 0 320 320" role="img" aria-label="Matched buyers by distance of nearest purchase">
        <defs>
          <radialGradient id="bmx-core" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#fff6d8" /><stop offset="55%" stopColor="#f4c860" /><stop offset="100%" stopColor="#b7791f" /></radialGradient>
          <radialGradient id="bmx-field" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="var(--bmx-aqua)" stopOpacity="0.22" /><stop offset="70%" stopColor="var(--bmx-aqua)" stopOpacity="0.03" /><stop offset="100%" stopColor="var(--bmx-aqua)" stopOpacity="0" /></radialGradient>
        </defs>
        <circle cx="160" cy="160" r="150" fill="url(#bmx-field)" />
        <circle className="bmx-orbit__county" cx="160" cy="160" r="146" />
        <circle className="bmx-orbit__edge" cx="160" cy="160" r="130" />
        {rings.map((m) => <g key={m}><circle className="bmx-orbit__ring" cx="160" cy="160" r={rad(m)} /><text className="bmx-orbit__lbl" x={160 + rad(m) * 0.72} y={160 - rad(m) * 0.72}>{m} mi</text></g>)}
        <text className="bmx-orbit__lbl" x="160" y="24" textAnchor="middle">{R} mi</text>
        <g className="bmx-orbit__sweep"><path d="M160 160 L160 30 A130 130 0 0 1 252 68 Z" /></g>
        {dots.map(({ b, x, y, size, i }) => (
          <g key={b.id} className={cls('bmx-orbit__dot', `t-${b.tier}`, focusId === b.id && 'is-focus')} style={{ '--x': `${x - 160}px`, '--y': `${y - 160}px`, '--i': i } as CSSProperties} onClick={() => onFocus(b.id)}>
            <circle cx={x} cy={y} r={size + 7} className="hit" />
            <circle cx={x} cy={y} r={size} className="dot" />
          </g>
        ))}
        <circle cx="160" cy="160" r="15" className="bmx-orbit__halo" />
        <circle cx="160" cy="160" r="9" fill="url(#bmx-core)" stroke="#fff" strokeWidth="1.6" />
      </svg>
      <figcaption>
        <span><i className="t-strong" />Strong</span><span><i className="t-moderate" />Moderate</span><span><i className="t-exploratory" />Exploratory</span>
        <em>Ring = distance of nearest purchase · outer dashes = county only · angle = rank</em>
      </figcaption>
    </figure>
  )
}

/* ── market signals ── */

export function MarketSignals({ w }: { w: BuyerMatchWorkspace }) {
  const m = w.market
  const win = w.subject.window
  return (
    <section className="bmx-panel bmx-market">
      <div className="bmx-panel__head"><span>Observed buyer activity</span><em>{w.query.radiusMiles} mi · {w.query.months} mo</em></div>
      <div className="bmx-market__grid">
        <div><b><Count value={m.buyersInRadius} /></b><span>resolved buyers purchased here</span></div>
        <div><b><Count value={m.sameTypeTransactionsInRadius} /></b><span>{w.subject.familyLabel.toLowerCase()} purchases</span></div>
        <div><b><Count value={m.nearbySimilarBuyers} /></b><span>bought same type ≤ 2 mi</span></div>
        <div><b><Count value={m.activeLast90} /></b><span>matched buyers active in 90 days</span></div>
      </div>
      {m.countyBuyersActive24m !== null ? <p className="bmx-note">{m.countyBuyersActive24m.toLocaleString('en-US')} buyers purchased in {w.subject.county ? `${w.subject.county} County` : 'the county'} in the last 24 months.</p> : null}
      {m.matchedPriceBand && win ? (
        <div className="bmx-band">
          <div className="bmx-band__row"><span>Matched buyers typically pay</span><b>{money(m.matchedPriceBand.low)}–{money(m.matchedPriceBand.high)}</b></div>
          <PriceBar bandLow={m.matchedPriceBand.low} bandHigh={m.matchedPriceBand.high} winLow={win.low} winHigh={win.high} />
          <p className="bmx-note">Median of the strong and moderate buyers’ p25–p75 purchase prices ({m.matchedPriceBand.buyers} buyers) against this deal’s {win.basis === 'offer_to_value' ? 'offer → value' : 'value'} window. Observed behaviour, not a disposition guarantee.</p>
        </div>
      ) : null}
    </section>
  )
}

/** Buyer's observed band vs the deal's window on one scale. */
export function PriceBar({ bandLow, bandHigh, winLow, winHigh }: { bandLow: number; bandHigh: number; winLow: number; winHigh: number }) {
  const lo = Math.min(bandLow, winLow) * 0.85
  const hi = Math.max(bandHigh, winHigh) * 1.08
  const at = (v: number) => `${((v - lo) / (hi - lo || 1)) * 100}%`
  return (
    <div className="bmx-pricebar" aria-hidden="true">
      <div className="bmx-pricebar__rail" />
      <div className="bmx-pricebar__band" style={{ left: at(bandLow), width: `calc(${at(bandHigh)} - ${at(bandLow)})` }} />
      <div className="bmx-pricebar__win" style={{ left: at(winLow), width: `calc(${at(winHigh)} - ${at(winLow)})` }}><em>deal</em></div>
    </div>
  )
}

/* ── disposition states ── */

export function StateRail({ w, shortlisted }: { w: BuyerMatchWorkspace; shortlisted: number }) {
  const d = w.disposition
  const steps: Array<[string, number | string, string]> = [
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
    <section className="bmx-panel bmx-rail">
      <div className="bmx-panel__head"><span>Disposition state</span><em>read from outreach, offers &amp; agreements</em></div>
      <ol>
        {steps.map(([k, v, sub], i) => (
          <li key={k} className={cls(Number(v) > 0 && 'is-on')} style={{ '--i': i } as CSSProperties}>
            <b>{v}</b><span>{k}</span><em>{sub}</em>
          </li>
        ))}
      </ol>
      <p className="bmx-note">A match or shortlist never advances a buyer. Commitment, agreement and EMD appear only from their own records.</p>
    </section>
  )
}

/* ── fit ── */

const FIT_TONE = (v: string) => (['inside', 'dominant', 'strong', 'active', 'recent'].includes(v) ? 'good' : ['near', 'present', 'county', 'slowing'].includes(v) ? 'mid' : ['unknown'].includes(v) ? 'unk' : 'bad')
export function FitPills({ b }: { b: MatchedBuyer }) {
  const pills: Array<[string, string]> = [['Type', b.fit.type], ['Price', b.fit.price.verdict], ['Market', b.fit.market], ['Recency', b.fit.recency], ['Size', b.fit.size.verdict]]
  return <div className="bmx-fits">{pills.map(([k, v]) => <span key={k} className={`f-${FIT_TONE(v)}`} title={v}><i />{k}</span>)}</div>
}

/** Subject vs buyer — the signature comparison. */
export function FitTable({ b, w }: { b: MatchedBuyer; w: BuyerMatchWorkspace }) {
  const s = w.subject
  const win = s.window
  const verdict = (v: string) => ({ inside: 'Inside range', near: 'Close', outside: 'Outside', unknown: 'No evidence', dominant: 'Their focus', present: 'In their mix', absent: 'Not their type', strong: 'Strong', county: 'County only', none: 'None', active: 'Active', recent: 'Recent', slowing: 'Slowing', stale: 'Stale' } as Record<string, string>)[v] ?? v
  const rows: Array<{ k: string; subject: ReactNode; buyer: ReactNode; v: string; bar?: ReactNode }> = [
    { k: 'Price', subject: win ? `${money(win.low)}–${money(win.high)}` : money(s.value) ?? '—', buyer: b.buyBox.priceLow && b.buyBox.priceHigh ? `${money(b.buyBox.priceLow)}–${money(b.buyBox.priceHigh)}` : '—', v: b.fit.price.verdict,
      bar: win && b.buyBox.priceLow && b.buyBox.priceHigh ? <PriceBar bandLow={b.buyBox.priceLow} bandHigh={b.buyBox.priceHigh} winLow={win.low} winHigh={win.high} /> : null },
    { k: 'Type', subject: s.familyLabel, buyer: b.buyBox.dominant ?? (b.buyBox.families.join(' · ') || '—'), v: b.fit.type },
    { k: 'Market', subject: s.county ? `${s.county} Co. · ${s.zip ?? ''}` : s.zip ?? '—', buyer: b.nearby ? `${b.nearby.sameFamily} same-type ≤ ${w.query.radiusMiles} mi` : `${b.countyPurchases} in county`, v: b.fit.market },
    { k: 'Size', subject: s.sqft ? `${s.sqft.toLocaleString('en-US')} sf` : '—', buyer: b.buyBox.sqftLow && b.buyBox.sqftHigh ? `${Math.round(b.buyBox.sqftLow).toLocaleString('en-US')}–${Math.round(b.buyBox.sqftHigh).toLocaleString('en-US')} sf` : '—', v: b.fit.size.verdict },
    { k: 'Recency', subject: 'now', buyer: b.activity.daysSince !== null ? `last ${ago(b.activity.daysSince)}` : '—', v: b.fit.recency },
  ]
  return (
    <div className="bmx-fittable">
      <div className="bmx-fittable__head"><span /><span>Subject</span><span>Buyer</span></div>
      {rows.map((r, i) => (
        <div key={r.k} className={`bmx-fitrow f-${FIT_TONE(r.v)}`} style={{ '--i': i } as CSSProperties}>
          <span className="k">{r.k}</span><span className="s">{r.subject}</span><span className="b">{r.buyer}</span>
          <em><i />{verdict(r.v)}</em>
          {r.bar ? <div className="bar">{r.bar}</div> : null}
        </div>
      ))}
    </div>
  )
}

/* ── buyer card ── */

export function BuyerCard({ b, w, rank, focus, shortlisted, comparing, onOpen, onShortlist, onCompare }: {
  b: MatchedBuyer; w: BuyerMatchWorkspace; rank: number; focus: boolean; shortlisted: boolean; comparing: boolean
  onOpen: () => void; onShortlist: () => void; onCompare: () => void
}) {
  const price = money(b.buyBox.priceMid ?? b.buyBox.priceLow) ?? '—'
  return (
    <article className={cls('bmx-card', `t-${b.tier}`, focus && 'is-focus', shortlisted && 'is-short')} data-id={b.id} style={{ '--i': Math.min(rank, 10) } as CSSProperties}>
      <button type="button" className="bmx-card__open" onClick={onOpen} aria-label={`Open ${buyerTitle(b)}`}>
        <div className="bmx-card__top">
          <span className="bmx-mono"><i>{initials(b)}</i></span>
          <div className="bmx-card__id">
            <h3>{buyerTitle(b)}</h3>
            <p>{[b.identity.label, b.kind === 'company' ? 'Company' : 'Individual', b.behavior.archetype].filter(Boolean).join(' · ')}</p>
          </div>
          <span className={cls('bmx-tier', `t-${b.tier}`)}>{TIER_LABEL[b.tier]}</span>
        </div>
        <dl className="bmx-card__metrics">
          <div><dt>Same-type</dt><dd>{b.nearby?.sameFamily ?? 0}</dd><em>≤ {w.query.radiusMiles} mi</em></div>
          <div><dt>12 mo</dt><dd>{b.activity.t365}</dd><em>{b.activity.t90 ? `${b.activity.t90} in 90d` : 'purchases'}</em></div>
          <div><dt>Last buy</dt><dd>{ago(b.activity.daysSince) ?? '—'}</dd><em>{b.nearby?.nearestMiles !== null && b.nearby?.nearestMiles !== undefined ? `${b.nearby.nearestMiles.toFixed(1)} mi away` : `${b.countyPurchases} in county`}</em></div>
          <div><dt>Pays</dt><dd>{price}</dd><em>{b.buyBox.cashShare !== null && b.activity.acquisitions >= 3 ? `${Math.round(b.buyBox.cashShare * 100)}% cash` : b.activity.acquisitions >= 3 ? 'median' : 'observed'}</em></div>
        </dl>
        <FitPills b={b} />
        <ul className="bmx-card__why">{b.evidence.slice(0, 2).map((e) => <li key={e.k}><i />{e.text}{e.sub ? <em> · {e.sub}</em> : null}</li>)}</ul>
      </button>
      <div className="bmx-card__foot">
        <span className={cls('bmx-contact', `c-${b.contact.state}`)}><i />{b.contact.label}</span>
        <div>
          <button type="button" className={cls('bmx-iconbtn', comparing && 'is-on')} onClick={onCompare} aria-pressed={comparing} aria-label="Compare"><Icon name="layout-split" /></button>
          <button type="button" className={cls('bmx-iconbtn', shortlisted && 'is-gold')} onClick={onShortlist} aria-pressed={shortlisted} aria-label="Shortlist"><Icon name="star" /></button>
        </div>
      </div>
    </article>
  )
}

/* ── why not ── */

export function WhyNot({ w, onOpen }: { w: BuyerMatchWorkspace; onOpen: (b: MatchedBuyer) => void }) {
  const counts = Object.entries(w.counts.exclusions).sort((a, b) => b[1] - a[1])
  const label: Record<string, string> = { lender_or_agency: 'Lenders, servicers & agencies', type_mismatch: 'Buy a different asset type', stale: 'Inactive 24+ months', price_outside: 'Price band far from this deal' }
  if (!w.excluded.length && !w.counts.oneTimeIndividuals) return null
  return (
    <section className="bmx-panel bmx-whynot">
      <div className="bmx-panel__head"><span>Why not these acquirers</span><em>{w.counts.excluded} ruled out</em></div>
      <div className="bmx-whynot__reasons">
        {counts.map(([k, n]) => <span key={k}><b>{n}</b>{label[k] ?? k}</span>)}
        {w.counts.oneTimeIndividuals ? <span><b>{w.counts.oneTimeIndividuals}</b>One-time individual buyers</span> : null}
      </div>
      <ul>
        {w.excluded.slice(0, 8).map((b) => (
          <li key={b.id}>
            <button type="button" onClick={() => onOpen(b)}>
              <strong>{buyerTitle(b)}</strong>
              <span>{b.exclusions[0]?.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
