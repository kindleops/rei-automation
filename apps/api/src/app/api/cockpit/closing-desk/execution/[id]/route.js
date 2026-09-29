import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../../_shared.js'
import { getClosingExecution } from '@/lib/domain/closings/closing-execution-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET /api/cockpit/closing-desk/execution/:id[?activity_before=ISO]
 * One transaction room. :id is a closing_case_id (`closing:<uuid>`) or an
 * opportunity uuid. Activity is paginated by `activity_before`.
 */
export async function GET(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return unauthorizedJson(auth.response, headers)
  try {
    const { id } = await params
    const before = new URL(request.url).searchParams.get('activity_before')
    const data = await getClosingExecution(decodeURIComponent(String(id || '')), { activityBefore: before || null })
    if (!data) return NextResponse.json({ ok: false, error: 'closing_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'closing_execution_failed' }, { status: 500, headers })
  }
}
