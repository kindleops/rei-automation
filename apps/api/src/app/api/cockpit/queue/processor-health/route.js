import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { fetchQueueProcessorHealth } from '@/lib/cockpit/queue-processor-health-service.js'

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
    const data = await fetchQueueProcessorHealth()
    return NextResponse.json({ ok: true, action: 'queue-processor-health', ...data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'queue_processor_health_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}