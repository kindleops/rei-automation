import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { hasSupabaseConfig } from '@/lib/supabase/client.js'
import { buildWarRoom } from '@/lib/domain/metrics/war-room-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  if (!hasSupabaseConfig()) {
    return NextResponse.json(
      { ok: false, degraded: true, error: 'supabase_not_configured', message: 'Supabase service role not configured for war-room metrics.' },
      { status: 200, headers: cors },
    )
  }

  const { searchParams } = new URL(request.url)
  const params = {
    window: searchParams.get('window') || '7d',
    channel: searchParams.get('channel') || 'all',
    state: searchParams.get('state') || 'all',
    market: searchParams.get('market') || 'all',
    agent: searchParams.get('agent') || 'all',
  }
  // Treat the literal "all" sentinel as "no filter".
  for (const k of ['state', 'market', 'agent']) {
    if (String(params[k]).toLowerCase() === 'all') params[k] = ''
  }

  try {
    const payload = await buildWarRoom(params)
    return NextResponse.json({ ok: true, degraded: false, ...payload }, { status: 200, headers: cors })
  } catch (err) {
    console.error('[war-room] build failure', err)
    return NextResponse.json(
      { ok: false, degraded: true, error: 'WAR_ROOM_BUILD_FAILED', message: String(err?.message ?? err) },
      { status: 200, headers: cors },
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}
