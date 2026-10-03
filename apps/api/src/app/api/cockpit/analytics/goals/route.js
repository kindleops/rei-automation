/**
 * ANALYTICS GOALS — the operator's targets on canonical Lab metrics.
 * Operator-private, revision-checked; see lib/domain/analytics/goals/*.
 */
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { createGoalService } from '@/lib/domain/analytics/goals/goal-service.js'
import { createGoalRoutes } from '@/lib/domain/analytics/goals/goal-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const routes = createGoalRoutes({ service: createGoalService(), authorize: ensureMutationAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const GET = routes.GET
export const PUT = routes.PUT
export const DELETE = routes.DELETE
