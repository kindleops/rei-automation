import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { listWorkflowAutomationActivity } from '@/lib/domain/workflow-v2/workflow-automation-activity-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      {
        ok: false,
        errorType: 'auth_error',
        error: 'unauthorized',
        message: 'Dashboard authentication required',
        retryable: true,
      },
      { status: auth.response?.status || 401, headers },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const result = await listWorkflowAutomationActivity(Object.fromEntries(searchParams.entries()))
    return NextResponse.json({ ok: true, data: result, source: 'workflow_automation_activity' }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        errorType: 'query_failed',
        error: 'automation_activity_fetch_failed',
        message: error?.message || String(error),
        retryable: true,
      },
      { status: 500, headers },
    )
  }
}