// P0 · RESUME DRAIN DRY RUN (read-only) — 2026-10-08.
// What applyResumeDrain WOULD do right now if dispatch resumed: counts by action
// and kind, and the re-planned time spread per hour. Writes nothing; no phones.
import { connectReadOnly, arg, writeOut } from "./_ro-db.mjs";
import { planResumeDrain } from "@/lib/domain/queue/resume-drain-policy.js";

const OUT = arg("out") || "/tmp";
const db = await connectReadOnly();
const now = new Date().toISOString();
const { rows } = await db.query(
  `select id::text, queue_status, scheduled_for, scheduled_for_utc, created_at, to_phone_number, thread_key, type, message_type, timezone, metadata, campaign_id::text
     from send_queue where queue_status = any($1) and scheduled_for_utc < $2 order by scheduled_for_utc limit 5000`,
  [["queued", "scheduled", "pending"], now],
);
const prepared = rows.map((r) => ({ ...r, timezone: r.timezone || r.metadata?.recipient_timezone || r.metadata?.timezone || "America/Chicago" }));
const decisions = planResumeDrain(prepared, { now: Date.parse(now) });
const by_action = {}, by_kind = {}, per_hour = {};
for (const d of decisions) {
  by_action[d.action] = (by_action[d.action] || 0) + 1;
  by_kind[`${d.kind}:${d.action}`] = (by_kind[`${d.kind}:${d.action}`] || 0) + 1;
  if (d.scheduled_for_utc) { const h = d.scheduled_for_utc.slice(0, 13) + ":00Z"; per_hour[h] = (per_hour[h] || 0) + 1; }
}
const summary = { now, overdue_rows: rows.length, by_action, by_kind, replanned_per_hour: per_hour };
writeOut(OUT, "resume-drain-dryrun.json", JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
await db.end?.();
