/**
 * R2 persistent runtime tick — POST /api/internal/agent/runtime/tick (cron auth).
 * Invoked by the Worker's "*\/1 * * * *" lane, job agent_runtime_tick, only when
 * CRON_AGENT_RUNTIME_ENABLED="true" (default OFF). Inert unless
 * AGENT_RUNTIME_ENABLED=1 + AGENT_ENABLED (container) and
 * agent.runtime_limits.runtime_enabled (DB). Reaps expired leases, enqueues due
 * schedules, runs ≤ tick_max_jobs registered handlers (R2: ops.health_check only)
 * inside a hard wall-clock budget (≤ 45 s), heartbeats. Sends nothing; writes only
 * schema agent.
 */
import { NextResponse } from 'next/server.js'

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { runScheduledRuntimeTick, DEFAULT_RUNTIME_HANDLERS } from '@/lib/agent/runtime/runtime-service.js'
import { conversationRuntimeHandlers } from '@/lib/ai/conversation-decide-handler.js'
import { missionRuntimeHandlers } from '@/lib/ai/mission-runtime-wiring.js'
import { operationsRuntimeHandlers } from '@/lib/ai/operations-runtime-wiring.js'
import { followupRuntimeHandlers } from '@/lib/ai/followup-runtime-wiring.js'
import { actionGatewayExecutionHandlers } from '@/lib/ai/action-gateway-execution.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = child({ module: 'api.internal.agent.runtime.tick' })
export const ROUTE_NAME = 'internal/agent/runtime/tick'

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  try {
    // conversation.decide (R1/R2 shadow, no send) is registered only when AI_CONVERSATION_SHADOW_ENABLED=true;
    // the 8.5.18 persistent missions (mission.research / mission.supervisor / acquisition.discovery /
    // conversation.review_digest — no send) only when AGENT_MISSIONS_ENABLED=1; the 8.5.20 C operations
    // jobs (recovery.sweep / inbox.action_center / pipeline.reconcile / ops.supervisor — no send) only when
    // AGENT_OPERATIONS_ENABLED=1; the 8.5.21 follow-up execution pipeline (followup.execution_sweep /
    // followup.dispatch / followup.reconcile — writes follow-up send_queue rows) only when
    // LC_FOLLOWUP_EXECUTION=1, and it does nothing until system_control.followup_execution_mode is set; the Action
    // Gateway executor kind (action_gateway.execute — the canonical send paths) only when LC_ACTION_GATEWAY_EXECUTION=1
    const result = await runScheduledRuntimeTick({ handlers: { ...DEFAULT_RUNTIME_HANDLERS, ...conversationRuntimeHandlers(), ...missionRuntimeHandlers(), ...operationsRuntimeHandlers(), ...followupRuntimeHandlers(), ...actionGatewayExecutionHandlers() } })
    if (result.summary) {
      const s = result.summary
      logger.info('agent.runtime.tick', { blocked: s.blocked, claimed: s.claimed, jobs: s.jobs.map((j) => `${j.kind}:${j.outcome}`), errors: s.errors.map((e) => `${e.phase}:${e.code}`), elapsed_ms: s.elapsed_ms })
    }
    return NextResponse.json({ route: ROUTE_NAME, ...result })
  } catch (error) {
    logger.error('agent.runtime.tick_failed', { error: error?.code || error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'agent_runtime_tick_failed' }, { status: 500 })
  }
}
