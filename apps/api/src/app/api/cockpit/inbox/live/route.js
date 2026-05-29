import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getLiveInbox } from '@/lib/domain/inbox/live-inbox-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TIMEOUT_MS_BY_MODE = {
  initial_boot: 20_000,
  manual_bucket_switch: 15_000,
  auto_refresh: 10_000,
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const params = Object.fromEntries(searchParams.entries())

    const timeoutMode = ['initial_boot', 'manual_bucket_switch', 'auto_refresh'].includes(params.timeout_mode)
      ? params.timeout_mode
      : 'manual_bucket_switch'
    const timeoutMs = TIMEOUT_MS_BY_MODE[timeoutMode]
    const requestedFilter = params.filter || params.bucket || 'all'
    const requestedLimit = Number(params.limit || 100)
    const useInitialBootSafeSelect =
      timeoutMode === 'initial_boot' &&
      (requestedFilter === 'all' || requestedFilter === 'all_messages') &&
      Number.isFinite(requestedLimit) &&
      requestedLimit <= 100

    console.log('[INBOX_LIVE_TIMEOUT_MODE]', {
      timeoutMode,
      timeoutMs,
      filter: requestedFilter,
      limit: requestedLimit,
      selectMode: useInitialBootSafeSelect ? 'initial_boot_safe' : 'default',
    })

    let data
    try {
      data = await Promise.race([
        getLiveInbox(
          params,
          useInitialBootSafeSelect ? { selectMode: 'initial_boot_safe' } : undefined,
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error('live_inbox_timeout'), { isTimeout: true })),
            timeoutMs
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
            dataMode: 'timeout_preserved',
            timeoutMode,
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
