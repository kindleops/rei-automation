import type { CommandResult, GlobalCommandProvider, GlobalCommandSearchContext, LocationResult } from '../command.types'

const LOCAL_STORAGE_KEY = 'leadcommand.commandBar.recentLocations'

// In-memory cache for geocoding results
const geocodeCache = new Map<string, LocationResult[]>()

// Local storage for recent locations
const getRecentLocations = (): LocationResult[] => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!data) return []
    return JSON.parse(data) as LocationResult[]
  } catch (err) {
    return []
  }
}

const saveRecentLocation = (location: LocationResult) => {
  try {
    const recent = getRecentLocations()
    const filtered = recent.filter((l) => l.id !== location.id)
    filtered.unshift(location)
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(filtered.slice(0, 10)))
  } catch (err) {
    // ignore
  }
}

// Ensure the recent save is exposed globally or we save it on execution
// We'll listen for the action if needed, or we can just save it when it is returned? 
// The instruction says: "Keep last 10. Show them when command bar is focused and query is empty."
// Since `useGlobalCommandSearch` requires query length >= 2 to trigger remote providers, how do we show them when query is empty?
// Let's modify `useGlobalCommandSearch.ts` to show recent locations if query is empty.

const getMapboxToken = () => {
  return import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
}

const geocodeLocation = async (query: string): Promise<LocationResult[]> => {
  const token = getMapboxToken()
  if (!token) {
    return [
      {
        id: 'stub-1',
        label: `Mock Location for: ${query}`,
        query,
        latitude: 32.7767,
        longitude: -96.7970, // Dallas default
        city: 'Dallas',
        state: 'TX',
        placeType: 'unknown',
        source: 'stub',
      },
    ]
  }

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&country=us&limit=3`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return data.features.map((f: any) => ({
      id: f.id,
      label: f.place_name,
      query,
      latitude: f.center[1],
      longitude: f.center[0],
      placeType: f.place_type[0] || 'unknown',
      source: 'mapbox',
    }))
  } catch (err) {
    console.error('Geocoding failed', err)
    return []
  }
}

const isZip = (q: string) => /^[0-9]{5}$/.test(q)
const isAddressLike = (q: string) => /\d+.*[a-zA-Z]/.test(q) && q.includes(' ')

const parseCommandIntent = (query: string) => {
  const lower = query.toLowerCase()
  if (lower.startsWith('map ') || lower.startsWith('go to ') || lower.startsWith('open ')) return 'map'
  if (lower.startsWith('leads near ') || lower.startsWith('show ') && lower.includes(' leads')) return 'leads'
  if (lower.startsWith('buyers near ')) return 'buyers'
  if (lower.startsWith('comps ')) return 'comps'
  if (lower.startsWith('underwrite ')) return 'underwrite'
  return null
}

const cleanQueryForGeocoding = (query: string, intent: string | null) => {
  let cleaned = query
  if (intent === 'map') cleaned = cleaned.replace(/^(map|go to|open)\s+/i, '')
  if (intent === 'leads') cleaned = cleaned.replace(/^(leads near|show)\s+/i, '').replace(/\s+leads$/i, '')
  if (intent === 'buyers') cleaned = cleaned.replace(/^buyers near\s+/i, '')
  if (intent === 'comps') cleaned = cleaned.replace(/^comps\s+/i, '')
  if (intent === 'underwrite') cleaned = cleaned.replace(/^underwrite\s+/i, '')
  return cleaned.trim()
}

export const locationCommandProvider: GlobalCommandProvider = {
  id: 'location-provider',
  search: async (rawQuery: string, context: GlobalCommandSearchContext): Promise<CommandResult[]> => {
    // If empty query, return recent locations
    // But this provider is only called if query >= 2 chars, so we need to handle recent searches differently, or update useGlobalCommandSearch.
    
    const intent = parseCommandIntent(rawQuery)
    const query = cleanQueryForGeocoding(rawQuery, intent)

    if (query.length < 3) return []

    let locations = geocodeCache.get(query)
    if (!locations) {
      locations = await geocodeLocation(query)
      geocodeCache.set(query, locations)
    }

    if (locations.length === 0) {
      return []
    }

    const results: CommandResult[] = []

    // For each location, generate commands based on intent or default
    locations.forEach((loc, index) => {
      const isTop = index === 0

      if (!intent || intent === 'map') {
        results.push({
          id: `loc-map-${loc.id}`,
          type: 'location',
          title: `Open map at ${loc.label}`,
          subtitle: `Navigate to ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`,
          icon: 'map-pin',
          score: isTop ? 100 : 80 - index,
          route: '/dashboard/live',
          action: {
            id: 'fly-to',
            kind: 'dispatch_event',
            eventName: 'nexus:map-flyto',
          },
          payload: { location: loc },
          location: loc,
          meta: { groupLabel: 'Locations' },
          preview: {
            eyebrow: 'Location',
            title: loc.label,
            summary: `Fly to this location on the map. Source: ${loc.source}`,
          }
        })
      }

      if (!intent || intent === 'leads') {
        results.push({
          id: `loc-leads-${loc.id}`,
          type: 'leads',
          title: `Show nearby leads in ${loc.city || loc.zip || loc.label}`,
          subtitle: 'Search inbox for nearby properties',
          icon: 'users',
          score: isTop ? 95 : 75 - index,
          action: {
            id: 'search-leads',
            kind: 'dispatch_event',
            eventName: 'nexus:command-action', // Stub event
          },
          payload: { action: 'search-leads', location: loc },
          location: loc,
          meta: { groupLabel: 'Leads' }
        })
      }

      if (!intent || intent === 'buyers') {
        results.push({
          id: `loc-buyers-${loc.id}`,
          type: 'buyers',
          title: `Show buyers near ${loc.city || loc.zip || loc.label}`,
          subtitle: 'Find disposition matches',
          icon: 'user-check',
          score: isTop ? 90 : 70 - index,
          action: {
            id: 'search-buyers',
            kind: 'dispatch_event',
            eventName: 'nexus:command-action', // Stub event
          },
          payload: { action: 'search-buyers', location: loc },
          location: loc,
          meta: { groupLabel: 'Buyers' }
        })
      }

      if (isAddressLike(query) && (!intent || intent === 'comps' || intent === 'underwrite')) {
        results.push({
          id: `loc-comps-${loc.id}`,
          type: 'comps',
          title: `Run comp snapshot for ${loc.label}`,
          subtitle: 'Underwrite nearby recent sales',
          icon: 'bar-chart-2',
          score: isTop ? 98 : 78 - index,
          action: {
            id: 'run-comps',
            kind: 'dispatch_event',
            eventName: 'nexus:command-action', // Stub event
          },
          payload: { action: 'run-comps', location: loc },
          location: loc,
          meta: { groupLabel: 'Comparables' }
        })
      }
    })

    return results
  }
}

export const saveRecentCommandLocation = (location: LocationResult) => {
  saveRecentLocation(location)
}

export const getRecentCommandLocations = () => {
  return getRecentLocations()
}
