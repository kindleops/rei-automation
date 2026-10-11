/**
 * BUYER MATCH · GEOGRAPHY MODEL (pure). What the real map draws:
 *
 *   - every recorded purchase inside the subject's evidence radius from the
 *     workspace's window read (`w.transactions`, any buyer on the page),
 *     coloured by buyer — a stable categorical colour for the most active
 *     buyers, one neutral bucket for the rest;
 *   - the selected buyer's purchases emphasised, the others dimmed;
 *   - when the window read is absent, the selected buyer's own located
 *     purchases and holdings (the old footprint's evidence) instead.
 *
 * Names follow the cockpit's rule: a person, or a buyer whose name is
 * withheld, is never named — not in the legend, not in a hover card.
 */
import type { BuyerMatchWorkspace, MatchedBuyer, WindowTransaction } from '../../../domain/buyer-match/buyer-match-workspace-api'
import type { Holding, Receipt } from './buyer-match-cockpit-model'
import { haversineMiles } from './buyer-match-cockpit-model'

/** Categorical, theme-safe; never the semantic red / amber. */
export const GEO_PALETTE = ['#5cc8f0', '#a78bfa', '#34d399', '#f472b6', '#60a5fa', '#2dd4bf', '#c084fc', '#a3e635'] as const
export const GEO_OTHER = '#8d9ab0'
export const GEO_MAX_COLORED = GEO_PALETTE.length

export type GeoSource = 'window' | 'selected'

export interface GeoPoint {
  key: string
  lat: number
  lng: number
  buyerId: string | null
  /** 'b0'…'b7' for coloured buyers, 'other' for the neutral bucket, 'held' for a holding */
  colorKey: string
  color: string
  selected: boolean
  kind: 'purchase' | 'holding'
  buyerLabel: string
  address: string | null
  city: string | null
  date: string | null
  price: number | null
  nominal: boolean
  family: string | null
  sameFamily: boolean | null
  miles: number | null
  propertyId: string | null
}

export interface LegendRow { key: string; label: string; color: string; count: number; selected: boolean; buyerId: string | null }

export interface GeoModel {
  source: GeoSource
  points: GeoPoint[]
  legend: LegendRow[]
  /** purchases in the read but outside the radius (or without a buyer on the page) */
  outside: number
  truncated: boolean
  total: number | null
}

/** The legend / hover label: a name only for a named company. */
export function buyerGeoLabel(b: Pick<MatchedBuyer, 'name' | 'kind' | 'nameWithheld'> | null | undefined): string {
  if (!b) return 'Other buyer'
  if (b.kind === 'person') return 'Private individual'
  if (b.nameWithheld || !b.name) return 'Registered entity'
  return b.name
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Colour slots: the buyers with the most located purchases in the read get the
 * palette, ties broken by id so the same workspace always paints the same way.
 * The selected buyer always gets a colour.
 */
export function assignBuyerColors(rows: Array<Pick<WindowTransaction, 'buyerId'>>, known: Set<string>, selectedId: string | null, max = GEO_MAX_COLORED): Map<string, { key: string; color: string }> {
  const counts = new Map<string, number>()
  for (const r of rows) if (known.has(r.buyerId)) counts.set(r.buyerId, (counts.get(r.buyerId) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id]) => id)
  let top = ranked.slice(0, max)
  if (selectedId && counts.has(selectedId) && !top.includes(selectedId)) top = [...top.slice(0, max - 1), selectedId]
  // palette order follows rank, so the top buyer keeps the first colour
  const ordered = ranked.filter((id) => top.includes(id))
  const out = new Map<string, { key: string; color: string }>()
  ordered.forEach((id, i) => out.set(id, { key: `b${i}`, color: GEO_PALETTE[i % GEO_PALETTE.length] }))
  return out
}

export function milesFrom(subject: { lat: number | null; lng: number | null }, lat: number, lng: number): number | null {
  if (!finite(subject.lat) || !finite(subject.lng)) return null
  return Math.round(haversineMiles(subject.lat, subject.lng, lat, lng) * 100) / 100
}

export function buildGeoModel(input: {
  w: Pick<BuyerMatchWorkspace, 'subject' | 'query' | 'transactions'>
  buyers: Array<Pick<MatchedBuyer, 'id' | 'name' | 'kind' | 'nameWithheld'>>
  selectedId: string | null
  receipts?: Receipt[]
  holdings?: Holding[]
}): GeoModel {
  const { w, buyers, selectedId } = input
  const R = w.query.radiusMiles
  const byId = new Map(buyers.map((b) => [b.id, b]))
  const tx = w.transactions
  const selected = selectedId ? byId.get(selectedId) ?? null : null

  if (tx?.available && tx.rows.length) {
    let outside = 0
    const located: Array<WindowTransaction & { d: number | null }> = []
    for (const r of tx.rows) {
      if (!finite(r.lat) || !finite(r.lng)) { outside += 1; continue }
      const d = finite(r.miles) ? r.miles : milesFrom(w.subject, r.lat, r.lng)
      if (d !== null && d > R + 1e-6) { outside += 1; continue }
      if (!byId.has(r.buyerId)) { outside += 1; continue }
      located.push({ ...r, d })
    }
    const colors = assignBuyerColors(located, new Set(byId.keys()), selectedId)
    const points: GeoPoint[] = located.map((r, i) => {
      const c = colors.get(r.buyerId)
      return {
        key: `t:${r.txnId ?? `${r.buyerId}:${i}`}`,
        lat: r.lat, lng: r.lng, buyerId: r.buyerId,
        colorKey: c?.key ?? 'other', color: c?.color ?? GEO_OTHER,
        selected: selectedId !== null && r.buyerId === selectedId,
        kind: 'purchase', buyerLabel: buyerGeoLabel(byId.get(r.buyerId)),
        address: r.address, city: r.city, date: r.date, price: r.price, nominal: r.nominal,
        family: r.family, sameFamily: r.sameFamily, miles: r.d, propertyId: r.propertyId,
      }
    })
    return { source: 'window', points, legend: legendRows(points, byId), outside, truncated: tx.truncated, total: tx.total }
  }

  // fallback: the selected buyer's own located purchases and holdings
  const label = buyerGeoLabel(selected)
  const points: GeoPoint[] = []
  for (const r of input.receipts ?? []) {
    if (!finite(r.lat) || !finite(r.lng)) continue
    points.push({
      key: `r:${r.key}`, lat: r.lat, lng: r.lng, buyerId: selectedId, colorKey: 'b0', color: GEO_PALETTE[0], selected: true, kind: 'purchase',
      buyerLabel: label, address: r.address, city: r.city, date: r.date, price: r.price, nominal: r.nominal, family: r.family, sameFamily: r.sameFamily,
      miles: finite(r.miles) ? r.miles : milesFrom(w.subject, r.lat, r.lng), propertyId: null,
    })
  }
  for (const h of input.holdings ?? []) {
    if (!finite(h.lat) || !finite(h.lng)) continue
    points.push({
      key: `h:${h.key}`, lat: h.lat, lng: h.lng, buyerId: selectedId, colorKey: 'held', color: GEO_OTHER, selected: true, kind: 'holding',
      buyerLabel: `${label} · ${h.basis}`, address: h.address, city: null, date: null, price: h.value, nominal: false, family: h.propertyType, sameFamily: null,
      miles: h.miles, propertyId: h.propertyId,
    })
  }
  const legend: LegendRow[] = []
  const nP = points.filter((p) => p.kind === 'purchase').length
  const nH = points.length - nP
  if (nP) legend.push({ key: 'b0', label, color: GEO_PALETTE[0], count: nP, selected: true, buyerId: selectedId })
  if (nH) legend.push({ key: 'held', label: 'Holdings', color: GEO_OTHER, count: nH, selected: true, buyerId: selectedId })
  return { source: 'selected', points, legend, outside: 0, truncated: false, total: null }
}

/** Legend: coloured buyers in palette order (selected flagged), then the neutral bucket. */
export function legendRows(points: GeoPoint[], byId: Map<string, Pick<MatchedBuyer, 'id' | 'name' | 'kind' | 'nameWithheld'>>): LegendRow[] {
  const rows = new Map<string, LegendRow>()
  for (const p of points) {
    const k = p.colorKey
    const row = rows.get(k)
    if (row) { row.count += 1; continue }
    rows.set(k, {
      key: k,
      label: k === 'other' ? 'Other buyers' : buyerGeoLabel(p.buyerId ? byId.get(p.buyerId) : null),
      color: p.color, count: 1, selected: p.selected, buyerId: k === 'other' ? null : p.buyerId,
    })
  }
  const order = (k: string) => (k === 'other' ? 1e6 : k === 'held' ? 1e5 : Number(k.slice(1)))
  return [...rows.values()].sort((a, b) => order(a.key) - order(b.key))
}

/** The rows the list beside the map shows: the selected buyer first, then nearest. */
export function listOrder(points: GeoPoint[]): GeoPoint[] {
  return [...points].sort((a, b) => Number(b.selected) - Number(a.selected) || (a.miles ?? 1e9) - (b.miles ?? 1e9) || (a.key < b.key ? -1 : 1))
}

export function pointCollection(points: GeoPoint[], anySelected: boolean) {
  return {
    type: 'FeatureCollection' as const,
    features: points.map((p) => ({
      type: 'Feature' as const,
      id: p.key,
      properties: { key: p.key, color: p.color, sel: p.selected ? 1 : 0, dim: anySelected && !p.selected ? 1 : 0, held: p.kind === 'holding' ? 1 : 0 },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    })),
  }
}

/** [[w, s], [e, n]] around the radius, for fitBounds. */
export function radiusBounds(lat: number, lng: number, miles: number): [[number, number], [number, number]] {
  const dLat = miles / 69.0
  const dLng = miles / (69.0 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
  return [[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]]
}
