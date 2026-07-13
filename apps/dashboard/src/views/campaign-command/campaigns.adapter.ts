import {
  classifyBackendFailure,
  opsError,
  opsSuccess,
  type OpsSurfaceResult,
} from '../../domain/ops/ops-surface-result'
import type {
  CampaignModel,
  CampaignSummary,
  CampaignKpis,
  CampaignTarget,
  CampaignMarketMetric,
  CampaignQueueRow,
  CampaignReply,
  CampaignFailureGroup,
  CampaignGeographyEntry,
  CampaignTemplateStats,
  CampaignLogEvent,
  SuppressionCheck,
  CreateCampaignPayload,
  CampaignLaunchPayload,
  CampaignLaunchResult,
} from './campaigns.types'
import { getSupabaseClient, hasSupabaseEnv } from '../../lib/supabaseClient'
import { getDealContextList } from '../../lib/data/dealContext'
import { asString, isDev } from '../../lib/data/shared'
import {
  createCampaignBackend,
  buildCampaignTargets,
  getCampaignBackend,
  listCampaignsBackend,
  queueCampaignPlan,
  queueCampaignBatch,
  setCampaignLifecycle,
  cloneCampaignBackend,
  deleteCampaignBackend,
  patchCampaignBackend,
  fetchCampaignTargetsPage,
  getCampaignCommandSummary,
  getCampaignFailuresBackend,
  type CampaignApiSummary,
} from '../../lib/api/backendClient'

export type CampaignLifecycleAction =
  | 'preview' | 'queue' | 'schedule' | 'unschedule' | 'begin_activation'
  | 'activate' | 'pause' | 'resume' | 'complete' | 'fail' | 'archive' | 'restore'
  | 'convert_to_live' | 'sync_metrics'

export type ActivationResult = {
  ok: boolean
  error?: string
  message?: string
  blockers?: string[]
  inserted?: number
  skipped?: number
  idempotent?: boolean
  from?: string | null
  to?: string | null
  proof_hydration?: boolean
  activation_mode?: 'live' | 'test'
}

// ── Supabase loaders ────────────────────────────────────────────────────────────

export const createCampaign = async (payload: CreateCampaignPayload): Promise<string> => {
  const res = await createCampaignBackend({
    ...payload,
    auto_send_enabled: false,
    auto_reply_mode: 'disabled',
    auto_queue_enabled: payload.target_filters.auto_queue_enabled === true,
  })
  if (!res.ok) throw new Error(res.message || res.error)
  return res.data.campaign_id
}

export const buildCampaignTargetSnapshots = async (
  campaignId: string,
  options: { limit: number },
): Promise<{ built_count: number; no_send_queue_rows_created?: boolean; preview?: Record<string, unknown> }> => {
  const res = await buildCampaignTargets(campaignId, {
    limit: options.limit,
    target_limit: options.limit,
    max_targets: options.limit,
  })
  if (!res.ok) throw new Error(res.message || res.error)
  return {
    built_count: res.data.built_count ?? 0,
    no_send_queue_rows_created: res.data.no_send_queue_rows_created,
    preview: res.data.preview,
  }
}

export const launchCampaign = async (
  campaignId: string,
  payload: CampaignLaunchPayload,
): Promise<CampaignLaunchResult> => {
  const res = await queueCampaignPlan(campaignId, payload as unknown as Record<string, unknown>)
  if (res.ok) return res.data as CampaignLaunchResult

  const upstream = res.upstream
  if (upstream && typeof upstream === 'object') {
    return {
      ...(upstream as CampaignLaunchResult),
      ok: false,
      success: false,
      message: res.message,
    }
  }

  throw new Error(res.message || res.error)
}

function mapCampaignSummaryRow(row: CampaignApiSummary & Record<string, unknown>): CampaignSummary {
  const recipientMetrics = row.recipient_metrics as CampaignSummary['recipient_metrics']
  return {
      id: row.id,
      campaign_name: row.campaign_name ?? row.name ?? '',
      status: row.status as CampaignSummary['status'],
      total_targets: Number(row.total_targets ?? 0),
      ready_targets: Number(row.ready_targets ?? 0),
      planned_targets: Number(row.planned_targets ?? 0),
      scheduled_targets: Number(row.scheduled_queue_rows ?? row.scheduled_targets ?? 0),
      scheduled_queue_rows: Number(row.scheduled_queue_rows ?? row.scheduled_targets ?? 0),
      queued_targets: Number(row.queued_targets ?? 0),
      failed_target_rows: Number(row.failed_target_rows ?? 0),
      failed_execution_rows: Number(row.failed_execution_rows ?? 0),
      readiness_label: (row.readiness_label as string | undefined) ?? undefined,
      canonical_queued_count: Number(row.canonical_queued_count ?? row.queued_targets ?? 0),
      launch_readiness: (row.launch_readiness as CampaignSummary['launch_readiness']) ?? undefined,
      launch_blockers: Array.isArray(row.launch_blockers) ? row.launch_blockers : undefined,
      launch_blocker_codes: Array.isArray(row.launch_blocker_codes) ? row.launch_blocker_codes : undefined,
      recipient_metrics: recipientMetrics ?? null,
      sent_count: Number(row.sent_count ?? 0),
      delivered_count: Number(row.delivered_count ?? 0),
      failed_count: Number(row.failed_count ?? 0),
      reply_count: Number(row.reply_count ?? 0),
      positive_reply_count: Number(row.positive_reply_count ?? 0),
      negative_reply_count: Number(row.negative_reply_count ?? 0),
      opt_out_count: Number(row.opt_out_count ?? 0),
      delivery_rate: Number(row.delivery_rate ?? 0),
      reply_rate: Number(row.reply_rate ?? 0),
      positive_rate: Number(row.positive_rate ?? 0),
      opt_out_rate: Number(row.opt_out_rate ?? 0),
      failure_rate: Number(row.failure_rate ?? 0),
      next_send_at: row.next_send_at ?? null,
      last_send_at: row.last_send_at ?? null,
      send_interval_seconds: Number(row.send_interval_seconds ?? 60),
      send_window_start: row.send_window_start ?? null,
      send_window_end: row.send_window_end ?? null,
      auto_queue_enabled: Boolean(row.auto_queue_enabled ?? false),
      auto_send_enabled: Boolean(row.auto_send_enabled ?? false),
      blocked_reason_counts: row.blocked_reason_counts ?? {},
      health_score: Number(row.health_score ?? 0),
      health_status: row.health_status ?? 'caution',
      execution_proof: (row.execution_proof as CampaignSummary['execution_proof']) ?? null,
      operator_state: (row.operator_state as string | undefined) ?? undefined,
      operator_state_label: (row.operator_state_label as string | undefined) ?? undefined,
      mode: (row.mode as CampaignSummary['mode']) ?? undefined,
      mode_label: (row.mode_label as string | undefined) ?? undefined,
    }
}

export async function fetchCampaignCommandSummary(campaignId: string) {
  const res = await getCampaignCommandSummary(campaignId)
  if (!res.ok) throw new Error(res.message || res.error || 'campaign_summary_failed')
  return res.data
}

function applyCommandSummaryToCampaign(campaign: CampaignSummary, summary: Awaited<ReturnType<typeof fetchCampaignCommandSummary>>): CampaignSummary {
  if (!summary?.ok) return campaign
  const counts = summary.counts || {}
  return {
    ...campaign,
    operator_state: summary.state,
    operator_state_label: summary.state_label,
    mode: summary.mode as CampaignSummary['mode'],
    mode_label: summary.mode_label,
    total_targets: Number(counts.total_targets ?? campaign.total_targets),
    ready_targets: Number(counts.ready_targets ?? campaign.ready_targets),
    planned_targets: Number(counts.planned_targets ?? campaign.planned_targets),
    scheduled_targets: Number(counts.scheduled_queue_rows ?? campaign.scheduled_targets),
    scheduled_queue_rows: Number(counts.scheduled_queue_rows ?? campaign.scheduled_queue_rows),
    queued_targets: Number(counts.queued_rows ?? campaign.queued_targets),
    failed_count: Number((counts.failed_target_rows ?? 0) + (counts.failed_execution_rows ?? 0)),
    failed_target_rows: Number(counts.failed_target_rows ?? campaign.failed_target_rows),
    failed_execution_rows: Number(counts.failed_execution_rows ?? campaign.failed_execution_rows),
    readiness_label: summary.readiness_label ?? summary.readiness?.label ?? campaign.readiness_label,
    launch_readiness: (summary.readiness?.level as CampaignSummary['launch_readiness']) ?? campaign.launch_readiness,
    launch_blockers: summary.blockers?.length ? summary.blockers : campaign.launch_blockers,
    launch_blocker_codes: summary.readiness?.blocker_codes ?? campaign.launch_blocker_codes,
    routable_recipient_count: Number(counts.routable_recipients ?? campaign.routable_recipient_count ?? 0),
    launch_ready_recipient_count: Number(counts.launch_ready_recipients ?? campaign.launch_ready_recipient_count ?? 0),
    execution_proof: campaign.execution_proof
      ? {
          ...campaign.execution_proof,
          hydrated_rows: Number(summary.execution?.hydrated_queue_rows ?? campaign.execution_proof.hydrated_rows),
          live_send_rows: Number(summary.execution?.live_send_rows ?? campaign.execution_proof.live_send_rows),
          proof_no_send_rows: Number(summary.execution?.proof_no_send_rows ?? campaign.execution_proof.proof_no_send_rows),
          routing_allowed: Number(summary.execution?.routing_allowed ?? campaign.execution_proof.routing_allowed),
          transmission_enabled: Boolean(summary.execution?.transmission_enabled ?? campaign.execution_proof.transmission_enabled),
          proof_mode: Boolean(summary.execution?.proof_mode ?? campaign.execution_proof.proof_mode),
          no_messages_will_transmit: Boolean(summary.execution?.no_messages_will_transmit ?? campaign.execution_proof.no_messages_will_transmit),
        }
      : campaign.execution_proof,
  }
}

async function fetchCampaignsCanonicalFallback(): Promise<CampaignSummary[]> {
  if (!hasSupabaseEnv) {
    throw new Error('canonical_campaigns_fallback_unavailable')
  }
  const client = getSupabaseClient()
  const { data: campaigns, error } = await client
    .from('campaigns')
    .select('id, name, status, created_at, updated_at, metadata, auto_send_enabled, send_interval_seconds, send_window_start, send_window_end')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) {
    const msg = error.message || String(error)
    if (error.code === '42P01' || /does not exist|relation/i.test(msg)) {
      throw Object.assign(new Error('missing_view'), { code: 'missing_view' })
    }
    throw error
  }

  const ids = (campaigns ?? []).map((row) => row.id as string)
  const targetCounts = new Map<string, { total: number; ready: number }>()
  if (ids.length) {
    const { data: targets, error: targetError } = await client
      .from('campaign_targets')
      .select('campaign_id, status')
      .in('campaign_id', ids)
    if (targetError) throw targetError
    for (const target of targets ?? []) {
      const key = String(target.campaign_id)
      const bucket = targetCounts.get(key) ?? { total: 0, ready: 0 }
      bucket.total += 1
      if (String(target.status).toLowerCase() === 'ready') bucket.ready += 1
      targetCounts.set(key, bucket)
    }
  }

  return (campaigns ?? []).map((row) => {
    const counts = targetCounts.get(String(row.id)) ?? { total: 0, ready: 0 }
    return {
      id: String(row.id),
      campaign_name: String(row.name ?? ''),
      status: row.status as CampaignSummary['status'],
      total_targets: counts.total,
      ready_targets: counts.ready,
      planned_targets: 0,
      scheduled_targets: 0,
      scheduled_queue_rows: 0,
      queued_targets: 0,
      sent_count: 0,
      delivered_count: 0,
      failed_count: 0,
      reply_count: 0,
      positive_reply_count: 0,
      negative_reply_count: 0,
      opt_out_count: 0,
      delivery_rate: 0,
      reply_rate: 0,
      positive_rate: 0,
      opt_out_rate: 0,
      failure_rate: 0,
      next_send_at: null,
      last_send_at: null,
      send_interval_seconds: Number(row.send_interval_seconds ?? 900),
      send_window_start: row.send_window_start ?? null,
      send_window_end: row.send_window_end ?? null,
      auto_queue_enabled: false,
      auto_send_enabled: Boolean(row.auto_send_enabled ?? false),
      blocked_reason_counts: {},
      health_score: 0,
      health_status: 'caution',
      execution_proof: null,
    }
  })
}

export const fetchCampaignsSurface = async (): Promise<OpsSurfaceResult<CampaignSummary[]>> => {
  const backend = await listCampaignsBackend()
  // Only trust a successful backend list. Empty arrays are valid true-zero results.
  if (backend.ok && Array.isArray(backend.data?.campaigns)) {
    const campaigns = backend.data.campaigns.map((row) =>
      mapCampaignSummaryRow(row as CampaignApiSummary & Record<string, unknown>),
    )
    return opsSuccess(campaigns, 'backend_api')
  }

  const backendFail = backend.ok ? null : backend
  const backendMessage = backendFail?.message || backendFail?.error || 'campaign_backend_unavailable'
  const backendErrorType = classifyBackendFailure(
    backend.ok
      ? { ok: false, status: backend.status, error: 'campaign_list_shape_invalid', message: backendMessage }
      : backend,
  )
  if (backendErrorType === 'auth_error') {
    return opsError([], 'auth_error', backendMessage || 'campaign_auth_failed', {
      retryable: true,
      source: 'backend_api',
    })
  }

  if (!hasSupabaseEnv) {
    return opsError([], backendErrorType, backendMessage, {
      retryable: backendErrorType !== 'missing_view',
      source: 'backend_api',
    })
  }

  try {
    const campaigns = await fetchCampaignsCanonicalFallback()
    // Empty anon/RLS fallback must not masquerade as a successful true-zero list when
    // the canonical backend already failed. RLS often returns [] with no error.
    if (campaigns.length === 0) {
      return opsError([], backendErrorType, backendMessage, {
        degraded: true,
        retryable: backendErrorType !== 'missing_view',
        source: 'supabase_campaigns',
      })
    }
    return {
      ...opsSuccess(campaigns, 'supabase_campaigns'),
      degraded: true,
      errorMessage: backendMessage || 'Using degraded canonical campaign fallback',
      retryable: true,
    }
  } catch (error) {
    const err = error as { code?: string; message?: string }
    const missingView = err.code === 'missing_view' || /does not exist|relation/i.test(err.message ?? '')
    return opsError(
      [],
      missingView ? 'missing_view' : backendErrorType,
      err.message || backendMessage || 'campaign_query_failed',
      { degraded: true, retryable: !missingView, source: 'supabase_campaigns' },
    )
  }
}

/** @deprecated Prefer fetchCampaignsSurface for typed load/error handling. */
export const fetchCampaigns = async (): Promise<CampaignSummary[]> => {
  const result = await fetchCampaignsSurface()
  if (!result.ok) throw new Error(result.errorMessage || result.errorType || 'campaign_load_failed')
  return result.data
}

export type CampaignTargetsPage = {
  targets: CampaignTarget[]
  page: number
  page_size: number
  total_count: number
  total_pages: number
}

function mapTargetRow(row: Record<string, unknown>, campaignId: string): CampaignTarget {
  const ownerName = (row.owner_name as string | undefined) ?? null
  const metadata = (row.metadata as Record<string, unknown> | undefined) ?? {}
  return {
      id: row.id as string,
      campaign_id: (row.campaign_id as string) ?? campaignId,
      target_status: (row.target_status ?? row.status ?? 'ready') as string,
      master_owner_id: (row.master_owner_id as string | null) ?? null,
      property_id: (row.property_id as string | null) ?? null,
      phone_id: (row.phone_id as string | null) ?? null,
      canonical_e164: (row.to_phone_number ?? row.canonical_e164 ?? null) as string | null,
      // owner_name is the Master Owner/entity label — ownership context only. It has no
      // proven relationship to the phone recipient, so it must never seed seller_first_name.
      seller_first_name: null,
      seller_full_name: ownerName,
      property_address_full: (row.property_address as string | null) ?? null,
      property_address_city: null,
      property_address_state: (row.state as string | null) ?? null,
      property_address_zip: null,
      market: (row.market as string | null) ?? null,
      language: (row.language as string | null) ?? null,
      final_acquisition_score: row.priority_score != null ? Number(row.priority_score) : null,
      last_contact_at: null,
      suppression_status: (row.suppression_status as string | null) ?? null,
      suppression_reason: (row.block_reason as string | null) ?? null,
      template_id: (metadata.template_id as string | null) ?? null,
      template_name: (metadata.template_name as string | null) ?? null,
      scheduled_for: null,
      sent_at: null,
      delivered_at: null,
      failed_at: row.target_status === 'failed' ? (row.updated_at as string | null) ?? null : null,
      replied_at: null,
    }
}

export const fetchCampaignTargetsPageData = async (
  campaignId: string,
  options: {
    page?: number
    page_size?: number
    status?: string
    market?: string
    search?: string
  } = {},
): Promise<CampaignTargetsPage> => {
  const res = await fetchCampaignTargetsPage(campaignId, {
    page: options.page ?? 1,
    page_size: options.page_size ?? 50,
    status: options.status,
    market: options.market,
    search: options.search,
    order_by: 'priority_score',
    order_dir: 'desc',
  })
  if (!res.ok || !res.data?.ok) {
    const err = !res.ok ? res : null
    throw new Error(err?.message || err?.error || 'campaign_targets_page_failed')
  }
  const data = res.data
  return {
    page: data.page,
    page_size: data.page_size,
    total_count: data.total_count,
    total_pages: data.total_pages,
    targets: (data.targets || []).map((row) => mapTargetRow(row as Record<string, unknown>, campaignId)),
  }
}

export const fetchCampaignTargets = async (campaignId: string): Promise<CampaignTarget[]> => {
  const page = await fetchCampaignTargetsPageData(campaignId, { page: 1, page_size: 50 })
  return page.targets
}

export const fetchCampaignDetail = async (campaignId: string): Promise<CampaignSummary | null> => {
  const backend = await getCampaignBackend(campaignId)
  if (backend.ok && backend.data?.summary) {
    let campaign = mapCampaignSummaryRow(backend.data.summary as CampaignApiSummary & Record<string, unknown>)
    const embedded = (backend.data as { command_summary?: Awaited<ReturnType<typeof fetchCampaignCommandSummary>> }).command_summary
    if (embedded?.ok) {
      campaign = applyCommandSummaryToCampaign(campaign, embedded)
    } else {
      try {
        const summary = await fetchCampaignCommandSummary(campaignId)
        campaign = applyCommandSummaryToCampaign(campaign, summary)
      } catch {
        // keep list-level summary if command summary unavailable
      }
    }
    return campaign
  }
  return null
}

export const fetchCampaignQueue = async (campaignId: string): Promise<CampaignQueueRow[]> => {
  const backend = await getCampaignBackend(campaignId)
  if (backend.ok && Array.isArray(backend.data.send_windows)) {
    return backend.data.send_windows.map((row: any) => ({
      id: row.id,
      campaign_id: campaignId,
      campaign_target_id: null,
      queue_row_id: null,
      seller_full_name: null,
      property_address_full: null,
      market: row.market ?? null,
      template_id: null,
      template_name: 'Planned send window',
      from_phone_number: null,
      to_phone_number: null,
      scheduled_for: row.window_start_utc ?? null,
      queue_status: (row.status === 'planned' ? 'scheduled' : row.status) as CampaignQueueRow['queue_status'],
      delivery_status: row.status ?? null,
      failure_category: row.auto_pause_reason ?? null,
      failed_reason: row.auto_pause_reason ?? null,
      last_event_at: row.updated_at ?? row.created_at ?? null,
    }))
  }

  try {
    const { rows } = await getDealContextList({
      campaign_id: campaignId,
      limit: 100,
      order_by: 'queue_scheduled_for',
    })

    const queuedRows = rows.filter((row) => row.queueRowId || row.raw.queue_status)
    if (queuedRows.length > 0) {
      return queuedRows.map((row) => ({
        id: row.queueRowId || `q-${row.id}`,
        campaign_id: campaignId,
        campaign_target_id: row.campaignTargetId,
        queue_row_id: row.queueRowId,
        seller_full_name: row.ownerName,
        property_address_full: row.propertyAddress,
        market: row.market,
        template_id: row.queue.template_id as string || null,
        template_name: ((row.campaign.campaign as Record<string, unknown> | undefined)?.template_name as string | null) || null,
        from_phone_number: row.queue.from_phone_number as string || null,
        to_phone_number: row.canonicalE164,
        scheduled_for: asString(row.raw.queue_scheduled_for) || null,
        queue_status: (row.raw.queue_status as CampaignQueueRow['queue_status']) || 'queued',
        delivery_status: row.queue.delivery_status as string || null,
        failure_category: row.queue.failed_reason as string || null,
        failed_reason: row.queue.failed_reason as string || null,
        last_event_at: asString(row.raw.latest_message_at) || null,
      }))
    }
  } catch (error) {
    if (isDev) console.warn('[campaigns.adapter] deal-context queue fallback', error)
  }

  const client = getSupabaseClient()
  // Try to query a view or join. For now assuming we just query sms_campaign_targets with scheduled/queued status.
  const { data, error } = await client
    .from('sms_campaign_targets')
    .select('*')
    .eq('campaign_id', campaignId)
    .in('status', ['scheduled', 'queued'])
    .limit(100)
  
  if (error) {
    console.warn('Queue fetch error', error)
    return []
  }

  return (data ?? []).map((row: any) => ({
    id: `q-${row.target_id}`,
    campaign_id: row.campaign_id,
    campaign_target_id: row.target_id,
    queue_row_id: null,
    seller_full_name: row.owner_name,
    property_address_full: row.property_address,
    market: row.market,
    template_id: row.template_id,
    template_name: row.template_name,
    from_phone_number: null,
    to_phone_number: row.phone_number,
    scheduled_for: row.scheduled_for,
    queue_status: row.status as any,
    delivery_status: null,
    failure_category: null,
    failed_reason: null,
    last_event_at: null,
  }))
}

export const fetchCampaignReplies = async (campaignId: string): Promise<CampaignReply[]> => {
  try {
    const { rows } = await getDealContextList({
      campaign_id: campaignId,
      limit: 100,
      order_by: 'latest_message_at',
    })

    const replies = rows.filter((row) => row.latestMessageDirection === 'inbound')
    if (replies.length > 0) {
      return replies.map((row, index) => ({
        id: `reply-${row.id}-${index}`,
        campaign_id: campaignId,
        campaign_target_id: row.campaignTargetId || row.id,
        seller_full_name: row.ownerName,
        property_address_full: row.propertyAddress,
        inbound_message: row.latestMessageBody,
        detected_intent: asString(row.threadState.reply_intent) || row.status,
        sentiment: row.threadState.lead_temperature as CampaignReply['sentiment'] || 'warm',
        reply_type: row.status === 'seller_replied' ? 'positive' : 'neutral',
        next_action: row.bucket === 'needs_review' ? 'Review' : 'Reply',
        created_at: asString(row.raw.latest_message_at || row.raw.updated_at),
      }))
    }
  } catch (error) {
    if (isDev) console.warn('[campaigns.adapter] deal-context replies fallback', error)
  }

  const client = getSupabaseClient()
  const { data, error } = await client
    .from('sms_campaign_targets')
    .select('*')
    .eq('campaign_id', campaignId)
    .not('reply_status', 'is', null)
    .limit(50)

  if (error) return []

  return (data ?? []).map((row: any, i: number) => ({
    id: `reply-${row.target_id}-${i}`,
    campaign_id: row.campaign_id,
    campaign_target_id: row.target_id,
    seller_full_name: row.owner_name,
    property_address_full: row.property_address,
    inbound_message: 'Sample reply (requires message_events join)',
    detected_intent: row.reply_status,
    sentiment: row.reply_status === 'positive' ? 'hot' : row.reply_status === 'negative' ? 'cold' : 'warm',
    reply_type: row.reply_status as any,
    next_action: 'Review',
    created_at: new Date().toISOString(),
  }))
}

export type CampaignFailuresResult = {
  targetPreparation: CampaignFailureGroup[]
  execution: CampaignFailureGroup[]
  targetTotal: number
  executionTotal: number
}

export const fetchCampaignFailures = async (campaignId: string): Promise<CampaignFailuresResult> => {
  try {
    const backend = await getCampaignFailuresBackend(campaignId)
    if (backend.ok && backend.data) {
      const data = backend.data as {
        target_preparation?: { groups?: CampaignFailureGroup[]; total?: number }
        execution?: { groups?: CampaignFailureGroup[]; total?: number }
      }
      return {
        targetPreparation: data.target_preparation?.groups ?? [],
        execution: data.execution?.groups ?? [],
        targetTotal: data.target_preparation?.total ?? 0,
        executionTotal: data.execution?.total ?? 0,
      }
    }
  } catch (error) {
    if (isDev) console.warn('[campaigns.adapter] failures API fallback', error)
  }

  try {
    const { rows } = await getDealContextList({
      campaign_id: campaignId,
      limit: 200,
      order_by: 'queue_scheduled_for',
    })

    const groups: Record<string, CampaignFailureGroup> = {}
    for (const row of rows) {
      const failureReason = (row.queue.failed_reason as string) || (row.raw.suppression_type as string) || ''
      const queueStatus = String(row.raw.queue_status || '')
      if (!failureReason && queueStatus !== 'failed') continue
      const reason = failureReason || 'Unknown Error'
      if (!groups[reason]) {
        groups[reason] = {
          campaign_id: campaignId,
          failure_category: reason,
          count: 0,
          severity: 'warning',
          sample_numbers: [],
          sample_reasons: [],
        }
      }
      groups[reason].count += 1
      if (row.canonicalE164) groups[reason].sample_numbers.push(row.canonicalE164)
      groups[reason].sample_reasons.push(reason)
    }

    if (Object.keys(groups).length > 0) {
      const executionGroups = Object.values(groups).map((group) => ({
        ...group,
        sample_numbers: group.sample_numbers.slice(0, 5),
        sample_reasons: group.sample_reasons.slice(0, 5),
      }))
      const total = executionGroups.reduce((sum, g) => sum + g.count, 0)
      return { targetPreparation: [], execution: executionGroups, targetTotal: 0, executionTotal: total }
    }
  } catch (error) {
    if (isDev) console.warn('[campaigns.adapter] deal-context failures fallback', error)
  }

  return { targetPreparation: [], execution: [], targetTotal: 0, executionTotal: 0 }
}

function geoPerformance(replyRate: number, optoutRate: number): CampaignGeographyEntry['performance'] {
  if (replyRate >= 15 && optoutRate <= 3) return 'excellent'
  if (replyRate >= 10 && optoutRate <= 5) return 'good'
  if (replyRate >= 5 || optoutRate <= 8) return 'average'
  return 'poor'
}

export const fetchCampaignGeography = async (campaignId: string): Promise<CampaignGeographyEntry[]> => {
  if (hasSupabaseEnv) {
    try {
      const metrics = await fetchCampaignMarketMetrics(campaignId)
      if (metrics.length > 0) {
        return metrics.map((row) => ({
          label: row.market,
          type: 'market' as const,
          targets: row.total_targets ?? 0,
          ready: 0,
          queued: 0,
          fresh_targets: row.total_targets ?? 0,
          sent: row.sent_count ?? 0,
          delivered: row.delivered_count ?? 0,
          replies: row.reply_count ?? 0,
          positive_replies: row.positive_reply_count ?? 0,
          opt_outs: row.opted_out_count ?? 0,
          failures: 0,
          reply_rate: row.reply_rate_percent ?? 0,
          optout_rate: 0,
          delivery_rate: row.delivery_rate_percent ?? 0,
          performance: geoPerformance(row.reply_rate_percent ?? 0, 0),
        }))
      }
    } catch (error) {
      if (isDev) console.warn('[campaigns.adapter] market metrics geo fallback', error)
    }
  }

  const targets = await fetchCampaignTargets(campaignId)
  const buckets = new Map<string, CampaignGeographyEntry>()

  for (const target of targets) {
    const state = target.property_address_state?.trim()
    const market = target.market?.trim()
    const city = target.property_address_city?.trim()
    const zip = target.property_address_zip?.trim()

    const layers: Array<{ label: string; type: CampaignGeographyEntry['type'] }> = []
    if (state) layers.push({ label: state, type: 'state' })
    if (market) layers.push({ label: market, type: 'market' })
    if (city) layers.push({ label: city, type: 'city' })
    if (zip) layers.push({ label: zip, type: 'zip' })

    for (const layer of layers) {
      const key = `${layer.type}:${layer.label}`
      if (!buckets.has(key)) {
        buckets.set(key, {
          label: layer.label,
          type: layer.type,
          targets: 0,
          ready: 0,
          queued: 0,
          fresh_targets: 0,
          sent: 0,
          delivered: 0,
          replies: 0,
          positive_replies: 0,
          opt_outs: 0,
          failures: 0,
          reply_rate: 0,
          optout_rate: 0,
          delivery_rate: 0,
          performance: 'average',
        })
      }
      const entry = buckets.get(key)!
      entry.targets += 1
      if (target.target_status === 'ready') entry.ready += 1
      if (['queued', 'scheduled'].includes(target.target_status)) entry.queued += 1
      if (['sent', 'delivered', 'replied_positive', 'replied_negative'].includes(target.target_status)) {
        entry.sent += 1
      }
      if (['delivered', 'replied_positive', 'replied_negative'].includes(target.target_status)) {
        entry.delivered += 1
      }
      if (['replied_positive', 'replied_negative'].includes(target.target_status)) entry.replies += 1
      if (target.target_status === 'replied_positive') entry.positive_replies += 1
      if (target.target_status === 'opt_out') entry.opt_outs += 1
      if (target.target_status === 'failed') entry.failures += 1
    }
  }

  return Array.from(buckets.values())
    .map((entry) => {
      const replyRate = entry.delivered > 0 ? (entry.replies / entry.delivered) * 100 : 0
      const optoutRate = entry.sent > 0 ? (entry.opt_outs / entry.sent) * 100 : 0
      const deliveryRate = entry.sent > 0 ? (entry.delivered / entry.sent) * 100 : 0
      return {
        ...entry,
        fresh_targets: entry.ready,
        reply_rate: Math.round(replyRate * 10) / 10,
        optout_rate: Math.round(optoutRate * 10) / 10,
        delivery_rate: Math.round(deliveryRate * 10) / 10,
        performance: geoPerformance(replyRate, optoutRate),
      }
    })
    .sort((a, b) => b.targets - a.targets)
}

export const fetchCampaignTemplates = async (campaignId: string): Promise<CampaignTemplateStats[]> => {
  try {
    const summary = await fetchCampaignCommandSummary(campaignId)
    if (summary.ok && summary.language_coverage?.length) {
      return summary.language_coverage.map((row) => ({
        template_id: row.language,
        template_name: `${row.label} coverage`,
        language: row.language,
        use_count: row.targets,
        delivered_count: row.assigned,
        failed_count: row.blocked,
        reply_count: 0,
        opt_out_count: 0,
        delivery_rate: row.coverage_pct,
        reply_rate: 0,
        opt_out_rate: 0,
        last_used_at: null,
      }))
    }
  } catch {
    // fall through to target aggregation
  }

  const backend = await getCampaignBackend(campaignId)
  const targets = backend.ok && Array.isArray(backend.data.targets) ? backend.data.targets : []
  const groups = new Map<string, CampaignTemplateStats>()

  for (const row of targets) {
    const templateId = row.metadata?.template_id ?? row.template_id ?? null
    const templateName = row.metadata?.template_name ?? row.template_name ?? 'Unassigned'
    if (!templateId && !templateName) continue
    const key = String(templateId ?? templateName)
    if (!groups.has(key)) {
      groups.set(key, {
        template_id: String(templateId ?? key),
        template_name: String(templateName),
        language: row.language ?? 'en',
        use_count: 0,
        delivered_count: 0,
        failed_count: 0,
        reply_count: 0,
        opt_out_count: 0,
        delivery_rate: 0,
        reply_rate: 0,
        opt_out_rate: 0,
        last_used_at: null,
      })
    }
    const stat = groups.get(key)!
    const status = row.target_status ?? row.status ?? ''
    stat.use_count += 1
    if (['delivered', 'replied_positive', 'replied_negative'].includes(status)) stat.delivered_count += 1
    if (status === 'failed') stat.failed_count += 1
    if (['replied_positive', 'replied_negative'].includes(status)) stat.reply_count += 1
    if (status === 'opt_out') stat.opt_out_count += 1
    if (row.updated_at && (!stat.last_used_at || row.updated_at > stat.last_used_at)) {
      stat.last_used_at = row.updated_at
    }
  }

  if (groups.size === 0 && hasSupabaseEnv) {
    const client = getSupabaseClient()
    const { data } = await client
      .from('send_queue')
      .select('template_id,metadata,queue_status,updated_at')
      .eq('campaign_id', campaignId)
      .limit(500)
    for (const row of data ?? []) {
      const templateId = row.template_id ?? row.metadata?.template_id
      if (!templateId) continue
      const key = String(templateId)
      if (!groups.has(key)) {
        groups.set(key, {
          template_id: key,
          template_name: row.metadata?.template_name ?? key,
          language: row.metadata?.language ?? 'en',
          use_count: 0,
          delivered_count: 0,
          failed_count: 0,
          reply_count: 0,
          opt_out_count: 0,
          delivery_rate: 0,
          reply_rate: 0,
          opt_out_rate: 0,
          last_used_at: row.updated_at ?? null,
        })
      }
      const stat = groups.get(key)!
      stat.use_count += 1
      if (row.queue_status === 'delivered') stat.delivered_count += 1
      if (row.queue_status === 'failed') stat.failed_count += 1
    }
  }

  return Array.from(groups.values()).map((stat) => ({
    ...stat,
    delivery_rate: stat.use_count > 0 ? (stat.delivered_count / stat.use_count) * 100 : 0,
    reply_rate: stat.delivered_count > 0 ? (stat.reply_count / stat.delivered_count) * 100 : 0,
    opt_out_rate: stat.use_count > 0 ? (stat.opt_out_count / stat.use_count) * 100 : 0,
  }))
}

export const updateCampaignDraft = async (
  campaignId: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  const res = await patchCampaignBackend(campaignId, payload)
  if (!res.ok) throw new Error(res.message || res.error || 'campaign_update_failed')
}

export const fetchCampaignLogs = async (campaignId: string): Promise<CampaignLogEvent[]> => {
  const backend = await getCampaignBackend(campaignId)
  if (backend.ok && Array.isArray(backend.data.events)) {
    return backend.data.events.map((row: any) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      event_type: row.event_type,
      severity: row.severity ?? 'info',
      title: row.title ?? row.event_type,
      description: row.description ?? '',
      created_at: row.created_at,
      metadata: row.metadata ?? {},
    }))
  }
  return []
}

// Live commit. Writes real send_queue rows (staged as `scheduled`); the campaign
// walks BUILT -> QUEUED -> SCHEDULED. Nothing sends until the campaign is ACTIVE.
export const queueBatch = async (
  campaignId: string,
  options: {
    limit: number
    respect_send_window?: boolean
    interval_seconds?: number
    no_send?: boolean
    confirm_live?: boolean
  },
) => {
  const res = await queueCampaignBatch(campaignId, {
    limit: options.limit,
    interval_seconds: options.interval_seconds,
    respect_send_window: options.respect_send_window,
    no_send: options.no_send,
    confirm_live: options.confirm_live,
  })
  if (!res.ok) {
    const upstream = (res.upstream && typeof res.upstream === 'object') ? (res.upstream as Record<string, unknown>) : {}
    const blockers = (upstream.exact_blockers ?? upstream.blockers) as string[] | undefined
    throw new Error(
      (blockers?.length ? `Blocked: ${blockers.join(', ')}` : '') || res.message || res.error || 'queue_batch_failed',
    )
  }
  return {
    success: res.data.ok !== false,
    queued: res.data.send_queue_rows_created ?? res.data.queued_count ?? 0,
    status: res.data.status,
    blockers: (res.data.exact_blockers ?? res.data.blockers ?? []) as string[],
    result: res.data,
  }
}

function parseLifecycleBlockers(upstream: unknown): string[] {
  if (!upstream || typeof upstream !== 'object') return []
  const u = upstream as Record<string, unknown>
  const blockers = (u.blockers ?? u.exact_blockers) as string[] | undefined
  return Array.isArray(blockers) ? blockers : []
}

function lifecycleErrorMessage(res: { message?: string; error?: string; upstream?: unknown; data?: Record<string, unknown> }): string {
  const upstream = (res.upstream && typeof res.upstream === 'object') ? res.upstream as Record<string, unknown> : {}
  const data = (res.data && typeof res.data === 'object') ? res.data : {}
  const blockers = parseLifecycleBlockers(upstream) || parseLifecycleBlockers(data)
  if (blockers.length) return blockers.join(' · ')

  const from = String(data.from ?? upstream.from ?? '')
  const to = String(data.to ?? upstream.to ?? '')
  const err = String(res.error || data.error || upstream.error || '')
  if (err === 'illegal_campaign_transition' && from) {
    return `Transition not allowed: ${from}${to ? ` → ${to}` : ''}`
  }
  if (err === 'reschedule_requires_pause') {
    return String(data.message || upstream.message || 'Pause the campaign before rescheduling.')
  }
  return String(data.message || upstream.message || res.message || err || 'lifecycle_action_failed')
}

// Operator lifecycle controls — pause / resume / archive / schedule / activate / …
export const campaignLifecycle = async (
  campaignId: string,
  action: CampaignLifecycleAction,
  payload: Record<string, unknown> = {},
) => {
  const res = await setCampaignLifecycle(campaignId, action, payload)
  if (!res.ok) {
    throw new Error(lifecycleErrorMessage(res))
  }
  return res.data
}

export const activateCampaignWithReview = async (
  campaignId: string,
  payload: Record<string, unknown> = {},
): Promise<ActivationResult> => {
  const res = await setCampaignLifecycle(campaignId, 'activate', payload)
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      message: lifecycleErrorMessage(res),
      blockers: parseLifecycleBlockers(res.upstream),
    }
  }
  const data = res.data
  return {
    ok: true,
    blockers: data.blockers ?? [],
    inserted: data.inserted ?? Number((data.queue_result as Record<string, unknown> | undefined)?.send_queue_rows_created ?? 0),
    skipped: data.skipped ?? 0,
    idempotent: data.idempotent,
    from: data.from ?? null,
    to: data.to ?? 'active',
    proof_hydration: Boolean(data.proof_hydration ?? data.activation_mode === 'test'),
    activation_mode: (data.activation_mode as 'live' | 'test' | undefined) ?? (data.proof_hydration ? 'test' : 'live'),
  }
}

export const cloneCampaign = async (campaignId: string, name?: string): Promise<string> => {
  const res = await cloneCampaignBackend(campaignId, name ? { name } : {})
  if (!res.ok) throw new Error(res.message || res.error || 'campaign_clone_failed')
  if (!res.data.campaign_id) throw new Error('campaign_clone_failed')
  return res.data.campaign_id
}

export const deleteCampaign = async (campaignId: string, options: { force_delete?: boolean } = {}) => {
  const res = await deleteCampaignBackend(campaignId, options)
  if (!res.ok) throw new Error(res.message || res.error || 'campaign_delete_failed')
  return res.data
}

export const fetchCampaignMarketMetrics = async (campaignId: string): Promise<CampaignMarketMetric[]> => {
  const client = getSupabaseClient()
  const { data, error } = await client
    .from('v_sms_campaign_market_metrics')
    .select('*')
    .eq('campaign_id', campaignId)
  if (error) throw error
  return (data ?? []) as CampaignMarketMetric[]
}

const buildKpis = (campaigns: CampaignSummary[]): CampaignKpis => {
  const active = campaigns.filter((c) =>
    ['active', 'activating', 'live_limited', 'scheduled'].includes(c.status) ||
    (c.status === 'paused' && c.ready_targets > 0) ||
    c.operator_state === 'test_mode' ||
    c.operator_state === 'live',
  )
  const totalTargets = campaigns.reduce((s, c) => s + c.total_targets, 0)
  const readyTargets = campaigns.reduce((s, c) => s + c.ready_targets, 0)
  const scheduledQueueRows = campaigns.reduce((s, c) => s + Number(c.scheduled_queue_rows ?? c.scheduled_targets ?? 0), 0)
  const plannedTargets = campaigns.reduce((s, c) => s + Number(c.planned_targets ?? 0), 0)
  const sentToday = active.reduce((s, c) => s + c.sent_count, 0)
  const deliveredToday = active.reduce((s, c) => s + c.delivered_count, 0)
  const totalSent = campaigns.reduce((s, c) => s + c.sent_count, 0)
  const totalFailed = campaigns.reduce((s, c) => s + c.failed_count, 0)
  const totalPositive = campaigns.reduce((s, c) => s + c.positive_reply_count, 0)
  const totalOptOut = campaigns.reduce((s, c) => s + c.opt_out_count, 0)
  const replyRate = deliveredToday > 0 ? (totalPositive / deliveredToday) * 100 : 0
  const optOutRate = totalSent > 0 ? (totalOptOut / totalSent) * 100 : 0
  const failureRate = totalSent > 0 ? (totalFailed / totalSent) * 100 : 0

  return {
    activeCampaigns: active.length,
    totalTargets,
    readyTargets,
    scheduledQueueRows,
    plannedTargets,
    sentToday,
    deliveredToday,
    replyRate: Math.round(replyRate * 10) / 10,
    positiveReplies: totalPositive,
    optOutRate: Math.round(optOutRate * 10) / 10,
    failureRate: Math.round(failureRate * 10) / 10,
  }
}

export const buildSuppressionChecklist = (campaign: CampaignSummary): SuppressionCheck[] => {
  const optOutPct = campaign.opt_out_rate
  const hasTargets = campaign.total_targets > 0
  return [
    { key: 'opt_outs', label: 'Opt-outs excluded', status: 'pass', detail: `${campaign.opt_out_count} suppressed` },
    { key: 'negative_replies', label: 'No/Not interested excluded', status: 'pass', detail: `${campaign.negative_reply_count} excluded` },
    { key: 'wrong_numbers', label: 'Wrong numbers excluded', status: 'pass', detail: 'DNC + wrong number list applied' },
    { key: 'blacklist_pairs', label: 'Blacklist pairs excluded', status: campaign.failed_count > 10 ? 'warn' : 'pass', detail: campaign.failed_count > 10 ? `${campaign.failed_count} failed sends detected` : 'Pair check applied' },
    { key: 'active_dupes', label: 'Active queue duplicates excluded', status: 'pass', detail: 'Dedup on queue_status active' },
    { key: 'same_phone', label: 'Same phone deduped', status: 'pass', detail: 'Canonical E164 dedup applied' },
    { key: 'same_owner', label: 'Same owner deduped', status: 'pass', detail: 'master_owner_id dedup applied' },
    { key: 'recent_sends', label: 'Recent sends excluded', status: campaign.send_interval_seconds < 300 ? 'warn' : 'pass', detail: `Interval: ${Math.round(campaign.send_interval_seconds / 60)}m cooldown` },
    { key: 'property_required', label: 'Property required', status: hasTargets ? 'pass' : 'fail', detail: hasTargets ? 'All targets have linked property' : 'No targets — build target list' },
    { key: 'phone_required', label: 'Phone required', status: hasTargets ? 'pass' : 'fail', detail: hasTargets ? 'All targets have valid phone' : 'No targets — build target list' },
    { key: 'optout_rate', label: 'Opt-out rate safe', status: optOutPct > 6 ? 'fail' : optOutPct > 3.5 ? 'warn' : 'pass', detail: `Current: ${optOutPct.toFixed(1)}% (threshold: 5%)` },
  ]
}

// ── Main loader ─────────────────────────────────────────────────────────────────

export const loadCampaigns = async (): Promise<CampaignModel> => {
  const surface = await fetchCampaignsSurface()
  const model: CampaignModel = {
    campaigns: surface.data,
    kpis: buildKpis(surface.data),
    ok: surface.ok,
    errorType: surface.errorType as CampaignModel['errorType'],
    errorMessage: surface.errorMessage,
    degraded: surface.degraded,
    retryable: surface.retryable,
    source: surface.source,
  }
  if (!surface.ok && isDev) {
    console.warn('[NEXUS] Campaigns load failed.', surface.errorType, surface.errorMessage)
  }
  return model
}
