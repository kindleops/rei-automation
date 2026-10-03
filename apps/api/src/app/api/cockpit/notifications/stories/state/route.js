/**
 * NOTIFICATION STORY STATE — READ / RESOLVED (kept separate, both persisted).
 * POST { story_ids: string[], action: 'read'|'unread'|'resolve'|'reopen' }
 * Ops dashboard auth only. Writes only notification state — never seller,
 * campaign, valuation, offer or compliance state.
 */
import { NextResponse } from 'next/server.js'
import { updateStoryState, StoryError } from '@/lib/domain/notifications/stories/story-service.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { operatorIdFromHeaders } from '@/lib/domain/intelligence/corrections/corrections.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await parseJsonSafe(request)
    const data = await updateStoryState(body, { operatorId: operatorIdFromHeaders(request.headers) || auth.auth?.operator_id || auth.auth?.user_id || null })
    return NextResponse.json(data, { status: 200, headers: { ...headers, 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof StoryError) return NextResponse.json({ ok: false, errorType: 'bad_request', error: error.code, message: error.message }, { status: error.status, headers })
    console.error('notifications.story_state_failed', error)
    return NextResponse.json({ ok: false, errorType: 'write_failed', error: 'story_state_failed', message: 'Story state could not be saved right now.', retryable: true }, { status: 500, headers })
  }
}
