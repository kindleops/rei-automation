/** One orchestrator run: path, timeline, waits. */
import { getStudioRun } from '@/lib/domain/workflow-studio/studio-home-service.js'
import { optionsResponse, params, requireAuth, withCors } from '../../../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request, { params: p }) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  try {
    const result = await (async () => { const q = await p; return getStudioRun(q.key, q.run_id) })()
    return withCors(request, result, result.ok === false ? result.status || 500 : 200)
  } catch (error) {
    return withCors(request, { ok: false, error: 'studio_run_failed', message: error?.message || String(error) }, 500)
  }
}
