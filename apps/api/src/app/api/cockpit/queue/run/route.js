import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { runSendQueue } from '@/lib/domain/queue/run-send-queue.js'
import { getSystemValue } from '@/lib/system-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function clean(value) {
  return String(value ?? '').trim()
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => ({}))
  const configuredMode = clean(await getSystemValue('queue_processor_mode') || 'paused').toLowerCase()

  const requestedMode = clean(body.mode || configuredMode || 'safe').toLowerCase()
  const runLimit = Math.max(1, Math.min(250, asNumber(body.limit ?? body.caps?.queue_run_limit, asNumber(await getSystemValue('queue_run_limit'), 50))))
  const result = await runSendQueue({ limit: runLimit, dry_run: false }, {})

  return NextResponse.json({
    ok: result?.ok !== false,
    action: 'queue-run',
    diagnostics: {
      configured_mode: configuredMode,
      requested_mode: requestedMode,
      run_limit: runLimit,
      result,
      summary: {
        sent: Number(result?.sent_count || 0),
        failed: Number(result?.failed_count || 0),
        blocked: Number(result?.blocked_count || 0),
      },
    },
  }, { status: result?.ok === false ? 500 : 200 })
}
