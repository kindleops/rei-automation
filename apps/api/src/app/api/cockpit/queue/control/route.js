import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTROL_KEYS = [
  'queue_processor_mode',
  'queue_daily_send_cap',
  'queue_run_limit',
  'queue_spacing_seconds',
  'queue_contact_window_start',
  'queue_contact_window_end',
  'queue_auto_pause_failure_rate',
  'queue_auto_pause_optout_rate',
  'queue_market_throttle',
  'queue_sender_throttle',
  'queue_auto_enqueue_enabled',
  'queue_auto_send_enabled',
]

const DEFAULTS = {
  queue_processor_mode: 'paused',
  queue_daily_send_cap: '500',
  queue_run_limit: '50',
  queue_spacing_seconds: '45',
  queue_contact_window_start: '08:00',
  queue_contact_window_end: '21:00',
  queue_auto_pause_failure_rate: '12',
  queue_auto_pause_optout_rate: '5',
  queue_market_throttle: '250',
  queue_sender_throttle: '150',
  queue_auto_enqueue_enabled: 'true',
  queue_auto_send_enabled: 'false',
}

function clean(value) {
  return String(value ?? '').trim()
}

function parseBody(body = {}) {
  const patch = {}
  for (const key of CONTROL_KEYS) {
    if (body[key] === undefined) continue
    patch[key] = clean(body[key])
  }
  if (patch.queue_processor_mode) {
    const mode = clean(patch.queue_processor_mode).toLowerCase()
    patch.queue_processor_mode = ['off', 'safe', 'live', 'paused', 'assisted', 'automatic'].includes(mode) ? mode : 'paused'
  }
  return patch
}

async function loadSettings() {
  const values = {}
  for (const key of CONTROL_KEYS) {
    const value = await getSystemValue(key)
    values[key] = value ?? DEFAULTS[key] ?? null
  }
  return values
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const values = await loadSettings()
  return NextResponse.json({ ok: true, action: 'queue-control:get', diagnostics: values }, { status: 200 })
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  
  if (body.action === 'safe_batch') {
    const { runSendQueue } = await import('@/lib/domain/queue/run-send-queue.js')
    const limit = Math.max(1, Math.min(25, Number(body.limit) || 10))
    const result = await runSendQueue({ limit, dry_run: false }, {})
    return NextResponse.json({
      ok: result?.ok !== false,
      action: 'safe_batch',
      rows_sent: Number(result?.sent_count || 0),
      block_reasons: {
        failed: Number(result?.failed_count || 0),
        blocked: Number(result?.blocked_count || 0)
      }
    }, { status: result?.ok === false ? 500 : 200 })
  }

  if (body.action === 'run_due_queue') {
    const { runSendQueue } = await import('@/lib/domain/queue/run-send-queue.js')
    const limit = Math.max(1, Math.min(250, Number(body.limit) || Number(body.caps?.queue_run_limit) || 50))
    const result = await runSendQueue({ limit, dry_run: false }, {})
    return NextResponse.json({
      ok: result?.ok !== false,
      action: 'run_due_queue',
      rows_sent: Number(result?.sent_count || 0),
      block_reasons: {
        failed: Number(result?.failed_count || 0),
        blocked: Number(result?.blocked_count || 0)
      }
    }, { status: result?.ok === false ? 500 : 200 })
  }

  const patch = parseBody(body)
  const result = await setSystemValues(patch)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 })
  }
  const values = await loadSettings()
  return NextResponse.json({ ok: true, action: 'queue-control:set', diagnostics: values }, { status: 200 })
}

