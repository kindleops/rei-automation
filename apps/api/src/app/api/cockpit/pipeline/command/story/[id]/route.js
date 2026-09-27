/**
 * PIPELINE COMMAND — one deal's story + sections (conversation, negotiation,
 * decision engine, disposition, closing). Read-only.
 */
import { NextResponse } from 'next/server.js'
import { getPipelineDealStory } from '@/lib/domain/opportunity/pipeline-command-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  }
  const { id } = await params
  if (!UUID.test(String(id || ''))) return NextResponse.json({ ok: false, error: 'invalid_opportunity_id' }, { status: 400, headers })
  try {
    const data = await getPipelineDealStory(id)
    if (!data) return NextResponse.json({ ok: false, error: 'opportunity_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('pipeline.command.story_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'pipeline_command_story_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
