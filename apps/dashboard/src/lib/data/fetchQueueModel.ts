import { getSupabaseClient } from '../supabaseClient'
import { asBoolean, asIso, asNumber, asString, getFirst, safeArray, type AnyRecord } from './shared'
import type { QueueModel, QueueItem, QueueItemStatus, QueueItemPriority, RiskLevel, DeliveryStatus, FailureReason } from '../../domain/queue/queue.types'
import { classifyQueueFailure } from '../../domain/queue/classifyFailure'
import { getBackendBaseUrl } from '../api/backendClient'

const toQueueStatus = (value: unknown): QueueItemStatus => {
  const status = asString(value, '').toLowerCase()
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
  if (raw === 'P0' || raw === 'P1' || raw === 'P2' || raw === 'P3') return raw as QueueItemPriority
  return 'P2'
}

const toRisk = (value: unknown): RiskLevel => {
  const raw = asString(value, '').toLowerCase()
  if (raw === 'high') return 'high'
  if (raw === 'medium') return 'medium'
  return 'low'
}

const toFailureReason = (value: unknown): FailureReason | null => {
  const raw = asString(value, '').toLowerCase()
  const candidates: FailureReason[] = ['carrier_error', 'textgrid_error', 'invalid_phone', 'dnc_conflict', 'outside_contact_window', 'template_missing', 'retry_exhausted', 'sync_error', 'unknown']
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

const asRecord = (value: unknown): AnyRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
)

export const fetchQueueModel = async (): Promise<QueueModel> => {
  const supabase = getSupabaseClient()

  // Step 1: Fetch Queue
  const queueResult = await supabase
    .from('send_queue')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1200)

  if (queueResult.error) throw new Error(queueResult.error.message)
  const queueRows = safeArray(queueResult.data as AnyRecord[])

  // Step 2: Extract IDs
  const propertyIds = new Set<string>()
  const ownerIds = new Set<string>()
  const targetIds = new Set<string>()
  const campaignIds = new Set<string>()
  const queueIds = new Set<string>()
  
  for (const row of queueRows) {
    const qid = asString(getFirst(row, ['queue_id', 'id']), '')
    if (qid) queueIds.add(qid)

    const pid = asString(getFirst(row, ['property_id']), '')
    if (pid) propertyIds.add(pid)

    const oid = asString(getFirst(row, ['owner_id', 'master_owner_id']), '')
    if (oid) ownerIds.add(oid)

    const md = asRecord(row.metadata)
    const targetSnapshot = asRecord(md.target_snapshot)
    const cid = asString(
      getFirst(row, ['campaign_id']),
      asString(getFirst(md, ['campaign_id']), asString(getFirst(targetSnapshot, ['campaign_id']), '')),
    )
    if (cid) campaignIds.add(cid)

    const tid = asString(
      getFirst(row, ['campaign_target_id']),
      asString(getFirst(md, ['campaign_target_id']), asString(getFirst(targetSnapshot, ['campaign_target_id']), '')),
    )
    if (tid) targetIds.add(tid)
  }

  // Step 3: Fetch Related Data
  const qArr = Array.from(queueIds)
  const pArr = Array.from(propertyIds)
  const oArr = Array.from(ownerIds)
  const cArr = Array.from(campaignIds)
  const tArr = Array.from(targetIds)

  const chunkArray = <T>(arr: T[], size: number): T[][] => {
    return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, i * size + size)
    )
  }

  const fetchChunked = async (arr: string[], fetcher: (chunk: string[]) => Promise<{ data: any[] | null }>, chunkSize = 100) => {
    if (arr.length === 0) return { data: [] }
    const chunks = chunkArray(arr, chunkSize)
    const results = []
    // Execute with limited concurrency (e.g. 5 at a time)
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5)
      results.push(...await Promise.all(batch.map(fetcher)))
    }
    return { data: results.flatMap(r => r.data || []) }
  }

  const fetchTargetChunked = async (_qArrChunk: string[], _tArrChunk: string[]) => {
    // Disabled: frontend direct Supabase calls querying huge in(...) lists for sms_campaign_targets
    return { data: [] }
  }

  const [propRes, evtRes, tgtRes, cmpRes, ownerRes, tgRes] = await Promise.all([
    fetchChunked(pArr, async chunk => await supabase.from('properties').select('property_id,owner_id,master_owner_id,property_address,property_address_city,property_address_state,property_address_zip,market').in('property_id', chunk).limit(3000), 100),
    fetchChunked(qArr, async _chunk => ({ data: [] }), 30), // Disabled message_events
    (async () => {
      if (qArr.length === 0 && tArr.length === 0) return { data: [] }
      const qChunks = chunkArray(qArr, 30)
      const tChunks = chunkArray(tArr, 30)
      const maxLen = Math.max(qChunks.length, tChunks.length)
      const results = []
      for (let i = 0; i < maxLen; i += 5) {
        const batch = Array.from({ length: Math.min(5, maxLen - i) }).map((_, j) => {
          const idx = i + j
          return fetchTargetChunked(qChunks[idx] || [], tChunks[idx] || [])
        })
        results.push(...await Promise.all(batch))
      }
      return { data: results.flatMap(r => r.data || []) }
    })(),
    fetchChunked(cArr, async chunk => await supabase.from('sms_campaigns').select('id,campaign_name').in('id', chunk).limit(500), 100),
    fetchChunked(oArr, async _chunk => ({ data: [] }), 100), // Disabled master_owners
    supabase.from('textgrid_numbers').select('*')
  ])

  const propertyById = new Map(safeArray(propRes.data as AnyRecord[]).map(r => [r.property_id, r]))
  const eventByQid = new Map(safeArray(evtRes.data as AnyRecord[]).map(r => [r.queue_id, r]))
  const targetByQid = new Map(safeArray(tgtRes.data as AnyRecord[]).map(r => [r.queue_row_id, r]))
  const targetById = new Map(safeArray(tgtRes.data as AnyRecord[]).map(r => [r.id, r]))
  const cmpById = new Map(safeArray(cmpRes.data as AnyRecord[]).map(r => [r.id, r]))
  const ownerById = new Map(safeArray(ownerRes.data as AnyRecord[]).map(r => [r.master_owner_id, r]))
  const textgridNumbers = safeArray(tgRes.data as AnyRecord[])

  // Step 4: Hydration Mapping
  const items: QueueItem[] = queueRows.map((row, index) => {
    const id = asString(row['id'], `queue-${index + 1}`)
    const queueId = asString(getFirst(row, ['queue_id', 'id']), id)
    const md = asRecord(row.metadata)
    const targetSnapshot = asRecord(md.target_snapshot)
    const templateSnapshot = asRecord(md.template_snapshot)

    const metadataCampaignTargetId = asString(
      getFirst(row, ['campaign_target_id']),
      asString(getFirst(md, ['campaign_target_id']), asString(getFirst(targetSnapshot, ['campaign_target_id']), '')),
    )
    const target = targetByQid.get(queueId) || targetById.get(metadataCampaignTargetId) || null
    const event = eventByQid.get(queueId) || null

    const basePropId = asString(getFirst(target || {}, ['property_id']), asString(getFirst(row, ['property_id']), ''))
    const property = propertyById.get(basePropId) || null

    const baseOwnerId = asString(getFirst(target || {}, ['owner_id']), asString(getFirst(row, ['owner_id', 'master_owner_id']), asString(getFirst(property || {}, ['owner_id', 'master_owner_id']), '')))
    const owner = ownerById.get(baseOwnerId) || null

    const baseCmpId = asString(
      getFirst(target || {}, ['campaign_id']),
      asString(getFirst(row, ['campaign_id']), asString(getFirst(md, ['campaign_id']), asString(getFirst(targetSnapshot, ['campaign_id']), ''))),
    )
    const campaign = cmpById.get(baseCmpId) || null

    const status = toQueueStatus(getFirst(row, ['queue_status', 'status']))
    const scheduledIso = asIso(getFirst(row, ['scheduled_for', 'scheduled_at', 'send_at'])) ?? new Date().toISOString()
    const localScheduledIso = asIso(getFirst(row, ['scheduled_for_local'])) || scheduledIso

    const sellerName = asString(
      getFirst(target || {}, ['seller_name', 'seller_full_name']),
      asString(getFirst(row, ['full_name', 'entity_name', 'seller_name', 'first_name']),
      asString(getFirst(owner || {}, ['display_name', 'entity_name', 'first_name']), 'Unknown seller'))
    )

    const propertyAddress = asString(
      getFirst(target || {}, ['property_address_full', 'address_full']),
      asString(getFirst(property || row, ['property_address', 'address', 'property']), 'No property linked')
    )

    const market = asString(
      getFirst(target || {}, ['market']),
      asString(getFirst(row, ['market']), asString(getFirst(property || {}, ['market']), 'Market unknown'))
    )

    const phone = asString(getFirst(row, ['to_phone_number', 'phone']), '') || 'No phone'
    const fromPhone = asString(getFirst(row, ['from_phone_number']), '')
    const retryCount = asNumber(getFirst(row, ['retry_count']), 0)
    const maxRetries = Math.max(asNumber(getFirst(row, ['max_retries']), 3), retryCount || 0)

    const sentAt = asIso(getFirst(row, ['sent_at']))
    const deliveredAt = asIso(getFirst(event || {}, ['delivered_at'])) || asIso(getFirst(md, ['delivered_at']))

    const providerMessageId =
      asString(getFirst(row, ['provider_message_sid', 'provider_message_id']), '') ||
      asString(getFirst(md, ['provider_message_sid', 'provider_message_id']), '') ||
      asString(getFirst(event || {}, ['provider_message_sid']), '') ||
      null
    const textgridMessageId = asString(getFirst(row, ['textgrid_message_id']), '') || asString(getFirst(md, ['textgrid_message_id']), '') || null

    const messageText = asString(getFirst(row, ['message_body', 'message_text', 'message']), '')
    const templateId = asString(getFirst(row, ['template_key', 'selected_template_id']), '') || asString(getFirst(md, ['selected_template_id', 'template_id']), asString(getFirst(templateSnapshot, ['selected_template_id', 'template_id']), asString(getFirst(target || {}, ['template_id']), ''))) || null

    const guardReason = asString(getFirst(row, ['guard_reason']), '') || null
    const deliveryStatus = deliveryFromStatus(status)
    const failureCategory = classifyQueueFailure(row, event, status, deliveryStatus, !!templateId, !!messageText.trim())

    // Source inference
    let rowSource: QueueItem['rowSource'] = 'unknown'
    const qKey = asString(row.queue_key, '')
    if (target || baseCmpId || metadataCampaignTargetId || md.source === 'campaign_launch_execution') rowSource = 'campaign'
    else if (qKey.startsWith('feed') || md.source === 'feeder') rowSource = 'feeder'
    else if (md.auto_reply) rowSource = 'auto_reply'
    else if (md.source === 'manual') rowSource = 'manual'
    else rowSource = 'feeder' // fallback

    // Diagnostics
    const flags: string[] = []
    if (sellerName === 'Unknown seller') flags.push('MISSING_OWNER')
    if (propertyAddress === 'No property linked') flags.push('MISSING_PROPERTY')
    if (status === 'sent' && !event) flags.push('MISSING_MESSAGE_EVENT')
    if (rowSource === 'campaign' && !metadataCampaignTargetId && !target) flags.push('MISSING_CAMPAIGN_TARGET')
    if (!templateId) flags.push('MISSING_TEMPLATE')
    if (fromPhone && !textgridNumbers.some(n => n.number === fromPhone || n.phone_number === fromPhone)) flags.push('MISSING_TEXTGRID_NUMBER')
    if (status === 'sent' && !providerMessageId && !textgridMessageId) flags.push('MISSING_PROVIDER_ID')
    if (status === 'sent' && deliveryStatus === 'pending' && !deliveredAt && failureCategory !== 'carrier_failure') flags.push('MISSING_DELIVERY_STATUS')

    const failureGroupMap: Record<string, string> = {
      'textgrid_content_filter': 'Carrier', 'blacklist_pair_21610': 'Compliance', 'recipient_opted_out': 'Compliance',
      'invalid_number': 'Carrier', 'suppression_blocked': 'Compliance', 'no_valid_sender': 'Routing',
      'missing_template': 'Template', 'blank_message_body': 'Payload', 'webhook_missing': 'Webhook',
      'message_event_missing': 'Webhook', 'carrier_failure': 'Carrier', 'unknown': 'Unknown', 'stale_runnable_row': 'Unknown'
    }

    return {
      id,
      queueId,
      sellerName,
      sellerDisplayName: sellerName,
      sellerFirstName: asString(getFirst(target || {}, ['seller_first_name']), asString(getFirst(owner || {}, ['first_name']), '')) || null,
      sellerFullName: sellerName,
      propertyAddress,
      propertyCity: asString(getFirst(target || {}, ['property_city']), asString(getFirst(property || {}, ['property_address_city']), '')) || null,
      propertyState: asString(getFirst(target || {}, ['property_state']), asString(getFirst(property || {}, ['property_address_state']), '')) || null,
      propertyZip: asString(getFirst(target || {}, ['property_zip']), asString(getFirst(property || {}, ['property_address_zip']), '')) || null,
      market,
      phone,
      toPhoneNumber: asString(getFirst(row, ['to_phone_number', 'phone']), ''),
      fromPhoneNumber: fromPhone,
      agent: asString(getFirst(row, ['agent_name', 'selected_agent_id', 'agent']), '') || asString(getFirst(md, ['agent_name', 'agent_first_name']), 'NEXUS'),
      templateName: asString(getFirst(row, ['template_key', 'template_name', 'use_case_template']), '') || asString(getFirst(templateSnapshot, ['template_name', 'template_use_case']), asString(getFirst(md, ['template_use_case', 'selected_template_use_case']), 'Template not attached')),
      templateId,
      selectedTemplateId: templateId,
      templateSource: 'system',
      useCase: asString(getFirst(row, ['message_type', 'use_case']), 'listing'),
      stage: asString(getFirst(row, ['stage', 'seller_stage']), 'lead'),
      stageBefore: asString(getFirst(row, ['stage_before']), asString(md.stage_before, '')) || null,
      stageAfter: asString(getFirst(row, ['stage_after']), asString(md.stage_after, '')) || null,
      messageText,
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
      failureReason: toFailureReason(getFirst(row, ['failed_reason', 'failure_reason', 'error_code'])),
      failedReason: asString(getFirst(row, ['failed_reason']), '') || null,
      pausedReason: asString(getFirst(row, ['paused_reason']), '') || null,
      blockedReason: asString(getFirst(row, ['blocked_reason']), asString(md.blocked_reason, '')) || null,
      guardReason,
      deliveryStatus,
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
      linkedInboxThreadId: asString(getFirst(row, ['thread_key']), '') || asString(getFirst(md, ['thread_id', 'conversation_id', 'thread_key']), '') || null,
      linkedPropertyId: basePropId || null,
      linkedOwnerId: baseOwnerId || null,
      propertyType: asString(getFirst(row, ['property_type']), '') || asString(md.property_type, '') || null,
      safetyStatus: asString(getFirst(row, ['safety_status']), asString(md.safety_status, '')) || null,
      routingAllowed: asBoolean(getFirst(row, ['routing_allowed']), asBoolean(md.routing_allowed, false)),
      smsEligible: asBoolean(getFirst(row, ['sms_eligible']), asBoolean(md.sms_eligible, false)),
      providerMessageId,
      textgridMessageId,
      messageEventId: asString(getFirst(event || {}, ['id']), '') || null,
      missingMessageEvent: flags.includes('MISSING_MESSAGE_EVENT'),
      missingProviderMessageId: flags.includes('MISSING_PROVIDER_ID'),
      overdue: ['scheduled', 'queued', 'ready'].includes(status) && new Date(scheduledIso).getTime() < Date.now(),
      metadata: md,

      sellerTemperature: asString(getFirst(row, ['seller_temperature']), asString(md.seller_temperature, 'unknown')) as any,
      currentStage: asString(getFirst(row, ['pipeline_stage', 'current_stage']), '') || asString(md.current_stage, 'Nurture'),
      nextBestAction: asString(getFirst(row, ['next_best_action'])) || asString(md.next_best_action) || null,
      memoryStatus: asString(getFirst(row, ['memory_status']), asString(md.memory_status, 'none')) as QueueItem['memoryStatus'],
      urgencyScore: asNumber(getFirst(row, ['urgency_score']), asNumber(md.urgency_score, 0)),
      extractedIntent: asString(getFirst(row, ['extracted_intent'])) || asString(md.extracted_intent) || null,
      routingReason: asString(getFirst(row, ['routing_reason'])) || asString(md.routing_reason) || null,
      failureGroup: failureCategory ? (failureGroupMap[failureCategory] as any) : null,
      retryEligible: asBoolean(getFirst(row, ['retry_eligible']), asBoolean(md.retry_eligible, retryCount < maxRetries)),
      approvalReason: asString(getFirst(row, ['approval_reason'])) || asString(md.approval_reason) || null,
      priorThreadSummary: asString(getFirst(row, ['prior_thread_summary'])) || asString(md.prior_thread_summary) || null,

      campaignId: baseCmpId || (campaign ? asString(campaign.id, '') : '') || null,
      campaignName: campaign
        ? asString(campaign.campaign_name, '') || asString(campaign.name, '') || null
        : asString(getFirst(md, ['campaign_name']), '') || null,
      campaignTargetId: metadataCampaignTargetId || (target ? asString(target.id, '') : '') || null,
      campaignTargetStatus: target
        ? asString(getFirst(target, ['target_status', 'status']), '') || null
        : asString(getFirst(row, ['campaign_target_status']), asString(getFirst(targetSnapshot, ['target_status']), '')) || null,
      routingTier: asNumber(getFirst(row, ['routing_tier']), 0) || null,
      routingRuleName: asString(getFirst(row, ['routing_rule_name']), '') || null,
      lastEventType: event ? asString(event.event_type, '') || null : null,
      lastEventAt: event ? asString(event.created_at, '') || null : null,
      lastEventStatus: event ? asString(event.delivery_status, '') || null : null,
      diagnosticFlags: flags,
      rowSource,
      failureCategory
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
  const deliveredTodayCount = items.filter((i) => i.deliveredAt && new Date(i.deliveredAt).toDateString() === now).length

  const apiPressureLevel: 'low' | 'medium' | 'high' =
    failedCount + retryCount > items.length * 0.1
      ? 'high'
      : failedCount + retryCount > items.length * 0.04
        ? 'medium'
        : 'low'

  const hasProxyUrl = Boolean(getBackendBaseUrl())
  const engineMode: QueueModel['engineMode'] = hasProxyUrl ? 'proxy' : 'dry-run only'

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
