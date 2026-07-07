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

/** Inbox/conversation filters excluded — map filters operate on the property universe, not inbox threads. */
export const MAP_CONVERSATION_FILTER_GROUP = 'conversation'

export const MAP_CONVERSATION_FILTER_KEYS = new Set([
  'inboxCategory',
  'stage',
  'status',
  'intent',
  'leadTemperature',
  'isRead',
  'isStarred',
  'isPinned',
  'isArchived',
  'isSuppressed',
  'direction',
  'deliveryStatus',
  'automationStatus',
  'messageCountMin',
  'messageCountMax',
  'inboundCountMin',
  'inboundCountMax',
  'outboundCountMin',
  'outboundCountMax',
  'activityDateFrom',
  'activityDateTo',
  'lastInboundDateFrom',
  'lastInboundDateTo',
  'lastOutboundDateFrom',
  'lastOutboundDateTo',
  'followUpAtFrom',
  'followUpAtTo',
  'hasSellerReply',
])

const MAP_EXCLUDED_FILTER_KEYS = new Set([
  ...MAP_LOCATION_FILTER_KEYS,
  ...MAP_CONVERSATION_FILTER_KEYS,
])

export function isMapLocationFilterKey(key: string): boolean {
  return MAP_LOCATION_FILTER_KEYS.has(key)
}

export function isMapConversationFilterKey(key: string): boolean {
  return MAP_CONVERSATION_FILTER_KEYS.has(key)
}

export function isMapExcludedFilterKey(key: string): boolean {
  return MAP_EXCLUDED_FILTER_KEYS.has(key)
}

export function isMapExcludedFilterGroup(groupId: string): boolean {
  return groupId === MAP_CONVERSATION_FILTER_GROUP
}

export function stripMapExcludedFilters<T extends Record<string, unknown>>(filters: T): T {
  const next = { ...filters }
  for (const key of MAP_EXCLUDED_FILTER_KEYS) {
    delete next[key]
  }
  return next
}

/** @deprecated Use stripMapExcludedFilters */
export function stripMapLocationFilters<T extends Record<string, unknown>>(filters: T): T {
  return stripMapExcludedFilters(filters)
}