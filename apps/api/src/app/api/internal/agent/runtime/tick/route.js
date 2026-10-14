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
    // conversation.decide (R1/R2 shadow, no send) is registered only when AI_CONVERSATION_SHADOW_ENABLED=true
    const result = await runScheduledRuntimeTick({ handlers: { ...DEFAULT_RUNTIME_HANDLERS, ...conversationRuntimeHandlers() } })
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
