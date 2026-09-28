/**
 * ANALYTICS — period performance of the acquisition machine vs the prior
 * period. Read-only; every metric carries its contract (METRICS).
 */
import { NextResponse } from 'next/server.js'
import { getAnalyticsPerformance } from '@/lib/domain/analytics/analytics-performance-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SAFE = /^[\w:.+-]{1,64}$/

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  const url = new URL(request.url)
  const pick = (k) => { const v = (url.searchParams.get(k) || '').trim(); return v && SAFE.test(v) ? v : null }
  try {
    const data = await getAnalyticsPerformance({ range: pick('range') || '30d', start: pick('start'), end: pick('end'), market: pick('market') })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('analytics.performance_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'analytics_performance_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
