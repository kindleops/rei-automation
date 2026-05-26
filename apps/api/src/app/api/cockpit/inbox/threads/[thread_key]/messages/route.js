import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

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
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: cors }
    )
  }

  const { thread_key } = params
  const { searchParams } = new URL(request.url)
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') || '0', 10) || 0)
  const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get('limit') || '200', 10) || 200))

  if (!thread_key) {
    return NextResponse.json({ ok: false, error: 'missing_thread_key' }, { status: 400, headers: cors })
  }

  try {
    const { data, error, count } = await supabase
      .from('inbox_messages_hydrated')
      .select('*', { count: 'exact' })
      .eq('thread_key', thread_key)
      .order('message_created_at', { ascending: true })
      .range(offset, offset + limit - 1)

    if (error) throw error

    const rows = Array.isArray(data) ? data : []
    const total = Number.isFinite(Number(count)) ? Number(count) : rows.length
    const nextOffset = offset + rows.length

    return NextResponse.json(
      {
        ok: true,
        action: 'thread-messages',
        diagnostics: {
          thread_key,
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
      {
        ok: false,
        action: 'thread-messages',
        error: 'thread_messages_failed',
        message: error?.message || 'Unknown thread messages error',
      },
      { status: 500, headers: cors },
    )
  }
}
