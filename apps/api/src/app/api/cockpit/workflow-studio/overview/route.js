/** Workflow Studio home — live system workflows, studio definitions (honest), runtime health. */
import { getWorkflowOverview } from '@/lib/domain/workflow-studio/observatory-service.js'
import { optionsResponse, requireAuth, withCors } from '../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  try {
    return withCors(request, await getWorkflowOverview())
  } catch (error) {
    return withCors(request, { ok: false, error: 'workflow_overview_failed', message: error?.message || String(error) }, 500)
  }
}
