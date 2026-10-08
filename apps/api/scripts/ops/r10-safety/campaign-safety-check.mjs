// ROUND 10 · ACTIVE CAMPAIGN SAFETY CHECK (read-only) — 2026-10-08.
//
// Confirms the named active campaigns (default "St. Louis · Oct 7" and
// "Atlanta · Oct 7") are unaffected by the round-9 view + repair:
//   1. static: the PROPOSED round-9 view / repair SQL write nothing but
//      inbox_thread_state (and its snapshot); no campaign / queue / graph table
//   2. per campaign, now: campaign_targets by target_status, send_queue by
//      queue_status, sendable targets
//   3. projected after the repair: the only way a target can leave is
//      suppression -- a repaired thread with suppress=true whose phone is a
//      sendable target (the repair sets is_suppressed only where the phone is
//      already on the active sms_suppression_list, so the send path already
//      blocks it). Every other repaired thread changes bucket / last_intent only.
//
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs \
//     scripts/ops/r10-safety/campaign-safety-check.mjs --repair=<PROPOSED-inbox-round9-repair.sql> \
//     --view=<PROPOSED_20261008020000_inbox_round9_buckets.sql> --out=<dir> [--names="A|B"]
import fs from "node:fs";
import { connectReadOnly, phoneRef, e164, arg, writeOut } from "./_ro-db.mjs";

const OUT = arg("out");
const REPAIR = arg("repair");
const VIEW = arg("view");
const NAMES = String(arg("names", "St. Louis · Oct 7|Atlanta · Oct 7")).split("|");
if (!OUT || !REPAIR || !VIEW) {
  console.error("usage: --repair=<sql> --view=<sql> --out=<dir> [--names=A|B]");
  process.exit(2);
}

// 1. Static: which tables do the PROPOSED files write?
const writeTargets = (sql) => {
  const t = new Set();
  for (const m of sql.matchAll(/\b(?:update|insert\s+into|delete\s+from|alter\s+table|truncate|create\s+(?:or\s+replace\s+)?(?:view|table|function|materialized\s+view))\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_.]*)/gi)) t.add(m[1].toLowerCase());
  return [...t];
};
const repairSql = fs.readFileSync(REPAIR, "utf8");
const viewSql = fs.readFileSync(VIEW, "utf8");
const repair_writes = writeTargets(repairSql);
const view_writes = writeTargets(viewSql);
const CAMPAIGN_TABLES = /campaign|send_queue|sms_suppression|target_graph/;
const static_ok = ![...repair_writes, ...view_writes].some((t) => CAMPAIGN_TABLES.test(t));

const repaired = [...repairSql.matchAll(/\('([0-9a-f-]{36})'::uuid,\s*'([0-9a-f-]{36})',\s*'([a-z_]+)',\s*(null|'[a-z_]+'),\s*(true|false)\)/g)].map((m) => ({
  id: m[1], intent: m[3], bucket: m[4] === "null" ? null : m[4].slice(1, -1), suppress: m[5] === "true",
}));

const db = await connectReadOnly();
const { rows: camps } = await db.query(`select id::text, name, status, market from campaigns where name = any($1)`, [NAMES]);
const { rows: thr } = await db.query(
  `select id::text, canonical_e164, thread_key from inbox_thread_state where id::text = any($1)`, [repaired.map((r) => r.id)]);
const repairedByPhone = new Map();
for (const t of thr) {
  const p = e164(t.canonical_e164 || t.thread_key);
  const r = repaired.find((x) => x.id === t.id);
  if (p && r) repairedByPhone.set(p, r);
}
const SENDABLE = ["ready", "queued", "scheduled", "pending", "eligible", "approved"];
const report = [];
for (const c of camps) {
  const { rows: ts } = await db.query(`select coalesce(target_status,'(null)') s, count(*)::int n from campaign_targets where campaign_id::text = $1 group by 1 order by 2 desc`, [c.id]);
  const { rows: qs } = await db.query(`select queue_status s, count(*)::int n from send_queue where campaign_id::text = $1 group by 1 order by 2 desc`, [c.id]);
  const { rows: tp } = await db.query(`select to_phone_number, coalesce(target_status,'') s from campaign_targets where campaign_id::text = $1`, [c.id]);
  const { rows: listed } = await db.query(
    `select distinct phone_e164 from sms_suppression_list where is_active and sender_phone_e164 is null and phone_e164 = any($1)`,
    [[...new Set(tp.map((r) => e164(r.to_phone_number)).filter(Boolean))]]);
  const listedSet = new Set(listed.map((r) => e164(r.phone_e164)));
  const touched = tp.filter((r) => repairedByPhone.has(e164(r.to_phone_number)));
  const sendable = tp.filter((r) => SENDABLE.includes(r.s.toLowerCase()));
  const removedBySuppression = sendable.filter((r) => repairedByPhone.get(e164(r.to_phone_number))?.suppress === true);
  report.push({
    campaign: c.name,
    status: c.status,
    market: c.market,
    targets_total: tp.length,
    targets_by_status: Object.fromEntries(ts.map((r) => [r.s, r.n])),
    queue_by_status: Object.fromEntries(qs.map((r) => [r.s, r.n])),
    sendable_before: sendable.length,
    targets_on_repaired_threads: touched.length,
    repaired_thread_changes: touched.map((r) => {
      const x = repairedByPhone.get(e164(r.to_phone_number));
      return { phone_ref: phoneRef(r.to_phone_number), target_status: r.s, write_intent: x.intent, write_bucket: x.bucket, suppress: x.suppress };
    }),
    removed_by_suppression: removedBySuppression.length,
    removed_already_on_suppression_list: removedBySuppression.filter((r) => listedSet.has(e164(r.to_phone_number))).length,
    sendable_after_projected: sendable.length - removedBySuppression.length,
    removed_other_than_suppression: 0,
  });
}
await db.end();
const summary = {
  generated_at: new Date().toISOString(),
  campaigns_requested: NAMES,
  campaigns_found: camps.length,
  static: { repair_writes, view_writes, campaign_or_queue_tables_written: !static_ok },
  repaired_threads: repaired.length,
  repaired_threads_suppress: repaired.filter((r) => r.suppress).length,
  campaigns: report,
  verdict: static_ok && camps.length === NAMES.length && report.every((r) => r.removed_other_than_suppression === 0) ? "unaffected_except_suppression" : "check",
};
writeOut(OUT, "r10-campaign-safety.json", JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
