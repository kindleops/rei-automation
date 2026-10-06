/**
 *   GET    /api/cockpit/wall/displays/:id   one display + its audit trail (§62)
 *   PATCH  /api/cockpit/wall/displays/:id   view configuration only (wall-config validateConfigPatch)
 *   DELETE /api/cockpit/wall/displays/:id   revoke — the credential dies immediately
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, ensureDashboardReadAuth } from '../../../_shared.js'
import { parseJsonSafe } from '../../../../_shared.js'
import { publicDisplay, revokeDisplay, updateDisplayConfig, WallAuthError } from '@/lib/domain/command-wall/wall-auth.js'
import { wallStore } from '@/lib/domain/command-wall/wall-store.js'
import { wallError, operatorIdFrom, wallAuthenticator } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ok = (request, body) => { const res = NextResponse.json({ ok: true, ...body }, { headers: { 'Cache-Control': 'no-store' } }); for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v); return res }
const fail = (request, error) => { const res = wallError(error); for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v); return res }

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  try {
    const row = await wallStore().getDisplay(params.id)
    if (!row) throw new WallAuthError(404, 'display_not_found')
    const audit = await wallStore().listAudit(params.id, 40)
    return ok(request, { display: publicDisplay(row), audit })
  } catch (error) {
    return fail(request, error)
  }
}

export async function PATCH(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await parseJsonSafe(request, {})
    return ok(request, await updateDisplayConfig(wallStore(), params.id, body, { operatorId: operatorIdFrom(request) }))
  } catch (error) {
    return fail(request, error)
  }
}

export async function DELETE(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    return ok(request, await revokeDisplay(wallStore(), params.id, { operatorId: operatorIdFrom(request), authenticator: wallAuthenticator() }))
  } catch (error) {
    return fail(request, error)
  }
}
