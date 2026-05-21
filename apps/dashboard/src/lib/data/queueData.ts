import type {
  DeliveryStatus,
  FailureReason,
  QueueItem,
  QueueItemPriority,
  QueueItemStatus,
  QueueModel,
  RiskLevel,
} from '../../modules/queue/queue.types'

export type {
  DeliveryStatus,
  FailureReason,
  QueueItem,
  QueueItemPriority,
  QueueItemStatus,
  QueueModel,
  RiskLevel,
}
import { getSupabaseClient } from '../supabaseClient'
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  getFirst,
  mapErrorMessage,
  normalizeStatus,
  safeArray,
  type AnyRecord,
} from './shared'
import * as backendClient from '../api/backendClient'

const toQueueStatus = (value: unknown): QueueItemStatus => {
  const status = normalizeStatus(value)
  if (status === 'ready') return 'ready'
  if (status === 'scheduled') return 'scheduled'
  if (status === 'sent') return 'sent'
  if (status === 'delivered') return 'delivered'
  if (status === 'failed') return 'failed'
  if (status === 'held') return 'held'
  if (status === 'approval' || status === 'awaiting_approval') return 'approval'
  if (status === 'retry' || status === 'retrying') return 'retry'
  if (status === 'queued') return 'queued'
  if (status === 'sending') return 'sending'
  if (status === 'blocked') return 'blocked'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'replied_before_send') return 'replied_before_send'
  if (status === 'paused_name_missing') return 'paused_name_missing'
  if (status === 'paused_duplicate') return 'paused_duplicate'
  if (status === 'paused_invalid_queue_row') return 'paused_invalid_queue_row'
  if (status === 'paused_global_lock') return 'paused_global_lock'
  if (status === 'paused_max_retries') return 'paused_max_retries'
  return 'scheduled'
}

const toPriority = (value: unknown): QueueItemPriority => {
  const raw = asString(value, 'P2').toUpperCase()
  if (raw === 'P0' || raw === 'P1' || raw === 'P2' || raw === 'P3') return raw
  return 'P2'
}

const toRisk = (value: unknown): RiskLevel => {
  const raw = normalizeStatus(value)
  if (raw === 'high') return 'high'
  if (raw === 'medium') return 'medium'
  return 'low'
}

const toFailureReason = (value: unknown): FailureReason | null => {
  const raw = normalizeStatus(value)
  const candidates: FailureReason[] = [
    'carrier_error',
    'textgrid_error',
    'invalid_phone',
    'dnc_conflict',
    'outside_contact_window',
    'template_missing',
    'retry_exhausted',
    'sync_error',
    'unknown',
  ]
  if (candidates.includes(raw as FailureReason)) return raw as FailureReason
  return null
}

const deliveryFromStatus = (status: QueueItemStatus): DeliveryStatus => {
  if (status === 'delivered') return 'delivered'
  if (status === 'failed') return 'failed'
  if (status === 'retry') return 'failed'
  if (status === 'sent') return 'sent'
  if (status === 'held') return 'pending'
  if (status === 'approval') return 'pending'
  return 'pending'
}

const statusLabelFor = (status: QueueItemStatus): string => status.replace(/_/g, ' ')

export const fetchQueueModel = async (): Promise<QueueModel> => {
  const supabase = getSupabaseClient()

  const [queueResult, propertyResult, messageEventResult] = await Promise.all([
    supabase
      .from('send_queue')
      .select(`
        id,
        queue_id,
        queue_key,
        queue_status,
        scheduled_for,
        scheduled_for_local,
        timezone,
        to_phone_number,
        from_phone_number,
        message_type,
        use_case_template,
        message_body,
        message_text,
        selected_template_id,
        selected_agent_id,
        master_owner_id,
        owner_id,
        property_id,
        prospect_id,
        phone_number_id,
        market_id,
        market,
        property_type,
        property_address_state,
        property_address_city,
        property_address_zip,
        agent_name,
        template_key,
        pipeline_stage,
        seller_status,
        thread_key,
        retry_count,
        max_retries,
        failed_reason,
        blocked_reason,
        paused_reason,
        created_at,
        updated_at,
        metadata,
        priority,
        risk_level,
        ai_confidence,
        estimated_cost,
        sent_at,
        approved_at,
        held_at,
        touch_number,
        language
      `)
      .order('created_at', { ascending: false })
      .limit(1200),
    supabase
      .from('properties')
      .select('property_id,owner_id,master_owner_id,property_address,property_address_city,property_address_state,market')
      .limit(3000),
    supabase
      .from('message_events')
      .select('id,queue_id,property_id,thread_key,provider_message_sid,created_at,delivered_at,delivery_status,event_type')
      .order('created_at', { ascending: false })
      .limit(5000),
  ])

  if (queueResult.error) throw new Error(mapErrorMessage(queueResult.error))
  if (propertyResult.error) throw new Error(mapErrorMessage(propertyResult.error))
  if (messageEventResult.error) throw new Error(mapErrorMessage(messageEventResult.error))

  const queueRows = safeArray(queueResult.data as AnyRecord[])
  const propertyRows = safeArray(propertyResult.data as AnyRecord[])
  const messageEventRows = safeArray(messageEventResult.data as AnyRecord[])

  const propertyById = new Map<string, AnyRecord>()
  for (const row of propertyRows) {
    const propertyId = asString(getFirst(row, ['property_id']), '')
    if (propertyId) propertyById.set(propertyId, row)
  }

  const messageEventByQueueId = new Map<string, AnyRecord>()
  for (const row of messageEventRows) {
    const queueId = asString(getFirst(row, ['queue_id']), '')
    if (!queueId || messageEventByQueueId.has(queueId)) continue
    messageEventByQueueId.set(queueId, row)
  }

  const items: QueueItem[] = queueRows.map((row, index) => {
    const id = asString(row['id'], `queue-${index + 1}`)
    const queueId = asString(row['queue_id'] || row['id'], id)
    const ownerId = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    const propertyId = asString(getFirst(row, ['property_id']), '')
    const property = propertyById.get(propertyId)

    const status = toQueueStatus(getFirst(row, ['queue_status', 'status']))
    const scheduledIso =
      asIso(getFirst(row, ['scheduled_for', 'scheduled_at', 'send_at'])) ?? new Date().toISOString()
    const localScheduledIso = asIso(getFirst(row, ['scheduled_for_local'])) || scheduledIso

    const sellerName = asString(
      getFirst(row, ['full_name', 'entity_name', 'seller_name', 'first_name']),
      'Unknown seller',
    )

    const propertyAddress = asString(
      getFirst(property ?? row, ['property_address', 'address', 'property']),
      'No property linked',
    )

    const market = asString(
      getFirst(row, ['market']) ?? 
      getFirst(property ?? row, ['market']),
      'Market unknown',
    )

    const phone = asString(getFirst(row, ['to_phone_number', 'phone']), '') || 'No phone'

    const retryCount = asNumber(getFirst(row, ['retry_count']), 0)
    const maxRetries = Math.max(asNumber(getFirst(row, ['max_retries']), 3), retryCount || 0)

    const metadata = (row['metadata'] as AnyRecord) || {}
    const linkedEvent = messageEventByQueueId.get(queueId) ?? null
    const sentAt = asIso(getFirst(row, ['sent_at']))
    const deliveredAt = asIso(getFirst(linkedEvent ?? {}, ['delivered_at'])) || asIso(getFirst(metadata, ['delivered_at']))
    const providerMessageId =
      asString(getFirst(row, ['provider_message_sid']), '') ||
      asString(getFirst(metadata, ['provider_message_sid', 'provider_message_id']), '') ||
      asString(getFirst(linkedEvent ?? {}, ['provider_message_sid']), '') ||
      null
    const textgridMessageId =
      asString(getFirst(row, ['textgrid_message_id']), '') ||
      asString(getFirst(metadata, ['textgrid_message_id']), '') ||
      asString(getFirst(linkedEvent ?? {}, ['provider_message_sid', 'provider_message_id']), '') ||
      null

    // Tactical Intelligence Extraction
    const sellerTemperatureRaw = asString(getFirst(row, ['seller_temperature']), asString(metadata.seller_temperature, 'unknown'))
    const sellerTemperature: QueueItem['sellerTemperature'] =
      ['cold', 'warm', 'hot', 'dnc'].includes(sellerTemperatureRaw) ? (sellerTemperatureRaw as any) : 'unknown'

    const failureReason = toFailureReason(getFirst(row, ['failed_reason', 'failure_reason', 'error_code']))
    const failureGroupRaw = asString(getFirst(row, ['failure_group']), asString(metadata.failure_group, ''))

    let failureGroup: QueueItem['failureGroup'] = null
    if (failureGroupRaw && ['Carrier', 'Compliance', 'Routing', 'Template', 'Webhook', 'Contact Window', 'Duplicate', 'Payload', 'Unknown'].includes(failureGroupRaw)) {
      failureGroup = failureGroupRaw as any
    } else if (failureReason) {
      if (failureReason === 'carrier_error') failureGroup = 'Carrier'
      else if (failureReason === 'dnc_conflict') failureGroup = 'Compliance'
      else if (failureReason === 'textgrid_error') failureGroup = 'Webhook'
      else if (failureReason === 'invalid_phone') failureGroup = 'Routing'
      else if (failureReason === 'template_missing') failureGroup = 'Template'
      else if (failureReason === 'outside_contact_window') failureGroup = 'Contact Window'
      else if (failureReason === 'sync_error') failureGroup = 'Payload'
      else failureGroup = 'Unknown'
    }

    return {
      id,
      queueId,
      sellerName,
      sellerDisplayName: sellerName,
      propertyAddress,
      market,
      phone,
      toPhoneNumber: asString(getFirst(row, ['to_phone_number', 'phone']), ''),
      fromPhoneNumber: asString(getFirst(row, ['from_phone_number']), ''),
      agent: asString(getFirst(row, ['agent_name', 'selected_agent_id', 'agent']), '') || asString(getFirst(metadata, ['agent_name', 'agent_first_name']), 'NEXUS'),
      templateName: asString(getFirst(row, ['template_key', 'template_name', 'use_case_template']), '') || asString(getFirst(metadata, ['template_use_case', 'selected_template_use_case']), 'Template not attached'),
      templateId: asString(getFirst(row, ['template_key', 'selected_template_id']), '') || asString(getFirst(metadata, ['selected_template_id', 'template_id']), '') || null,
      selectedTemplateId: asString(getFirst(row, ['template_key', 'selected_template_id']), '') || null,
      templateSource: 'system',
      useCase: asString(getFirst(row, ['message_type', 'use_case']), 'listing'),
      stage: asString(getFirst(row, ['stage', 'seller_stage']), 'lead'),
      stageBefore: asString(getFirst(row, ['stage_before']), asString(metadata.stage_before, '')) || null,
      stageAfter: asString(getFirst(row, ['stage_after']), asString(metadata.stage_after, '')) || null,
      messageText: asString(getFirst(row, ['message_body', 'message_text', 'message']), ''),
      scheduledForLocal: localScheduledIso,
      scheduledForUtc: scheduledIso,
      timezone: asString(getFirst(row, ['timezone']), 'America/Chicago'),
      contactWindow: 'flexible',
      status,
      statusLabel: statusLabelFor(status),
      priority: toPriority(getFirst(row, ['priority'])),
      touchNumber: Math.max(asNumber(getFirst(row, ['touch_number']), 1), 1),
      language: asString(getFirst(row, ['language']), 'en') === 'es' ? 'es' : 'en',
      retryCount,
      maxRetries,
      failureReason,
      failedReason: asString(getFirst(row, ['failed_reason']), '') || null,
      pausedReason: asString(getFirst(row, ['paused_reason']), '') || null,
      blockedReason: asString(getFirst(row, ['blocked_reason']), asString(metadata.blocked_reason, '')) || null,
      deliveryStatus: deliveryFromStatus(status),
      createdAt: asIso(getFirst(row, ['created_at'])) ?? new Date().toISOString(),
      updatedAt: asIso(getFirst(row, ['updated_at'])) ?? new Date().toISOString(),
      sentAt,
      deliveredAt,
      approvedByOperator: asIso(getFirst(row, ['approved_at'])) ? 'operator' : null,
      requiresApproval: status === 'approval' || asBoolean(getFirst(row, ['requires_approval']), false),
      riskLevel: toRisk(getFirst(row, ['risk_level'])),
      aiConfidence: Math.max(0, Math.min(100, asNumber(getFirst(row, ['ai_confidence', 'confidence']), 72))),
      estimatedCost: Math.max(asNumber(getFirst(row, ['estimated_cost']), 0.018), 0.01),
      textgridNumber: asString(getFirst(row, ['from_phone_number', 'textgrid_number']), phone),
      linkedInboxThreadId: asString(getFirst(row, ['thread_key']), '') || asString(getFirst(metadata, ['thread_id', 'conversation_id', 'thread_key']), '') || null,
      linkedPropertyId: propertyId || null,
      linkedOwnerId: ownerId || null,
      propertyType: asString(getFirst(row, ['property_type']), '') || asString(metadata.property_type, '') || null,
      safetyStatus: asString(getFirst(row, ['safety_status']), asString(metadata.safety_status, '')) || null,
      routingAllowed: asBoolean(getFirst(row, ['routing_allowed']), asBoolean(metadata.routing_allowed, false)),
      smsEligible: asBoolean(getFirst(row, ['sms_eligible']), asBoolean(metadata.sms_eligible, false)),
      providerMessageId,
      textgridMessageId,
      messageEventId: asString(getFirst(linkedEvent ?? {}, ['id']), '') || null,
      missingMessageEvent: status === 'sent' && !linkedEvent,
      missingProviderMessageId: status === 'sent' && !providerMessageId && !textgridMessageId,
      overdue: ['scheduled', 'queued', 'ready'].includes(status) && new Date(scheduledIso).getTime() < Date.now(),
      metadata,

      // New Tactical Intelligence Fields
      sellerTemperature,
      currentStage: asString(getFirst(row, ['pipeline_stage', 'current_stage']), '') || asString(metadata.current_stage, 'Nurture'),
      nextBestAction: asString(getFirst(row, ['next_best_action'])) || asString(metadata.next_best_action) || null,
      memoryStatus: asString(getFirst(row, ['memory_status']), asString(metadata.memory_status, 'none')) as QueueItem['memoryStatus'],
      urgencyScore: asNumber(getFirst(row, ['urgency_score']), asNumber(metadata.urgency_score, 0)),
      extractedIntent: asString(getFirst(row, ['extracted_intent'])) || asString(metadata.extracted_intent) || null,
      routingReason: asString(getFirst(row, ['routing_reason'])) || asString(metadata.routing_reason) || null,
      failureGroup,
      retryEligible: asBoolean(getFirst(row, ['retry_eligible']), asBoolean(metadata.retry_eligible, retryCount < maxRetries)),
      approvalReason: asString(getFirst(row, ['approval_reason'])) || asString(metadata.approval_reason) || null,
      priorThreadSummary: asString(getFirst(row, ['prior_thread_summary'])) || asString(metadata.prior_thread_summary) || null,
    }
  })

  const readyCount = items.filter((i) => i.status === 'ready').length
  const scheduledCount = items.filter((i) => i.status === 'scheduled').length
  const approvalCount = items.filter((i) => i.status === 'approval' || i.riskLevel === 'high').length
  const failedCount = items.filter((i) => i.status === 'failed' || i.status === 'retry').length
  const retryCount = items.filter((i) => i.status === 'retry').length
  const heldCount = items.filter((i) => i.status === 'held').length
  
  const now = new Date().toDateString()
  const sentTodayCount = items.filter((i) => i.sentAt && new Date(i.sentAt).toDateString() === now).length
  const deliveredTodayCount = items.filter((i) => (i as any).deliveredAt && new Date((i as any).deliveredAt).toDateString() === now).length

  const apiPressureLevel: 'low' | 'medium' | 'high' =
    failedCount + retryCount > items.length * 0.1
      ? 'high'
      : failedCount + retryCount > items.length * 0.04
        ? 'medium'
        : 'low'

  const hasProxyUrl = Boolean(import.meta.env.VITE_BACKEND_API_URL)
  const engineMode: QueueModel['engineMode'] = hasProxyUrl 
    ? 'proxy' 
    : 'dry-run only'

  return {
    items,
    readyCount,
    scheduledCount,
    approvalCount,
    failedCount,
    retryCount,
    heldCount,
    sentTodayCount,
    deliveredTodayCount,
    safeCapacityRemaining: Math.max(1200 - sentTodayCount, 0),
    optOutRiskCount: items.filter((item) => item.riskLevel === 'high').length,
    apiPressureLevel,
    sendEngine: 'real-estate-automation',
    engineMode,
  }
}

// ── Queue Actions ─────────────────────────────────────────────────────────

export interface QueueActionResult {
  ok: boolean
  errorMessage: string | null
  updatedItem?: QueueItem
}

export const approveQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.approveQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'scheduled', approvedByOperator: 'operator' } }
}

export const holdQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.holdQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'held' } }
}

export const rescheduleQueueItem = async (item: QueueItem, newTime: string): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.rescheduleQueueItem(String(item.id), newTime)
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'scheduled', scheduledForLocal: newTime } }
}

export const cancelQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.cancelQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'held' } }
}

export const retryRoutingForItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  // Backend re-resolves routing and reschedules.
  const result = await backendClient.retryRoutingForQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'scheduled' } }
}

export const retryQueueItem = async (item: QueueItem): Promise<QueueActionResult> => {
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.retryQueueItem(String(item.id))
  if (!result.ok) return { ok: false, errorMessage: result.message }
  return { ok: true, errorMessage: null, updatedItem: { ...item, status: 'retry', retryCount: (item.retryCount || 0) + 1 } }
}
