// Inbox round 9 — re-classify + re-bucket DRY RUN (2026-10-07).
//
// READ-ONLY against the database (one read-only transaction, statement
// timeout). For every seller inbound since --since it rebuilds the live
// context (the question it answered, intervening replies, property valuation),
// replays it through the CURRENT chain (buildConversationContext -> classify ->
// executeInboundAutomationDecision, dry run, live active+safe template
// catalog), and writes to --out:
//   round9-dryrun.csv        every inbound whose intent changed (no phones)
//   round9-threads.csv       every thread stored in New Replies / Priority:
//                            bucket before -> after (JS mirror of the round-9 view)
//   round9-missed-optouts.csv  inbounds the live classifier did not call opt_out
//                            that the round-9 rules do, and whether the phone is
//                            on the active sms_suppression_list
//   PROPOSED-inbox-round9-repair.sql  the repair (DO block, v_commit false)
//
// The repair touches a thread only when its LATEST message is the replayed
// inbound (compare-and-set on latest_message_event_id) and:
//   last_intent  := the round-9 re-read when it differs
//   inbox_bucket := dead (hostile / sold / never owned), cold (implausible ask),
//                   follow_up (decline / not now), suppressed (opt-out whose
//                   phone is ALREADY on the canonical sms_suppression_list) --
//                   only when the stored bucket is new_replies / priority
// It never writes suppression itself: an opt-out whose phone is NOT on the
// list is reported for the canonical recordPhoneSuppression path.
//
//   DATABASE_URL=... node --import ./tests/register-aliases.mjs \
//     scripts/repair/inbox-round9-reclassify-20261007.mjs --since=2026-10-01 --out=/tmp/r9

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

import "../../tests/helpers/critical-test-environment.mjs";
import { replayReply } from "../../tests/helpers/reply-replay-harness.mjs";
import { resolveInboxBucketFlags } from "@/lib/domain/inbox/inbox-bucket-predicates.js";

const require = createRequire(import.meta.url);
const pg = require("pg");

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SINCE = arg("since", "2026-10-01T00:00:00Z");
const OUT = arg("out");
if (!OUT || !process.env.DATABASE_URL) {
  console.error("usage: DATABASE_URL=... inbox-round9-reclassify-20261007.mjs --since=<iso> --out=<dir>");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const csv = (v) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const sqlText = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const redact = (s) => String(s ?? "").replace(/\+?1?\D?\d{3}\D?\d{3}\D?\d{4}/g, "<phone>").replace(/\s+/g, " ").slice(0, 90);
const ref = (key) => crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 10);

const DEAD = new Set(["hostile_or_legal", "hostile_or_troll", "sold_property", "former_owner_respondent", "wrong_number", "wrong_person", "property_specific_non_owner", "tenant_respondent"]);
const FOLLOW_UP = new Set(["not_interested", "need_time"]);

function bucketOf(f) {
  for (const k of ["priority", "new_replies", "unclear", "needs_review", "follow_up", "suppressed", "dead", "waiting", "cold"]) if (f[`in_${k}`]) return k;
  return f.in_all ? "all_only" : "archived";
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("begin read only");
await client.query("set local statement_timeout = '30s'");

const { rows: catalog } = await client.query(
  `select id, template_id::text as template_id, use_case, language, stage_code, is_active, safe_for_auto_reply, reply_mode, template_body, property_type_scope
     from sms_templates where is_active = true and safe_for_auto_reply = true`);
const { rows: inbound } = await client.query(
  `select id, thread_key, created_at, received_at, message_body, from_phone_number, property_id, detected_intent
     from message_events where direction = 'inbound' and created_at >= $1 order by created_at`, [SINCE]);

const replays = [];
for (const r of inbound) {
  if (!r.message_body) continue;
  const at = (r.received_at || r.created_at).toISOString();
  const digits = String(r.from_phone_number || "").replace(/\D/g, "").slice(-10);
  const variants = [r.from_phone_number, digits, `1${digits}`, `+1${digits}`];
  const { rows: out } = await client.query(
    `select sq.message_type, sq.template_id::text as template_id, sq.message_body, sq.sent_at, sq.delivered_at, t.use_case
       from send_queue sq left join sms_templates t on t.template_id::text = sq.template_id::text
      where sq.to_phone_number = any($1) and sq.queue_status in ('sent','delivered') and sq.sent_at is not null and sq.sent_at <= $2
      order by sq.sent_at desc limit 1`, [variants, at]);
  const prior = out[0] || null;
  let intervening = [];
  if (prior) {
    const { rows } = await client.query(
      `select created_at, message_body, detected_intent from message_events
        where direction = 'inbound' and from_phone_number = $1 and created_at > $2 and created_at < $3 order by created_at`,
      [r.from_phone_number, prior.sent_at, r.created_at]);
    intervening = rows.map((x) => ({ created_at: x.created_at.toISOString(), text: x.message_body, intent: x.detected_intent }));
  }
  let valuation = null;
  if (r.property_id) {
    const { rows } = await client.query(`select estimated_value, arv_estimate from properties where property_id::text = $1 limit 1`, [String(r.property_id)]);
    if (rows[0]) valuation = { estimated_value: rows[0].estimated_value == null ? null : Number(rows[0].estimated_value), arv_estimate: rows[0].arv_estimate == null ? null : Number(rows[0].arv_estimate) };
  }
  const fixture = {
    fixture_id: r.id, received_at: at, seller_message: r.message_body,
    prior_question: prior ? { message_type: prior.message_type, template_id: prior.template_id, template_use_case: prior.use_case, text: prior.message_body, sent_at: prior.sent_at?.toISOString(), delivered_at: prior.delivered_at?.toISOString() || null } : null,
    intervening_inbound: intervening, r7_history: [], valuation,
  };
  const replay = await replayReply(fixture, { catalog });
  replays.push({ event: r, replay });
}

const threadKeys = [...new Set(replays.map((x) => x.event.thread_key))];
const { rows: states } = await client.query(`select * from inbox_thread_state where thread_key = any($1)`, [threadKeys]);
const { rows: storedAttention } = await client.query(`select * from inbox_thread_state where inbox_bucket in ('new_replies','priority') and not coalesce(is_archived, false)`);
const phones = [...new Set(replays.map((x) => x.event.from_phone_number).filter(Boolean))];
const { rows: listed } = await client.query(`select distinct phone_e164 from sms_suppression_list where is_active = true and phone_e164 = any($1)`, [phones]);
await client.query("rollback");
await client.end();

const onList = new Set(listed.map((x) => x.phone_e164));
const stateByKey = new Map(states.map((s) => [s.thread_key, s]));
const latestByThread = new Map();
for (const x of replays) latestByThread.set(x.event.thread_key, x); // ordered by created_at

const changed = [];
const missed = [];
for (const x of replays) {
  const now = x.replay.classification.primary_intent || "unclear";
  const live = x.event.detected_intent || null;
  if (now !== live) changed.push(x);
  if (now === "opt_out" && live !== "opt_out") missed.push(x);
}

// Repair rows: the thread's latest message is the replayed inbound.
const repairs = [];
for (const [key, x] of latestByThread) {
  const s = stateByKey.get(key);
  if (!s || String(s.latest_message_event_id) !== String(x.event.id)) continue;
  const intent = x.replay.classification.primary_intent || "unclear";
  const stored = String(s.inbox_bucket || "").toLowerCase();
  let bucket = null;
  let suppress = false;
  if (["new_replies", "priority"].includes(stored)) {
    if (intent === "opt_out") {
      if (onList.has(x.event.from_phone_number)) { bucket = "suppressed"; suppress = true; }
    } else if (DEAD.has(intent)) bucket = "dead";
    else if (intent === "asking_price_implausible") bucket = "cold";
    else if (FOLLOW_UP.has(intent)) bucket = "follow_up";
  }
  // Never write "unclear" over a recorded intent (a context-lite re-read of an
  // old thread must not erase what the live path understood).
  const storedIntent = String(s.last_intent || "");
  const writeIntent = intent !== storedIntent && !(intent === "unclear" && storedIntent) ? intent : null;
  if (writeIntent || bucket) repairs.push({ s, x, writeIntent, bucket, suppress });
}

// Before/after for every thread stored in New Replies / Priority.
const repairById = new Map(repairs.map((r) => [r.s.id, r]));
const threadLines = [["thread_ref", "stored_bucket", "before_view_js", "after_view_js", "last_intent_before", "last_intent_after", "latest_body"]];
const moves = {};
for (const s of storedAttention) {
  const r = repairById.get(s.id);
  const after = { ...s, ...(r?.writeIntent ? { last_intent: r.writeIntent } : {}), ...(r?.bucket ? { inbox_bucket: r.bucket } : {}), ...(r?.suppress ? { is_suppressed: true } : {}) };
  const b0 = bucketOf(resolveInboxBucketFlags(s));
  const b1 = bucketOf(resolveInboxBucketFlags(after));
  const k = `${s.inbox_bucket} -> ${b1}`;
  moves[k] = (moves[k] || 0) + 1;
  threadLines.push([ref(s.thread_key), s.inbox_bucket, b0, b1, s.last_intent, after.last_intent, redact(s.latest_message_body)]);
}

fs.writeFileSync(path.join(OUT, "round9-threads.csv"), threadLines.map((l) => l.map(csv).join(",")).join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "round9-dryrun.csv"), [["event_id", "thread_ref", "received_at", "live_intent", "round9_intent", "outcome", "body"].join(",")]
  .concat(changed.map((x) => [x.event.id, ref(x.event.thread_key), x.event.created_at.toISOString(), x.event.detected_intent, x.replay.classification.primary_intent, x.replay.outcome, redact(x.event.message_body)].map(csv).join(","))).join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "round9-missed-optouts.csv"), [["event_id", "thread_ref", "received_at", "live_intent", "on_active_suppression_list", "body"].join(",")]
  .concat(missed.map((x) => [x.event.id, ref(x.event.thread_key), x.event.created_at.toISOString(), x.event.detected_intent, onList.has(x.event.from_phone_number), redact(x.event.message_body)].map(csv).join(","))).join("\n") + "\n");

const values = repairs.map((r) =>
  `    (${sqlText(r.s.id)}::uuid, ${sqlText(String(r.x.event.id))}, ${sqlText(r.writeIntent)}, ${sqlText(r.bucket)}, ${r.suppress})`).join(",\n");
const sql = `-- PROPOSED data repair — Inbox round 9 re-classify / re-bucket (generated ${new Date().toISOString()}).
-- NOT APPLIED. Generated by apps/api/scripts/repair/inbox-round9-reclassify-20261007.mjs
-- (read-only export + replay of every inbound since ${SINCE}); CSVs next to it list every row.
-- Apply AFTER PROPOSED_20261008020000_inbox_round9_buckets.sql (the view decides
-- New Replies / Unclear / Priority; this fixes the stored inputs it reads).
-- Compare-and-set on latest_message_event_id: a thread with a newer message is skipped.
--   last_intent   := the round-9 re-read
--   inbox_bucket  := dead / cold / follow_up / suppressed (stored new_replies|priority only)
--   is_suppressed := true ONLY where the phone is already on the active sms_suppression_list
-- Snapshot table holds every before-image; rollback:
--   update inbox_thread_state t set last_intent = b.before->>'last_intent', inbox_bucket = b.before->>'inbox_bucket',
--     is_suppressed = (b.before->>'is_suppressed')::boolean, suppressed_at = (b.before->>'suppressed_at')::timestamptz
--     from public._repair_inbox_round9_20261007 b where b.row_id = t.id::text;

create table if not exists public._repair_inbox_round9_20261007 (
  row_id text not null,
  before jsonb not null,
  captured_at timestamptz not null default now()
);
alter table public._repair_inbox_round9_20261007 enable row level security;
revoke all on public._repair_inbox_round9_20261007 from anon, authenticated;

do $repair$
declare
  v_commit boolean := false; -- DRY RUN unless flipped to true
  v_rows int;
begin
  create temp table _r (id uuid, latest_message_event_id text, write_intent text, write_bucket text, suppress boolean) on commit drop;
  insert into _r values
${values || "    (null, null, null, null, false)"};
  delete from _r where id is null;

  insert into public._repair_inbox_round9_20261007 (row_id, before)
  select t.id::text, jsonb_build_object('last_intent', t.last_intent, 'inbox_bucket', t.inbox_bucket,
         'is_suppressed', t.is_suppressed, 'suppressed_at', t.suppressed_at, 'latest_message_event_id', t.latest_message_event_id)
    from inbox_thread_state t join _r on _r.id = t.id
   where t.latest_message_event_id::text = _r.latest_message_event_id;

  update inbox_thread_state t
     set last_intent = coalesce(_r.write_intent, t.last_intent),
         inbox_bucket = coalesce(_r.write_bucket, t.inbox_bucket),
         is_suppressed = coalesce(t.is_suppressed, false) or _r.suppress,
         suppressed_at = case when _r.suppress and not coalesce(t.is_suppressed, false) then now() else t.suppressed_at end
    from _r
   where t.id = _r.id and t.latest_message_event_id::text = _r.latest_message_event_id;
  get diagnostics v_rows = row_count;
  raise notice 'round9 repair: % rows (of % proposed)', v_rows, (select count(*) from _r);

  if not v_commit then
    raise exception 'round9 repair DRY RUN complete (% rows) — rolled back; set v_commit := true to apply', v_rows;
  end if;
end
$repair$;
`;
fs.writeFileSync(path.join(OUT, "PROPOSED-inbox-round9-repair.sql"), sql);

console.log(JSON.stringify({
  inbound_replayed: replays.length,
  intent_changed: changed.length,
  missed_opt_outs: missed.length,
  missed_opt_outs_not_on_suppression_list: missed.filter((x) => !onList.has(x.event.from_phone_number)).length,
  repair_rows: repairs.length,
  stored_new_replies_priority: storedAttention.length,
  moves,
}, null, 1));
