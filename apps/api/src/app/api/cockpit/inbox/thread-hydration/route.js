import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getDealContextByThread } from '@/lib/domain/deal-context/deal-context-service.js'
import { getThreadMessages } from '@/lib/domain/inbox/live-inbox-service.js'
import { loadThreadContext } from '@/lib/domain/inbox/thread-context-service.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

function object(value) {
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
  const sources = [
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
    {
      name: 'v_inbox_enriched',
      columns: ['thread_key', 'best_phone', 'seller_phone', 'display_phone'],
      idColumns: ['property_id', 'final_property_id', 'final_prospect_id', 'master_owner_id', 'final_master_owner_id'],
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
          master_owner: null,
          phone: null,
          deal_context: null,
          deal_intelligence: null,
          valuation: null,
          routing: null,
          outreach: null,
          degradedParts: ['identity'],
          diagnostics: {
            queryMs: Date.now() - startedAt,
            sourceUsed: null,
            identitiesTried: {},
          },
        },
        { status: 200, headers },
      )
    }

    const degradedParts = []
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
    const thread = threadRowResult.row || {
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
    if (!threadRowResult.row) degradedParts.push('thread_row')

    let messagesPayload = { rows: [], total: 0, diagnostics: {}, threadKey: thread.thread_key || thread_key || null, sourceUsed: null, identityUsed: null, queryMs: null }
    try {
      const latestMessageId = firstPresent(
        thread.latest_message_id,
        thread.latestMessageId,
        thread.latest_message_event_id,
        thread.latestMessageEventId,
        object(thread.latest_message_event_data).message_event_id,
        latest_message_id,
      )
      messagesPayload = await getThreadMessages({
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
        latest_message_id: latestMessageId || latest_message_id || null,
      }, { offset: 0, limit: 50 }, {
        latestPreviewRow: thread,
        latestPreviewSource: threadRowResult.source || thread.latest_message_source || 'inbox_threads_view',
      })
    } catch (error) {
      degradedParts.push('messages')
      messagesPayload = {
        rows: [],
        total: 0,
        diagnostics: { error: error?.message || String(error) },
        threadKey: thread.thread_key || thread_key || null,
        sourceUsed: 'message_events:degraded',
        identityUsed: null,
        queryMs: null,
      }
    }

    const resolvedThreadKey = messagesPayload.threadKey || thread.thread_key || thread_key || null

    let contextPayload = null
    if (resolvedThreadKey) {
      try {
        contextPayload = await loadThreadContext({ thread_key: resolvedThreadKey, supabase })
      } catch (error) {
        degradedParts.push('context')
        contextPayload = { source_health: [{ table: 'thread_context', ok: false, error: error?.message || String(error), count: 0 }] }
      }
    }

    let dealContext = null
    if (resolvedThreadKey) {
      try {
        dealContext = await getDealContextByThread(resolvedThreadKey)
      } catch (error) {
        degradedParts.push('deal_context')
        dealContext = { _partial: true, thread_key: resolvedThreadKey, error: error?.message || String(error) }
      }
    }

    const selected = object(contextPayload?.context?.selected_thread)
    const property = firstArrayItem(selected.properties) || nonEmptyObject(dealContext?.property_data) || (thread.property_id ? {
      id: thread.property_id,
      property_id: thread.property_id,
      property_address_full: thread.property_address_full || thread.property_address || null,
      market: thread.market || thread.display_market || null,
    } : null)
    const prospect = firstArrayItem(selected.prospects) || nonEmptyObject(dealContext?.prospect_data) || (thread.prospect_id ? {
      id: thread.prospect_id,
      prospect_id: thread.prospect_id,
      full_name: thread.prospect_full_name || thread.owner_name || thread.owner_display_name || null,
      language: thread.filter_language || thread.language_preference || null,
    } : null)
    const masterOwner = firstArrayItem(selected.master_owners) || nonEmptyObject(dealContext?.master_owner_data) || (thread.master_owner_id ? {
      id: thread.master_owner_id,
      master_owner_id: thread.master_owner_id,
      owner_full_name: thread.owner_name || thread.owner_display_name || null,
    } : null)
    const phoneRow = firstArrayItem(selected.phone_numbers) || nonEmptyObject(dealContext?.phone_data) || {
      canonical_e164: thread.canonical_e164 || thread.best_phone || thread.seller_phone || phone || null,
      phone_number: thread.display_phone || thread.best_phone || thread.seller_phone || null,
    }
    const propertyIdForValuation = clean(property?.property_id || property?.id || dealContext?.property_id || thread.property_id || effective_property_id)
    const valuationResult = await fetchValuation(propertyIdForValuation)
    if (valuationResult.error) degradedParts.push('valuation')

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
    if (messagesPayload.integrityBlocked === true) degradedParts.push('thread_identity_integrity')
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
      valuation: valuationResult.data || nonEmptyObject(dealContext?.valuation_data),
    })
    if (Object.keys(fieldMissing).length > 0) degradedParts.push('field_missing')

    return NextResponse.json(
      {
        ok: true,
        degraded: degradedParts.length > 0,
        integrity_blocked: messagesPayload.integrityBlocked === true,
        integrityBlocked: messagesPayload.integrityBlocked === true,
        thread,
        messages: messagesPayload.rows,
        property,
        prospect,
        owner: masterOwner,
        master_owner: masterOwner,
        phone: phoneRow,
        deal_context: dealContext,
        deal_intelligence: dealContext,
        valuation: valuationResult.data || nonEmptyObject(dealContext?.valuation_data) || null,
        routing,
        outreach,
        pagination: messagePagination,
        degradedParts: [...new Set(degradedParts)],
        diagnostics: {
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
        master_owner: null,
        phone: null,
        deal_context: null,
        deal_intelligence: null,
        valuation: null,
        routing: null,
        outreach: null,
        degradedParts: ['fatal'],
        diagnostics: {
          queryMs: Date.now() - startedAt,
          sourceUsed: null,
        },
      },
      { status: 200, headers },
    )
  }
}
