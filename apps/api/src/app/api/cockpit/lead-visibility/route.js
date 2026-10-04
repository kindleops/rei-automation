/**
 * LEAD VISIBILITY — the one archive authority for Inbox threads and Pipeline
 * deals (shared visibility overlay). Gated by system_control
 * `lead_visibility_sync_enabled` + a schema probe; see
 * lib/domain/lead-visibility/lead-visibility-service.js.
 */
import { corsHeaders, ensureMutationAuth } from '../_shared.js'
import { getLeadVisibilityGate } from '@/lib/domain/lead-visibility/lead-visibility-gate.js'
import { createDefaultLeadVisibilityPorts, createLeadVisibilityService } from '@/lib/domain/lead-visibility/lead-visibility-service.js'
import { createLeadVisibilityRoutes } from '@/lib/domain/lead-visibility/lead-visibility-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

let service = null
const getService = async () => {
  if (!service) service = createLeadVisibilityService(await createDefaultLeadVisibilityPorts())
  return service
}

const routes = createLeadVisibilityRoutes({ getGate: getLeadVisibilityGate, getService, authorize: ensureMutationAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
export const POST = routes.POST
