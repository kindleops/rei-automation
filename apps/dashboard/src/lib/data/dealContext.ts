import {
  fetchDealContextByProperty,
  fetchDealContextByThread,
  fetchDealContextCounts as fetchDealContextCountsFromBackend,
  fetchDealContextList,
} from '../api/backendClient'
import { asBoolean, asIso, asNumber, asString, type AnyRecord } from './shared'

export interface DealContext {
  id: string
  deal_context_id: string
  contextType: string
  context_type: string
  propertyId: string | null
  property_id: string | null
  masterOwnerId: string | null
  master_owner_id: string | null
  prospectId: string | null
  prospect_id: string | null
  canonicalProspectId: string | null
  canonical_prospect_id: string | null
  phoneId: string | null
  phone_id: string | null
  emailId: string | null
  email_id: string | null
  threadKey: string | null
  thread_key: string | null
  canonicalE164: string | null
  canonical_e164: string | null
  campaignId: string | null
  campaign_id: string | null
  campaignTargetId: string | null
  campaign_target_id: string | null
  queueRowId: string | null
  queue_row_id: string | null
  textgridNumberId: string | null
  textgrid_number_id: string | null

  property: AnyRecord
  masterOwner: AnyRecord
  prospect: AnyRecord
  phone: AnyRecord
  phoneData: AnyRecord
  email: AnyRecord
  threadState: AnyRecord
  campaign: AnyRecord
  queue: AnyRecord
  suppression: AnyRecord
  valuation: AnyRecord
  buyerMatch: AnyRecord
  contactStack: AnyRecord
  latestMessageEvent: AnyRecord

  ownerName: string
  owner_name: string
  display_name: string
  displayName: string
  firstName: string
  fullName: string
  sellerDisplayName: string
  propertyAddress: string
  property_address_full: string
  market: string
  market_name: string
  phoneDisplay: string
  latestMessageBody: string
  latest_message_body: string
  latestMessageDirection: string
  latest_message_direction: string
  latestActivityAt: string | null
  latest_activity_at: string | null
  latest_message_at: string | null
  status: string
  universal_status: string
  universalStatus: string
  stage: string
  universal_stage: string
  universalStage: string
  bucket: string
  inbox_bucket: string
  inboxBucket: string
  conversationStage: string
  reviewStatus: string
  autoReplyStatus: string

  sellerPhone: string
  seller_phone: string
  senderPhone: string
  sender_phone: string
  ourNumber: string
  our_number: string
  bestPhone: string
  best_phone: string

  prospect_name: string
  full_name: string
  first_name: string
  cnam: string

  latitude: number
  longitude: number
  property_type: string
  property_class: string
  propertyState: string
  propertyZip: string
  propertyCounty: string
  estimatedValue: number
  estimated_value: number
  estimated_arv: number
  equityAmount: number
  equity_amount: number
  equityPercent: number
  equity_percent: number
  cashOffer: number
  cash_offer: number
  estimatedRepairCost: number
  estimated_repair_cost: number
  finalAcquisitionScore: number
  final_acquisition_score: number
  priorityScore: number
  priority_score: number
  propertyTags: string[]
  sellerTags: string[]
  lat: number
  lng: number
  optOut: boolean
  wrongNumber: boolean
  notInterested: boolean
  needsReview: boolean
  suppressed: boolean

  campaign_name: string
  queue_status: string
  reply_intent: string
  lead_temperature: string

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

const firstPresent = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim().length === 0) continue
    return value
  }
  return null
}

const firstString = (...values: unknown[]): string => asString(firstPresent(...values))

const firstNumber = (...values: unknown[]): number => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const numeric = asNumber(value, Number.NaN)
    if (Number.isFinite(numeric)) return numeric
  }
  return 0
}

const firstBoolean = (...values: unknown[]): boolean => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    return asBoolean(value)
  }
  return false
}

const firstIso = (...values: unknown[]): string | null => {
  for (const value of values) {
    const iso = asIso(value)
    if (iso) return iso
  }
  return null
}

const normalizePhoneValue = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw.startsWith('+') ? raw : `+${digits}`
}

const asStringArray = (...values: unknown[]): string[] => {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.map((item) => asString(item).trim()).filter(Boolean)
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(',').map((item) => item.trim()).filter(Boolean)
    }
  }
  return []
}

const TEXTGRID_NUMBERS = new Set([
  '+16128060495', '+13235589881', '+17866052999', '+19804589889', 
  '+13234104544', '+14704920588', '+14693131600', '+12818458577', 
  '+19048774448', '+17042405818'
])

function isTextGridNumber(phone: string | null | undefined): boolean {
  if (!phone) return false
  const p = normalizePhoneValue(phone)
  return TEXTGRID_NUMBERS.has(p)
}

export function normalizeDealContext(row: AnyRecord): DealContext {
  const property = asRecord(row.property_data ?? row.property ?? row.propertyData)
  const propertyRaw = asRecord(property.raw_payload_json)
  const masterOwner = asRecord(row.master_owner_data ?? row.masterOwner ?? row.masterOwnerData)
  const prospect = asRecord(row.prospect_data ?? row.prospect ?? row.prospectData)
  const phoneData = asRecord(row.phone_data ?? row.phoneData ?? row.phone)
  const email = asRecord(row.email_data ?? row.email ?? row.emailData)
  const threadState = asRecord(row.thread_state_data ?? row.threadState ?? row.threadStateData)
  const campaign = asRecord(row.campaign_data ?? row.campaign ?? row.campaignData)
  const queue = asRecord(row.queue_data ?? row.queue ?? row.queueData)
  const suppression = asRecord(row.suppression_data ?? row.suppression ?? row.suppressionData)
  const valuation = asRecord(row.valuation_data ?? row.valuation ?? row.valuationData)
  const buyerMatch = asRecord(row.buyer_match_data ?? row.buyerMatch ?? row.buyerMatchData)
  const latestMessageEvent = asRecord(
    row.latest_message_event_data ?? row.latestMessageEvent ?? row.latest_message_event ?? row.latestMessageEventData,
  )
  const contactStack = asRecord(row.contact_stack_json ?? row.contactStackJson)

  const dealContextId = firstString(row.deal_context_id, row.dealContextId, row.id)
  const contextType = firstString(row.context_type, row.contextType, 'property')
  const propertyId = firstString(row.property_id, row.propertyId, property.property_id, property.id) || null
  const masterOwnerId = firstString(
    row.master_owner_id,
    row.masterOwnerId,
    masterOwner.master_owner_id,
    masterOwner.id,
  ) || null
  const prospectId = firstString(row.prospect_id, row.prospectId, prospect.prospect_id, prospect.id) || null
  const canonicalProspectId = firstString(row.canonical_prospect_id, row.canonicalProspectId) || null
  const phoneId = firstString(row.phone_id, row.phoneId, phoneData.phone_id, phoneData.id) || null
  const textgridNumberId = firstString(
    row.textgrid_number_id,
    row.textgridNumberId,
    threadState.textgrid_number_id,
    queue.textgrid_number_id,
    latestMessageEvent.textgrid_number_id,
  ) || null
  const emailId = firstString(row.email_id, row.emailId, email.email_id, email.id) || null
  const threadKey = firstString(row.thread_key, row.threadKey, threadState.thread_key, queue.thread_key) || null
  const campaignId = firstString(row.campaign_id, row.campaignId, campaign.id) || null
  const campaignTargetId = firstString(row.campaign_target_id, row.campaignTargetId, campaign.campaign_target_id) || null
  const queueRowId = firstString(row.queue_row_id, row.queueRowId, queue.id) || null

  const latestEventDirection = firstString(
    row.latest_message_direction,
    row.latest_direction,
    row.direction,
    threadState.latest_message_direction,
    latestMessageEvent.direction,
    row.queue_data ? 'outbound' : 'unknown',
  )

  // ── Phone Resolution (STRICT) ───────────────────────────────────────────
  let senderPhone = ''
  const senderCandidates = [
    row.sender_phone, row.our_number, row.ourNumber,
    threadState.our_number, threadState.sender_phone,
    latestMessageEvent.to_phone_number, latestMessageEvent.from_phone_number,
    queue.from_phone_number, queue.our_number
  ]
  for (const c of senderCandidates) {
    const p = normalizePhoneValue(c)
    if (isTextGridNumber(p)) {
      senderPhone = p
      break
    }
  }

  let sellerPhone = ''
  const sellerCandidates = [
    row.seller_phone, threadState.seller_phone,
    latestEventDirection === 'inbound' ? latestMessageEvent.from_phone_number : latestMessageEvent.to_phone_number,
    row.best_phone, row.phone, threadState.canonical_e164, row.canonical_e164, row.canonicalE164,
    phoneData.best_phone, phoneData.canonical_e164, phoneData.phone_number,
    threadKey
  ]
  for (const c of sellerCandidates) {
    const p = normalizePhoneValue(c)
    if (p && !isTextGridNumber(p)) {
      sellerPhone = p
      break
    }
  }

  if (sellerPhone === senderPhone) sellerPhone = ''

  const ownerName = firstString(
    row.owner_name,
    row.display_name,
    row.full_name,
    masterOwner.display_name,
    property.owner_name,
    property.owner_1_name,
    prospect.full_name,
    phoneData.owner_display_name,
    'Unknown Owner',
  )
  const displayName = firstString(
    row.display_name,
    row.owner_display_name,
    masterOwner.display_name,
    prospect.display_name,
    prospect.full_name,
    ownerName,
  )
  const fullName = firstString(row.full_name, prospect.full_name, masterOwner.full_name, displayName, ownerName)
  const firstName = firstString(
    row.first_name,
    row.seller_first_name,
    prospect.first_name,
    masterOwner.first_name,
    fullName.split(' ')[0],
  )
  const sellerDisplayName = firstString(row.seller_display_name, row.seller_name, displayName, ownerName)

  const propertyAddress = firstString(
    row.property_address,
    row.property_address_full,
    property.property_address_full,
    propertyRaw.property_address_full,
    'Unknown Address',
  )
  const market = firstString(
    row.market,
    row.market_name,
    property.market,
    property.market_name,
    propertyRaw.market,
  )
  const propertyState = firstString(
    row.property_state,
    row.property_address_state,
    property.property_state,
    property.property_address_state,
    propertyRaw.property_address_state,
  )
  const propertyZip = firstString(
    row.property_zip,
    row.property_address_zip,
    property.property_zip,
    property.property_address_zip,
    propertyRaw.property_address_zip,
  )
  const propertyCounty = firstString(
    row.property_county,
    row.property_county_name,
    property.property_county,
    property.property_county_name,
    propertyRaw.property_county_name,
  )

  const latestMessageBody = firstString(
    row.latest_message_body,
    row.last_message_body,
    threadState.latest_message_body,
    threadState.last_message_body,
    latestMessageEvent.message_body,
    queue.message_body,
    '',
  )
  const status = firstString(row.universal_status, threadState.universal_status, row.inbox_status, 'unknown')
  const stage = firstString(row.universal_stage, threadState.universal_stage, row.conversation_stage, 'unknown')
  const bucket = firstString(row.inbox_bucket, threadState.inbox_bucket, 'all_messages')
  const latestActivityAt = firstIso(
    row.latest_activity_at,
    row.latest_message_at,
    row.last_message_at,
    threadState.latest_activity_at,
    threadState.latest_message_at,
    latestMessageEvent.created_at,
    queue.created_at,
    row.created_at,
  )

  const canonicalE164 = sellerPhone || null

  return {
    id: dealContextId,
    deal_context_id: dealContextId,
    contextType,
    context_type: contextType,
    propertyId,
    property_id: propertyId,
    masterOwnerId,
    master_owner_id: masterOwnerId,
    prospectId,
    prospect_id: prospectId,
    canonicalProspectId,
    canonical_prospect_id: canonicalProspectId,
    phoneId,
    phone_id: phoneId,
    emailId,
    email_id: emailId,
    threadKey,
    thread_key: threadKey,
    canonicalE164,
    canonical_e164: canonicalE164,
    campaignId,
    campaign_id: campaignId,
    campaignTargetId,
    campaign_target_id: campaignTargetId,
    queueRowId,
    queue_row_id: queueRowId,
    textgridNumberId,
    textgrid_number_id: textgridNumberId,

    property,
    masterOwner,
    prospect,
    phone: phoneData,
    phoneData,
    email,
    threadState,
    campaign,
    queue,
    suppression,
    valuation,
    buyerMatch,
    contactStack: (contactStack as any) || {},
    latestMessageEvent,

    ownerName,
    owner_name: ownerName,
    display_name: displayName,
    displayName,
    firstName,
    fullName,
    sellerDisplayName,
    propertyAddress,
    property_address_full: propertyAddress,
    market,
    market_name: market,
    phoneDisplay: sellerPhone,
    latestMessageBody,
    latest_message_body: latestMessageBody,
    latestMessageDirection: latestEventDirection,
    latest_message_direction: latestEventDirection,
    latestActivityAt,
    latest_activity_at: latestActivityAt,
    latest_message_at: latestActivityAt,
    status,
    universal_status: status,
    universalStatus: status,
    stage,
    universal_stage: stage,
    universalStage: stage,
    bucket,
    inbox_bucket: bucket,
    inboxBucket: bucket,
    conversationStage: stage,
    reviewStatus: status,
    autoReplyStatus: firstString(row.queue_status, queue.queue_status, ''),

    // Additional requested fields
    sellerPhone,
    seller_phone: sellerPhone,
    senderPhone,
    sender_phone: senderPhone,
    ourNumber: senderPhone,
    our_number: senderPhone,
    bestPhone: sellerPhone,
    best_phone: sellerPhone,
    
    // Prospect fields
    prospect_name: firstString(prospect.full_name, fullName),
    full_name: fullName,
    first_name: firstName,
    cnam: asString(prospect.cnam || row.cnam),
    
    // Property fields
    latitude: firstNumber(row.latitude, property.latitude, 0),
    longitude: firstNumber(row.longitude, property.longitude, 0),
    property_type: firstString(row.property_type, property.property_type, 'Single Family'),
    property_class: firstString(row.property_class, property.property_class, 'Residential'),
    propertyState,
    propertyZip,
    propertyCounty,
    estimatedValue: firstNumber(row.estimated_value, property.estimated_value, 0),
    estimated_value: firstNumber(row.estimated_value, property.estimated_value, 0),
    estimated_arv: firstNumber(row.estimated_arv, property.estimated_arv, 0),
    equityAmount: firstNumber(row.equity_amount, property.equity_amount, 0),
    equity_amount: firstNumber(row.equity_amount, property.equity_amount, 0),
    equityPercent: firstNumber(row.equity_percent, property.equity_percent, 0),
    equity_percent: firstNumber(row.equity_percent, property.equity_percent, 0),
    cashOffer: firstNumber(row.cash_offer, property.cash_offer, 0),
    cash_offer: firstNumber(row.cash_offer, property.cash_offer, 0),
    estimatedRepairCost: firstNumber(row.estimated_repair_cost, valuation.repair_estimate, 0),
    estimated_repair_cost: firstNumber(row.estimated_repair_cost, valuation.repair_estimate, 0),
    finalAcquisitionScore: firstNumber(row.final_acquisition_score, 0),
    final_acquisition_score: firstNumber(row.final_acquisition_score, 0),
    priorityScore: firstNumber(row.priority_score, 0),
    priority_score: firstNumber(row.priority_score, 0),
    propertyTags: asStringArray(row.podio_tags, property.podio_tags),
    sellerTags: asStringArray(row.seller_tags_text, prospect.seller_tags_text),
    lat: firstNumber(row.latitude, property.latitude, 0),
    lng: firstNumber(row.longitude, property.longitude, 0),
    optOut: firstBoolean(row.opt_out, threadState.opt_out),
    wrongNumber: firstBoolean(row.wrong_number, threadState.wrong_number),
    notInterested: firstBoolean(row.not_interested, threadState.not_interested),
    needsReview: firstBoolean(row.needs_review, threadState.needs_review),
    suppressed: firstBoolean(row.suppressed, threadState.suppressed),

    // Other fields
    campaign_name: firstString(row.campaign_name, campaign.campaign_name, ''),
    queue_status: firstString(row.queue_status, queue.queue_status, ''),
    reply_intent: firstString(row.reply_intent, threadState.reply_intent, ''),
    lead_temperature: firstString(row.lead_temperature, threadState.lead_temperature, ''),

    raw: row,
  } as any
}

export async function getDealContextList(
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<DealContextListResult> {
  const queryString = buildQueryString(params)
  const result = await fetchDealContextList(queryString, signal)
  if (!result.ok) throw new Error(result.message)
  const data = asRecord(result.data)
  const rowsRaw = Array.isArray(data.rows) ? data.rows : []
  const total = asNumber(data.total, rowsRaw.length)
  const pagination = asRecord(data.pagination)

  return {
    rows: rowsRaw.map((row) => normalizeDealContext(row as AnyRecord)),
    total,
    pagination: {
      offset: asNumber(pagination.offset, 0),
      limit: asNumber(pagination.limit, 100),
      total: asNumber(pagination.total, total),
      has_more: asBoolean(pagination.has_more, false),
      next_offset: asNumber(pagination.next_offset, undefined),
    },
  }
}

export async function getDealContextByProperty(
  propertyId: string,
  signal?: AbortSignal,
): Promise<DealContext | null> {
  const result = await fetchDealContextByProperty(propertyId, signal)
  if (!result.ok) return null
  const data = asRecord(result.data)
  const row = (Array.isArray(data.rows) ? data.rows[0] : data.row || data.data) as AnyRecord
  if (!row) return null
  return normalizeDealContext(row)
}

export async function getDealContextByThread(
  threadKey: string,
  signal?: AbortSignal,
): Promise<DealContext | null> {
  const result = await fetchDealContextByThread(threadKey, signal)
  if (!result.ok) return null
  const data = asRecord(result.data)
  const row = (Array.isArray(data.rows) ? data.rows[0] : data.row || data.data) as AnyRecord
  if (!row) return null
  return normalizeDealContext(row)
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
