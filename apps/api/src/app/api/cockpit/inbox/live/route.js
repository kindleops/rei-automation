import { NextResponse } from 'next/server.js'
import { parseJsonSafe, ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getLiveInbox } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const data = await getLiveInbox(Object.fromEntries(searchParams.entries()))
    return NextResponse.json({ ok: true, ...data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'live_inbox_failed', message: error.message },
      { status: 500, headers: cors }
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}
