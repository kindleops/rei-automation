/**
 * Title / counterparty inbound (§21–27, §31, §50–52, §98–99, §102–104, §109).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeEmailDb, BRAND_SENDER, SEND_ENV, makeTransport } from "../helpers/email-db-mock.mjs";
import { runEmailDispatch } from "@/lib/domain/email/email-dispatch.js";
import { ingestInboundEmail } from "@/lib/domain/email/email-inbound.js";
import { classifyCounterpartyEmail, classifyAttachment, parseDateMention } from "@/lib/domain/email/email-inbound-classify.js";
import { normalizeInboundEmail, extractReply, sanitizeEmailHtml, isAutomatedMail } from "@/lib/domain/email/email-content.js";

const CASE = "closing:c-9";
const T0 = Date.parse("2026-09-28T15:00:00Z"); // Monday

function seed() {
  return {
    system_control: [{ key: "email_enabled", value: "true" }],
    email_senders: [{ ...BRAND_SENDER }],
    closing_cases: [{ id: "u9", closing_case_id: CASE, opportunity_id: "opp-9", property_id: "prop-9", property_address: "123 Main St, Dallas, TX", title_company_name: "West Title", title_company_email: "lisa@westtitle.com", contract_status: "fully_executed", closing_status: "title_opened", scheduled_closing_date: "2026-10-15T00:00:00Z", closing_tz: "America/Chicago", brand_key: "reivesti", universal_stage: "disposition" }],
    closing_email_requests: [{ id: "r1", request_key: `closing_email:${CASE}:title_open:1`, closing_case_id: CASE, opportunity_id: "opp-9", property_id: "prop-9", action: "title_open", category: "title_open", sequence: 1, recipient_role: "title", recipient_email: "lisa@westtitle.com", template_key: "closing.title_open", template_version: "v1", thread_key: `closing:${CASE}:title`, status: "pending_transport", requested_by: "closing_automation", due_at: new Date(T0).toISOString(), payload: { property_address: "123 Main St, Dallas, TX", title_company_name: "West Title" } }],
    closing_title_issues: [], closing_activity_events: [], closing_milestones: [],
  };
}

const deps = (db, notes = []) => ({ supabase: db, now: () => T0 + 26 * 3600e3, notify: async (n) => { notes.push(n); return { ok: true } } });

async function openTitle(db) {
  const tx = makeTransport(() => ({ ok: true, sent: true, message_id: "<brevo-1@smtp>" }));
  await runEmailDispatch({ now: T0 + 60e3 }, { supabase: db, send: tx.send, env: SEND_ENV, notify: async () => ({}) });
  return { tx, sent: db.state.email_queue[0], thread: db.state.email_threads[0] };
}

test("§98 title reply threads back by reply token; commitment date recorded THROUGH Closing Authority; PDF commitment arrives → milestone; reminders stop", async () => {
  const db = makeEmailDb(seed());
  const { tx, sent, thread } = await openTitle(db);
  const replyTo = tx.calls[0].payload.replyTo.email;

  const r1 = await ingestInboundEmail({
    MessageId: "<t1@westtitle.com>", InReplyTo: sent.message_id_header, From: { Name: "Lisa", Address: "lisa@westtitle.com" }, To: [{ Address: replyTo }],
    Subject: "RE: New title order — 123 Main St", SentAtDate: "2026-09-29T16:00:00Z",
    RawTextBody: "Received the order, file number WT-22817. We expect the title commitment by Thursday.\n\nLisa\nWest Title",
  }, deps(db))
  assert.equal(r1.thread_id, thread.id)
  assert.equal(r1.resolution, "reply_token")
  const c = db.state.closing_cases[0]
  assert.ok(c.title_acknowledged_at, "acknowledgement recorded by authority")
  assert.equal(c.title_acknowledged_source, "title_email")
  assert.equal(c.title_commitment_date.slice(0, 10), "2026-10-01", "Thursday after Tue 9/29 → Oct 1")
  assert.ok(db.state.closing_activity_events.some((e) => e.event_type === "title_commitment_date_set"), "audited")
  assert.equal(db.state.email_threads[0].needs_operator, false)

  // A commitment reminder planned now must not go out once the commitment arrives.
  db.state.closing_email_requests.push({ id: "r2", request_key: `closing_email:${CASE}:title_commitment:1`, closing_case_id: CASE, action: "title_commitment_reminder", category: "title_commitment", sequence: 1, recipient_role: "title", recipient_email: "lisa@westtitle.com", template_key: "closing.title_commitment_reminder", thread_key: `closing:${CASE}:title`, status: "pending_transport", due_at: "2026-09-30T14:00:00Z", payload: { property_address: "123 Main St, Dallas, TX" } })

  const r2 = await ingestInboundEmail({
    MessageId: "<t2@westtitle.com>", InReplyTo: "<t1@westtitle.com>", References: "", From: { Address: "lisa@westtitle.com" }, To: [{ Address: replyTo }],
    Subject: "Title commitment WT-22817", SentAtDate: "2026-09-30T13:00:00Z", RawTextBody: "Attached is the title commitment.",
    Attachments: [{ Name: "WT-22817 Title Commitment.pdf", ContentType: "application/pdf", ContentLength: 184000, DownloadToken: "tok-1" }],
  }, deps(db))
  const att = db.state.email_attachments[0]
  assert.equal(att.doc_type, "title_commitment")
  assert.equal(att.review_state, "auto_classified")
  assert.equal(att.routed_entity_id, CASE, "attachment associated with the closing")
  assert.ok(db.state.closing_cases[0].title_commitment_received_at, "title milestone updated via authority")
  assert.match(db.state.closing_cases[0].title_commitment_evidence, /^attachment:/)
  assert.ok(r2.applied.some((a) => a.type === "commitment_received" && a.ok))

  const tx2 = makeTransport()
  await runEmailDispatch({ now: Date.parse("2026-09-30T14:05:00Z") }, { supabase: db, send: tx2.send, env: SEND_ENV, notify: async () => ({}) })
  assert.equal(tx2.calls.length, 0, "no further commitment reminders")
  assert.equal(db.state.email_queue.find((q) => q.action_key === "closing.title_commitment_reminder").cancel_reason, "commitment_received")
})

test("§99 'unreleased mortgage, need direction' → NEEDS YOU, blocker via Closing Authority, automation paused, critical notification, no decision made", async () => {
  const db = makeEmailDb(seed());
  const { tx } = await openTitle(db);
  const notes = []
  const r = await ingestInboundEmail({
    MessageId: "<t9@westtitle.com>", From: { Address: "lisa@westtitle.com" }, To: [{ Address: tx.calls[0].payload.replyTo.email }],
    Subject: "RE: 123 Main St", SentAtDate: "2026-09-29T16:00:00Z", RawTextBody: "We found an unreleased mortgage from 2014. Need direction on how you'd like to proceed.",
  }, deps(db, notes))
  const t = db.state.email_threads[0]
  assert.equal(t.needs_operator, true)
  assert.equal(t.needs_code, "title_issue")
  assert.match(t.needs_reason, /open lien.*needs direction/i)
  const issue = db.state.closing_title_issues[0]
  assert.equal(issue.issue_type, "open_lien")
  assert.equal(issue.source, "title_email")
  assert.equal(issue.status, "open")
  assert.ok(db.state.closing_cases[0].automation_paused_at, "closing follow-ups paused")
  assert.ok(notes.some((n) => n.eventType === "email_needs_operator" && n.severity === "critical"))
  assert.ok(notes.some((n) => n.eventType === "closing_title_issue"))
  assert.equal(db.state.closing_cases[0].clear_to_close_at ?? null, null)
  // no autonomous reply
  assert.equal(db.state.email_queue.filter((q) => q.queue_status === "pending_send").length, 0)
  assert.ok(r.needs)
})

test("clear-to-close from title is a SUBMISSION: authority refuses it while an issue is open", async () => {
  const db = makeEmailDb(seed());
  const { tx } = await openTitle(db);
  db.state.closing_title_issues.push({ issue_id: "i1", closing_case_id: CASE, issue_type: "tax", status: "open" })
  const r = await ingestInboundEmail({ MessageId: "<c1@westtitle.com>", From: { Address: "lisa@westtitle.com" }, To: [{ Address: tx.calls[0].payload.replyTo.email }], Subject: "RE: 123 Main", RawTextBody: "Good news, the file is clear to close." }, deps(db))
  assert.equal(db.state.closing_cases[0].clear_to_close_at ?? null, null)
  assert.equal(r.needs.code, "clear_to_close_refused")
  db.state.closing_title_issues[0].status = "resolved"
  await ingestInboundEmail({ MessageId: "<c2@westtitle.com>", From: { Address: "lisa@westtitle.com" }, To: [{ Address: tx.calls[0].payload.replyTo.email }], Subject: "RE: 123 Main", RawTextBody: "File is clear to close." }, deps(db))
  const c = db.state.closing_cases[0]
  assert.ok(c.clear_to_close_at)
  assert.equal(c.clear_to_close_source, "title_email")
  assert.match(c.clear_to_close_evidence, /^email:/)
})

test("unverified sender's assertion never becomes state", async () => {
  const db = makeEmailDb(seed());
  const { tx } = await openTitle(db);
  const r = await ingestInboundEmail({ MessageId: "<x1@evil.com>", From: { Address: "someone@evil.com" }, To: [{ Address: tx.calls[0].payload.replyTo.email }], Subject: "RE: 123 Main", RawTextBody: "The file is clear to close." }, deps(db))
  assert.equal(db.state.closing_cases[0].clear_to_close_at ?? null, null)
  assert.equal(r.needs.code, "unverified_sender_assertion")
})

test("wire instructions are never parsed or trusted — always the operator", async () => {
  const db = makeEmailDb(seed());
  const { tx } = await openTitle(db);
  const r = await ingestInboundEmail({ MessageId: "<w1@westtitle.com>", From: { Address: "lisa@westtitle.com" }, To: [{ Address: tx.calls[0].payload.replyTo.email }], Subject: "Updated wire instructions", RawTextBody: "Please note our new bank account. Routing number 021000021, account number 12345678. The file is clear to close." }, deps(db))
  assert.equal(r.needs.code, "wire_instructions_received")
  assert.equal(db.state.closing_cases[0].clear_to_close_at ?? null, null, "nothing applied from a wire email")
  assert.equal(r.applied.length, 0)
})

test("financial attachments are never auto-trusted; blocked file types rejected", () => {
  assert.equal(classifyAttachment({ filename: "Settlement Statement.pdf", contentType: "application/pdf", senderVerified: true, role: "title" }).review_state, "needs_review")
  assert.equal(classifyAttachment({ filename: "EMD receipt.pdf", contentType: "application/pdf", senderVerified: true, role: "title" }).review_state, "needs_review")
  assert.equal(classifyAttachment({ filename: "commitment.pdf", contentType: "application/pdf", senderVerified: false, role: "title" }).review_state, "needs_review")
  assert.equal(classifyAttachment({ filename: "invoice.exe", contentType: "application/octet-stream" }).fetch, "blocked")
})

test("attachments cannot be routed to a business object without trusted classification (DB rule)", async () => {
  const db = makeEmailDb();
  const { error } = await db.from("email_attachments").insert({ attachment_key: "a1", inbound_message_id: "x", filename: "s.pdf", review_state: "needs_review", routed_entity_id: "closing:1" })
  assert.equal(error?.code, "23514")
})

test("inbound duplicates ignored; auto-replies never drive automation; unresolved has its own bucket", async () => {
  const db = makeEmailDb(seed());
  const item = { MessageId: "<d1@x.com>", From: { Address: "stranger@x.com" }, Subject: "Hello", RawTextBody: "Is this still available?" }
  const a = await ingestInboundEmail(item, deps(db))
  const b = await ingestInboundEmail(item, deps(db))
  assert.equal(b.duplicate, true)
  assert.equal(db.state.email_inbound_messages.length, 1)
  assert.equal(a.unresolved, true)
  assert.equal(db.state.email_threads[0].category, "unresolved")
  assert.equal(db.state.email_threads[0].needs_operator, false, "a stranger is not an alert")
  const auto = await ingestInboundEmail({ MessageId: "<ooo@westtitle.com>", From: { Address: "lisa@westtitle.com" }, Subject: "Out of Office: RE: 123 Main", RawTextBody: "I am out of the office until Monday.", Headers: { "Auto-Submitted": "auto-replied" } }, deps(db))
  assert.equal(auto.ignored, "auto_submitted")
})

test("content: quoted history + signature split; HTML sanitized; dates parsed", () => {
  const r = extractReply("Sounds good, Thursday works.\n-- \nLisa Park\nWest Title\n\nOn Tue, Sep 29, 2026 at 9:00 AM Ryan wrote:\n> Can you confirm?")
  assert.equal(r.reply, "Sounds good, Thursday works.")
  assert.match(r.signature, /Lisa Park/)
  assert.equal(r.quoted, true)
  const html = sanitizeEmailHtml('<p onclick="x()">Hi<script>alert(1)</script><img src="https://track/p.gif"><a href="javascript:evil()">x</a><a href="https://ok.com">ok</a><iframe src="x"></iframe></p>')
  assert.doesNotMatch(html, /script|onclick|img|iframe|javascript/i)
  assert.match(html, /<a href="https:\/\/ok.com" target="_blank" rel="noopener noreferrer nofollow" data-external="1">ok<\/a>/)
  assert.equal(parseDateMention("by Thursday", "2026-09-29T16:00:00Z"), "2026-10-01")
  assert.equal(parseDateMention("on 10/7", "2026-09-29T16:00:00Z"), "2026-10-07")
  assert.equal(parseDateMention("October 12th", "2026-09-29T16:00:00Z"), "2026-10-12")
  const n = normalizeInboundEmail({ From: "Lisa Park <LISA@westtitle.com>", To: "reply+abc12345@reply.reivesti.com", Subject: "x", RawTextBody: "hi", Headers: { References: "<a@x> <b@y>" } })
  assert.equal(n.from_email, "lisa@westtitle.com")
  assert.equal(n.from_name, "Lisa Park")
  assert.deepEqual(n.references_headers, ["<a@x>", "<b@y>"])
  assert.equal(isAutomatedMail({ from_email: "mailer-daemon@x.com", headers: {} }), "system_sender")
})

test("classifier: amendment / legal / closing-date proposals always need a human", () => {
  assert.equal(classifyCounterpartyEmail({ text: "Buyer wants an extension of the closing by two weeks", role: "buyer" }).needs.code, "approval_required")
  assert.equal(classifyCounterpartyEmail({ text: "Our attorney will be in touch about breach of contract", role: "title" }).needs.code, "legal_language")
  assert.equal(classifyCounterpartyEmail({ text: "We can set closing for October 15th at 2pm", role: "title", receivedAt: "2026-09-29T16:00:00Z" }).needs.code, "closing_date_proposed")
  assert.equal(classifyCounterpartyEmail({ text: "The file is not yet clear to close", role: "title" }).assertions.some((a) => a.type === "clear_to_close"), false)
})
