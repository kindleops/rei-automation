import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { runSupabaseCandidateFeeder } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
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

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  const normalized = clean(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => ({}))
  const configuredMode = clean(await getSystemValue('queue_processor_mode') || 'paused').toLowerCase()

  const target_count = Math.max(1, Math.min(1000, asNumber(body.target_count, 100)))
  const scan_limit = Math.max(25, Math.min(5000, asNumber(body.scan_limit, 1000)))
  const per_pass_limit = Math.max(1, Math.min(250, asNumber(body.limit, Math.min(100, target_count))))
  const candidate_source = clean(body.candidate_source || 'v_sms_ready_contacts_expanded')
  const respect_contact_window = asBoolean(body.respect_contact_window, true)
  const mode = clean(body.mode || configuredMode || 'safe').toLowerCase()
  const identity_gate_mode = clean(body.identity_gate_mode || '')
  const allow_identity_unknown =
    body.allow_identity_unknown === undefined ? undefined : asBoolean(body.allow_identity_unknown, false)
  const allow_weak_identity_outbound =
    body.allow_weak_identity_outbound === undefined ? undefined : asBoolean(body.allow_weak_identity_outbound, false)

  let offset = 0
  let queued_total = 0
  let scanned_total = 0
  let passes = 0
  const pass_results = []

  while (queued_total < target_count && passes < 20) {
    passes += 1
    const result = await runSupabaseCandidateFeeder({
      candidate_source,
      limit: Math.min(per_pass_limit, target_count - queued_total),
      scan_limit,
      candidate_offset: offset,
      within_contact_window_now: respect_contact_window,
      routing_safe_only: mode !== 'live',
      dry_run: false,
      schedule_spread: true,
      schedule_interval_seconds_min: 45,
      schedule_interval_seconds_max: 180,
      identity_gate_mode,
      allow_identity_unknown,
      allow_weak_identity_outbound,
    })

    queued_total += Number(result?.queued_count || 0)
    scanned_total += Number(result?.scanned_count || 0)
    pass_results.push({
      pass: passes,
      offset,
      scanned_count: Number(result?.scanned_count || 0),
      eligible_count: Number(result?.eligible_count || 0),
      queued_count: Number(result?.queued_count || 0),
      duplicate_queue_item_count: Number(result?.duplicate_queue_item_count || 0),
      reason_code_counts: result?.reason_code_counts || [],
    })

    if ((result?.scanned_count || 0) < 1) break
    offset += scan_limit
  }

  return NextResponse.json({
    ok: true,
    action: 'queue-auto-enqueue',
    diagnostics: {
      configured_mode: configuredMode,
      requested_mode: mode,
      target_count,
      queued_count: queued_total,
      scanned_count: scanned_total,
      passes,
      pass_results,
    },
  }, { status: 200 })
}
