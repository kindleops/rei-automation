/**
 * PIPELINE COMMAND — flow. Read-only: the river over a period (what entered
 * and left each stage, by the machine or an operator), what is in flight in
 * the queue now, and the period's real movement. See getPipelineCommandFlow in
 * lib/domain/opportunity/pipeline-command-service.js.
 */
import { NextResponse } from 'next/server.js'
import { getPipelineCommandFlow } from '@/lib/domain/opportunity/pipeline-command-service.js'
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
    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const data = await getPipelineCommandFlow(params)
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('pipeline.command.flow_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'pipeline_command_flow_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
