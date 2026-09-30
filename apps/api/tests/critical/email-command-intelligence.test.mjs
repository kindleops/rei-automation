/**
 * Email Command desktop intelligence — the bounded read-only fields the desk
 * reads: outbox status of the next send, failure class, escalation, origin,
 * market, party/automation lenses, and the per-thread explanation (summary,
 * automation, WHY, truly-linked systems). Nothing here writes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeEmailDb } from "../helpers/email-db-mock.mjs";
import { outboxStatus, classifyFailure, currentFailure, deriveThreadState } from "@/lib/domain/email/email-command-model.js";
import { buildLinks, provenanceOf, actionLabel } from "@/lib/domain/email/email-command-intelligence.js";
import { getEmailCommandHome, getEmailCommandThread } from "@/lib/domain/email/email-command-service.js";

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;

test("outbox status of the next send is read off the row, never inferred", () => {
  assert.equal(outboxStatus(null), null);
  assert.equal(outboxStatus({ queue_status: "sending" }, NOW), "sending", "claimed by the dispatcher");
  assert.equal(outboxStatus({ queue_status: "pending_send", retry_count: 1, next_retry_at: iso(NOW + 300e3), failed_reason: "brevo_timeout" }, NOW), "retrying");
  assert.equal(outboxStatus({ queue_status: "pending_send", retry_count: 0, next_retry_at: iso(NOW + 900e3), failed_reason: "sender_unavailable" }, NOW), "held", "deferred by the safety gate");
  assert.equal(outboxStatus({ queue_status: "scheduled", scheduled_for: iso(NOW + H) }, NOW), "scheduled");
  assert.equal(outboxStatus({ queue_status: "pending_send", scheduled_for: iso(NOW + H) }, NOW), "scheduled", "future pending is planned, not queued");
  assert.equal(outboxStatus({ queue_status: "pending_send", scheduled_for: iso(NOW - 60e3) }, NOW), "queued");
});

test("failure class: what failed, whether anything retries it, whether a person must act", () => {
  const hard = classifyFailure({ queue_status: "bounced", failed_reason: "hard_bounce" }, { events: [{ event_type: "hard_bounce", reason: "mailbox does not exist" }] });
  assert.deepEqual([hard.class, hard.label, hard.retry, hard.operator_must_act], ["delivery", "Hard bounce", "none", true]);
  assert.match(hard.what, /mailbox does not exist/);
  const hardNoEvents = classifyFailure({ queue_status: "bounced", failed_reason: "mailbox does not exist" });
  assert.equal(hardNoEvents.label, "Hard bounce", "queue_status bounced is only ever written for hard bounces");
  const soft = classifyFailure({ queue_status: "failed" }, { events: [{ event_type: "soft_bounce" }] });
  assert.deepEqual([soft.class, soft.operator_must_act], ["delivery", false]);
  const blocked = classifyFailure({ queue_status: "failed" }, { events: [{ event_type: "blocked", reason: "policy" }] });
  assert.equal(blocked.class, "blocked");
  const sup = classifyFailure({ queue_status: "cancelled", cancel_reason: "recipient_suppressed" });
  assert.deepEqual([sup.class, sup.retry], ["suppression", "none"]);
  const unknown = classifyFailure({ queue_status: "failed", failed_reason: "transport_outcome_unknown" });
  assert.deepEqual([unknown.class, unknown.retry, unknown.operator_must_act], ["transport", "none", true]);
  assert.match(unknown.what, /never re-sent automatically/);
  const exhausted = classifyFailure({ queue_status: "failed", failed_reason: "brevo_timeout", retry_count: 3 });
  assert.deepEqual([exhausted.class, exhausted.retry, exhausted.attempts], ["transport", "exhausted", 3]);
  assert.equal(classifyFailure({ queue_status: "failed", failed_reason: "brevo_unauthorized" }).class, "provider");
  assert.equal(classifyFailure({ queue_status: "failed", failed_reason: "stale_scheduled_message" }).class, "blocked");
  const odd = classifyFailure({ queue_status: "failed", failed_reason: "something_new" });
  assert.deepEqual([odd.class, odd.label], ["unknown", "Failed"], "an unrecognised code is never guessed into a class");
});

test("a later successful send clears the current failure", () => {
  const bounced = { id: "a", queue_status: "bounced", failed_reason: "hard_bounce", sent_at: iso(NOW - 5 * H), updated_at: iso(NOW - 5 * H) };
  assert.equal(currentFailure([bounced]).class, "delivery");
  assert.equal(currentFailure([bounced, { id: "b", queue_status: "delivered", sent_at: iso(NOW - H) }]), null);
});

test("thread state carries next-send status, escalation and who wrote the messages", () => {
  const sh = deriveThreadState({ automation_state: "active", last_outbound_at: iso(NOW - H) }, { outbound: [
    { id: "n", queue_status: "pending_send", scheduled_for: iso(NOW - 30e3), source: "seller", action_key: "seller.reply.condition_probe", sequence: 1 },
    { id: "o", queue_status: "sent", sent_at: iso(NOW - H), source: "manual" },
  ] });
  assert.equal(sh.state, "system_handling");
  assert.equal(sh.next.status, "queued");
  assert.deepEqual(sh.origin, { automated: 1, manual: 1 });
  assert.equal(deriveThreadState({ needs_operator: true, needs_code: "title_issue", automation_state: "active" }).escalated, true, "automation handed it to a person");
  assert.equal(deriveThreadState({ needs_operator: true, needs_code: "reply_on_taken_over_thread", automation_state: "taken_over", taken_over_by: "op" }).escalated, false, "the operator already owns it");
  assert.equal(deriveThreadState({ automation_state: "active" }, { outbound: [{ queue_status: "awaiting_approval", approval_status: "required" }] }).escalated, false, "an approval gate is not an escalation");
});

test("action labels and provenance come from the outbox row", () => {
  assert.equal(actionLabel({ action_key: "closing.title_commitment_reminder", sequence: 2 }), "Follow-up #2 · Commitment reminder");
  assert.equal(actionLabel({ action_key: "seller.reply.condition_probe", sequence: 1 }), "Reply to the seller");
  assert.deepEqual(provenanceOf({ source: "closing" }), { kind: "system", label: "Closing Execution", workflow: "closing_execution" });
  assert.deepEqual(provenanceOf({ source: "closing", requested_by: "workflow:title_chaser@3" }), { kind: "workflow", label: "Workflow · Title chaser", workflow: "title_chaser" });
  assert.equal(provenanceOf({ source: "manual" }).kind, "operator");
});

function seed() {
  return {
    email_threads: [
      { id: "t-west", thread_key: "closing:c1:title", category: "title", counterparty_email: "lisa@westtitle.com", counterparty_name: "West Title", counterparty_role: "title", closing_case_id: "c1", property_id: "p1", automation_state: "active", resolution_status: "resolved", needs_operator: false, last_inbound_at: iso(NOW - 20 * H), last_outbound_at: iso(NOW - 44 * H), last_message_at: iso(NOW - 20 * H), last_message_direction: "inbound", reply_token: "a1", inbound_count: 1, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 72 * H) },
      { id: "t-summit", thread_key: "closing:c2:title", category: "title", counterparty_email: "escrow@summit.com", counterparty_name: "Summit Title", counterparty_role: "title", closing_case_id: "c2", property_id: "p2", automation_state: "active", resolution_status: "resolved", needs_operator: true, needs_code: "title_issue", needs_reason: "Title reports open lien", needs_since: iso(NOW - 0.4 * H), last_inbound_at: iso(NOW - 0.4 * H), last_outbound_at: iso(NOW - 30 * H), last_message_at: iso(NOW - 0.4 * H), last_message_direction: "inbound", reply_token: "a2", inbound_count: 1, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 72 * H) },
      { id: "t-karen", thread_key: "seller:mo-9:p9", category: "seller", counterparty_email: "karen@x.com", counterparty_name: "Karen Holt", counterparty_role: "seller", master_owner_id: "mo-9", property_id: "p9", sms_thread_key: "+1555", automation_state: "active", resolution_status: "resolved", needs_operator: false, last_inbound_at: iso(NOW - 0.05 * H), last_outbound_at: iso(NOW - 30 * H), last_message_at: iso(NOW - 0.05 * H), last_message_direction: "inbound", reply_token: "a3", inbound_count: 2, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 72 * H) },
      { id: "t-buyer", thread_key: "closing:c2:buyer", category: "buyer", counterparty_email: "acq@np.com", counterparty_name: "Northpoint", counterparty_role: "buyer", closing_case_id: "c2", property_id: "p2", automation_state: "active", resolution_status: "resolved", needs_operator: false, last_outbound_at: iso(NOW - 5 * H), last_message_at: iso(NOW - 5 * H), last_message_direction: "outbound", reply_token: "a4", inbound_count: 0, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 72 * H) },
      { id: "t-maria", thread_key: "seller:mo-4:p4", category: "seller", counterparty_email: "maria@x.com", counterparty_name: "Maria", counterparty_role: "seller", master_owner_id: "mo-4", property_id: "p4", automation_state: "active", resolution_status: "resolved", needs_operator: false, last_outbound_at: iso(NOW - 26 * H), last_message_at: iso(NOW - 26 * H), last_message_direction: "outbound", reply_token: "a5", inbound_count: 0, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 72 * H) },
      { id: "t-unknown", thread_key: "unresolved:info@leads.com", category: "unresolved", counterparty_email: "info@leads.com", automation_state: "active", resolution_status: "unresolved", resolution_method: "no_match", needs_operator: false, last_inbound_at: iso(NOW - 3 * H), last_message_at: iso(NOW - 3 * H), last_message_direction: "inbound", reply_token: "a6", inbound_count: 1, outbound_count: 0, attachment_count: 0, created_at: iso(NOW - 3 * H) },
    ],
    email_queue: [
      { id: "q-w1", queue_key: "k1", thread_id: "t-west", queue_status: "delivered", sent_at: iso(NOW - 44 * H), source: "closing", action_key: "closing.title_open", sequence: 1, subject: "New title order", to_email: "lisa@westtitle.com", approval_status: "not_required", created_at: iso(NOW - 44 * H) },
      { id: "q-w2", queue_key: "k2", thread_id: "t-west", queue_status: "scheduled", scheduled_for: iso(NOW + 18 * H), source: "closing", action_key: "closing.title_commitment_reminder", sequence: 2, subject: "Re: commitment", to_email: "lisa@westtitle.com", approval_status: "not_required", reason: { why: "Title commitment has not been received", category: "title_commitment", sequence: 2 }, created_at: iso(NOW - H) },
      { id: "q-s1", queue_key: "k3", thread_id: "t-summit", queue_status: "delivered", sent_at: iso(NOW - 30 * H), source: "closing", action_key: "closing.title_open", sequence: 1, subject: "New title order", to_email: "escrow@summit.com", approval_status: "not_required", created_at: iso(NOW - 30 * H) },
      { id: "q-k1", queue_key: "k4", thread_id: "t-karen", queue_status: "delivered", sent_at: iso(NOW - 30 * H), source: "campaign", campaign_id: "Minneapolis seller email", action_key: "campaign.touch", sequence: 1, subject: "Your house", to_email: "karen@x.com", approval_status: "not_required", created_at: iso(NOW - 30 * H) },
      { id: "q-k2", queue_key: "k5", thread_id: "t-karen", queue_status: "pending_send", scheduled_for: iso(NOW - 60e3), source: "seller", requested_by: "seller_brain", action_key: "seller.reply.condition_probe", sequence: 1, subject: "Re: Your house", to_email: "karen@x.com", approval_status: "not_required", reason: { why: "Seller replied by email", use_case: "condition_probe" }, created_at: iso(NOW - 60e3) },
      { id: "q-b1", queue_key: "k6", thread_id: "t-buyer", queue_status: "delivered", sent_at: iso(NOW - 5 * H), source: "closing", campaign_id: "5b8f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b", action_key: "closing.buyer_agreement_followup", sequence: 1, subject: "Assignment agreement", to_email: "acq@np.com", approval_status: "not_required", created_at: iso(NOW - 5 * H) },
      { id: "q-m1", queue_key: "k7", thread_id: "t-maria", queue_status: "bounced", failed_reason: "hard_bounce", sent_at: iso(NOW - 26 * H), updated_at: iso(NOW - 25.9 * H), source: "campaign", campaign_id: "Miami seller email", subject: "Your house on Birch St", to_email: "maria@x.com", approval_status: "not_required", created_at: iso(NOW - 26 * H) },
    ],
    email_events: [
      { event_key: "e1", queue_id: "q-m1", event_type: "hard_bounce", event_at: iso(NOW - 25.9 * H), reason: "mailbox does not exist", direction: "outbound" },
      { event_key: "e2", queue_id: "q-b1", event_type: "delivered", event_at: iso(NOW - 4.9 * H), direction: "outbound" },
    ],
    email_inbound_messages: [
      { id: "in-w", dedupe_key: "w", thread_id: "t-west", from_email: "lisa@westtitle.com", received_at: iso(NOW - 20 * H), processing_status: "handled", classification: { applied: [{ type: "title_acknowledged", ok: true }, { type: "commitment_due", ok: true }] } },
      { id: "in-s", dedupe_key: "s", thread_id: "t-summit", from_email: "escrow@summit.com", received_at: iso(NOW - 0.4 * H), processing_status: "needs_operator", classification: { applied: [{ type: "title_issue", ok: true, value: "open_lien" }] } },
      { id: "in-k1", dedupe_key: "k1", thread_id: "t-karen", from_email: "karen@x.com", received_at: iso(NOW - 26 * H), processing_status: "handled", classification: { primary_intent: "interested", stage_after: "asking_price" } },
      { id: "in-k2", dedupe_key: "k2", thread_id: "t-karen", from_email: "karen@x.com", received_at: iso(NOW - 0.05 * H), processing_status: "handled", classification: { primary_intent: "asking_price_provided", stage_after: "property_condition", next_use_case: "condition_probe", sms_followups_cancelled: 1 } },
      { id: "in-u", dedupe_key: "u", thread_id: "t-unknown", from_email: "info@leads.com", received_at: iso(NOW - 3 * H), processing_status: "unresolved" },
    ],
    closing_cases: [
      { closing_case_id: "c1", property_address: "1201 Oak Grove Dr", title_acknowledged_at: iso(NOW - 20 * H), title_commitment_date: "2026-10-01T00:00:00Z" },
      { closing_case_id: "c2", property_address: "88 Harbor View Rd", title_acknowledged_at: iso(NOW - 28 * H), title_commitment_received_at: iso(NOW - 2 * H), automation_paused_at: iso(NOW - 0.39 * H), automation_paused_reason: "email:title_issue" },
    ],
    closing_activity_events: [],
    inbox_thread_state: [{ thread_key: "+1555", seller_stage: "property_condition", seller_display_name: "Karen Holt", contactability_status: "contactable" }],
    acquisition_opportunities: [],
    properties: [
      { property_id: "p1", property_address_full: "1201 Oak Grove Dr, Dallas, TX", market: "Dallas, TX" },
      { property_id: "p2", property_address_full: "88 Harbor View Rd, Tampa, FL", market: "Tampa, FL" },
      { property_id: "p9", property_address_full: "9 Elm St, Minneapolis, MN", market: "Minneapolis, MN" },
      { property_id: "p4", property_address_full: "22 Birch St, Miami, FL", market: "Miami, FL" },
    ],
    system_control: [{ key: "email_enabled", value: "false" }],
  };
}

test("home: party and automation lenses, market, next-send status and escalation", async () => {
  const h = await getEmailCommandHome({}, { supabase: makeEmailDb(seed()) });
  assert.equal(h.ok, true);
  assert.deepEqual(h.parties, { seller: 2, buyer: 1, title: 2, closings: 3 });
  assert.equal(h.automation_counts.escalated, 1, "the title issue was escalated by automation");
  assert.equal(h.automation_counts.manual, 0);
  const west = h.system_handling.find((t) => t.id === "t-west");
  assert.equal(west.market, "Dallas, TX");
  assert.equal(west.next.status, "scheduled");
  assert.equal(h.system_handling.find((t) => t.id === "t-karen").next.status, "queued", "the seller reply is waiting for the dispatcher");
  const maria = h.failed.find((t) => t.id === "t-maria");
  assert.equal(maria.failure.class, "delivery");
  assert.equal(h.needs_you[0].escalated, true);
});

test("room WHY: scheduled closing follow-up explains itself from the closing case and the outbox row", async () => {
  const r = await getEmailCommandThread("t-west", { supabase: makeEmailDb(seed()) });
  const w = r.intelligence.why;
  assert.equal(w.title, "Why follow-up #2 is scheduled");
  const text = w.lines.map((l) => l.text);
  assert.ok(text.includes("Title commitment has not been received"), "the planner's own reason, verbatim");
  assert.ok(text.includes("Title acknowledged the order {at}"));
  assert.ok(text.includes("Commitment due Thu, Oct 1 — not yet delivered"));
  assert.ok(text.includes("Closing cadence active"));
  const nextLine = w.lines.find((l) => l.text.startsWith("Follow-up #2"));
  assert.equal(nextLine.fmt, "until");
  assert.equal(nextLine.at, seed().email_queue.find((q) => q.id === "q-w2").scheduled_for);
  assert.ok(text.includes("It is cancelled automatically if title replies first"), "a chase is superseded by a reply (send-safety)");
  assert.ok(text.includes("Email sending is off — it waits until sending is turned on"), "the kill switch is stated, not hidden");
  assert.equal(r.intelligence.automation.mode, "system_handling");
  assert.equal(r.intelligence.automation.armed[0].status, "scheduled");
  assert.equal(r.intelligence.automation.send_enabled, false);
  assert.equal(r.intelligence.property.market, "Dallas, TX");
  assert.equal(r.intelligence.summary.sentiment, null, "sentiment is not recorded — withheld");
  const systems = r.intelligence.links.map((l) => l.system);
  assert.deepEqual(systems, ["closing_desk", "workflow_studio", "entity_graph"]);
  assert.equal(r.intelligence.links[0].href, "/closing-desk?case=c1");
  assert.equal(r.intelligence.links[1].href, "/workflow-studio?wf=closing_execution");
});

test("room WHY: a title issue explains why the system did not reply", async () => {
  const r = await getEmailCommandThread("t-summit", { supabase: makeEmailDb(seed()) });
  const w = r.intelligence.why;
  assert.equal(w.title, "Why the system did not reply");
  const text = w.lines.map((l) => l.text);
  assert.match(text[0], /liens, judgments and vesting problems always go to a person/);
  assert.ok(text.includes("Closing automation paused {at}"));
  assert.ok(text.includes("Nothing is queued to send"));
  assert.equal(r.intelligence.automation.mode, "escalated");
  assert.equal(r.intelligence.summary.intent.label, "Title issue");
  assert.equal(r.intelligence.summary.stage.label, "Clear to close");
});

test("room WHY: LeadCommand replying to a seller — intent, stage movement only with evidence, one brain", async () => {
  const r = await getEmailCommandThread("t-karen", { supabase: makeEmailDb(seed()) });
  const w = r.intelligence.why;
  assert.equal(w.title, "Why LeadCommand is replying");
  const text = w.lines.map((l) => l.text);
  assert.ok(text.includes("Understood as asking price provided"));
  assert.ok(text.includes("Stage set to S4 Condition"));
  assert.ok(text.includes("Pending SMS follow-up stopped — one conversation, two channels"));
  assert.ok(text.includes("Any seller reply — SMS or email — cancels it before it sends"));
  const s = r.intelligence.summary;
  assert.deepEqual([s.stage.label, s.stage.moved, s.stage.from], ["S4 Condition", "moved", "S3 Asking price"], "two recorded replies prove the move");
  assert.equal(s.intent.source, "Seller brain");
  assert.equal(s.channel.sms_linked, true);
  const systems = r.intelligence.links.map((l) => l.system);
  assert.ok(systems.includes("inbox") && systems.includes("deal_intelligence"));
  assert.ok(!systems.includes("campaign_command"), "a campaign label that is not a campaign id is never linked");
  const di = r.intelligence.links.find((l) => l.system === "deal_intelligence").href;
  assert.equal(di, "/deal-intelligence?thread_key=%2B1555&property_id=p9&master_owner_id=mo-9", "Deal Intelligence reads thread_key / property_id / master_owner_id");
  const wf = r.intelligence.links.filter((l) => l.system === "workflow_studio").map((l) => l.href).sort();
  assert.deepEqual(wf, ["/workflow-studio?wf=campaign_execution", "/workflow-studio?wf=seller_inbound"]);
});

test("room: a single reply never claims the stage moved", async () => {
  const db = makeEmailDb(seed());
  db.state.email_inbound_messages = db.state.email_inbound_messages.filter((m) => m.id !== "in-k1");
  const r = await getEmailCommandThread("t-karen", { supabase: db });
  assert.equal(r.intelligence.summary.stage.moved, null);
  assert.equal(r.intelligence.summary.stage.from, null);
});

test("room: waiting, failed and unresolved explain themselves; links only where truly linked", async () => {
  const db = makeEmailDb(seed());
  const buyer = await getEmailCommandThread("t-buyer", { supabase: db });
  assert.equal(buyer.intelligence.why.title, "Why we’re waiting");
  assert.ok(buyer.intelligence.why.lines.some((l) => l.text === "Buyer has the ball"));
  assert.ok(buyer.intelligence.links.some((l) => l.system === "campaign_command" && l.href === "/campaign-command?campaign=5b8f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"), "a real campaign id is linked");
  assert.ok(buyer.intelligence.links.some((l) => l.system === "buyer_match" && l.href === "/buyer-match?property_id=p2"));

  const maria = await getEmailCommandThread("t-maria", { supabase: db });
  assert.equal(maria.thread.state, "failed");
  assert.equal(maria.thread.failure.label, "Hard bounce");
  assert.match(maria.thread.failure.what, /mailbox does not exist/, "the room classifies from the provider event");
  const lines = maria.intelligence.why.lines.map((l) => l.text);
  assert.ok(lines.includes("No automatic retry for this kind of failure"));
  assert.ok(lines.includes("Next step: Find another address or call"));
  const out = maria.items.find((i) => i.kind === "outbound");
  assert.equal(out.failure.class, "delivery");
  assert.equal(out.provenance.label, "Campaign Execution");

  const unknown = await getEmailCommandThread("t-unknown", { supabase: db });
  assert.equal(unknown.intelligence.why.title, "Why this is unresolved");
  assert.ok(unknown.intelligence.why.lines.some((l) => l.text === "Automation never replies to an unidentified sender"));
  assert.deepEqual(unknown.intelligence.links, [], "no ids, no links");
  assert.equal(unknown.intelligence.automation.mode, "off");
});

test("links never invent a destination", () => {
  const links = buildLinks({ thread: { category: "other" }, summary: {}, outbound: [{ source: "manual", campaign_id: "not-a-uuid" }] });
  assert.deepEqual(links, []);
});
