/**
 * Orchestrator operator actions: publish | arm | pause | archive | draft |
 * approve | reject | resume | cancel. The actor is the Worker-verified operator
 * (x-ops-user-id); a body "actor" is ignored.
 */
import { applyOrchestratorAction } from '@/lib/domain/workflow-studio/orchestrator/studio-service.js'
import { optionsResponse, requireAuth, withCors } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function POST(request) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  const { action, actor: _ignored, ...fields } = body
  try {
    const result = await applyOrchestratorAction(String(action || ''), fields, { actor: request.headers.get('x-ops-user-id') || '' })
    return withCors(request, result, result.ok ? 200 : result.status || 409)
  } catch (error) {
    return withCors(request, { ok: false, error: 'orchestrator_action_failed', message: error?.message || String(error) }, 500)
  }
}
