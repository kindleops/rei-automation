import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { capRetryBatch, getRolloutControls, resolveScopedId } from '@/lib/config/rollout-controls.js'
import { child } from '@/lib/logging/logger.js'
import { runRetryRunner } from '@/lib/workers/retry-runner.js'
import { buildDisabledResponse, getSystemFlag } from '@/lib/system-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = child({ module: 'api.cockpit.queue.retry_failed' })

function asNumber(value, fallback = null) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const retry_enabled = await getSystemFlag('retry_enabled')
  if (!retry_enabled) {
    return NextResponse.json(buildDisabledResponse('retry_enabled', 'cockpit-queue-retry-failed'), { status: 423 })
  }

  const body = await request.json().catch(() => ({}))
  const rollout = getRolloutControls()
  const master_owner_scope = resolveScopedId({
    requested_id: asNumber(body?.master_owner_id, null),
    safe_id: rollout.single_master_owner_id,
    resource: 'master_owner',
  })

  if (!master_owner_scope.ok) {
    return NextResponse.json({ ok: false, error: master_owner_scope.reason }, { status: 400 })
  }

  const limit = capRetryBatch(asNumber(body?.limit, 50), 50)
  const dry_run = asBoolean(body?.dry_run, false)

  logger.info('cockpit_queue_retry_failed.requested', {
    limit,
    dry_run,
    master_owner_id: master_owner_scope.effective_id,
  })

  const result = await runRetryRunner({
    limit,
    dry_run,
    master_owner_id: master_owner_scope.effective_id,
  })

  const summary = {
    resolved: Number(result?.retried_count || 0) + Number(result?.scheduled_count || 0),
    blocked: Number(result?.blocked_count || 0) + Number(result?.terminal_skipped_count || 0),
    failed: Number(result?.terminal_count || 0),
    skipped: Number(result?.skipped_count || 0),
  }

  return NextResponse.json({
    ok: result?.ok !== false,
    action: 'retry_failed',
    route: 'cockpit/queue/retry-failed',
    summary,
    result,
  }, { status: result?.ok === false ? 400 : 200 })
}
