// ─── apply-resume-drain.js ───────────────────────────────────────────────────
// P0 (owner, 2026-10-08): no backlog burst when dispatch resumes.
// Runs before the runner claims rows, on every live (non-dry-run) tick. Overdue
// unsent rows are decided by the pure resume-drain policy (resume-drain-policy.js):
//   send               -> untouched; normal claim, caps, pacing and the final
//                         send-time guard still apply
//   replan/reevaluate  -> scheduled_for(_utc) moved to the next opening of the
//                         recipient-local 08:00–21:00 window with jitter;
//                         per-thread order preserved; sender, campaign and
//                         template fields are never touched
//   hold_for_operator  -> queue_status 'held' (+ dispatch_hold); released only by
//                         the audited owner-release action
// Fail closed: if the overdue read or any update fails, the runner sends nothing
// this tick.
import { info, warn } from "@/lib/logging/logger.js";
import { planResumeDrain, RESUME_DRAIN_POLICY_VERSION } from "@/lib/domain/queue/resume-drain-policy.js";

const OVERDUE_STATUSES = ["queued", "scheduled", "pending"];
const MAX_ROWS = 2000;

const clean = (v) => String(v ?? "").trim();

export async function applyResumeDrain({ supabase, now = new Date().toISOString(), plan = planResumeDrain, maxRows = MAX_ROWS } = {}) {
  if (!supabase?.from) return { ok: false, reason: "resume_drain_no_client", changed: 0 };
  const now_ms = Date.parse(now);
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status,scheduled_for,scheduled_for_utc,created_at,to_phone_number,thread_key,type,message_type,timezone,metadata")
    .in("queue_status", OVERDUE_STATUSES)
    .lt("scheduled_for_utc", now)
    .order("scheduled_for_utc", { ascending: true })
    .limit(maxRows);
  if (error) return { ok: false, reason: "resume_drain_read_failed", error: clean(error.message), changed: 0 };
  const rows = (data || []).map((r) => ({
    ...r,
    timezone: clean(r.timezone) || clean(r.metadata?.recipient_timezone) || clean(r.metadata?.timezone) || "America/Chicago",
  }));
  if (!rows.length) return { ok: true, scanned: 0, changed: 0, counts: {} };

  const decisions = plan(rows, { now: now_ms });
  const counts = {};
  let changed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const d = decisions[i];
    if (!d) continue;
    counts[d.action] = (counts[d.action] || 0) + 1;
    if (d.action === "send") continue;
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const drain_meta = {
      action: d.action,
      reason: d.reason,
      kind: d.kind,
      version: RESUME_DRAIN_POLICY_VERSION,
      at: now,
      previous_scheduled_for_utc: row.scheduled_for_utc || null,
    };
    let patch;
    if (d.action === "hold_for_operator") {
      patch = {
        queue_status: "held",
        held_at: now,
        updated_at: now,
        metadata: { ...meta, dispatch_hold: "resume_drain_stale_manual_send", resume_drain: drain_meta },
      };
    } else {
      if (!d.scheduled_for_utc) continue;
      patch = {
        scheduled_for_utc: d.scheduled_for_utc,
        scheduled_for: d.scheduled_for_utc,
        updated_at: now,
        metadata: { ...meta, resume_drain: { ...drain_meta, scheduled_for_utc: d.scheduled_for_utc, reevaluate: d.action === "reevaluate" } },
      };
    }
    // Guarded update: only rows still in an overdue-claimable status.
    const { error: update_error } = await supabase
      .from("send_queue")
      .update(patch)
      .eq("id", row.id)
      .in("queue_status", OVERDUE_STATUSES);
    if (update_error) {
      warn("queue.resume_drain_update_failed", { queue_row_id: row.id, error: clean(update_error.message) });
      return { ok: false, reason: "resume_drain_update_failed", scanned: rows.length, changed, counts };
    }
    changed += 1;
  }
  info("queue.resume_drain_applied", { scanned: rows.length, changed, counts, version: RESUME_DRAIN_POLICY_VERSION });
  return { ok: true, scanned: rows.length, changed, counts };
}

export default applyResumeDrain;
