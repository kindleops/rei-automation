import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { fetchQueuePage } from '@/lib/cockpit/queue-page-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function corsHeaders(_request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
  }
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const data = await fetchQueuePage({
      page: Number(searchParams.get('page') || 0),
      pageSize: Number(searchParams.get('pageSize') || searchParams.get('page_size') || 50),
      status: searchParams.get('status') || 'all',
      dateBasis: searchParams.get('dateBasis') || searchParams.get('date_basis') || 'created_at',
      dateFrom: searchParams.get('dateFrom') || searchParams.get('date_from') || null,
      dateTo: searchParams.get('dateTo') || searchParams.get('date_to') || null,
      market: searchParams.get('market') || 'all',
      sender: searchParams.get('sender') || 'all',
    })
    return NextResponse.json({ ok: true, action: 'queue-page', ...data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'queue_page_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}