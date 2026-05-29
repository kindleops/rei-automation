import type { CommandResult, GlobalCommandProvider } from '../command.types'
import { canUseSupabaseSearch, getSupabaseSearchClient, limitResults, sanitizeIlike, withScoredResult } from './providerUtils'

type PropertyRow = Record<string, unknown>

const asText = (value: unknown): string => String(value ?? '').trim()
const asNumber = (value: unknown): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const mapPropertyRow = (row: PropertyRow): CommandResult => {
  const address = asText(row.property_address_full || row.property_address || row.address) || 'Address not resolved'
  const city = asText(row.property_address_city)
  const state = asText(row.property_address_state)
  const zip = asText(row.property_address_zip)
  const market = asText(row.market)
  const propertyType = asText(row.property_type)
  const beds = asNumber(row.total_bedrooms ?? row.bedrooms)
  const baths = asNumber(row.total_baths ?? row.bathrooms)
  const sqft = asNumber(row.building_square_feet)
  const value = asNumber(row.estimated_value)
  const threadId = asText(row.thread_key || row.thread_id || row.id)
  const location = [city, state, zip].filter(Boolean).join(', ')

  return {
    id: `property-${asText(row.property_id || row.id || address)}`,
    type: 'property',
    title: address,
    subtitle: [market, propertyType || 'Property'].filter(Boolean).join(' · '),
    description: location || 'Property record',
    badge: 'Property',
    icon: 'home',
    route: '/inbox',
    score: 24,
    payload: {
      kind: 'focus_thread',
      threadId,
      view: 'command_map',
      propertyId: asText(row.property_id),
    },
    preview: {
      eyebrow: 'Property',
      title: address,
      summary: [location, propertyType].filter(Boolean).join(' · '),
      details: [
        { label: 'Market', value: market || '—' },
        { label: 'Beds / Baths', value: [beds ?? '—', baths ?? '—'].join(' / ') },
        { label: 'Sq Ft', value: sqft ? sqft.toLocaleString() : '—' },
        { label: 'Value', value: value ? `$${Math.round(value).toLocaleString()}` : '—' },
      ],
    },
    meta: {
      provider: 'property',
      groupLabel: 'Properties',
      keywords: [address, location, market, propertyType].filter(Boolean),
    },
  }
}

export const propertySearchProvider: GlobalCommandProvider = {
  id: 'property',
  search: async (query, context) => {
    if (!canUseSupabaseSearch(query)) return []
    const supabase = getSupabaseSearchClient()
    const safe = sanitizeIlike(query)
    const term = `%${safe}%`
    const { data, error } = await supabase
      .from('v_operator_inbox_threads')
      .select('id,thread_key,property_id,property_address_full,property_address,property_address_city,property_address_state,property_address_zip,market,property_type,total_bedrooms,total_baths,building_square_feet,estimated_value')
      .or([
        `property_address_full.ilike.${term}`,
        `property_address.ilike.${term}`,
        `property_address_city.ilike.${term}`,
        `property_address_state.ilike.${term}`,
        `property_address_zip.ilike.${term}`,
        `market.ilike.${term}`,
        `property_type.ilike.${term}`,
      ].join(','))
      .limit(8)

    if (error || !data) return []
    return limitResults(
      (data as PropertyRow[]).map((row) => withScoredResult(
        mapPropertyRow(row),
        query,
        context,
        asText(row.property_address_full || row.property_address),
        asText(row.market),
        asText(row.property_type),
      )),
      8,
    )
  },
}
