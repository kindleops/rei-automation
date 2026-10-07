// Inbox Actionability 8.5 — one-time re-bucket DRY RUN (2026-10-06).
//
// READ-ONLY. Takes a JSON export of the threads that sit (or would sit) in New
// Replies / Priority, re-reads each latest inbound with the CURRENT classifier
// (heuristic only, no AI, no network; property valuation + recent seller
// messages supplied from the export so implausible asks and trolls are seen),
// and writes:
//   <out>/rebucket-dryrun.csv   what moves where, and why
//   <out>/rebucket-repair.sql   the PROPOSED repair (DO block, v_commit false)
//
// The repair only ever DEMOTES: it writes a re-read intent when that intent is
// NON-ACTIONABLE (reply-actionability.js) and the stored one was not, and it
// cools a recorded warm/hot that the canonical heat no longer supports. It
// never promotes on a context-lite re-read and never writes suppression: an
// opt-out the classifier now sees is listed for the canonical STOP path.
//
// Export (read-only psql, see the header of rebucket-repair.sql for the query):
//   node --import ./tests/register-aliases.mjs \
//     scripts/repair/inbox-actionability-rebucket-20261006.mjs <rows.json> <outDir>

import fs from "node:fs";
import path from "node:path";

import { classify } from "@/lib/domain/classification/classify.js";
import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
import { resolveInboxBucketFlags } from "@/lib/domain/inbox/inbox-bucket-predicates.js";
import {
  isNonActionableReplyIntent,
  resolveCanonicalLeadHeat,
} from "@/lib/domain/inbox/reply-actionability.js";

const [, , inputPath, outDir] = process.argv;
if (!inputPath || !outDir) {
  console.error("usage: inbox-actionability-rebucket-20261006.mjs <rows.json> <outDir>");
  process.exit(2);
}

const rows = JSON.parse(fs.readFileSync(inputPath, "utf8")) || [];
const NOW = Date.now();

function bucketOf(flags) {
  if (flags.in_priority) return "priority";
  if (flags.in_new_replies) return "new_replies";
  if (flags.in_needs_review) return "needs_review";
  if (flags.in_follow_up) return "follow_up";
  if (flags.in_suppressed) return "suppressed";
  if (flags.in_dead) return "dead";
  if (flags.in_waiting) return "waiting";
  if (flags.in_cold) return "cold";
  return "all";
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sqlText(value) {
  return value == null ? "null" : `'${String(value).replace(/'/g, "''")}'`;
}

const out = [];
for (const row of rows) {
  const body = String(row.latest_message_body || "");
  const before = row.in_priority ? "priority" : row.in_new_replies ? "new_replies" : row.in_follow_up ? "follow_up" : "other";
  let reread = null;
  if (body.trim()) {
    const result = await classify(body, null, {
      heuristicOnly: true,
      conversation_context: {
        canonical_thread: row.thread_key,
        recent_seller_messages: Array.isArray(row.recent_seller_messages) ? row.recent_seller_messages : [],
        property_valuation: row.property_valuation || null,
        last_outbound_body: row.last_outbound_body || null,
      },
    });
    reread = normalizeCanonicalIntent(result?.primary_intent);
  }
  const stored = String(row.last_intent || "").toLowerCase();
  const demote = Boolean(reread) && isNonActionableReplyIntent(reread) && !isNonActionableReplyIntent(stored);
  const intentAfter = demote ? reread : stored;

  // The view-equivalent row (PROPOSED 8.5 predicate) before / after the repair.
  const base = {
    ...row,
    latest_direction: "inbound",
    inbox_bucket: row.inbox_bucket,
    last_outbound_at: row.last_outbound_at ?? null,
  };
  const afterRow = { ...base, last_intent: intentAfter };
  const after = row.in_priority || row.in_new_replies || row.in_follow_up
    ? bucketOf(resolveInboxBucketFlags(afterRow, NOW))
    : "other";
  const heat = resolveCanonicalLeadHeat(afterRow);
  const coolTemperature = heat.temperature_gated === true;
  const clearHot = row.is_hot_lead === true && heat.is_hot_lead === false;

  out.push({
    thread_key: row.thread_key,
    id: row.id,
    latest_message_event_id: row.latest_message_event_id,
    body: body.replace(/\s+/g, " ").slice(0, 120),
    stored_intent: stored || "",
    reread_intent: reread || "",
    write_intent: demote ? reread : "",
    before_bucket: before,
    after_bucket: after,
    recorded_temperature: heat.recorded_lead_temperature || "",
    shown_temperature: heat.lead_temperature || "",
    cool_temperature: coolTemperature,
    clear_hot_flag: clearHot,
    needs_compliance_path: demote && (reread === "opt_out" || reread === "hostile_or_legal"),
  });
}

fs.mkdirSync(outDir, { recursive: true });
const header = Object.keys(out[0] || { thread_key: "" });
fs.writeFileSync(
  path.join(outDir, "rebucket-dryrun.csv"),
  [header.join(","), ...out.map((r) => header.map((k) => csv(r[k])).join(","))].join("\n") + "\n",
);

const writes = out.filter((r) => r.write_intent || r.cool_temperature || r.clear_hot_flag);
const values = writes.map((r) => `    (${sqlText(r.id)}::uuid, ${sqlText(r.latest_message_event_id)}, ${sqlText(r.write_intent || null)}, ${r.cool_temperature}, ${r.clear_hot_flag})`).join(",\n");

const sql = `-- PROPOSED data repair — Inbox Actionability 8.5 re-bucket (generated ${new Date(NOW).toISOString()}).
-- NOT APPLIED. Generated by apps/api/scripts/repair/inbox-actionability-rebucket-20261006.mjs
-- from a read-only export; the dry-run CSV next to this file lists every row.
--
-- Apply only AFTER PROPOSED_20261006235000_inbox_actionability_buckets.sql (the
-- view does the re-bucket itself; this fixes the stored inputs it reads).
-- Per row, compare-and-set on latest_message_event_id: a thread that received
-- a newer message since the export is skipped (its new reply wins).
--   write_intent      last_intent := the current classifier's NON-ACTIONABLE
--                     re-read (demotion only; never a promotion)
--   cool_temperature  lead_temperature/temperature 'hot'|'warm' -> 'cold' when the
--                     latest reply is not a plausible positive one (manual locks skipped)
--   clear_hot_flag    is_hot_lead := false
-- Opt-outs / legal threats the re-read found (needs_compliance_path in the CSV) are NOT suppressed
-- here: run them through the canonical STOP path.
-- Snapshot table (RLS on, anon/authenticated revoked) holds every before-image;
-- rollback: update inbox_thread_state t set last_intent = b.before->>'last_intent',
--   lead_temperature = b.before->>'lead_temperature', temperature = b.before->>'temperature',
--   is_hot_lead = (b.before->>'is_hot_lead')::boolean
--   from public._repair_inbox_actionability_20261006 b where b.row_id = t.id::text;

create table if not exists public._repair_inbox_actionability_20261006 (
  row_id text not null,
  before jsonb not null,
  captured_at timestamptz not null default now()
);
alter table public._repair_inbox_actionability_20261006 enable row level security;
revoke all on public._repair_inbox_actionability_20261006 from anon, authenticated;

do $repair$
declare
  v_commit boolean := false; -- DRY RUN unless flipped to true
  v_intent int;
  v_cooled int;
  v_unhot int;
begin
  create temp table _r (id uuid, latest_message_event_id text, write_intent text, cool boolean, unhot boolean) on commit drop;
  insert into _r values
${values || "    (null::uuid, null, null, false, false)"};

  insert into public._repair_inbox_actionability_20261006 (row_id, before)
  select t.id::text, jsonb_build_object('last_intent', t.last_intent, 'lead_temperature', t.lead_temperature,
         'temperature', t.temperature, 'is_hot_lead', t.is_hot_lead, 'latest_message_event_id', t.latest_message_event_id)
    from public.inbox_thread_state t join _r r on r.id = t.id
   where t.latest_message_event_id::text = r.latest_message_event_id;

  update public.inbox_thread_state t set last_intent = r.write_intent
    from _r r
   where r.id = t.id and r.write_intent is not null
     and t.latest_message_event_id::text = r.latest_message_event_id;
  get diagnostics v_intent = row_count;

  update public.inbox_thread_state t set lead_temperature = 'cold', temperature = 'cold',
         temperature_reason = coalesce(t.temperature_reason || ',', '') || 'REPAIR_8_5_NON_POSITIVE_LATEST_REPLY'
    from _r r
   where r.id = t.id and r.cool
     and t.latest_message_event_id::text = r.latest_message_event_id
     and coalesce(t.manual_temperature_lock, false) = false
     and lower(coalesce(t.temperature_source, '')) <> 'manual'
     and lower(coalesce(t.lead_temperature, t.temperature, '')) in ('hot', 'warm');
  get diagnostics v_cooled = row_count;

  update public.inbox_thread_state t set is_hot_lead = false
    from _r r
   where r.id = t.id and r.unhot and t.is_hot_lead = true
     and t.latest_message_event_id::text = r.latest_message_event_id;
  get diagnostics v_unhot = row_count;

  raise notice 'inbox actionability repair: intent=% cooled=% unhot=% (expected % / % / %)',
    v_intent, v_cooled, v_unhot,
    ${writes.filter((r) => r.write_intent).length}, ${writes.filter((r) => r.cool_temperature).length}, ${writes.filter((r) => r.clear_hot_flag).length};

  if not v_commit then
    raise exception 'DRY RUN — rolled back (set v_commit := true to apply)';
  end if;
end
$repair$;
`;
fs.writeFileSync(path.join(outDir, "rebucket-repair.sql"), sql);

const tally = (key) => out.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] || 0) + 1), acc), {});
const moves = out.reduce((acc, r) => {
  const k = `${r.before_bucket}->${r.after_bucket}`;
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({
  rows: out.length,
  moves,
  demoted_intents: tally("write_intent"),
  cool_temperature: out.filter((r) => r.cool_temperature).length,
  clear_hot_flag: out.filter((r) => r.clear_hot_flag).length,
  needs_compliance_path: out.filter((r) => r.needs_compliance_path).map((r) => r.thread_key),
}, null, 2));
