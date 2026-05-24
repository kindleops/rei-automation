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
  queue_processor_mode: 'off',
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
    patch.queue_processor_mode = ['off', 'safe', 'live'].includes(mode) ? mode : 'off'
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
  return withCors(request, NextResponse.json({ ok: true, action: 'queue-control:get', diagnostics: values }, { status: 200 })
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  const patch = parseBody(body)
  const result = await setSystemValues(patch)
  if (!result.ok) {
    return withCors(request, NextResponse.json({ ok: false, error: 'queue_control_update_failed' }, { status: 500 }))
  }
  const values = await loadSettings()
  return withCors(request, NextResponse.json({ ok: true, action: 'queue-control:set', diagnostics: values }, { status: 200 }))
}


export async function OPTIONS(request) {
  return handleOptionsResponse(request));
}
