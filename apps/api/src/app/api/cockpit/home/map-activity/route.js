/**
 * HOME MAP ACTIVITY — one lens, one period, by ZIP, for the Home Map widget.
 * Read-only; see lib/domain/home/home-map-activity-service.js.
 */
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { createHomeMapActivityRoutes } from '@/lib/domain/home/home-map-activity-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createHomeMapActivityRoutes({ authorize: ensureDashboardReadAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
