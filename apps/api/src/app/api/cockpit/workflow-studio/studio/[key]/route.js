/** One studio workflow: graph, versions, runs with the lead each one is on. */
import { getStudioWorkflow } from '@/lib/domain/workflow-studio/studio-home-service.js'
import { optionsResponse, params, requireAuth, withCors } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, { params: p }) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  try {
    const result = await getStudioWorkflow((await p).key)
    return withCors(request, result, result.ok === false ? result.status || 500 : 200)
  } catch (error) {
    return withCors(request, { ok: false, error: 'studio_workflow_failed', message: error?.message || String(error) }, 500)
  }
}
