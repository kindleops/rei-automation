import { useEffect, useMemo, useState } from 'react'
import { buyerSearchProvider } from './providers/buyerSearchProvider'
import { marketSearchProvider } from './providers/marketSearchProvider'
import { propertySearchProvider } from './providers/propertySearchProvider'
import { queueSearchProvider } from './providers/queueSearchProvider'
import { sellerSearchProvider } from './providers/sellerSearchProvider'
import { locationCommandProvider, getRecentCommandLocations } from './providers/locationCommandProvider'
import type { CommandResult, CommandResultType, GlobalCommandProvider, GlobalCommandSearchContext } from './command.types'

const DATA_PROVIDERS: GlobalCommandProvider[] = [
  locationCommandProvider,
  propertySearchProvider,
  sellerSearchProvider,
  buyerSearchProvider,
  marketSearchProvider,
  queueSearchProvider,
]

const GROUP_ORDER: CommandResultType[] = [
  'recent',
  'location',
  'property',
  'seller',
  'conversation',
  'leads',
  'buyer',
  'market',
  'queue',
  'comps',
  'underwrite',
]

const GROUP_LABELS: Partial<Record<CommandResultType, string>> = {
  recent: 'Recent Searches',
  location: 'Locations',
  property: 'Properties',
  seller: 'Sellers',
  conversation: 'Conversations',
  leads: 'Leads',
  buyer: 'Buyers',
  market: 'Markets',
  queue: 'Queue',
  comps: 'Comparables',
  underwrite: 'Underwriting',
}

const dedupeResults = (results: CommandResult[]): CommandResult[] => {
  const seen = new Map<string, CommandResult>()
  results.forEach((result) => {
    const existing = seen.get(result.id)
    if (!existing || existing.score < result.score) seen.set(result.id, result)
  })
  return Array.from(seen.values())
}

export const useInboxTopSearch = (query: string, context: GlobalCommandSearchContext) => {
  const [results, setResults] = useState<CommandResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    const normalizedQuery = query.trim()

    if (normalizedQuery.length === 0) {
      const recents = getRecentCommandLocations().map((loc, i) => ({
        id: `recent-${loc.id}`,
        type: 'recent' as CommandResultType,
        title: loc.label,
        subtitle: `Recent Location`,
        icon: 'clock' as const,
        score: 100 - i,
        route: '/map',
        action: {
          id: 'fly-to',
          kind: 'dispatch_event' as const,
          eventName: 'nexus:map-flyto',
        },
        payload: { location: loc },
        location: loc,
        meta: { groupLabel: 'Recent Searches' },
      }))
      setResults(recents)
      setLoading(false)
      return () => {
        active = false
      }
    }

    if (normalizedQuery.length < 2) {
      setResults([])
      setLoading(false)
      return () => {
        active = false
      }
    }

    setLoading(true)
    const timer = window.setTimeout(async () => {
      const providerResults = await Promise.all(DATA_PROVIDERS.map((provider) => provider.search(normalizedQuery, context)))
      if (!active) return
      const merged = dedupeResults(providerResults.flat())
        .sort((left, right) => right.score - left.score)
        .slice(0, 18)
      setResults(merged)
      setLoading(false)
    }, 140)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [context, query])

  const groupedResults = useMemo(() => (
    GROUP_ORDER.map((type) => ({
      key: type,
      label: GROUP_LABELS[type] ?? type,
      items: results.filter((result) => result.type === type).slice(0, 5),
    })).filter((group) => group.items.length > 0)
  ), [results])

  return {
    results,
    loading,
    groupedResults,
  }
}
