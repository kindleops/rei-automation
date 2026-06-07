import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getDealContextByThread } from '@/lib/domain/deal-context/deal-context-service.js'
import { getThreadMessages, resolveDeliveryBadge } from '@/lib/domain/inbox/live-inbox-service.js'
import { loadThreadContext } from '@/lib/domain/inbox/thread-context-service.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

function object(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function nonEmptyObject(value) {
  const record = object(value)
  return Object.keys(record).length > 0 ? record : null
}

function firstArrayItem(value) {
  return Array.isArray(value) && value.length > 0 ? value[0] : null
}

function firstPresent(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    return value
  }
  return null
}

function quoteSupabaseValue(value) {
  return `"${clean(value).replaceAll('"', '""')}"`
}

function buildOrEquals(columns = [], values = []) {
  const uniqueValues = [...new Set(values.map(clean).filter(Boolean))]
  return columns
    .flatMap((column) => uniqueValues.map((value) => `${column}.eq.${quoteSupabaseValue(value)}`))
    .join(',')
}

function normalizePhone(value) {
  const raw = clean(value)
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw.startsWith('+') ? raw : `+${digits}`
}

function asTime(value) {
  const time = new Date(value || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function latestOutboundMessage(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => clean(row?.direction).toLowerCase().startsWith('out'))
    .sort((left, right) => (
      asTime(right?.event_timestamp || right?.created_at || right?.sent_at) -
      asTime(left?.event_timestamp || left?.created_at || left?.sent_at)
    ))[0] || null
}

function parseConversationThreadId(value) {
  const text = clean(value)
  if (!text.startsWith('ct:')) return {}
  const parsed = {}
  for (const segment of text.slice(3).split('|')) {
    const splitAt = segment.indexOf(':')
    if (splitAt <= 0) continue
    const key = segment.slice(0, splitAt)
    const rawValue = segment.slice(splitAt + 1)
    if (!rawValue) continue
    if (key === 'prospect') parsed.prospect_id = rawValue
    if (key === 'property') parsed.property_id = rawValue
    if (key === 'owner') parsed.master_owner_id = rawValue
    if (key === 'phone') parsed.normalized_phone = normalizePhone(rawValue)
  }
  return parsed
}

async function queryThreadRow({ thread_key, conversation_thread_id, legacy_thread_key, normalized_phone, canonical_e164, phone_e164, phone, best_phone, seller_phone, property_id, prospect_id, master_owner_id }) {
  const parsedIdentity = parseConversationThreadId(conversation_thread_id || thread_key)
  const resolvedPropertyId = property_id || parsedIdentity.property_id
  const resolvedProspectId = prospect_id || parsedIdentity.prospect_id
  const resolvedMasterOwnerId = master_owner_id || parsedIdentity.master_owner_id
  const resolvedNormalizedPhone = normalized_phone || parsedIdentity.normalized_phone
  const threadKeyPhone = clean(thread_key).startsWith('ct:') ? '' : normalizePhone(thread_key)
  const identityValues = [
    conversation_thread_id,
    legacy_thread_key,
    thread_key,
    canonical_e164,
    phone_e164,
    phone,
    best_phone,
    seller_phone,
    resolvedNormalizedPhone,
    threadKeyPhone,
    normalizePhone(canonical_e164 || phone_e164 || phone || best_phone || seller_phone),
  ].filter(Boolean)
  const idValues = [resolvedPropertyId, resolvedProspectId, resolvedMasterOwnerId].filter(Boolean)
  // P0: canonical_inbox_threads is the single source of truth and carries the full
  // deal-intelligence projection, so the dossier resolves from the SAME view as the
  // list. The legacy views are kept only as last-resort identity fallbacks.
  const sources = [
    {
      name: 'deal_context_index',
      columns: ['thread_key', 'canonical_e164'],
      idColumns: ['property_id', 'prospect_id', 'master_owner_id'],
    },
    {
      name: 'canonical_inbox_threads',
      columns: ['canonical_thread_key', 'thread_key', 'canonical_e164', 'best_phone', 'seller_phone', 'display_phone'],
      idColumns: ['property_id', 'prospect_id', 'master_owner_id', 'thread_property_id', 'thread_prospect_id', 'thread_master_owner_id'],
    },
    {
      name: 'inbox_threads_view',
      columns: ['canonical_thread_key', 'thread_key', 'canonical_e164', 'best_phone', 'seller_phone', 'display_phone'],
      idColumns: ['property_id', 'prospect_id', 'master_owner_id', 'thread_property_id', 'thread_prospect_id', 'thread_master_owner_id'],
    },
    {
      name: 'v_inbox_threads_live_v2',
      columns: ['thread_key', 'canonical_thread_key', 'canonical_e164', 'best_phone', 'seller_phone'],
      idColumns: ['property_id', 'prospect_id', 'master_owner_id'],
    },
  ]
  const diagnostics = []

  for (const source of sources) {
    const clauses = [
      buildOrEquals(source.columns, identityValues),
      buildOrEquals(source.idColumns, idValues),
    ].filter(Boolean).join(',')
    if (!clauses) continue
    try {
      let query = supabase.from(source.name).select('*').or(clauses)
      if (typeof query.order === 'function') {
        query = query.order('latest_message_at', { ascending: false, nullsFirst: false })
      }
      const { data, error } = await query.limit(1)
      if (error) {
        diagnostics.push({ source: source.name, ok: false, error: error.message })
        continue
      }
      const row = Array.isArray(data) ? data[0] : null
      diagnostics.push({ source: source.name, ok: true, rows: row ? 1 : 0 })
      if (row) return { row, source: source.name, diagnostics }
    } catch (error) {
      diagnostics.push({ source: source.name, ok: false, error: error?.message || String(error) })
    }
  }

  return { row: null, source: null, diagnostics }
}

async function fetchValuation(propertyId) {
  const property_id = clean(propertyId)
  if (!property_id) return { data: null, source: null, error: null }
  try {
    const { data, error } = await supabase
      .from('property_valuation_snapshots')
      .select('*')
      .eq('property_id', property_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return { data: null, source: 'property_valuation_snapshots', error: error.message }
    return { data: data || null, source: 'property_valuation_snapshots', error: null }
  } catch (error) {
    return { data: null, source: 'property_valuation_snapshots', error: error?.message || String(error) }
  }
}

function buildFieldMissingDiagnostics({ thread, messages, property, prospect, masterOwner, phone, dealContext, valuation }) {
  const checks = {
    seller_name: firstPresent(thread?.seller_display_name, thread?.owner_name, thread?.owner_display_name, prospect?.full_name, masterOwner?.owner_full_name, masterOwner?.full_name),
    property_address: firstPresent(thread?.property_address_full, thread?.property_address, property?.property_address_full, property?.property_address),
    property_id: firstPresent(thread?.property_id, property?.id, property?.property_id),
    property_market: firstPresent(thread?.market, property?.market, property?.market_name),
    prospect_language: firstPresent(prospect?.language, prospect?.language_preference, thread?.filter_language, thread?.language_preference),
    phone: firstPresent(thread?.best_phone, thread?.seller_phone, thread?.canonical_e164, phone?.canonical_e164, phone?.phone_number),
    last_message: firstPresent(thread?.latest_message_body, messages?.[messages.length - 1]?.message_body),
    thread_status: firstPresent(thread?.inbox_bucket, thread?.universal_status, dealContext?.inbox_bucket, dealContext?.universal_status),
    motivation_score: firstPresent(thread?.motivation_score, thread?.priority_score, dealContext?.priority_score),
    valuation: firstPresent(valuation?.id, valuation?.estimated_value, valuation?.estimated_arv, dealContext?.estimated_arv),
    routing_sender: firstPresent(thread?.our_number, thread?.sender_phone, dealContext?.our_number, dealContext?.sender_phone),
    outreach_suppression: firstPresent(thread?.suppression_status, thread?.opt_out, dealContext?.suppression_status, dealContext?.opt_out),
  }
  return Object.fromEntries(
    Object.entries(checks)
      .filter(([, value]) => value === null || value === undefined || value === '')
      .map(([field]) => [field, { field_missing: true }]),
  )
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const startedAt = Date.now()

  try {
    const auth = ensureMutationAuth(request)
    if (!auth.ok) return auth.response

    const { searchParams } = new URL(request.url)
    const thread_key = clean(searchParams.get('thread_key'))
    const conversation_thread_id = clean(searchParams.get('conversation_thread_id') || searchParams.get('conversationThreadId'))
    const legacy_thread_key = clean(searchParams.get('legacy_thread_key') || searchParams.get('legacyThreadKey'))
    const normalized_phone = clean(searchParams.get('normalized_phone') || searchParams.get('normalizedPhone'))
    const canonical_e164 = clean(searchParams.get('canonical_e164'))
    const phone_e164 = clean(searchParams.get('phone_e164'))
    const phone = clean(searchParams.get('phone'))
    const best_phone = clean(searchParams.get('best_phone'))
    const seller_phone = clean(searchParams.get('seller_phone'))
    const property_id = clean(searchParams.get('property_id'))
    const prospect_id = clean(searchParams.get('prospect_id'))
    const master_owner_id = clean(searchParams.get('master_owner_id') || searchParams.get('owner_id'))
    const latest_message_id = clean(searchParams.get('latest_message_id') || searchParams.get('latestMessageId') || searchParams.get('latest_message_event_id') || searchParams.get('latestMessageEventId'))
    const parsedIdentity = parseConversationThreadId(conversation_thread_id || thread_key)
    const effective_normalized_phone = normalized_phone || parsedIdentity.normalized_phone || ''
    const effective_property_id = property_id || parsedIdentity.property_id || ''
    const effective_prospect_id = prospect_id || parsedIdentity.prospect_id || ''
    const effective_master_owner_id = master_owner_id || parsedIdentity.master_owner_id || ''

    console.log('[THREAD_HYDRATION_IDENTITY]', {
      thread_key,
      conversation_thread_id,
      parsed_property_id: parsedIdentity.property_id || null,
      parsed_master_owner_id: parsedIdentity.master_owner_id || null,
      parsed_phone: parsedIdentity.normalized_phone || null,
      effective_property_id: effective_property_id || null,
      effective_master_owner_id: effective_master_owner_id || null,
      effective_phone: effective_normalized_phone || null,
      latest_message_id: latest_message_id || null,
    })

    if (!thread_key && !conversation_thread_id && !legacy_thread_key && !effective_normalized_phone && !canonical_e164 && !phone_e164 && !phone && !best_phone && !seller_phone && !effective_property_id && !effective_prospect_id && !effective_master_owner_id && !latest_message_id) {
      return NextResponse.json(
        {
          ok: true,
          degraded: true,
          error_code: 'missing_thread_identity',
          error: 'Provide thread_key, phone, property_id, prospect_id, or master_owner_id.',
          thread: null,
          messages: [],
          property: null,
          prospect: null,
          owner: null,
          masterOwner: null,
          master_owner: null,
          phone: null,
          dealContext: null,
          deal_context: null,
          deal_intelligence: null,
          valuationSnapshot: null,
          valuation: null,
          routing: null,
          outreach: null,
          degradedParts: ['identity'],
          diagnostics: {
            messagesOk: false,
            propertyOk: false,
            prospectOk: false,
            masterOwnerOk: false,
            phoneOk: false,
            dealContextOk: false,
            valuationOk: false,
            failedParts: ['identity'],
            queryMs: Date.now() - startedAt,
            sourceUsed: null,
            identitiesTried: {},
          },
        },
        { status: 200, headers },
      )
    }

    const failedParts = []
    const partHealth = {
      messagesOk: true,
      contextOk: true,
      dealContextOk: true,
      valuationOk: true,
    }
    const threadRowResult = await queryThreadRow({
      thread_key,
      conversation_thread_id,
      legacy_thread_key,
      normalized_phone: effective_normalized_phone,
      canonical_e164,
      phone_e164,
      phone,
      best_phone,
      seller_phone,
      property_id: effective_property_id,
      prospect_id: effective_prospect_id,
      master_owner_id: effective_master_owner_id,
    })
    let thread = threadRowResult.row || {
      thread_key: thread_key || canonical_e164 || phone_e164 || phone || best_phone || seller_phone || null,
      conversation_thread_id: conversation_thread_id || null,
      legacy_thread_key: legacy_thread_key || null,
      normalized_phone: effective_normalized_phone || canonical_e164 || phone_e164 || null,
      canonical_e164: canonical_e164 || phone_e164 || null,
      phone: phone || null,
      best_phone: best_phone || null,
      seller_phone: seller_phone || null,
      property_id: effective_property_id || null,
      prospect_id: effective_prospect_id || null,
      master_owner_id: effective_master_owner_id || null,
    }
    if (!threadRowResult.row) failedParts.push('thread')

    const latestMessageId = firstPresent(
      thread.latest_message_id,
      thread.latestMessageId,
      thread.latest_message_event_id,
      thread.latestMessageEventId,
      object(thread.latest_message_event_data).message_event_id,
      latest_message_id,
    )

    const resolvedThreadKey = thread.thread_key || thread_key || null

    // Remove redundant getDealContextByThread call if deal_context_index already hydrated it
    const hasDealContextData = threadRowResult.source === 'deal_context_index' && (nonEmptyObject(thread.property_data) || nonEmptyObject(thread.valuation_data) || thread.deal_context_id)
    const [messagesPayloadResult, contextPayloadResult, dealContextResult] = await Promise.all([
      getThreadMessages({
        selected_thread_key: thread_key || thread.thread_key,
        conversation_thread_id,
        legacy_thread_key,
        normalized_phone: effective_normalized_phone,
        canonical_e164: canonical_e164 || thread.canonical_e164,
        phone_e164,
        phone: phone || thread.phone,
        best_phone: best_phone || thread.best_phone,
        seller_phone: seller_phone || thread.seller_phone,
        property_id: effective_property_id || thread.property_id || thread.final_property_id,
        prospect_id: effective_prospect_id || thread.prospect_id || thread.final_prospect_id,
        master_owner_id: effective_master_owner_id || thread.master_owner_id || thread.final_master_owner_id,
        latest_message_id: latestMessageId || null,
      }, { offset: 0, limit: 50 }, {
        latestPreviewRow: thread,
        latestPreviewSource: threadRowResult.source || thread.latest_message_source || 'inbox_threads_view',
      }).catch((error) => {
        partHealth.messagesOk = false
        failedParts.push('messages')
        return {
          rows: [],
          total: 0,
          diagnostics: { error: error?.message || String(error) },
          threadKey: resolvedThreadKey,
          sourceUsed: 'message_events:degraded',
          identityUsed: null,
          queryMs: null,
        }
      }),
      resolvedThreadKey ? loadThreadContext({ thread_key: resolvedThreadKey, supabase }).catch((error) => {
        partHealth.contextOk = false
        failedParts.push('context')
        return { source_health: [{ table: 'thread_context', ok: false, error: error?.message || String(error), count: 0 }] }
      }) : Promise.resolve(null),
      hasDealContextData ? Promise.resolve(thread) : (resolvedThreadKey ? getDealContextByThread(resolvedThreadKey).catch((error) => {
        partHealth.dealContextOk = false
        failedParts.push('dealContext')
        return { _partial: true, thread_key: resolvedThreadKey, error: error?.message || String(error) }
      }) : Promise.resolve(null)),
    ])

    const messagesPayload = messagesPayloadResult
    const contextPayload = contextPayloadResult
    const latestOutbound = latestOutboundMessage(messagesPayload.rows)
    thread = {
      ...thread,
      latest_delivery_status: firstPresent(
        latestOutbound?.delivery_status,
        latestOutbound?.lifecycle_status,
        thread.latest_delivery_status,
        thread.delivery_status,
      ),
      latest_provider_delivery_status: firstPresent(
        latestOutbound?.provider_delivery_status,
        latestOutbound?.provider_status,
        thread.latest_provider_delivery_status,
        thread.provider_delivery_status,
      ),
      latest_delivered_at: firstPresent(latestOutbound?.delivered_at, thread.latest_delivered_at),
      latest_failed_at: firstPresent(latestOutbound?.failed_at, thread.latest_failed_at),
      latest_failure_reason: firstPresent(
        latestOutbound?.failure_reason,
        latestOutbound?.error_message,
        thread.latest_failure_reason,
      ),
    }
    thread.delivery_badge = resolveDeliveryBadge(thread)

    const selected = object(contextPayload?.context?.selected_thread)
    const fetchedDealContext = object(dealContextResult)
    const propertySource =
      nonEmptyObject(thread.property_data) ||
      firstArrayItem(selected.properties) ||
      nonEmptyObject(fetchedDealContext.property_data)
    const property = (propertySource || thread.property_id) ? {
      ...object(propertySource),
      id: firstPresent(propertySource?.id, propertySource?.property_id, thread.property_id),
      property_id: firstPresent(propertySource?.property_id, propertySource?.id, thread.property_id),
      property_address_full: firstPresent(
        propertySource?.property_address_full,
        propertySource?.property_address,
        thread.property_address_full,
        thread.property_address,
      ),
      market: firstPresent(propertySource?.market, propertySource?.market_name, thread.market, thread.display_market),
      latitude: firstPresent(propertySource?.latitude, propertySource?.lat, thread.latitude),
      longitude: firstPresent(propertySource?.longitude, propertySource?.lng, thread.longitude),
    } : null
    const prospectSource =
      nonEmptyObject(thread.prospect_data) ||
      firstArrayItem(selected.prospects) ||
      nonEmptyObject(fetchedDealContext.prospect_data)
    const prospect = (prospectSource || thread.prospect_id) ? {
      ...object(prospectSource),
      id: firstPresent(prospectSource?.id, prospectSource?.prospect_id, thread.prospect_id),
      prospect_id: firstPresent(prospectSource?.prospect_id, prospectSource?.id, thread.prospect_id),
      full_name: firstPresent(
        prospectSource?.full_name,
        prospectSource?.display_name,
        thread.prospect_full_name,
        thread.owner_name,
        thread.owner_display_name,
      ),
      language: firstPresent(
        prospectSource?.language,
        prospectSource?.language_preference,
        thread.filter_language,
        thread.language_preference,
      ),
    } : null
    const masterOwnerSource =
      nonEmptyObject(thread.master_owner_data) ||
      firstArrayItem(selected.master_owners) ||
      nonEmptyObject(fetchedDealContext.master_owner_data)
    const masterOwner = (masterOwnerSource || thread.master_owner_id) ? {
      ...object(masterOwnerSource),
      id: firstPresent(masterOwnerSource?.id, masterOwnerSource?.master_owner_id, thread.master_owner_id),
      master_owner_id: firstPresent(masterOwnerSource?.master_owner_id, masterOwnerSource?.id, thread.master_owner_id),
      owner_full_name: firstPresent(
        masterOwnerSource?.owner_full_name,
        masterOwnerSource?.full_name,
        masterOwnerSource?.display_name,
        thread.owner_name,
        thread.owner_display_name,
      ),
    } : null
    const phoneSource =
      nonEmptyObject(thread.phone_data) ||
      firstArrayItem(selected.phone_numbers) ||
      nonEmptyObject(fetchedDealContext.phone_data)
    const phoneRow = {
      ...object(phoneSource),
      canonical_e164: firstPresent(
        phoneSource?.canonical_e164,
        phoneSource?.best_phone,
        thread.canonical_e164,
        thread.best_phone,
        thread.seller_phone,
        phone,
      ),
      best_phone: firstPresent(phoneSource?.best_phone, thread.best_phone, thread.canonical_e164, thread.seller_phone),
      seller_phone: firstPresent(phoneSource?.seller_phone, thread.seller_phone, thread.canonical_e164, thread.best_phone),
      phone_number: firstPresent(phoneSource?.phone_number, thread.display_phone, thread.best_phone, thread.seller_phone),
    }
    const dealContext = {
      ...fetchedDealContext,
      thread_key: firstPresent(fetchedDealContext.thread_key, resolvedThreadKey),
      canonical_e164: firstPresent(fetchedDealContext.canonical_e164, phoneRow.canonical_e164),
      property_id: firstPresent(fetchedDealContext.property_id, property?.property_id, thread.property_id),
      prospect_id: firstPresent(fetchedDealContext.prospect_id, prospect?.prospect_id, thread.prospect_id),
      master_owner_id: firstPresent(fetchedDealContext.master_owner_id, masterOwner?.master_owner_id, thread.master_owner_id),
      property_data: property,
      prospect_data: prospect,
      master_owner_data: masterOwner,
      phone_data: phoneRow,
      deal_status: firstPresent(fetchedDealContext.deal_status, thread.deal_status, thread.universal_status, thread.display_status),
      deal_stage: firstPresent(
        fetchedDealContext.deal_stage,
        fetchedDealContext.current_stage,
        thread.deal_stage,
        thread.current_stage,
        thread.conversation_stage,
      ),
      current_stage: firstPresent(fetchedDealContext.current_stage, thread.current_stage, thread.conversation_stage),
      conversation_stage: firstPresent(fetchedDealContext.conversation_stage, thread.conversation_stage, thread.current_stage),
      inbox_bucket: firstPresent(fetchedDealContext.inbox_bucket, thread.inbox_bucket),
      inbox_category: firstPresent(fetchedDealContext.inbox_category, thread.inbox_category),
      latest_delivery_status: thread.latest_delivery_status || null,
      latest_provider_delivery_status: thread.latest_provider_delivery_status || null,
      latest_failed_at: thread.latest_failed_at || null,
      latest_failure_reason: thread.latest_failure_reason || null,
      delivery_badge: thread.delivery_badge,
    }
    const propertyIdForValuation = clean(property?.property_id || property?.id || dealContext?.property_id || thread.property_id || effective_property_id)

    // Remove redundant fetchValuation if deal_context_index already hydrated it
    const hasValuationData = nonEmptyObject(thread.valuation_data) || nonEmptyObject(fetchedDealContext.valuation_data)
    const valuationResult = hasValuationData ? { data: null, source: 'deal_context_index', error: null } : (propertyIdForValuation ? await fetchValuation(propertyIdForValuation) : { data: null, source: null, error: null })
    if (valuationResult.error) {
      partHealth.valuationOk = false
      failedParts.push('valuation')
    }
    const valuationSnapshot =
      valuationResult.data ||
      nonEmptyObject(thread.valuation_data) ||
      nonEmptyObject(dealContext.valuation_data) ||
      null
    dealContext.valuation_data = valuationSnapshot

    const routing = {
      seller_phone: firstPresent(thread.seller_phone, thread.best_phone, thread.canonical_e164, phoneRow.canonical_e164, dealContext?.seller_phone) || null,
      sender_phone: firstPresent(thread.sender_phone, thread.our_number, dealContext?.sender_phone, dealContext?.our_number) || null,
      textgrid_number_id: firstPresent(thread.textgrid_number_id, dealContext?.textgrid_number_id) || null,
    }
    const outreach = {
      suppression_status: firstPresent(thread.suppression_status, dealContext?.suppression_status, thread.opt_out ? 'suppressed' : null) || null,
      inbox_bucket: firstPresent(thread.inbox_bucket, dealContext?.inbox_bucket) || null,
      queue_status: firstPresent(thread.queue_status, dealContext?.queue_status) || null,
      reply_intent: firstPresent(thread.reply_intent, thread.detected_intent, dealContext?.reply_intent) || null,
      lead_temperature: firstPresent(thread.lead_temperature, dealContext?.lead_temperature) || null,
    }
    if (messagesPayload.integrityBlocked === true) failedParts.push('threadIdentityIntegrity')
    const messageOffset = 0
    const messageLimit = 50
    const messageTotal = Number.isFinite(Number(messagesPayload.total)) ? Number(messagesPayload.total) : messagesPayload.rows.length
    const messageNextOffset = messageOffset + messagesPayload.rows.length
    const messagePagination = {
      offset: messageOffset,
      limit: messageLimit,
      total: messageTotal,
      has_more: messageNextOffset < messageTotal,
      next_offset: messageNextOffset < messageTotal ? messageNextOffset : null,
    }

    const fieldMissing = buildFieldMissingDiagnostics({
      thread,
      messages: messagesPayload.rows,
      property,
      prospect,
      masterOwner,
      phone: phoneRow,
      dealContext,
      valuation: valuationSnapshot,
    })
    const uniqueFailedParts = [...new Set(failedParts)]
    const criticalFailedParts = uniqueFailedParts.filter(p => ['messages', 'dealContext', 'threadIdentityIntegrity', 'thread', 'identity'].includes(p))
    const diagnosticsHealth = {
      messagesOk: partHealth.messagesOk,
      propertyOk: Boolean(property),
      prospectOk: Boolean(prospect),
      masterOwnerOk: Boolean(masterOwner),
      phoneOk: Boolean(phoneRow.canonical_e164 || phoneRow.phone_number),
      dealContextOk: partHealth.dealContextOk && Object.keys(dealContext).length > 0,
      valuationOk: partHealth.valuationOk,
      failedParts: uniqueFailedParts,
    }

    // Resilience Check: if major deal parts are missing entirely, gracefully degrade
    if (Object.keys(fieldMissing).length >= 4 && !property && !prospect && !dealContext?.inbox_bucket) {
      return NextResponse.json(
        {
          ok: true,
          degraded: criticalFailedParts.length > 0,
          error_code: 'hydration_incomplete',
          error: 'Required thread context subsections missing (returning null)',
          thread: null,
          messages: messagesPayload.rows,
          property: null,
          prospect: null,
          owner: null,
          masterOwner: null,
          master_owner: null,
          phone: null,
          dealContext: null,
          deal_context: null,
          deal_intelligence: null,
          valuationSnapshot: null,
          valuation: null,
          routing: null,
          outreach: null,
          pagination: messagePagination,
          failedParts: uniqueFailedParts,
          degradedParts: uniqueFailedParts,
          diagnostics: {
            ...diagnosticsHealth,
            queryMs: Date.now() - startedAt,
            sourceUsed: { thread: threadRowResult.source },
            threadKey: resolvedThreadKey,
            field_missing: fieldMissing,
          },
        },
        { status: 200, headers },
      )
    }

    return NextResponse.json(
      {
        ok: true,
        degraded: criticalFailedParts.length > 0,
        integrity_blocked: messagesPayload.integrityBlocked === true,
        integrityBlocked: messagesPayload.integrityBlocked === true,
        thread,
        messages: messagesPayload.rows,
        property,
        prospect,
        owner: masterOwner,
        masterOwner,
        master_owner: masterOwner,
        phone: phoneRow,
        dealContext,
        deal_context: dealContext,
        deal_intelligence: dealContext,
        valuationSnapshot,
        valuation: valuationSnapshot,
        routing,
        outreach,
        pagination: messagePagination,
        failedParts: uniqueFailedParts,
        degradedParts: criticalFailedParts,
        diagnostics: {
          ...diagnosticsHealth,
          queryMs: Date.now() - startedAt,
          sourceUsed: {
            thread: threadRowResult.source,
            messages: messagesPayload.sourceUsed,
            context: 'thread-context-service',
            deal_context: 'v_deal_context_cards',
            valuation: valuationResult.source,
          },
          threadKey: resolvedThreadKey,
          conversation_thread_id: messagesPayload.conversationThreadId || messagesPayload.diagnostics?.conversation_thread_id || conversation_thread_id || null,
          integrity_blocked: messagesPayload.integrityBlocked === true,
          identityUsed: messagesPayload.identityUsed || null,
          identitiesTried: messagesPayload.diagnostics?.identitiesTried || messagesPayload.diagnostics?.identities_tried || null,
          threadRowSources: threadRowResult.diagnostics,
          messages: messagesPayload.diagnostics,
          pagination: messagePagination,
          sourceHealth: contextPayload?.source_health || [],
          field_missing: fieldMissing,
        },
      },
      { status: 200, headers },
    )
  } catch (error) {
    console.error('[THREAD_HYDRATION_FAILED]', {
      message: error?.message || String(error),
      code: error?.code || null,
      details: error?.details || null,
      hint: error?.hint || null,
      stack: error?.stack || null,
    })
    return NextResponse.json(
      {
        ok: true,
        degraded: true,
        error_code: 'thread_hydration_degraded',
        error: error?.message || 'Unknown thread hydration error',
        thread: null,
        messages: [],
        property: null,
        prospect: null,
        owner: null,
        masterOwner: null,
        master_owner: null,
        phone: null,
        dealContext: null,
        deal_context: null,
        deal_intelligence: null,
        valuationSnapshot: null,
        valuation: null,
        routing: null,
        outreach: null,
        failedParts: ['route'],
        degradedParts: ['route'],
        diagnostics: {
          messagesOk: false,
          propertyOk: false,
          prospectOk: false,
          masterOwnerOk: false,
          phoneOk: false,
          dealContextOk: false,
          valuationOk: false,
          failedParts: ['route'],
          queryMs: Date.now() - startedAt,
          sourceUsed: null,
          error: {
            message: error?.message || String(error),
            code: error?.code || null,
            details: error?.details || null,
            hint: error?.hint || null,
          },
        },
      },
      { status: 200, headers },
    )
  }
}
