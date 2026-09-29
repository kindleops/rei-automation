/**
 * Workflow orchestrator tick — POST /api/internal/workflow-studio/orchestrator/tick.
 * Ingests workflow_events past a durable cursor, starts runs of ARMED
 * workflows, resolves waits, steps due runs under a lease, writes a heartbeat.
 * Does nothing unless system_control.workflow_orchestrator_enabled='true' AND
 * WORKFLOW_ORCHESTRATOR_ENABLED='true'. NOT on the Cloudflare schedule yet:
 * registering it is an operator commissioning act (see cloudflare-cron-scope).
 */
import { NextResponse } from 'next/server.js'

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { supabase } from '@/lib/supabase/client.js'
import { tickOrchestrator } from '@/lib/domain/workflow-studio/orchestrator/runtime.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = child({ module: 'api.internal.workflow_studio.orchestrator' })
export const ROUTE_NAME = 'internal/workflow-studio/orchestrator/tick'

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  try {
    const result = await tickOrchestrator({ supabase })
    if (result.claimed || result.ingest?.started || result.last_error) logger.info('workflow_orchestrator.tick', { claimed: result.claimed, started: result.ingest?.started, outcomes: result.outcomes, error: result.last_error })
    return NextResponse.json({ ok: true, route: ROUTE_NAME, ...result })
  } catch (error) {
    logger.error('workflow_orchestrator.failed', { error: error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'workflow_orchestrator_failed', message: error?.message || 'failed' }, { status: 500 })
  }
}
