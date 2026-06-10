import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { capReconcileBatch, getRolloutControls, resolveScopedId } from '@/lib/config/rollout-controls.js'
import { child } from '@/lib/logging/logger.js'
import { runQueueReconcileRunner } from '@/lib/workers/queue-reconcile-runner.js'
import { reconcileSupabaseDeliveryStatuses } from '@/lib/domain/events/normalize-delivery-status.js'
import { reconcileCanonicalQueueLifecycle } from '@/lib/supabase/sms-engine.js'
import { buildDisabledResponse, getSystemFlag } from '@/lib/system-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = child({ module: 'api.cockpit.queue.reconcile' })

function asNumber(value, fallback = null) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const reconcile_enabled = await getSystemFlag('reconcile_enabled')
  if (!reconcile_enabled) {
    return NextResponse.json(buildDisabledResponse('reconcile_enabled', 'cockpit-queue-reconcile'), { status: 423 })
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

  const limit = capReconcileBatch(asNumber(body?.limit, 50), 50)
  const stale_after_minutes = asNumber(body?.stale_after_minutes, 20)

  logger.info('cockpit_queue_reconcile.requested', {
    limit,
    stale_after_minutes,
    master_owner_id: master_owner_scope.effective_id,
  })

  const result = await runQueueReconcileRunner({
    limit,
    stale_after_minutes,
    master_owner_id: master_owner_scope.effective_id,
  })

  const supabase_delivery_reconcile = await reconcileSupabaseDeliveryStatuses({ limit }).catch((error) => ({
    ok: false,
    total_normalized: 0,
    error: error?.message || 'supabase_delivery_reconcile_failed',
  }))

  const canonical_lifecycle_reconcile = await reconcileCanonicalQueueLifecycle({
    limit,
    stale_minutes: stale_after_minutes,
    lease_minutes: 10,
    dry_run: false,
  }).catch((error) => ({
    ok: false,
    reconciled_rows: 0,
    error: error?.message || 'canonical_lifecycle_reconcile_failed',
  }))

  const reconciled =
    Number(supabase_delivery_reconcile?.total_normalized || 0) +
    Number(canonical_lifecycle_reconcile?.reconciled_rows || 0)

  return NextResponse.json({
    ok: result?.ok !== false,
    action: 'reconcile_delivery',
    route: 'cockpit/queue/reconcile',
    reconciled,
    result,
    supabase_delivery_reconcile,
    canonical_lifecycle_reconcile,
  }, { status: result?.ok === false ? 400 : 200 })
}
