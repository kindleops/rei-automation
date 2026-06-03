import {
  dataLayerNow,
  logCacheCommitDone,
  type DashboardConnectionState,
} from './dashboardDataLayer'
import {
  asNumber,
  asString,
  getFirst,
  safeArray,
  type AnyRecord,
} from './shared'

export interface DashboardEntityState {
  threadsById: Record<string, AnyRecord>
  messagesByThreadId: Record<string, AnyRecord[]>
  prospectsById: Record<string, AnyRecord>
  propertiesById: Record<string, AnyRecord>
  ownersById: Record<string, AnyRecord>
  phonesById: Record<string, AnyRecord>
  dealIntelByPropertyId: Record<string, AnyRecord>
  pipelineById: Record<string, AnyRecord>
  connectionState: DashboardConnectionState
  lastCommitAt: string | null
  version: number
}

type DashboardEntityListener = (state: DashboardEntityState) => void

const cloneState = (state: DashboardEntityState): DashboardEntityState => ({
  threadsById: { ...state.threadsById },
  messagesByThreadId: { ...state.messagesByThreadId },
  prospectsById: { ...state.prospectsById },
  propertiesById: { ...state.propertiesById },
  ownersById: { ...state.ownersById },
  phonesById: { ...state.phonesById },
  dealIntelByPropertyId: { ...state.dealIntelByPropertyId },
  pipelineById: { ...state.pipelineById },
  connectionState: state.connectionState,
  lastCommitAt: state.lastCommitAt,
  version: state.version,
})

const initialState: DashboardEntityState = {
  threadsById: {},
  messagesByThreadId: {},
  prospectsById: {},
  propertiesById: {},
  ownersById: {},
  phonesById: {},
  dealIntelByPropertyId: {},
  pipelineById: {},
  connectionState: 'reconnecting',
  lastCommitAt: null,
  version: 0,
}

let state: DashboardEntityState = cloneState(initialState)
const listeners = new Set<DashboardEntityListener>()

const emit = (): void => {
  for (const listener of listeners) listener(state)
}

const bumpState = (next: DashboardEntityState): void => {
  state = {
    ...next,
    version: state.version + 1,
    lastCommitAt: new Date().toISOString(),
  }
  emit()
}

const asRecord = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : {}

const firstEntityId = (row: AnyRecord, keys: string[]): string =>
  asString(getFirst(row, keys), '').trim()

const nestedOrEmpty = (row: AnyRecord, key: string): AnyRecord => asRecord(row[key])

const normalizeThreadEntity = (row: AnyRecord): AnyRecord | null => {
  const entity = nestedOrEmpty(row, 'thread_entity')
  const id = firstEntityId(row, ['conversationThreadId', 'conversation_thread_id']) ||
    firstEntityId(entity, ['conversationThreadId', 'conversation_thread_id']) ||
    firstEntityId(entity, ['id', 'threadKey', 'thread_key']) ||
    firstEntityId(row, ['id', 'threadKey', 'thread_key', 'thread_id', 'leadId', 'lead_id'])
  if (!id) return null
  const threadKey = firstEntityId(row, ['threadKey', 'thread_key', 'legacyThreadKey', 'legacy_thread_key']) ||
    firstEntityId(entity, ['threadKey', 'thread_key']) ||
    firstEntityId(row, ['threadKey', 'thread_key']) ||
    id
  return {
    ...row,
    ...entity,
    id,
    conversationThreadId: id,
    conversation_thread_id: id,
    threadKey,
    thread_key: threadKey,
  }
}

const normalizePropertyEntity = (row: AnyRecord): AnyRecord | null => {
  const entity = {
    ...nestedOrEmpty(row, 'property_data'),
    ...nestedOrEmpty(row, 'property_entity'),
  }
  const id = firstEntityId(entity, ['id', 'propertyId', 'property_id']) ||
    firstEntityId(row, ['propertyId', 'property_id'])
  if (!id) return null
  return {
    ...entity,
    id,
    propertyId: id,
    property_id: id,
    latitude: asNumber(entity.latitude ?? row.latitude, undefined),
    longitude: asNumber(entity.longitude ?? row.longitude, undefined),
  }
}

const normalizeOwnerEntity = (row: AnyRecord): AnyRecord | null => {
  const entity = {
    ...nestedOrEmpty(row, 'master_owner_data'),
    ...nestedOrEmpty(row, 'owner_entity'),
  }
  const id = firstEntityId(entity, ['id', 'masterOwnerId', 'master_owner_id', 'ownerId', 'owner_id']) ||
    firstEntityId(row, ['ownerId', 'owner_id', 'masterOwnerId', 'master_owner_id'])
  if (!id) return null
  return {
    ...entity,
    id,
    ownerId: id,
    owner_id: id,
    master_owner_id: id,
  }
}

const normalizeProspectEntity = (row: AnyRecord): AnyRecord | null => {
  const entity = {
    ...nestedOrEmpty(row, 'prospect_data'),
    ...nestedOrEmpty(row, 'prospect_entity'),
  }
  const id = firstEntityId(entity, ['id', 'prospectId', 'prospect_id', 'canonicalProspectId', 'canonical_prospect_id']) ||
    firstEntityId(row, ['prospectId', 'prospect_id', 'canonicalProspectId', 'canonical_prospect_id'])
  if (!id) return null
  return {
    ...entity,
    id,
    prospectId: id,
    prospect_id: id,
  }
}

const normalizePhoneEntity = (row: AnyRecord): AnyRecord | null => {
  const entity = {
    ...nestedOrEmpty(row, 'phone_data'),
    ...nestedOrEmpty(row, 'phone_entity'),
  }
  const id = firstEntityId(entity, ['id', 'phoneId', 'phone_id', 'phoneNumberId', 'phone_number_id']) ||
    firstEntityId(row, ['phoneNumberId', 'phone_number_id', 'canonicalE164', 'canonical_e164', 'phoneNumber', 'phone_number'])
  if (!id) return null
  return {
    ...entity,
    id,
    phoneId: id,
    phone_id: id,
  }
}

const normalizeDealIntelEntity = (row: AnyRecord): { propertyId: string; entity: AnyRecord } | null => {
  const entity = {
    ...nestedOrEmpty(row, 'deal_context'),
    ...nestedOrEmpty(row, 'deal_intel_entity'),
  }
  const propertyId = firstEntityId(entity, ['propertyId', 'property_id']) ||
    firstEntityId(row, ['propertyId', 'property_id'])
  const id = firstEntityId(entity, ['id', 'dealContextId', 'deal_context_id']) ||
    firstEntityId(row, ['deal_context_id', 'id']) ||
    propertyId
  if (!propertyId || !id) return null
  return {
    propertyId,
    entity: {
      ...row,
      ...entity,
      id,
      propertyId,
      property_id: propertyId,
    },
  }
}

const commitRowEntities = (next: DashboardEntityState, row: AnyRecord): {
  threadCommitted: boolean
  propertyCommitted: boolean
  ownerCommitted: boolean
  prospectCommitted: boolean
  phoneCommitted: boolean
  dealIntelCommitted: boolean
} => {
  const thread = normalizeThreadEntity(row)
  const property = normalizePropertyEntity(row)
  const owner = normalizeOwnerEntity(row)
  const prospect = normalizeProspectEntity(row)
  const phone = normalizePhoneEntity(row)
  const dealIntel = normalizeDealIntelEntity(row)

  if (thread) next.threadsById[asString(thread.id)] = { ...(next.threadsById[asString(thread.id)] ?? {}), ...thread }
  if (property) next.propertiesById[asString(property.id)] = { ...(next.propertiesById[asString(property.id)] ?? {}), ...property }
  if (owner) next.ownersById[asString(owner.id)] = { ...(next.ownersById[asString(owner.id)] ?? {}), ...owner }
  if (prospect) next.prospectsById[asString(prospect.id)] = { ...(next.prospectsById[asString(prospect.id)] ?? {}), ...prospect }
  if (phone) next.phonesById[asString(phone.id)] = { ...(next.phonesById[asString(phone.id)] ?? {}), ...phone }
  if (dealIntel) next.dealIntelByPropertyId[dealIntel.propertyId] = {
    ...(next.dealIntelByPropertyId[dealIntel.propertyId] ?? {}),
    ...dealIntel.entity,
  }

  return {
    threadCommitted: Boolean(thread),
    propertyCommitted: Boolean(property),
    ownerCommitted: Boolean(owner),
    prospectCommitted: Boolean(prospect),
    phoneCommitted: Boolean(phone),
    dealIntelCommitted: Boolean(dealIntel),
  }
}

const normalizeMessageEntity = (message: unknown): AnyRecord => {
  const row = asRecord(message)
  const entity = nestedOrEmpty(row, 'message_entity')
  const id = firstEntityId(entity, ['id', 'messageId', 'message_id', 'message_event_key']) ||
    firstEntityId(row, ['id', 'messageId', 'message_id', 'message_event_key'])
  return {
    ...row,
    ...entity,
    id: id || `${asString(row.threadKey ?? row.thread_key, 'thread')}:${asString(row.createdAt ?? row.created_at, String(dataLayerNow()))}`,
  }
}

const mergeMessages = (current: AnyRecord[], incoming: AnyRecord[]): AnyRecord[] => {
  const byId = new Map<string, AnyRecord>()
  for (const message of [...current, ...incoming]) {
    const id = asString(message.id, '')
    if (!id) continue
    byId.set(id, { ...(byId.get(id) ?? {}), ...message })
  }
  return [...byId.values()].sort((left, right) => {
    const leftTime = new Date(asString(left.createdAt ?? left.created_at ?? left.timelineAt ?? left.timeline_at, '')).getTime()
    const rightTime = new Date(asString(right.createdAt ?? right.created_at ?? right.timelineAt ?? right.timeline_at, '')).getTime()
    return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0)
  })
}

export const getDashboardEntitySnapshot = (): DashboardEntityState => cloneState(state)

export const subscribeDashboardEntityStore = (listener: DashboardEntityListener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const commitDashboardThreads = (
  rows: unknown[],
  meta: AnyRecord = {},
): number => {
  const startedAt = dataLayerNow()
  const next = cloneState(state)
  const summary = {
    threads: 0,
    properties: 0,
    owners: 0,
    prospects: 0,
    phones: 0,
    dealIntel: 0,
  }

  for (const row of safeArray(rows as AnyRecord[])) {
    const committed = commitRowEntities(next, asRecord(row))
    if (committed.threadCommitted) summary.threads += 1
    if (committed.propertyCommitted) summary.properties += 1
    if (committed.ownerCommitted) summary.owners += 1
    if (committed.prospectCommitted) summary.prospects += 1
    if (committed.phoneCommitted) summary.phones += 1
    if (committed.dealIntelCommitted) summary.dealIntel += 1
  }

  bumpState(next)
  logCacheCommitDone('dashboard_threads', startedAt, {
    rows: rows.length,
    ...summary,
    ...meta,
  })
  return summary.threads
}

export const commitDashboardMessages = (
  threadId: string,
  messages: unknown[],
  meta: AnyRecord = {},
): number => {
  const normalizedThreadId = asString(threadId, '').trim()
  if (!normalizedThreadId) return 0

  const startedAt = dataLayerNow()
  const next = cloneState(state)
  const incoming = safeArray(messages as AnyRecord[]).map(normalizeMessageEntity)
  next.messagesByThreadId[normalizedThreadId] = meta.replace === true
    ? mergeMessages([], incoming)
    : mergeMessages(
      next.messagesByThreadId[normalizedThreadId] ?? [],
      incoming,
    )
  bumpState(next)
  logCacheCommitDone('dashboard_messages', startedAt, {
    threadId: normalizedThreadId,
    incoming: incoming.length,
    total: next.messagesByThreadId[normalizedThreadId].length,
    ...meta,
  })
  return next.messagesByThreadId[normalizedThreadId].length
}

export const commitDashboardDealIntel = (
  rows: unknown[],
  meta: AnyRecord = {},
): number => {
  const startedAt = dataLayerNow()
  const next = cloneState(state)
  let committed = 0
  for (const row of safeArray(rows as AnyRecord[])) {
    const dealIntel = normalizeDealIntelEntity(asRecord(row))
    if (!dealIntel) continue
    next.dealIntelByPropertyId[dealIntel.propertyId] = {
      ...(next.dealIntelByPropertyId[dealIntel.propertyId] ?? {}),
      ...dealIntel.entity,
    }
    committed += 1
  }
  bumpState(next)
  logCacheCommitDone('dashboard_deal_intelligence', startedAt, {
    rows: rows.length,
    committed,
    ...meta,
  })
  return committed
}

export const commitDashboardPipeline = (
  rows: unknown[],
  meta: AnyRecord = {},
): number => {
  const startedAt = dataLayerNow()
  const next = cloneState(state)
  let committed = 0
  for (const row of safeArray(rows as AnyRecord[])) {
    const record = asRecord(row)
    const id = firstEntityId(record, ['id', 'pipelineId', 'pipeline_id', 'propertyId', 'property_id'])
    if (!id) continue
    next.pipelineById[id] = { ...(next.pipelineById[id] ?? {}), ...record, id }
    committed += 1
  }
  bumpState(next)
  logCacheCommitDone('dashboard_pipeline', startedAt, {
    rows: rows.length,
    committed,
    ...meta,
  })
  return committed
}

export const patchDashboardThread = (
  threadId: string,
  patch: AnyRecord,
  meta: AnyRecord = {},
): boolean => {
  const normalizedThreadId = asString(threadId, '').trim()
  if (!normalizedThreadId) return false

  const startedAt = dataLayerNow()
  const next = cloneState(state)
  next.threadsById[normalizedThreadId] = {
    ...(next.threadsById[normalizedThreadId] ?? { id: normalizedThreadId, threadKey: normalizedThreadId }),
    ...patch,
  }
  bumpState(next)
  logCacheCommitDone('dashboard_thread_patch', startedAt, {
    threadId: normalizedThreadId,
    patchKeys: Object.keys(patch),
    ...meta,
  })
  return true
}

export const setDashboardConnectionState = (
  connectionState: DashboardConnectionState,
  meta: AnyRecord = {},
): void => {
  if (state.connectionState === connectionState) return
  const startedAt = dataLayerNow()
  bumpState({
    ...cloneState(state),
    connectionState,
  })
  logCacheCommitDone('dashboard_connection_state', startedAt, {
    connectionState,
    ...meta,
  })
}
