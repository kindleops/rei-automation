/**
 * RESUMING IS NOT LAUNCHING.
 *
 * THE DEFECT THIS CLOSES. Resume reused `evaluateCampaignLaunchReadiness` — the
 * ACTIVATION validator — which requires at least one target at
 * `target_status = 'ready'`. But materializing a target into the queue moves it
 * to `planned`. So a campaign whose recipients had ALL been queued had zero
 * "ready" targets by construction, and Resume refused it:
 *
 *     Resume blocked — No ready recipients in target snapshot
 *
 * Pause held the work correctly and then nothing could release it. Pause became
 * one-way for exactly the campaigns most likely to be paused — the ones already
 * running.
 *
 * THE DISTINCTION. Launch readiness asks "is there new work to start?".
 * Resume asks "is there work to continue?". Those are different questions and a
 * campaign can legitimately answer no to the first and yes to the second. This
 * adds the second source WITHOUT weakening the first: every other launch
 * blocker still blocks, and activation semantics are untouched.
 *
 * WHAT IT DOES NOT DO. It does not rebuild targets, re-plan work, reset target
 * state or fabricate readiness. It grants execution authority back over rows
 * that already exist; those rows then face every ordinary dispatch gate —
 * due-time, contact window, suppression, sender health, emergency stop, queue
 * posture. Resume itself sends nothing.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

/**
 * Queue statuses that represent work still legitimately in play.
 *
 * Mirrors the dispatcher's own live/holding vocabulary rather than inventing a
 * parallel one. `scheduled` is the shape the pause authority leaves behind, so
 * a paused campaign's own held rows qualify — which is the whole point.
 */
export const RESUMABLE_QUEUE_STATUSES = Object.freeze([
  "queued",
  "pending",
  "processing",
  "scheduled",
  "ready",
  "approved",
  "retry",
  "held",
  "paused",
]);

/**
 * Statuses that are finished business. History alone must never justify Resume:
 * a campaign whose every message was delivered has nothing to continue.
 */
export const TERMINAL_QUEUE_STATUSES = Object.freeze([
  "sent",
  "delivered",
  "failed",
  "failed_transport",
  "cancelled",
  "expired",
  "duplicate_blocked",
  "replied_before_send",
]);

const clean = (value) => String(value ?? "").trim().toLowerCase();

/**
 * Is this row work a Resume could legitimately continue?
 *
 * Status is necessary but not sufficient: a row carrying a provider message id
 * or a `sent_at` has already reached the provider, whatever its status column
 * says, and must not be counted as pending.
 */
export function isResumableQueueRow(row = {}) {
  if (!clean(row.campaign_id)) return false;
  if (clean(row.provider_message_id) || clean(row.textgrid_message_id)) return false;
  if (clean(row.sent_at)) return false;

  const status = clean(row.queue_status);
  if (TERMINAL_QUEUE_STATUSES.includes(status)) return false;
  return RESUMABLE_QUEUE_STATUSES.includes(status);
}

/**
 * Count the campaign's resumable queue work.
 *
 * Returns `null` when the count cannot be established — the caller must treat
 * that as "no evidence of resumable work" rather than as permission.
 */
export async function countResumableQueueWork(campaignId, deps = {}) {
  if (typeof deps.loadCampaignQueueRows === "function") {
    try {
      const rows = (await deps.loadCampaignQueueRows(campaignId)) || [];
      return rows.filter((row) => isResumableQueueRow({ ...row, campaign_id: row.campaign_id ?? campaignId })).length;
    } catch {
      // Same contract as the query path below: an unreadable queue is absence
      // of evidence, never evidence of absence — and never permission.
      return null;
    }
  }

  const supabase = deps.supabase || defaultSupabase;
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("id,campaign_id,queue_status,provider_message_id,textgrid_message_id,sent_at")
      .eq("campaign_id", campaignId)
      .in("queue_status", [...RESUMABLE_QUEUE_STATUSES])
      .limit(1000);
    if (error) throw error;
    return (data || []).filter(isResumableQueueRow).length;
  } catch {
    return null;
  }
}

/**
 * Decide whether Resume may proceed.
 *
 * @param readiness the existing launch-readiness verdict, unchanged
 * @returns {{ok: boolean, reason: string, resumable_queue_rows: number|null, blockers: string[]}}
 */
export async function evaluateCampaignResumeReadiness(campaignId, readiness = {}, deps = {}) {
  const blockerCodes = Array.isArray(readiness.blocker_codes) ? readiness.blocker_codes : [];
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];

  if (readiness.launch_readiness !== "blocked") {
    return { ok: true, reason: "launch_readiness_not_blocked", resumable_queue_rows: null, blockers: [] };
  }

  /**
   * ONLY the missing-recipients blocker is answerable by existing queue work.
   *
   * If the campaign is also blocked on routing, send windows, templates or an
   * operator gate, those are real problems that pending rows do not solve, and
   * Resume must keep refusing. Relaxing the whole verdict because one blocker
   * had an alternative answer would turn a narrow fix into a bypass.
   */
  const otherBlockers = blockerCodes.filter((code) => clean(code) !== "no_ready_recipients");
  if (otherBlockers.length > 0) {
    return { ok: false, reason: "blocked_for_other_reasons", resumable_queue_rows: null, blockers };
  }
  if (!blockerCodes.includes("no_ready_recipients")) {
    return { ok: false, reason: "blocked_without_recipient_blocker", resumable_queue_rows: null, blockers };
  }

  const resumable = await countResumableQueueWork(campaignId, deps);
  if (resumable === null) {
    // Unreadable queue state is not evidence of resumable work.
    return { ok: false, reason: "resumable_queue_state_unreadable", resumable_queue_rows: null, blockers };
  }
  if (resumable > 0) {
    return { ok: true, reason: "resumable_queue_work_exists", resumable_queue_rows: resumable, blockers: [] };
  }

  // No fresh recipients AND nothing pending — the refusal is truthful.
  return { ok: false, reason: "no_fresh_recipients_and_no_pending_work", resumable_queue_rows: 0, blockers };
}

export default evaluateCampaignResumeReadiness;
