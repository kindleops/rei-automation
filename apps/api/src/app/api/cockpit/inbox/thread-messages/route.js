import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { degradedThreadMessagesPayload } from '@/lib/domain/inbox/degraded-read-responses.js'
import { getThreadMessages } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
])

function resolveAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  if (/^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) return origin
  return null
}

function corsHeaders(request) {
  const origin = request.headers.get('origin')
  const allowedOrigin = resolveAllowedOrigin(origin)
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

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
  const canonical_e164 = clean(searchParams.get('canonical_e164'))
  const phone = clean(searchParams.get('phone'))
  const best_phone = clean(searchParams.get('best_phone'))
  const seller_phone = clean(searchParams.get('seller_phone'))
  const offset = Math.max(0, Number.parseInt(clean(searchParams.get('offset')) || '0', 10) || 0)
  const limit = Math.min(500, Math.max(1, Number.parseInt(clean(searchParams.get('limit')) || '200', 10) || 200))

  if (!thread_key) {
    return NextResponse.json({ ok: false, error: 'missing_thread_key' }, { status: 400, headers: cors })
  }

  try {
    const { rows, total, diagnostics } = await getThreadMessages({
      selected_thread_key: thread_key,
      canonical_e164,
      phone,
      best_phone,
      seller_phone,
    }, { offset, limit })
    const nextOffset = offset + rows.length

    return NextResponse.json(
      {
        ok: true,
        action: 'thread-messages',
        thread_key,
        messages: rows,
        pagination: {
          offset,
          limit,
          total,
          has_more: nextOffset < total,
          next_offset: nextOffset < total ? nextOffset : null,
        },
        diagnostics: {
          ...diagnostics,
          thread_key,
          canonical_e164: canonical_e164 || diagnostics?.canonical_e164 || null,
          canonical_thread_key: diagnostics?.canonical_thread_key || thread_key,
          messages: rows,
          pagination: {
            offset,
            limit,
            total,
            has_more: nextOffset < total,
            next_offset: nextOffset < total ? nextOffset : null,
          },
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
