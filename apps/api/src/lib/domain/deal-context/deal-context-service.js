import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const DEAL_CONTEXT_SOURCE = 'v_deal_context_cards'
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const COUNT_SCAN_CHUNK = 5000

function clean(value) {
  return String(value ?? '').trim()
}

function lower(value) {
  return clean(value).toLowerCase()
}

function int(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, 0), max)
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase())
}

function normalizeSearchTerm(value) {
  return clean(value).replace(/[,%()]/g, ' ')
}

function applyScalarFilters(query, params = {}) {
  const scalarFilters = [
    ['deal_context_id', params.deal_context_id],
    ['context_type', params.context_type],
    ['property_id', params.property_id],
    ['master_owner_id', params.master_owner_id],
    ['prospect_id', params.prospect_id],
    ['canonical_prospect_id', params.canonical_prospect_id],
    ['phone_id', params.phone_id],
    ['email_id', params.email_id],
    ['thread_key', params.thread_key],
    ['canonical_e164', params.canonical_e164],
    ['campaign_id', params.campaign_id],
    ['campaign_target_id', params.campaign_target_id],
    ['queue_row_id', params.queue_row_id],
    ['market', params.market],
    ['property_state', params.property_state],
    ['property_zip', params.property_zip],
    ['property_county_name', params.property_county_name],
    ['universal_status', params.universal_status],
    ['universal_stage', params.universal_stage],
    ['campaign_status', params.campaign_status],
    ['campaign_name', params.campaign_name],
    ['campaign_target_status', params.campaign_target_status],
    ['queue_status', params.queue_status],
    ['suppression_status', params.suppression_status],
  ]

  let nextQuery = query
  for (const [column, rawValue] of scalarFilters) {
    const value = clean(rawValue)
    if (!value) continue
    nextQuery = nextQuery.eq(column, value)
  }

  const inboxBucket = lower(params.inbox_bucket)
  if (inboxBucket === 'dead') {
    nextQuery = nextQuery.or('inbox_bucket.eq.dead,universal_status.eq.dead')
  } else if (inboxBucket === 'cold') {
    nextQuery = nextQuery
      .eq('inbox_bucket', 'cold')
      .not('universal_status', 'eq', 'dead')
      .not('universal_status', 'eq', 'suppressed')
      .eq('opt_out', false)
      .eq('wrong_number', false)
      .eq('not_interested', false)
  } else if (inboxBucket && inboxBucket !== 'all' && inboxBucket !== 'all_messages') {
    nextQuery = nextQuery.eq('inbox_bucket', inboxBucket)
  }

  if (clean(params.has_thread)) {
    nextQuery = truthy(params.has_thread)
      ? nextQuery.not('thread_key', 'is', null)
      : nextQuery.is('thread_key', null)
  }

  if (clean(params.has_message)) {
    nextQuery = truthy(params.has_message)
      ? nextQuery.not('latest_message_body', 'is', null)
      : nextQuery.is('latest_message_body', null)
  }

  if (clean(params.has_phone)) {
    nextQuery = truthy(params.has_phone)
      ? nextQuery.not('canonical_e164', 'is', null)
      : nextQuery.is('canonical_e164', null)
  }

  const search = normalizeSearchTerm(params.q)
  if (search) {
    const like = `%${search}%`
    nextQuery = nextQuery.or([
      `property_address_full.ilike.${like}`,
      `owner_name.ilike.${like}`,
      `latest_message_body.ilike.${like}`,
      `thread_key.ilike.${like}`,
      `canonical_e164.ilike.${like}`,
    ].join(','))
  }

  return nextQuery
}

function applyOrdering(query, params = {}) {
  const orderBy = clean(params.order_by) || 'latest_message_at'
  const ascending = truthy(params.ascending)
  const orderedQuery = query.order(orderBy, { ascending, nullsFirst: false })

  if (orderBy !== 'deal_context_id') {
    return orderedQuery.order('deal_context_id', { ascending: true, nullsFirst: false })
  }

  return orderedQuery
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizePhone(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = s.replace(/\D/g, '')
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return s.startsWith('+') ? s : (d ? `+${d}` : null)
}

function firstPhone(...values) {
  for (const value of values) {
    const normalized = normalizePhone(value)
    if (normalized) return normalized
  }
  return null
}

const TEXTGRID_NUMBERS = new Set([
  '+16128060495', '+13235589881', '+17866052999', '+19804589889', 
  '+13234104544', '+14704920588', '+14693131600', '+12818458577', 
  '+19048774448', '+17042405818'
])

function isTextGridNumber(phone) {
  if (!phone) return false
  const normalized = normalizePhone(phone)
  return normalized && TEXTGRID_NUMBERS.has(normalized)
}

function resolvePhones(row) {
  const event = object(row.latest_message_event_data)
  const threadState = object(row.thread_state_data)
  const direction = lower(row.latest_message_direction || event.direction || row.direction)
  
  const toNum = normalizePhone(event.to_phone_number)
  const fromNum = normalizePhone(event.from_phone_number)
  const canonical = normalizePhone(row.canonical_e164 || threadState.canonical_e164)
  const threadKey = normalizePhone(row.thread_key)
  const rowOur = normalizePhone(row.our_number || threadState.our_number)

  let seller_phone = null
  let sender_phone = null

  // 1. Identify our number (sender_phone)
  if (isTextGridNumber(rowOur)) sender_phone = rowOur
  else if (isTextGridNumber(fromNum)) sender_phone = fromNum
  else if (isTextGridNumber(toNum)) sender_phone = toNum
  else if (direction === 'inbound') sender_phone = toNum
  else if (direction === 'outbound') sender_phone = fromNum

  // 2. Identify seller number (seller_phone)
  // Must NOT be a TextGrid number
  if (direction === 'inbound') {
    if (fromNum && !isTextGridNumber(fromNum)) seller_phone = fromNum
  } else if (direction === 'outbound') {
    if (toNum && !isTextGridNumber(toNum)) seller_phone = toNum
  }

  // Fallback chain for seller_phone
  if (!seller_phone) {
    if (threadKey && !isTextGridNumber(threadKey)) seller_phone = threadKey
    else if (canonical && !isTextGridNumber(canonical)) seller_phone = canonical
    else if (fromNum && !isTextGridNumber(fromNum)) seller_phone = fromNum
    else if (toNum && !isTextGridNumber(toNum)) seller_phone = toNum
  }

  // 3. Final safety check: if they are still the same, we have a problem
  if (seller_phone === sender_phone && seller_phone !== null) {
    if (isTextGridNumber(seller_phone)) {
      seller_phone = null // Should never be seller
    } else {
      sender_phone = null // Should not be sender if it's the seller
    }
  }

  return {
    seller_phone: normalizePhone(seller_phone),
    sender_phone: normalizePhone(sender_phone)
  }
}

function hydrateDealContextRow(row) {
  const { seller_phone, sender_phone } = resolvePhones(row)
  const property = object(row.property_data)
  const valuation = object(row.valuation_data)
  const buyerMatch = object(row.buyer_match_data)
  const threadState = object(row.thread_state_data)
  const prospect = object(row.prospect_data)
  
  // Strict seller phone: must not be a TextGrid number
  const bestSeller = seller_phone || 
    (!isTextGridNumber(row.canonical_e164) ? normalizePhone(row.canonical_e164) : null) ||
    (!isTextGridNumber(row.best_phone) ? normalizePhone(row.best_phone) : null) ||
    (!isTextGridNumber(row.thread_key) ? normalizePhone(row.thread_key) : null)

  // Strict sender phone: must be a TextGrid number if possible
  const bestSender = isTextGridNumber(sender_phone) ? sender_phone : (
    isTextGridNumber(row.our_number) ? normalizePhone(row.our_number) : (
      isTextGridNumber(row.sender_phone) ? normalizePhone(row.sender_phone) : null
    )
  )

  return {
    ...row,
    seller_phone: bestSeller,
    sender_phone: bestSender,
    our_number: bestSender,
    canonical_e164: bestSeller || normalizePhone(row.canonical_e164) || null,
    best_phone: bestSeller || normalizePhone(row.best_phone) || null,
    phone: bestSeller || normalizePhone(row.phone) || null,
    
    // Hydrate missing top-levels from JSON if needed, or ensure they exist
    display_name: row.owner_name || property.seller_name || null,
    first_name: row.seller_first_name || prospect.first_name || null,
    full_name: row.owner_name || prospect.full_name || null,
    
    // Valuations
    estimated_arv: row.estimated_arv || valuation.estimated_arv || null,
    suggested_offer: valuation.target_offer || valuation.conservative_offer || null,
    max_allowable_offer: valuation.max_allowable_offer || null,
    repair_estimate: valuation.repair_estimate || null,
    
    // Scores
    deal_strength_score: valuation.deal_strength_score || null,
    buyer_demand_score: row.buyer_demand_score || valuation.buyer_demand_score || null,
    comp_confidence_score: valuation.comp_confidence_score || null,
    
    // Buyer Match
    matched_buyer_count: row.buyer_match_count || buyerMatch.buyer_count || 0,
    high_fit_buyer_count: buyerMatch.high_fit_count || 0,
    
    // Status/Stage
    reply_intent: threadState.reply_intent || null,
    lead_temperature: threadState.lead_temperature || null,
  }
}

export async function listDealContexts(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const limit = int(params.limit, DEFAULT_LIMIT, MAX_LIMIT)
  const offset = int(params.offset, 0)

  let query = supabase
    .from(DEAL_CONTEXT_SOURCE)
    .select('*', { count: 'exact' })

  query = applyScalarFilters(query, params)
  query = applyOrdering(query, params)
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) throw error

  const rawRows = Array.isArray(data) ? data : []
  const rows = rawRows.map(hydrateDealContextRow)

  const total = Number.isFinite(Number(count)) ? Number(count) : rows.length
  const nextOffset = offset + rows.length

  return {
    rows,
    total,
    pagination: {
      offset,
      limit,
      total,
      has_more: nextOffset < total,
      next_offset: nextOffset < total ? nextOffset : null,
    },
  }
}

export async function getDealContextByProperty(propertyId, deps = {}) {
  const property_id = clean(propertyId)
  if (!property_id) return null

  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase
    .from(DEAL_CONTEXT_SOURCE)
    .select('*')
    .eq('property_id', property_id)
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data ? hydrateDealContextRow(data) : null
}

export async function getDealContextByThread(threadKey, deps = {}) {
  const thread_key = clean(threadKey)
  if (!thread_key) return null

  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase
    .from(DEAL_CONTEXT_SOURCE)
    .select('*')
    .eq('thread_key', thread_key)
    .order('context_type', { ascending: true })
    .order('property_id', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data ? hydrateDealContextRow(data) : null
}

function incrementCount(bucket, key) {
  const normalized = clean(key) || 'unknown'
  bucket[normalized] = (bucket[normalized] || 0) + 1
}

export async function getDealContextCounts(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const source = 'deal_thread_state'

  const [
    allRes,
    priorityRes,
    newRepliesRes,
    needsReviewRes,
    followUpRes,
    coldRes,
    deadRes,
    suppressedRes,
  ] = await Promise.all([
    supabase.from(source).select('*', { count: 'exact', head: true }),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'priority'),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'new_replies'),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'needs_review'),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'follow_up'),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'cold'),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'dead'),
    supabase.from(source).select('*', { count: 'exact', head: true }).eq('inbox_bucket', 'suppressed'),
  ])

  // unlinked is not easily tracked in deal_thread_state if it's missing property_id
  // but for the sake of specific requirements, we'll try to find it in the index
  const { count: unlinkedCount } = await supabase
    .from('deal_context_index')
    .select('*', { count: 'exact', head: true })
    .eq('context_type', 'unlinked_thread')

  return {
    total: allRes.count || 0,
    all: allRes.count || 0,
    all_messages: allRes.count || 0,
    by_inbox_bucket: {
      priority: priorityRes.count || 0,
      new_replies: newRepliesRes.count || 0,
      needs_review: needsReviewRes.count || 0,
      follow_up: followUpRes.count || 0,
      cold: coldRes.count || 0,
      dead: deadRes.count || 0,
      suppressed: suppressedRes.count || 0,
      all_messages: allRes.count || 0,
    },
    by_context_type: {
      unlinked_thread: unlinkedCount || 0,
    }
  }
}
