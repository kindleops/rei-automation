import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient, hasSupabaseAdminEnv } from '../_lib/supabaseAdmin'
import { asBoolean, asString, normalizeStatus } from '../../../src/lib/data/shared'

const getInternalSupabase = () => hasSupabaseAdminEnv ? getSupabaseAdminClient() : getSupabaseClient()

export interface FailureTaxonomy {
  category: string
  reason_normalized: string
  is_true_delivery_failure: boolean
  is_data_hygiene: boolean
  is_repeat_contact_risk: boolean
}

export function classifyQueueFailureReason(row: Record<string, any>): FailureTaxonomy {
  const status = asString(row.queue_status, '')
  const failed = asString(row.failed_reason, '').toLowerCase()
  const guard = asString(row.guard_reason, '').toLowerCase()
  const paused = asString(row.paused_reason, '').toLowerCase()
  const blocked = asString(row.blocked_reason, '').toLowerCase()
  const metaRouting = asString(row.metadata?.routing_block_reason, '').toLowerCase()
  const metaSkip = asString(row.metadata?.skip_reason, '').toLowerCase()
  const metaPaused = asString(row.metadata?.paused_reason, '').toLowerCase()
  const metaCancel = asString(row.metadata?.cancel_reason, '').toLowerCase()
  
  const allReasons = `${failed} ${guard} ${paused} ${blocked} ${metaRouting} ${metaSkip} ${metaPaused} ${metaCancel} ${status}`

  let category = 'unknown'
  let reasonNormalized = 'unknown_error'
  let isTrueDelivery = false
  let isDataHygiene = false
  let isRepeatRisk = false

  if (allReasons.includes('delivery_failed') || status === 'delivery_failed') {
    category = 'delivery_failure'
    reasonNormalized = 'delivery_failed'
    isTrueDelivery = true
  } else if (allReasons.includes('blacklist') || allReasons.includes('21610')) {
    category = 'textgrid_blacklist'
    reasonNormalized = 'textgrid_blacklist'
    isTrueDelivery = true
  } else if (allReasons.includes('blank_message') || allReasons.includes('missing_template_text') || allReasons.includes('blank_greeting') || allReasons.includes('retired_before_send')) {
    category = 'blank_message'
    reasonNormalized = 'blank_message_body'
    isDataHygiene = true
  } else if (allReasons.includes('missing_seller_first_name') || allReasons.includes('missing_name') || allReasons.includes('missing_variables')) {
    category = 'missing_name'
    reasonNormalized = 'missing_variables'
    isDataHygiene = true
  } else if (allReasons.includes('routing blocked') || allReasons.includes('no_valid_local') || allReasons.includes('missing_from_phone_number')) {
    category = 'routing_missing_sender'
    reasonNormalized = 'missing_from_phone_number'
  } else if (allReasons.includes('duplicate_dedupe_key') || allReasons.includes('duplicate')) {
    category = 'duplicate'
    reasonNormalized = 'duplicate_dedupe_key'
    isRepeatRisk = true
  } else if (allReasons.includes('manual hold') || allReasons.includes('after hours') || allReasons.includes('safety_net')) {
    category = 'safety_hold'
    reasonNormalized = 'safety_net_hold'
  } else if (allReasons.includes('manual_cancel') || allReasons.includes('replied_before_send')) {
    category = 'manual_cancel'
    reasonNormalized = 'manual_cancel'
  } else if (allReasons.includes('max_per_number_per_day') || allReasons.includes('max_per_market_per_hour')) {
    category = 'scheduler_overflow'
    reasonNormalized = 'scheduler_overflow'
  } else if (allReasons.includes('opt_out') || allReasons.includes('dnc') || allReasons.includes('wrong_number') || allReasons.includes('suppressed')) {
    category = 'data_hygiene'
    reasonNormalized = 'suppression_list'
    isDataHygiene = true
  }

  return {
    category,
    reason_normalized: reasonNormalized,
    is_true_delivery_failure: isTrueDelivery,
    is_data_hygiene: isDataHygiene,
    is_repeat_contact_risk: isRepeatRisk
  }
}

export interface SuppressionResult {
  safe: boolean
  blocked: boolean
  reason: string | null
  codes: string[]
}

/**
 * Hard Suppression Gate: Validates if a contact is safe to message.
 */
export async function checkSuppression(params: {
  phone: string
  threadKey?: string
  masterOwnerId?: string
  prospectId?: string
}): Promise<SuppressionResult> {
  const supabase = getInternalSupabase()
  const codes: string[] = []
  const phone = params.phone.replace(/\D/g, '')

  if (!phone || phone.length < 10) {
    return { safe: false, blocked: true, reason: 'Invalid phone number', codes: ['invalid_phone'] }
  }

  // 1. Check Global SMS Suppression List
  const { data: suppressions } = await supabase
    .from('sms_suppression_list')
    .select('suppression_type, is_active')
    .eq('phone_e164', phone.length === 10 ? `+1${phone}` : `+${phone}`)
    .eq('is_active', true)

  if (suppressions && suppressions.length > 0) {
    const types = suppressions.map(s => s.suppression_type)
    if (types.includes('opt_out')) codes.push('opt_out')
    if (types.includes('dnc')) codes.push('dnc')
    if (types.includes('wrong_number')) codes.push('wrong_number')
    if (types.includes('hostile')) codes.push('hostile_block')
    if (types.includes('legal')) codes.push('legal_threat')
  }

  // 2. Check Thread State
  if (params.threadKey) {
    const { data: thread } = await supabase
      .from('inbox_thread_state')
      .select('is_suppressed, automation_state, status')
      .eq('thread_key', params.threadKey)
      .single()

    if (thread) {
      if (thread.is_suppressed) codes.push('thread_suppressed')
      if (thread.automation_state === 'manual_control' || thread.automation_state === 'paused') {
        codes.push('human_takeover')
      }
    }
  }

  // 3. Check Message Events for recent Opt-Outs
  const formattedPhone = phone.length === 10 ? `+1${phone}` : `+${phone}`
  const { data: recentEvents } = await supabase
    .from('message_events')
    .select('is_opt_out, detected_intent')
    .or(`from_phone_number.eq.${formattedPhone},to_phone_number.eq.${formattedPhone}`)
    .order('created_at', { ascending: false })
    .limit(1)

  if (recentEvents && recentEvents.length > 0) {
    if (asBoolean(recentEvents[0].is_opt_out, false)) codes.push('opt_out_recent')
    const intent = normalizeStatus(recentEvents[0].detected_intent)
    if (['opt_out', 'wrong_number', 'hostile_or_legal'].includes(intent)) {
      codes.push(`intent_${intent}`)
    }
  }

  const blocked = codes.length > 0
  return {
    safe: !blocked,
    blocked,
    reason: blocked ? `Suppressed by: ${codes.join(', ')}` : null,
    codes
  }
}

export async function checkRepeatContactAndBlacklist(params: {
  phone: string
  prospectId: string
  masterOwnerId: string
  propertyId?: string
  stageCode: string
  touchNumber?: number
}): Promise<{ safe: boolean, reason: string | null }> {
  const supabase = getInternalSupabase()
  const phoneE164 = params.phone.replace(/\D/g, '')
  const formattedPhone = phoneE164.length === 10 ? `+1${phoneE164}` : `+${phoneE164}`

  // 1. Check for recent contact (45 days) in message_events
  const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
  
  // Use canonical_e164 for phone matching in message_events
  const { data: recentEvents } = await supabase
    .from('message_events')
    .select('id')
    .eq('direction', 'outbound')
    .gte('created_at', fortyFiveDaysAgo)
    .or(`prospect_id.eq."${params.prospectId}",master_owner_id.eq."${params.masterOwnerId}",canonical_e164.eq."${formattedPhone}"`)
    .limit(1)

  if (recentEvents && recentEvents.length > 0) {
    return { safe: false, reason: 'recent_message_event_outbound' }
  }

  // 2. Check for recent contact in send_queue (including today's sends)
  // This covers the gap where message_events haven't been backfilled yet
  const orConditions = [
    `prospect_id.eq."${params.prospectId}"`,
    `master_owner_id.eq."${params.masterOwnerId}"`,
    `to_phone_number.eq."${formattedPhone}"`
  ]
  if (params.propertyId) {
    orConditions.push(`property_id.eq."${params.propertyId}"`)
  }

  const { data: recentQueue } = await supabase
    .from('send_queue')
    .select('id')
    .in('queue_status', ['queued', 'scheduled', 'sending', 'sent', 'delivered'])
    .or(orConditions.join(','))
    .limit(1)

  if (recentQueue && recentQueue.length > 0) {
    return { safe: false, reason: 'recent_send_queue_active' }
  }

  // 3. Specifically check for same touch number if provided
  if (params.touchNumber) {
    const { data: sameTouch } = await supabase
      .from('send_queue')
      .select('id')
      .eq('master_owner_id', params.masterOwnerId)
      .eq('to_phone_number', formattedPhone)
      .eq('touch_number', params.touchNumber)
      .in('queue_status', ['sent', 'delivered'])
      .limit(1)
    
    if (sameTouch && sameTouch.length > 0) {
      return { safe: false, reason: 'same_touch_already_sent' }
    }
  }

  // 4. Check for TextGrid 21610 blacklist metadata for this phone
  const { data: blacklistEvents } = await supabase
    .from('send_queue')
    .select('id')
    .eq('to_phone_number', formattedPhone)
    .or('failed_reason.ilike.%21610%,failed_reason.ilike.%blacklist%,blocked_reason.ilike.%blacklist%,metadata->>failure_reason_normalized.eq.textgrid_blacklist')
    .limit(1)

  if (blacklistEvents && blacklistEvents.length > 0) {
    return { safe: false, reason: 'prior_textgrid_blacklist_pair' }
  }

  return { safe: true, reason: null }
}

/**
 * Generates a deterministic dedupe key for the queue.
 */
export function generateDedupeKey(params: {
  threadKey: string
  phone: string
  queueType: string
  stageCode: string
  touchNumber: number
}): string {
  const normalizedPhone = params.phone.replace(/\D/g, '')
  return `${params.threadKey}:${normalizedPhone}:${params.queueType}:${params.stageCode}:${params.touchNumber}`
}

/**
 * Calculates a natural delay in minutes based on intent.
 */
export function getNaturalDelay(intent: string): number {
  const normalized = normalizeStatus(intent)
  switch (normalized) {
    case 'simple_confirmation':
    case 'yes':
      return Math.floor(Math.random() * (4 - 2 + 1) + 2) // 2-4 mins
    case 'who_is_this':
    case 'confused':
      return Math.floor(Math.random() * (5 - 2 + 1) + 2) // 2-5 mins
    case 'spanish_route':
      return Math.floor(Math.random() * (6 - 3 + 1) + 3) // 3-6 mins
    case 'asking_price':
    case 'negotiation':
      return Math.floor(Math.random() * (12 - 5 + 1) + 5) // 5-12 mins
    case 'hot_lead':
    case 'offer_requested':
      return Math.floor(Math.random() * (8 - 3 + 1) + 3) // 3-8 mins
    default:
      return 5
  }
}

/**
 * Checks for existing active queue items with the same dedupe key.
 */
export async function checkExistingQueue(dedupeKey: string): Promise<boolean> {
  const supabase = getInternalSupabase()
  const { data, error } = await supabase
    .from('send_queue')
    .select('id')
    .eq('dedupe_key', dedupeKey)
    .in('queue_status', ['queued', 'scheduled', 'sending', 'sent', 'delivered'])
    .limit(1)

  return !!(data && data.length > 0)
}

/**
 * Adjusts scheduling to respect contact windows (8am-8pm local).
 */
export function scheduleWithWindow(baseDate: Date, timezone: string): Date {
  const date = new Date(baseDate)
  const hour = date.getHours() 

  if (hour < 8) {
    date.setHours(8, Math.floor(Math.random() * 15), 0, 0)
  } else if (hour >= 20) {
    date.setDate(date.getDate() + 1)
    date.setHours(9, Math.floor(Math.random() * 15), 0, 0)
  }

  // Add jitter: Ensure 5-20 minutes delay so cron doesn't blast immediately
  date.setMinutes(date.getMinutes() + Math.floor(Math.random() * 15) + 5)
  
  return date
}

import { renderTemplate, type SmsTemplate } from '../../../src/lib/data/templateData'

/**
 * Renders a template and ensures the result is not blank.
 */
export function renderMessage(template: SmsTemplate, context: Record<string, string>): { 
  ok: boolean, 
  text: string, 
  reason?: string 
} {
  if (!template || !template.templateText || template.templateText.trim() === '') {
    return { ok: false, text: '', reason: 'missing_template_text' }
  }

  const rendered = renderTemplate(template, context)
  
  if (rendered.missingVariables.length > 0) {
    return { ok: false, text: '', reason: `missing_variables: ${rendered.missingVariables.join(', ')}` }
  }

  const text = rendered.renderedText.trim()
  if (!text) {
    return { ok: false, text: '', reason: 'blank_message_body' }
  }

  return { ok: true, text }
}

/**
 * Cleans up existing active blank queue rows.
 */
export async function cleanupBlankQueueRows(): Promise<number> {
  const supabase = getInternalSupabase()
  const { data, error } = await supabase
    .from('send_queue')
    .update({ 
      queue_status: 'blocked', 
      blocked_reason: 'blank_message_body',
      updated_at: new Date().toISOString()
    })
    .in('queue_status', ['queued', 'scheduled', 'sending'])
    .or('message_body.eq."",message_text.eq.""')
    .select('id')

  if (error) {
    console.error('[Cleanup] Failed to clean up blank rows:', error)
    return 0
  }
  return data?.length || 0
}

const toAnyRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

const normalizeState = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return ''
  const upper = raw.toUpperCase()
  if (upper === 'NORTH CAROLINA') return 'NC'
  return upper
}

export async function hydrateQueueRoutingContext(row: Record<string, any>): Promise<Record<string, unknown>> {
  const supabase = getInternalSupabase()
  const metadata = toAnyRecord(row.metadata)
  const hydrated: Record<string, unknown> = {
    seller_name: asString(row.seller_name || metadata['seller_name'], ''),
    property_address: asString(row.property_address || metadata['property_address'], ''),
    property_id: asString(row.property_id || metadata['property_id'], ''),
    master_owner_id: asString(row.master_owner_id, ''),
    prospect_id: asString(row.prospect_id, ''),
    market: asString(row.market || metadata['market'], ''),
    market_id: asString(row.market_id, ''),
    property_address_state: normalizeState(row.property_address_state || metadata['property_address_state']),
    thread_key: asString(row.thread_key || metadata['thread_key'], ''),
  }

  const applyRecord = (source: Record<string, any> | null | undefined) => {
    if (!source) return
    if (!hydrated.seller_name) hydrated.seller_name = asString(source.owner_name || source.seller_name || source.full_name || source.display_name, '')
    if (!hydrated.property_address) hydrated.property_address = asString(source.property_address || source.address, '')
    if (!hydrated.property_id) hydrated.property_id = asString(source.property_id, '')
    if (!hydrated.master_owner_id) hydrated.master_owner_id = asString(source.master_owner_id || source.owner_id, '')
    if (!hydrated.prospect_id) hydrated.prospect_id = asString(source.prospect_id, '')
    if (!hydrated.market) hydrated.market = asString(source.market, '')
    if (!hydrated.market_id) hydrated.market_id = asString(source.market_id, '')
    if (!hydrated.property_address_state) hydrated.property_address_state = normalizeState(source.property_address_state || source.state)
  }

  if (hydrated.thread_key) {
    const { data: threadState } = await supabase
      .from('inbox_thread_state')
      .select('*')
      .eq('thread_key', hydrated.thread_key)
      .limit(1)
      .maybeSingle()
    applyRecord(threadState as Record<string, any> | null)
  }

  if (hydrated.property_id) {
    const { data: property } = await supabase
      .from('properties')
      .select('*')
      .eq('property_id', hydrated.property_id)
      .limit(1)
      .maybeSingle()
    applyRecord(property as Record<string, any> | null)
  }

  if (hydrated.prospect_id) {
    const { data: prospect } = await supabase
      .from('prospects')
      .select('*')
      .eq('prospect_id', hydrated.prospect_id)
      .limit(1)
      .maybeSingle()
    applyRecord(prospect as Record<string, any> | null)
  }

  const phone = asString(row.to_phone_number, '')
  if (phone) {
    const phoneVariants = [phone, phone.replace(/^\+1/, ''), phone.replace(/^\+/, '')]
    const { data: recentPropertyEvent } = await supabase
      .from('message_events')
      .select('*')
      .or(phoneVariants.map((value) => `from_phone_number.eq.${value},to_phone_number.eq.${value}`).join(','))
      .order('created_at', { ascending: false })
      .limit(10)

    const eventRow = Array.isArray(recentPropertyEvent)
      ? recentPropertyEvent.find((item) => item.property_id || item.market || item.master_owner_id)
      : null
    applyRecord((eventRow as Record<string, any> | null) ?? null)
  }

  if (!hydrated.market) hydrated.market = asString(metadata['market'], '')
  if (!hydrated.property_address_state) hydrated.property_address_state = normalizeState(metadata['property_address_state'])

  return hydrated
}
