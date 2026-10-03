/**
 * RESEARCH SOURCES — Browser 1.0 Save Source (observational pointers only).
 * Operator-private attribution, audited attach/remove; see
 * lib/domain/research/research-sources-service.js.
 */
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { createResearchSourcesService } from '@/lib/domain/research/research-sources-service.js'
import { createResearchSourcesRoutes } from '@/lib/domain/research/research-sources-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createResearchSourcesRoutes({ service: createResearchSourcesService(), authorize: ensureMutationAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
export const POST = routes.POST
export const DELETE = routes.DELETE
