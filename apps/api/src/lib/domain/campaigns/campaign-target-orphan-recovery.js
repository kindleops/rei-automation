/**
 * Recovery for campaign targets orphaned in `target_status = 'planned'`.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `target_status` is a one-way door. Exactly one statement advances it to
 * 'planned' — the hydration step at campaign-automation-service.js:7069, run
 * immediately after send_queue rows are inserted — and NOTHING in the codebase
 * ever moves it back. Meanwhile the hydration selector filters on
 * `.eq('target_status', 'ready')`.
 *
 * So the moment a target's queue rows all reach a terminal state
 * (cancelled / expired / failed / duplicate_blocked / blocked_by_health_guard),
 * that target is stranded permanently:
 *
 *   · not 'ready'  -> the hydration selector will never pick it up again
 *   · no live queue row -> the queue runner has nothing to send
 *   · not blocked  -> no operator-visible reason it is being skipped
 *
 * The cancel paths make this routine, not exotic: campaign-convert-to-live.js
 * and workflow-v2/follow-up-service.js both cancel send_queue rows in bulk and
 * never touch campaign_targets at all. Bulk expiry does the same.
 *
 * Measured in production 2026-08-17: 1,619 of 2,359 targets (69%) were stranded
 * this way — every one with status='ready' and block_reason IS NULL, holding
 * 3,235 queue rows between them of which zero were live (1,767 cancelled,
 * 1,312 expired, the rest delivered/failed).
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * Rather than patch each of the several places that can terminalise a queue
 * row, recovery is idempotent and runs at the one place that matters: just
 * before targets are selected for hydration. A target returns to 'ready' only
 * when it is genuinely re-sendable:
 *
 *   target_status = 'planned'      already dispatched at least once
 *   status        = 'ready'        was eligible at build time
 *   block_reason  IS NULL          not blocked for cause
 *   suppression_status <> 'blocked'
 *   AND no send_queue row in a live state
 *
 * Targets that were legitimately delivered are NOT recovered — see
 * TERMINAL_BUT_CONSUMED below. Re-sending to someone we already reached is a
 * compliance problem, not a recovery.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { paginateRows } from './campaign-target-pagination.js'

/** Queue states that mean "this target is still in flight — leave it alone". */
export const LIVE_QUEUE_STATUSES = [
  'queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending',
]

/**
 * Terminal states that mean the message REACHED the recipient. A target holding
 * one of these has been consumed and must never be silently re-queued.
 */
export const TERMINAL_BUT_CONSUMED = ['sent', 'delivered']

/**
 * Find targets stranded in 'planned' with nothing live behind them.
 * Read-only. Returns the target ids that recovery would touch.
 */
export async function findOrphanedCampaignTargets(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return []

  const candidates = await paginateRows((from, to) =>
    supabase
      .from('campaign_targets')
      .select('id,suppression_status')
      .eq('campaign_id', campaignId)
      .eq('target_status', 'planned')
      .eq('status', 'ready')
      .is('block_reason', null)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const eligible = candidates.filter((row) => String(row.suppression_status ?? '').trim() !== 'blocked')
  if (!eligible.length) return []

  const ids = eligible.map((row) => row.id)
  const disqualifying = [...LIVE_QUEUE_STATUSES, ...TERMINAL_BUT_CONSUMED]

  // Any target holding a live OR already-delivered queue row is excluded.
  const held = new Set()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const rows = await paginateRows((from, to) =>
      supabase
        .from('send_queue')
        .select('campaign_target_id')
        .in('campaign_target_id', chunk)
        .in('queue_status', disqualifying)
        .order('campaign_target_id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) held.add(row.campaign_target_id)
  }

  return ids.filter((id) => !held.has(id))
}

/**
 * Return orphaned targets to 'ready' so hydration can pick them up again.
 *
 * Idempotent: re-running with nothing orphaned is a no-op. Does not enqueue,
 * schedule or send anything — it only restores eligibility. Actual dispatch
 * still requires the normal launch path and the queue execution settings.
 *
 * @param {{ dryRun?: boolean }} options dryRun returns the candidate ids without writing
 */
export async function releaseOrphanedCampaignTargets(campaignId, deps = {}, options = {}) {
  const supabase = deps.supabase || defaultSupabase
  const ids = await findOrphanedCampaignTargets(campaignId, deps)
  if (!ids.length) return { released: 0, ids: [] }
  if (options.dryRun) return { released: 0, ids, dry_run: true }

  const releasedAt = new Date().toISOString()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { error } = await supabase
      .from('campaign_targets')
      // `updated_at` only — deliberately no new column. Adding one would need a
      // migration, and `last_launched_at` is left intact as the audit trail of
      // the dispatch that stranded the row.
      .update({ target_status: 'ready', updated_at: releasedAt })
      .in('id', chunk)
      // Re-assert the guard at write time: another process may have hydrated
      // or blocked one of these between the read and this update.
      .eq('target_status', 'planned')
      .is('block_reason', null)
    if (error) throw error
  }
  return { released: ids.length, ids, released_at: releasedAt }
}
