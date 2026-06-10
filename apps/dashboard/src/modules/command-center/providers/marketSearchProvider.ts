import type { CommandResult, GlobalCommandProvider, GlobalCommandSearchContext } from '.../../domain/command-center/command.types'
import { canUseSupabaseSearch, getSupabaseSearchClient, limitResults, sanitizeIlike, withScoredResult } from './providerUtils'

type MarketRow = Record<string, unknown>

const asText = (value: unknown): string => String(value ?? '').trim()

const mapMarketRow = (row: MarketRow, context: GlobalCommandSearchContext): CommandResult => {
  const market = asText(row.market) || asText(row.property_address_city) || 'Market not resolved'
  const state = asText(row.property_address_state)
  const zip = asText(row.property_address_zip)
  const subtitle = [state, zip].filter(Boolean).join(' · ') || 'Inbox market intelligence'

  return {
    id: `market-${market.toLowerCase()}-${state.toLowerCase() || 'na'}`,
    type: 'market',
    title: market,
    subtitle,
    description: 'Focus Inbox views and map context on this market.',
    badge: 'Market',
    icon: 'map',
    route: '/inbox',
    score: context.selectedMarket?.toLowerCase() === market.toLowerCase() ? 84 : 42,
    payload: { kind: 'focus_market', market, state },
    preview: {
      eyebrow: 'Market',
      title: market,
      summary: [market, state].filter(Boolean).join(', '),
      details: [
        { label: 'State', value: state || '—' },
        { label: 'Zip', value: zip || '—' },
      ],
    },
    meta: {
      provider: 'market',
      groupLabel: 'Markets',
      keywords: [market, state, zip, `${market} ${state}`].filter(Boolean),
    },
  }
}

export const marketSearchProvider: GlobalCommandProvider = {
  id: 'market',
  search: async (query, context) => {
    if (!canUseSupabaseSearch(query)) return []
    const supabase = getSupabaseSearchClient()
    const term = `%${sanitizeIlike(query)}%`
    const { data, error } = await supabase
      .from('v_operator_inbox_threads')
      .select('market,property_address_city,property_address_state,property_address_zip')
      .or([
        `market.ilike.${term}`,
        `property_address_city.ilike.${term}`,
        `property_address_state.ilike.${term}`,
        `property_address_zip.ilike.${term}`,
      ].join(','))
      .limit(15)

    if (error || !data) return []

    const uniqueRows = Array.from(new Map(
      (data as MarketRow[])
        .filter((row) => asText(row.market) || asText(row.property_address_city))
        .map((row) => {
          const market = asText(row.market) || asText(row.property_address_city)
          const state = asText(row.property_address_state)
          return [`${market.toLowerCase()}::${state.toLowerCase()}`, row] as const
        }),
    ).values())

    return limitResults(
      uniqueRows.map((row) => withScoredResult(
        mapMarketRow(row, context),
        query,
        context,
        asText(row.market),
        asText(row.property_address_city),
        asText(row.property_address_state),
        asText(row.property_address_zip),
      )),
      8,
    )
  },
}
