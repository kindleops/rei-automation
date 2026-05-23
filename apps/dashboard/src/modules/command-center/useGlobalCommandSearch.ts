import { useEffect, useMemo, useState } from 'react'
import { appCommandProvider } from './providers/appCommandProvider'
import { buyerSearchProvider } from './providers/buyerSearchProvider'
import { filterCommandProvider } from './providers/filterCommandProvider'
import { mapCommandProvider } from './providers/mapCommandProvider'
import { marketSearchProvider } from './providers/marketSearchProvider'
import { propertySearchProvider } from './providers/propertySearchProvider'
import { queueSearchProvider } from './providers/queueSearchProvider'
import { sellerSearchProvider } from './providers/sellerSearchProvider'
import { locationCommandProvider, getRecentCommandLocations } from './providers/locationCommandProvider'
import type { CommandResult, CommandResultType, GlobalCommandProvider, GlobalCommandSearchContext } from './command.types'

const STATIC_PROVIDERS: GlobalCommandProvider[] = [
  appCommandProvider,
  filterCommandProvider,
  mapCommandProvider,
  marketSearchProvider,
]

const REMOTE_PROVIDERS: GlobalCommandProvider[] = [
  locationCommandProvider,
  propertySearchProvider,
  sellerSearchProvider,
  buyerSearchProvider,
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
  'pipeline',
  'queue',
  'comps',
  'underwrite',
  'map_action',
  'app',
  'filter',
  'system_action',
]

const GROUP_LABELS: Record<CommandResultType, string> = {
  recent: 'Recent Searches',
  location: 'Locations',
  property: 'Properties',
  seller: 'Sellers',
  conversation: 'Sellers',
  leads: 'Leads',
  buyer: 'Buyers',
  market: 'Markets',
  pipeline: 'Pipeline',
  queue: 'Queue',
  comps: 'Comparables',
  underwrite: 'Underwriting',
  map_action: 'Actions',
  app: 'Actions',
  filter: 'Actions',
  system_action: 'Actions',
}

const dedupeResults = (results: CommandResult[]): CommandResult[] => {
  const seen = new Map<string, CommandResult>()
  results.forEach((result) => {
    const existing = seen.get(result.id)
    if (!existing || existing.score < result.score) seen.set(result.id, result)
  })
  return Array.from(seen.values())
}

export const useGlobalCommandSearch = (query: string, context: GlobalCommandSearchContext) => {
  const [results, setResults] = useState<CommandResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    const normalizedQuery = query.trim()
    let staticSnapshot: CommandResult[] = []

    const immediateLoad = async () => {
      const staticResults = await Promise.all(STATIC_PROVIDERS.map((provider) => provider.search(normalizedQuery, context)))
      if (!active) return
      
      let mergedStatic = dedupeResults(staticResults.flat())
        .sort((left, right) => right.score - left.score)
        .slice(0, 20)

      if (normalizedQuery.length === 0) {
        const recents = getRecentCommandLocations().map((loc, i) => ({
          id: `recent-${loc.id}`,
          type: 'recent' as CommandResultType,
          title: loc.label,
          subtitle: `Recent Location`,
          icon: 'clock' as const,
          score: 100 - i,
          route: '/dashboard/live',
          action: {
            id: 'fly-to',
            kind: 'dispatch_event' as const,
            eventName: 'nexus:map-flyto',
          },
          payload: { location: loc },
          location: loc,
          meta: { groupLabel: 'Recent Searches' },
        }))
        mergedStatic = [...recents, ...mergedStatic]
      }

      staticSnapshot = mergedStatic
      setResults(mergedStatic)
      setLoading(normalizedQuery.length >= 2)
    }

    void immediateLoad()

    if (normalizedQuery.length < 2) {
      return () => {
        active = false
      }
    }

    const timer = window.setTimeout(async () => {
      const remoteResults = await Promise.all(REMOTE_PROVIDERS.map((provider) => provider.search(normalizedQuery, context)))
      if (!active) return
      const merged = dedupeResults([...staticSnapshot, ...remoteResults.flat()])
        .sort((left, right) => right.score - left.score)
        .slice(0, 36)
      setResults(merged)
      setLoading(false)
    }, 150)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [context, query])

  const groupedResults = useMemo(() => {
    const groups = GROUP_ORDER.map((type) => ({
      key: type,
      label: GROUP_LABELS[type],
      items: results.filter((result) => result.type === type).slice(0, 8),
    })).filter((group) => group.items.length > 0)

    const bestMatches = results.slice(0, 6)
    return { bestMatches, groups }
  }, [results])

  return {
    results,
    loading,
    groupedResults,
  }
}
