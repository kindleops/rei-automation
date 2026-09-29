/** Validate + describe + diff + simulate a draft graph. Pure: no writes, capability.simulate only. */
import { validateAndSimulate } from '@/lib/domain/workflow-studio/orchestrator/studio-service.js'
import { optionsResponse, requireAuth, withCors } from '../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function POST(request) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  const result = validateAndSimulate({ graph: body.graph, blueprint: body.blueprint || null, params: body.params || {}, scenario: body.scenario, previous: body.previous })
  return withCors(request, result, result.ok ? 200 : 400)
}
