// ─── no-automatic-reactivation.js ────────────────────────────────────────────
// FOUNDER P0 2026-11-23, item 1: "Lifting a global freeze, resuming a campaign,
// retrying a delivery, or restarting a service must never independently
// authorize an old message."
//
// CAMPAIGN RESUME. A paused campaign's rows used to stay `queued` / `scheduled`
// through the pause and go out the moment the campaign returned to `active`:
// pressing Resume re-authorized every message written before the pause. Resume
// now holds them first. Each waiting row is revalidated
// (queue-authority.js#revalidateBeforeDispatch) and moved, compare-and-set on
// its current status, to the canonical review hold (paused_operator_review)
// with the verdict recorded. The campaign resumes; its OLD rows do not. New
// work the feeder writes after the resume is fresh and unaffected, and an old
// row goes out only after an explicit per-row owner release.
//
// FAIL CLOSED. If the rows cannot be read, or a hold cannot be written, the
// caller must refuse the resume: a campaign must not go live with unheld rows.

import { revalidateBeforeDispatch } from "@/lib/domain/queue/queue-authority.js";
import { buildReauthorizationHoldPatch } from "@/lib/domain/queue/final-dispatch-gate.js";

export const RESUME_HOLD_STATUSES = Object.freeze(["queued", "scheduled", "pending", "ready", "approved", "retry"]);

const clean = (value) => String(value ?? "").trim();

/**
 * Hold every waiting row of a campaign before it resumes.
 * @returns {Promise<{ ok: boolean, examined: number, held: number, reason?: string, failed_ids?: string[] }>}
 */
export async function holdCampaignRowsForReauthorization(campaignId, { supabase, now = new Date().toISOString(), trigger = "campaign_resume", limit = 10000 } = {}) {
  const id = clean(campaignId);
  if (!id) return { ok: false, examined: 0, held: 0, reason: "missing_campaign_id" };
  if (!supabase?.from) return { ok: false, examined: 0, held: 0, reason: "no_database_client" };

  let rows;
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("*")
      .eq("campaign_id", id)
      .in("queue_status", RESUME_HOLD_STATUSES)
      .limit(limit);
    if (error) return { ok: false, examined: 0, held: 0, reason: "campaign_rows_unreadable" };
    rows = Array.isArray(data) ? data : [];
  } catch {
    return { ok: false, examined: 0, held: 0, reason: "campaign_rows_unreadable" };
  }

  const failed_ids = [];
  let held = 0;
  for (const row of rows) {
    const revalidation = revalidateBeforeDispatch({
      row,
      // A campaign-level Resume is not a per-row authorization.
      authorization_scope_valid: false,
    });
    const patch = buildReauthorizationHoldPatch(row, { trigger, now, blockers: revalidation.blockers });
    try {
      const { data, error } = await supabase
        .from("send_queue")
        .update(patch)
        .eq("id", row.id)
        .eq("queue_status", row.queue_status)
        .select("id");
      // Zero rows: the row moved on (cancelled, or claimed by a runner) between read and
      // write. While the campaign is still paused a claimed row is refused by the final
      // gate's campaign check, so the hold runs BEFORE the status transition (see caller).
      if (error) failed_ids.push(clean(row.id));
      else if (Array.isArray(data) && data.length === 1) held += 1;
    } catch {
      failed_ids.push(clean(row.id));
    }
  }

  if (failed_ids.length) return { ok: false, examined: rows.length, held, reason: "campaign_row_hold_write_failed", failed_ids };
  return { ok: true, examined: rows.length, held };
}

export default holdCampaignRowsForReauthorization;
