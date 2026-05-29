import { NextResponse } from 'next/server.js'
import { parseJsonSafe, ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getLiveInbox } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TIMEOUT_MS = 8000

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const params = Object.fromEntries(searchParams.entries())

    let data
    try {
      data = await Promise.race([
        getLiveInbox(params),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error('live_inbox_timeout'), { isTimeout: true })),
            TIMEOUT_MS
          )
        ),
      ])
    } catch (innerErr) {
      if (innerErr.isTimeout) {
        // Return 200 with degraded flag so frontend can skip cache invalidation
        return NextResponse.json(
          {
            ok: true,
            degraded: true,
            error: 'live_inbox_timeout',
            threads: [],
            messages: [],
            counts: {},
            mapPins: [],
            pagination: { limit: 0, returned: 0, has_more: false, next_cursor: null },
          },
          { status: 200, headers: cors }
        )
      }
      throw innerErr
    }

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
