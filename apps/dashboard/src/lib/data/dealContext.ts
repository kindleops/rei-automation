import {
  fetchDealContextByProperty,
  fetchDealContextByThread,
  fetchDealContextCounts as fetchDealContextCountsFromBackend,
  fetchDealContextList,
} from '../api/backendClient'
import { asBoolean, asNumber, asString, safeArray, type AnyRecord } from './shared'

export interface DealContext {
  id: string
  contextType: string
  propertyId: string | null
  masterOwnerId: string | null
  prospectId: string | null
  canonicalProspectId: string | null
  phoneId: string | null
  emailId: string | null
  threadKey: string | null
  canonicalE164: string | null
  campaignId: string | null
  campaignTargetId: string | null
  queueRowId: string | null

  property: AnyRecord
  masterOwner: AnyRecord
  prospect: AnyRecord
  phone: AnyRecord
  email: AnyRecord
  threadState: AnyRecord
  campaign: AnyRecord
  queue: AnyRecord
  suppression: AnyRecord
  valuation: AnyRecord
  buyerMatch: AnyRecord

  ownerName: string
  propertyAddress: string
  market: string
  phoneDisplay: string
  latestMessageBody: string
  latestMessageDirection: string
  status: string
  stage: string
  bucket: string

  raw: AnyRecord
}

export interface DealContextListResult {
  rows: DealContext[]
  total: number
  pagination: {
    offset: number
    limit: number
    total: number
    has_more: boolean
    next_offset: number | null
  }
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : {}
}

function buildQueryString(params: Record<string, unknown> = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    const normalized = typeof value === 'boolean' ? String(value) : String(value).trim()
    if (!normalized) continue
    query.set(key, normalized)
  }
  return query.toString()
}

export function normalizeDealContext(row: AnyRecord): DealContext {
  const property = asRecord(row.property_data)
  const masterOwner = asRecord(row.master_owner_data)
  const prospect = asRecord(row.prospect_data)
  const phone = asRecord(row.phone_data)
  const email = asRecord(row.email_data)
  const threadState = asRecord(row.thread_state_data)
  const campaign = asRecord(row.campaign_data)
  const queue = asRecord(row.queue_data)
  const suppression = asRecord(row.suppression_data)
  const valuation = asRecord(row.valuation_data)
  const buyerMatch = asRecord(row.buyer_match_data)

  return {
    id: asString(row.deal_context_id),
    contextType: asString(row.context_type, 'property'),
    propertyId: asString(row.property_id) || null,
    masterOwnerId: asString(row.master_owner_id) || null,
    prospectId: asString(row.prospect_id) || null,
    canonicalProspectId: asString(row.canonical_prospect_id) || null,
    phoneId: asString(row.phone_id) || null,
    emailId: asString(row.email_id) || null,
    threadKey: asString(row.thread_key) || null,
    canonicalE164: asString(row.canonical_e164) || null,
    campaignId: asString(row.campaign_id) || null,
    campaignTargetId: asString(row.campaign_target_id) || null,
    queueRowId: asString(row.queue_row_id) || null,

    property,
    masterOwner,
    prospect,
    phone,
    email,
    threadState,
    campaign,
    queue,
    suppression,
    valuation,
    buyerMatch,

    ownerName: asString(row.owner_name),
    propertyAddress: asString(row.property_address_full),
    market: asString(row.market),
    phoneDisplay: asString(row.canonical_e164 || phone.phone || phone.canonical_e164),
    latestMessageBody: asString(row.latest_message_body),
    latestMessageDirection: asString(row.latest_message_direction),
    status: asString(row.universal_status),
    stage: asString(row.universal_stage),
    bucket: asString(row.inbox_bucket),

    raw: row,
  }
}

export async function getDealContextList(
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<DealContextListResult> {
  const queryString = buildQueryString(params)
  const result = await fetchDealContextList(queryString, signal)
  if (!result.ok) throw new Error(result.message)

  const payload = asRecord(result.data)
  const rows = safeArray(payload.data as AnyRecord[]).map((row) => normalizeDealContext(asRecord(row)))

  const pagination = asRecord(payload.pagination)
  const rawNextOffset = pagination.next_offset

  return {
    rows,
    total: asNumber(payload.total, rows.length),
    pagination: {
      offset: asNumber(pagination.offset, 0),
      limit: asNumber(pagination.limit, rows.length),
      total: asNumber(pagination.total, rows.length),
      has_more: asBoolean(pagination.has_more, false),
      next_offset: rawNextOffset === null || rawNextOffset === undefined || rawNextOffset === ''
        ? null
        : asNumber(rawNextOffset, 0),
    },
  }
}

export async function getDealContextByProperty(
  propertyId: string,
  signal?: AbortSignal,
): Promise<DealContext | null> {
  const result = await fetchDealContextByProperty(propertyId, signal)
  if (!result.ok) {
    if (result.status === 404) return null
    throw new Error(result.message)
  }
  return normalizeDealContext(asRecord(asRecord(result.data).data))
}

export async function getDealContextByThread(
  threadKey: string,
  signal?: AbortSignal,
): Promise<DealContext | null> {
  const result = await fetchDealContextByThread(threadKey, signal)
  if (!result.ok) {
    if (result.status === 404) return null
    throw new Error(result.message)
  }
  return normalizeDealContext(asRecord(asRecord(result.data).data))
}

export async function getDealContextCounts(
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<AnyRecord> {
  const queryString = buildQueryString(params)
  const result = await fetchDealContextCountsFromBackend(queryString, signal)
  if (!result.ok) throw new Error(result.message)
  return asRecord(asRecord(result.data).data)
}
