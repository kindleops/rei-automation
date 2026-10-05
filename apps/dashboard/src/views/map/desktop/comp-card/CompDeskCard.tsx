/**
 * SOLD COMP CARD — DESKTOP. A docked glass card for one recorded sale.
 *
 *   hero        Street View through resolveMapsImage (own key first, at the
 *               click point before hydration lands; stored vendor link last),
 *               gated by the metadata probe; satellite when no panorama
 *   ledger      sale price (or per door) · sale date + age · PPSF · per unit
 *   corpus      "Valuation comp · engine pool" vs "Market sale · display only"
 *   vs subject  distance · Δ price · Δ PPSF against the selected property's
 *               ESTIMATED value (labelled — a sale and an estimate never merge)
 *   property    beds · baths · sq ft · lot · built · units · type · stories
 *   buyer       company name or "Individual buyer" (name withheld)
 *   money       cash / financed · financing · arm's length · document · basis
 *   provenance  corpus · price source · observations · recorded · APN · dataset
 *   actions     Comps beside · Property beside · Look Around · Center ·
 *               Show the portfolio — navigation and map focus only, no writes
 *
 * Hydration: one keyed get_map_sold_comp read per click (comp-detail-store);
 * a newer click aborts the older read. Missing values read "—", never 0.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type maplibregl from 'maplibre-gl'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCIconButton, LCSkeleton, LCTooltip, cx } from '../../../../shared/lc'
import { resolveMapsImage } from '../../../../domain/inbox/inbox-normalization'
import { InteractiveStreetViewPanorama } from '../../../../modules/deal-intelligence/InteractiveStreetViewPanorama'
import { openObjectBeside } from '../../../../modules/desktop/objects/object-actions'
import { propertyObject } from '../../../../modules/desktop/objects/object-registry'
import { useStreetViewAvailability } from '../../seller-card/use-street-view-availability'
import { mapOverlayTarget } from '../../map-overlay-host'
import { showPortfolio } from '../../mobile/comp-portfolio-layer'
import { openCompsBeside } from './comp-card-actions'
import { DASH, buildCompCardModel, type CompCardModel, type CompRecord, type CompSubject, type Fact } from './comp-card-model'
import { useCompDetail, type CompDetailStore } from './comp-detail-store'
import { BuyerOfRecord } from '../../../../modules/market-intelligence/sale-owner/BuyerOfRecord'
import { useSaleOwners } from '../../../../modules/market-intelligence/sale-owner/sale-owner-client'
import './comp-card.css'

function Facts({ items, className }: { items: Fact[]; className?: string }) {
  return (
    <dl className={cx('mcc-facts', className)}>
      {items.map((f) => {
        const cell = (
          <div key={f.label} className={cx('mcc-fact', f.value === DASH && 'is-missing', f.tone && `is-${f.tone}`)}>
            <dt>{f.label}</dt>
            <dd className="lc-num">{f.value}</dd>
          </div>
        )
        return f.hint ? <LCTooltip key={f.label} content={f.hint}>{cell}</LCTooltip> : cell
      })}
    </dl>
  )
}

function Hero({ m, lat, lng, address, stored, onLook }: { m: CompCardModel | null; lat: number | null; lng: number | null; address: string | null; stored: string | null; onLook: (() => void) | null }) {
  const street = resolveMapsImage({ kind: 'street', stored, address, lat, lng })
  const gate = useStreetViewAvailability(street)
  const noPano = gate === 'unavailable' || gate === 'error'
  // one fallback image, only after the panorama probe says there is none
  const aerial = noPano ? resolveMapsImage({ kind: 'satellite', address, lat, lng }) : null
  const [aerialFailed, setAerialFailed] = useState(false)
  const src = !noPano ? street : aerialFailed ? null : aerial
  return (
    <div className={cx('mcc-hero', gate === 'loading' && 'is-loading')}>
      {src ? <img src={src} alt="" loading="lazy" decoding="async" onError={noPano ? () => setAerialFailed(true) : undefined} /> : (
        <div className="mcc-hero__none" aria-hidden="true"><Icon name="home" size={22} /><span>No street imagery here</span></div>
      )}
      <div className="mcc-hero__scrim" aria-hidden="true" />
      <div className="mcc-hero__chips">
        {m ? <span className="mcc-chip">{m.sourceLabel}</span> : null}
        {noPano && src ? <span className="mcc-chip is-quiet">Satellite</span> : null}
      </div>
      {onLook && !noPano ? (
        <button type="button" className="mcc-hero__look" onClick={onLook} data-comp-look>
          <Icon name="globe" size={13} /> Look Around
        </button>
      ) : null}
    </div>
  )
}

export function CompDeskCard({ map, compId, clickLngLat, subject, store, onClose, reducedMotion, now }: {
  map: maplibregl.Map | null
  compId: string
  /** the clicked pin's position — imagery starts before hydration lands */
  clickLngLat: [number, number] | null
  subject: CompSubject | null
  store: CompDetailStore
  onClose: () => void
  reducedMotion: boolean
  now: number
}) {
  const entry = useCompDetail(store, compId)
  const rec: CompRecord | null = entry.status === 'ready' ? entry.data : null
  // One keyed, cached sale_owner request per card (shared batcher), not per field.
  const ownerOf = useSaleOwners(compId ? [compId] : [])
  const owner = ownerOf(compId)
  const m = useMemo(() => (rec ? buildCompCardModel(rec, subject, now, owner) : null), [rec, subject, now, owner])
  const [look, setLook] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // the portfolio's gold dots leave with the card
  useEffect(() => () => { if (map) showPortfolio(map, null) }, [map, compId])

  const lat = m?.lat ?? clickLngLat?.[1] ?? null
  const lng = m?.lng ?? clickLngLat?.[0] ?? null
  const compsTarget = subject?.propertyId || m?.propertyId || null

  const center = () => {
    if (!map || lat === null || lng === null) return
    map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15), duration: reducedMotion ? 0 : 600 })
  }
  const revealPortfolio = () => {
    if (!map || !rec?.portfolio?.length) return
    showPortfolio(map, rec)
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const p of rec.portfolio) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat) }
    if (Number.isFinite(w)) map.fitBounds([[w, s], [e, n]], { padding: { top: 80, bottom: 80, left: 80, right: 460 }, maxZoom: 16, duration: reducedMotion ? 0 : 900 })
  }
  const compsBeside = () => {
    if (!compsTarget) return
    const r = openCompsBeside(compsTarget)
    setNote(r === 'refused' ? 'No room beside the Map — close a pane first.' : null)
  }
  const propertyBeside = () => {
    if (!m?.propertyId) return
    const r = openObjectBeside(propertyObject({ propertyId: m.propertyId, label: m.address, lat: m.lat, lng: m.lng, source: 'map' }))
    setNote(r.ok ? null : r.reason ?? 'This property could not open beside.')
  }

  const loading = entry.status === 'loading' || entry.status === 'idle'
  const failed = entry.status === 'error'
  const sibs = rec?.portfolio ?? []

  return createPortal(
    <section
      className={cx('mx-comp', 'mcc-card', m?.institutional && 'is-institutional', m?.corpus === 'engine_pool' && 'is-pool')}
      role="dialog"
      aria-label={m ? `Sold comp — ${m.address}` : 'Sold comp'}
      data-map-card="comp"
      data-comp-id={compId}
      data-comp-corpus={m?.corpus ?? undefined}
    >
      <Hero m={m} lat={lat} lng={lng} address={rec?.address ?? null} stored={rec?.streetview_image ?? null} onLook={lat !== null && lng !== null ? () => setLook(true) : null} />
      <LCIconButton className="mcc-close" icon="close" label="Close comp" size="sm" onClick={onClose} data-map-sheet-close />

      <header className="mcc-head">
        <div className="mcc-head__corpus">
          {m?.corpusTitle ? (
            <LCTooltip content={m.corpusNote ?? ''}>
              <span className={cx('mcc-corpus', m.corpus === 'engine_pool' ? 'is-pool' : 'is-market')} data-corpus-label>{m.corpusTitle}</span>
            </LCTooltip>
          ) : loading ? <i className="lc-skel" style={{ width: 150, height: 12 }} /> : null}
        </div>
        <h3 className="mcc-head__addr">{m ? m.address : loading ? 'Reading the sale…' : 'Sale unavailable'}</h3>
        {m?.locality ? <p className="mcc-head__loc">{m.locality}</p> : null}
      </header>

      {failed ? (
        <div className="mcc-body"><p className="mcc-empty">This sale could not be read just now. Close and click the pin again to retry.</p></div>
      ) : !m ? (
        <div className="mcc-body"><LCSkeleton shape="metric" /><LCSkeleton shape="lines" count={4} /></div>
      ) : (
        <div className="mcc-body">
          <div className="mcc-ledger">
            <div className="mcc-ledger__price">
              <strong className="lc-num" data-comp-price>{m.headline}</strong>
              <span>{m.headlineBasis}{m.portfolioTotal ? ` · ${m.portfolioTotal} for ${m.portfolioSize} parcels` : ''}</span>
            </div>
            <div className="mcc-ledger__when">
              <strong className="lc-num">{m.saleDate}</strong>
              <span className="lc-num">{m.age === DASH ? 'sale date' : m.age}</span>
            </div>
          </div>
          <div className="mcc-kpis">
            <div className={cx('mcc-kpi', m.ppsf === DASH && 'is-missing')}><span>Per sq ft</span><strong className="lc-num" data-comp-ppsf>{m.ppsf}</strong></div>
            <LCTooltip content={m.ppuHint ?? 'Price ÷ the recorded unit count'} disabled={!m.ppuHint}>
              <div className={cx('mcc-kpi', m.ppu === DASH && 'is-missing')}><span>Per unit</span><strong className="lc-num" data-comp-ppu>{m.ppu}</strong></div>
            </LCTooltip>
            <div className={cx('mcc-kpi', m.estimatedValue === DASH && 'is-missing')}><span>Est. value today</span><strong className="lc-num">{m.estimatedValue}</strong></div>
          </div>

          {m.subject ? (
            <section className="mcc-sec mcc-vs" aria-label="Against the selected property">
              <h4>Against <em>{m.subject.label}</em></h4>
              <div className="mcc-vs__row">
                {m.subject.deltas.map((d) => (
                  <LCTooltip key={d.label} content={d.basis}>
                    <div className={cx('mcc-vs__cell', d.direction && `is-${d.direction}`, d.value === DASH && 'is-missing')}>
                      <span>{d.label}</span>
                      <strong className="lc-num">{d.value}</strong>
                    </div>
                  </LCTooltip>
                ))}
              </div>
            </section>
          ) : null}

          <section className="mcc-sec">
            <h4>Property</h4>
            <Facts items={m.specs} className="is-4" />
          </section>

          <section className="mcc-sec mcc-buyer">
            <h4>Buyer</h4>
            <div className="mcc-buyer__row">
              <span className={cx('mcc-buyer__mark', m.buyer.withheld && 'is-person')} aria-hidden="true"><Icon name={m.buyer.withheld ? 'user' : 'briefcase'} size={14} /></span>
              <div className="mcc-buyer__copy">
                <strong>{m.buyer.owner ? <BuyerOfRecord row={m.buyer.owner} /> : m.buyer.name}</strong>
                <span>{[m.buyer.kind, m.buyer.withheld ? 'name withheld' : null, m.buyer.investor ? 'investor purchase' : null].filter(Boolean).join(' · ')}</span>
                {m.buyer.record ? <span className="lc-num">{m.buyer.record}</span> : null}
              </div>
            </div>
            {m.buyer.entityNote ? <p className="mcc-note">{m.buyer.entityNote}</p> : null}
          </section>

          <section className="mcc-sec">
            <h4>Cash &amp; financing</h4>
            <Facts items={m.money} className="is-2" />
          </section>

          {m.portfolioSize >= 2 ? (
            <section className="mcc-sec mcc-portfolio">
              <h4>Portfolio sale · {m.portfolioSize} parcels, one price</h4>
              {sibs.length ? (
                <ul>{(showAll ? sibs : sibs.slice(0, 4)).map((p) => <li key={p.comp_id}>{p.address ?? DASH}</li>)}</ul>
              ) : null}
              <div className="mcc-portfolio__acts">
                {sibs.length ? <LCButton size="sm" variant="quiet" icon="map" onClick={revealPortfolio}>Show all on the map</LCButton> : null}
                {sibs.length > 4 && !showAll ? <LCButton size="sm" variant="ghost" onClick={() => setShowAll(true)}>+{sibs.length - 4} more</LCButton> : null}
              </div>
            </section>
          ) : null}

          <section className="mcc-sec">
            <h4>Source &amp; freshness</h4>
            <Facts items={m.provenance} className="is-2" />
          </section>
        </div>
      )}

      <footer className="mcc-actions">
        {note ? <p className="mcc-actions__note" role="status">{note}</p> : null}
        <div className="mcc-actions__row">
          <LCButton size="sm" variant="primary" icon="layout-split" disabled={!compsTarget} onClick={compsBeside} data-comp-action="comps-beside">
            {subject?.propertyId ? 'Comps for subject' : 'Comp Intelligence'}
          </LCButton>
          <LCButton size="sm" variant="secondary" icon="home" disabled={!m?.propertyId} onClick={propertyBeside} data-comp-action="property-beside">Property</LCButton>
          <LCButton size="sm" variant="secondary" icon="globe" disabled={lat === null || lng === null} onClick={() => setLook(true)} data-comp-action="street-view">Street View</LCButton>
          <LCIconButton size="sm" icon="target" label="Center on this sale" disabled={lat === null || lng === null} onClick={center} />
        </div>
      </footer>

      {look && lat !== null && lng !== null ? createPortal(
        <div className="smc-look" role="dialog" aria-label={`Look Around — ${m?.address ?? 'sold property'}`}>
          <InteractiveStreetViewPanorama address={rec?.address ?? ''} lat={lat} lng={lng} visible onFailure={() => setLook(false)} />
          <div className="smc-look__bar">
            <span className="smc-look__addr">{m?.address ?? ''}</span>
            <button type="button" className="smc-look__done" onClick={() => setLook(false)}>Done</button>
          </div>
        </div>,
        mapOverlayTarget(),
      ) : null}
    </section>,
    mapOverlayTarget(),
  )
}
