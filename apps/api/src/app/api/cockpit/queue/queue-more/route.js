import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { runSupabaseCandidateFeeder } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { getSystemValue } from '@/lib/system-control.js'
import { supabase } from '@/lib/supabase/client.js'

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
  const respect_contact_window = asBoolean(body.respect_contact_window, true)
  const manualMode = clean(body.mode || '').toLowerCase()
  const mode = manualMode === 'expanded' ? 'expanded' : clean(configuredMode || 'safe').toLowerCase()
  const candidate_source = clean(body.candidate_source || 'v_sms_ready_contacts_expanded')

  let offset = 0
  let queued_total = 0
  let scheduled_total = 0
  let scanned_total = 0
  let eligible_total = 0
  let skipped_total = 0

  let suppression_blocks = 0
  let routing_blocks = 0
  let duplicate_blocks = 0
  let no_template_blocks = 0
  let contact_window_blocks = 0
  let pending_prior_touch_blocks = 0
  let prior_touch_cooldown_blocks = 0
  let active_queue_blocks = 0

  let passes = 0

  while ((queued_total + scheduled_total) < target_count && passes < 20) {
    passes += 1
    const result = await runSupabaseCandidateFeeder({
      candidate_source,
      limit: Math.min(per_pass_limit, target_count - (queued_total + scheduled_total)),
      scan_limit,
      candidate_offset: offset,
      within_contact_window_now: respect_contact_window,
      routing_safe_only: mode !== 'live',
      dry_run: false,
      schedule_spread: true,
      schedule_interval_seconds_min: 45,
      schedule_interval_seconds_max: 180,
      allow_multiple_per_owner: false, // Enforce one phone per owner per batch
    })

    queued_total += Number(result?.queued_count || 0)
    scheduled_total += Number(result?.scheduled_count || 0)
    scanned_total += Number(result?.scanned_count || 0)
    eligible_total += Number(result?.eligible_count || 0)
    skipped_total += Number(result?.skipped_count || 0)

    suppression_blocks += Number(result?.suppression_block_count || 0)
    routing_blocks += Number(result?.routing_block_count || 0)
    duplicate_blocks += Number(result?.duplicate_queue_block_count || 0)
    duplicate_blocks += Number(result?.batch_duplicate_block_count || 0)
    no_template_blocks += Number(result?.template_block_count || 0)
    contact_window_blocks += Number(result?.contact_window_block_count || 0)
    pending_prior_touch_blocks += Number(result?.pending_prior_touch_block_count || 0)
    prior_touch_cooldown_blocks += Number(result?.prior_touch_cooldown_block_count || 0)
    active_queue_blocks += Number(result?.active_queue_block_count || 0)

    if ((result?.scanned_count || 0) < 1) break
    offset += scan_limit
  }

  // Get active queue count after insertion
  const { count: queue_count_after } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .in('queue_status', ['queued', 'scheduled', 'pending', 'ready'])

  return NextResponse.json({
    ok: true,
    action: 'queue-more',
    candidates_scanned: scanned_total,
    eligible_found: eligible_total,
    rows_created: queued_total,
    rows_scheduled: scheduled_total,
    rows_blocked: skipped_total,
    prior_touch_cooldown_blocks,
    active_queue_blocks,
    suppression_blocks,
    duplicate_blocks,
    block_reasons: {
      suppression: suppression_blocks,
      routing: routing_blocks,
      duplicates: duplicate_blocks,
      no_template: no_template_blocks,
      contact_window: contact_window_blocks,
      pending_prior_touch: pending_prior_touch_blocks,
      prior_touch_cooldown: prior_touch_cooldown_blocks,
      active_queue_row: active_queue_blocks,
    },
    queue_count_after: queue_count_after || 0,
  }, { status: 200 })
}
