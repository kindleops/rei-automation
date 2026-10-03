#!/usr/bin/env node
/**
 * SENDER ROUTING 2.0 — inbound round-trip PROOF for a new number. READ-ONLY.
 * This script sends NOTHING. The OWNER sends the test text.
 *
 * Procedure (owner brief §B: production-ready only after a REAL controlled
 * inbound round-trip):
 *   0. Owner sets the provider SMS webhook to
 *      https://ops.leadcommand.ai/api/webhooks/textgrid/inbound (TextGrid console).
 *      inventory-reconcile.mjs must show the number CONFIGURED_UNVERIFIED.
 *   1. Run onboard-indianapolis-tampa.sql step=configuring (owner, committed).
 *   2. From the owner's own phone (NOT a seller), text the new number, e.g.
 *      "LC inbound proof <number> <time>". Note the time.
 *   3. Run:
 *        node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/inbound-proof.mjs \
 *          --number=+13173494612 --sender=+1XXXXXXXXXX --since=2026-10-03T15:00:00Z
 *   4. All five checks PASS -> run step=inbound_verified with -v proof_at=<printed>.
 *      Any FAIL -> the number stays CONFIGURING; fix and re-test.
 *
 * Checks:
 *   webhook_reached   an inbound message_events row TO the number since --since
 *   thread_resolves   inbox_thread_state row for that thread
 *   identity_kept     thread our_number is the new number and the thread key is the
 *                     sender's phone (no sender rewrite, no identity split)
 *   seller_matching   the pipeline recorded a contact resolution outcome on the event or
 *                     thread (matched owner/property, or explicitly none for an unknown
 *                     test phone — reported, not faked)
 *   inbox_receives    the thread is visible to the Inbox read model (v_inbox_thread_state_buckets)
 * Also reported: any auto-reply queued to the test phone since --since (expected none).
 */
import { readOnlyClient, arg, writeOut } from "./_readonly.mjs";
import { normalizeE164, maskPhone } from "../../../src/lib/domain/routing/sender-routing/sender-routing-policy.js";

const number = normalizeE164(arg("number"));
const sender = normalizeE164(arg("sender")) || null;
const since = arg("since") || new Date(Date.now() - 2 * 3600_000).toISOString();
if (!number) {
  console.error("--number=<E.164> required");
  process.exit(2);
}
const sb = readOnlyClient();
const checks = [];
const check = (name, pass, detail) => checks.push({ name, result: pass === null ? "INFO" : pass ? "PASS" : "FAIL", detail });

let q = sb.from("message_events").select("id,thread_key,from_phone_number,to_phone_number,direction,created_at,received_at,master_owner_id,property_id,prospect_id,auto_reply_status").eq("to_phone_number", number).eq("direction", "inbound").gte("created_at", since).order("created_at", { ascending: true }).limit(20);
if (sender) q = q.eq("from_phone_number", sender);
const { data: events, error } = await q;
if (error) throw new Error(error.message);
const ev = (events || [])[0] || null;
check("webhook_reached", Boolean(ev), ev ? `event ${String(ev.id).slice(0, 8)} at ${ev.created_at} from ${maskPhone(ev.from_phone_number)}` : `no inbound message_events to ${maskPhone(number)} since ${since}`);

let thread = null;
if (ev?.thread_key) {
  const { data } = await sb.from("inbox_thread_state").select("thread_key,our_number,master_owner_id,property_id,prospect_id,last_inbound_at").eq("thread_key", ev.thread_key).maybeSingle();
  thread = data || null;
}
check("thread_resolves", Boolean(thread), thread ? `thread ${maskPhone(thread.thread_key)} last_inbound_at ${thread.last_inbound_at}` : "no inbox_thread_state row for the event's thread");

const ourOk = thread ? normalizeE164(thread.our_number) === number : false;
const keyOk = ev ? normalizeE164(ev.thread_key) === normalizeE164(ev.from_phone_number) : false;
check("identity_kept", Boolean(ev && thread && ourOk && keyOk), thread ? `our_number ${maskPhone(thread.our_number)} (${ourOk ? "is" : "is NOT"} the new number); thread key ${keyOk ? "=" : "!="} sender phone` : "no thread");

const matched = ev && (ev.master_owner_id || ev.property_id || ev.prospect_id || thread?.master_owner_id || thread?.property_id);
check("seller_matching", ev ? (matched ? true : null) : false, ev ? (matched ? `matched owner ${thread?.master_owner_id || ev.master_owner_id || "-"} property ${thread?.property_id || ev.property_id || "-"}` : "no owner/property on the event or thread (expected for the owner's own test phone: unknown-contact routing). Confirm in Inbox that it is shown as an unknown contact, not merged into a seller.") : "no event");

let visible = false;
if (ev?.thread_key) {
  const { data } = await sb.from("v_inbox_thread_state_buckets").select("thread_key").eq("thread_key", ev.thread_key).limit(1);
  visible = (data || []).length > 0;
}
check("inbox_receives", visible, visible ? "thread present in v_inbox_thread_state_buckets" : "thread not in the Inbox read model");

if (ev?.from_phone_number) {
  const { data } = await sb.from("send_queue").select("id,queue_status,created_at").eq("to_phone_number", ev.from_phone_number).gte("created_at", since).limit(10);
  check("no_auto_reply_to_test_phone", null, `${(data || []).length} send_queue rows to the test phone since ${since}${(data || []).length ? ": " + data.map((r) => `${String(r.id).slice(0, 8)}:${r.queue_status}`).join(", ") : ""}`);
}

const required = ["webhook_reached", "thread_resolves", "identity_kept", "inbox_receives"];
const pass = required.every((n) => checks.find((c) => c.name === n)?.result === "PASS") && checks.find((c) => c.name === "seller_matching")?.result !== "FAIL";
for (const c of checks) console.log(`${c.result.padEnd(4)} ${c.name.padEnd(28)} ${c.detail}`);
console.log(pass ? `\nPROOF PASSED. Next: onboard-indianapolis-tampa.sql -v step=inbound_verified -v proof_at="'${ev.created_at}'"` : "\nPROOF NOT PASSED. The number stays CONFIGURING.");
writeOut(arg("out"), { number: maskPhone(number), since, pass, proof_at: pass ? ev.created_at : null, checks });
process.exit(pass ? 0 : 1);
