/**
 * Sold comp card — the property card's shape, in red liquid glass.
 *
 *   hero      Street View of the sold property (stored image), gradient-scrimmed
 *   chips     sale source (MLS / public record / investor) · buyer class
 *   price     the sale, or for a portfolio sale the PER-DOOR price with the
 *             portfolio total beside it (the recorded price is the whole deal)
 *   buyer     who bought, what kind of buyer, their purchase record
 *   portfolio "Bought with 50 others" → every property of the deal on the map
 * Plus the comp filters sheet.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type maplibregl from 'maplibre-gl'
import { Icon } from '../../../shared/icons'
import { useStreetViewAvailability } from '../seller-card/use-street-view-availability'
import { InteractiveStreetViewPanorama } from '../../../modules/deal-intelligence/InteractiveStreetViewPanorama'
import {
  BUYER_CLASS_LABEL,
  COMP_SOURCE_LABEL,
  DEFAULT_COMP_FILTERS,
  loadCompDetail,
  type BuyerClass,
  type CompDetail,
  type CompFilters,
  type CompSource,
} from './useSoldComps'
import { mapOverlayTarget } from '../map-overlay-host'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const usd = (v?: number | null) => (v == null || !Number.isFinite(v) || v <= 0 ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M` : `$${Math.round(v / 1000)}K`)
const dateLabel = (d?: string | null) => {
  if (!d) return '—'
  const t = new Date(`${d}T12:00:00Z`)
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '')

const PORTFOLIO_SRC = 'nx-comps-portfolio'
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

/** The stored image when the record has one, else Street View at the sale's own coordinates. */
export function compStreetViewUrl(comp: Pick<CompDetail, 'streetview_image' | 'lat' | 'lng' | 'address'> | null): string | null {
  if (!comp) return null
  if (comp.streetview_image) return comp.streetview_image
  if (!MAPS_KEY) return null
  const hasCoords = Number.isFinite(comp.lat) && Number.isFinite(comp.lng) && Math.abs(comp.lat) > 0.0001
  const location = hasCoords ? `${comp.lat},${comp.lng}` : (comp.address ?? '').trim()
  if (!location) return null
  const params = new URLSearchParams({ size: '640x400', location, fov: '80', pitch: '4', source: 'outdoor', key: MAPS_KEY })
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`
}

const pctText = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : null)
const moneyText = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? usd(Math.abs(v)).replace('$', v < 0 ? '−$' : '$') : null)
const text = (v: unknown) => (v == null || v === '' ? null : String(v))

/** Label/value rows for a section, only the ones the record actually has. */
function rows(pairs: Array<[string, string | null]>): Array<[string, string]> {
  return pairs.filter((p): p is [string, string] => Boolean(p[1]))
}

function showPortfolio(map: maplibregl.Map, comp: CompDetail | null) {
  try {
    if (!map.getSource(PORTFOLIO_SRC)) {
      map.addSource(PORTFOLIO_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: `${PORTFOLIO_SRC}-glow`, type: 'circle', source: PORTFOLIO_SRC, paint: { 'circle-radius': 16, 'circle-color': '#f5c542', 'circle-blur': 1, 'circle-opacity': 0.4 } })
      map.addLayer({ id: `${PORTFOLIO_SRC}-dot`, type: 'circle', source: PORTFOLIO_SRC, paint: { 'circle-radius': 5.5, 'circle-color': '#f5c542', 'circle-stroke-color': '#2a1400', 'circle-stroke-width': 1.5 } })
    }
    const src = map.getSource(PORTFOLIO_SRC) as maplibregl.GeoJSONSource
    const pts = comp?.portfolio ?? []
    src.setData({
      type: 'FeatureCollection',
      features: pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} })),
    })
  } catch { /* style mid-swap */ }
}

export function MapCompCard({ map, compId, onClose, reducedMotion }: { map: maplibregl.Map | null; compId: string; onClose: () => void; reducedMotion: boolean }) {
  const [comp, setComp] = useState<CompDetail | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [showAll, setShowAll] = useState(false)
  const [lookAround, setLookAround] = useState(false)

  useEffect(() => {
    let alive = true
    setState('loading')
    setComp(null)
    setShowAll(false)
    void loadCompDetail(compId).then((c) => {
      if (!alive) return
      setComp(c)
      setState(c ? 'ready' : 'error')
    })
    return () => { alive = false }
  }, [compId])

  useEffect(() => () => { if (map) showPortfolio(map, null) }, [map, compId])

  const heroUrl = compStreetViewUrl(comp)
  const hero = useStreetViewAvailability(heroUrl)
  const isPortfolio = (comp?.portfolio_size ?? 1) >= 2
  const instit = comp?.buyer_class === 'institutional' || comp?.buyer_class === 'hedge_fund'

  const revealPortfolio = () => {
    if (!map || !comp?.portfolio?.length) return
    showPortfolio(map, comp)
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    for (const p of comp.portfolio) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat) }
    if (Number.isFinite(w)) map.fitBounds([[w, s], [e, n]], { padding: { top: 140, bottom: 420, left: 40, right: 72 }, maxZoom: 16, duration: reducedMotion ? 0 : 1000 })
  }

  return createPortal(
    <div className={cls('mx-comp', instit && 'is-institutional', isPortfolio && 'is-portfolio')} role="dialog" aria-label="Sold comp" data-map-card="comp">
      <div className="mx-comp__hero">
        {heroUrl && hero !== 'unavailable' && hero !== 'error'
          ? <img src={heroUrl} alt="" loading="lazy" className={cls(hero === 'loading' && 'is-loading')} />
          : <div className="mx-comp__hero-fallback" aria-hidden="true"><Icon name="home" size={26} /><span>No street imagery here</span></div>}
        <div className="mx-comp__scrim" />
        <div className="mx-comp__chips">
          <span className={cls('mx-comp__chip', `src-${comp?.source ?? 'mls'}`)}>{comp ? COMP_SOURCE_LABEL[comp.source] : 'Sold'}</span>
          {comp && comp.buyer_class !== 'unknown' && <span className={cls('mx-comp__chip', 'buyer', instit && 'is-gold')}>{BUYER_CLASS_LABEL[comp.buyer_class]}</span>}
        </div>
        <button type="button" className="mx-comp__close" aria-label="Close comp" onClick={onClose} data-map-sheet-close><Icon name="close" size={14} /></button>
        {comp && Number.isFinite(comp.lat) && (
          <button type="button" className="mx-comp__look" onClick={() => setLookAround(true)} data-comp-look>
            <Icon name="globe" size={14} /> Look Around
          </button>
        )}
        <div className="mx-comp__title">
          <strong>{comp?.address ? titleCase(comp.address) : state === 'loading' ? 'Loading sale…' : 'Sale unavailable'}</strong>
          <span>{comp ? [comp.property_type, dateLabel(comp.sold_on)].filter(Boolean).join(' · ') : ''}</span>
        </div>
      </div>

      {comp && (
        <div className="mx-comp__body">
          <div className="mx-comp__price">
            <div>
              <strong>{usd(isPortfolio ? comp.per_door : comp.price)}</strong>
              <span>{isPortfolio ? `per door · ${usd(comp.price)} for ${comp.portfolio_size} properties` : comp.ppsf ? `$${Math.round(comp.ppsf)}/sq ft` : 'sale price'}</span>
            </div>
            {comp.estimated_value ? (
              <div className="mx-comp__vs">
                <strong>{usd(comp.estimated_value)}</strong>
                <span>est. value today</span>
              </div>
            ) : null}
          </div>

          <div className="mx-comp__facts">
            {[
              comp.beds ? `${comp.beds} bd` : null,
              comp.baths ? `${comp.baths} ba` : null,
              comp.sqft ? `${Math.round(comp.sqft).toLocaleString()} sq ft` : null,
              comp.year_built ? `Built ${comp.year_built}` : null,
              comp.units && comp.units > 1 ? `${comp.units} units` : null,
            ].filter(Boolean).map((f) => <span key={f as string}>{f}</span>)}
          </div>

          <div className={cls('mx-comp__buyer', instit && 'is-gold')}>
            <span className="mx-comp__buyer-label">Buyer</span>
            <strong>{comp.buyer ? titleCase(comp.buyer) : 'Not on public record'}</strong>
            <span>
              {[
                comp.buyer_class !== 'unknown' ? BUYER_CLASS_LABEL[comp.buyer_class] : null,
                comp.buyer_stats && comp.buyer_stats.purchases > 1 ? `${comp.buyer_stats.purchases} purchases${comp.buyer_stats.markets > 1 ? ` in ${comp.buyer_stats.markets} states` : ''}` : null,
                comp.buyer_stats?.median_price && comp.buyer_stats.purchases > 1 ? `median ${usd(comp.buyer_stats.median_price)}` : null,
                comp.out_of_state_owner ? 'Out-of-state' : null,
              ].filter(Boolean).join(' · ')}
            </span>
          </div>

          {comp.details && (() => {
            const d = comp.details
            const deal = isPortfolio ? [] : rows([
              ['ARV estimate', moneyText(d.arv_estimate)],
              ['Below value', typeof d.percent_off === 'number' && d.percent_off > 0 ? `${Math.round(d.percent_off)}% · ${moneyText(d.price_off_value) ?? ''}` : null],
              ['Potential spread', typeof d.potential_spread === 'number' && d.potential_spread > 0 ? moneyText(d.potential_spread) : null],
              ['Est. repairs', moneyText(d.estimated_repair_cost)],
              ['Renovation', text(d.renovation_level)],
              ['Deal grade', text(d.deal_grade)],
              ['Equity at sale', typeof d.equity_percent === 'number' && d.equity_percent > -100 ? `${pctText(d.equity_percent)} · ${moneyText(d.equity_amount) ?? ''}` : null],
            ])
            const sale = rows([
              ['Recorded', d.recording_date ? dateLabel(String(d.recording_date)) : null],
              ['Public record', d.sale_price ? `${usd(Number(d.sale_price))} · ${dateLabel(text(d.sale_date))}` : null],
              ['MLS sold', d.mls_sold_price ? `${usd(Number(d.mls_sold_price))} · ${dateLabel(text(d.mls_sold_date))}` : null],
              ['MLS status', text(d.mls_status)],
              ['Listed at', moneyText(d.mls_list_price)],
              ['Assessed', moneyText(d.assessed_total_value)],
              ['APN', text(d.apn)],
            ])
            const building = rows([
              ['Lot', d.lot_square_feet ? `${Math.round(Number(d.lot_square_feet)).toLocaleString()} sq ft` : d.lot_acreage ? `${d.lot_acreage} ac` : null],
              ['Stories', text(d.stories)],
              ['Condition', text(d.building_condition)],
              ['Quality', text(d.building_quality)],
              ['Construction', text(d.construction_type)],
              ['Exterior', text(d.exterior_walls)],
              ['Roof', text(d.roof)],
              ['Garage', text(d.garage)],
              ['Pool', text(d.pool)],
              ['Basement', text(d.basement)],
              ['Cooling', text(d.air_conditioning)],
              ['Heating', text(d.heating)],
              ['Style', text(d.style)],
              ['Effective built', text(d.effective_year_built)],
            ])
            const place = rows([
              ['County', text(d.county)],
              ['Subdivision', text(d.subdivision)],
              ['Schools', text(d.school_district)],
              ['Zoning', text(d.zoning)],
              ['Flood zone', text(d.flood_zone)],
              ['Class', text(d.property_class)],
            ])
            const buyerMore = rows([
              ['Buyer mailing', text(d.owner_mailing)],
              ['Buy box', text(d.buyer_buy_box)],
              ['Activity', text(d.buyer_activity)],
              ['Entity', text(d.buyer_entity_strength)],
            ])
            const Section = ({ title, items, tone }: { title: string; items: Array<[string, string]>; tone?: string }) => items.length ? (
              <section className={cls('mx-comp__section', tone)}>
                <h4>{title}</h4>
                <dl>{items.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}</dl>
              </section>
            ) : null
            return (
              <>
                <Section title="Deal math" items={deal} tone="is-deal" />
                <Section title="The sale" items={sale} />
                <Section title="Building" items={building} />
                <Section title="Location" items={place} />
                <Section title="Buyer profile" items={buyerMore} />
                {text(d.flags) && <div className="mx-comp__flags">{String(d.flags).split(/;\s*/).filter(Boolean).map((f) => <span key={f}>{f}</span>)}</div>}
              </>
            )
          })()}

          {isPortfolio && (
            <div className="mx-comp__portfolio">
              <div className="mx-comp__portfolio-head">
                <strong>{instit ? 'Institutional portfolio buy' : 'Portfolio sale'}</strong>
                <span>{comp.portfolio_size} properties recorded together on {dateLabel(comp.sold_on)} at one price</span>
              </div>
              <button type="button" className="mx-act is-gold" onClick={revealPortfolio}>Show all {comp.portfolio_size} on the map</button>
              {comp.portfolio && (
                <ul className="mx-comp__siblings">
                  {(showAll ? comp.portfolio : comp.portfolio.slice(0, 4)).map((p) => <li key={p.comp_id}>{titleCase(p.address)}</li>)}
                </ul>
              )}
              {comp.portfolio && comp.portfolio.length > 4 && !showAll && (
                <button type="button" className="mx-link" onClick={() => setShowAll(true)}>+{comp.portfolio.length - 4} more</button>
              )}
            </div>
          )}
        </div>
      )}
      {lookAround && comp && createPortal(
        <div className="smc-look" role="dialog" aria-label={`Look Around — ${comp.address ?? 'sold property'}`}>
          <InteractiveStreetViewPanorama address={comp.address ?? ''} lat={comp.lat} lng={comp.lng} visible onFailure={() => setLookAround(false)} />
          <div className="smc-look__bar">
            <span className="smc-look__addr">{titleCase(comp.address)}</span>
            <button type="button" className="smc-look__done" onClick={() => setLookAround(false)}>Done</button>
          </div>
        </div>,
        mapOverlayTarget(),
      )}
    </div>,
    mapOverlayTarget(),
  )
}

// ── Filters ──────────────────────────────────────────────────────────────────

const SOURCES: CompSource[] = ['mls', 'public_record', 'investor']
const CLASSES: BuyerClass[] = ['institutional', 'portfolio', 'builder', 'llc_investor', 'individual', 'trust', 'bank', 'government']
const TYPES = ['Single Family', 'Multi-Family', 'Condominium', 'Townhouse', 'Apartment', 'Vacant Land', 'Mobile Home']
const PRICES = [0, 50_000, 100_000, 150_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000, 2_000_000]

function Chips<T extends string>({ values, selected, label, onChange }: { values: readonly T[]; selected: T[]; label: (v: T) => string; onChange: (v: T[]) => void }) {
  return (
    <div className="mx-fchips">
      {values.map((v) => {
        const on = selected.includes(v)
        return (
          <button key={v} type="button" className={cls('mx-fchip', on && 'is-on')} aria-pressed={on} onClick={() => onChange(on ? selected.filter((s) => s !== v) : [...selected, v])}>
            {label(v)}
          </button>
        )
      })}
    </div>
  )
}

export function CompFiltersPanel({ filters, onChange, total, institutional }: { filters: CompFilters; onChange: (f: CompFilters) => void; total: number; institutional: number }) {
  const set = <K extends keyof CompFilters>(k: K, v: CompFilters[K]) => onChange({ ...filters, [k]: v })
  return (
    <div className="mx-compf">
      <p className="mx-note">{total.toLocaleString()} sales in view{institutional ? ` · ${institutional.toLocaleString()} institutional` : ''}</p>
      <section className="mx-block"><h3>Source</h3>
        <Chips values={SOURCES} selected={filters.sources} label={(v) => COMP_SOURCE_LABEL[v]} onChange={(v) => set('sources', v)} />
      </section>
      <section className="mx-block"><h3>Buyer</h3>
        <Chips values={CLASSES} selected={filters.classes} label={(v) => (v === 'institutional' ? 'Institutional / hedge fund' : BUYER_CLASS_LABEL[v])} onChange={(v) => set('classes', v)} />
        <button type="button" className={cls('mx-fchip', 'is-wide', filters.portfolioOnly && 'is-on')} aria-pressed={filters.portfolioOnly} onClick={() => set('portfolioOnly', !filters.portfolioOnly)}>
          Portfolio sales only (multiple properties, one price)
        </button>
      </section>
      <section className="mx-block"><h3>Sold within</h3>
        <div className="mx-fchips">
          {(['6m', '12m', '24m', 'all'] as const).map((w) => (
            <button key={w} type="button" className={cls('mx-fchip', filters.window === w && 'is-on')} aria-pressed={filters.window === w} onClick={() => set('window', w)}>
              {w === 'all' ? 'Any time' : `${parseInt(w, 10)} months`}
            </button>
          ))}
        </div>
      </section>
      <section className="mx-block"><h3>Price (per door)</h3>
        <div className="mx-frange">
          <select value={filters.minPrice ?? 0} onChange={(e) => set('minPrice', Number(e.target.value) || null)} aria-label="Minimum price">
            {PRICES.map((p) => <option key={p} value={p}>{p ? `Min ${usd(p)}` : 'No min'}</option>)}
          </select>
          <span>to</span>
          <select value={filters.maxPrice ?? 0} onChange={(e) => set('maxPrice', Number(e.target.value) || null)} aria-label="Maximum price">
            {PRICES.map((p) => <option key={p} value={p}>{p ? `Max ${usd(p)}` : 'No max'}</option>)}
          </select>
        </div>
      </section>
      <section className="mx-block"><h3>Property type</h3>
        <Chips values={TYPES} selected={filters.types} label={(v) => v} onChange={(v) => set('types', v)} />
      </section>
      <section className="mx-block"><h3>Bedrooms</h3>
        <div className="mx-fchips">
          {[0, 1, 2, 3, 4, 5].map((b) => (
            <button key={b} type="button" className={cls('mx-fchip', (filters.minBeds ?? 0) === b && 'is-on')} onClick={() => set('minBeds', b || null)}>{b ? `${b}+` : 'Any'}</button>
          ))}
        </div>
      </section>
      <button type="button" className="mx-act" onClick={() => onChange(DEFAULT_COMP_FILTERS)}>Reset comp filters</button>
    </div>
  )
}
