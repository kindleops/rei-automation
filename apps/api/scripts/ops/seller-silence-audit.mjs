#!/usr/bin/env node
/**
 * SELLER SILENCE AUDIT + SALVAGE  (operator items 14 and 19)
 *
 * THE INVARIANT: no production state may be
 *   processed inbound + seller still active + no reply + no pending recovery
 *   + no intentional terminal suppression + silence forever.
 *
 * Required output: ACTIVE_UNANSWERED_WITHOUT_PENDING_RECOVERY = 0.
 *
 * An upstream DECISION row is never counted as a reply (operator item 6):
 * seller_automation_decisions is written PRE-execution and reported 0 replies
 * queued out of 68 while replies were in fact going out. Only durable
 * queue/message records count here.
 *
 *   node --env-file=.env.local --import ./scripts/register-aliases-ops.mjs \
 *        scripts/ops/seller-silence-audit.mjs [--hours 168] [--salvage] [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import { processSellerInboundMessage } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

const args = process.argv.slice(2);
const HOURS = Number(args[args.indexOf("--hours") + 1]) || 168;
const SALVAGE = args.includes("--salvage");
const APPLY = args.includes("--apply");

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const since = new Date(Date.now() - HOURS * 3600_000).toISOString();
const say = (s) => process.stdout.write(`${s}\n`);

// Intents where silence is the CORRECT outcome. Everything else that goes
// unanswered is silence we did not choose.
const TERMINAL_INTENTS = new Set([
  "opt_out", "wrong_number", "sold_property", "hostile_or_legal", "do_not_contact",
]);
const ANSWERED_STATUSES = new Set(["sent", "delivered"]);
const PENDING_STATUSES = new Set([
  "queued", "pending", "scheduled", "ready", "locked", "processing",
]);

async function main() {
  const { data: inbound, error } = await supabase
    .from("inbound_processing_ledger")
    .select("id, thread_key, received_at, status, detected_intent, confidence, terminal_disposition, disposition_detail")
    .gte("received_at", since)
    .order("received_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`inbound_processing_ledger: ${error.message}`);

  const threads = [...new Set((inbound || []).map((r) => r.thread_key).filter(Boolean))];
  if (!threads.length) { say("no inbound in window"); return; }

  const [{ data: sq }, { data: sup }] = await Promise.all([
    supabase.from("send_queue")
      .select("id, thread_key, to_phone_number, queue_status, created_at, sent_at, message_body, metadata")
      .in("to_phone_number", threads).gte("created_at", since).limit(5000),
    supabase.from("sms_suppression_list")
      .select("phone_e164, is_active").in("phone_e164", threads).limit(5000),
  ]);

  const suppressed = new Set((sup || []).filter((r) => r.is_active !== false).map((r) => r.phone_e164));
  const byThread = new Map();
  for (const r of sq || []) {
    const k = r.to_phone_number || r.thread_key;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(r);
  }

  const rows = [];
  for (const ib of inbound || []) {
    const intent = String(ib.detected_intent || "").toLowerCase();
    const detail = ib.disposition_detail || {};
    const terminalIntent = TERMINAL_INTENTS.has(intent);
    const intentionallySilent =
      terminalIntent ||
      detail.no_reply_intentional === true ||
      String(ib.terminal_disposition || "").startsWith("suppressed_");
    const isSuppressed = suppressed.has(ib.thread_key);

    const after = (byThread.get(ib.thread_key) || []).filter(
      (r) => new Date(r.created_at) >= new Date(ib.received_at)
    );
    const answered = after.some((r) => ANSWERED_STATUSES.has(r.queue_status));
    const pending = after.some((r) => PENDING_STATUSES.has(r.queue_status));
    const failedRecoverable = after.some(
      (r) => r.queue_status === "failed_transport" &&
             r.metadata?.retry_allowed !== false
    );

    rows.push({
      id: ib.id, thread: ib.thread_key, at: ib.received_at, intent,
      disposition: ib.terminal_disposition,
      answered, pending, failedRecoverable,
      active: !isSuppressed && !terminalIntent,
      intentionallySilent,
      violation: !isSuppressed && !intentionallySilent && !answered && !pending,
    });
  }

  const total = rows.length;
  const answered = rows.filter((r) => r.answered).length;
  const pending = rows.filter((r) => !r.answered && r.pending).length;
  const intentional = rows.filter((r) => !r.answered && !r.pending && r.intentionallySilent).length;
  const violations = rows.filter((r) => r.violation);
  const recoverable = violations.filter((r) => r.failedRecoverable);

  say("");
  say(`SELLER SILENCE AUDIT   window=${HOURS}h   since=${since}`);
  say(`  inbound processed .......................... ${total}`);
  say(`  reply_sent (durable queue/message truth) ... ${answered}  (${total ? ((answered / total) * 100).toFixed(1) : "0.0"}%)`);
  say(`  reply_pending_recovery ..................... ${pending}`);
  say(`  intentional_terminal_suppression ........... ${intentional}`);
  say(`  ACTIVE_UNANSWERED_WITHOUT_PENDING_RECOVERY . ${violations.length}   ${violations.length === 0 ? "PASS" : "FAIL"}`);
  say(`     of which transport-failed (recoverable) . ${recoverable.length}`);

  if (violations.length) {
    say("");
    say("  VIOLATIONS:");
    for (const v of violations.slice(0, 40)) {
      say(`    ${String(v.at).slice(0, 19)}  ${v.thread.padEnd(14)} intent=${(v.intent || "?").padEnd(22)} disposition=${v.disposition || "-"}`);
    }
    if (violations.length > 40) say(`    ... and ${violations.length - 40} more`);
  }

  if (SALVAGE) {
    say("");
    say(`SALVAGE  (${APPLY ? "APPLY" : "DRY RUN"})`);
    const candidates = [...new Map(violations.map((v) => [v.thread, v])).values()];
    for (const c of candidates) {
      say(`  ${c.thread.padEnd(14)} last_inbound=${String(c.at).slice(0, 19)} intent=${c.intent}`);
    }
    say(`  ${candidates.length} distinct threads eligible.`);
    say("");

    for (const c of candidates) {
      // Re-drive the seller's OWN last message through the canonical decision
      // and send path. Nothing bespoke: same code that will handle the next
      // live inbound, so a salvage cannot diverge from production behaviour.
      const { data: last } = await supabase
        .from("message_events")
        .select("id, message_body, created_at, thread_key, from_phone_number, to_phone_number")
        .eq("thread_key", c.thread).eq("direction", "inbound")
        .order("created_at", { ascending: false }).limit(1);
      const msg = (last || [])[0];
      if (!msg?.message_body) { say(`  ${c.thread}  SKIP no_inbound_body`); continue; }

      try {
        const res = await processSellerInboundMessage({
          message: msg.message_body,
          threadKey: c.thread,
          inboundFrom: msg.from_phone_number || c.thread,
          inboundTo: msg.to_phone_number || "",
          inboundEventId: msg.id,
          inboundReceivedAt: msg.created_at,
          supabaseClient: supabase,
          // Suppression is re-checked inside; STOP/DNC and terminal declines
          // can never be resurrected by this path.
          applySuppression: true,
          // The webhook supplies this; without it the orchestrator resolves
          // `disabled` and every dry run reports auto_reply_mode_disabled,
          // which tells you nothing about real behaviour.
          autoReplyMode: process.env.SALVAGE_AUTO_REPLY_MODE || "live_limited",
          dryRun: !APPLY,
        });
        const q = res?.reply?.queued ?? res?.seller_stage_reply?.queued ?? false;
        const reason = res?.reply?.reason ?? res?.seller_stage_reply?.reason ?? res?.reason ?? "-";
        say(`  ${c.thread.padEnd(14)} ${APPLY ? "APPLIED" : "DRY   "} queued=${q} reason=${reason}`);
      } catch (e) {
        say(`  ${c.thread.padEnd(14)} ERROR ${e?.message || e}`);
      }
    }
    if (!APPLY) say("\n  dry run only; pass --apply to actually resume.");
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
