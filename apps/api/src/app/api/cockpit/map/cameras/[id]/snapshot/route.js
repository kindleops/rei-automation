/**
 * GET /api/cockpit/map/cameras/:id/snapshot — the current still for ONE
 * camera, by canonical id only (there is no URL parameter: this is not an
 * image proxy). Allowed only where the provider's terms permit proxying;
 * held in memory for about one provider cadence, never stored. The capture
 * time travels with the image so the Map never shows an old frame as current.
 *
 * TxDOT (INTERNAL USE, pending a TxDOT data-sharing agreement): an on-demand
 * pass-through — fetched per request, never cached anywhere, rate-limited per
 * operator plus a global cap, and answered with Cache-Control: no-store.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../../../_shared.js'
import { fetchCameraSnapshot } from '@/lib/domain/map/cameras/camera-network-service.js'
import { operatorKeyFor } from '@/lib/domain/map/cameras/camera-snapshot-limits.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EXPOSE = 'X-Camera-Captured-At, X-Camera-Captured-Basis, X-Camera-Fetched-At, X-Camera-Cache'
const decodeId = (raw) => {
  const s = String(raw || '')
  if (!s.includes('%')) return s
  try { return decodeURIComponent(s) } catch { return s }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/** The handler, with its auth and snapshot source injectable (tests). */
export async function handleCameraSnapshotRequest(request, params, deps = {}) {
  const ensureAuth = deps.ensureAuth || ensureDashboardReadAuth
  const fetchSnapshot = deps.fetchSnapshot || fetchCameraSnapshot
  const auth = ensureAuth(request)
  if (!auth.ok) return auth.response
  const cors = corsHeaders(request)
  try {
    const got = await fetchSnapshot(decodeId(params?.id), { ...(deps.snapshotDeps || {}), operatorKey: operatorKeyFor(request) })
    if (!got.ok) {
      const headers = { ...cors, 'Cache-Control': 'no-store' }
      if (got.status === 429 && got.retry_after_sec) headers['Retry-After'] = String(got.retry_after_sec)
      return NextResponse.json({ ok: false, reason: got.reason }, { status: got.status || 502, headers })
    }
    return new Response(got.bytes, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': got.content_type,
        'Cache-Control': got.no_store ? 'no-store' : `private, max-age=${Math.max(5, Math.min(60, got.ttl_sec || 15))}`,
        ...(got.no_store ? { Pragma: 'no-cache', 'X-Camera-Use': 'internal' } : {}),
        'X-Camera-Captured-At': got.captured_at || '',
        'X-Camera-Captured-Basis': got.captured_basis || 'unknown',
        'X-Camera-Fetched-At': got.fetched_at || '',
        'X-Camera-Cache': got.from_cache ? 'hit' : 'miss',
        'Access-Control-Expose-Headers': EXPOSE,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return NextResponse.json({ ok: false, reason: 'snapshot_failed' }, { status: 500, headers: { ...cors, 'Cache-Control': 'no-store' } })
  }
}

export async function GET(request, { params }) {
  return handleCameraSnapshotRequest(request, params)
}
