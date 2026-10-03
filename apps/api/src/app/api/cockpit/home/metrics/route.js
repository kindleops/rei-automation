/**
 * HOME METRICS — the period figures Home widgets show, with Analytics' exact
 * counting rules but without the analytics_performance bundle.
 * Read-only; see lib/domain/home/home-metrics-service.js.
 */
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { createHomeMetricsRoutes } from '@/lib/domain/home/home-metrics-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createHomeMetricsRoutes({ authorize: ensureDashboardReadAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
