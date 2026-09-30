/**
 * Camera network refresh — POST /api/internal/map/cameras/refresh.
 * Pulls each enabled provider's inventory when due (per provider cadence),
 * under a lease, with bounded backoff; writes a heartbeat + ledger row.
 * Metadata only — never imagery. Does nothing unless
 * CAMERA_NETWORK_REFRESH_ENABLED='true' (explicit job enablement), and is
 * only reachable with the scheduled-job credential.
 */
import { NextResponse } from 'next/server.js'

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { refreshCameraProviders } from '@/lib/domain/map/cameras/camera-network-service.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = child({ module: 'api.internal.map.cameras.refresh' })
export const ROUTE_NAME = 'internal/map/cameras/refresh'

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  if (String(process.env.CAMERA_NETWORK_REFRESH_ENABLED || '').trim() !== 'true') {
    return NextResponse.json({ ok: true, route: ROUTE_NAME, skipped: 'camera_network_refresh_disabled' })
  }
  try {
    const result = await refreshCameraProviders({ owner: `cron:${Date.now()}` })
    const failed = (result.results || []).filter((r) => r.ok === false)
    if (failed.length) logger.warn('camera_refresh.provider_failed', { failed: failed.map((f) => ({ provider: f.provider_id, error: f.error })) })
    return NextResponse.json({ ...result, route: ROUTE_NAME })
  } catch (error) {
    logger.error('camera_refresh.failed', { error: error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'camera_refresh_failed' }, { status: 500 })
  }
}
