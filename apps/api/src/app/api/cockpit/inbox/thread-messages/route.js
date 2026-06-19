import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { degradedThreadMessagesPayload } from '@/lib/domain/inbox/degraded-read-responses.js'
import { getThreadMessages } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
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
  const prospect_id = clean(searchParams.get('prospect_id'))
  const property_id = clean(searchParams.get('property_id'))
  const owner_id = clean(searchParams.get('owner_id'))
  const master_owner_id = clean(searchParams.get('master_owner_id'))
  const latest_message_id = clean(searchParams.get('latest_message_id') || searchParams.get('latestMessageId') || searchParams.get('latest_message_event_id') || searchParams.get('latestMessageEventId'))
  const fetchAll = ['1', 'true', 'yes'].includes(clean(searchParams.get('fetch_all') || searchParams.get('fetchAll')).toLowerCase())
  const offset = fetchAll ? 0 : Math.max(0, Number.parseInt(clean(searchParams.get('offset')) || '0', 10) || 0)
  const limit = fetchAll
    ? 2000
    : Math.min(100, Math.max(1, Number.parseInt(clean(searchParams.get('limit')) || '50', 10) || 50))

  if (!thread_key && !conversation_thread_id && !legacy_thread_key && !normalized_phone && !canonical_e164 && !phone_e164 && !phone && !best_phone && !seller_phone && !prospect_id && !property_id && !owner_id && !master_owner_id && !latest_message_id) {
    return NextResponse.json(
      degradedThreadMessagesPayload({
        error: new Error('missing_thread_identity'),
        thread_key: null,
        canonical_e164: null,
        offset,
        limit,
        diagnostics: {
          error_code: 'missing_thread_identity',
          identities_tried: {
            thread_keys: [],
            phones: [],
            prospect_ids: [],
            property_ids: [],
            master_owner_ids: [],
          },
        },
      }),
      { status: 200, headers: cors },
    )
  }

  try {
    const startedAt = Date.now()
    const { rows, total, diagnostics, threadKey, conversationThreadId, integrityBlocked, identityUsed, sourceUsed, queryMs } = await getThreadMessages({
      selected_thread_key: thread_key,
      conversation_thread_id,
      legacy_thread_key,
      normalized_phone,
      canonical_e164,
      phone_e164,
      phone,
      best_phone,
      seller_phone,
      prospect_id,
      property_id,
      owner_id,
      master_owner_id,
      latest_message_id,
    }, { offset, limit, fetchAll })
    const nextOffset = offset + rows.length
    const hasMore = fetchAll ? false : nextOffset < total

    return NextResponse.json(
      {
        ok: true,
        action: 'thread-messages',
        degraded: false,
        fetch_all: fetchAll,
        integrity_blocked: integrityBlocked === true,
        integrityBlocked: integrityBlocked === true,
        thread_key,
        threadKey: threadKey || thread_key || null,
        conversation_thread_id: conversationThreadId || conversation_thread_id || diagnostics?.conversation_thread_id || null,
        conversationThreadId: conversationThreadId || conversation_thread_id || diagnostics?.conversation_thread_id || null,
        identityUsed: identityUsed || null,
        sourceUsed: sourceUsed || 'message_events',
        queryMs: Number.isFinite(Number(queryMs)) ? Number(queryMs) : Date.now() - startedAt,
        messages: rows,
        pagination: {
          offset,
          limit,
          total,
          has_more: hasMore,
          next_offset: hasMore ? nextOffset : null,
        },
        diagnostics: {
          ...diagnostics,
          thread_key,
          threadKey: threadKey || thread_key || null,
          conversation_thread_id: conversationThreadId || conversation_thread_id || diagnostics?.conversation_thread_id || null,
          conversationThreadId: conversationThreadId || conversation_thread_id || diagnostics?.conversation_thread_id || null,
          integrity_blocked: integrityBlocked === true,
          canonical_e164: canonical_e164 || diagnostics?.canonical_e164 || null,
          phone_e164: phone_e164 || null,
          canonical_thread_key: diagnostics?.canonical_thread_key || thread_key || null,
          identityUsed: identityUsed || diagnostics?.identityUsed || null,
          sourceUsed: sourceUsed || diagnostics?.sourceUsed || 'message_events',
          queryMs: Number.isFinite(Number(queryMs)) ? Number(queryMs) : Date.now() - startedAt,
          messages: rows,
          pagination: {
            offset,
            limit,
            total,
            has_more: hasMore,
            next_offset: hasMore ? nextOffset : null,
          },
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      degradedThreadMessagesPayload({
        error,
        thread_key: thread_key || null,
        canonical_e164: canonical_e164 || phone_e164 || null,
        offset,
        limit,
        diagnostics: {
          input: {
            thread_key,
            conversation_thread_id,
            legacy_thread_key,
            normalized_phone,
            canonical_e164,
            phone_e164,
            phone,
            best_phone,
            seller_phone,
            prospect_id,
            property_id,
            owner_id,
            master_owner_id,
          },
        },
      }),
      { status: 200, headers: cors },
    )
  }
}
