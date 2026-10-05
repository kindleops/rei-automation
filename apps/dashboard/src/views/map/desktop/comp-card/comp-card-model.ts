/**
 * SOLD COMP CARD — the pure model behind the desktop Map's comp hover preview
 * and comp card (no React, no network; everything here is unit-tested).
 *
 * Two inputs, two very different budgets:
 *
 *   HOVER  the vector feature the comp layer already holds (get_map_sold_comps:
 *          comp_id · price · sold_on · source · buyer_class · portfolio_size ·
 *          n · institutional, plus the point geometry). Nothing is fetched on
 *          hover. Specs (beds/baths/sqft/PPSF) are shown only when the feature
 *          carries them, or when this comp was already hydrated by a click.
 *   CLICK  one keyed get_map_sold_comp(comp_id) read: the mv_map_market_sales
 *          row (to_jsonb) + the source record's details + buyer stats.
 *
 * Product truth:
 *   - Missing is "—", never 0. A zero / negative number is missing.
 *   - Price per unit needs a REAL positive unit count from the record. A null
 *     unit count is never read as 1, and a single-family record whose unit
 *     count fails the engine's ≥350 sf/unit credibility rule gets no PPU.
 *   - Corpus, as Comp Intelligence labels it (5068eece): a sale whose cluster
 *     holds an engine-pool observation (v_recent_sold_comps) is a "Valuation
 *     comp · engine pool"; a sale known only from canonical recorded deeds is
 *     a "Market sale · display only" — never scored, never in the valuation.
 *   - Buyer identity follows the Buyer Match rule: company names only; a
 *     person buyer is "Individual buyer", name withheld (the RPC never returns
 *     one). Entity ownership of the parcel today is never an investor purchase.
 *   - Sale price vs the subject's ESTIMATED value is labelled as such; the two
 *     are never collapsed into one "value".
 */

export type CompSourceKey = 'mls' | 'public_record' | 'investor'

/** What a sold-comp vector feature carries (useSoldComps → nx-comps source). */
export interface CompFeatureProps {
  comp_id?: string | null
  n?: number | null
  /** COALESCE(per_door, price): for a portfolio sale this is the per-door figure */
  price?: number | null
  sold_on?: string | null
  source?: string | null
  buyer_class?: string | null
  portfolio_size?: number | null
  institutional?: number | null
  /** optional — present only if the bbox RPC returns them */
  ppsf?: number | null
  beds?: number | null
  baths?: number | null
  sqft?: number | null
  units?: number | null
}

/** The hydrated record: get_map_sold_comp(p_comp_id) → to_jsonb(mv row) + portfolio + buyer_stats + details. */
export interface CompRecord {
  comp_id: string
  source?: string | null
  sold_on?: string | null
  price?: number | null
  per_door?: number | null
  ppsf?: number | null
  lat?: number | null
  lng?: number | null
  property_id?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  property_type?: string | null
  beds?: number | null
  baths?: number | null
  sqft?: number | null
  year_built?: number | null
  units?: number | null
  estimated_value?: number | null
  streetview_image?: string | null
  buyer?: string | null
  buyer_class?: string | null
  buyer_kind?: string | null
  buyer_archetype?: string | null
  is_investor?: boolean | null
  investor_inferred_current_owner?: boolean | null
  out_of_state_owner?: boolean | null
  portfolio_size?: number | null
  portfolio?: Array<{ comp_id: string; address: string | null; lat: number; lng: number; type: string | null }> | null
  buyer_stats?: { purchases: number; first: string | null; last: string | null; markets: number; median_price?: number | null } | null
  price_src?: string | null
  price_source?: string | null
  observations?: number | null
  sources?: string | null
  doc_type?: string | null
  is_cash_purchase?: boolean | null
  is_arms_length?: boolean | null
  is_priced?: boolean | null
  details?: Record<string, string | number | boolean | null> | null
}

export interface CompSubject {
  lat: number
  lng: number
  propertyId?: string | null
  label?: string | null
  /** the subject's ESTIMATED value (AVM) — never a sale */
  estimatedValue?: number | null
  sqft?: number | null
}

export const DASH = '—'
const DAY = 86_400_000

/* ── primitives ────────────────────────────────────────────────────────── */

/** A usable positive number, else null. 0, negatives, NaN, '' and null are missing. */
export function pos(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === 'boolean') return null
  const s = String(v).trim()
  return s ? s : null
}

export function fmtUsd(v: unknown): string {
  const n = pos(v)
  if (n === null) return DASH
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
  if (n >= 1e4) return `$${Math.round(n / 1000)}K`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** Whole dollars, for the card's headline ($412,500). */
export function fmtUsdFull(v: unknown): string {
  const n = pos(v)
  return n === null ? DASH : `$${Math.round(n).toLocaleString('en-US')}`
}

export function fmtInt(v: unknown, suffix = ''): string {
  const n = pos(v)
  return n === null ? DASH : `${Math.round(n).toLocaleString('en-US')}${suffix}`
}

/** Baths keep a half (2.5 ba). */
export function fmtBaths(v: unknown): string {
  const n = pos(v)
  return n === null ? DASH : `${Math.round(n * 2) / 2}`
}

export function fmtDate(d: unknown): string {
  const s = str(d)
  if (!s) return DASH
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s)
  return Number.isNaN(t.getTime()) ? s : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function daysSince(d: unknown, now: number): number | null {
  const s = str(d)
  if (!s || !Number.isFinite(now)) return null
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s)
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null
}

export function fmtAge(days: number | null): string {
  if (days === null) return DASH
  if (days < 1) return 'today'
  if (days < 45) return `${days}d ago`
  if (days < 365 * 2) return `${Math.round(days / 30.44)} mo ago`
  return `${(days / 365.25).toFixed(1)} yr ago`
}

export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.7613
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

const usableLatLng = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001

export function distanceToSubject(subject: CompSubject | null | undefined, lat: unknown, lng: unknown): number | null {
  if (!subject || !usableLatLng(subject.lat, subject.lng) || !usableLatLng(lat, lng)) return null
  return haversineMiles(subject.lat, subject.lng, lat as number, lng as number)
}

export function fmtMiles(mi: number | null): string {
  if (mi === null) return DASH
  return mi < 0.1 ? `${Math.round(mi * 5280).toLocaleString('en-US')} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Inc|Ii|Iii|Sfr|Amh|Reit)\b/g, (w) => w.toUpperCase())

/* ── labels ────────────────────────────────────────────────────────────── */

export const SOURCE_LABEL: Record<string, string> = { mls: 'MLS sale', public_record: 'Public record', investor: 'Investor purchase' }

export const BUYER_CLASS_LABEL: Record<string, string> = {
  builder: 'Home builder',
  institutional: 'Institutional',
  hedge_fund: 'Hedge fund',
  portfolio: 'Portfolio buyer',
  llc_investor: 'LLC / investor',
  individual: 'Individual buyer',
  trust: 'Trust / estate',
  bank: 'Bank / lender',
  government: 'Government',
  unknown: 'Buyer not on record',
}

export type CorpusKind = 'engine_pool' | 'market_sale'

/**
 * Engine pool vs display-only market sale, from the comp id and the cluster's
 * source letters (mv_map_market_sales.sources: 'T' deed, 'P' engine pool).
 * A 'p:' id is pool-only; a 't:' id is in the pool only when its cluster
 * merged a pool observation.
 */
export function corpusOf(compId: string | null | undefined, sources?: string | null): CorpusKind | null {
  const id = str(compId)
  if (!id) return null
  if (id.startsWith('p:') || id.startsWith('c:')) return 'engine_pool'
  if (typeof sources === 'string') return sources.toUpperCase().includes('P') ? 'engine_pool' : 'market_sale'
  return null
}

export const CORPUS_LABEL: Record<CorpusKind, { title: string; note: string }> = {
  engine_pool: { title: 'Valuation comp · engine pool', note: 'In the engine pool (v_recent_sold_comps), the valuation’s only comp source' },
  market_sale: { title: 'Market sale · display only', note: 'Canonical recorded sale — not in the valuation, never scored' },
}

/* ── units ─────────────────────────────────────────────────────────────── */

const SINGLE_UNIT_VOCAB = /\b(single[\s-]*family|sfr|sfh|townhouse|townhome|condo(minium)?|mobile|manufactured|residential)\b/i

/**
 * A unit count the card may divide by: a real positive number from the record.
 * Never inferred from a missing value. A single-unit vocabulary overridden by
 * a unit count > 1 must show ≥350 sf/unit (the engine's unitCountCredible).
 */
export function credibleUnits(units: unknown, propertyType: unknown, sqft: unknown): { units: number | null; reason: string | null } {
  const u = pos(units)
  if (u === null) return { units: null, reason: 'unit count not recorded' }
  const n = Math.round(u)
  if (n < 1) return { units: null, reason: 'unit count not recorded' }
  const type = str(propertyType)
  if (n > 1 && type && SINGLE_UNIT_VOCAB.test(type)) {
    const sf = pos(sqft)
    if (sf === null || sf / n < 350) return { units: null, reason: `${n} units on a ${type} record is not credible` }
  }
  return { units: n, reason: null }
}

/** Price per unit — only over a credible, real unit count. */
export function pricePerUnit(price: unknown, units: unknown, propertyType: unknown, sqft: unknown): number | null {
  const p = pos(price)
  const u = credibleUnits(units, propertyType, sqft).units
  return p !== null && u !== null ? Math.round(p / u) : null
}

/* ── hover ─────────────────────────────────────────────────────────────── */

export interface CompHoverModel {
  key: string
  cluster: boolean
  count: number
  headline: string
  headlineNote: string | null
  date: string
  age: string
  source: string | null
  buyer: string | null
  portfolio: string | null
  institutional: boolean
  specs: Array<{ label: string; value: string }>
  distance: string | null
  corpus: CorpusKind | null
}

/**
 * The hover preview from what the feature already carries (plus an
 * already-hydrated record when this comp was clicked before). Pure: no I/O.
 */
export function hoverPreviewFromFeature(
  props: CompFeatureProps,
  lngLat: readonly [number, number] | null,
  subject: CompSubject | null | undefined,
  now: number,
  hydrated?: CompRecord | null,
): CompHoverModel {
  const n = Math.max(1, Math.round(Number(props.n) || 1))
  const cluster = n > 1
  const compId = str(props.comp_id)
  const key = compId ?? `cluster:${lngLat ? lngLat.map((v) => v.toFixed(5)).join(',') : 'x'}`
  const portfolioSize = Math.round(Number(props.portfolio_size) || 1)
  const isPortfolio = !cluster && portfolioSize >= 2
  const days = daysSince(props.sold_on, now)
  const buyerClass = str(props.buyer_class)
  const h = hydrated && hydrated.comp_id === compId ? hydrated : null
  const ppsf = pos(props.ppsf) ?? pos(h?.ppsf)
  const beds = pos(props.beds) ?? pos(h?.beds)
  const baths = pos(props.baths) ?? pos(h?.baths)
  const sqft = pos(props.sqft) ?? pos(h?.sqft)
  const specs = cluster ? [] : [
    { label: 'PPSF', value: ppsf !== null ? `$${Math.round(ppsf).toLocaleString('en-US')}` : DASH },
    { label: 'Beds', value: beds !== null ? fmtInt(beds) : DASH },
    { label: 'Baths', value: baths !== null ? fmtBaths(baths) : DASH },
    { label: 'Sq ft', value: sqft !== null ? fmtInt(sqft) : DASH },
  ]
  const dist = lngLat ? distanceToSubject(subject, lngLat[1], lngLat[0]) : null
  return {
    key,
    cluster,
    count: n,
    headline: fmtUsd(props.price),
    headlineNote: cluster ? 'average' : isPortfolio ? 'per door' : null,
    date: cluster ? (props.sold_on ? `newest ${fmtDate(props.sold_on)}` : DASH) : fmtDate(props.sold_on),
    age: fmtAge(days),
    source: str(props.source) ? (SOURCE_LABEL[String(props.source)] ?? null) : null,
    buyer: buyerClass && buyerClass !== 'unknown' ? (BUYER_CLASS_LABEL[buyerClass] ?? null) : null,
    portfolio: isPortfolio ? `Portfolio of ${portfolioSize}` : null,
    institutional: Number(props.institutional) > 0 || buyerClass === 'institutional' || buyerClass === 'hedge_fund',
    specs,
    distance: dist !== null ? fmtMiles(dist) : null,
    corpus: cluster ? null : corpusOf(compId, h?.sources ?? null),
  }
}

/* ── the card ──────────────────────────────────────────────────────────── */

export interface Fact { label: string; value: string; hint?: string; tone?: 'ok' | 'attn' | 'exec' | 'flow' }

export interface CompDelta { label: string; value: string; direction: 'up' | 'down' | 'flat' | null; basis: string }

import type { SaleOwnerRow } from '../../../../modules/market-intelligence/sale-owner/sale-owner-client'

export interface CompCardModel {
  compId: string
  address: string
  locality: string | null
  lat: number | null
  lng: number | null
  propertyId: string | null
  corpus: CorpusKind | null
  corpusTitle: string | null
  corpusNote: string | null
  sourceLabel: string
  priced: boolean
  headline: string
  headlineBasis: string
  portfolioTotal: string | null
  portfolioSize: number
  saleDate: string
  age: string
  ppsf: string
  ppu: string
  ppuHint: string | null
  specs: Fact[]
  buyer: { name: string; kind: string; withheld: boolean; investor: boolean; record: string | null; entityNote: string | null
    /** The shared buyer-of-record resolver (MI op=sale_owner), when this sale has no recorded buyer. */
    owner: SaleOwnerRow | null; basis: 'recorded_buyer' | 'current_owner_of_record' | 'not_on_record' | null }
  money: Fact[]
  provenance: Fact[]
  subject: { label: string; deltas: CompDelta[] } | null
  institutional: boolean
  estimatedValue: string
}

const pctDelta = (a: number, b: number) => ((a - b) / b) * 100

function delta(label: string, comp: number | null, subj: number | null, basis: string, money: (n: number) => string): CompDelta {
  if (comp === null || subj === null) return { label, value: DASH, direction: null, basis }
  const diff = comp - subj
  const p = pctDelta(comp, subj)
  const dir: CompDelta['direction'] = Math.abs(p) < 0.5 ? 'flat' : diff > 0 ? 'up' : 'down'
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  return { label, value: `${sign}${money(Math.abs(diff))} · ${sign}${Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0)}%`, direction: dir, basis }
}

const yesNo = (v: unknown, yes: string, no: string): string | null => (v === true ? yes : v === false ? no : null)

export function buildCompCardModel(c: CompRecord, subject: CompSubject | null | undefined, now: number, owner: SaleOwnerRow | null = null): CompCardModel {
  const d = c.details ?? {}
  const portfolioSize = Math.max(1, Math.round(Number(c.portfolio_size) || 1))
  const isPortfolio = portfolioSize >= 2
  const price = pos(c.price)
  const perDoor = pos(c.per_door)
  const basePrice = isPortfolio ? perDoor : price
  const sqft = pos(c.sqft)
  const ppsf = pos(c.ppsf) ?? (!isPortfolio && price !== null && sqft !== null ? Math.round(price / sqft) : null)
  const units = credibleUnits(c.units, c.property_type, sqft)
  const ppu = basePrice !== null && units.units !== null ? Math.round(basePrice / units.units) : null
  const corpus = corpusOf(c.comp_id, c.sources ?? null)
  const lat = typeof c.lat === 'number' && Number.isFinite(c.lat) ? c.lat : null
  const lng = typeof c.lng === 'number' && Number.isFinite(c.lng) ? c.lng : null
  const lot = pos(d.lot_square_feet) !== null ? `${fmtInt(d.lot_square_feet)} sf` : pos(d.lot_acreage) !== null ? `${Number(d.lot_acreage).toFixed(2)} ac` : DASH
  const days = daysSince(c.sold_on, now)

  // buyer — company names only; a person is never named
  const buyerClass = str(c.buyer_class) ?? 'unknown'
  const isPerson = c.buyer_kind === 'person' || buyerClass === 'individual'
  const company = !isPerson ? str(c.buyer) : null
  const stats = c.buyer_stats && c.buyer_stats.purchases > 1 ? c.buyer_stats : null
  // No recorded buyer: the shared resolver may name today's owner of record (latest sale, no
  // later transfer). Its label is used verbatim; "not on record" stays "Buyer not on record".
  const resolved = !company && !isPerson && owner?.buyer_of_record ? owner : null
  const buyer = {
    name: company ? titleCase(company) : isPerson ? 'Individual buyer' : resolved ? resolved.buyer_of_record!.label : 'Buyer not on record',
    kind: BUYER_CLASS_LABEL[buyerClass] ?? 'Buyer',
    withheld: isPerson,
    investor: c.is_investor === true,
    record: stats ? [`${stats.purchases} purchases`, stats.markets > 1 ? `${stats.markets} states` : null, pos(stats.median_price) !== null ? `median ${fmtUsd(stats.median_price)}` : null, stats.last ? `last ${fmtDate(stats.last)}` : null].filter(Boolean).join(' · ') : null,
    // The resolver's tiered inference replaces the untiered entity note once it is known.
    entityNote: !owner && c.investor_inferred_current_owner === true ? 'The parcel is owned by an entity today — inferred, not an investor purchase' : null,
    owner: resolved,
    basis: company || isPerson ? 'recorded_buyer' as const : resolved ? resolved.buyer_of_record!.basis : null,
  }

  // cash / financing — only what the record says
  const cash = c.is_cash_purchase ?? (typeof d.cash_purchase === 'boolean' ? d.cash_purchase : null)
  const arms = c.is_arms_length ?? (typeof d.arms_length === 'boolean' ? d.arms_length : null)
  const money: Fact[] = [
    { label: 'Payment', value: yesNo(cash, 'Cash', 'Financed') ?? DASH, tone: cash === true ? 'ok' : undefined },
    { label: 'Financing', value: str(d.financing) ? titleCase(String(d.financing).replace(/_/g, ' ')) : d.has_concurrent_loan === true ? 'Concurrent loan recorded' : DASH },
    { label: 'Arm’s length', value: yesNo(arms, 'Yes', 'No — non-arm’s-length') ?? DASH, tone: arms === false ? 'attn' : undefined },
    { label: 'Document', value: str(c.doc_type) ?? str(d.document_type) ?? DASH },
    { label: 'Price basis', value: str(c.price_source) ? String(c.price_source).replace(/_/g, ' ') : str(d.price_code) ?? DASH },
  ]
  if (str(d.purchase_info)) money.push({ label: 'Purchase info', value: String(d.purchase_info) })

  const obs = pos(c.observations)
  const provenance: Fact[] = [
    { label: 'Corpus', value: corpus ? (corpus === 'engine_pool' ? 'Engine pool' : 'Canonical recorded sales') : DASH, hint: corpus ? CORPUS_LABEL[corpus].note : undefined, tone: corpus === 'engine_pool' ? 'exec' : undefined },
    { label: 'Price from', value: c.price_src === 'P' ? 'Engine pool record' : c.price_src === 'T' ? 'Recorded deed' : DASH },
    { label: 'Observations', value: obs !== null ? `${Math.round(obs)} merged${str(d.corpus) ? ` · ${d.corpus}` : ''}` : DASH },
    { label: 'Recorded', value: str(d.recording_date) ? fmtDate(d.recording_date) : fmtDate(d.sale_date ?? c.sold_on) },
    { label: 'APN', value: str(d.apn) ?? DASH },
    { label: 'Dataset', value: 'mv_map_market_sales · refreshed daily' },
  ]

  const specs: Fact[] = [
    { label: 'Beds', value: fmtInt(c.beds) },
    { label: 'Baths', value: fmtBaths(c.baths) },
    { label: 'Sq ft', value: fmtInt(sqft) },
    { label: 'Lot', value: lot },
    { label: 'Built', value: pos(c.year_built) !== null ? String(Math.round(Number(c.year_built))) : DASH },
    { label: 'Units', value: units.units !== null ? String(units.units) : DASH, hint: units.reason ?? undefined },
    { label: 'Type', value: str(c.property_type) ?? DASH },
    { label: 'Stories', value: fmtInt(d.stories) },
  ]

  // vs the selected subject — sale vs the subject's ESTIMATE, labelled
  let subjectBlock: CompCardModel['subject'] = null
  if (subject && usableLatLng(subject.lat, subject.lng)) {
    const subjValue = pos(subject.estimatedValue)
    const subjSqft = pos(subject.sqft)
    const subjPpsf = subjValue !== null && subjSqft !== null ? subjValue / subjSqft : null
    const dist = distanceToSubject(subject, lat, lng)
    subjectBlock = {
      label: str(subject.label) ?? 'Selected property',
      deltas: [
        { label: 'Distance', value: fmtMiles(dist), direction: null, basis: 'Straight line to the selected property' },
        delta('Δ price', basePrice, subjValue, isPortfolio ? 'Per-door sale vs the subject’s estimated value' : 'Sale price vs the subject’s estimated value (AVM)', (n) => fmtUsd(n)),
        delta('Δ PPSF', ppsf, subjPpsf, 'Sale $/sf vs the subject’s estimated value ÷ its sq ft', (n) => `$${Math.round(n).toLocaleString('en-US')}`),
      ],
    }
  }

  const address = str(c.address)
  const city = str(c.city)
  const locality = [city ? titleCase(city) : null, [str(c.state)?.toUpperCase() ?? null, str(c.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null
  return {
    compId: c.comp_id,
    address: address ? titleCase(address.split(',')[0]) : 'Address not recorded',
    locality,
    lat,
    lng,
    propertyId: str(c.property_id),
    corpus,
    corpusTitle: corpus ? CORPUS_LABEL[corpus].title : null,
    corpusNote: corpus ? CORPUS_LABEL[corpus].note : null,
    sourceLabel: SOURCE_LABEL[String(c.source ?? '')] ?? 'Sale',
    priced: basePrice !== null,
    headline: fmtUsdFull(basePrice),
    headlineBasis: isPortfolio ? 'per door' : basePrice !== null ? 'sale price' : 'no price recorded',
    portfolioTotal: isPortfolio && price !== null ? fmtUsd(price) : null,
    portfolioSize,
    saleDate: fmtDate(c.sold_on),
    age: fmtAge(days),
    ppsf: ppsf !== null ? `$${Math.round(ppsf).toLocaleString('en-US')}` : DASH,
    ppu: ppu !== null ? fmtUsd(ppu) : DASH,
    ppuHint: ppu === null ? (basePrice === null ? 'no price recorded' : units.reason) : null,
    specs,
    buyer,
    money,
    provenance,
    subject: subjectBlock,
    institutional: buyerClass === 'institutional' || buyerClass === 'hedge_fund',
    estimatedValue: fmtUsd(c.estimated_value),
  }
}

/* ── the subject, from the Map's selected property card ─────────────────── */

const subjectCache = new WeakMap<object, CompSubject>()

/**
 * The comp card's subject from the selected property card's record and its
 * mapped position (tile features carry no lat/lng — the card coordinates do).
 * Reads only what the record holds; memoised per record so it is stable.
 */
export function compSubjectFrom(record: Record<string, unknown> | null | undefined, coordinates: readonly [number, number] | null | undefined): CompSubject | null {
  if (!record || !coordinates) return null
  const [lng, lat] = coordinates
  if (!usableLatLng(lat, lng)) return null
  const hit = subjectCache.get(record)
  if (hit && hit.lat === lat && hit.lng === lng) return hit
  const address = str(record.property_address_full) ?? str(record.address) ?? str(record.property_address)
  const next: CompSubject = {
    lat,
    lng,
    propertyId: str(record.property_id) ?? str(record.propertyId),
    label: address ? titleCase(address.split(',')[0]) : null,
    estimatedValue: pos(record.estimated_value) ?? pos(record.estimatedValue),
    sqft: pos(record.building_square_feet) ?? pos(record.sqft),
  }
  subjectCache.set(record, next)
  return next
}
