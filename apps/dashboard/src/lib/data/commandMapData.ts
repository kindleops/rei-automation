import { getSupabaseClient } from '../supabaseClient'
import {
  COMMAND_MAP_PROPERTY_DOSSIER_SELECT,
  COMMAND_MAP_PROPERTY_PEEK_SELECT,
} from '../../views/map/seller-card/seller-property-dossier-select'

export type SoldCompFilters = {
  monthsBack?: number
  assetClass?: string
  minSalePrice?: number
  maxSalePrice?: number
  beds?: number
  baths?: number
  sqftRange?: [number, number]
  yearBuiltBucket?: string
  selectedMarket?: string
  selectedState?: string
  selectedZip?: string
  limit?: number
}

export type RecentSoldComp = {
  property_id: string
  property_address_full: string
  property_address_city: string
  property_address_state: string
  property_address_zip: string
  latitude: number
  longitude: number
  mls_sold_price: number | null
  mls_sold_date: string | null
  sale_price: number | null
  sale_date: string | null
  owner_name: string | null
  is_corporate_owner: boolean | null
  property_type: string | null
  normalized_asset_class: string | null
  building_condition: string | null
  construction_type: string | null
  property_class: string | null
  total_bedrooms: number | null
  total_baths: number | null
  building_square_feet: number | null
  year_built: number | null
  renovation_level_classification: string | null
  comp_search_profile_hash: string | null
  comp_confidence_score: number | null
  deal_grade: string | null
  streetview_image: string | null
  satellite_image: string | null
  arv_estimate: number | null
  arv_ppsf: number | null
  potential_spread: number | null
  target_margin_percent: number | null
  computed_ppsf: number | null
  property_flags_text?: string | null
  units_count?: number | null
  lot_square_feet?: number | null
  lot_acreage?: number | null
  effective_year_built?: number | null
  sale_source?: string | null
  owner_type_label?: string | null
  buyer_type_label?: string | null
  buyer_type_confidence?: string | null
  is_institutional_buyer?: boolean | null
  institutional_match_name?: string | null
  institutional_match_method?: string | null
  institutional_match_confidence?: string | null
  estimated_value?: number | null
  price_off_value?: number | null
  percent_off?: number | null
  ppu?: number | null
  ppbd?: number | null
  distance_miles?: number | null
  similarity_score?: number | null
}

export type CommandMapSellerPin = {
  property_id: string
  master_owner_id?: string | null
  prospect_id?: string | null
  thread_key?: string | null
  lat: number
  lng: number
  latitude?: number | null
  longitude?: number | null
  seller_name: string | null
  seller_display_name?: string | null
  property_address_full: string | null
  property_address?: string | null
  property_address_city?: string | null
  property_address_state?: string | null
  property_address_zip?: string | null
  market?: string | null
  filter_market?: string | null
  owner_type: string | null
  owner_display_name?: string | null
  owner_name?: string | null
  owner_full_name?: string | null
  entity_name?: string | null
  property_type: string | null
  asset_class?: string | null
  total_bedrooms: number | null
  total_baths: number | null
  building_square_feet: number | null
  units_count: number | null
  year_built: number | null
  lot_square_feet?: number | null
  lot_acreage?: number | null
  estimated_value: number | null
  equity_amount?: number | null
  equity_percent: number | null
  estimated_repair_cost: number | null
  motivation_score: number | null
  final_acquisition_score?: number | null
  priority_score?: number | null
  owner_priority_score?: number | null
  owner_priority_tier?: string | null
  lifecycle_stage?: string | null
  operational_status?: string | null
  lead_temperature?: string | null
  contactability_status?: string | null
  mailing_address_full?: string | null
  owner_mailing_address?: string | null
  effective_year_built?: number | null
  construction_type?: string | null
  building_condition?: string | null
  stories?: number | null
  zoning?: string | null
  land_use?: string | null
  ownership_years?: number | null
  tax_delinquent?: boolean | null
  absentee_owner?: boolean | null
  out_of_state_owner?: boolean | null
  active_lien?: boolean | null
  mortgage_balance?: number | null
  loan_count?: number | null
  loan_type?: string | null
  assessed_total_value?: number | null
  assessed_land_value?: number | null
  assessed_improvement_value?: number | null
  annual_taxes?: number | null
  last_sale_amount?: number | null
  last_sale_date?: string | null
  last_inbound_text?: string | null
  last_inbound_at?: string | null
  last_outbound_text?: string | null
  last_outbound_at?: string | null
  delivery_status?: string | null
  suppression_reason?: string | null
  campaign_name?: string | null
  automation_state?: string | null
  follow_up_due_at?: string | null
  next_action_at?: string | null
  canonical_e164?: string | null
  seller_phone?: string | null
  prospect_best_phone?: string | null
  display_phone?: string | null
  best_language?: string | null
  property_count?: number | null
  portfolio_total_value?: number | null
  portfolio_total_equity?: number | null
  portfolio_total_loan_balance?: number | null
  portfolio_total_tax_amount?: number | null
  portfolio_total_units?: number | null
  prospect_language_preference?: string | null
  property_tags_text: string | null
  property_tags_json: unknown | null
  podio_tags?: unknown
  property_flags_text?: string | null
  property_flags_json?: unknown
  latest_message_at: string | null
  latest_direction: string | null
  seller_state: string | null
  seller_status?: string | null
  execution_state: string | null
  inbox_category?: string | null
  inbound_count?: number | null
  outbound_count?: number | null
  queued_count: number | null
  scheduled_count: number | null
  ready_count: number | null
  sent_count: number | null
  delivered_count: number | null
  next_scheduled_for: string | null
  pin_color: string | null
  pin_shape: string | null
  pulse_style: string | null
  execution_ring_color: string | null
  render_priority: number | null
  streetview_image?: string | null
  map_image?: string | null
  satellite_image?: string | null
  dossier_hydrated?: boolean | null
}

type MapBounds = {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

export type CommandMapDossierMode = 'peek' | 'focus'

type DetailLookupOptions = {
  signal?: AbortSignal
  threadKey?: string | null
  masterOwnerId?: string | null
  prospectId?: string | null
  dossierMode?: CommandMapDossierMode
}

const INSTITUTIONAL_NAMES = [
  'INVITATION HOMES',
  'IH6',
  'IH5',
  'IH4',
  'STARWOOD',
  'TRICON',
  'FIRSTKEY',
  'AMHERST',
  'PROGRESS RESIDENTIAL',
  'PRETIUM',
  'MAIN STREET RENEWAL',
  'MAYMONT HOMES',
  'SECOND AVENUE',
  'HOME PARTNERS OF AMERICA',
  'OPENDOOR',
  'OFFERPAD',
  'AMERICAN HOMES 4 RENT',
  'AH4R',
  'ROOFSTOCK',
  'RESICAP',
  'CERBERUS',
  'BLACKSTONE',
  'SFR3',
  'VINEBROOK',
  'WEDGEWOOD',
  'SUNDAE',
  'ENTERA',
  'MYND',
  'DIVVY',
  'REALPHA',
  'SYLVAN HOMES',
  'RENU PROPERTY MANAGEMENT',
  'FRONT YARD RESIDENTIAL',
  'ALTISOURCE',
  'TRANSCENDENT ELECTRA',
  'TIBER CAPITAL',
  'CONREX',
  'AMHERST RESIDENTIAL',
  'SREIT',
  'TRICON RESIDENTIAL',
]

const INSTITUTIONAL_KEYWORDS = [
  'FUND',
  'REIT',
  'PORTFOLIO',
  'TRUST',
  'CAPITAL',
  'INVESTMENT',
  'HOLDING',
  'PARTNER',
  'MANAGEMENT',
  'CORPORATION',
  'OPPORTUNITY FUND',
  'SINGLE FAMILY RENTAL',
  'EQUITY',
  'VENTURE',
  'ADVISOR',
]

const BUILDER_KEYWORDS = [
  'BUILDER',
  'DEVELOP',
  'CONSTRUCTION',
  'HOMES',
  'LIVABLE',
  'NEIGHBORHOOD',
  'CUSTOM HOME',
  'LAND',
  'CONTRACTOR',
]

const OPERATOR_KEYWORDS = [
  'APARTMENT',
  'LIVING',
  'RESIDENCE',
  'COMMUNITY',
  'SUITES',
  'LOFTS',
  'VILLAS',
  'MANOR',
  'OPERATOR',
  'REALTY',
]

/** Columns verified on v_command_map_seller_pin_feed (no streetview — lives on properties). */
const COMMAND_MAP_SELLER_PIN_FEED_SELECT = [
  'property_id',
  'master_owner_id',
  'prospect_id',
  'thread_key',
  'owner_display_name',
  'owner_name',
  'owner_full_name',
  'entity_name',
  'property_address',
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'market',
  'filter_market',
  'property_type',
  'asset_class',
  'total_bedrooms',
  'total_baths',
  'building_square_feet',
  'units_count',
  'year_built',
  'lot_square_feet',
  'lot_acreage',
  'estimated_value',
  'equity_amount',
  'equity_percent',
  'estimated_repair_cost',
  'motivation_score',
  'final_acquisition_score',
  'priority_score',
  'property_tags_text',
  'property_tags_json',
  'podio_tags',
  'property_flags_text',
  'property_flags_json',
  'owner_type',
  'seller_state',
  'seller_status',
  'execution_state',
  'inbox_category',
  'latest_message_at',
  'latest_direction',
  'inbound_count',
  'outbound_count',
  'queued_count',
  'scheduled_count',
  'ready_count',
  'sent_count',
  'delivered_count',
  'next_scheduled_for',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'pin_color',
  'pin_shape',
  'pulse_style',
  'execution_ring_color',
  'render_priority',
].join(',')

// Phone columns from migration 20260704120000 — queried separately so a project
// that has not applied that migration still loads the rest of the seller card.
const COMMAND_MAP_SELLER_PIN_FEED_PHONE_SELECT = [
  'prospect_best_phone',
  'display_phone',
  'canonical_e164',
  'seller_phone',
].join(',')

// Queried separately from COMMAND_MAP_SELLER_PIN_FEED_SELECT (below) so that an
// environment where the 20260705120000 migration hasn't been applied yet still
// gets the rest of the card — a missing column here must never take down the
// whole detail query.
const COMMAND_MAP_SELLER_PIN_IDENTITY_SELECT = [
  'prospect_full_name',
  'prospect_first_name',
  'sms_eligible',
  'prospect_language_preference',
  'agent_persona',
  'agent_family',
].join(',')

/** Fast thread state from inbox_thread_state (canonical_inbox_threads is too slow in prod). */
const COMMAND_MAP_THREAD_STATE_SELECT = [
  'thread_key',
  'property_id',
  'master_owner_id',
  'canonical_e164',
  'seller_phone',
  'lead_temperature',
  'seller_stage',
  'conversation_status',
  'temperature',
  'inbox_bucket',
  'inbox_category',
  'suppression_status',
  'is_suppressed',
  'latest_message_body',
  'latest_message_at',
  'latest_direction',
  'last_inbound_at',
  'last_outbound_at',
  'latest_delivery_status',
  'follow_up_at',
  'market',
].join(',')

const COMMAND_MAP_DETAIL_QUERY_TIMEOUT_MS = 6_000

const withDetailQueryTimeout = async <T,>(
  label: string,
  run: () => Promise<T>,
  timeoutMs = COMMAND_MAP_DETAIL_QUERY_TIMEOUT_MS,
): Promise<T | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          if (import.meta.env.DEV) {
            console.warn(`[CommandMap] ${label} timed out after ${timeoutMs}ms`)
          }
          resolve(null)
        }, timeoutMs)
      }),
    ])
    return result
  } catch (error) {
    if (import.meta.env.DEV) console.warn(`[CommandMap] ${label} failed:`, error)
    return null
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

let lastSellerPinErrorMsg: string | null = null
let lastSellerPinErrorAt = 0

export function buildZillowUrl(address: string): string {
  if (!address) return ''
  const encoded = encodeURIComponent(address.replace(/\s+/g, '-'))
  return `https://www.zillow.com/homes/${encoded}_rb/`
}

export function buildGoogleMapsUrl(address: string, lat?: number, lng?: number): string {
  if (lat && lng) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
  return ''
}

const isAbortError = (error: unknown) =>
  (error as { name?: string } | null)?.name === 'AbortError' ||
  String((error as { message?: string } | null)?.message ?? '').toLowerCase().includes('abort')

function enrichSoldComp(comp: RecentSoldComp): RecentSoldComp {
  if (!comp.sale_source) {
    if (comp.mls_sold_price && comp.mls_sold_price > 0) {
      comp.sale_source = 'MLS SOLD'
    } else if (comp.sale_price && comp.sale_price > 0) {
      comp.sale_source = 'PUBLIC RECORD SOLD'
    } else if (comp.mls_sold_date) {
      comp.sale_source = 'MLS SOLD'
    } else if (comp.sale_date) {
      comp.sale_source = 'PUBLIC RECORD SOLD'
    } else {
      comp.sale_source = 'RECORDED SALE'
    }
  }

  if (comp.building_square_feet === 0) comp.building_square_feet = null
  if (comp.total_bedrooms === 0) comp.total_bedrooms = null
  if (comp.total_baths === 0) comp.total_baths = null
  if (comp.units_count === 0) comp.units_count = null

  const price = comp.mls_sold_price ?? comp.sale_price ?? 0
  if (price > 0) {
    if (!comp.computed_ppsf && comp.building_square_feet) {
      comp.computed_ppsf = Math.round(price / comp.building_square_feet)
    }
    if (!comp.ppu && comp.units_count && comp.units_count > 1) {
      comp.ppu = Math.round(price / comp.units_count)
    }
    if (!comp.ppbd && comp.total_bedrooms) {
      comp.ppbd = Math.round(price / comp.total_bedrooms)
    }
  }

  if (!comp.owner_type_label) {
    if (comp.is_corporate_owner) {
      comp.owner_type_label = 'Corporate Owner'
    } else if (comp.is_corporate_owner === false && comp.owner_name) {
      comp.owner_type_label = 'Individual Owner'
    } else {
      comp.owner_type_label = 'Unknown Owner Type'
    }
  }

  const ownerNameUpper = (comp.owner_name || '').toUpperCase()
  let isInst = false
  let matchName: string | null = null
  let matchMethod: string | null = null
  let matchConfidence: string | null = null
  let buyerLabel = 'Unknown Buyer Type'

  if (ownerNameUpper) {
    for (const name of INSTITUTIONAL_NAMES) {
      if (ownerNameUpper.includes(name)) {
        isInst = true
        matchName = name
        matchMethod = 'name_match'
        matchConfidence = 'Confirmed'
        break
      }
    }

    if (!isInst) {
      for (const keyword of INSTITUTIONAL_KEYWORDS) {
        if (ownerNameUpper.includes(keyword) && comp.is_corporate_owner !== false) {
          isInst = true
          matchName = keyword
          matchMethod = 'keyword_match'
          matchConfidence = 'High'
          break
        }
      }
    }

    if (isInst) {
      buyerLabel = 'Hedge Fund / Institutional'
      comp.is_institutional_buyer = true
    } else if (BUILDER_KEYWORDS.some((keyword) => ownerNameUpper.includes(keyword)) && comp.is_corporate_owner !== false) {
      buyerLabel = 'Builder / Developer'
      comp.is_institutional_buyer = false
    } else if (
      (OPERATOR_KEYWORDS.some((keyword) => ownerNameUpper.includes(keyword)) ||
        (ownerNameUpper.includes('LLC') && (comp.units_count ?? 0) >= 5)) &&
      comp.is_corporate_owner !== false
    ) {
      buyerLabel = 'Apartment Operator'
      comp.is_institutional_buyer = false
    } else if (ownerNameUpper.includes('LLC') || ownerNameUpper.includes('LP') || ownerNameUpper.includes('TRUST')) {
      buyerLabel = 'Local Investor / LLC'
      comp.is_institutional_buyer = false
    } else if (comp.is_corporate_owner || ownerNameUpper.includes('INC') || ownerNameUpper.includes('CORP')) {
      buyerLabel = 'Corporate Buyer'
      comp.is_institutional_buyer = false
    } else {
      buyerLabel = 'Individual Buyer'
      comp.is_institutional_buyer = false
    }
  } else if (comp.is_corporate_owner) {
    buyerLabel = 'Corporate Buyer'
  } else if (comp.is_corporate_owner === false) {
    buyerLabel = 'Individual Buyer'
  }

  comp.institutional_match_name = matchName
  comp.institutional_match_method = matchMethod
  comp.institutional_match_confidence = matchConfidence

  if (!comp.buyer_type_label || comp.buyer_type_label === 'Unknown Buyer Type') {
    comp.buyer_type_label = buyerLabel
  }

  return comp
}

export const loadSubjectComps = async (
  propertyId: string,
  radiusMiles = 1.0,
  monthsBack = 12,
  limit = 50,
  filters?: SoldCompFilters,
): Promise<RecentSoldComp[]> => {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase.rpc('get_comp_candidates_for_subject', {
    p_subject_property_id: propertyId,
    p_radius_miles: radiusMiles,
    p_months_back: filters?.monthsBack ?? monthsBack,
    p_limit: filters?.limit ?? limit,
  })

  if (error || !data) {
    console.error('Failed to load subject comps', error)
    return []
  }

  let results = (data as Record<string, unknown>[]).map((row) =>
    enrichSoldComp({
      ...row,
      property_address_full: (row.property_address_full || row.address) as string,
      property_address_city: (row.property_address_city || row.city) as string,
      property_address_state: (row.property_address_state || row.state) as string,
      property_address_zip: (row.property_address_zip || row.zip) as string,
      building_square_feet: (row.building_square_feet || row.sqft) as number | null,
      total_bedrooms: (row.total_bedrooms || row.beds) as number | null,
      total_baths: (row.total_baths || row.baths) as number | null,
      normalized_asset_class: (row.normalized_asset_class || row.asset_class) as string | null,
      streetview_image: (row.streetview_image || null) as string | null,
      satellite_image: (row.satellite_image || null) as string | null,
    } as RecentSoldComp),
  )

  if (filters?.assetClass) {
    results = results.filter((row) => row.normalized_asset_class === filters.assetClass)
  }
  if (filters?.minSalePrice) {
    results = results.filter((row) => (row.mls_sold_price ?? row.sale_price ?? 0) >= filters.minSalePrice!)
  }
  if (filters?.maxSalePrice) {
    results = results.filter((row) => (row.mls_sold_price ?? row.sale_price ?? 0) <= filters.maxSalePrice!)
  }

  return results
}

export const loadMarketComps = async (
  market?: string,
  zip?: string,
  limit = 100,
  filters?: SoldCompFilters,
): Promise<RecentSoldComp[]> => {
  const supabase = getSupabaseClient()
  let query = supabase.from('v_recent_sold_comps').select('*').limit(limit)

  if (market) query = query.eq('market', market)
  else if (zip) query = query.eq('property_address_zip', zip)
  else return []

  if (filters?.assetClass) {
    query = query.eq('normalized_asset_class', filters.assetClass)
  }

  const months = filters?.monthsBack ?? 6
  const dateLimit = new Date()
  dateLimit.setMonth(dateLimit.getMonth() - months)

  query = query.gte('sale_date', dateLimit.toISOString().split('T')[0])
  query = query.order('sale_date', { ascending: false })

  const { data, error } = await query

  if (error || !data) {
    console.error('Failed to load market comps', error)
    return []
  }

  return (data as RecentSoldComp[]).map(enrichSoldComp)
}

export const loadSoldCompsInBounds = async (
  bounds: MapBounds,
  filters?: SoldCompFilters & { signal?: AbortSignal },
): Promise<RecentSoldComp[]> => {
  const supabase = getSupabaseClient()
  const limit = Math.min(filters?.limit ?? 1000, 1500)

  let query = supabase
    .from('v_recent_sold_comps')
    .select('*')
    .gte('latitude', bounds.minLat)
    .lte('latitude', bounds.maxLat)
    .gte('longitude', bounds.minLng)
    .lte('longitude', bounds.maxLng)
    .order('sale_date', { ascending: false, nullsFirst: false })
    .order('mls_sold_date', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (filters?.signal) query = query.abortSignal(filters.signal)

  if (filters?.assetClass) query = query.eq('normalized_asset_class', filters.assetClass)
  if (filters?.selectedMarket) query = query.eq('market', filters.selectedMarket)
  if (filters?.selectedState) query = query.eq('property_address_state', filters.selectedState)
  if (filters?.selectedZip) query = query.eq('property_address_zip', filters.selectedZip)

  const { data, error } = await query

  if (error || !data) {
    if (isAbortError(error)) return []
    console.error('Failed to load sold comps', error)
    return []
  }

  return (data as RecentSoldComp[])
    .filter((comp) => {
      const price = comp.mls_sold_price ?? comp.sale_price ?? 0
      if (price <= 0) return false

      if (filters?.beds && comp.total_bedrooms !== filters.beds) return false
      if (filters?.baths && comp.total_baths !== filters.baths) return false

      if (filters?.sqftRange) {
        const sqft = comp.building_square_feet ?? 0
        if (sqft < filters.sqftRange[0] || sqft > filters.sqftRange[1]) return false
      }

      if (filters?.minSalePrice && price < filters.minSalePrice) return false
      if (filters?.maxSalePrice && price > filters.maxSalePrice) return false

      return true
    })
    .map(enrichSoldComp)
}

export const loadCommandMapSellerPins = async (
  bounds: MapBounds,
  zoomLevel: number,
  maxRows: number,
  options: { signal?: AbortSignal } = {},
): Promise<CommandMapSellerPin[]> => {
  const supabase = getSupabaseClient()

  let query = supabase.rpc('get_command_map_seller_pins', {
    min_lat: bounds.minLat,
    min_lng: bounds.minLng,
    max_lat: bounds.maxLat,
    max_lng: bounds.maxLng,
    zoom_level: Math.floor(zoomLevel),
    max_rows: maxRows,
  })

  if (options.signal) query = query.abortSignal(options.signal)

  const { data, error } = await query

  if (error || !data) {
    if (isAbortError(error)) return []

    const msg = String(error?.message ?? error ?? 'unknown')
    const now = Date.now()

    if (msg !== lastSellerPinErrorMsg || now - lastSellerPinErrorAt > 30_000) {
      if (import.meta.env.DEV) console.warn('[CommandMap] seller pins RPC failed (returning empty):', msg)
      lastSellerPinErrorMsg = msg
      lastSellerPinErrorAt = now
    }

    return []
  }

  lastSellerPinErrorMsg = null
  return data as CommandMapSellerPin[]
}

const SELLER_WORK_ITEM_PHONE_SELECT = 'prospect_id,prospect_best_phone,display_phone,master_owner_id'

export const pickSellerContactPhone = (row: Record<string, unknown> | null | undefined): string | null => {
  if (!row) return null
  const candidates = [
    row.canonical_e164,
    row.prospect_best_phone,
    row.display_phone,
    row.seller_phone,
    row.best_phone,
    row.best_phone_1,
    row.phone,
    row.phone_number,
    row.e164,
  ]
  for (const candidate of candidates) {
    const phone = String(candidate ?? '').trim()
    if (!phone || phone.toLowerCase() === 'no phone') continue
    if (/^ph_[a-z0-9_]+$/i.test(phone)) continue
    return phone
  }
  return null
}

/** Normalize a loose US phone string to +1 E.164 for TextGrid sends. */
export const normalizeSellerDialablePhone = (value: unknown): string | null => {
  const raw = String(value ?? '').trim()
  if (!raw || raw.toLowerCase() === 'no phone' || /^ph_[a-z0-9_]+$/i.test(raw)) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`
  return null
}

const readCommandMapPinFeedContact = async (
  propertyId: string,
  signal?: AbortSignal,
): Promise<{ phone: string | null; prospectId: string | null; masterOwnerId: string | null } | null> => {
  if (!propertyId) return null
  const supabase = getSupabaseClient()
  // Production pin feed may not expose phone columns (pre-20260704120000 migration).
  // Identity only here — phone resolves via master_owners.best_phone_1 / work items.
  let query = supabase
    .from('v_command_map_seller_pin_feed')
    .select('prospect_id,master_owner_id')
    .eq('property_id', propertyId)
  if (signal) query = query.abortSignal(signal)
  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) {
    if (error && !isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] pin feed phone lookup failed:', error)
    }
    return null
  }
  const row = data as Record<string, unknown>
  const phone = normalizeSellerDialablePhone(pickSellerContactPhone(row))
  return {
    phone,
    prospectId: String(row.prospect_id ?? '').trim() || null,
    masterOwnerId: String(row.master_owner_id ?? '').trim() || null,
  }
}

const readProspectLinkedPhones = async (
  prospectId: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> => {
  const id = String(prospectId ?? '').trim()
  if (!id) return null

  const supabase = getSupabaseClient()
  let query = supabase
    .from('phones')
    .select('canonical_e164,phone,phone_number,e164,sort_rank')
    .or(`primary_prospect_id.eq.${id},canonical_prospect_id.eq.${id}`)
    .order('sort_rank', { ascending: true })
    .limit(8)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query
  if (error || !data?.length) {
    if (error && !isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] prospect linked phones lookup failed:', error)
    }
    return null
  }

  for (const row of data as Record<string, unknown>[]) {
    const normalized = normalizeSellerDialablePhone(pickSellerContactPhone(row))
    if (normalized) return normalized
  }
  return null
}

const readMasterOwnerBestPhone = async (
  masterOwnerId: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> => {
  const ownerId = String(masterOwnerId ?? '').trim()
  if (!ownerId) return null

  const supabase = getSupabaseClient()
  let query = supabase
    .from('master_owners')
    .select('best_phone_1')
    .eq('master_owner_id', ownerId)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error) {
    if (!isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] master owner phone lookup failed:', error)
    }
    return null
  }
  return pickSellerContactPhone(data as Record<string, unknown>)
}

const readProspectBestPhone = async (
  prospectId: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> => {
  const id = String(prospectId ?? '').trim()
  if (!id) return null

  const supabase = getSupabaseClient()
  let query = supabase
    .from('prospects')
    .select('best_phone')
    .eq('prospect_id', id)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error) {
    if (!isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] prospect phone lookup failed:', error)
    }
    return null
  }
  return pickSellerContactPhone(data as Record<string, unknown>)
}

export const resolveMasterOwnerIdForProperty = async (
  propertyId: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  const supabase = getSupabaseClient()
  let query = supabase
    .from('properties')
    .select('master_owner_id')
    .eq('property_id', propertyId)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) return null
  return String((data as Record<string, unknown>).master_owner_id ?? '').trim() || null
}

export const resolveCommandMapSellerPhone = async (
  propertyId: string,
  options: {
    prospectId?: string | null
    masterOwnerId?: string | null
    signal?: AbortSignal
  } = {},
): Promise<{ phone: string | null; prospectId: string | null }> => {
  if (!propertyId) return { phone: null, prospectId: options.prospectId ?? null }

  let resolvedProspectId = String(options.prospectId ?? '').trim() || null
  let resolvedOwnerId = String(options.masterOwnerId ?? '').trim() || null

  const pinFeed = await readCommandMapPinFeedContact(propertyId, options.signal)
  if (pinFeed) {
    resolvedProspectId = resolvedProspectId || pinFeed.prospectId
    resolvedOwnerId = resolvedOwnerId || pinFeed.masterOwnerId
    if (pinFeed.phone) {
      return { phone: pinFeed.phone, prospectId: resolvedProspectId }
    }
  }

  const supabase = getSupabaseClient()
  let query = supabase
    .from('v_seller_work_items')
    .select(SELLER_WORK_ITEM_PHONE_SELECT)
    .eq('property_id', propertyId)
  if (options.signal) query = query.abortSignal(options.signal)

  const { data, error } = await query.limit(1).maybeSingle()

  if (!error && data) {
    const row = data as Record<string, unknown>
    const phone = normalizeSellerDialablePhone(pickSellerContactPhone(row))
    resolvedProspectId = resolvedProspectId || String(row.prospect_id ?? '').trim() || null
    resolvedOwnerId = resolvedOwnerId || String(row.master_owner_id ?? '').trim() || null
    if (phone) {
      return { phone, prospectId: resolvedProspectId }
    }
  }

  if (!resolvedOwnerId) {
    resolvedOwnerId = await resolveMasterOwnerIdForProperty(propertyId, options.signal)
  }

  const ownerPhone = normalizeSellerDialablePhone(
    await readMasterOwnerBestPhone(resolvedOwnerId, options.signal),
  )
  if (ownerPhone) {
    return { phone: ownerPhone, prospectId: resolvedProspectId }
  }

  const prospectPhone = normalizeSellerDialablePhone(
    await readProspectBestPhone(resolvedProspectId, options.signal),
  )
  if (prospectPhone) {
    return { phone: prospectPhone, prospectId: resolvedProspectId }
  }

  const linkedPhone = await readProspectLinkedPhones(resolvedProspectId, options.signal)
  if (linkedPhone) {
    return { phone: linkedPhone, prospectId: resolvedProspectId }
  }

  return { phone: null, prospectId: resolvedProspectId }
}

export type CommandMapSellerIdentity = {
  prospectId: string | null
  prospectFirstName: string | null
  prospectFullName: string | null
  prospectLanguagePreference: string | null
  smsEligible: boolean
  agentPersona: string | null
  agentFamily: string | null
}

const readProspectIdentity = async (
  prospectId: string | null | undefined,
  signal?: AbortSignal,
): Promise<{
  prospectFirstName: string | null
  prospectFullName: string | null
  prospectLanguagePreference: string | null
  smsEligible: boolean
} | null> => {
  const id = String(prospectId ?? '').trim()
  if (!id) return null

  const supabase = getSupabaseClient()
  let query = supabase
    .from('prospects')
    .select('first_name,full_name,sms_eligible,language_preference')
    .eq('prospect_id', id)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) {
    if (error && !isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] prospect identity lookup failed:', error)
    }
    return null
  }
  const row = data as Record<string, unknown>
  return {
    prospectFirstName: String(row.first_name ?? '').trim() || null,
    prospectFullName: String(row.full_name ?? '').trim() || null,
    prospectLanguagePreference: String(row.language_preference ?? '').trim() || null,
    smsEligible: row.sms_eligible === true,
  }
}

const readMasterOwnerAgentSignal = async (
  masterOwnerId: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ agentPersona: string | null; agentFamily: string | null } | null> => {
  const ownerId = String(masterOwnerId ?? '').trim()
  if (!ownerId) return null

  const supabase = getSupabaseClient()
  let query = supabase
    .from('master_owners')
    .select('agent_persona,agent_family')
    .eq('master_owner_id', ownerId)
  if (signal) query = query.abortSignal(signal)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) {
    if (error && !isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] master owner agent signal lookup failed:', error)
    }
    return null
  }
  const row = data as Record<string, unknown>
  return {
    agentPersona: String(row.agent_persona ?? '').trim() || null,
    agentFamily: String(row.agent_family ?? '').trim() || null,
  }
}

/**
 * Live fallback identity resolver for the Map ownership-check send. Used only when
 * the hydrated map-card record itself lacks prospect name / eligibility / agent
 * fields (e.g. a stale cache or a lightweight pin payload) — the common case is
 * already covered by v_command_map_seller_pin_feed's own prospect_full_name /
 * prospect_first_name / sms_eligible / agent_persona / agent_family columns.
 */
export const resolveCommandMapSellerIdentity = async (params: {
  prospectId?: string | null
  masterOwnerId?: string | null
  signal?: AbortSignal
}): Promise<CommandMapSellerIdentity> => {
  const prospectId = String(params.prospectId ?? '').trim() || null
  const masterOwnerId = String(params.masterOwnerId ?? '').trim() || null

  const [prospectIdentity, agentSignal] = await Promise.all([
    readProspectIdentity(prospectId, params.signal),
    readMasterOwnerAgentSignal(masterOwnerId, params.signal),
  ])

  return {
    prospectId,
    prospectFirstName: prospectIdentity?.prospectFirstName ?? null,
    prospectFullName: prospectIdentity?.prospectFullName ?? null,
    prospectLanguagePreference: prospectIdentity?.prospectLanguagePreference ?? null,
    smsEligible: prospectIdentity?.smsEligible ?? false,
    agentPersona: agentSignal?.agentPersona ?? null,
    agentFamily: agentSignal?.agentFamily ?? null,
  }
}

const readSellerWorkItemContact = async (
  propertyId: string,
  signal?: AbortSignal,
): Promise<Partial<CommandMapSellerPin> | null> => {
  if (!propertyId) return null
  const supabase = getSupabaseClient()
  let query = supabase
    .from('v_seller_work_items')
    .select(SELLER_WORK_ITEM_PHONE_SELECT)
    .eq('property_id', propertyId)
  if (signal) query = query.abortSignal(signal)
  const { data, error } = await query.limit(1).maybeSingle()
  if (error) {
    if (!isAbortError(error) && import.meta.env.DEV) {
      console.warn('[CommandMap] seller work item contact lookup failed:', error)
    }
    return null
  }
  if (!data) return null
  const row = data as Record<string, unknown>
  let phone = pickSellerContactPhone(row)
  const masterOwnerId = String(row.master_owner_id ?? '').trim() || null
  if (!phone && masterOwnerId) {
    phone = await readMasterOwnerBestPhone(masterOwnerId, signal)
  }
  return {
    prospect_id: String(row.prospect_id ?? '').trim() || null,
    prospect_best_phone: phone || String(row.prospect_best_phone ?? '').trim() || null,
    display_phone: phone || String(row.display_phone ?? '').trim() || null,
    canonical_e164: phone,
    seller_phone: phone,
  }
}

const mapThreadStateRow = (row: Record<string, unknown> | null): Partial<CommandMapSellerPin> | null => {
  if (!row) return null
  const latestBody = String(row.latest_message_body ?? '').trim()
  const latestDirection = String(row.latest_message_direction ?? row.latest_direction ?? '').trim().toLowerCase()
  return {
    thread_key: String(row.thread_key ?? '').trim() || null,
    property_id: String(row.property_id ?? '').trim(),
    master_owner_id: String(row.master_owner_id ?? '').trim() || null,
    owner_name: String(row.owner_name ?? '').trim() || null,
    owner_display_name: String(row.owner_name ?? '').trim() || null,
    property_address_full: String(row.property_address_full ?? '').trim() || null,
    market: String(row.market ?? '').trim() || null,
    property_type: String(row.property_type ?? '').trim() || null,
    canonical_e164: String(row.canonical_e164 ?? row.seller_phone ?? '').trim() || null,
    seller_phone: String(row.seller_phone ?? row.canonical_e164 ?? '').trim() || null,
    lifecycle_stage: String(row.seller_stage ?? '').trim() || null,
    operational_status: String(row.conversation_status ?? '').trim() || null,
    lead_temperature: String(row.lead_temperature ?? row.temperature ?? '').trim() || null,
    inbox_category: String(row.inbox_category ?? row.inbox_bucket ?? '').trim() || null,
    latest_message_at: String(row.latest_message_at ?? '').trim() || null,
    latest_direction: latestDirection || null,
    last_inbound_at: String(row.last_inbound_at ?? '').trim() || null,
    last_outbound_at: String(row.last_outbound_at ?? '').trim() || null,
    last_inbound_text: latestDirection === 'inbound' ? latestBody || null : null,
    last_outbound_text: latestDirection === 'outbound' ? latestBody || null : null,
    delivery_status: String(row.delivery_status ?? row.latest_delivery_status ?? '').trim() || null,
    follow_up_due_at: String(row.follow_up_at ?? '').trim() || null,
    suppression_reason: String(row.suppression_status ?? '').trim() || null,
  }
}

const mapMasterOwnerFields = (
  masterOwner: Record<string, unknown> | null,
): Partial<CommandMapSellerPin> => ({
  owner_priority_score: Number.isFinite(Number(masterOwner?.priority_score)) ? Number(masterOwner?.priority_score) : null,
  owner_priority_tier: String(masterOwner?.priority_tier ?? '').trim() || null,
  best_language: String(masterOwner?.best_language ?? '').trim() || null,
  mailing_address_full: String(masterOwner?.primary_owner_address ?? '').trim() || null,
  property_count: Number.isFinite(Number(masterOwner?.property_count)) ? Number(masterOwner?.property_count) : null,
  portfolio_total_value: Number.isFinite(Number(masterOwner?.portfolio_total_value)) ? Number(masterOwner?.portfolio_total_value) : null,
  portfolio_total_equity: Number.isFinite(Number(masterOwner?.portfolio_total_equity)) ? Number(masterOwner?.portfolio_total_equity) : null,
  portfolio_total_loan_balance: Number.isFinite(Number(masterOwner?.portfolio_total_loan_balance)) ? Number(masterOwner?.portfolio_total_loan_balance) : null,
  portfolio_total_tax_amount: Number.isFinite(Number(masterOwner?.portfolio_total_tax_amount)) ? Number(masterOwner?.portfolio_total_tax_amount) : null,
  portfolio_total_units: Number.isFinite(Number(masterOwner?.portfolio_total_units)) ? Number(masterOwner?.portfolio_total_units) : null,
})

const mapPropertyEnrichmentRow = (
  row: Record<string, unknown> | null,
  masterOwner: Record<string, unknown> | null,
  dossierMode: CommandMapDossierMode = 'peek',
): (Partial<CommandMapSellerPin> & Record<string, unknown>) | null => {
  if (!row) return null
  const taxAmt = Number(row.tax_amt)
  const salePrice = Number(row.saleprice)
  const ownerFields = mapMasterOwnerFields(masterOwner)
  const aliases: Record<string, unknown> = {
    property_id: String(row.property_id ?? '').trim(),
    master_owner_id: String(row.master_owner_id ?? masterOwner?.master_owner_id ?? '').trim() || null,
    streetview_image: String(row.streetview_image ?? '').trim() || null,
    map_image: String(row.map_image ?? '').trim() || null,
    satellite_image: String(row.satellite_image ?? '').trim() || null,
    effective_year_built: Number.isFinite(Number(row.effective_year_built)) ? Number(row.effective_year_built) : null,
    construction_type: String(row.construction_type ?? '').trim() || null,
    building_condition: String(row.building_condition ?? '').trim() || null,
    stories: Number.isFinite(Number(row.stories)) ? Number(row.stories) : null,
    zoning: String(row.zoning ?? '').trim() || null,
    land_use: String(row.county_land_use_code ?? '').trim() || null,
    lot_square_feet: Number.isFinite(Number(row.lot_square_feet)) ? Number(row.lot_square_feet) : null,
    lot_acreage: Number.isFinite(Number(row.lot_acreage)) ? Number(row.lot_acreage) : null,
    ownership_years: Number.isFinite(Number(row.ownership_years)) ? Number(row.ownership_years) : null,
    tax_delinquent: row.tax_delinquent === true,
    out_of_state_owner: row.out_of_state_owner === true,
    active_lien: row.active_lien === true,
    mortgage_balance: Number.isFinite(Number(row.total_loan_balance)) ? Number(row.total_loan_balance) : null,
    assessed_total_value: Number.isFinite(Number(row.assd_total_value)) ? Number(row.assd_total_value) : null,
    assessed_land_value: Number.isFinite(Number(row.assd_land_value)) ? Number(row.assd_land_value) : null,
    assessed_improvement_value: Number.isFinite(Number(row.assd_improvement_value)) ? Number(row.assd_improvement_value) : null,
    annual_taxes: Number.isFinite(taxAmt) ? taxAmt : null,
    last_sale_amount: Number.isFinite(salePrice) ? salePrice : null,
    last_sale_date: String(row.sale_date ?? '').trim() || null,
    dossier_hydrated: dossierMode === 'focus',
    _dossierHydrated: dossierMode === 'focus',
    ...ownerFields,
  }

  if (dossierMode === 'focus') {
    return { ...row, ...aliases }
  }

  return aliases
}

export const loadCommandMapSellerPinDetail = async (
  propertyId: string,
  options: DetailLookupOptions = {},
): Promise<Partial<CommandMapSellerPin> | null> => {
  const supabase = getSupabaseClient()

  const buildPinFeedQuery = (select: string) => {
    let query = supabase.from('v_command_map_seller_pin_feed').select(select)
    if (propertyId) {
      query = query.eq('property_id', propertyId)
    } else if (options.threadKey) {
      query = query.eq('thread_key', options.threadKey)
    } else if (options.masterOwnerId) {
      query = query.eq('master_owner_id', options.masterOwnerId)
    } else if (options.prospectId) {
      query = query.eq('prospect_id', options.prospectId)
    } else {
      return null
    }
    if (options.signal) query = query.abortSignal(options.signal)
    return query
  }

  const readFeed = async () => {
    const query = buildPinFeedQuery(COMMAND_MAP_SELLER_PIN_FEED_SELECT)
    if (!query) return null
    const { data, error } = await query.limit(1).maybeSingle()
    if (error) {
      if (isAbortError(error)) return null
      if (import.meta.env.DEV) console.warn('[CommandMap] seller pin feed detail failed:', error)
      return null
    }
    if (!data) return null

    let merged = data as Partial<CommandMapSellerPin>
    const phoneQuery = buildPinFeedQuery(COMMAND_MAP_SELLER_PIN_FEED_PHONE_SELECT)
    if (phoneQuery) {
      const { data: phoneData, error: phoneError } = await phoneQuery.limit(1).maybeSingle()
      if (!phoneError && phoneData) {
        merged = { ...merged, ...(phoneData as unknown as Record<string, unknown>) }
      } else if (phoneError && !isAbortError(phoneError) && import.meta.env.DEV) {
        console.warn('[CommandMap] seller pin phone fields unavailable (migration pending?):', phoneError)
      }
    }
    return merged
  }

  // Isolated from readFeed() on purpose: a 400 here (e.g. migration
  // 20260705120000 not yet applied to this Supabase project, so these columns
  // don't exist on the view) must degrade to "no prospect identity/agent data"
  // only — it must never fail the rest of the card.
  const readIdentityFields = async () => {
    let query = supabase.from('v_command_map_seller_pin_feed').select(COMMAND_MAP_SELLER_PIN_IDENTITY_SELECT)
    if (propertyId) {
      query = query.eq('property_id', propertyId)
    } else if (options.threadKey) {
      query = query.eq('thread_key', options.threadKey)
    } else if (options.masterOwnerId) {
      query = query.eq('master_owner_id', options.masterOwnerId)
    } else if (options.prospectId) {
      query = query.eq('prospect_id', options.prospectId)
    } else {
      return null
    }
    if (options.signal) query = query.abortSignal(options.signal)
    try {
      const { data, error } = await query.limit(1).maybeSingle()
      if (error) {
        if (!isAbortError(error) && import.meta.env.DEV) {
          console.warn('[CommandMap] seller pin identity fields unavailable (migration pending?):', error)
        }
        return null
      }
      return data as Partial<CommandMapSellerPin> | null
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[CommandMap] seller pin identity fields query threw:', err)
      return null
    }
  }

  const readThreadState = async () => {
    let query = supabase.from('inbox_thread_state').select(COMMAND_MAP_THREAD_STATE_SELECT)
    if (propertyId) {
      query = query.eq('property_id', propertyId)
    } else if (options.threadKey) {
      query = query.eq('thread_key', options.threadKey)
    } else if (options.masterOwnerId) {
      query = query.eq('master_owner_id', options.masterOwnerId)
    } else {
      return null
    }
    if (options.signal) query = query.abortSignal(options.signal)
    const { data, error } = await query.order('latest_message_at', { ascending: false }).limit(1).maybeSingle()
    if (error) {
      if (isAbortError(error)) return null
      if (import.meta.env.DEV) console.warn('[CommandMap] inbox thread state detail failed:', error)
      return null
    }
    return mapThreadStateRow(data as Record<string, unknown> | null)
  }

  const dossierMode: CommandMapDossierMode = options.dossierMode ?? 'peek'
  const propertySelect = dossierMode === 'focus'
    ? COMMAND_MAP_PROPERTY_DOSSIER_SELECT
    : COMMAND_MAP_PROPERTY_PEEK_SELECT

  const readPropertyEnrichment = async (resolvedPropertyId: string, masterOwnerId: string | null) => {
    let query = supabase.from('properties').select(propertySelect).eq('property_id', resolvedPropertyId)
    if (options.signal) query = query.abortSignal(options.signal)
    const { data: propertyRow, error: propertyError } = await query.limit(1).maybeSingle()
    if (propertyError) {
      if (!isAbortError(propertyError) && import.meta.env.DEV) {
        console.warn('[CommandMap] property enrichment failed:', propertyError)
      }
    }

    const propertyData = propertyError ? null : (propertyRow as Record<string, unknown> | null)
    let masterOwner: Record<string, unknown> | null = null
    const ownerId = masterOwnerId || String(propertyData?.master_owner_id ?? '').trim() || null
    if (ownerId) {
      let ownerQuery = supabase
        .from('master_owners')
        .select('master_owner_id,priority_score,priority_tier,primary_owner_address,property_count,best_language,portfolio_total_value,portfolio_total_equity,portfolio_total_loan_balance,portfolio_total_tax_amount,portfolio_total_units')
        .eq('master_owner_id', ownerId)
      if (options.signal) ownerQuery = ownerQuery.abortSignal(options.signal)
      const { data: ownerRow } = await ownerQuery.limit(1).maybeSingle()
      masterOwner = (ownerRow as Record<string, unknown> | null) ?? null
    }

    return mapPropertyEnrichmentRow(propertyData, masterOwner, dossierMode)
  }

  const [sellerWorkItem, identityFields, threadState, sellerWorkItemContact] = await Promise.all([
    withDetailQueryTimeout('seller_pin_feed', () => readFeed()),
    withDetailQueryTimeout('seller_pin_identity', () => readIdentityFields(), 4_000),
    withDetailQueryTimeout('inbox_thread_state', () => readThreadState()),
    withDetailQueryTimeout('seller_work_item_contact', () => readSellerWorkItemContact(propertyId, options.signal)),
  ])

  const resolvedPropertyId = threadState?.property_id
    || sellerWorkItem?.property_id
    || propertyId
  const resolvedMasterOwnerId = threadState?.master_owner_id
    || sellerWorkItem?.master_owner_id
    || options.masterOwnerId
    || null

  const propertyEnrichment = resolvedPropertyId
    ? await withDetailQueryTimeout(
      'property_enrichment',
      () => readPropertyEnrichment(resolvedPropertyId, resolvedMasterOwnerId),
    )
    : null

  if (!sellerWorkItem && !threadState && !propertyEnrichment && !sellerWorkItemContact) return null

  const merged = {
    ...(sellerWorkItem ?? {}),
    ...(identityFields ?? {}),
    ...(threadState ?? {}),
    ...(sellerWorkItemContact ?? {}),
    ...(propertyEnrichment ?? {}),
    property_id: resolvedPropertyId,
    thread_key: threadState?.thread_key ?? sellerWorkItem?.thread_key ?? options.threadKey ?? null,
    master_owner_id: resolvedMasterOwnerId,
    prospect_id: sellerWorkItemContact?.prospect_id ?? sellerWorkItem?.prospect_id ?? options.prospectId ?? null,
    owner_priority_score:
      propertyEnrichment?.owner_priority_score
      ?? sellerWorkItem?.priority_score
      ?? null,
    priority_score: sellerWorkItem?.priority_score ?? propertyEnrichment?.owner_priority_score ?? null,
    next_action_at: sellerWorkItem?.next_scheduled_for ?? threadState?.follow_up_due_at ?? null,
    automation_state: sellerWorkItem?.execution_state ?? null,
  } satisfies Partial<CommandMapSellerPin>

  return merged
}