import type { CommandResult, GlobalCommandProvider, GlobalCommandSearchContext } from '../../../domain/command-center/command.types'
import { limitResults, withScoredResult } from './providerUtils'
import { searchInboxDeck, type InboxDeckHit } from './inboxDeckSearch'

/**
 * PROPERTIES — the properties behind the Inbox's conversations, from the same
 * server search as Sellers (one request serves both).
 *
 * Choosing one opens Deal Intelligence on THAT property (`?property_id=`, which
 * the desktop surface reads from its pane location); ⌥↵ opens it beside the
 * focused pane. A conversation without a linked property is not a property
 * result — it is still found under Sellers.
 */

export function toPropertyResult(hit: InboxDeckHit, context: GlobalCommandSearchContext): CommandResult | null {
  if (!hit.propertyId || !hit.street) return null
  const inboxFocused = context.routePath === '/inbox' || context.routePath === '/conversation'
  return {
    id: `property-${hit.propertyId}`,
    type: 'property',
    title: hit.street,
    subtitle: [hit.locality ?? hit.market, `Owner: ${hit.name}`].filter(Boolean).join(' · '),
    icon: 'home',
    route: `/deal-intelligence?property_id=${encodeURIComponent(hit.propertyId)}`,
    score: inboxFocused ? 34 : 24,
    payload: { propertyId: hit.propertyId, threadKey: hit.threadKey },
    preview: {
      eyebrow: 'Property',
      title: hit.street,
      summary: [hit.locality, hit.market].filter(Boolean).join(' · '),
      details: [
        { label: 'Owner', value: hit.name },
        { label: 'Market', value: hit.market ?? '—' },
      ],
    },
    meta: {
      provider: 'property',
      groupLabel: 'Properties',
      hint: 'Open Deal Intelligence · ⌥↵ beside',
      keywords: [hit.street, hit.locality, hit.market, hit.name].filter(Boolean) as string[],
    },
  }
}

export const propertySearchProvider: GlobalCommandProvider = {
  id: 'property',
  search: async (query, context) => {
    const hits = await searchInboxDeck(query)
    const seen = new Set<string>()
    const results: CommandResult[] = []
    for (const hit of hits) {
      const result = toPropertyResult(hit, context)
      if (!result || seen.has(result.id)) continue
      seen.add(result.id)
      results.push(withScoredResult(result, query, context))
    }
    return limitResults(results, 6)
  },
}
