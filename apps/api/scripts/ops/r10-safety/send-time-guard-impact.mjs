// P0 · SEND-TIME GUARD IMPACT COUNT (read-only) — 2026-10-08.
// For every unsent pending / scheduled / queued send_queue row of every ACTIVE
// campaign, runs the send-time contact guard (send-time-contact-guard.js) on
// fresh read-only facts and counts the rows it would newly block, by reason
// and by campaign. Phones are never printed.
//
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs \
//     scripts/ops/r10-safety/send-time-guard-impact.mjs --out=<dir>
import { connectReadOnly, phoneRef, arg, writeOut, roSupabase } from "./_ro-db.mjs";
import { runSendTimeContactGuard } from "@/lib/domain/queue/send-time-contact-guard.js";

const OUT = arg("out");
if (!OUT) {
  console.error("usage: --out=<dir>");
  process.exit(2);
}
const PENDING = ["pending", "scheduled", "queued", "ready", "approved", "held", "processing", "sending"];
const db = await connectReadOnly();
const { rows: camps } = await db.query(`select id::text, name from campaigns where status = 'active' order by name`);
const { rows } = await db.query(
  `select q.id::text, q.campaign_id::text, q.to_phone_number, q.thread_key, q.from_phone_number, q.property_id, q.prospect_id,
          q.master_owner_id, q.phone_id, q.type, q.message_type, q.touch_number, q.queue_status, q.created_at, q.metadata
     from send_queue q
    where q.sent_at is null and q.queue_status = any($1) and q.campaign_id::text = any($2)`,
  [PENDING, camps.map((c) => c.id)],
);
const supabase = roSupabase(db);
const by_reason = {};
const by_campaign = Object.fromEntries(camps.map((c) => [c.name, { rows: 0, would_block: 0, by_reason: {} }]));
const name = new Map(camps.map((c) => [c.id, c.name]));
const blocked = [];
for (const row of rows) {
  const g = await runSendTimeContactGuard(row, { supabase, now: Date.now() });
  const c = by_campaign[name.get(row.campaign_id)];
  c.rows += 1;
  if (g.blocked) {
    by_reason[g.reason] = (by_reason[g.reason] || 0) + 1;
    c.would_block += 1;
    c.by_reason[g.reason] = (c.by_reason[g.reason] || 0) + 1;
    blocked.push({ queue_row_id: row.id, campaign: name.get(row.campaign_id), phone_ref: phoneRef(row.to_phone_number), status: row.queue_status, reason: g.reason, detail: g.detail || null });
  }
}
await db.end();
const summary = {
  generated_at: new Date().toISOString(),
  active_campaigns: camps.map((c) => c.name),
  pending_rows: rows.length,
  would_block: blocked.length,
  by_reason,
  by_campaign,
};
writeOut(OUT, "p0-send-time-guard-impact.json", JSON.stringify({ ...summary, blocked }, null, 1));
console.log(JSON.stringify(summary, null, 1));
