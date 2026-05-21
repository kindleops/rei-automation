import type {
  ConversationThread,
  DealStage,
  DossierModel,
  LeadStage,
  OwnerType,
  SellerDossier,
  Temperature,
} from '../../modules/dossier/dossier.types'
import { getSupabaseClient } from '../supabaseClient'
import {
  asIso,
  asNumber,
  asString,
  getFirst,
  mapErrorMessage,
  normalizeStatus,
  safeArray,
  type AnyRecord,
} from './shared'

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value))

const toOwnerType = (value: unknown): OwnerType => {
  const normalized = normalizeStatus(value)
  if (normalized === 'corporation' || normalized === 'corporate') return 'corporation'
  if (normalized === 'trust') return 'trust'
  if (normalized === 'entity_llc') return 'entity_llc'
  if (normalized === 'entity_partnership') return 'entity_partnership'
  if (normalized === 'nonprofit') return 'nonprofit'
  if (normalized === 'entity' || normalized === 'llc' || normalized === 'company') return 'entity'
  return 'individual'
}

const toLeadStage = (value: unknown): LeadStage => {
  const normalized = normalizeStatus(value)
  if (normalized === 'prospect') return 'prospect'
  if (normalized === 'contacted') return 'contacted'
  if (normalized === 'engaged') return 'engaged'
  if (normalized === 'negotiating') return 'negotiating'
  if (normalized === 'offer_sent') return 'offer_sent'
  if (normalized === 'deal_pending') return 'deal_pending'
  if (normalized === 'closed') return 'closed'
  return 'prospect'
}

const toDealStage = (value: unknown): DealStage => {
  const normalized = normalizeStatus(value)
  if (normalized === 'preliminary') return 'preliminary'
  if (normalized === 'offer_generated') return 'offer_generated'
  if (normalized === 'offer_sent') return 'offer_sent'
  if (normalized === 'offer_accepted') return 'offer_accepted'
  if (normalized === 'contract_pending') return 'contract_pending'
  if (normalized === 'title_open') return 'title_open'
  if (normalized === 'closing') return 'closing'
  return 'no_deal'
}

const tempFromScore = (score: number): Temperature => {
  if (score >= 75) return 'hot'
  if (score >= 45) return 'warm'
  return 'cold'
}

export const fetchDossierModel = async (): Promise<DossierModel> => {
  const supabase = getSupabaseClient()

  const [ownerResult, propertyResult, phoneResult, emailResult, prospectResult, messageResult] =
    await Promise.all([
      supabase
        .from('owners')
        .select('owner_id,master_owner_id,first_name,last_name,full_name,entity_name,owner_type,market,city,state,status,priority,motivation_score,ai_score,risk_score,created_at,updated_at')
        .order('updated_at', { ascending: false })
        .limit(800),
      supabase
        .from('properties')
        .select('property_id,owner_id,master_owner_id,market,property_address,property_address_city,property_address_state,zip,estimated_value,equity,motivation_score,priority_score,status,property_type,beds,baths,sqft,year_built')
        .limit(2400),
      supabase
        .from('phone_numbers')
        .select('phone_id,owner_id,master_owner_id,phone,phone_number,type,status,created_at')
        .limit(2400),
      supabase
        .from('emails')
        .select('email_id,owner_id,master_owner_id,email,status,created_at')
        .limit(2400),
      supabase
        .from('prospects')
        .select('prospect_id,owner_id,master_owner_id,lead_stage,seller_stage,status,priority,updated_at')
        .limit(2400),
      supabase
        .from('message_events')
        .select('event_id,thread_id,conversation_id,owner_id,master_owner_id,direction,sentiment,body,message,message_text,created_at')
        .order('created_at', { ascending: false })
        .limit(3000),
    ])

  if (ownerResult.error) throw new Error(mapErrorMessage(ownerResult.error))
  if (propertyResult.error) throw new Error(mapErrorMessage(propertyResult.error))
  if (phoneResult.error) throw new Error(mapErrorMessage(phoneResult.error))
  if (emailResult.error) throw new Error(mapErrorMessage(emailResult.error))
  if (prospectResult.error) throw new Error(mapErrorMessage(prospectResult.error))
  if (messageResult.error) throw new Error(mapErrorMessage(messageResult.error))

  const owners = safeArray(ownerResult.data as AnyRecord[])
  const properties = safeArray(propertyResult.data as AnyRecord[])
  const phones = safeArray(phoneResult.data as AnyRecord[])
  const emails = safeArray(emailResult.data as AnyRecord[])
  const prospects = safeArray(prospectResult.data as AnyRecord[])
  const events = safeArray(messageResult.data as AnyRecord[])

  const propertiesByOwner = new Map<string, AnyRecord[]>()
  for (const row of properties) {
    const ownerId = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    if (!ownerId) continue
    const bucket = propertiesByOwner.get(ownerId) ?? []
    bucket.push(row)
    propertiesByOwner.set(ownerId, bucket)
  }

  const phonesByOwner = new Map<string, AnyRecord[]>()
  for (const row of phones) {
    const ownerId = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    if (!ownerId) continue
    const bucket = phonesByOwner.get(ownerId) ?? []
    bucket.push(row)
    phonesByOwner.set(ownerId, bucket)
  }

  const emailsByOwner = new Map<string, AnyRecord[]>()
  for (const row of emails) {
    const ownerId = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    if (!ownerId) continue
    const bucket = emailsByOwner.get(ownerId) ?? []
    bucket.push(row)
    emailsByOwner.set(ownerId, bucket)
  }

  const prospectsByOwner = new Map<string, AnyRecord>()
  for (const row of prospects) {
    const ownerId = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    if (!ownerId || prospectsByOwner.has(ownerId)) continue
    prospectsByOwner.set(ownerId, row)
  }

  const eventsByOwner = new Map<string, AnyRecord[]>()
  for (const row of events) {
    const ownerId = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    if (!ownerId) continue
    const bucket = eventsByOwner.get(ownerId) ?? []
    bucket.push(row)
    eventsByOwner.set(ownerId, bucket)
  }

  const sellers: SellerDossier[] = owners.map((owner, index) => {
    const ownerId = asString(getFirst(owner, ['owner_id', 'master_owner_id']), `owner-${index + 1}`)
    const firstName = asString(getFirst(owner, ['first_name']), 'Unknown')
    const lastName = asString(getFirst(owner, ['last_name']), 'Owner')
    const fullName = asString(
      getFirst(owner, ['full_name']),
      `${firstName} ${lastName}`.trim(),
    )

    const ownerProperties = propertiesByOwner.get(ownerId) ?? []
    const ownerPhones = phonesByOwner.get(ownerId) ?? []
    const ownerEmails = emailsByOwner.get(ownerId) ?? []
    const ownerProspect = prospectsByOwner.get(ownerId)
    const ownerEvents = eventsByOwner.get(ownerId) ?? []

    const aiScore = clamp(asNumber(getFirst(owner, ['ai_score']), 58))
    const motivationScore = clamp(asNumber(getFirst(owner, ['motivation_score']), 52))
    const riskScore = clamp(asNumber(getFirst(owner, ['risk_score']), 34))

    const temperature = tempFromScore(motivationScore)
    const priority =
      motivationScore >= 75
        ? 'high'
        : motivationScore >= 45
          ? 'medium'
          : 'low'

    const totalValue = ownerProperties.reduce(
      (sum, property) => sum + asNumber(getFirst(property, ['estimated_value']), 0),
      0,
    )
    const totalEquity = ownerProperties.reduce(
      (sum, property) => sum + asNumber(getFirst(property, ['equity']), 0),
      0,
    )

    const conversations: ConversationThread[] = ownerEvents.slice(0, 2).map((row, rowIndex) => {
      const direction = normalizeStatus(getFirst(row, ['direction']))
      const sentiment = normalizeStatus(getFirst(row, ['sentiment']))
      return {
        threadId: asString(
          getFirst(row, ['thread_id', 'conversation_id']),
          `${ownerId}-thread-${rowIndex + 1}`,
        ),
        channel: 'sms',
        lastMessage: asString(getFirst(row, ['body', 'message', 'message_text']), 'No message body'),
        lastMessageAt: asIso(getFirst(row, ['created_at'])) ?? new Date().toISOString(),
        sentiment:
          sentiment === 'positive'
            ? 'positive'
            : sentiment === 'negative'
              ? 'negative'
              : sentiment === 'interested'
                ? 'interested'
                : sentiment === 'objection'
                  ? 'objection'
                  : 'neutral',
        stage: toLeadStage(getFirst(ownerProspect ?? owner, ['lead_stage', 'status'])),
        nextAction: direction === 'inbound' ? 'Send response' : 'Follow up',
        aiSummary: 'Conversation synced from Supabase message events.',
      }
    })

    const timeline = ownerEvents.slice(0, 6).map((row, rowIndex) => ({
      id: asString(getFirst(row, ['event_id']), `${ownerId}-event-${rowIndex + 1}`),
      type: 'message_event',
      label: normalizeStatus(getFirst(row, ['direction'])) === 'inbound' ? 'Inbound message' : 'Outbound message',
      timestamp: asIso(getFirst(row, ['created_at'])) ?? new Date().toISOString(),
      source: 'supabase',
      description: asString(getFirst(row, ['body', 'message', 'message_text']), 'Message event'),
      severity: 'medium' as const,
    }))

    return {
      id: ownerId,
      masterOwnerId: ownerId,
      masterKey: ownerId,
      displayName: fullName,
      firstName,
      lastName,
      entityName: asString(getFirst(owner, ['entity_name']), '') || undefined,
      ownerType: toOwnerType(getFirst(owner, ['owner_type'])),
      ownerAddress:
        asString(getFirst(ownerProperties[0] ?? owner, ['property_address', 'address']), '') ||
        'Address unavailable',
      mailingCity: asString(getFirst(owner, ['city']), 'Unknown'),
      mailingState: asString(getFirst(owner, ['state']), 'NA'),
      mailingZip: asString(getFirst(ownerProperties[0] ?? owner, ['zip']), '00000'),
      outOfStateOwner: false,
      corporateOwner: toOwnerType(getFirst(owner, ['owner_type'])) !== 'individual',
      trustEstate: toOwnerType(getFirst(owner, ['owner_type'])) === 'trust',
      hedgeFundMatch: false,
      language: 'english',
      contactProbability: clamp(100 - riskScore),
      preferredChannel: 'sms',
      bestContactTime: 'afternoon',
      market: asString(getFirst(owner, ['market']), 'Unknown'),
      status: asString(getFirst(owner, ['status']), 'active'),
      temperature,
      priority,
      aiScore,
      motivationScore,
      riskScore,
      portfolioValue: totalValue,
      estimatedEquity: totalEquity,
      propertyCount: ownerProperties.length,
      linkedProspectsCount: ownerProspect ? 1 : 0,
      linkedPhoneCount: ownerPhones.length,
      linkedEmailCount: ownerEmails.length,
      phones: ownerPhones.map((row, rowIndex) => ({
        id: asString(getFirst(row, ['phone_id']), `${ownerId}-phone-${rowIndex + 1}`),
        phone: asString(getFirst(row, ['phone', 'phone_number']), ''),
        type: 'mobile',
        status: normalizeStatus(getFirst(row, ['status'])) === 'verified' ? 'verified' : 'unverified',
        dncStatus: 'active',
        confidence: 80,
      })),
      emails: ownerEmails.map((row, rowIndex) => ({
        id: asString(getFirst(row, ['email_id']), `${ownerId}-email-${rowIndex + 1}`),
        email: asString(getFirst(row, ['email']), ''),
        role: 'owner',
        status: normalizeStatus(getFirst(row, ['status'])) === 'verified' ? 'verified' : 'unverified',
        confidence: 80,
      })),
      properties: ownerProperties.map((row, rowIndex) => {
        const equity = asNumber(getFirst(row, ['equity']), 0)
        const value = asNumber(getFirst(row, ['estimated_value']), 0)
        return {
          propertyId: asString(getFirst(row, ['property_id']), `${ownerId}-property-${rowIndex + 1}`),
          address: asString(getFirst(row, ['property_address']), 'Address unavailable'),
          city: asString(getFirst(row, ['property_address_city', 'city']), 'Unknown'),
          state: asString(getFirst(row, ['property_address_state', 'state']), 'NA'),
          zip: asString(getFirst(row, ['zip', 'zipcode']), '00000'),
          propertyType: 'single_family' as const,
          beds: asNumber(getFirst(row, ['beds']), undefined),
          baths: asNumber(getFirst(row, ['baths']), undefined),
          sqft: asNumber(getFirst(row, ['sqft']), undefined),
          yearBuilt: asNumber(getFirst(row, ['year_built']), undefined),
          estimatedValue: value,
          equity,
          mortgageBalance: Math.max(value - equity, 0),
          absentee: false,
          vacant: false,
          taxDelinquent: false,
          probate: false,
          foreclosure: false,
          freeAndClear: value > 0 && equity >= value,
          highEquity: value > 0 ? equity / value >= 0.6 : false,
          tiredLandlord: false,
          distressSignals: [],
          aiPropertyScore: clamp(asNumber(getFirst(row, ['motivation_score', 'priority_score']), 55)),
          recommendedStrategy: 'cash_offer',
        }
      }),
      conversations,
      timeline,
      leadStage: toLeadStage(getFirst(ownerProspect ?? owner, ['lead_stage', 'status'])),
      sellerStage: toDealStage(getFirst(ownerProspect ?? owner, ['seller_stage', 'status'])),
      offerStatus: 'none',
      recommendedCashOffer:
        ownerProperties.length > 0
          ? Math.round(totalValue * 0.72)
          : undefined,
      creativeOfferEligible: motivationScore >= 50,
      multifamilyUnderwriteRequired: false,
      contractStatus: 'none',
      titleStatus: 'clear',
      closingStatus: 'none',
      buyerMatchStatus: 'pending',
      nextBestAction: conversations.some((c) => c.stage === 'engaged') ? 'Generate offer' : 'Send SMS',
      nextBestActionReason: 'Live owner profile and recent communication activity from Supabase.',
      aiConfidence: clamp(Math.round((aiScore + motivationScore) / 2)),
    }
  })

  const hotCount = sellers.filter((s) => s.temperature === 'hot').length
  const portfolioCount = sellers.filter((s) => s.propertyCount > 1).length
  const needsAction = sellers.filter((s) => s.priority === 'high').length
  const averageMotivationScore =
    sellers.length > 0
      ? Math.round(sellers.reduce((sum, seller) => sum + seller.motivationScore, 0) / sellers.length)
      : 0

  return {
    sellers,
    stats: {
      totalOwners: sellers.length,
      hotSellers: hotCount,
      portfolioOwners: portfolioCount,
      needsAction,
      averageMotivationScore,
    },
  }
}
