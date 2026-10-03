/**
 * NOTIFICATION STORIES — the aggregated read model behind Notification Center 2.0.
 * Server/auth only (ops dashboard session); never anonymous. Read-only.
 * See lib/domain/notifications/stories/ for the grammar and the state model.
 */
import { NextResponse } from 'next/server.js'
import { getNotificationStories, StoryError } from '@/lib/domain/notifications/stories/story-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams.entries())
    const t0 = performance.now()
    const data = await getNotificationStories(query)
    // the handler's own time (the read), separate from any server queueing in front of it
    const dur = Math.round(performance.now() - t0)
    return NextResponse.json(data, { status: 200, headers: { ...headers, 'Cache-Control': 'no-store', 'Server-Timing': `stories;desc="${data.source || 'read'}";dur=${dur}` } })
  } catch (error) {
    if (error instanceof StoryError) return NextResponse.json({ ok: false, errorType: 'bad_request', error: error.code, message: error.message }, { status: error.status, headers })
    console.error('notifications.stories_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'stories_failed', message: 'Notifications could not be resolved right now.', retryable: true }, { status: 500, headers })
  }
}
