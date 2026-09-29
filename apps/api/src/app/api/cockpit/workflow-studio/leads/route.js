/** Leads in flight across every workflow runtime (7d). */
import { getStudioLeads } from '@/lib/domain/workflow-studio/studio-home-service.js'
import { optionsResponse, params, requireAuth, withCors } from '../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  try {
    const result = await getStudioLeads()
    return withCors(request, result, result.ok === false ? result.status || 500 : 200)
  } catch (error) {
    return withCors(request, { ok: false, error: 'studio_leads_failed', message: error?.message || String(error) }, 500)
  }
}
