/**
 * Settings → Displays (operator only; rides the Worker session + allowlist gate).
 *
 *   GET  /api/cockpit/wall/displays            the registry (§7, §72)
 *   POST /api/cockpit/wall/displays            { code, name, preset?, theme?, privacy_mode?, display_id? }
 *                                              claim a TV's pairing code (§6)
 *
 * Writes only the PROPOSED command_wall_* tables (503 until applied). Never an
 * operational write: no sends, campaigns, routing, queue or Signal changes.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, ensureDashboardReadAuth } from '../../_shared.js'
import { parseJsonSafe } from '../../../_shared.js'
import { claimPairing, publicDisplay } from '@/lib/domain/command-wall/wall-auth.js'
import { wallStore } from '@/lib/domain/command-wall/wall-store.js'
import { wallRateLimiter } from '@/lib/domain/command-wall/wall-rate-limit.js'
import { wallError, operatorIdFrom } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const withCors = (request, res) => { for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v); return res }

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  try {
    const rows = await wallStore().listDisplays()
    const t = Date.now()
    return withCors(request, NextResponse.json({ ok: true, displays: rows.map((r) => publicDisplay(r, t)), store: wallStore().kind }, { headers: { 'Cache-Control': 'no-store' } }))
  } catch (error) {
    return withCors(request, wallError(error))
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await parseJsonSafe(request, {})
    const out = await claimPairing(wallStore(), {
      code: body.code,
      operatorId: operatorIdFrom(request),
      name: body.name,
      config: { preset: body.preset, theme: body.theme, privacy_mode: body.privacy_mode, oled_protection: body.oled_protection, ...(body.config && typeof body.config === 'object' ? body.config : {}) },
      displayId: body.display_id || null,
    }, { limiter: wallRateLimiter() })
    return withCors(request, NextResponse.json({ ok: true, ...out }, { headers: { 'Cache-Control': 'no-store' } }))
  } catch (error) {
    return withCors(request, wallError(error))
  }
}
