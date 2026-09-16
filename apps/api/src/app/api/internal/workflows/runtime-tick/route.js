import { NextResponse } from 'next/server.js'
import { child } from '@/lib/logging/logger.js'
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js'
import { runWorkflowRuntimeTick } from '@/lib/domain/workflow-v2/workflow-runtime-worker.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = child({ module: 'api.internal.workflows.runtime-tick' })

/**
 * Production cadence: every 5 minutes via apps/api/vercel.json cron.
 *
 * THE GAP THIS CLOSES. `/api/workflows/process` carried the comment "No cron
 * integration yet; caller is responsible for scheduling", and nothing ever
 * called it — `workflow_scheduled_tasks` had 0 rows and `findDueTasks` /
 * `completeTask` had zero callers anywhere in the codebase. Separately, the
 * canonical acquisition bus (`automation_events`) was never connected to the
 * workflow event inbox, so no published workflow could be entered at all.
 *
 * One tick does both: bridge canonical events, then run whatever became due.
 * Deliberately not a new timer service — this is a plain route on the same cron
 * list every other recurring worker uses.
 *
 * SAFETY. Nothing here arms a workflow. `matchDefinitions` still requires
 * `status = 'active'`, and the 14 real workflows are `published`, so a canonical
 * event reaches the matcher and the matcher selects nothing. Workflow-generated
 * communication remains `no_send` and is refused by the queue processor.
 * `workflow_event_bridge_mode = off` is the operator kill switch.
 */
export async function GET(request) {
  const auth = requireInternalSecret(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 })
  }

  logger.info('workflow_runtime_tick.started')
  try {
    const result = await runWorkflowRuntimeTick()
    logger.info('workflow_runtime_tick.completed', {
      bridged: result.bridge?.bridged ?? 0,
      duplicates: result.bridge?.duplicates ?? 0,
      matched: result.bridge?.matched ?? 0,
      tasks_processed: result.scheduled?.processed ?? 0,
      tasks_advanced: result.scheduled?.advanced ?? 0,
    })
    return NextResponse.json({
      ok: true,
      route: 'internal/workflows/runtime-tick',
      cadence: '*/5 * * * *',
      ...result,
    })
  } catch (error) {
    const message = error?.message || String(error)
    logger.error('workflow_runtime_tick.failed', { error: message })
    return NextResponse.json(
      { ok: false, error: 'workflow_runtime_tick_failed', message },
      { status: 500 },
    )
  }
}

export async function POST(request) {
  return GET(request)
}
