/**
 * seller-followup-scheduler.js
 *
 * Deterministic follow-up scheduling based on inbound seller intent.
 * Maps intent → suppression | nurture_days | reason.
 *
 * Rules (per spec):
 *   Permanent suppression: opt_out, wrong_person, hostile_or_legal, DNC
 *   not_interested          → nurture in 30 days
 *   maybe / conditional     → nurture in 14-30 days
 *   price_too_low / stalled → nurture in 7-21 days
 *   positive                → active workflow (no scheduled followup)
 */

import { supabase as defaultSupabase } from '../lib/supabase/client.js'

const SUPPRESSED_INTENTS = new Set([
  'opt_out',
  'wrong_person',
  'wrong_person',
  'hostile_or_legal',
  'timing_complaint',
])

const NURTURE_DAYS = {
  not_interested:      30,
  listed_or_unavailable: 45,
  tenant_or_occupancy: 21,
  condition_signal:    14,
  asking_price_value:  14,
  unclear:             7,
  // conditional / maybe
  conditional_interest: 21,
  maybe_depends_on_price: 21,
}

const ACTIVE_INTENTS = new Set([
  'ownership_confirmed',
  'asks_offer',
  'info_request',
  'positive_interest',
])

function addDays(base, days) {
  const d = base instanceof Date ? new Date(base) : new Date(base || Date.now())
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString()
}

/**
 * Decide whether and when to schedule a follow-up for a thread.
 *
 * Returns:
 *   { suppressed: true, reason }
 *   { suppressed: false, followup_created: false, reason: 'active_workflow' }
 *   { suppressed: false, followup_created: false|true, scheduled_for, reason, days }
 */
export function resolveFollowUpPlan(intent, opts = {}) {
  const { thread_key, is_suppressed = false } = opts

  // Already suppressed at thread level
  if (is_suppressed) {
    return { suppressed: true, followup_created: false, reason: 'thread_already_suppressed' }
  }

  // Permanent suppression intents — never follow up
  if (SUPPRESSED_INTENTS.has(intent)) {
    return { suppressed: true, followup_created: false, reason: `permanent_suppression:${intent}` }
  }

  // Active/positive intents → acquisition workflow, no scheduled nurture needed
  if (ACTIVE_INTENTS.has(intent)) {
    return { suppressed: false, followup_created: false, reason: 'active_workflow_no_nurture' }
  }

  const days = NURTURE_DAYS[intent] ?? null

  if (!days) {
    return { suppressed: false, followup_created: false, reason: `no_followup_rule_for_intent:${intent}` }
  }

  const scheduled_for = addDays(new Date(), days)

  return {
    suppressed: false,
    followup_created: true,
    scheduled_for,
    days,
    reason: `nurture_followup:${intent}`,
    thread_key: thread_key || null,
  }
}

/**
 * Writes a follow-up row to send_queue (scheduled, type=followup).
 * Idempotent: skips insert if a pending followup already exists for this thread.
 */
export async function scheduleFollowUp(intent, thread_key, context = {}, supabase = defaultSupabase) {
  const plan = resolveFollowUpPlan(intent, { thread_key, is_suppressed: context.is_suppressed })

  if (plan.suppressed || !plan.followup_created) {
    return { ok: false, skipped: true, ...plan }
  }

  if (!thread_key) {
    return { ok: false, skipped: true, reason: 'missing_thread_key' }
  }

  // Idempotency: check for existing scheduled followup for this thread
  const { count: existing } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('thread_key', thread_key)
    .eq('type', 'followup')
    .in('queue_status', ['scheduled', 'queued'])
    .limit(1)

  if ((existing || 0) > 0) {
    return { ok: false, skipped: true, reason: 'duplicate_followup_exists', thread_key }
  }

  const { error } = await supabase.from('send_queue').insert({
    thread_key,
    queue_status: 'scheduled',
    type: 'followup',
    scheduled_for: plan.scheduled_for,
    message_type: 'followup',
    use_case_template: `nurture_${intent}`,
    metadata: {
      source: 'seller_followup_scheduler',
      intent,
      followup_reason: plan.reason,
      days_until_followup: plan.days,
      ...context,
    },
  })

  if (error) {
    return { ok: false, error: error.message, thread_key }
  }

  return {
    ok: true,
    followup_created: true,
    scheduled_for: plan.scheduled_for,
    reason: plan.reason,
    thread_key,
  }
}
