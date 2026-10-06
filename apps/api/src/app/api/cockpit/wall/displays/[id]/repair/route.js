/** POST /api/cockpit/wall/displays/:id/repair — "Regenerate pairing": kill the credential; the TV shows a new code. */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { requireRepair } from '@/lib/domain/command-wall/wall-auth.js'
import { wallStore } from '@/lib/domain/command-wall/wall-store.js'
import { wallError, operatorIdFrom, wallAuthenticator } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const out = await requireRepair(wallStore(), params.id, { operatorId: operatorIdFrom(request), authenticator: wallAuthenticator() })
    return NextResponse.json({ ok: true, ...out }, { headers: { ...corsHeaders(request), 'Cache-Control': 'no-store' } })
  } catch (error) {
    return wallError(error)
  }
}
