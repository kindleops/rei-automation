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
].join(',')

const OWNER_SELECT = 'master_owner_id,display_name,owner_type_guess,priority_score'
const PROSPECT_SELECT = 'prospect_id,master_owner_id,full_name,first_name'

const STATUS_BUCKET_VALUES = {
  scheduled: ['scheduled'],
  queued: ['queued', 'ready', 'pending'],
  sending: ['sending'],
  sent: ['sent', 'delivered', 'failed', 'retry', 'retrying'],
  delivered: ['delivered'],
  failed: ['failed', 'retry', 'retrying'],
  blocked: [
    'blocked', 'paused_invalid_queue_row', 'paused_name_missing', 'paused_max_retries',
    'paused_duplicate', 'paused_global_lock', 'duplicate_blocked', 'incident_quarantine',
  ],
  approval: ['approval', 'awaiting_approval'],
}

function clean(value) {
  return String(value ?? '').trim()
}

function applyRangeFilters(query, opts = {}) {
  let out = query
  const dateBasis = ['created_at', 'scheduled_for', 'updated_at'].includes(opts.dateBasis)
    ? opts.dateBasis
    : 'created_at'
  if (opts.dateFrom) out = out.gte(dateBasis, opts.dateFrom)
  if (opts.dateTo) out = out.lte(dateBasis, opts.dateTo)
  if (opts.market && opts.market !== 'all') out = out.eq('market', opts.market)
  if (opts.sender && opts.sender !== 'all') out = out.eq('from_phone_number', opts.sender)
  return out
}

async function bucketCount(opts, values) {
  const res = await applyRangeFilters(
    supabase.from('send_queue').select('id', { count: 'exact', head: true }),
    opts,
  ).in('queue_status', values)
  if (res.error) throw res.error
  return Number(res.count || 0)
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
  )
  if (statusValues) tableQuery = tableQuery.in('queue_status', statusValues)

  const [queueResult, scheduled, queued, sending, sent, delivered, failed, blocked, approval] = await Promise.all([
    tableQuery
      .order(dateBasis, { ascending: false, nullsFirst: false })
      .range(page * pageSize, page * pageSize + pageSize - 1),
    bucketCount(opts, STATUS_BUCKET_VALUES.scheduled),
    bucketCount(opts, STATUS_BUCKET_VALUES.queued),
    bucketCount(opts, STATUS_BUCKET_VALUES.sending),
    bucketCount(opts, STATUS_BUCKET_VALUES.sent),
    bucketCount(opts, STATUS_BUCKET_VALUES.delivered),
    bucketCount(opts, STATUS_BUCKET_VALUES.failed),
    bucketCount(opts, STATUS_BUCKET_VALUES.blocked),
    bucketCount(opts, STATUS_BUCKET_VALUES.approval),
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

  const [propertiesResult, ownersResult, prospectsResult] = await Promise.all([
    propertyIds.length
      ? supabase
        .from('properties')
        .select('property_id,owner_id,master_owner_id,property_address,property_address_city,property_address_state,property_address_zip,market')
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
  ])

  const properties = propertiesResult.error ? [] : (propertiesResult.data || [])
  const owners = ownersResult.error ? [] : (ownersResult.data || [])
  const prospects = prospectsResult.error ? [] : (prospectsResult.data || [])
  timer.mark('enrichment')

  const response = {
    items: rows,
    properties,
    owners,
    prospects,
    totalCount,
    currentPage: page,
    pageSize,
    totalPages,
    hasMore: page < totalPages - 1,
    rangeCounts: {
      scheduled, queued, sending, sent, delivered, failed, blocked, approval,
      optOuts: 0,
      total: totalCount,
    },
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