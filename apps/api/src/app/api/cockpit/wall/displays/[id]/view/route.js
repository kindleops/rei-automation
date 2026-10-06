/**
 * POST /api/cockpit/wall/displays/:id/view — "Send to Command Wall" (§37, §38).
 * { preset?, market?, campaign_id?, hold_minutes? } changes what the TV SHOWS,
 * for a while, and nothing else. Designed so a phone client can call it later.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { parseJsonSafe } from '../../../../../_shared.js'
import { sendViewCommand } from '@/lib/domain/command-wall/wall-auth.js'
import { wallStore } from '@/lib/domain/command-wall/wall-store.js'
import { wallError, operatorIdFrom } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await parseJsonSafe(request, {})
    const out = await sendViewCommand(wallStore(), params.id, body, { operatorId: operatorIdFrom(request) })
    return NextResponse.json({ ok: true, ...out }, { headers: { ...corsHeaders(request), 'Cache-Control': 'no-store' } })
  } catch (error) {
    return wallError(error)
  }
}
