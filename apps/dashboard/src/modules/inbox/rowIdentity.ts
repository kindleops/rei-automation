const DEV = Boolean(import.meta.env?.DEV)
const INBOX_ROW_IDENTITY_DEBUG = DEV && String(import.meta.env?.VITE_INBOX_DEBUG ?? 'false').toLowerCase() === 'true'

const readString = (record: Record<string, unknown> | null | undefined, keys: readonly string[]): string => {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const trimmed = String(value).trim()
    if (trimmed) return trimmed
  }
  return ''
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
)

export type InboxRowLike = object | null | undefined

const normalizeSegment = (value: unknown, fallback: string): string => {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/:/g, '_')
    .replace(/[^\w+\-. ]+/g, '')
    .trim()
    .replace(/\s/g, '_')
    || fallback
}

const hashString = (value: string): string => {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return Math.abs(hash >>> 0).toString(36)
}

const getInboxExplicitRowKey = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'rowKey',
  'row_key',
])

const isCanonicalInboxRowKey = (value: string): boolean =>
  value.startsWith('row:') && value.split(':').length >= 5

export const getInboxThreadKey = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'conversationThreadId',
  'conversation_thread_id',
  'threadKey',
  'thread_key',
])

export const getInboxCanonicalE164 = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'canonicalE164',
  'canonical_e164',
  'phoneNumber',
  'phone_number',
  'sellerPhone',
  'seller_phone',
  'best_phone',
  'display_phone',
  'phone',
])

export const getInboxLatestMessageEventId = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'latestMessageId',
  'latest_message_id',
  'latestMessageEventId',
  'latest_message_event_id',
  'messageEventId',
  'message_event_id',
])

export const getInboxQueueRowId = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'queueRowId',
  'queue_row_id',
  'queueId',
  'queue_id',
])

export const getInboxPropertyId = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'propertyId',
  'property_id',
])

export const getInboxPropertyAddress = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'propertyAddressFull',
  'property_address_full',
  'propertyAddress',
  'property_address',
  'address',
  'subject',
])

export const getInboxProspectId = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'prospectId',
  'prospect_id',
])

export const getInboxOwnerIdentity = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'masterOwnerId',
  'master_owner_id',
  'prospectId',
  'prospect_id',
  'ownerId',
  'owner_id',
])

export const getInboxLatestMessageIdentity = (thread: InboxRowLike): string => readString(recordOf(thread), [
  'latestMessageId',
  'latest_message_id',
  'latestMessageEventId',
  'latest_message_event_id',
  'messageEventId',
  'message_event_id',
  'latestMessageAt',
  'latest_message_at',
  'latestActivityAt',
  'latest_activity_at',
  'lastMessageAt',
  'last_message_at',
  'lastMessageIso',
  'updatedAt',
  'updated_at',
])

export const buildInboxRowKey = (thread: InboxRowLike, index?: number): string => {
  const record = recordOf(thread)
  const threadOrPhone = getInboxThreadKey(record) || getInboxCanonicalE164(record) || 'no_thread'

  const propertyId = getInboxPropertyId(record)
  const propertyAddress = getInboxPropertyAddress(record)
  const propertyIdentity = propertyId
    || (propertyAddress ? `addr_${hashString(normalizeSegment(propertyAddress, 'property_address'))}` : '')
    || 'no_property'

  const ownerIdentity = getInboxOwnerIdentity(record) || 'no_owner'
  const latestIdentity = getInboxLatestMessageIdentity(record) || (Number.isInteger(index) ? String(index) : 'no_row')

  return [
    'row',
    normalizeSegment(threadOrPhone, 'no_thread'),
    normalizeSegment(propertyIdentity, 'no_property'),
    normalizeSegment(ownerIdentity, 'no_owner'),
    normalizeSegment(latestIdentity, 'no_row'),
  ].join(':')
}

export const getInboxRowKey = (thread: InboxRowLike, index?: number): string => (
  ((explicitRowKey) => isCanonicalInboxRowKey(explicitRowKey) ? explicitRowKey : buildInboxRowKey(thread, index))(getInboxExplicitRowKey(thread))
)

export const findInboxRowKeyDuplicates = (threads: readonly InboxRowLike[]) => {
  const byKey = new Map<string, Array<{ index: number; identity: ReturnType<typeof buildInboxRowIdentityDebug> }>>()
  threads.forEach((thread, index) => {
    const key = getInboxRowKey(thread, index)
    const entries = byKey.get(key) ?? []
    entries.push({ index, identity: buildInboxRowIdentityDebug(thread, null, null, index) })
    byKey.set(key, entries)
  })

  return Array.from(byKey.entries())
    .filter(([, entries]) => entries.length > 1)
    .map(([rowKey, entries]) => ({ rowKey, entries }))
}

const loggedDuplicateSets = new Set<string>()

export const logInboxRowIdentityBatch = (
  threads: readonly InboxRowLike[],
  selectedRowKey: string | null | undefined,
  selectedThreadKey: string | null | undefined,
  label = 'INBOX_ROW_IDENTITY',
) => {
  if (!INBOX_ROW_IDENTITY_DEBUG || threads.length === 0) return

  const first = buildInboxRowIdentityDebug(threads[0], selectedRowKey, selectedThreadKey, 0)
  const duplicates = findInboxRowKeyDuplicates(threads)
  console.log(`[${label}]`, {
    count: threads.length,
    first,
    selectedRowKey: selectedRowKey || null,
    selectedThreadKey: selectedThreadKey || null,
    duplicateKeyCount: duplicates.length,
  })

  if (duplicates.length === 0) return

  const signature = duplicates
    .map((duplicate) => `${duplicate.rowKey}:${duplicate.entries.map((entry) => entry.index).join(',')}`)
    .join('|')
  if (loggedDuplicateSets.has(signature)) return
  loggedDuplicateSets.add(signature)

  console.warn('[INBOX_ROW_KEY_DUPLICATES]', {
    duplicateKeyCount: duplicates.length,
    duplicates,
  })
}

export const isInboxRowSelected = (
  thread: InboxRowLike,
  selectedRowKey: string | null | undefined,
  selectedThreadKey: string | null | undefined,
  index?: number,
): boolean => {
  const rowKey = getInboxRowKey(thread, index)
  if (selectedRowKey) return rowKey === selectedRowKey

  const threadKey = getInboxThreadKey(thread)
  return Boolean(threadKey && selectedThreadKey && threadKey === selectedThreadKey)
}

export const buildInboxRowIdentityDebug = (
  thread: InboxRowLike,
  selectedRowKey: string | null | undefined,
  selectedThreadKey: string | null | undefined,
  index?: number,
) => ({
  rowKey: getInboxRowKey(thread, index),
  builtRowKey: buildInboxRowKey(thread, index),
  threadKey: getInboxThreadKey(thread) || null,
  propertyId: getInboxPropertyId(thread) || null,
  propertyAddress: getInboxPropertyAddress(thread) || null,
  ownerIdentity: getInboxOwnerIdentity(thread) || null,
  prospectId: getInboxProspectId(thread) || null,
  latestMessageEventId: getInboxLatestMessageEventId(thread) || null,
  latestMessageIdentity: getInboxLatestMessageIdentity(thread) || null,
  queueRowId: getInboxQueueRowId(thread) || null,
  isSelected: isInboxRowSelected(thread, selectedRowKey, selectedThreadKey, index),
})
