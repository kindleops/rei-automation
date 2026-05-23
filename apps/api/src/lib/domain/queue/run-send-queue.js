import crypto from "node:crypto";
import { info, warn } from "@/lib/logging/logger.js";
import { getSystemFlag } from "@/lib/system-control.js";

export async function runSendQueue(
  {
    limit = 50,
    dry_run = false,
    now = new Date().toISOString(),
  } = {},
  deps = {}
) {
  const get_system_flag = deps.getSystemFlag || getSystemFlag;
  const log_info = deps.info || info;
  const log_warn = deps.warn || warn;
  const run_started_at = now;
  const processing_run_id = crypto.randomUUID();

  log_info("queue.run_started", { limit, dry_run, now_utc: now });

  // 1. Stale-lock recovery for stuck "processing" rows
  try {
    const { data: recycled, error: recycle_error } = await deps.supabaseClient
        .from('send_queue')
        .update({
            queue_status: 'queued',
            is_locked: false,
            locked_at: null,
            processing_run_id: null,
        })
        .eq('queue_status', 'processing')
        .lt('locked_at', new Date(Date.now() - 10 * 60000).toISOString())
        .select('id');
    
    if (recycled?.length) {
        log_info("queue_stuck_rows_recycled", { count: recycled.length });
    }
  } catch (err) {
    log_warn("queue.stuck_row_recovery_failed", { error: err.message });
  }

  // 2. Fetch candidates (no global lock skip)
  const candidates = await buildQueueCandidates(limit, now, { ...deps, dry_run });
  const rows = normalizeRows(candidates.rows);

  log_info("queue_rows_claimed", { count: rows.length });

  const results = [];
  let sent_count = 0;
  let failed_count = 0;
  let processed_count = 0;

  // 3. Process rows with row-level atomic claims
  for (const row of rows) {
    const queue_item_id = row.id;
    
    // Atomic Claim
    const { data: claimed, error: claim_error } = await deps.supabaseClient
        .from('send_queue')
        .update({
            queue_status: 'processing',
            is_locked: true,
            locked_at: new Date().toISOString(),
            processing_run_id: processing_run_id,
            metadata: {
                ...row.metadata,
                claimed_by: 'queue_runner',
                claimed_at: new Date().toISOString()
            }
        })
        .eq('id', queue_item_id)
        .eq('queue_status', 'queued')
        .is('is_locked', false)
        .select()
        .single();

    if (claim_error || !claimed) {
        log_warn("queue_row_claim_failed", { queue_item_id });
        continue;
    }

    try {
        const result = await deps.processSendQueueItem(claimed, { ...deps, now });
        processed_count += 1;
        
        if (result.ok) {
            sent_count += 1;
            results.push({ ok: true, queue_item_id });
            log_info("queue_row_processed", { queue_item_id, status: 'sent' });
        } else {
            failed_count += 1;
            results.push({ ok: false, queue_item_id, reason: result.reason });
            log_warn("queue_row_failed", { queue_item_id, reason: result.reason });
        }
    } catch (err) {
        failed_count += 1;
        log_warn("queue_row_failed", { queue_item_id, error: err.message });
    }
  }

  log_info("queue_run_completed", {
      processing_run_id,
      claimed_count: rows.length,
      sent_count,
      failed_count,
      batch_duration_ms: Date.now() - new Date(run_started_at).getTime()
  });

  return { ok: true, sent_count, failed_count };
}
