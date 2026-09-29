/** One workflow: topology, outline, description, live node aggregates, recent runs. */
import { getWorkflowDetail } from '@/lib/domain/workflow-studio/observatory-service.js'
import { optionsResponse, params, requireAuth, withCors } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, ctx) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  const { key } = await ctx.params
  const p = params(request)
  try {
    const r = await getWorkflowDetail(key, { status: p.status || null, limit: p.limit, cursor: p.cursor || null })
    return withCors(request, r, r.ok ? 200 : r.status || 500)
  } catch (error) {
    return withCors(request, { ok: false, error: 'workflow_detail_failed', message: error?.message || String(error) }, 500)
  }
}
