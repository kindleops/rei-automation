/** Workflow Studio catalog — typed capabilities (with honest availability), triggers, conditions, bounded workflows. */
import { getStudioCatalog } from '@/lib/domain/workflow-studio/orchestrator/studio-service.js'
import { optionsResponse, requireAuth, withCors } from '../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  return withCors(request, getStudioCatalog())
}
