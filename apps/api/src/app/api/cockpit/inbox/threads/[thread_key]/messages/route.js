import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../../../_shared.js'
import { degradedThreadMessagesPayload } from '@/lib/domain/inbox/degraded-read-responses.js'
import { getThreadMessages } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const { thread_key } = await params
  const { searchParams } = new URL(request.url)
  const conversation_thread_id = searchParams.get('conversation_thread_id') || searchParams.get('conversationThreadId')
  const legacy_thread_key = searchParams.get('legacy_thread_key') || searchParams.get('legacyThreadKey')
  const normalized_phone = searchParams.get('normalized_phone') || searchParams.get('normalizedPhone')
  const canonical_e164 = searchParams.get('canonical_e164')
  const phone = searchParams.get('phone')
  const best_phone = searchParams.get('best_phone')
  const seller_phone = searchParams.get('seller_phone')
  const prospect_id = searchParams.get('prospect_id')
  const property_id = searchParams.get('property_id')
  const master_owner_id = searchParams.get('master_owner_id') || searchParams.get('owner_id')
  const latest_message_id = searchParams.get('latest_message_id') || searchParams.get('latestMessageId') || searchParams.get('latest_message_event_id') || searchParams.get('latestMessageEventId')
  const fetchAll = ['1', 'true', 'yes'].includes(String(searchParams.get('fetch_all') || searchParams.get('fetchAll') || '').trim().toLowerCase())
  const offset = fetchAll ? 0 : Math.max(0, Number.parseInt(searchParams.get('offset') || '0', 10) || 0)
  const limit = fetchAll
    ? 2000
    : Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') || '50', 10) || 50))

  if (!thread_key) {
    return NextResponse.json({ ok: false, error: 'missing_thread_key' }, { status: 400, headers: cors })
  }

  try {
    const { rows, total, diagnostics, conversationThreadId, integrityBlocked } = await getThreadMessages({
      selected_thread_key: thread_key,
      conversation_thread_id,
      legacy_thread_key,
      normalized_phone,
      canonical_e164,
      phone,
      best_phone,
      seller_phone,
      prospect_id,
      property_id,
      master_owner_id,
      latest_message_id,
    }, { offset, limit, fetchAll })

    const nextOffset = offset + rows.length

    const pagination = {
      offset,
      limit,
      total,
      has_more: fetchAll ? false : nextOffset < total,
      next_offset: fetchAll ? null : (nextOffset < total ? nextOffset : null),
    }

    return NextResponse.json(
      {
        ok: true,
        action: 'thread-messages',
        fetch_all: fetchAll,
        thread_key,
        conversation_thread_id: conversationThreadId || conversation_thread_id || diagnostics?.conversation_thread_id || null,
        integrity_blocked: integrityBlocked === true,
        messages: rows,
        pagination,
        // Keep diagnostics wrapper for backward compatibility
        diagnostics: {
          ...diagnostics,
          thread_key,
          conversation_thread_id: conversationThreadId || conversation_thread_id || diagnostics?.conversation_thread_id || null,
          integrity_blocked: integrityBlocked === true,
          canonical_e164: canonical_e164 || diagnostics?.canonical_e164 || null,
          canonical_thread_key: diagnostics?.canonical_thread_key || thread_key,
          messages: rows,
          pagination,
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      degradedThreadMessagesPayload({
        error,
        thread_key,
        canonical_e164,
        offset,
        limit,
      }),
      { status: 200, headers: cors },
    )
  }
}
