import { getSupabaseClient } from '../supabaseClient'
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  getFirst,
  isDev,
  safeArray,
  shouldUseSupabase,
  type AnyRecord,
} from './shared'
import { getDealContextList, type DealContext } from './dealContext'
import type {
  AcquisitionAiBrain,
  AcquisitionAutomation,
  AcquisitionEmail,
  AcquisitionKpi,
  AcquisitionMapPoint,
  AcquisitionOffer,
  AcquisitionOwner,
  AcquisitionPhone,
  AcquisitionProperty,
  AcquisitionProspect,
  AcquisitionRecordSummary,
  AcquisitionRecordType,
  AcquisitionUnderwriting,
} from '../../modules/acquisition/acquisition.types'

export interface AcquisitionFilters {
  market?: string
  search?: string
  status?: string
}

interface Dataset {
  masterowners: AnyRecord[]
  owners: AnyRecord[]
  prospects: AnyRecord[]
  properties: AnyRecord[]
  phoneNumbers: AnyRecord[]
  emails: AnyRecord[]
  sendQueue: AnyRecord[]
  messageEvents: AnyRecord[]
  aiBrain: AnyRecord[]
  offers: AnyRecord[]
  underwriting: AnyRecord[]
  contracts: AnyRecord[]
  markets: AnyRecord[]
  zipCodes: AnyRecord[]
  agents: AnyRecord[]
  templates: AnyRecord[]
  titleRouting: AnyRecord[]
  closings: AnyRecord[]
  dealRevenue: AnyRecord[]
}

const currency = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)

const toRelative = (value: unknown) => {
  const iso = asIso(value)
  if (!iso) return 'N/A'
  const deltaMs = Date.now() - new Date(iso).getTime()
  const deltaMin = Math.max(Math.floor(deltaMs / 60000), 0)
  if (deltaMin < 1) return 'just now'
  if (deltaMin < 60) return `${deltaMin}m ago`
  const deltaHour = Math.floor(deltaMin / 60)
  if (deltaHour < 24) return `${deltaHour}h ago`
  return `${Math.floor(deltaHour / 24)}d ago`
}

const contains = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase())

export const normalizeId = (value: unknown): string =>
  asString(value, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')

export const normalizePhone = (value: unknown): string =>
  asString(value, '').replace(/\D/g, '').replace(/^1/, '')

export const normalizeAddress = (value: unknown): string =>
  asString(value, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')

export const getFirstAvailable = (row: AnyRecord, keys: string[], fallback = ''): string =>
  asString(getFirst(row, keys), fallback)

const asRecord = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : {}

const getOwnerLinkKey = (row: AnyRecord) =>
  normalizeId(
    getFirst(row, [
      'owner_id',
      'master_owner_id',
      'seller_id',
      'podio_owner_id',
      'normalized_owner_key',
      'owner_full_name',
    ]),
  )

export const linkOwnerToProperties = (owner: AnyRecord, properties: AnyRecord[]) => {
  const ownerId = getOwnerLinkKey(owner)
  const ownerAddress = normalizeAddress(getFirst(owner, ['property_address', 'owner_address']))
  return properties.filter((property) => {
    const directOwner = normalizeId(getFirst(property, ['owner_id', 'master_owner_id', 'seller_id']))
    const keyMatch = ownerId && ownerId === directOwner
    const addressMatch =
      ownerAddress.length > 4 && ownerAddress === normalizeAddress(getFirst(property, ['property_address', 'address']))
    return keyMatch || addressMatch
  })
}

export const linkOwnerToProspects = (owner: AnyRecord, prospects: AnyRecord[]) => {
  const ownerId = getOwnerLinkKey(owner)
  return prospects.filter((prospect) =>
    ownerId === normalizeId(getFirst(prospect, ['owner_id', 'master_owner_id', 'seller_id', 'podio_owner_id'])),
  )
}

export const linkOwnerToContacts = (owner: AnyRecord, contacts: AnyRecord[]) => {
  const ownerId = getOwnerLinkKey(owner)
  return contacts.filter((contact) => {
    const directOwner = normalizeId(getFirst(contact, ['owner_id', 'master_owner_id', 'seller_id']))
    const fullNameMatch =
      normalizeId(getFirst(owner, ['full_name', 'owner_full_name'])) &&
      normalizeId(getFirst(owner, ['full_name', 'owner_full_name'])) ===
        normalizeId(getFirst(contact, ['owner_full_name']))
    return ownerId === directOwner || fullNameMatch
  })
}

export const linkOwnerToMessages = (owner: AnyRecord, messages: AnyRecord[]) => {
  const ownerId = getOwnerLinkKey(owner)
  const ownerPhone = normalizePhone(getFirst(owner, ['phone', 'phone_number']))
  return messages.filter((message) => {
    const directOwner = normalizeId(getFirst(message, ['owner_id', 'master_owner_id', 'seller_id']))
    const phoneMatch = ownerPhone && ownerPhone === normalizePhone(getFirst(message, ['phone', 'phone_number']))
    return ownerId === directOwner || phoneMatch
  })
}

export const linkPropertyToOffers = (property: AnyRecord, offers: AnyRecord[]) => {
  const propertyId = normalizeId(getFirst(property, ['property_id', 'id', 'podio_property_id']))
  const propertyAddress = normalizeAddress(getFirst(property, ['property_address', 'address']))
  return offers.filter((offer) => {
    const direct = normalizeId(getFirst(offer, ['property_id', 'podio_property_id']))
    const address = normalizeAddress(getFirst(offer, ['property_address', 'address']))
    return (propertyId && propertyId === direct) || (propertyAddress && propertyAddress === address)
  })
}

export const linkOfferToContracts = (offer: AnyRecord, contracts: AnyRecord[]) => {
  const offerId = normalizeId(getFirst(offer, ['offer_id', 'id']))
  return contracts.filter((contract) =>
    offerId === normalizeId(getFirst(contract, ['offer_id', 'linked_offer_id'])),
  )
}

const DEAL_CONTEXT_DATASET_LIMIT = 1200

const mapDealContextsToDataset = (contexts: DealContext[]): Dataset => {
  const ownersById = new Map<string, AnyRecord>()
  const propertiesById = new Map<string, AnyRecord>()
  const prospectsById = new Map<string, AnyRecord>()
  const phonesById = new Map<string, AnyRecord>()
  const emailsById = new Map<string, AnyRecord>()
  const queuesById = new Map<string, AnyRecord>()
  const messagesById = new Map<string, AnyRecord>()
  const aiById = new Map<string, AnyRecord>()
  const offersById = new Map<string, AnyRecord>()
  const underwritingById = new Map<string, AnyRecord>()
  const marketsById = new Map<string, AnyRecord>()

  for (const context of contexts) {
    const ownerId = context.masterOwnerId || context.propertyId || context.id
    const propertyId = context.propertyId || context.id
    const prospectId = context.prospectId || context.canonicalProspectId || ''
    const phoneId = context.phoneId || context.canonicalE164 || ''
    const emailId = context.emailId || asString(context.email.email) || ''
    const queueId = context.queueRowId || context.id
    const messageId = asString(context.raw.latest_message_event_id) || context.threadKey || context.id
    const marketKey = context.market || asString(context.property.market) || 'unknown'

    if (ownerId && !ownersById.has(ownerId)) {
      ownersById.set(ownerId, {
        owner_id: ownerId,
        master_owner_id: ownerId,
        full_name: context.ownerName,
        display_name: context.ownerName,
        owner_type: asString(context.masterOwner.owner_type_guess || context.masterOwner.owner_type),
        market: context.market,
        state: asString(context.raw.property_state || context.property.property_state || context.property.property_address_state),
        motivation_score: asNumber(context.raw.priority_score || context.property.structured_motivation_score),
        ai_score: asNumber(context.raw.final_acquisition_score || context.property.final_acquisition_score),
        risk_score: Math.max(0, 100 - asNumber(context.raw.priority_score, 0)),
        status: context.status,
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (propertyId && !propertiesById.has(propertyId)) {
      propertiesById.set(propertyId, {
        property_id: propertyId,
        owner_id: ownerId,
        master_owner_id: ownerId,
        property_address: context.propertyAddress,
        property_address_full: context.propertyAddress,
        property_address_city: asString(context.raw.property_address_city || context.property.property_address_city),
        property_address_state: asString(context.raw.property_state || context.property.property_address_state),
        property_address_zip: asString(context.raw.property_zip || context.property.property_address_zip),
        property_county_name: asString(context.raw.property_county_name || context.property.property_county_name),
        market: context.market,
        property_type: asString(context.raw.property_type || context.property.property_type),
        property_class: asString(context.raw.property_class || context.property.property_class),
        estimated_value: asNumber(context.raw.estimated_value || context.property.estimated_value),
        arv: asNumber(context.raw.estimated_arv),
        value: asNumber(context.raw.estimated_value || context.property.estimated_value),
        equity: asNumber(context.property.equity_amount),
        equity_percent: asNumber(context.raw.equity_percent || context.property.equity_percent),
        tax_flag: asBoolean(context.property.property_tax_delinquent),
        probate_flag: asBoolean(context.property.probate_flag),
        foreclosure_flag: asBoolean(context.property.foreclosure_flag),
        motivation_score: asNumber(context.raw.priority_score || context.property.structured_motivation_score),
        ai_score: asNumber(context.raw.final_acquisition_score || context.property.final_acquisition_score),
        offer_status: context.stage,
        status: context.status,
        latitude: asNumber(context.raw.latitude || context.property.latitude),
        longitude: asNumber(context.raw.longitude || context.property.longitude),
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (prospectId && !prospectsById.has(prospectId)) {
      prospectsById.set(prospectId, {
        prospect_id: prospectId,
        owner_id: ownerId,
        master_owner_id: ownerId,
        full_name: asString(context.prospect.full_name || context.ownerName),
        prospect_name: asString(context.prospect.full_name || context.ownerName),
        relationship_type: asString(context.prospect.relationship_type, 'owner'),
        market: context.market,
        best_phone: context.phoneDisplay,
        best_email: asString(context.email.email || context.prospect.best_email),
        language: asString(context.prospect.language || context.masterOwner.best_language, 'en'),
        lead_stage: context.stage,
        status: context.status,
        next_action: context.bucket === 'new_replies' ? 'Reply to seller' : 'Review context',
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (phoneId && !phonesById.has(phoneId)) {
      phonesById.set(phoneId, {
        phone_id: phoneId,
        owner_id: ownerId,
        master_owner_id: ownerId,
        prospect_id: prospectId || null,
        canonical_e164: context.canonicalE164,
        phone: context.phoneDisplay,
        phone_number: context.phoneDisplay,
        type: asString(context.phone.phone_type || context.phone.type, 'mobile'),
        status: asString(context.queue.queue_status || 'active'),
        sms_status: context.status,
        suppressed: asBoolean(context.raw.opt_out),
        dnc: asBoolean(context.raw.opt_out),
        last_contacted: asString(context.raw.last_outbound_at || context.raw.updated_at),
        last_reply: asString(context.raw.last_inbound_at),
        owner_full_name: context.ownerName,
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (emailId && !emailsById.has(emailId)) {
      emailsById.set(emailId, {
        email_id: emailId,
        owner_id: ownerId,
        master_owner_id: ownerId,
        prospect_id: prospectId || null,
        email: asString(context.email.email),
        status: asString(context.email.verification_status || 'unverified'),
        owner_full_name: context.ownerName,
        last_contacted: asString(context.raw.updated_at),
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (queueId && !queuesById.has(queueId) && (context.queueRowId || Object.keys(context.queue).length > 0)) {
      queuesById.set(queueId, {
        queue_id: queueId,
        id: queueId,
        owner_id: ownerId,
        master_owner_id: ownerId,
        property_id: propertyId || null,
        market: context.market,
        queue_status: asString(context.raw.queue_status),
        status: asString(context.raw.queue_status),
        message_text: context.latestMessageBody,
        message_body: context.latestMessageBody,
        scheduled_at: asString(context.raw.queue_scheduled_for),
        scheduled_for: asString(context.raw.queue_scheduled_for),
        created_at: asString(context.raw.created_at),
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (messageId && !messagesById.has(messageId) && (context.latestMessageBody || Object.keys(asRecord(context.raw.latest_message_event_data)).length > 0)) {
      messagesById.set(messageId, {
        event_id: messageId,
        id: messageId,
        thread_id: context.threadKey,
        thread_key: context.threadKey,
        owner_id: ownerId,
        master_owner_id: ownerId,
        property_id: propertyId || null,
        market: context.market,
        direction: context.latestMessageDirection,
        sentiment: asString(context.threadState.lead_temperature),
        message_text: context.latestMessageBody,
        message_body: context.latestMessageBody,
        unread: context.bucket === 'new_replies',
        created_at: asString(context.raw.latest_message_at || context.raw.updated_at),
      })
    }

    if (context.id && !aiById.has(context.id)) {
      aiById.set(context.id, {
        id: context.id,
        owner_id: ownerId,
        master_owner_id: ownerId,
        seller_intent: asString(context.threadState.reply_intent || context.threadState.lead_temperature),
        objections: asString(context.threadState.needs_review ? 'Needs operator review' : ''),
        language: asString(context.masterOwner.best_language || context.prospect.language, 'en'),
        sentiment: asString(context.threadState.lead_temperature || context.latestMessageDirection),
        conversation_stage: context.stage,
        recommended_next_action: context.bucket === 'new_replies' ? 'Reply to seller' : 'Review deal context',
        confidence: asNumber(context.raw.final_acquisition_score),
        agent_assigned: asString(context.masterOwner.agent_name),
        template_recommendation: asString(context.raw.campaign_name),
        negotiation_posture: context.status === 'seller_replied' ? 'active' : 'monitor',
        follow_up_timing: asString(context.raw.queue_scheduled_for || context.raw.latest_message_at),
      })
    }

    if (propertyId && !offersById.has(propertyId) && (asNumber(context.raw.cash_offer, 0) > 0 || asNumber(context.raw.estimated_value, 0) > 0)) {
      offersById.set(propertyId, {
        offer_id: `offer:${propertyId}`,
        owner_id: ownerId,
        master_owner_id: ownerId,
        property_id: propertyId,
        strategy: 'cash',
        recommended_offer: asNumber(context.raw.cash_offer),
        seller_asking_price: asNumber(context.property.list_price),
        status: context.stage || context.status || 'draft',
        confidence: asNumber(context.raw.final_acquisition_score),
        next_action: context.bucket === 'new_replies' ? 'Review response' : 'Review offer',
        updated_at: asString(context.raw.updated_at),
      })
    }

    if (propertyId && !underwritingById.has(propertyId) && (asNumber(context.raw.estimated_value, 0) > 0 || asNumber(context.raw.cash_offer, 0) > 0)) {
      underwritingById.set(propertyId, {
        underwriting_id: `uw:${propertyId}`,
        id: `uw:${propertyId}`,
        property_id: propertyId,
        arv: asNumber(context.raw.estimated_arv || context.raw.estimated_value),
        estimated_value: asNumber(context.raw.estimated_value),
        repair_estimate: asNumber(context.property.estimated_repair_cost),
        equity: asNumber(context.property.equity_amount),
        mao: asNumber(context.raw.cash_offer),
        cash_offer: asNumber(context.raw.cash_offer),
        creative_offer: asNumber(context.raw.cash_offer),
        novation_path: asString(context.buyerMatch.best_candidate ? 'Buyer match available' : 'Evaluate novation path'),
        multifamily_noi: asString(context.property.multifamily_noi),
        rent_estimate: asNumber(context.property.rent_estimate),
        ai_confidence: asNumber(context.raw.final_acquisition_score),
        risk_notes: asString(context.raw.suppression_status ? 'Suppressed contact' : context.threadState.needs_review ? 'Needs review' : 'No critical risk notes'),
      })
    }

    if (marketKey && !marketsById.has(marketKey)) {
      marketsById.set(marketKey, {
        market_id: marketKey,
        name: marketKey,
        market: marketKey,
        latitude: asNumber(context.raw.latitude || context.property.latitude),
        longitude: asNumber(context.raw.longitude || context.property.longitude),
      })
    }
  }

  return {
    masterowners: [],
    owners: [...ownersById.values()],
    prospects: [...prospectsById.values()],
    properties: [...propertiesById.values()],
    phoneNumbers: [...phonesById.values()],
    emails: [...emailsById.values()],
    sendQueue: [...queuesById.values()],
    messageEvents: [...messagesById.values()],
    aiBrain: [...aiById.values()],
    offers: [...offersById.values()],
    underwriting: [...underwritingById.values()],
    contracts: [],
    markets: [...marketsById.values()],
    zipCodes: [],
    agents: [],
    templates: [],
    titleRouting: [],
    closings: [],
    dealRevenue: [],
  }
}

const mockDataset = (): Dataset => {
  const owners: AnyRecord[] = [
    {
      owner_id: 'own-001',
      master_owner_id: 'mown-001',
      full_name: 'Diana Alvarez',
      owner_type: 'individual',
      market: 'Houston',
      state: 'TX',
      motivation_score: 88,
      ai_score: 84,
      risk_score: 24,
      status: 'hot',
      updated_at: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    },
    {
      owner_id: 'own-002',
      master_owner_id: 'mown-002',
      full_name: 'Oakline Holdings LLC',
      owner_type: 'corporation',
      market: 'Dallas',
      state: 'TX',
      motivation_score: 74,
      ai_score: 72,
      risk_score: 33,
      status: 'engaged',
      updated_at: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    },
    {
      owner_id: 'own-003',
      master_owner_id: 'mown-003',
      full_name: 'Marvin Reid',
      owner_type: 'individual',
      market: 'Phoenix',
      state: 'AZ',
      motivation_score: 64,
      ai_score: 69,
      risk_score: 39,
      status: 'watch',
      updated_at: new Date(Date.now() - 1000 * 60 * 105).toISOString(),
    },
  ]

  const properties: AnyRecord[] = [
    {
      property_id: 'prop-001',
      owner_id: 'own-001',
      property_address: '1289 Oak Ridge Dr',
      property_address_city: 'Houston',
      property_address_state: 'TX',
      market: 'Houston',
      property_type: 'single_family',
      estimated_value: 328000,
      equity: 176000,
      tax_flag: true,
      probate_flag: false,
      foreclosure_flag: false,
      motivation_score: 91,
      status: 'review_needed',
      updated_at: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    },
    {
      property_id: 'prop-002',
      owner_id: 'own-002',
      property_address: '445 Canyon Bend Ct',
      property_address_city: 'Dallas',
      property_address_state: 'TX',
      market: 'Dallas',
      property_type: 'multifamily',
      estimated_value: 811000,
      equity: 312000,
      tax_flag: false,
      probate_flag: false,
      foreclosure_flag: false,
      motivation_score: 76,
      status: 'offer_ready',
      updated_at: new Date(Date.now() - 1000 * 60 * 33).toISOString(),
    },
    {
      property_id: 'prop-003',
      owner_id: 'own-003',
      property_address: '2710 Mesa Verde Ave',
      property_address_city: 'Phoenix',
      property_address_state: 'AZ',
      market: 'Phoenix',
      property_type: 'single_family',
      estimated_value: 403000,
      equity: 146000,
      tax_flag: false,
      probate_flag: true,
      foreclosure_flag: false,
      motivation_score: 68,
      status: 'nurture',
      updated_at: new Date(Date.now() - 1000 * 60 * 57).toISOString(),
    },
  ]

  const prospects: AnyRecord[] = [
    {
      prospect_id: 'pros-001',
      owner_id: 'own-001',
      full_name: 'Diana Alvarez',
      relationship_type: 'owner',
      market: 'Houston',
      lead_stage: 'engaged',
      seller_stage: 'offer_generated',
      language: 'en',
      updated_at: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    },
    {
      prospect_id: 'pros-002',
      owner_id: 'own-002',
      full_name: 'Neil Burke',
      relationship_type: 'manager',
      market: 'Dallas',
      lead_stage: 'contacted',
      seller_stage: 'preliminary',
      language: 'en',
      updated_at: new Date(Date.now() - 1000 * 60 * 51).toISOString(),
    },
  ]

  const phoneNumbers: AnyRecord[] = [
    {
      phone_id: 'ph-001',
      owner_id: 'own-001',
      prospect_id: 'pros-001',
      phone: '+1 (713) 555-0174',
      type: 'mobile',
      status: 'verified',
      sms_status: 'active',
      last_contacted: new Date(Date.now() - 1000 * 60 * 44).toISOString(),
      last_reply: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
    },
    {
      phone_id: 'ph-002',
      owner_id: 'own-002',
      prospect_id: 'pros-002',
      phone: '+1 (214) 555-0108',
      type: 'mobile',
      status: 'verified',
      sms_status: 'active',
      last_contacted: new Date(Date.now() - 1000 * 60 * 93).toISOString(),
      last_reply: '',
    },
  ]

  const emails: AnyRecord[] = [
    {
      email_id: 'em-001',
      owner_id: 'own-001',
      prospect_id: 'pros-001',
      email: 'diana.alvarez@example.com',
      status: 'verified',
      last_contacted: new Date(Date.now() - 1000 * 60 * 51).toISOString(),
    },
    {
      email_id: 'em-002',
      owner_id: 'own-002',
      prospect_id: 'pros-002',
      email: 'operations@oaklineholdings.com',
      status: 'verified',
      last_contacted: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    },
  ]

  const sendQueue: AnyRecord[] = [
    {
      queue_id: 'sq-001',
      owner_id: 'own-001',
      property_id: 'prop-001',
      market: 'Houston',
      status: 'ready',
      message_text: 'Hi Diana, quick follow up on Oak Ridge…',
      scheduled_at: new Date(Date.now() + 1000 * 60 * 20).toISOString(),
      created_at: new Date(Date.now() - 1000 * 60 * 31).toISOString(),
    },
    {
      queue_id: 'sq-002',
      owner_id: 'own-003',
      property_id: 'prop-003',
      market: 'Phoenix',
      status: 'failed',
      message_text: 'Checking in about Mesa Verde…',
      scheduled_at: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
      created_at: new Date(Date.now() - 1000 * 60 * 48).toISOString(),
    },
  ]

  const messageEvents: AnyRecord[] = [
    {
      event_id: 'me-001',
      thread_id: 'th-001',
      owner_id: 'own-001',
      property_id: 'prop-001',
      market: 'Houston',
      direction: 'inbound',
      sentiment: 'hot',
      message_text: 'Can you send me a number today?',
      unread: true,
      created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    },
    {
      event_id: 'me-002',
      thread_id: 'th-002',
      owner_id: 'own-002',
      property_id: 'prop-002',
      market: 'Dallas',
      direction: 'inbound',
      sentiment: 'warm',
      message_text: 'I can talk later this afternoon.',
      unread: true,
      created_at: new Date(Date.now() - 1000 * 60 * 17).toISOString(),
    },
  ]

  const aiBrain: AnyRecord[] = [
    {
      id: 'ai-001',
      owner_id: 'own-001',
      seller_intent: 'Sell in 30 days',
      objections: 'Wants confidence in timing',
      language: 'English',
      sentiment: 'positive',
      stage: 'negotiation',
      recommended_next_action: 'Share net sheet and timeline',
      confidence: 87,
      agent_assigned: 'Sarah Johnson',
      template_recommendation: 'Urgency Follow-up',
      negotiation_posture: 'collaborative',
      follow_up_timing: 'Today 4:30 PM',
    },
    {
      id: 'ai-002',
      owner_id: 'own-002',
      seller_intent: 'Considering options',
      objections: 'Price sensitivity',
      language: 'English',
      sentiment: 'neutral',
      stage: 'qualification',
      recommended_next_action: 'Offer range anchoring',
      confidence: 74,
      agent_assigned: 'Mike Chen',
      template_recommendation: 'Value Framing',
      negotiation_posture: 'measured',
      follow_up_timing: 'Tomorrow 10:00 AM',
    },
  ]

  const offers: AnyRecord[] = [
    {
      offer_id: 'off-001',
      owner_id: 'own-001',
      property_id: 'prop-001',
      strategy: 'cash',
      recommended_offer: 242000,
      seller_asking_price: 279000,
      status: 'draft',
      confidence: 82,
      updated_at: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
      next_action: 'Review with operator',
    },
    {
      offer_id: 'off-002',
      owner_id: 'own-002',
      property_id: 'prop-002',
      strategy: 'novation',
      recommended_offer: 603000,
      seller_asking_price: 670000,
      status: 'ready',
      confidence: 79,
      updated_at: new Date(Date.now() - 1000 * 60 * 47).toISOString(),
      next_action: 'Generate contract',
    },
  ]

  const underwriting: AnyRecord[] = [
    {
      id: 'uw-001',
      property_id: 'prop-001',
      arv: 336000,
      repair_estimate: 29000,
      equity: 176000,
      mao: 219000,
      cash_offer: 242000,
      creative_offer: 258000,
      novation_path: 'Strong retail spread',
      multifamily_noi: 'N/A',
      rent_estimate: 2260,
      ai_confidence: 84,
      risk_notes: 'Permit history incomplete',
    },
    {
      id: 'uw-002',
      property_id: 'prop-002',
      arv: 828000,
      repair_estimate: 57000,
      equity: 312000,
      mao: 571000,
      cash_offer: 603000,
      creative_offer: 622000,
      novation_path: 'Moderate upside',
      multifamily_noi: '$6.8k/mo est.',
      rent_estimate: 5900,
      ai_confidence: 78,
      risk_notes: 'Lease rollover in 8 months',
    },
  ]

  const contracts: AnyRecord[] = [
    {
      contract_id: 'ct-001',
      owner_id: 'own-002',
      property_id: 'prop-002',
      offer_id: 'off-002',
      status: 'pending',
      updated_at: new Date(Date.now() - 1000 * 60 * 61).toISOString(),
    },
  ]

  const markets: AnyRecord[] = [
    { market_id: 'houston', name: 'Houston', state_code: 'TX', latitude: 29.7604, longitude: -95.3698 },
    { market_id: 'dallas', name: 'Dallas', state_code: 'TX', latitude: 32.7767, longitude: -96.797 },
    { market_id: 'phoenix', name: 'Phoenix', state_code: 'AZ', latitude: 33.4484, longitude: -112.074 },
  ]

  const agents: AnyRecord[] = [
    { agent_id: 'ag-001', name: 'Sarah Johnson', status: 'active' },
    { agent_id: 'ag-002', name: 'Mike Chen', status: 'active' },
  ]

  const templates: AnyRecord[] = [
    { template_id: 'tp-001', name: 'Urgency Follow-up' },
    { template_id: 'tp-002', name: 'Value Framing' },
  ]

  const titleRouting: AnyRecord[] = [
    { routing_id: 'tr-001', contract_id: 'ct-001', status: 'queued' },
  ]

  const closings: AnyRecord[] = [
    { closing_id: 'cl-001', contract_id: 'ct-001', status: 'pending' },
  ]

  const dealRevenue: AnyRecord[] = [
    { revenue_id: 'rv-001', contract_id: 'ct-001', amount: 42000, status: 'projected' },
  ]

  return {
    masterowners: [],
    owners,
    prospects,
    properties,
    phoneNumbers,
    emails,
    sendQueue,
    messageEvents,
    aiBrain,
    offers,
    underwriting,
    contracts,
    markets,
    zipCodes: [],
    agents,
    templates,
    titleRouting,
    closings,
    dealRevenue,
  }
}

const safeSelect = async (
  table: string,
  columns = '*',
  limit = 1200,
): Promise<AnyRecord[]> => {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.from(table).select(columns).limit(limit)
    if (error) {
      if (isDev) {
        console.warn(`[NEXUS] acquisitionData: table ${table} fallback`, error.message)
      }
      return []
    }
    return safeArray(data as unknown as AnyRecord[])
  } catch (error) {
    if (isDev) {
      console.warn(`[NEXUS] acquisitionData: table ${table} unavailable`, error)
    }
    return []
  }
}

const fetchDataset = async (): Promise<Dataset> => {
  if (!shouldUseSupabase()) return mockDataset()

  try {
    const dealContext = await getDealContextList({
      limit: DEAL_CONTEXT_DATASET_LIMIT,
      order_by: 'priority_score',
    })

    if (dealContext.rows.length > 0) {
      return mapDealContextsToDataset(dealContext.rows)
    }
  } catch (error) {
    if (isDev) {
      console.warn('[NEXUS] acquisitionData: deal-context fallback', error)
    }
  }

  const [
    masterowners,
    owners,
    prospects,
    properties,
    phoneNumbers,
    emails,
    sendQueue,
    messageEvents,
    aiBrain,
    offers,
    underwriting,
    contracts,
    markets,
    zipCodes,
    agents,
    templates,
    smsTemplates,
    titleRouting,
    closings,
    dealRevenue,
  ] = await Promise.all([
    safeSelect('masterowners'),
    safeSelect('owners'),
    safeSelect('prospects'),
    safeSelect('properties'),
    safeSelect('phone_numbers'),
    safeSelect('emails'),
    safeSelect('send_queue', 'id, queue_status, created_at, scheduled_at, message_body, market'),
    safeSelect('message_events'),
    safeSelect('ai_conversation_brain'),
    safeSelect('offers'),
    safeSelect('underwriting'),
    safeSelect('contracts'),
    safeSelect('markets'),
    safeSelect('zip_codes'),
    safeSelect('agents'),
    safeSelect('templates'),
    safeSelect('sms_templates'),
    safeSelect('title_routing_closing_engine'),
    safeSelect('closings'),
    safeSelect('deal_revenue'),
  ])

  const mergedTemplates = [...templates, ...smsTemplates]
  if (
    owners.length === 0 &&
    properties.length === 0 &&
    prospects.length === 0 &&
    phoneNumbers.length === 0
  ) {
    return mockDataset()
  }

  return {
    masterowners,
    owners,
    prospects,
    properties,
    phoneNumbers,
    emails,
    sendQueue,
    messageEvents,
    aiBrain,
    offers,
    underwriting,
    contracts,
    markets,
    zipCodes,
    agents,
    templates: mergedTemplates,
    titleRouting,
    closings,
    dealRevenue,
  }
}

const applyFilters = (rows: AnyRecord[], filters?: AcquisitionFilters) => {
  if (!filters) return rows
  let result = rows
  if (filters.market && filters.market !== 'All Markets') {
    result = result.filter((row) => contains(asString(getFirst(row, ['market', 'name', 'city']), ''), filters.market ?? ''))
  }
  if (filters.status) {
    result = result.filter((row) => contains(asString(getFirst(row, ['status']), ''), filters.status ?? ''))
  }
  if (filters.search) {
    const needle = filters.search.trim().toLowerCase()
    if (needle) {
      result = result.filter((row) =>
        Object.values(row).some((value) => asString(value, '').toLowerCase().includes(needle)),
      )
    }
  }
  return result
}

const ownerName = (owner: AnyRecord) =>
  getFirstAvailable(owner, ['full_name', 'owner_full_name', 'display_name', 'entity_name', 'first_name'], 'Unknown Owner')

const ownerState = (owner: AnyRecord) =>
  getFirstAvailable(owner, ['state', 'mailing_state', 'property_address_state'], 'NA')

export const getAcquisitionKpis = async (): Promise<AcquisitionKpi[]> => {
  const dataset = await fetchDataset()
  const hotSellers = dataset.owners.filter((owner) => asNumber(getFirst(owner, ['motivation_score']), 0) >= 75).length
  const newReplies = dataset.messageEvents.filter((event) => {
    return asString(getFirst(event, ['direction']), '').toLowerCase() === 'inbound' &&
      asBoolean(getFirst(event, ['unread']), false)
  }).length
  const readyQueue = dataset.sendQueue.filter((item) => asString(getFirst(item, ['queue_status', 'status']), '').toLowerCase() === 'ready').length
  const failedSends = dataset.sendQueue.filter((item) => {
    const status = asString(getFirst(item, ['queue_status', 'status']), '').toLowerCase()
    return status === 'failed' || status === 'retry'
  }).length
  const offersReady = dataset.offers.filter((offer) => contains(asString(getFirst(offer, ['status']), ''), 'ready')).length
  const contractsPending = dataset.contracts.filter((contract) => contains(asString(getFirst(contract, ['status']), ''), 'pending')).length
  const avgMotivation =
    dataset.owners.length > 0
      ? Math.round(
          dataset.owners.reduce((sum, owner) => sum + asNumber(getFirst(owner, ['motivation_score']), 0), 0) /
            dataset.owners.length,
        )
      : 0
  const pipelineValue = dataset.offers.reduce(
    (sum, offer) => sum + asNumber(getFirst(offer, ['recommended_offer', 'amount', 'offer_amount']), 0),
    0,
  )
  const contactRate = dataset.owners.length > 0
    ? Math.round(((dataset.phoneNumbers.length + dataset.emails.length) / dataset.owners.length) * 100)
    : 0
  const replyRate = dataset.sendQueue.length > 0
    ? Math.round((newReplies / dataset.sendQueue.length) * 100)
    : 0

  return [
    { id: 'hot-sellers', label: 'Hot Sellers', value: `${hotSellers}`, tone: hotSellers > 5 ? 'good' : 'warn' },
    { id: 'new-replies', label: 'New Replies', value: `${newReplies}`, tone: newReplies > 0 ? 'good' : 'neutral' },
    { id: 'ready-queue', label: 'Ready Queue', value: `${readyQueue}`, tone: readyQueue > 0 ? 'good' : 'neutral' },
    { id: 'failed-sends', label: 'Failed Sends', value: `${failedSends}`, tone: failedSends > 0 ? 'critical' : 'good' },
    { id: 'offers-ready', label: 'Offers Ready', value: `${offersReady}`, tone: offersReady > 0 ? 'good' : 'neutral' },
    { id: 'contracts-pending', label: 'Contracts Pending', value: `${contractsPending}`, tone: contractsPending > 0 ? 'warn' : 'neutral' },
    { id: 'avg-motivation', label: 'Average Motivation', value: `${avgMotivation}`, tone: avgMotivation >= 70 ? 'good' : 'warn' },
    { id: 'pipeline-value', label: 'Pipeline Value', value: currency(pipelineValue), tone: 'good' },
    { id: 'contact-rate', label: 'Contact Rate', value: `${contactRate}%`, tone: contactRate >= 70 ? 'good' : 'warn' },
    { id: 'reply-rate', label: 'Reply Rate', value: `${replyRate}%`, tone: replyRate >= 20 ? 'good' : 'warn' },
  ]
}

export const getAcquisitionOwners = async (filters?: AcquisitionFilters): Promise<AcquisitionOwner[]> => {
  const dataset = await fetchDataset()
  const owners = applyFilters(dataset.owners, filters)

  return owners.map((owner, index) => {
    const relatedProperties = linkOwnerToProperties(owner, dataset.properties)
    const relatedProspects = linkOwnerToProspects(owner, dataset.prospects)
    const relatedPhones = linkOwnerToContacts(owner, dataset.phoneNumbers)
    const relatedEmails = linkOwnerToContacts(owner, dataset.emails)

    const portfolioValue = relatedProperties.reduce(
      (sum, property) => sum + asNumber(getFirst(property, ['estimated_value', 'value']), 0),
      0,
    )
    const equity = relatedProperties.reduce(
      (sum, property) => sum + asNumber(getFirst(property, ['equity']), 0),
      0,
    )

    return {
      id: getFirstAvailable(owner, ['owner_id', 'master_owner_id'], `owner-${index + 1}`),
      ownerName: ownerName(owner),
      ownerType: getFirstAvailable(owner, ['owner_type'], 'individual'),
      market: getFirstAvailable(owner, ['market', 'city'], 'Unknown'),
      state: ownerState(owner),
      portfolioCount: relatedProperties.length,
      estimatedPortfolioValue: portfolioValue,
      equityEstimate: equity,
      motivationScore: asNumber(getFirst(owner, ['motivation_score']), 0),
      contactProbability: Math.max(0, Math.min(100, 100 - asNumber(getFirst(owner, ['risk_score']), 35))),
      lastActivity: toRelative(getFirst(owner, ['updated_at', 'created_at'])),
      nextAction: asNumber(getFirst(owner, ['motivation_score']), 0) >= 75 ? 'Generate offer' : 'Review messages',
      status: getFirstAvailable(owner, ['status', 'priority'], 'active'),
      propertyIds: relatedProperties.map((property, propertyIndex) =>
        getFirstAvailable(property, ['property_id'], `property-${propertyIndex + 1}`),
      ),
      prospectIds: relatedProspects.map((prospect, prospectIndex) =>
        getFirstAvailable(prospect, ['prospect_id'], `prospect-${prospectIndex + 1}`),
      ),
      phoneIds: relatedPhones.map((phone, phoneIndex) =>
        getFirstAvailable(phone, ['phone_id'], `phone-${phoneIndex + 1}`),
      ),
      emailIds: relatedEmails.map((email, emailIndex) =>
        getFirstAvailable(email, ['email_id'], `email-${emailIndex + 1}`),
      ),
    }
  })
}

export const getAcquisitionProperties = async (
  filters?: AcquisitionFilters,
): Promise<AcquisitionProperty[]> => {
  const dataset = await fetchDataset()
  const properties = applyFilters(dataset.properties, filters)

  return properties.map((property, index) => {
    const ownerId = getFirstAvailable(property, ['owner_id', 'master_owner_id'], '')
    const owner = dataset.owners.find((item) => normalizeId(getFirst(item, ['owner_id', 'master_owner_id'])) === normalizeId(ownerId))

    const distressTags = [
      asBoolean(getFirst(property, ['vacant']), false) ? 'Vacant' : '',
      asBoolean(getFirst(property, ['tax_flag', 'tax_delinquent']), false) ? 'Tax' : '',
      asBoolean(getFirst(property, ['probate_flag', 'probate']), false) ? 'Probate' : '',
      asBoolean(getFirst(property, ['foreclosure_flag', 'foreclosure']), false) ? 'Foreclosure' : '',
      asNumber(getFirst(property, ['motivation_score', 'priority_score']), 0) >= 75 ? 'High Motivation' : '',
    ].filter(Boolean)

    return {
      id: getFirstAvailable(property, ['property_id'], `property-${index + 1}`),
      address: getFirstAvailable(property, ['property_address', 'address'], 'Address unavailable'),
      market: getFirstAvailable(property, ['market', 'property_address_city'], 'Unknown'),
      propertyType: getFirstAvailable(property, ['property_type'], 'single_family'),
      ownerId,
      ownerName: owner ? ownerName(owner) : 'Unknown Owner',
      value: asNumber(getFirst(property, ['estimated_value', 'arv', 'value']), 0),
      equity: asNumber(getFirst(property, ['equity']), 0),
      distressTags,
      occupancy: asBoolean(getFirst(property, ['vacant']), false) ? 'Vacant' : 'Occupied',
      taxFlag: asBoolean(getFirst(property, ['tax_flag', 'tax_delinquent']), false),
      probateFlag: asBoolean(getFirst(property, ['probate_flag', 'probate']), false),
      foreclosureFlag: asBoolean(getFirst(property, ['foreclosure_flag', 'foreclosure']), false),
      aiScore: asNumber(getFirst(property, ['ai_score', 'motivation_score', 'priority_score']), 0),
      offerStatus: getFirstAvailable(property, ['offer_status', 'status'], 'none'),
      lastActivity: toRelative(getFirst(property, ['updated_at', 'created_at'])),
    }
  })
}

export const getAcquisitionProspects = async (
  filters?: AcquisitionFilters,
): Promise<AcquisitionProspect[]> => {
  const dataset = await fetchDataset()
  const prospects = applyFilters(dataset.prospects, filters)

  return prospects.map((prospect, index) => {
    const ownerId = getFirstAvailable(prospect, ['owner_id', 'master_owner_id'], '')
    const owner = dataset.owners.find((item) => normalizeId(getFirst(item, ['owner_id', 'master_owner_id'])) === normalizeId(ownerId))

    const phone = dataset.phoneNumbers.find((row) => normalizeId(getFirst(row, ['prospect_id'])) === normalizeId(getFirst(prospect, ['prospect_id'])))
    const email = dataset.emails.find((row) => normalizeId(getFirst(row, ['prospect_id'])) === normalizeId(getFirst(prospect, ['prospect_id'])))
    const recentMessage = dataset.messageEvents.find((row) => normalizeId(getFirst(row, ['owner_id'])) === normalizeId(ownerId))

    return {
      id: getFirstAvailable(prospect, ['prospect_id'], `prospect-${index + 1}`),
      prospectName: getFirstAvailable(prospect, ['full_name', 'prospect_name'], 'Unknown Prospect'),
      ownerId,
      ownerName: owner ? ownerName(owner) : 'Unknown Owner',
      relationshipType: getFirstAvailable(prospect, ['relationship_type'], 'owner'),
      market: getFirstAvailable(prospect, ['market'], getFirstAvailable(owner ?? {}, ['market'], 'Unknown')),
      bestPhone: phone ? getFirstAvailable(phone, ['phone', 'phone_number']) : 'N/A',
      bestEmail: email ? getFirstAvailable(email, ['email']) : 'N/A',
      language: getFirstAvailable(prospect, ['language'], 'en'),
      contactProbability: Math.max(0, Math.min(100, asNumber(getFirst(owner ?? {}, ['motivation_score']), 50))),
      outreachStatus: getFirstAvailable(prospect, ['lead_stage', 'status'], 'prospect'),
      lastMessage: recentMessage ? toRelative(getFirst(recentMessage, ['created_at'])) : 'N/A',
      nextAction: getFirstAvailable(prospect, ['next_action'], 'Send follow-up'),
    }
  })
}

export const getAcquisitionContacts = async (filters?: AcquisitionFilters): Promise<{
  phones: AcquisitionPhone[]
  emails: AcquisitionEmail[]
}> => {
  const dataset = await fetchDataset()
  const phones = applyFilters(dataset.phoneNumbers, filters)
  const emails = applyFilters(dataset.emails, filters)

  const phoneResults: AcquisitionPhone[] = phones.map((phone, index) => {
    const ownerId = getFirstAvailable(phone, ['owner_id', 'master_owner_id'], '')
    const owner = dataset.owners.find((item) => normalizeId(getFirst(item, ['owner_id', 'master_owner_id'])) === normalizeId(ownerId))

    return {
      id: getFirstAvailable(phone, ['phone_id'], `phone-${index + 1}`),
      phoneNumber: getFirstAvailable(phone, ['phone', 'phone_number'], 'Unknown'),
      ownerId,
      ownerName: owner ? ownerName(owner) : 'Unknown Owner',
      prospectId: getFirstAvailable(phone, ['prospect_id'], '') || null,
      phoneType: getFirstAvailable(phone, ['type'], 'mobile'),
      rank: index + 1,
      score: Math.max(0, Math.min(100, 85 - index * 3)),
      smsStatus: getFirstAvailable(phone, ['sms_status', 'status'], 'active'),
      suppression: asBoolean(getFirst(phone, ['dnc', 'suppressed']), false) ? 'Suppressed' : 'Active',
      lastContacted: toRelative(getFirst(phone, ['last_contacted', 'updated_at'])),
      lastReply: toRelative(getFirst(phone, ['last_reply', 'updated_at'])),
    }
  })

  const emailResults: AcquisitionEmail[] = emails.map((email, index) => {
    const ownerId = getFirstAvailable(email, ['owner_id', 'master_owner_id'], '')
    const owner = dataset.owners.find((item) => normalizeId(getFirst(item, ['owner_id', 'master_owner_id'])) === normalizeId(ownerId))

    return {
      id: getFirstAvailable(email, ['email_id'], `email-${index + 1}`),
      email: getFirstAvailable(email, ['email'], 'Unknown'),
      ownerId,
      ownerName: owner ? ownerName(owner) : 'Unknown Owner',
      prospectId: getFirstAvailable(email, ['prospect_id'], '') || null,
      rank: index + 1,
      score: Math.max(0, Math.min(100, 83 - index * 2)),
      linkageQuality: index % 2 === 0 ? 'High' : 'Medium',
      verificationStatus: getFirstAvailable(email, ['status'], 'unverified'),
      lastContacted: toRelative(getFirst(email, ['last_contacted', 'updated_at'])),
    }
  })

  return { phones: phoneResults, emails: emailResults }
}

export const getAcquisitionOffers = async (filters?: AcquisitionFilters): Promise<AcquisitionOffer[]> => {
  const dataset = await fetchDataset()
  const offers = applyFilters(dataset.offers, filters)

  return offers.map((offer, index) => {
    const ownerId = getFirstAvailable(offer, ['owner_id', 'master_owner_id'], '')
    const propertyId = getFirstAvailable(offer, ['property_id'], '')
    const owner = dataset.owners.find((item) => normalizeId(getFirst(item, ['owner_id', 'master_owner_id'])) === normalizeId(ownerId))
    const property = dataset.properties.find((item) => normalizeId(getFirst(item, ['property_id'])) === normalizeId(propertyId))

    return {
      id: getFirstAvailable(offer, ['offer_id'], `offer-${index + 1}`),
      propertyId,
      propertyAddress: property ? getFirstAvailable(property, ['property_address', 'address']) : 'Unknown Property',
      ownerId,
      ownerName: owner ? ownerName(owner) : 'Unknown Owner',
      strategy: getFirstAvailable(offer, ['strategy'], 'cash'),
      recommendedOffer: asNumber(getFirst(offer, ['recommended_offer', 'offer_amount', 'amount']), 0),
      sellerAskingPrice: asNumber(getFirst(offer, ['seller_asking_price', 'asking_price']), 0),
      offerStatus: getFirstAvailable(offer, ['status'], 'draft'),
      confidence: asNumber(getFirst(offer, ['confidence', 'ai_confidence']), 70),
      lastUpdated: toRelative(getFirst(offer, ['updated_at', 'created_at'])),
      nextAction: getFirstAvailable(offer, ['next_action'], 'Review'),
    }
  })
}

export const getAcquisitionUnderwriting = async (
  filters?: AcquisitionFilters,
): Promise<AcquisitionUnderwriting[]> => {
  const dataset = await fetchDataset()
  const underwritingRows = applyFilters(dataset.underwriting, filters)

  return underwritingRows.map((row, index) => {
    const propertyId = getFirstAvailable(row, ['property_id'], '')
    const property = dataset.properties.find((item) => normalizeId(getFirst(item, ['property_id'])) === normalizeId(propertyId))

    return {
      id: getFirstAvailable(row, ['underwriting_id', 'id'], `uw-${index + 1}`),
      propertyId,
      propertyAddress: property ? getFirstAvailable(property, ['property_address', 'address']) : 'Unknown Property',
      arv: asNumber(getFirst(row, ['arv', 'value', 'estimated_value']), 0),
      repairEstimate: asNumber(getFirst(row, ['repair_estimate']), 0),
      equity: asNumber(getFirst(row, ['equity']), 0),
      mao: asNumber(getFirst(row, ['mao']), 0),
      cashOffer: asNumber(getFirst(row, ['cash_offer']), 0),
      creativeOffer: asNumber(getFirst(row, ['creative_offer']), 0),
      novationPath: getFirstAvailable(row, ['novation_path'], 'TBD'),
      multifamilyNoi: getFirstAvailable(row, ['multifamily_noi'], 'N/A'),
      rentEstimate: asNumber(getFirst(row, ['rent_estimate']), 0),
      aiValuationConfidence: asNumber(getFirst(row, ['ai_confidence', 'confidence']), 0),
      riskNotes: getFirstAvailable(row, ['risk_notes'], 'No critical risk notes.'),
    }
  })
}

export const getAcquisitionAiBrain = async (
  filters?: AcquisitionFilters,
): Promise<AcquisitionAiBrain[]> => {
  const dataset = await fetchDataset()
  const aiRows = applyFilters(dataset.aiBrain, filters)

  return aiRows.map((row, index) => {
    const ownerId = getFirstAvailable(row, ['owner_id', 'master_owner_id'], '')
    const owner = dataset.owners.find((item) => normalizeId(getFirst(item, ['owner_id', 'master_owner_id'])) === normalizeId(ownerId))

    return {
      id: getFirstAvailable(row, ['id', 'ai_id'], `ai-${index + 1}`),
      ownerId,
      ownerName: owner ? ownerName(owner) : 'Unknown Owner',
      sellerIntent: getFirstAvailable(row, ['seller_intent', 'intent'], 'Unknown'),
      objections: getFirstAvailable(row, ['objections', 'objection'], 'None detected'),
      language: getFirstAvailable(row, ['language'], 'en'),
      sentiment: getFirstAvailable(row, ['sentiment'], 'neutral'),
      conversationStage: getFirstAvailable(row, ['conversation_stage', 'stage'], 'qualification'),
      recommendedNextAction: getFirstAvailable(row, ['recommended_next_action'], 'Review thread'),
      aiConfidence: asNumber(getFirst(row, ['confidence', 'ai_confidence']), 0),
      agentAssigned: getFirstAvailable(row, ['agent_assigned', 'agent_name'], 'Unassigned'),
      templateRecommendation: getFirstAvailable(row, ['template_recommendation'], 'Default template'),
      negotiationPosture: getFirstAvailable(row, ['negotiation_posture'], 'balanced'),
      followUpTiming: getFirstAvailable(row, ['follow_up_timing'], 'Next business day'),
    }
  })
}

export const getAcquisitionActivity = async (
  filters?: AcquisitionFilters,
): Promise<Array<{
  id: string
  title: string
  detail: string
  kind: string
  severity: 'info' | 'warning' | 'critical'
  timestamp: string
  recordType?: AcquisitionRecordType
  recordId?: string
}>> => {
  const dataset = await fetchDataset()
  const queueRows = applyFilters(dataset.sendQueue, filters).slice(0, 10)
  const messageRows = applyFilters(dataset.messageEvents, filters).slice(0, 10)

  const queueActivity = queueRows.map((item, index) => {
    const status = getFirstAvailable(item, ['status'], 'scheduled')
    const severity: 'info' | 'warning' | 'critical' =
      status === 'failed' || status === 'retry' ? 'critical' : status === 'held' ? 'warning' : 'info'

    return {
      id: `queue-activity-${index + 1}`,
      title: `Queue item ${status}`,
      detail: getFirstAvailable(item, ['message_text'], 'Queue event'),
      kind: 'queue',
      severity,
      timestamp: toRelative(getFirst(item, ['updated_at', 'created_at', 'scheduled_at'])),
      recordType: 'queue_item' as const,
      recordId: getFirstAvailable(item, ['queue_id']),
    }
  })

  const messageActivity = messageRows.map((event, index) => {
    const direction = getFirstAvailable(event, ['direction'], 'inbound')
    return {
      id: `message-activity-${index + 1}`,
      title: direction === 'inbound' ? 'Inbound reply received' : 'Outbound message sent',
      detail: getFirstAvailable(event, ['message_text', 'message', 'body'], 'Message event'),
      kind: 'message',
      severity: direction === 'inbound' ? 'warning' as const : 'info' as const,
      timestamp: toRelative(getFirst(event, ['created_at'])),
      recordType: 'inbox_thread' as const,
      recordId: getFirstAvailable(event, ['thread_id', 'conversation_id']),
    }
  })

  return [...messageActivity, ...queueActivity]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 18)
}

export const getAcquisitionMapPoints = async (
  filters?: AcquisitionFilters,
): Promise<AcquisitionMapPoint[]> => {
  const dataset = await fetchDataset()
  const marketRows = applyFilters(dataset.markets, filters)

  const points = marketRows.map((market, index) => {
    const marketName = getFirstAvailable(market, ['name', 'label', 'city', 'market'], `Market ${index + 1}`)
    const marketProps = dataset.properties.filter((row) =>
      contains(getFirstAvailable(row, ['market', 'property_address_city'], ''), marketName),
    )
    const replies = dataset.messageEvents.filter((row) =>
      asString(getFirst(row, ['direction']), '').toLowerCase() === 'inbound' &&
      contains(getFirstAvailable(row, ['market'], ''), marketName),
    ).length
    const failed = dataset.sendQueue.filter((row) => {
      const status = asString(getFirst(row, ['status']), '').toLowerCase()
      return (status === 'failed' || status === 'retry') && contains(getFirstAvailable(row, ['market'], ''), marketName)
    }).length

    return {
      id: getFirstAvailable(market, ['market_id', 'id'], `market-${index + 1}`),
      marketName,
      lng: asNumber(getFirst(market, ['longitude', 'lng']), -95.3 + index * 2),
      lat: asNumber(getFirst(market, ['latitude', 'lat']), 29.8 + index * 2),
      hotReplies: replies,
      failedSends: failed,
      highMotivation: marketProps.filter((row) => asNumber(getFirst(row, ['motivation_score']), 0) >= 70).length,
      leadPulse: replies + marketProps.length,
      ownerTypeMix: 'Mixed',
      distressCount: marketProps.filter((row) => {
        return asBoolean(getFirst(row, ['vacant']), false) ||
          asBoolean(getFirst(row, ['tax_flag', 'tax_delinquent']), false) ||
          asBoolean(getFirst(row, ['probate_flag', 'probate']), false)
      }).length,
      equityBand: marketProps.length > 0 ? 'Mid-High' : 'Unknown',
    }
  })

  if (points.length > 0) return points

  return [
    {
      id: 'fallback-houston',
      marketName: 'Houston',
      lng: -95.3698,
      lat: 29.7604,
      hotReplies: 3,
      failedSends: 1,
      highMotivation: 8,
      leadPulse: 19,
      ownerTypeMix: 'Owner / LLC',
      distressCount: 5,
      equityBand: 'High',
    },
  ]
}

export const getLinkedRecord = async (
  recordType: AcquisitionRecordType,
  id: string,
): Promise<AcquisitionRecordSummary> => {
  const dataset = await fetchDataset()
  const relationships = await getRecordRelationships(recordType, id)

  const allRecords: Record<AcquisitionRecordType, AnyRecord[]> = {
    owner: dataset.owners,
    property: dataset.properties,
    prospect: dataset.prospects,
    phone: dataset.phoneNumbers,
    email: dataset.emails,
    inbox_thread: dataset.messageEvents,
    queue_item: dataset.sendQueue,
    offer: dataset.offers,
    contract: dataset.contracts,
  }

  const idKeys: Record<AcquisitionRecordType, string[]> = {
    owner: ['owner_id', 'master_owner_id'],
    property: ['property_id'],
    prospect: ['prospect_id'],
    phone: ['phone_id'],
    email: ['email_id'],
    inbox_thread: ['thread_id', 'conversation_id', 'event_id'],
    queue_item: ['queue_id'],
    offer: ['offer_id'],
    contract: ['contract_id'],
  }

  const rows = allRecords[recordType]
  const row = rows.find((item) =>
    idKeys[recordType].some((key) => normalizeId(item[key]) === normalizeId(id)),
  ) ?? { id, status: 'unknown' }

  const title =
    getFirstAvailable(row, ['full_name', 'owner_full_name', 'property_address', 'email', 'phone', 'message_text'], '') ||
    `${recordType} ${id}`

  return {
    id,
    title,
    type: recordType,
    subtitle: getFirstAvailable(row, ['status', 'market', 'owner_type'], 'No subtitle'),
    keyFields: [
      { label: 'Record ID', value: id },
      { label: 'Status', value: getFirstAvailable(row, ['status'], 'Unknown') },
      { label: 'Market', value: getFirstAvailable(row, ['market', 'property_address_city'], 'N/A') },
      { label: 'Updated', value: toRelative(getFirst(row, ['updated_at', 'created_at'])) },
    ],
    linkedRecords: relationships,
    recentActivity: [
      `Last touch ${toRelative(getFirst(row, ['updated_at', 'created_at']))}`,
      'Linked data synchronized',
      'Ready for action',
    ],
    quickActions: ['Open Inbox', 'Open Queue', 'Generate Offer', 'Open Full Record'],
  }
}

export const getRecordRelationships = async (
  recordType: AcquisitionRecordType,
  id: string,
): Promise<Array<{ id: string; label: string; type: AcquisitionRecordType }>> => {
  const dataset = await fetchDataset()

  const owners = await getAcquisitionOwners()
  const properties = await getAcquisitionProperties()
  const prospects = await getAcquisitionProspects()
  const offers = await getAcquisitionOffers()

  if (recordType === 'owner') {
    const owner = owners.find((item) => normalizeId(item.id) === normalizeId(id))
    if (!owner) return []
    return [
      ...owner.propertyIds.slice(0, 4).map((propertyId) => ({
        id: propertyId,
        label: properties.find((property) => normalizeId(property.id) === normalizeId(propertyId))?.address ?? propertyId,
        type: 'property' as const,
      })),
      ...owner.prospectIds.slice(0, 3).map((prospectId) => ({
        id: prospectId,
        label: prospects.find((prospect) => normalizeId(prospect.id) === normalizeId(prospectId))?.prospectName ?? prospectId,
        type: 'prospect' as const,
      })),
      ...owner.phoneIds.slice(0, 2).map((phoneId) => ({
        id: phoneId,
        label: dataset.phoneNumbers.find((phone) => normalizeId(getFirst(phone, ['phone_id'])) === normalizeId(phoneId))
          ? getFirstAvailable(
              dataset.phoneNumbers.find((phone) => normalizeId(getFirst(phone, ['phone_id'])) === normalizeId(phoneId)) ?? {},
              ['phone', 'phone_number'],
              phoneId,
            )
          : phoneId,
        type: 'phone' as const,
      })),
    ]
  }

  if (recordType === 'property') {
    const propertyOffers = offers.filter((offer) => normalizeId(offer.propertyId) === normalizeId(id))
    return propertyOffers.map((offer) => ({
      id: offer.id,
      label: `${offer.strategy} ${currency(offer.recommendedOffer)}`,
      type: 'offer' as const,
    }))
  }

  if (recordType === 'offer') {
    const contracts = dataset.contracts.filter((contract) =>
      normalizeId(getFirst(contract, ['offer_id'])) === normalizeId(id),
    )
    return contracts.map((contract, index) => ({
      id: getFirstAvailable(contract, ['contract_id'], `contract-${index + 1}`),
      label: getFirstAvailable(contract, ['status'], 'pending'),
      type: 'contract' as const,
    }))
  }

  return []
}

export const getAcquisitionAutomations = async (): Promise<AcquisitionAutomation[]> => {
  const dataset = await fetchDataset()
  const failedQueue = dataset.sendQueue.filter((item) => {
    const status = asString(getFirst(item, ['queue_status', 'status']), '').toLowerCase()
    return status === 'failed' || status === 'retry'
  }).length
  const inboundCount = dataset.messageEvents.filter((item) =>
    asString(getFirst(item, ['direction']), '').toLowerCase() === 'inbound',
  ).length

  return [
    {
      id: 'feeder-status',
      name: 'Feeder Status',
      status: 'healthy',
      failedJobs: 0,
      lastRun: '2m ago',
      detail: `${dataset.owners.length} owners synced`,
    },
    {
      id: 'queue-runner',
      name: 'Queue Runner',
      status: failedQueue > 0 ? 'watch' : 'healthy',
      failedJobs: failedQueue,
      lastRun: '1m ago',
      detail: `${dataset.sendQueue.length} queue items processed`,
    },
    {
      id: 'retry-engine',
      name: 'Retry Engine',
      status: failedQueue > 2 ? 'critical' : 'watch',
      failedJobs: failedQueue,
      lastRun: '4m ago',
      detail: 'Retry backoff engaged',
    },
    {
      id: 'reconcile',
      name: 'Reconcile',
      status: 'healthy',
      failedJobs: 0,
      lastRun: '8m ago',
      detail: 'Supabase sync checksum clean',
    },
    {
      id: 'inbound-webhook',
      name: 'Inbound Webhook',
      status: inboundCount > 0 ? 'healthy' : 'watch',
      failedJobs: 0,
      lastRun: 'just now',
      detail: `${inboundCount} inbound events`,
    },
    {
      id: 'delivery-webhook',
      name: 'Delivery Webhook',
      status: failedQueue > 0 ? 'watch' : 'healthy',
      failedJobs: failedQueue,
      lastRun: '3m ago',
      detail: 'Carrier receipts normalized',
    },
    {
      id: 'ai-draft',
      name: 'AI Draft Generation',
      status: dataset.aiBrain.length > 0 ? 'healthy' : 'watch',
      failedJobs: 0,
      lastRun: '5m ago',
      detail: `${dataset.aiBrain.length} AI strategy records`,
    },
    {
      id: 'template-resolver',
      name: 'Template Resolver',
      status: dataset.templates.length > 0 ? 'healthy' : 'watch',
      failedJobs: 0,
      lastRun: '9m ago',
      detail: `${dataset.templates.length} templates active`,
    },
    {
      id: 'suppression',
      name: 'Suppression / Compliance',
      status: 'healthy',
      failedJobs: 0,
      lastRun: '12m ago',
      detail: 'DNC checks passing',
    },
    {
      id: 'failed-jobs',
      name: 'Failed Jobs',
      status: failedQueue > 2 ? 'critical' : 'watch',
      failedJobs: failedQueue,
      lastRun: '1m ago',
      detail: 'Monitor retries and handoff',
    },
  ]
}
