/**
 * PLATFORM EVENTS — the one event language (Machine Feed + Time Machine).
 * Read-only; see lib/domain/platform/events/ for the envelope and ownership.
 */
import { NextResponse } from 'next/server.js'
import { listPlatformEvents, PlatformEventsError } from '@/lib/domain/platform/events/platform-events-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  }
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams.entries())
    const data = await listPlatformEvents(query)
    return NextResponse.json(data, { status: 200, headers: { ...headers, 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof PlatformEventsError) {
      return NextResponse.json({ ok: false, errorType: 'bad_request', error: error.code, message: error.message }, { status: error.status, headers })
    }
    console.error('platform.events_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'platform_events_failed', message: 'Event history could not be resolved right now.', retryable: true }, { status: 500, headers })
  }
}
