import type { PostgrestError } from '@supabase/supabase-js'
import type { CommandResult, GlobalCommandProvider } from '.../../domain/command-center/command.types'
import { canUseSupabaseSearch, getSupabaseSearchClient, limitResults, sanitizeIlike, withScoredResult } from './providerUtils'

type BuyerRow = Record<string, unknown>

const asText = (value: unknown): string => String(value ?? '').trim()

const fetchFirstAvailable = async (tables: string[], query: string): Promise<BuyerRow[]> => {
  const supabase = getSupabaseSearchClient()
  const term = `%${sanitizeIlike(query)}%`
  let lastError: PostgrestError | null = null

  for (const table of tables) {
    const result = await supabase
      .from(table)
      .select('*')
      .or([
        `buyer_name.ilike.${term}`,
        `buyer_entity_name.ilike.${term}`,
        `entity_name.ilike.${term}`,
        `market.ilike.${term}`,
        `property_type.ilike.${term}`,
        `buyer_exit_strategy.ilike.${term}`,
      ].join(','))
      .limit(8)

    if (!result.error && result.data) return result.data as BuyerRow[]
    lastError = result.error
  }

  if (lastError) return []
  return []
}

const mapBuyerRow = (row: BuyerRow): CommandResult => {
  const buyerName =
    asText(row.buyer_name)
    || asText(row.buyer_entity_name)
    || asText(row.entity_name)
    || asText(row.company_name)
    || 'Buyer entity'
  const market = asText(row.market) || asText(row.top_market)
  const propertyType = asText(row.property_type) || asText(row.primary_property_type)
  const strategy = asText(row.buyer_exit_strategy) || asText(row.strategy)
  const confidence = asText(row.buyer_confidence_score || row.confidence_score)
  const activity = asText(row.last_purchase_date || row.last_activity_at)

  return {
    id: `buyer-${asText(row.buyer_key || row.buyer_entity_key || row.id || buyerName)}`,
    type: 'buyer',
    title: buyerName,
    subtitle: [market, propertyType || strategy || 'Buyer'].filter(Boolean).join(' · '),
    description: strategy || activity || 'Buyer intelligence record',
    badge: confidence ? `Confidence ${confidence}` : 'Buyer',
    icon: 'briefcase',
    route: '/inbox',
    score: 24,
    payload: {
      kind: 'focus_buyer',
      buyerKey: asText(row.buyer_key || row.buyer_entity_key),
    },
    preview: {
      eyebrow: 'Buyer',
      title: buyerName,
      summary: strategy || propertyType || market || 'Buyer intelligence',
      details: [
        { label: 'Market', value: market || '—' },
        { label: 'Property Type', value: propertyType || '—' },
        { label: 'Strategy', value: strategy || '—' },
        { label: 'Activity', value: activity || '—' },
      ],
    },
    meta: {
      provider: 'buyer',
      groupLabel: 'Buyers',
      keywords: [buyerName, market, propertyType, strategy].filter(Boolean),
    },
  }
}

export const buyerSearchProvider: GlobalCommandProvider = {
  id: 'buyer',
  search: async (query, context) => {
    if (!canUseSupabaseSearch(query)) return []
    const rows = await fetchFirstAvailable(
      ['v_buyer_entity_leaderboard', 'top_buyer_profiles', 'buyer_profiles_computed', 'buyer_profiles'],
      query,
    )
    return limitResults(rows.map((row) => withScoredResult(mapBuyerRow(row), query, context, asText(row.buyer_name), asText(row.market), asText(row.property_type))), 8)
  },
}
