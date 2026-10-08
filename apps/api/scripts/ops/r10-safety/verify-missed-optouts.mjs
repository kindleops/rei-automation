// ROUND 10 · OPT-OUT VERIFICATION (read-only, dry run) — 2026-10-08.
//
// For every previously-missed opt-out since 10-01 (round 9's
// round9-missed-optouts.csv, by message_event id) plus any extra event ids
// (--extra=id,id: e.g. the outstanding thread-suppression flags), per phone
// (hashed, never printed):
//   1. sms_suppression_list: an ACTIVE global row (sender_phone_e164 null)
//   2. inbox_thread_state: every thread for the phone is_suppressed = true
//   3. send_queue: no pending row (canonical CANCELLABLE statuses, unsent)
//      and, reported separately, no paused_* / retry row that could resume
//   4. campaign_target_graph: every row for the phone excluded
//      (true_post_contact_suppression, or not sms_eligible / not queue_eligible)
//      and campaign_targets: no row still ready/queued for an active campaign
//
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs scripts/ops/r10-safety/verify-missed-optouts.mjs \
//     --csv=<round9-missed-optouts.csv> [--extra=<event ids>] --out=<dir>
import fs from "node:fs";
import { connectReadOnly, phoneRef, phoneVariants, e164, arg, writeOut, csv } from "./_ro-db.mjs";
import { CANCELLABLE_QUEUE_STATUSES } from "@/lib/domain/compliance/canonical-no-contact-states.js";

const CSV = arg("csv");
const OUT = arg("out");
const EXTRA = String(arg("extra", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!CSV || !OUT) {
  console.error("usage: --csv=<round9-missed-optouts.csv> --out=<dir> [--extra=<ids>]");
  process.exit(2);
}
const ids = fs.readFileSync(CSV, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0]).filter(Boolean);
const all_ids = [...new Set([...ids, ...EXTRA])];

const db = await connectReadOnly();
const { rows: events } = await db.query(
  `select id::text, from_phone_number, thread_key, created_at from message_events where id::text = any($1::text[])`,
  [all_ids],
);
const byPhone = new Map();
for (const e of events) {
  const p = e164(e.from_phone_number || e.thread_key);
  if (!p) continue;
  if (!byPhone.has(p)) byPhone.set(p, { events: [] });
  byPhone.get(p).events.push(e.id);
}
const missing_events = all_ids.filter((id) => !events.some((e) => e.id === id));

const RESUMABLE = ["retry", "runnable", "paused", "paused_after_hours", "paused_global_lock", "paused_operator_review", "paused_name_missing", "paused_duplicate", "paused_invalid_queue_row", "paused_max_retries", "approval", "blocked_by_health_guard", "blocked_sender_ineligible"];
const results = [];
for (const [phone, info] of byPhone) {
  const v = phoneVariants(phone);
  const sup = await db.query(
    `select count(*) filter (where is_active and sender_phone_e164 is null)::int global_active,
            count(*) filter (where is_active and sender_phone_e164 is not null)::int pair_active,
            count(*)::int total
       from sms_suppression_list where phone_e164 = any($1)`, [v]);
  const thr = await db.query(
    `select count(*)::int threads, count(*) filter (where is_suppressed is true)::int suppressed,
            string_agg(distinct coalesce(inbox_bucket,'-'), '|') buckets
       from inbox_thread_state where canonical_e164 = any($1) or thread_key = any($1)`, [v]);
  const q = await db.query(
    `select count(*) filter (where queue_status = any($2))::int pending,
            count(*) filter (where queue_status = any($3))::int resumable,
            string_agg(distinct queue_status, '|') filter (where queue_status = any($2) or queue_status = any($3)) statuses
       from send_queue where sent_at is null and (to_phone_number = any($1) or thread_key = any($1))`,
    [v, [...CANCELLABLE_QUEUE_STATUSES], RESUMABLE]);
  const g = await db.query(
    `select count(*)::int rows,
            count(*) filter (where coalesce(true_post_contact_suppression,false) = false and coalesce(sms_eligible,false) = true and coalesce(queue_eligible,false) = true)::int still_eligible
       from campaign_target_graph where canonical_e164 = any($1)`, [v]);
  const ct = await db.query(
    `select count(*)::int live_targets
       from campaign_targets t join campaigns c on c.id = t.campaign_id
      where t.to_phone_number = any($1) and c.status = 'active'
        and coalesce(t.target_status,'') = any(array['ready','queued','scheduled','pending','eligible'])`, [v]);
  const s = sup.rows[0], t = thr.rows[0], qq = q.rows[0], gg = g.rows[0], cc = ct.rows[0];
  const checks = {
    suppression_list_active: s.global_active > 0,
    thread_suppressed: t.threads > 0 && t.suppressed === t.threads,
    no_pending_send: qq.pending === 0,
    no_resumable_send: qq.resumable === 0,
    graph_excluded: gg.still_eligible === 0,
    no_live_campaign_target: cc.live_targets === 0,
  };
  results.push({
    phone_ref: phoneRef(phone),
    events: info.events.length,
    ...checks,
    pass: Object.values(checks).every(Boolean),
    detail: `list g=${s.global_active} pair=${s.pair_active}; threads ${t.suppressed}/${t.threads} [${t.buckets || "-"}]; queue pending=${qq.pending} resumable=${qq.resumable} [${qq.statuses || "-"}]; graph rows=${gg.rows} eligible=${gg.still_eligible}; live targets=${cc.live_targets}`,
  });
}
await db.end();

const header = ["phone_ref", "events", "suppression_list_active", "thread_suppressed", "no_pending_send", "no_resumable_send", "graph_excluded", "no_live_campaign_target", "pass", "detail"];
writeOut(OUT, "r10-optout-verification.csv", [header.join(","), ...results.map((r) => header.map((h) => csv(r[h])).join(","))].join("\n") + "\n");
const sum = (k) => results.filter((r) => r[k]).length;
const summary = {
  generated_at: new Date().toISOString(),
  event_ids: all_ids.length,
  events_found: events.length,
  events_missing: missing_events.length,
  phones: results.length,
  pass: sum("pass"),
  suppression_list_active: sum("suppression_list_active"),
  thread_suppressed: sum("thread_suppressed"),
  no_pending_send: sum("no_pending_send"),
  no_resumable_send: sum("no_resumable_send"),
  graph_excluded: sum("graph_excluded"),
  no_live_campaign_target: sum("no_live_campaign_target"),
  failing: results.filter((r) => !r.pass).map((r) => ({ phone_ref: r.phone_ref, detail: r.detail })),
};
writeOut(OUT, "r10-optout-verification.json", JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
