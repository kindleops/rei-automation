/**
 * ANALYTICS GOALS · progress — each goal's period-to-date from the Lab engine
 * (the same definitions Analytics shows). Read-only.
 */
import { corsHeaders, ensureDashboardReadAuth } from '../../../_shared.js'
import { createGoalService } from '@/lib/domain/analytics/goals/goal-service.js'
import { createGoalRoutes } from '@/lib/domain/analytics/goals/goal-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createGoalRoutes({ service: createGoalService(), authorize: ensureDashboardReadAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.PROGRESS
