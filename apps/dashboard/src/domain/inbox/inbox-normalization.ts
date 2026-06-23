import { asString } from '../../lib/data/shared'
import type { ThreadMessage, ThreadIntelligenceRecord } from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

const GOOGLE_MAPS_API_KEY = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY

export interface NormalizedPropertySnapshot {
  // Property Identity
  fullAddress: string
  city: string
  state: string
  zip: string
  market: string
  propertyType: string
  propertyClass: string
  propertyStyle: string
  streetViewUrl: string | null
  aerialViewUrl: string | null
  streetviewImage?: string // alias for streetview_image
  
  // Structural
  beds: string
  baths: string
  sqft: string
  yearBuilt: string
  effectiveYear: string
  unitCount: string
  lotSize: string
  lotSizeAcres: string
  zoning: string
  occupancy: string

  // Valuation & Financial
  estimatedValue: string
  repairCost: string
  cashOffer: string
  finalScore: string
  equityPercent: string
  equityAmount: string
  loanAmount: string
  loanBalance: string
  loanPayment: string
  assessedTotalValue: string
  assessedLandValue: string
  assessedImprovementValue: string
  taxDelinquent: string
  taxAmount: string
  
  // Owner & Prospect
  ownerName: string
  ownerDisplayName: string
  ownerType: string
  priorityTier: string
  language: string
  bestContactWindow: string
  prospectFullName: string
  prospectFirstName: string
  householdIncome: string
  netAssetValue: string
  occupationGroup: string
  phoneCarrier: string
  gender: string
  ownerAddress: string
  portfolioPropertyCount: string
  sfrCount: string
  mfCount: string
  portfolioValue: string
  financialScore: string
  urgencyCount: string
  taxDelinquentCount: string
  lienCount: string
  oldestTaxYear: string

  // Automation & Intent
  uiIntent: string
  automationState: string
  nextSystemAction: string
  detectedIntent: string
  safetyStatus: string
  routingAllowed: string
  
  // Meta
  floodZone: string
  ownershipYears: string
}


export interface ExternalLinks {
  zillow: string | null
  realtor: string | null
  googleSearch: string | null
  streetView: string | null
}

/**
 * Build consistent external links for a property address.
 */
export const buildPropertyExternalLinks = (address: string | null): ExternalLinks => {
  if (!address || address.length < 5) {
    return { zillow: null, realtor: null, googleSearch: null, streetView: null }
  }
  const encoded = encodeURIComponent(address)
  return {
    zillow: `https://www.zillow.com/homes/${encoded}_rb/`,
    realtor: `https://www.realtor.com/realestateandhomes-search/${encoded}`,
    googleSearch: `https://www.google.com/search?q=${encoded}`,
    streetView: `https://www.google.com/maps/search/?api=1&query=${encoded}`,
  }
}

/**
 * Build Google Street View API URL. Prefers lat/lng coordinates over address string.
 */
export const buildStreetViewUrl = (
  address: string | null,
  lat?: number | null,
  lng?: number | null,
): string | null => {
  const apiKey = GOOGLE_MAPS_API_KEY || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.001 && Math.abs(Number(lng)) > 0.001
  const location = hasCoords ? `${lat},${lng}` : (address ? encodeURIComponent(address) : null)
  if (!location) return null
  console.debug('[GOOGLE_MAP_SOURCE]', { source: hasCoords ? 'coords' : 'address', lat, lng, address })
  return `https://maps.googleapis.com/maps/api/streetview?size=600x300&location=${location}&fov=70&key=${apiKey}`
}

export const buildAerialViewUrl = (
  address: string | null,
  lat?: number | null,
  lng?: number | null,
): string | null => {
  const apiKey = GOOGLE_MAPS_API_KEY || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.001 && Math.abs(Number(lng)) > 0.001
  const center = hasCoords ? `${lat},${lng}` : (address ? encodeURIComponent(address) : null)
  if (!center) return null
  console.debug('[GOOGLE_MAP_SOURCE]', { source: hasCoords ? 'coords' : 'address', lat, lng, address })
  return `https://maps.googleapis.com/maps/api/staticmap?size=600x300&maptype=satellite&scale=2&zoom=19&center=${center}&key=${apiKey}`
}

/**
 * Normalize raw intelligence data into a structured property snapshot.
 */
export const normalizePropertySnapshot = (
  intelligence: ThreadIntelligenceRecord | null,
  thread: InboxWorkflowThread | null,
  dossier?: import('../../lib/data/threadDossier').ThreadDossier | null
): NormalizedPropertySnapshot => {
  const get = (key: string, aliases: string[] = []) => {
    let val: any
    
    // 1. Check Dossier (most authoritative)
    if (dossier) {
      val = dossier.prospect?.[key] ?? dossier.master_owner?.[key] ?? dossier.property?.[key] ?? dossier.inbox_thread_state?.[key]
      if (val === undefined || val === null || val === '') {
        for (const alias of aliases) {
          val = dossier.prospect?.[alias] ?? dossier.master_owner?.[alias] ?? dossier.property?.[alias] ?? dossier.inbox_thread_state?.[alias]
          if (val !== undefined && val !== null && val !== '') break
        }
      }
    }

    // 2. Check Intelligence
    if (val === undefined || val === null || val === '') {
      val = intelligence?.[key]
      if (val === undefined || val === null || val === '') {
        for (const alias of aliases) {
          val = intelligence?.[alias]
          if (val !== undefined && val !== null && val !== '') break
        }
      }
    }
    
    // 3. Check Thread
    if (val === undefined || val === null || val === '') {
      val = (thread as any)?.[key]
      if (val === undefined || val === null || val === '') {
        for (const alias of aliases) {
          val = (thread as any)?.[alias]
          if (val !== undefined && val !== null && val !== '') break
        }
      }
    }
    return asString(val, '').trim()
  }

  const threadAddress = thread?.propertyAddressFull || thread?.propertyAddress || thread?.subject
  const intelligenceAddress = get('property_address_full', ['address'])
  const ownerAddressFallback = get('owner_mailing_address', ['mailing_address', 'owner_address'])
  
  const address = (threadAddress || intelligenceAddress || ownerAddressFallback || '').trim()
  
  return {
    // Property Identity
    fullAddress: address,
    city: get('property_address_city', ['property_city', 'city']),
    state: get('property_address_state', ['property_state', 'state']),
    zip: get('property_address_zip', ['property_zip', 'zip']),
    market: get('market', ['market_id']) || thread?.market || '',
    propertyType: get('property_type', ['propertyType']),
    propertyClass: get('property_class', ['propertyClass']),
    propertyStyle: get('property_style', ['propertyStyle']),
    streetViewUrl: buildStreetViewUrl(address),
    aerialViewUrl: buildAerialViewUrl(address),
    streetviewImage: get('streetview_image'),

    // Structural
    beds: get('beds', ['bedrooms']),
    baths: get('baths', ['bathrooms']),
    sqft: get('sqft', ['living_area_sqft', 'livingAreaSqft']),
    yearBuilt: get('year_built', ['yearBuilt']),
    effectiveYear: get('effective_year_built', ['effectiveYear']),
    unitCount: get('units', ['number_of_units', 'unit_count']),
    lotSize: get('lot_size_square_feet', ['lot_size_sqft']),
    lotSizeAcres: get('lot_size_acres'),
    zoning: get('zoning', ['zoning_code']),
    occupancy: get('occupancy'),

    // Valuation & Financial
    estimatedValue: get('estimated_value', ['estimatedValue', 'zestimate']),
    repairCost: get('estimated_repair_cost', ['repairCost', 'estimatedRepairCost']),
    cashOffer: get('cash_offer', ['cashOffer', 'mao']),
    finalScore: get('final_acquisition_score', ['finalScore', 'finalAcquisitionScore']),
    equityPercent: get('equity_percent', ['equityPercent']),
    equityAmount: get('equity_amount', ['estimated_equity_amount', 'equityAmount']),
    loanAmount: get('loan_amount'),
    loanBalance: get('loan_balance'),
    loanPayment: get('loan_payment'),
    assessedTotalValue: get('assessed_total_value'),
    assessedLandValue: get('assessed_land_value'),
    assessedImprovementValue: get('assessed_improvement_value'),
    taxDelinquent: get('tax_delinquent'),
    taxAmount: get('tax_amount'),
    
    // Owner & Prospect
    ownerName: get('owner_full_name', ['owner_name', 'ownerName']),
    ownerDisplayName: get('owner_display_name', ['ownerDisplayName']),
    ownerType: get('owner_type_guess', ['owner_type', 'ownerType']),
    priorityTier: get('owner_priority_tier', ['priority_tier']),
    language: get('best_language', ['language', 'contactLanguage']),
    bestContactWindow: get('best_contact_window'),
    prospectFullName: get('prospect_full_name'),
    prospectFirstName: get('prospect_first_name'),
    householdIncome: get('est_household_income', ['household_income', 'householdIncome']),
    netAssetValue: get('net_asset_value', ['netAssetValue']),
    occupationGroup: get('occupation_group'),
    phoneCarrier: get('phone_carrier'),
    gender: get('gender'),
    ownerAddress: get('primary_owner_address', ['owner_address', 'mailing_address']),
    portfolioPropertyCount: get('property_count', ['portfolio_property_count']),
    sfrCount: get('sfr_count'),
    mfCount: get('mf_count'),
    portfolioValue: get('portfolio_total_value', ['portfolioValue']),
    financialScore: get('financial_pressure_score', ['financialScore']),
    urgencyCount: get('urgency_count', ['urgency_score']),
    taxDelinquentCount: get('tax_delinquent_count', ['portfolio_tax_delinquent_count']),
    lienCount: get('active_lien_count', ['portfolio_lien_count']),
    oldestTaxYear: get('oldest_tax_delinquent_year', ['oldestTaxYear']),

    // Automation & Intent
    uiIntent: get('ui_intent', ['uiIntent']),
    automationState: get('automation_state', ['automationState']),
    nextSystemAction: get('next_system_action', ['nextSystemAction']),
    detectedIntent: get('detected_intent', ['detectedIntent']),
    safetyStatus: get('safety_status'),
    routingAllowed: get('routing_allowed'),
    
    // Meta
    floodZone: get('flood_zone'),
    ownershipYears: get('ownership_years'),
  }
}



/**
 * Normalizes a thread message, ensuring delivery status and direction are canonical.
 */
export const normalizeThreadMessage = (message: ThreadMessage): ThreadMessage => {
  const status = String(message.deliveryStatus || message.rawStatus || 'unknown').toLowerCase()
  
  // Map various provider statuses to our canonical set: queued, pending, sent, delivered, failed
  let deliveryStatus = 'pending'
  if (status.includes('deliver')) deliveryStatus = 'delivered'
  else if (status.includes('sent') || status === 'success') deliveryStatus = 'sent'
  else if (status.includes('fail') || status.includes('undeliv')) deliveryStatus = 'failed'
  else if (status.includes('queue')) deliveryStatus = 'queued'
  else if (status === 'pending') deliveryStatus = 'pending'

  return {
    ...message,
    deliveryStatus
  }
}
