/** Run inspector: the path this run actually took, why, timeline, entity links. */
import { getWorkflowRun } from '@/lib/domain/workflow-studio/observatory-service.js'
import { optionsResponse, requireAuth, withCors } from '../../../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, ctx) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  const { key, run_id } = await ctx.params
  try {
    const r = await getWorkflowRun(key, run_id)
    return withCors(request, r, r.ok ? 200 : r.status || 500)
  } catch (error) {
    return withCors(request, { ok: false, error: 'workflow_run_failed', message: error?.message || String(error) }, 500)
  }
}
