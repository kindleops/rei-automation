/**
 * HOME LAYOUTS — the operator's saved Home command boards (Home 2.0).
 * Operator-private, revision-checked; see lib/domain/home/home-layout-service.js.
 */
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { createHomeLayoutService } from '@/lib/domain/home/home-layout-service.js'
import { createHomeLayoutRoutes } from '@/lib/domain/home/home-layout-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createHomeLayoutRoutes({ service: createHomeLayoutService(), authorize: ensureMutationAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
export const PUT = routes.PUT
export const DELETE = routes.DELETE
