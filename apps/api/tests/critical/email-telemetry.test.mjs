/**
 * EMAIL TELEMETRY + ENGAGEMENT ATTRIBUTION (§1–20, §37, §41–42, §48–50, §60–61, §67).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeEmailDb, BRAND_SENDER, SEND_ENV, makeTransport } from "../helpers/email-db-mock.mjs";
import { runEmailDispatch } from "@/lib/domain/email/email-dispatch.js";
import { ingestProviderEvents } from "@/lib/domain/email/email-provider-events.js";
import { normalizeBrevoEvent } from "@/lib/domain/email/email-providers.js";
import { recordEmailEvent } from "@/lib/domain/email/email-telemetry.js";
import { applyTracking, recordOpen, recordClick, classifySignal } from "@/lib/domain/email/email-tracking.js";
import { ingestInboundEmail } from "@/lib/domain/email/email-inbound.js";
import { parseMime } from "@/lib/domain/email/email-mime.js";
import { evaluateEmailHealth } from "@/lib/domain/email/email-health.js";

const T0 = Date.parse("2026-09-29T14:00:00Z");
const MSG_ID = "<202609291400.1@smtp-relay.mailin.fr>";

function sentMessage(extra = {}) {
  return {
    id: "q-1", queue_key: "campaign:mpls:t1:mo-x", queue_status: "sent", to_email: "david@example.com", from_email: "ryan@prominentcashoffer.com",
    subject: "Your house on Main St", text_body: "hi", html_body: '<p>Hi — see <a href="https://offers.example.com/123-main">your offer</a></p>', sent_at: new Date(T0).toISOString(),
    provider: "brevo", provider_message_id: MSG_ID, source: "campaign", lane: "acquisition", sender_key: "prominent", sending_domain: "prominentcashoffer.com",
    campaign_id: "cmp-mpls", campaign_target_id: "tgt-9", sequence_id: "seq-1", sequence_step: 1, template_id: "tpl-a", template_version: "v3",
    master_owner_id: "mo-x", property_id: "prop-x", thread_id: "th-1", approval_status: "not_required", ...extra,
  };
}
const threads = [{ id: "th-1", thread_key: "seller:mo-x:prop-x", category: "seller", automation_state: "active", resolution_status: "resolved", reply_token: "abcdef0123456789", counterparty_email: "david@example.com", master_owner_id: "mo-x", property_id: "prop-x", inbound_count: 0, outbound_count: 1, attachment_count: 0 }];

const brevo = (event, extra = {}) => ({ event, email: "david@example.com", "message-id": MSG_ID, ts_event: Math.floor(T0 / 1000) + (extra.dt || 0), ...extra });

test("Brevo is an adapter: events normalize into LeadCommand semantics", () => {
  assert.equal(normalizeBrevoEvent(brevo("delivered")).type, "delivered");
  assert.equal(normalizeBrevoEvent(brevo("opened")).type, "open_signal");
  assert.equal(normalizeBrevoEvent(brevo("proxy_open")).signalClass, "privacy_proxy");
  assert.equal(normalizeBrevoEvent(brevo("hard_bounce")).type, "hard_bounce");
  assert.equal(normalizeBrevoEvent(brevo("soft_bounce")).bounceClass, "temporary");
  assert.equal(normalizeBrevoEvent(brevo("spam")).type, "complaint");
  assert.equal(normalizeBrevoEvent(brevo("request")).type, "accepted");
  assert.equal(normalizeBrevoEvent(brevo("unique_opened")), null, "uniqueness is derived, not double-counted");
});

test("duplicate Brevo webhook does not duplicate the event; multiple opens are separate facts; first stays first", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage()], email_threads: [...threads] });
  const batch = [brevo("delivered", { dt: 60 }), brevo("opened", { dt: 2400 }), brevo("opened", { dt: 2580 }), brevo("opened", { dt: 11800 })];
  const a = await ingestProviderEvents("brevo", batch, { supabase: db });
  const b = await ingestProviderEvents("brevo", batch, { supabase: db });
  assert.equal(a.recorded, 4);
  assert.equal(b.recorded, 0);
  assert.equal(b.duplicates, 4);
  const opens = db.state.email_events.filter((e) => e.event_type === "open_signal").map((e) => e.event_at).sort();
  assert.equal(opens.length, 3, "open count derives from 3 events");
  assert.equal(opens[0], new Date(T0 + 2400e3).toISOString(), "first_open_at");
  assert.equal(opens[2], new Date(T0 + 11800e3).toISOString(), "last_open_at");
  const ev = db.state.email_events[0];
  for (const k of ["campaign_id", "campaign_target_id", "sequence_step", "template_id", "template_version", "sender_key", "sending_domain", "lane", "master_owner_id", "property_id", "provider", "provider_message_id", "event_source"]) {
    assert.ok(ev[k] !== null && ev[k] !== undefined, `lineage ${k}`);
  }
  assert.equal(ev.event_source, "brevo_webhook");
  assert.equal(db.state.email_queue[0].delivered_at, new Date(T0 + 60e3).toISOString());
});

test("events are append-only history (the ledger refuses edits)", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage()] });
  await recordEmailEvent(db, { type: "delivered", source: "brevo_webhook", message: db.state.email_queue[0], key: "k1" });
  const { error } = await db.from("email_events").update({ event_type: "open_signal" }).eq("event_key", "k1");
  assert.match(String(error?.message), /APPEND_ONLY/);
});

test("open and click are telemetry: they never touch seller state or notify", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage()], email_threads: [...threads], inbox_thread_state: [{ thread_key: "+1612", master_owner_id: "mo-x", seller_stage: "offer_interest" }], acquisition_opportunities: [{ id: "o1", master_owner_id: "mo-x", acquisition_stage: "offer_interest" }] });
  const before = JSON.stringify({ a: db.state.acquisition_opportunities, i: db.state.inbox_thread_state, t: db.state.email_threads, s: db.state.email_suppression })
  const r = await ingestProviderEvents("brevo", [brevo("opened", { dt: 100 }), brevo("click", { dt: 200, link: "https://offers.example.com/123-main" })], { supabase: db });
  assert.equal(r.recorded, 2);
  assert.deepEqual(r.consequences, []);
  assert.equal(JSON.stringify({ a: db.state.acquisition_opportunities, i: db.state.inbox_thread_state, t: db.state.email_threads, s: db.state.email_suppression }), before);
});

test("hard bounce suppresses the ADDRESS and stops pending automated email to it — not the seller", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage(), { ...sentMessage(), id: "q-2", queue_key: "k2", queue_status: "scheduled", provider_message_id: null, sequence_step: 2 }, { ...sentMessage(), id: "q-3", queue_key: "k3", queue_status: "scheduled", to_email: "david.alt@example.com", provider_message_id: null }], email_threads: [...threads] });
  await ingestProviderEvents("brevo", [brevo("hard_bounce", { dt: 30, reason: "mailbox does not exist" })], { supabase: db });
  const sup = db.state.email_suppression.find((s) => s.email_address === "david@example.com");
  assert.equal(sup.reason, "hard_bounce");
  assert.equal(db.state.email_queue.find((q) => q.id === "q-1").queue_status, "bounced");
  assert.equal(db.state.email_queue.find((q) => q.id === "q-2").cancel_reason, "recipient_hard_bounced");
  assert.equal(db.state.email_queue.find((q) => q.id === "q-3").queue_status, "scheduled", "another address for the same seller is untouched");
});

test("unsubscribe and complaint suppress immediately; soft bounces only after a bounded count", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage()] });
  await ingestProviderEvents("brevo", [brevo("unsubscribed", { dt: 10 })], { supabase: db });
  assert.equal(db.state.email_suppression[0].reason, "unsubscribe");
  const db2 = makeEmailDb({ email_queue: [sentMessage()] });
  await ingestProviderEvents("brevo", [brevo("spam", { dt: 10 })], { supabase: db2 });
  assert.equal(db2.state.email_suppression[0].reason, "complaint");
  const db3 = makeEmailDb({ email_queue: [sentMessage()] });
  await ingestProviderEvents("brevo", [brevo("soft_bounce", { dt: 1 }), brevo("soft_bounce", { dt: 2 })], { supabase: db3, now: () => T0 + 10e3 });
  assert.equal(db3.state.email_suppression.length, 0, "two soft bounces: keep trying (bounded)");
  await ingestProviderEvents("brevo", [brevo("soft_bounce", { dt: 3 })], { supabase: db3, now: () => T0 + 10e3 });
  assert.equal(db3.state.email_suppression[0].reason, "soft_bounce_repeated");
});

test("own tracking: pixel + links minted at send, open recorded, click maps to the exact link", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage({ tracking_token: null })] });
  const q = db.state.email_queue[0];
  const t = await applyTracking(db, q, "https://track.prominentcashoffer.com");
  assert.match(t.html, /https:\/\/track\.prominentcashoffer\.com\/c\/[A-Za-z0-9_-]{24}/);
  assert.match(t.html, /\/o\/[A-Za-z0-9_-]{24}\.gif/);
  assert.doesNotMatch(t.html, /offers\.example\.com/, "destination is not in the email");
  assert.doesNotMatch(t.html, /q-1|mo-x|prop-x/, "no ids or seller data in URLs");
  q.tracking_token = t.token;
  const again = await applyTracking(db, q, "https://track.prominentcashoffer.com");
  assert.equal(again.links[0].token, t.links[0].token, "transport retry reuses the same link tokens");

  const o = await recordOpen(db, `${t.token}.gif`, { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)", now: T0 + 3600e3 });
  assert.equal(o.recorded, true);
  assert.equal(o.signalClass, "likely_human");
  const c = await recordClick(db, t.links[0].token, { ua: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148", now: T0 + 3700e3 });
  assert.equal(c.destination, "https://offers.example.com/123-main");
  const click = db.state.email_events.find((e) => e.event_type === "click");
  assert.equal(click.link_id, db.state.email_links[0].id);
  assert.equal(click.campaign_id, "cmp-mpls");
  assert.equal(click.event_source, "leadcommand_click_redirect");
});

test("tampered / unknown click token is rejected — never an open redirect", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage()] });
  assert.equal((await recordClick(db, "not-a-token")).destination, null);
  assert.equal((await recordClick(db, "AAAAAAAAAAAAAAAAAAAAAAAA")).destination, null);
  assert.equal((await recordClick(db, "https://evil.com")).destination, null);
});

test("signal classification: proxies and scanners are not counted as humans", () => {
  assert.equal(classifySignal("open", { ua: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)" }).signalClass, "privacy_proxy");
  assert.equal(classifySignal("open", { ua: "Mozilla/5.0", ip: "17.58.1.2" }).signalClass, "privacy_proxy");
  assert.equal(classifySignal("click", { ua: "Mozilla/5.0 (compatible; Barracuda Sentinel)" }).signalClass, "automated");
  assert.equal(classifySignal("click", { ua: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15", secondsSinceSent: 4 }).signalClass, "automated");
  assert.equal(classifySignal("click", { ua: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15", burst: true }).signalClass, "automated");
});

test("reply maps to the campaign target touch that generated it (replied event with lineage)", async () => {
  const db = makeEmailDb({ email_queue: [sentMessage({ message_id_header: "<lc.abc@prominentcashoffer.com>" })], email_threads: [...threads] });
  const r = await ingestInboundEmail({ MessageId: "<r1@gmail.com>", InReplyTo: "<lc.abc@prominentcashoffer.com>", From: { Address: "david@example.com" }, To: [{ Address: "reply+abcdef0123456789@reply.prominentcashoffer.com" }], Subject: "Re: Your house", RawTextBody: "Maybe. What would you pay?", SentAtDate: "2026-09-29T16:00:00Z" }, { supabase: db, source: "cloudflare_inbound_email", handleSellerEmail: async () => ({ ok: true }) });
  assert.equal(r.answered_message_id, "q-1");
  const replied = db.state.email_events.find((e) => e.event_type === "replied");
  assert.equal(replied.campaign_target_id, "tgt-9");
  assert.equal(replied.sequence_step, 1);
  assert.equal(replied.template_version, "v3");
  assert.equal(replied.event_source, "cloudflare_inbound_email");
});

test("dispatch writes sent + accepted with lineage; provider replacement leaves history intact", async () => {
  const db = makeEmailDb({ system_control: [{ key: "email_enabled", value: "true" }], email_senders: [{ ...BRAND_SENDER, metadata: { ...BRAND_SENDER.metadata, tracking_base_url: "https://track.reivesti.com" } }], email_threads: [...threads] });
  db.state.email_queue.push({ id: "q-9", queue_key: "manual:x", queue_status: "pending_send", scheduled_for: new Date(T0).toISOString(), created_at: new Date(T0).toISOString(), to_email: "david@example.com", subject: "Hello", text_body: "Hi", html_body: '<p>Hi <a href="https://reivesti.com/offer">offer</a></p>', source: "manual", thread_id: "th-1", approval_status: "not_required", campaign_id: "cmp-1", template_id: "tpl-z" });
  const tx = makeTransport(() => ({ ok: true, sent: true, message_id: "<p1@brevo>" }));
  await runEmailDispatch({ now: T0 + 1000 }, { supabase: db, send: tx.send, env: SEND_ENV, notify: async () => ({}) });
  const types = db.state.email_events.map((e) => e.event_type).sort();
  assert.deepEqual(types, ["accepted", "sent"]);
  assert.match(tx.calls[0].payload.htmlContent, /track\.reivesti\.com\/o\//);
  const snapshot = JSON.stringify(db.state.email_events);
  // Swapping provider for FUTURE mail changes nothing already recorded.
  db.state.email_senders[0].provider = "ses";
  assert.equal(JSON.stringify(db.state.email_events), snapshot);
  assert.equal(db.state.email_events[0].provider, "brevo");
});

test("Cloudflare raw MIME parses: multipart, QP, base64 attachment, encoded subject", () => {
  const raw = [
    "From: =?UTF-8?B?RGF2aWQgTGFyc29u?= <david@example.com>",
    "To: reply+abcdef0123456789@reply.reivesti.com",
    "Subject: =?utf-8?Q?Re:_Caf=C3=A9_house?=",
    "Message-ID: <m-1@mail.gmail.com>",
    "In-Reply-To: <lc.abc@reivesti.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B1"',
    "",
    "--B1",
    'Content-Type: multipart/alternative; boundary="B2"',
    "",
    "--B2",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Yes I'd take $315k =E2=80=94 house needs work.",
    "--B2",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Yes I'd take $315k</p>",
    "--B2--",
    "--B1",
    'Content-Type: application/pdf; name="photos.pdf"',
    'Content-Disposition: attachment; filename="photos.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 test").toString("base64"),
    "--B1--",
    "",
  ].join("\r\n");
  const m = parseMime(Buffer.from(raw));
  assert.match(m.from, /David Larson/);
  assert.equal(m.subject, "Re: Café house");
  assert.equal(m.text.trim(), "Yes I'd take $315k — house needs work.");
  assert.equal(m.html, "<p>Yes I'd take $315k</p>");
  assert.equal(m.attachments[0].filename, "photos.pdf");
  assert.equal(m.attachments[0].content.toString(), "%PDF-1.4 test");
  assert.equal(m.inReplyTo, "<lc.abc@reivesti.com>");
});

test("health: stalled outbound, bounce spike per lane/domain, silent webhook — concrete, no score", () => {
  const now = T0;
  const base = { now, sendEnabled: true, providerConfigured: true, dispatchHeartbeatAt: new Date(now - 60e3).toISOString(), dueCount: 0, failed24h: 0, needsCount: 0, unresolved24h: 0, outbound1h: [], outbound7d: [], complaints24h: [], inbound7dCount: 0, inboundConfigured: true, sentSince6h: 0, attachmentFailures24h: 0 };
  assert.equal(evaluateEmailHealth(base).status, "healthy");
  const stalled = evaluateEmailHealth({ ...base, dueCount: 200, oldestDueAt: new Date(now - 25 * 60e3).toISOString(), lastAcceptedAt: new Date(now - 40 * 60e3).toISOString() });
  assert.ok(stalled.issues.some((i) => i.code === "email_outbound_stalled"));
  const spike = evaluateEmailHealth({ ...base, outbound1h: [{ lane: "acquisition", domain: "prominentcashoffer.com", sent: 100, hardBounce: 12 }], outbound7d: [{ lane: "acquisition", domain: "prominentcashoffer.com", sent: 5000, hardBounce: 50 }, { lane: "closing", domain: "everline.com", sent: 50, hardBounce: 0 }] });
  const d = spike.issues.find((i) => i.code === "email_delivery_degraded");
  assert.equal(d.lane, "acquisition");
  assert.equal(d.domain, "prominentcashoffer.com");
  assert.equal(spike.issues.filter((i) => i.code === "email_delivery_degraded").length, 1, "transactional lane not contaminated");
  assert.ok(evaluateEmailHealth({ ...base, sentSince6h: 40, webhookLastAt: null }).issues.some((i) => i.code === "email_webhook_silent"));
  assert.ok(evaluateEmailHealth({ ...base, dispatchHeartbeatAt: new Date(now - 30 * 60e3).toISOString() }).issues.some((i) => i.code === "email_dispatcher_stale"));
});
