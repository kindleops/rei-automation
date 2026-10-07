// Opt-out / legal sweep (2026-10-06) — DRY RUN BY DEFAULT.
//
// Why: three threads ("Ya quita mi número de tus contactos", "Mejor te
// blokeo...", "Chinga tu madre qlex") told us to stop or were hostile, the
// classifier of the day read them as `unclear`, and they are still
// is_suppressed=false — a future campaign could text them.
//
// What it does:
//   1. READ-ONLY replay: every inbound message since --since (default
//      2026-09-01) is re-read with the CURRENT classifier (classify.js,
//      heuristic only: no AI, no network).
//   2. A thread is listed when any of its replies is an opt-out (any language;
//      opt_out intent or compliance_flag stop_texting) or a hostile_or_legal
//      message, and it is NOT fully suppressed today.
//   3. --apply runs, per listed thread, the SAME canonical calls the live
//      inbound path makes for that intent — no hand-written UPDATEs:
//        a. resolveSellerStageTransition  (the blocking-intent hold: contactability,
//           operational status, next action, disposition)
//        b. patchUniversalLeadState       (+ buildInboundSuppressionEvidence; the
//           only writer of contactability / is_suppressed)
//        c. applyInboundSuppression       (opt-out only: sms_suppression_list, what
//           campaign eligibility reads — live applies it for opt-outs only)
//        d. cancelSupabasePendingOutbound (COMPLIANCE_TERMINAL, every pending send)
//      exactly as process-seller-inbound-message.js / apply-inbound-automation-
//      decision.js do on a live STOP.
//
// Hostile replies: the live path writes do_not_text for every hostile_or_legal
// intent, but the owner decided on 2026-10-01 that an insult WITHOUT opt-out or
// legal language is "archive / cool, no automatic nurture, no DNC". So insult-
// only rows (classifier rule ids hostile_insult_no_opt_out / hostile_profanity /
// emoji_hostile*) are LISTED with action review_hostile_insult and are only
// suppressed with --include-hostile-insults. Legal threats are always included.
//
// A seller who wrote something positive AFTER the opt-out is still suppressed
// (a binding opt-out is never auto-resumed: latest-intent-precedence.js) and is
// flagged later_positive_reply=true for a human.
//
// Usage (from apps/api). The owner runs --apply with auto mode OFF.
//   DATABASE_URL=... node --import ./scripts/register-aliases-ops.mjs \
//     scripts/repair/optout-sweep-20261006.mjs --out=<dir> [--since=2026-09-01]
//   ... --apply --confirm=optout-sweep-20261006 [--include-hostile-insults]
//     (--apply also needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
// --db-url-file=<path> may replace DATABASE_URL. The CSV contains phone numbers:
// write it OUTSIDE the repo.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { classify, CLASSIFY_VERSION } from "@/lib/domain/classification/classify.js";
import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
import { isPositiveReplyIntent } from "@/lib/domain/inbox/reply-actionability.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const SINCE = String(args.since || "2026-09-01");
const OUT = args.out ? String(args.out) : null;
const APPLY = args.apply === true;
const INCLUDE_INSULTS = args["include-hostile-insults"] === true;
const SWEEP_ID = "optout-sweep-20261006";

if (!OUT) {
  console.error("--out=<dir> is required (outside the repo: the CSV contains phone numbers)");
  process.exit(2);
}
if (APPLY && args.confirm !== SWEEP_ID) {
  console.error(`--apply requires --confirm=${SWEEP_ID}`);
  process.exit(2);
}

const HOSTILE_INSULT_RULE_IDS = new Set([
  "hostile_insult_no_opt_out",
  "hostile_profanity",
  "emoji_hostile",
  "emoji_hostile_with_text",
]);
const BLOCKING_CONTACTABILITY = new Set(["opted_out", "dnc", "do_not_text", "legal_hold", "suppressed"]);
const PENDING = ["scheduled", "queued", "pending", "approved", "ready", "processing", "sending"];

// ── 1. read (one read-only transaction) ─────────────────────────────────────
const dbUrl = process.env.DATABASE_URL || (args["db-url-file"] ? fs.readFileSync(String(args["db-url-file"]), "utf8").trim() : "");
if (!dbUrl) {
  console.error("DATABASE_URL or --db-url-file is required (read-only replay)");
  process.exit(2);
}
const pg = createRequire(import.meta.url)("pg");
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
let messages;
let threads;
try {
  await client.query("begin read only");
  await client.query("set local statement_timeout = '30s'");
  messages = (await client.query(
    `select id::text, thread_key, message_body, created_at
       from public.message_events
      where direction = 'inbound' and created_at >= $1::timestamptz and thread_key is not null
      order by thread_key, created_at`,
    [SINCE],
  )).rows;
  const keys = [...new Set(messages.map((m) => m.thread_key))];
  threads = (await client.query(
    `select t.thread_key, t.is_suppressed, t.contactability_status, t.seller_stage, t.lead_temperature,
            t.disposition, t.master_owner_id, t.property_id, t.prospect_id, t.is_archived,
            exists (select 1 from public.sms_suppression_list s
                     where s.phone_e164 = t.thread_key and s.is_active is distinct from false) as list_active,
            (select count(*) from public.send_queue q
              where q.thread_key = t.thread_key and lower(q.queue_status) = any ($2::text[]))::int as pending_sends
       from public.inbox_thread_state t
      where t.thread_key = any ($1::text[])`,
    [keys, PENDING],
  )).rows;
  await client.query("commit");
} finally {
  await client.end();
}
const threadByKey = new Map(threads.map((t) => [t.thread_key, t]));

// ── 2. replay with the current classifier ───────────────────────────────────
const byThread = new Map();
for (const m of messages) {
  if (!byThread.has(m.thread_key)) byThread.set(m.thread_key, []);
  byThread.get(m.thread_key).push(m);
}

const rows = [];
let replayed = 0;
for (const [threadKey, list] of byThread) {
  const reads = [];
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const body = String(m.message_body || "");
    if (!body.trim()) continue;
    const prior = list.slice(0, i).reverse().map((p) => String(p.message_body || "")).filter(Boolean).slice(0, 10);
    const result = await classify(body, null, {
      heuristicOnly: true,
      conversation_context: { canonical_thread: threadKey, recent_seller_messages: prior },
    });
    replayed += 1;
    const intent = normalizeCanonicalIntent(result?.primary_intent);
    const ruleIds = (Array.isArray(result?.matched_rule_ids) ? result.matched_rule_ids : []).map((r) => String(r).toLowerCase());
    const optOut = intent === "opt_out" || String(result?.compliance_flag || "") === "stop_texting";
    reads.push({ m, intent: optOut ? "opt_out" : intent, ruleIds, optOut, matched_phrase: result?.matched_phrase || null });
  }
  const hits = reads.filter((r) => r.optOut || r.intent === "hostile_or_legal");
  if (!hits.length) continue;
  // The strongest compliance message wins: an opt-out over a hostile reply.
  const hit = hits.find((r) => r.optOut) || hits[hits.length - 1];
  const t = threadByKey.get(threadKey) || {};
  const threadSuppressed = t.is_suppressed === true || BLOCKING_CONTACTABILITY.has(String(t.contactability_status || "").toLowerCase());
  const insultOnly = !hit.optOut && hit.ruleIds.some((r) => HOSTILE_INSULT_RULE_IDS.has(r)) && !hit.ruleIds.includes("hostile_legal_threat");
  // Fully suppressed = what the live path would have left behind for this intent.
  const fully = hit.optOut ? threadSuppressed && t.list_active === true : threadSuppressed;
  if (fully) continue;
  const laterPositive = reads.some((r) => r.m.created_at > hit.m.created_at && isPositiveReplyIntent(r.intent));
  const action = hit.optOut ? "suppress_opt_out"
    : insultOnly && !INCLUDE_INSULTS ? "review_hostile_insult"
      : "suppress_hostile_or_legal";
  rows.push({
    thread_key: threadKey,
    message_event_id: hit.m.id,
    message_at: new Date(hit.m.created_at).toISOString(),
    body: String(hit.m.message_body || "").replace(/\s+/g, " ").slice(0, 160),
    replay_intent: hit.intent,
    rule_ids: hit.ruleIds.join("|"),
    thread_is_suppressed: t.is_suppressed === true,
    contactability_status: t.contactability_status || "",
    sms_suppression_list_active: t.list_active === true,
    pending_sends: Number(t.pending_sends || 0),
    is_archived: t.is_archived === true,
    later_positive_reply: laterPositive,
    action,
    thread_state_missing: !threadByKey.has(threadKey),
    _hit: hit,
    _thread: t,
  });
}

// ── 3. apply (canonical path) ───────────────────────────────────────────────
const results = new Map();
if (APPLY) {
  const { getDefaultSupabaseClient } = await import("@/lib/supabase/default-client.js");
  const { resolveSellerStageTransition } = await import("@/lib/domain/seller-flow/resolve-seller-stage-transition.js");
  const { decisionToUniversalLeadStatePatch } = await import("@/lib/domain/seller-flow/seller-flow-decision-contract.js");
  const { patchUniversalLeadState } = await import("@/lib/domain/lead-state/patch-universal-lead-state.js");
  const { buildInboundSuppressionEvidence } = await import("@/lib/domain/lead-state/suppression-evidence.js");
  const { STATE_SOURCE_CODES } = await import("@/lib/domain/lead-state/universal-lead-state-registry.js");
  const { applyInboundSuppression } = await import("@/lib/domain/seller-flow/apply-inbound-automation-decision.js");
  const { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } = await import("@/lib/domain/queue/cancel-supabase-pending-outbound.js");
  const supabase = getDefaultSupabaseClient();
  if (!supabase) {
    console.error("--apply needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  for (const row of rows) {
    if (row.action === "review_hostile_insult" || row.thread_state_missing) continue;
    const { _hit: hit, _thread: t } = row;
    const intent = hit.optOut ? "opt_out" : "hostile_or_legal";
    const out = {};
    // a. the live blocking hold for this intent
    const transition = resolveSellerStageTransition({
      stage_before: t.seller_stage || null,
      intent,
      current_temperature: t.lead_temperature || null,
      current_disposition: t.disposition || null,
      source_message_id: hit.m.id,
    });
    // Blocking intents never move the stage (stage_after === stage_before), so
    // the stage is left out: a thread with no recorded stage is not given one.
    const patch = decisionToUniversalLeadStatePatch({
      operational_status: transition.operational_status,
      disposition: transition.disposition,
      contactability: transition.contactability_patch?.contactability_status || null,
      next_action: transition.next_action,
    });
    // b. contactability / is_suppressed (evidence-gated, audited)
    out.lead_state = await patchUniversalLeadState({
      threadKey: row.thread_key,
      patch,
      supabase,
      dryRun: false,
      meta: {
        change_source: STATE_SOURCE_CODES.AUTOPILOT,
        source_view: SWEEP_ID,
        reason: transition.reasoning_code,
        message_event_id: hit.m.id,
        classifier_version: `${CLASSIFY_VERSION}:heuristic`,
        resolver_version: transition.resolver_version || null,
        transition_reason: transition.reasoning_code || null,
        prospect_id: t.prospect_id || null,
        suppression_evidence: buildInboundSuppressionEvidence({
          intent,
          source_event_id: hit.m.id,
          rule_version: `${CLASSIFY_VERSION}:heuristic`,
          matched_phrase: hit.matched_phrase,
        }),
        metadata: { reasoning_code: transition.reasoning_code, sweep: SWEEP_ID },
      },
    });
    // c. the phone-level list campaigns read (live: opt-outs only)
    if (hit.optOut) {
      out.suppression_list = await applyInboundSuppression({
        supabaseClient: supabase,
        phoneNumber: row.thread_key,
        ownerId: t.master_owner_id || null,
        reason: "opt_out",
        threadKey: row.thread_key,
        dryRun: false,
      });
    }
    // d. every pending send to this seller
    out.queue_cancellation = await cancelSupabasePendingOutbound(
      {
        thread_key: row.thread_key,
        to_phone_number: row.thread_key,
        prospect_id: t.prospect_id || null,
        master_owner_id: t.master_owner_id || null,
        property_id: t.property_id || null,
        policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
        reason: "inbound_compliance_suppression",
        suppression_reason: intent === "opt_out" ? "opt_out" : "hostile_or_legal",
        inbound_event_id: hit.m.id,
        cancelled_by: SWEEP_ID,
      },
      { supabase },
    );
    results.set(row.thread_key, out);
  }
}

// ── 4. report ───────────────────────────────────────────────────────────────
const cols = [
  "thread_key", "message_event_id", "message_at", "body", "replay_intent", "rule_ids",
  "thread_is_suppressed", "contactability_status", "sms_suppression_list_active", "pending_sends",
  "is_archived", "later_positive_reply", "action", "thread_state_missing", "applied",
];
const csv = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, "optout-sweep.csv");
fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => {
  const res = results.get(r.thread_key);
  const applied = !APPLY ? "dry_run"
    : res ? JSON.stringify({
      lead_state: res.lead_state?.ok ?? res.lead_state?.reason ?? null,
      list: res.suppression_list ? res.suppression_list.ok : "n/a",
      cancelled: res.queue_cancellation?.cancelled ?? null,
    })
      : "skipped";
  return cols.map((c) => csv(c === "applied" ? applied : r[c])).join(",");
})].join("\n") + "\n");

const count = (fn) => rows.filter(fn).length;
console.log(JSON.stringify({
  mode: APPLY ? "apply" : "dry_run",
  since: SINCE,
  inbound_messages_replayed: replayed,
  threads_replayed: byThread.size,
  listed_threads: rows.length,
  suppress_opt_out: count((r) => r.action === "suppress_opt_out"),
  suppress_hostile_or_legal: count((r) => r.action === "suppress_hostile_or_legal"),
  review_hostile_insult: count((r) => r.action === "review_hostile_insult"),
  opt_out_missing_list_row_only: count((r) => r.action === "suppress_opt_out" && r.thread_is_suppressed && !r.sms_suppression_list_active),
  with_pending_sends: count((r) => r.pending_sends > 0),
  later_positive_reply: count((r) => r.later_positive_reply),
  archived: count((r) => r.is_archived),
  csv: file,
}, null, 2));
