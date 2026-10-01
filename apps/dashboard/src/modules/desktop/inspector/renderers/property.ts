import type { InspectorModel, InspectorRenderer } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { count, enc, joinParts, money, present, readInspector, text, when } from '../inspector-read'

/**
 * PROPERTY — GET /api/cockpit/properties/:id/subject (the Comps subject
 * contract, `comp_intelligence_subject_v1`). Fields arrive either raw or as
 * `{ value, source, … }`; both read the same.
 */

type Field = unknown
export interface PropertySubject {
  property_id?: string
  canonical_address?: Field
  owner_id?: Field
  master_owner_id?: Field
  opportunity_id?: Field
  thread_key?: Field
  market?: Field
  county?: Field
  property_type?: Field
  units?: Field
  bedrooms?: Field
  bathrooms?: Field
  square_feet?: Field
  year_built?: Field
  condition?: Field
  parcel_apn?: Field
  owner_name?: Field
  estimated_value?: Field
  estimated_arv?: Field
  equity_amount?: Field
  equity_percent?: Field
  repair_estimate?: Field
  last_sale_date?: Field
  last_sale_price?: Field
  tax_assessed_value?: Field
  data_freshness?: { property_updated_at?: string | null } | null
}

const v = (f: Field): unknown => (f && typeof f === 'object' && 'value' in (f as Record<string, unknown>) ? (f as { value: unknown }).value : f)
const t = (f: Field) => text(v(f))

export function shapeProperty(d: PropertySubject, ref: EntityRef): InspectorModel {
  const id = text(d.property_id) ?? ref.id
  const address = t(d.canonical_address) ?? text(ref.label)
  const threadKey = t(d.thread_key) ?? text(ref.hint?.thread_key)
  const opportunityId = t(d.opportunity_id) ?? text(ref.hint?.opportunity_id)
  const units = Number(v(d.units))
  const beds = v(d.bedrooms), baths = v(d.bathrooms)
  const owner = t(d.owner_name)
  const relations: InspectorModel['relations'] = []
  if (threadKey) relations.push({ label: 'Seller', ref: { type: 'seller', id: threadKey, label: owner, hint: { thread_key: threadKey, property_id: id } } })
  if (opportunityId) relations.push({ label: 'Deal', ref: { type: 'deal', id: opportunityId, label: address } })

  const open = [
    { label: 'Deal Intelligence', path: `/deal-intelligence?property_id=${enc(id)}` },
    { label: 'Comps', path: `/comp-intelligence?property_id=${enc(id)}` },
    { label: 'Buyer Match', path: `/buyer-match?property_id=${enc(id)}` },
    { label: 'Entity Graph', path: `/entity-graph/property/${enc(id)}` },
  ]
  if (opportunityId) open.push({ label: 'Pipeline', path: `/pipeline?opp=${enc(opportunityId)}` })

  const lastSale = joinParts([money(v(d.last_sale_price)), when(v(d.last_sale_date))])
  const equity = joinParts([money(v(d.equity_amount)), v(d.equity_percent) != null && v(d.equity_percent) !== '' ? `${Math.round(Number(v(d.equity_percent)))}%` : null])

  return {
    title: address ?? `Property ${id}`,
    eyebrow: joinParts([t(d.market), t(d.county) ? `${t(d.county)} County` : null]),
    facts: present([
      { label: 'Type', value: joinParts([t(d.property_type), units > 1 ? count(units, 'unit') : null]) },
      { label: 'Layout', value: joinParts([beds != null && beds !== '' ? `${beds} bd` : null, baths != null && baths !== '' ? `${baths} ba` : null, v(d.square_feet) ? `${count(v(d.square_feet))} sq ft` : null]) },
      { label: 'Built', value: t(d.year_built) },
      { label: 'Condition', value: t(d.condition) },
      { label: 'Owner', value: owner },
      { label: 'Parcel', value: t(d.parcel_apn) },
    ]),
    value: present([
      { label: 'Estimated value', value: money(v(d.estimated_value)), hint: 'Modeled' },
      { label: 'Estimated ARV', value: money(v(d.estimated_arv)), hint: 'Modeled' },
      { label: 'Equity', value: equity, hint: 'Modeled' },
      { label: 'Repair estimate', value: money(v(d.repair_estimate)), hint: 'Modeled' },
      { label: 'Last sale', value: lastSale, hint: 'Recorded' },
      { label: 'Tax assessed', value: money(v(d.tax_assessed_value)), hint: 'Recorded' },
    ]),
    relations,
    open,
    mission: { label: address ?? `Property ${id}`, propertyId: id, threadKey, opportunityId, masterOwnerId: t(d.master_owner_id), address },
    replay: { type: 'property', id, label: address },
    freshness: d.data_freshness?.property_updated_at ? `Property record updated ${when(d.data_freshness.property_updated_at)}` : null,
  }
}

export const propertyInspector: InspectorRenderer = {
  type: 'property',
  noun: 'Property',
  glyph: 'home',
  load: async (ref, signal) => {
    const id = text(ref.hint?.property_id) ?? ref.id
    const body = await readInspector<{ data: PropertySubject }>(`/api/cockpit/properties/${enc(id)}/subject`, signal)
    return shapeProperty(body.data ?? {}, ref)
  },
}
