/**
 * HOME INSTRUMENTS — narrow at-a-glance reads for the Deal Intelligence,
 * Comps, Buyer Match, Entity Graph and Queue widgets. Read-only; see
 * lib/domain/home/home-instruments-service.js.
 */
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { createHomeInstrumentsRoutes } from '@/lib/domain/home/home-instruments-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createHomeInstrumentsRoutes({ authorize: ensureDashboardReadAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
