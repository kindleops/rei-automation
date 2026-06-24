import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { degradedLiveResponse } from '@/lib/domain/inbox/degraded-read-responses.js'
import { getLiveInbox } from '@/lib/domain/inbox/live-inbox-service.js'
import { createRequestTimer } from '@/lib/cockpit/server-timing.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_GRACE_PERIOD = 500;
const TIMEOUT_MS_BY_MODE = {
  initial_boot: 5_000 - BACKEND_GRACE_PERIOD,
  manual_bucket_switch: 5_000 - BACKEND_GRACE_PERIOD,
  auto_refresh: 5_000 - BACKEND_GRACE_PERIOD,
}
const INITIAL_BOOT_DEFAULT_LIMIT = 25

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const timer = createRequestTimer('inbox-live')
    const { searchParams } = new URL(request.url)
    const params = Object.fromEntries(searchParams.entries())
    timer.mark('auth_config')

    const timeoutMode = ['initial_boot', 'manual_bucket_switch', 'auto_refresh'].includes(params.timeout_mode)
      ? params.timeout_mode
      : 'manual_bucket_switch'
    const timeoutMs = TIMEOUT_MS_BY_MODE[timeoutMode]
    const requestedFilter = params.filter || params.bucket || 'all'
    const requestedLimit = Number(params.limit || (timeoutMode === 'initial_boot' ? INITIAL_BOOT_DEFAULT_LIMIT : 100))
    if (!params.limit && timeoutMode === 'initial_boot') {
      params.limit = String(INITIAL_BOOT_DEFAULT_LIMIT)
    }

    console.log('[INBOX_LIVE_TIMEOUT_MODE]', {
      timeoutMode,
      timeoutMs,
      filter: requestedFilter,
      limit: requestedLimit,
      selectMode: 'canonical_row_contract',
    })

    let data
    try {
      data = await Promise.race([
        getLiveInbox(params),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error('live_inbox_timeout'), { isTimeout: true })),
            timeoutMs
          )
        ),
      ])
    } catch (innerErr) {
      if (innerErr.isTimeout) {
        return NextResponse.json(
          degradedLiveResponse({
            timeoutMode,
            error: 'live_inbox_timeout',
            reason: 'live_timeout_preserve_client_counts',
            dataMode: 'timeout_preserved',
            countsSource: 'timeout',
          }),
          { status: 200, headers: cors }
        )
      }
      throw innerErr
    }

    timer.mark('transformation')
    const timing = timer.summary({ sourceUsed: data?.source || data?.diagnostics?.source || null })
    return NextResponse.json(
      {
        ok: true,
        degraded: false,
        ...data,
        sourceUsed: data?.source || data?.diagnostics?.source || null,
        queryMs: data?.diagnostics?.queryMs ?? timing.totalMs,
        diagnostics: {
          ...(data?.diagnostics || {}),
          sourceUsed: data?.source || data?.diagnostics?.source || null,
          timing,
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    console.error('[INBOX_LIVE_DEGRADED_ERROR]', {
      message: error?.message || String(error),
      stack: error?.stack || null,
    })
    return NextResponse.json(
      degradedLiveResponse({
        timeoutMode: 'unknown',
        error: 'live_inbox_failed_degraded',
        reason: 'live_error_preserve_client_counts',
        dataMode: 'error_preserved',
        countsSource: 'error',
      }),
      { status: 200, headers: cors }
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}