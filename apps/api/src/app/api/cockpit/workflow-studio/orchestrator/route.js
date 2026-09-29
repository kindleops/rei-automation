/** Orchestrator state — workflows, live runs, pending approvals, heartbeat ("migration pending" when wf_* is absent). */
import { getOrchestratorState } from '@/lib/domain/workflow-studio/orchestrator/studio-service.js'
import { optionsResponse, requireAuth, withCors } from '../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  try {
    const state = await getOrchestratorState()
    return withCors(request, state, state.ok ? 200 : 500)
  } catch (error) {
    return withCors(request, { ok: false, error: 'orchestrator_read_failed', message: error?.message || String(error) }, 500)
  }
}
