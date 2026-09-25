import { supabase } from '@/lib/supabase/client.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'
import { createRequestTimer } from './server-timing.js'

const QUEUE_PAGE_COLUMNS = [
  'id', 'queue_status', 'priority', 'market', 'retry_count', 'max_retries',
  'created_at', 'updated_at', 'scheduled_for', 'scheduled_for_utc', 'sent_at', 'delivered_at',
  'to_phone_number', 'from_phone_number', 'property_id', 'owner_id', 'master_owner_id', 'prospect_id',
  'thread_key', 'template_id', 'use_case_template', 'message_type', 'metadata',
  'message_body', 'message_text', 'touch_number', 'current_stage', 'queue_key',
  'failed_reason', 'blocked_reason', 'paused_reason', 'guard_reason', 'property_address',
  /**
   * §10/§11 — A CAMPAIGN QUEUE ROW MUST NOT ARRIVE ANONYMOUS.
   *
   * Both columns exist on `send_queue` and are populated by campaign
   * materialization, and neither was selected here. So a row created by a
   * campaign reached the Queue surface with no campaign identity at all: the
   * operator could see a message to a phone number about a property and had no
   * way to tell WHICH campaign put it there, no way to deep-link back, and no
   * way to answer "why is this scheduled" without querying the database by
   * hand — which is exactly what the Queue is supposed to make unnecessary.
   */
  'campaign_id', 'campaign_target_id',
  // The asset the message is about, and the language it is written in —
  // shown in the mobile detail so a template/asset mismatch is visible.
  'property_type', 'language', 'selected_template_id', 'timezone', 'next_retry_at',
].join(',')

const OWNER_SELECT = 'master_owner_id,display_name,owner_type_guess,priority_score'
const PROSPECT_SELECT = 'prospect_id,master_owner_id,full_name,first_name'

/**
 * Status vocabulary → buckets. Built from what production actually writes
 * (2026-09-25: failed_transport 2,065, blocked_by_health_guard 250,
 * paused_operator_review 84, expired 3,754, cancelled 2,530 … none of which
 * any bucket counted, so the Queue under-reported failures ~7×).
 */
const FAILED_VALUES = ['failed', 'failed_transport', 'retry', 'retrying']
const BLOCKED_VALUES = [
  'blocked', 'blocked_by_health_guard', 'blocked_sender_ineligible', 'paused_sender_eligibility_unavailable',
  'paused_invalid_queue_row', 'paused_name_missing', 'paused_max_retries', 'paused_duplicate',
  'paused_global_lock', 'paused_operator_review', 'paused_deferred_unresolved', 'duplicate_blocked',
  'incident_quarantine',
]
const APPROVAL_VALUES = ['approval', 'awaiting_approval']

const STATUS_BUCKET_VALUES = {
  scheduled: ['scheduled'],
  queued: ['queued', 'ready', 'pending'],
  sending: ['sending', 'processing'],
  sent: ['sent', 'delivered', ...FAILED_VALUES],
  delivered: ['delivered'],
  failed: FAILED_VALUES,
  blocked: BLOCKED_VALUES,
  approval: APPROVAL_VALUES,
  // Mobile dispatch segments.
  ready: ['queued', 'ready', 'pending', 'approved'],
  attention: [...FAILED_VALUES, ...BLOCKED_VALUES, ...APPROVAL_VALUES],
  history: ['sent', 'delivered', 'cancelled', 'expired', 'replied_before_send'],
}

/**
 * Live work is shown whenever it was created: a row scheduled for tomorrow
 * that was materialized nine days ago is still tomorrow's send. Only
 * attention and history are windowed by the date range.
 */
const LIVE_BUCKETS = new Set(['ready', 'scheduled', 'sending'])
const SEGMENTS = ['ready', 'scheduled', 'sending', 'attention', 'history']

/** Soonest-first for work that has not gone out; most recent first otherwise. */
const BUCKET_ORDER = {
  ready: ['scheduled_for', true],
  scheduled: ['scheduled_for', true],
  sending: ['updated_at', false],
  attention: ['updated_at', false],
  history: ['sent_at', false],
}

/** Search text → a PostgREST-safe ilike term, or null. */
function searchTerm(q) {
  const t = clean(q).replace(/[^\p{L}\p{N}\s#'-]/gu, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 2 ? t.slice(0, 60) : null
}

function applySearch(query, q) {
  const term = searchTerm(q)
  if (!term) return query
  const digits = term.replace(/\D/g, '')
  const ors = [`property_address.ilike.*${term}*`, `message_body.ilike.*${term}*`]
  if (digits.length >= 3) ors.push(`to_phone_number.ilike.*${digits}*`)
  return query.or(ors.join(','))
}

function clean(value) {
  return String(value ?? '').trim()
}

function applyRangeFilters(query, opts = {}, { live = false } = {}) {
  let out = query
  const dateBasis = ['created_at', 'scheduled_for', 'updated_at'].includes(opts.dateBasis)
    ? opts.dateBasis
    : 'created_at'
  if (!live && opts.dateFrom) out = out.gte(dateBasis, opts.dateFrom)
  if (!live && opts.dateTo) out = out.lte(dateBasis, opts.dateTo)
  if (opts.market && opts.market !== 'all') out = out.eq('market', opts.market)
  if (opts.sender && opts.sender !== 'all') out = out.eq('from_phone_number', opts.sender)
  return out
}

async function bucketCount(opts, values, { live = false, search = false } = {}) {
  let query = applyRangeFilters(
    supabase.from('send_queue').select('id', { count: 'exact', head: true }),
    opts,
    { live },
  ).in('queue_status', values)
  if (search) query = applySearch(query, opts.q)
  const res = await query
  if (res.error) throw res.error
  return Number(res.count || 0)
}

/** One count per mobile segment, with the same windowing and search as its list. */
async function fetchSegmentCounts(opts = {}) {
  const counts = await Promise.all(SEGMENTS.map((key) => (
    bucketCount(opts, STATUS_BUCKET_VALUES[key], { live: LIVE_BUCKETS.has(key), search: true }).catch(() => null)
  )))
  return Object.fromEntries(SEGMENTS.map((key, i) => [key, counts[i]]))
}

async function fetchRangeCounts(opts = {}) {
  const dateBasis = ['created_at', 'scheduled_for', 'updated_at'].includes(opts.dateBasis)
    ? opts.dateBasis
    : 'created_at'
  const market = opts.market && opts.market !== 'all' ? clean(opts.market) : null
  const sender = opts.sender && opts.sender !== 'all' ? clean(opts.sender) : null

  const { data, error } = await supabase.rpc('cockpit_queue_page_range_counts', {
    p_date_basis: dateBasis,
    p_date_from: opts.dateFrom || null,
    p_date_to: opts.dateTo || null,
    p_market: market,
    p_sender: sender,
  })

  if (!error && data && typeof data === 'object') {
    return {
      scheduled: Number(data.scheduled ?? 0),
      queued: Number(data.queued ?? 0),
      sending: Number(data.sending ?? 0),
      sent: Number(data.sent ?? 0),
      delivered: Number(data.delivered ?? 0),
      failed: Number(data.failed ?? 0),
      blocked: Number(data.blocked ?? 0),
      approval: Number(data.approval ?? 0),
      optOuts: Number(data.optOuts ?? 0),
      total: Number(data.total ?? 0),
    }
  }

  const [scheduled, queued, sending, sent, delivered, failed, blocked, approval] = await Promise.all([
    bucketCount(opts, STATUS_BUCKET_VALUES.scheduled),
    bucketCount(opts, STATUS_BUCKET_VALUES.queued),
    bucketCount(opts, STATUS_BUCKET_VALUES.sending),
    bucketCount(opts, STATUS_BUCKET_VALUES.sent),
    bucketCount(opts, STATUS_BUCKET_VALUES.delivered),
    bucketCount(opts, STATUS_BUCKET_VALUES.failed),
    bucketCount(opts, STATUS_BUCKET_VALUES.blocked),
    bucketCount(opts, STATUS_BUCKET_VALUES.approval),
  ])
  return { scheduled, queued, sending, sent, delivered, failed, blocked, approval, optOuts: 0, total: 0 }
}

function queuePageCacheKey(opts = {}) {
  return [
    'cockpit:queue-page',
    opts.page ?? 0,
    opts.pageSize ?? 25,
    opts.status ?? 'all',
    opts.dateBasis ?? 'created_at',
    opts.dateFrom ?? '',
    opts.dateTo ?? '',
    opts.market ?? 'all',
    opts.sender ?? 'all',
    searchTerm(opts.q) ?? '',
    opts.segmentCounts ? 'seg' : '',
  ].join(':')
}

async function loadQueuePage(opts = {}) {
  const timer = createRequestTimer('queue-page')
  const page = Math.max(0, Math.floor(opts.page ?? 0))
  const pageSize = Math.max(1, Math.min(100, Math.floor(opts.pageSize ?? 25)))
  const statusBucket = opts.status && opts.status !== 'all' ? opts.status : null
  const statusValues = statusBucket ? STATUS_BUCKET_VALUES[statusBucket] ?? null : null
  const dateBasis = ['created_at', 'scheduled_for', 'updated_at'].includes(opts.dateBasis)
    ? opts.dateBasis
    : 'created_at'

  let tableQuery = applyRangeFilters(
    supabase.from('send_queue').select(QUEUE_PAGE_COLUMNS, { count: 'exact' }),
    opts,
    { live: LIVE_BUCKETS.has(statusBucket) },
  )
  if (statusValues) tableQuery = tableQuery.in('queue_status', statusValues)
  tableQuery = applySearch(tableQuery, opts.q)
  const [orderColumn, ascending] = BUCKET_ORDER[statusBucket] ?? [dateBasis, false]

  const [queueResult, rangeCounts, segmentCounts] = await Promise.all([
    tableQuery
      .order(orderColumn, { ascending, nullsFirst: false })
      .order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1),
    fetchRangeCounts(opts),
    opts.segmentCounts ? fetchSegmentCounts(opts) : Promise.resolve(null),
  ])
  timer.mark('supabase_queries')

  if (queueResult.error) throw queueResult.error

  const rows = (Array.isArray(queueResult.data) ? queueResult.data : []).map((row) => {
    const body = clean(row.message_body || row.message_text)
    if (!body || body.length <= 240) return row
    const preview = `${body.slice(0, 239)}…`
    return { ...row, message_body: preview, message_text: preview }
  })
  const totalCount = Number(queueResult.count ?? rows.length)
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const propertyIds = [...new Set(rows.map((row) => clean(row.property_id)).filter(Boolean))]
  const ownerIds = [...new Set(rows.flatMap((row) => {
    const ids = [clean(row.master_owner_id), clean(row.owner_id)]
    const md = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    if (clean(md.master_owner_id)) ids.push(clean(md.master_owner_id))
    return ids.filter(Boolean)
  }))]
  const prospectIds = [...new Set(rows.flatMap((row) => {
    const ids = [clean(row.prospect_id)]
    const md = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    if (clean(md.prospect_id)) ids.push(clean(md.prospect_id))
    return ids.filter(Boolean)
  }))]
  const campaignIds = [...new Set(rows.flatMap((row) => {
    const ids = []
    const md = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const targetSnapshot = md.target_snapshot && typeof md.target_snapshot === 'object' ? md.target_snapshot : {}
    if (clean(row.campaign_id)) ids.push(clean(row.campaign_id))
    if (clean(md.campaign_id)) ids.push(clean(md.campaign_id))
    if (clean(targetSnapshot.campaign_id)) ids.push(clean(targetSnapshot.campaign_id))
    return ids.filter(Boolean)
  }))]

  const [propertiesResult, ownersResult, prospectsResult, campaignsResult, textgridResult] = await Promise.all([
    propertyIds.length
      ? supabase
        .from('properties')
        .select('property_id,owner_id,master_owner_id,property_address,property_address_city,property_address_state,property_address_zip,market,property_type,units_count,asset_subclass')
        .in('property_id', propertyIds.slice(0, 100))
      : Promise.resolve({ data: [], error: null }),
    ownerIds.length
      ? supabase
        .from('master_owners')
        .select(OWNER_SELECT)
        .in('master_owner_id', ownerIds.slice(0, 100))
      : Promise.resolve({ data: [], error: null }),
    prospectIds.length
      ? supabase
        .from('prospects')
        .select(PROSPECT_SELECT)
        .in('prospect_id', prospectIds.slice(0, 100))
      : Promise.resolve({ data: [], error: null }),
    campaignIds.length
      ? supabase
        .from('campaigns')
        .select('id,name,status')
        .in('id', campaignIds.slice(0, 100))
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('textgrid_numbers')
      .select('id,phone_number,friendly_name,market,status,daily_limit,messages_sent_today,last_used_at,health_score,metadata'),
  ])

  const properties = propertiesResult.error ? [] : (propertiesResult.data || [])
  const owners = ownersResult.error ? [] : (ownersResult.data || [])
  const prospects = prospectsResult.error ? [] : (prospectsResult.data || [])
  const campaigns = campaignsResult.error ? [] : (campaignsResult.data || [])
  const textgridNumbers = textgridResult.error ? [] : (textgridResult.data || [])
  timer.mark('enrichment')

  const response = {
    items: rows,
    properties,
    owners,
    prospects,
    campaigns,
    textgridNumbers,
    totalCount,
    currentPage: page,
    pageSize,
    totalPages,
    hasMore: page < totalPages - 1,
    rangeCounts: {
      ...rangeCounts,
      total: rangeCounts.total > 0 ? rangeCounts.total : totalCount,
    },
    segmentCounts,
    fetchOptions: opts,
    queryMs: timer.summary().totalMs,
    sourceUsed: 'api:queue-page',
    timing: timer.summary(),
  }

  timer.mark('serialization')
  return response
}

export async function fetchQueuePage(opts = {}) {
  return readThroughCache(queuePageCacheKey(opts), 5_000, () => loadQueuePage(opts))
}