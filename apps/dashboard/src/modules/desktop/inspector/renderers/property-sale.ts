import type { InspectorModel } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { count, joinParts, money, num, present, text, when, words } from '../inspector-read'

/**
 * A COMP-DERIVED PROPERTY THAT IS NOT A CANONICAL PROPERTY —
 * GET /api/cockpit/properties/:id/sale-record (mv_map_market_sales, read-only).
 *
 * Comps carry the sale corpus's property id; many of those parcels were sold but
 * never entered the property universe, so the subject read answers not-found.
 * The Inspector shows what IS on record — the recorded sales — and says plainly
 * that this is a sale record. It never offers property surfaces (Deal
 * Intelligence, Comps, Buyer Match, seller, deal), which would only 404, and it
 * never shows owner / valuation / equity it does not have.
 */

export interface SaleRecordSale {
  comp_id?: string | null
  sold_on?: string | null
  price?: number | null
  price_source?: string | null
  source?: string | null
  doc_type?: string | null
  is_arms_length?: boolean | null
  buyer?: string | null
  buyer_kind?: string | null
  is_investor?: boolean | null
}

export interface PropertySaleRecord {
  kind?: 'sale_record'
  property_id?: string
  canonical_property?: false
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
  sales?: SaleRecordSale[]
  sale_count?: number | null
}

const SOURCE: Record<string, string> = { public_record: 'Public record', mls: 'MLS' }

function saleLine(s: SaleRecordSale): string {
  const price = money(s.price) ?? 'Price not recorded'
  const how = joinParts([s.doc_type ?? null, SOURCE[String(s.source ?? '')] ?? words(s.source), s.is_investor ? 'Investor buyer' : null])
  return how ? `Sold ${price} · ${how}` : `Sold ${price}`
}

export function shapeSaleRecord(d: PropertySaleRecord, ref: EntityRef): InspectorModel {
  const id = text(d.property_id) ?? ref.id
  const address = text(d.address) ?? text(ref.label)
  const sales = (d.sales ?? []).filter((s) => s && (s.sold_on || s.price != null))
  const latest = sales[0] ?? null
  const units = num(d.units) ?? 0
  return {
    title: address ?? `Sale record ${id}`,
    eyebrow: joinParts([text(d.city), text(d.state)]),
    status: { label: 'Recorded sale · not a tracked property', tone: 'neutral' },
    facts: present([
      { label: 'Type', value: joinParts([text(d.property_type), units > 1 ? count(units, 'unit') : null]) },
      { label: 'Layout', value: joinParts([d.beds != null ? `${d.beds} bd` : null, d.baths != null ? `${d.baths} ba` : null, d.sqft ? `${count(d.sqft)} sq ft` : null]) },
      { label: 'Built', value: text(d.year_built) },
      { label: 'Sales on record', value: count(d.sale_count ?? sales.length) },
    ]),
    value: present([
      { label: 'Last sale', value: latest ? joinParts([money(latest.price) ?? 'Price not recorded', when(latest.sold_on)]) : null, hint: 'Recorded' },
      { label: 'Price basis', value: latest ? words(latest.price_source) : null, hint: 'Recorded' },
    ]),
    activity: sales.filter((s) => s.sold_on).map((s) => ({ at: String(s.sold_on), text: saleLine(s) })),
    // no property surface can open a parcel outside the property universe
    open: [],
    mission: null,
    replay: null,
    freshness: 'From recorded sales (comp corpus)',
  }
}
