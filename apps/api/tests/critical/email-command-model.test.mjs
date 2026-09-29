/**
 * Email Command operating model + operator actions (§9–13, §37, §38, §46, §56, §72–73).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeEmailDb } from "../helpers/email-db-mock.mjs";
import { deriveThreadState, deliveryStatus, engagementFromEvents, closingContext } from "@/lib/domain/email/email-command-model.js";
import { getEmailCommandHome, getEmailCommandThread, applyEmailThreadAction, getEmailMessageTelemetry } from "@/lib/domain/email/email-command-service.js";

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

test("operating states: needs you / failed / system handling / waiting / unresolved / done", () => {
  assert.equal(deriveThreadState({ needs_operator: true, automation_state: "active" }).state, "needs_you");
  assert.equal(deriveThreadState({ automation_state: "active" }, { outbound: [{ queue_status: "awaiting_approval", approval_status: "required" }] }).state, "needs_you", "draft ready → review & send");
  assert.equal(deriveThreadState({ automation_state: "active", last_outbound_at: iso(NOW - 1e3) }, { outbound: [{ queue_status: "bounced", sent_at: iso(NOW - 1e3) }] }).state, "failed");
  const sh = deriveThreadState({ automation_state: "active", last_outbound_at: iso(NOW - 864e5) }, { outbound: [{ id: "f2", queue_status: "scheduled", scheduled_for: iso(NOW + 864e5), action_key: "closing.title_followup", sequence: 2, reason: { why: "commitment not received" } }] });
  assert.equal(sh.state, "system_handling");
  assert.equal(sh.ball, "leadcommand");
  assert.equal(sh.automation, "follow_up_scheduled");
  assert.equal(sh.next.sequence, 2);
  assert.deepEqual(sh.next.why, { why: "commitment not received" }, "why is carried for 'why did it do that?'");
  const w = deriveThreadState({ automation_state: "active", last_outbound_at: iso(NOW - 3600e3) });
  assert.equal(w.state, "waiting");
  assert.equal(w.ball, "them");
  assert.equal(deriveThreadState({ category: "unresolved", automation_state: "active", last_inbound_at: iso(NOW) }).state, "unresolved");
  assert.equal(deriveThreadState({ automation_state: "taken_over", last_inbound_at: iso(NOW), last_outbound_at: iso(NOW - 1e5) }).state, "needs_you");
});

test("operator unread is separate from system unhandled", () => {
  const handled = deriveThreadState({ automation_state: "active", last_inbound_at: iso(NOW - 1e5), last_outbound_at: iso(NOW - 1e4) });
  assert.equal(handled.state, "waiting", "system replied; nothing for the operator to do");
  assert.equal(handled.operator_unread, true, "…but the operator has not read it");
});

test("delivery status never claims more than was proven", () => {
  assert.equal(deliveryStatus({ queue_status: "sent" }, {}), "sent");
  assert.equal(deliveryStatus({ queue_status: "sent" }, { delivered_at: iso(NOW) }), "delivered");
  assert.equal(deliveryStatus({ queue_status: "delivered" }, { delivered_at: iso(NOW), replied_at: iso(NOW) }), "replied");
  const eng = engagementFromEvents([{ event_type: "open_signal", event_at: "2026-09-29T10:00:00Z", signal_class: "privacy_proxy" }, { event_type: "open_signal", event_at: "2026-09-29T11:00:00Z", signal_class: "likely_human" }]);
  assert.equal(eng.open_signals, 2);
  assert.equal(eng.likely_human_opens, 1);
  assert.equal(eng.first_open_at, "2026-09-29T10:00:00Z");
  assert.equal(eng.last_open_at, "2026-09-29T11:00:00Z");
});

test("closing context says what we are waiting for", () => {
  assert.equal(closingContext({ closing_case_id: "c1", title_acknowledged_at: iso(NOW), title_commitment_date: "2026-10-01T00:00:00Z" }).waiting_for, "Title commitment · due Thu, Oct 1");
  assert.equal(closingContext({ closing_case_id: "c1", title_acknowledged_at: iso(NOW), title_commitment_received_at: iso(NOW) }).waiting_for, "Clear to close");
});

function seed() {
  return {
    email_threads: [
      { id: "t-needs", thread_key: "closing:c1:title", category: "title", counterparty_email: "lisa@westtitle.com", counterparty_name: "West Title", closing_case_id: "c1", property_id: "p1", automation_state: "active", resolution_status: "resolved", needs_operator: true, needs_code: "title_issue", needs_reason: "Title reports open lien", needs_since: iso(NOW - 600e3), last_message_at: iso(NOW - 600e3), last_inbound_at: iso(NOW - 600e3), last_outbound_at: iso(NOW - 864e5), reply_token: "a1", inbound_count: 1, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 2 * 864e5) },
      { id: "t-wait", thread_key: "seller:mo-1:p2", category: "seller", counterparty_email: "d@x.com", master_owner_id: "mo-1", property_id: "p2", sms_thread_key: "+1612", automation_state: "active", resolution_status: "resolved", needs_operator: false, last_message_at: iso(NOW - 3600e3), last_outbound_at: iso(NOW - 3600e3), last_inbound_at: iso(NOW - 7200e3), reply_token: "a2", inbound_count: 1, outbound_count: 1, attachment_count: 0, created_at: iso(NOW - 864e5) },
    ],
    email_queue: [
      { id: "q-f", queue_key: "k-f", thread_id: "t-needs", queue_status: "scheduled", scheduled_for: iso(NOW + 864e5), source: "closing", action_key: "closing.title_followup", sequence: 2, subject: "Re: order", to_email: "lisa@westtitle.com", approval_status: "not_required", reason: { why: "no ack" }, created_at: iso(NOW - 3600e3) },
      { id: "q-s", queue_key: "k-s", thread_id: "t-wait", queue_status: "sent", sent_at: iso(NOW - 3600e3), source: "seller", action_key: "seller.reply.condition_probe", subject: "Re: 123 Main", to_email: "d@x.com", text_body: "Is anyone living there?", approval_status: "not_required", created_at: iso(NOW - 3600e3) },
    ],
    email_events: [
      { event_key: "e1", queue_id: "q-s", thread_id: "t-wait", event_type: "delivered", event_at: iso(NOW - 3500e3), direction: "outbound" },
      { event_key: "e2", queue_id: "q-s", thread_id: "t-wait", event_type: "open_signal", event_at: iso(NOW - 3000e3), direction: "outbound", signal_class: "unknown", raw_payload: { event: "opened" } },
    ],
    closing_cases: [{ closing_case_id: "c1", property_address: "123 Main St", title_acknowledged_at: null }],
    inbox_thread_state: [{ thread_key: "+1612", seller_stage: "property_condition", seller_display_name: "David Larson", contactability_status: "contactable" }],
    acquisition_opportunities: [{ id: "o-1", master_owner_id: "mo-1", property_id: "p2", acquisition_stage: "property_condition", metadata: { seller_facts: { asking_price: { value: { amount: 315000 } } } } }],
    properties: [{ property_id: "p2", property_address_full: "123 Main St, Dallas, TX" }],
  };
}

test("home: counts + lists by operating meaning, with business context", async () => {
  const db = makeEmailDb(seed());
  const h = await getEmailCommandHome({}, { supabase: db });
  assert.equal(h.ok, true);
  assert.equal(h.counts.needs_you, 1);
  assert.equal(h.counts.waiting, 1);
  const seller = h.waiting[0];
  assert.equal(seller.context.kind, "seller");
  assert.equal(seller.context.stage_label, "S4 Condition");
  assert.deepEqual(seller.context.known_facts[0], { key: "asking_price", label: "Asking", value: 315000 });
  assert.equal(seller.context.open_sms, "/inbox?thread=%2B1612");
  const title = h.needs_you[0];
  assert.equal(title.context.waiting_for, "Title to acknowledge the order");
  assert.equal(title.needs.code, "title_issue");
  assert.equal(title.context.open, "/closing-desk?case=c1");
});

test("thread room interleaves messages and derived telemetry; message sheet hides provider payload", async () => {
  const db = makeEmailDb(seed());
  const r = await getEmailCommandThread("t-wait", { supabase: db });
  const out = r.items.find((i) => i.kind === "outbound");
  assert.equal(out.status, "delivered");
  assert.equal(out.engagement.open_signals, 1);
  const tel = await getEmailMessageTelemetry("q-s", { supabase: db });
  assert.equal(tel.events.find((e) => e.event_type === "open_signal").has_provider_payload, true);
  assert.equal(tel.events.find((e) => e.event_type === "open_signal").raw_payload, undefined);
});

test("take over pauses THAT thread's automation (cancels its pending follow-ups) and return-to-system resumes", async () => {
  const db = makeEmailDb(seed());
  assert.equal((await applyEmailThreadAction("t-needs", "take_over", {}, { actor: "", supabase: db })).status, 401);
  const r = await applyEmailThreadAction("t-needs", "take_over", { reason: "handling lien myself" }, { actor: "op-1", supabase: db });
  assert.equal(r.stopped, 1);
  assert.equal(db.state.email_queue.find((q) => q.id === "q-f").cancel_reason, "operator_took_over");
  assert.equal(db.state.email_threads[0].automation_state, "taken_over");
  assert.equal(db.state.email_threads[1].automation_state, "active", "other threads untouched");
  await applyEmailThreadAction("t-needs", "return_to_system", {}, { actor: "op-1", supabase: db });
  assert.equal(db.state.email_threads[0].automation_state, "active");
  await applyEmailThreadAction("t-needs", "resolve_needs", { note: "told title to proceed" }, { actor: "op-1", supabase: db });
  assert.equal(db.state.email_threads[0].needs_operator, false);
});
