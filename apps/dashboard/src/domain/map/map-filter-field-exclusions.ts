/** Location filters excluded from map advanced filters — geography is handled by the map itself. */
export const MAP_LOCATION_FILTER_KEYS = new Set([
  'addressSearch',
  'city',
  'state',
  'zip',
  'county',
  'market',
  'marketRegion',
  'ownerMailingSearch',
])

export function isMapLocationFilterKey(key: string): boolean {
  return MAP_LOCATION_FILTER_KEYS.has(key)
}

export function stripMapLocationFilters<T extends Record<string, unknown>>(filters: T): T {
  const next = { ...filters }
  for (const key of MAP_LOCATION_FILTER_KEYS) {
    delete next[key]
  }
  return next
}