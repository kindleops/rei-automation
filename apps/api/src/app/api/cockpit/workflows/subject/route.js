import { NextResponse } from 'next/server.js'

import { corsHeaders, ensureDashboardReadAuth, workflowError, workflowSuccess } from '../../_shared.js'
import { getWorkflowSubjectAutomation } from '@/lib/domain/workflow-v2/workflow-studio-bridge.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cockpit/workflows/subject?thread_key=...&property_id=...
 *
 * §24/§25 — what automation is running for ONE subject, or an honest nothing.
 *
 * Workflow Studio opened from a property used to display the FIRST workflow in
 * the catalog as though it belonged to that property, because the load effect
 * ran `loadSelected(rows[0].id)` regardless of the subject context it already
 * held. This is the endpoint that lets the surface answer the question instead
 * of guessing: an empty `enrollments` array with
 * `empty_reason: 'no_automation_for_subject'` is a real answer.
 */
export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response

  const startedAt = Date.now()
  const url = new URL(request.url)
  const input = {
    thread_key: url.searchParams.get('thread_key'),
    subject_id: url.searchParams.get('subject_id'),
    opportunity_id: url.searchParams.get('opportunity_id'),
    property_id: url.searchParams.get('property_id'),
  }

  try {
    const result = await getWorkflowSubjectAutomation(input)
    if (!result.ok) {
      return NextResponse.json(
        workflowError(
          result.error === 'subject_required' ? 'SUBJECT_REQUIRED' : 'WORKFLOW_SUBJECT_FAILED',
          result.error === 'subject_required'
            ? 'A thread key, subject, opportunity or property is required.'
            : 'Subject automation could not be loaded.',
          false,
          startedAt,
        ),
        { status: result.status ?? 500, headers: corsHeaders(request) },
      )
    }
    return NextResponse.json(workflowSuccess(result, startedAt), { headers: corsHeaders(request) })
  } catch (error) {
    return NextResponse.json(
      workflowError('WORKFLOW_SUBJECT_FAILED', error?.message || 'subject_automation_failed', true, startedAt),
      { status: 500, headers: corsHeaders(request) },
    )
  }
}
