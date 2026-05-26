import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const DEAL_CONTEXT_SOURCE = 'v_deal_context_cards'
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const COUNT_SCAN_CHUNK = 5000

function clean(value) {
  return String(value ?? '').trim()
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
    ['inbox_bucket', params.inbox_bucket],
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

  const rows = Array.isArray(data) ? data : []
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
  return data || null
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
  return data || null
}

function incrementCount(bucket, key) {
  const normalized = clean(key) || 'unknown'
  bucket[normalized] = (bucket[normalized] || 0) + 1
}

export async function getDealContextCounts(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const limit = COUNT_SCAN_CHUNK
  let offset = 0
  let rowsRead = 0

  const summary = {
    total: 0,
    with_property_id: 0,
    with_thread_key: 0,
    with_latest_message_body: 0,
    with_owner_name: 0,
    with_property_address_full: 0,
    with_canonical_e164: 0,
    by_inbox_bucket: {},
    by_universal_status: {},
    by_universal_stage: {},
    by_market: {},
  }

  while (true) {
    let query = supabase
      .from(DEAL_CONTEXT_SOURCE)
      .select([
        'deal_context_id',
        'property_id',
        'thread_key',
        'latest_message_body',
        'owner_name',
        'property_address_full',
        'canonical_e164',
        'inbox_bucket',
        'universal_status',
        'universal_stage',
        'market',
      ].join(','))

    query = applyScalarFilters(query, params)
    query = query.order('deal_context_id', { ascending: true })
    query = query.range(offset, offset + limit - 1)

    const { data, error } = await query
    if (error) throw error

    const rows = Array.isArray(data) ? data : []
    if (rows.length === 0) break

    for (const row of rows) {
      summary.total += 1
      if (clean(row.property_id)) summary.with_property_id += 1
      if (clean(row.thread_key)) summary.with_thread_key += 1
      if (clean(row.latest_message_body)) summary.with_latest_message_body += 1
      if (clean(row.owner_name)) summary.with_owner_name += 1
      if (clean(row.property_address_full)) summary.with_property_address_full += 1
      if (clean(row.canonical_e164)) summary.with_canonical_e164 += 1
      incrementCount(summary.by_inbox_bucket, row.inbox_bucket)
      incrementCount(summary.by_universal_status, row.universal_status)
      incrementCount(summary.by_universal_stage, row.universal_stage)
      incrementCount(summary.by_market, row.market)
    }

    rowsRead += rows.length
    offset += rows.length
    if (rows.length < limit) break
  }

  return {
    ...summary,
    scan: {
      chunk_size: limit,
      rows_read: rowsRead,
    },
  }
}
