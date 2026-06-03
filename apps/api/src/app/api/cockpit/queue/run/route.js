import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { runSendQueue } from '@/lib/domain/queue/run-send-queue.js'
import { getSystemValue } from '@/lib/system-control.js'
import {
  blockedRuntimeBrakeResult,
  blockedSafetyResult,
  clean,
  evaluateQueueSendRuntimeBrakes,
  normalizeSafetyInput,
  validateLiveLimitedRails,
} from '@/lib/domain/queue/queue-control-safety.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function asNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => ({}))
  const configuredMode = clean(await getSystemValue('queue_processor_mode') || 'paused').toLowerCase()
  const safetySettings = {
    queue_processor_mode: configuredMode,
    campaign_mode: await getSystemValue('campaign_mode'),
    queue_hard_cap: await getSystemValue('queue_hard_cap'),
    queue_max_batch_size: await getSystemValue('queue_max_batch_size'),
    queue_daily_send_cap: await getSystemValue('queue_daily_send_cap'),
    queue_market_cap: await getSystemValue('queue_market_cap'),
    queue_per_number_cap: await getSystemValue('queue_per_number_cap'),
    queue_market_throttle: await getSystemValue('queue_market_throttle'),
    queue_sender_throttle: await getSystemValue('queue_sender_throttle'),
    queue_all_market_ack: await getSystemValue('queue_all_market_ack'),
    queue_emergency_stop_at: await getSystemValue('queue_emergency_stop_at'),
  }

  const requestedMode = clean(body.mode || configuredMode || 'safe').toLowerCase()
  const runLimit = Math.max(1, Math.min(250, asNumber(body.limit ?? body.caps?.queue_run_limit, asNumber(await getSystemValue('queue_run_limit'), 50))))
  const safety = normalizeSafetyInput({ ...body, limit: runLimit }, safetySettings)
  const runtimeBrake = evaluateQueueSendRuntimeBrakes(safetySettings, {
    action: 'queue-run',
    failClosed: true,
  })
  if (!runtimeBrake.ok) {
    return NextResponse.json(blockedRuntimeBrakeResult(runtimeBrake, 'queue-run'), { status: runtimeBrake.status })
  }
  const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true })
  if (!validation.ok) {
    return NextResponse.json(blockedSafetyResult(validation, 'queue-run'), { status: validation.status })
  }

  const result = await runSendQueue({ limit: Math.min(runLimit, validation.effective_limit), dry_run: false }, {})

  return NextResponse.json({
    ok: result?.ok !== false,
    action: 'queue-run',
    diagnostics: {
      configured_mode: configuredMode,
      requested_mode: requestedMode,
      run_limit: runLimit,
      result,
      summary: {
        sent: Number(result?.sent_count || 0),
        failed: Number(result?.failed_count || 0),
        blocked: Number(result?.blocked_count || 0),
      },
    },
  }, { status: result?.ok === false ? 500 : 200 })
}
