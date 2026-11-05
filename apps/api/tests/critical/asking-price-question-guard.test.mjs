/**
 * DUPLICATE ASKING-PRICE PROTECTION ON EVERY OUTBOUND PATH (rc-8.5.15.1).
 *
 * Owner directive 2026-10-13: never ask a seller for their asking price twice.
 * The live guard keyed on use_case_template ~* 'asking_price' only, so the 31
 * operator-typed price questions of the 30 days to 2026-10-14 (manual_reply)
 * were neither blocked nor counted as prior asks. These tests prove:
 *   1. the ONE shared classifier (EN + ES, conservative) on real phrasings;
 *   2. every writer stamps metadata.question_kind (canonical writer: manual,
 *      template auto-reply, AI conversation, no-response / nurture follow-ups;
 *      campaign batch; Discord) — the guard no longer depends on use_case alone;
 *   3. the manual send-now path reports the guard's cancellation (409), never ok:true;
 *   4. the audited override (actor, reason, at) reaches only this guard and never
 *      bypasses suppression / compliance.
 * The database trigger itself is proven on a disposable PostgreSQL in
 * repeat-asking-price-pg.test.mjs and by scripts/db/run-migration-test.mjs.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyAskingPriceQuestion, isAskingPriceUseCase } from "@/lib/domain/seller-flow/asking-price-question.js";
import { isS3AskingPriceQuestion } from "@/lib/domain/seller-flow/no-response-followup.js";
import {
  stampOutboundQuestionKind,
  resolveOutboundQuestionKind,
  isValidRepeatAskOverride,
  repeatAskBlockOf,
} from "@/lib/domain/queue/outbound-question-kind.js";
import { buildSendQueueInsertPayload, insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { createInboxSendNowQueueRow, buildRepeatAskOverride } from "@/lib/domain/inbox/send-now-service.js";

const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

// ── 1. the classifier ───────────────────────────────────────────────────────

const ASKS = [
  // the four phrasings named by the owner
  "What price would you be looking for?",
  "What would you take for it?",
  "¿Cuánto pide por la propiedad?",
  "Do you have a number in mind?",
  // operator-typed asks seen in production (30 days to 2026-10-14)
  "Do you have an asking price in mind?",
  "Any asking price in mind?",
  "Did you have an asking price in mind?",
  "What number are you at?",
  "I can make you a fair offer. What’s your asking price?",
  "Yes, I am a local investor. Do you have an asking price in mind?",
  "Sounds good, do you have any asking price in mind for it? We can pay cash, pay all closing costs, and close in 7 days.",
  "Got it, what price would you take for them if we can close in 7 days?",
  "¿Tienes un precio de venta en mente?",
  "Entendido. ¿Qué precio tendría en mente para la propiedad?",
  // more EN / ES shapes
  "How much would you want for the house?",
  "What are you asking for it?",
  "Is there a price that would work for you?",
  "What would you sell the house for?",
  "Do you have an asking price in mind", // operator dropped the question mark
  "¿Cuánto quiere por la casa?",
  "¿En cuánto la venderías?",
  "¿Cuál sería su precio?",
  "Tiene un número en mente para la propiedad",
];

const NOT_ASKS = [
  // offers / clarifiers quote a number
  "Would $150k work for you?",
  "My number would be 222K and I can close in 7 days. Does that work?",
  "Are you interested in moving forward with my offer at $132,000 cash with a 7 day close, or did you have a different price in mind?",
  "Just so I understood the number right, was that 180,000?",
  // negotiation, interest, condition, statements
  "What is your best price if we can close in 7 days?",
  "What's the lowest number you'd feel comfortable accepting?",
  "Open to discussing numbers for it?",
  "Are you open to a proposal?",
  "Does that price work for you to move forward?",
  "I can run my numbers and send you my best price. What is the current condition? Any major repairs or updates needed?",
  "How's the property overall? Anything that needs work?",
  "Thanks for sharing your asking price.",
  "The asking price on the listing was too high.",
  "",
  null,
];

test("classifier: every asking-price question (EN + ES) is recognised", () => {
  for (const text of ASKS) {
    const v = classifyAskingPriceQuestion(text);
    assert.equal(v.asking_price, true, `should be an asking-price question: ${JSON.stringify(text)}`);
    assert.ok(v.rule, text);
    assert.ok(["en", "es"].includes(v.language), text);
  }
  assert.equal(classifyAskingPriceQuestion("¿Cuánto pide por la propiedad?").language, "es");
  assert.equal(classifyAskingPriceQuestion("What would you take for it?").language, "en");
});

test("classifier: offers, clarifiers, negotiation, interest and statements are NOT asking-price questions (conservative)", () => {
  for (const text of NOT_ASKS) {
    assert.equal(classifyAskingPriceQuestion(text).asking_price, false, `should not be an asking-price question: ${JSON.stringify(text)}`);
  }
});

test("classifier: the S3 no-response anchor detector uses the same truth (no second implementation drift)", () => {
  assert.equal(isS3AskingPriceQuestion({ message_body: "Do you have an asking price in mind for the property?" }), true);
  assert.equal(isS3AskingPriceQuestion({ message_body: "Got it. What price would you have in mind for the property?" }), true);
  assert.equal(isS3AskingPriceQuestion({ message_body: "Would $150k work for you?" }), false);
  assert.equal(isS3AskingPriceQuestion({ use_case: "seller_asking_price" }), true);
  for (const t of ASKS) assert.equal(isS3AskingPriceQuestion({ message_body: t }), true, t);
  for (const t of NOT_ASKS) assert.equal(isS3AskingPriceQuestion({ message_body: t }), false, String(t));
});

test("use cases that ARE asks: …asking_price… and the S3 no-response chain", () => {
  for (const u of ["seller_asking_price", "asking_price_follow_up", "s3_no_response_fu1", "s3_no_response_fu2", "s3_no_response_nurture", "SELLER_ASKING_PRICE"]) assert.equal(isAskingPriceUseCase(u), true, u);
  for (const u of ["manual_reply", "condition_probe", "consider_selling", "s2_no_response_fu1", "offer_no_response_fu1", "nurture_not_interested", null]) assert.equal(isAskingPriceUseCase(u), false, String(u));
});

// ── 2. every writer stamps question_kind ───────────────────────────────────

async function canonicalInsert(row) {
  let captured = null;
  await insertSupabaseSendQueueRow(row, { insertSupabaseSendQueueRow: async (payload) => { captured = payload; return { ok: true, raw: payload }; } });
  return captured;
}

const BASE = { to_phone_number: "+16125550142", from_phone_number: "+16128060495", thread_key: "+16125550142", queue_status: "queued" };

test("canonical writer: manual send-now typed ask (use_case manual_reply) is stamped by the text classifier", async () => {
  const p = await canonicalInsert({ ...BASE, queue_key: "inbox:send_now:t1", use_case_template: "manual_reply", message_type: "manual_reply", message_body: "Do you have an asking price in mind?", metadata: { source: "manual_inbox", manual_operator_send: true } });
  assert.equal(p.metadata.question_kind, "asking_price");
  assert.equal(p.metadata.question_kind_source, "text_classifier");
  assert.equal(p.use_case_template, "manual_reply");
});

test("canonical writer: template auto-reply ask is stamped (text and use case agree)", async () => {
  const p = await canonicalInsert({ ...BASE, queue_key: "auto:t2", use_case_template: "seller_asking_price", message_body: "Got it. Do you have a price in mind for the property?", metadata: { source: "auto_reply" } });
  assert.equal(p.metadata.question_kind, "asking_price");
});

test("canonical writer: AI conversation row (source ai_conversation, R3) is stamped from its text", async () => {
  const p = await canonicalInsert({ ...BASE, queue_key: "ai:t3", use_case_template: "ai_reply", message_body: "Thanks Maria. What would you take for it?", source: "ai_conversation", metadata: { source: "ai_conversation" } });
  assert.equal(p.metadata.question_kind, "asking_price");
  // an AI decision may also DECLARE the S3 ask; a declaration can only make the row stricter
  const d = await canonicalInsert({ ...BASE, queue_key: "ai:t3b", use_case_template: "ai_reply", message_body: "Happy to help — and to make sure I'm in the right range, a figure would help.", metadata: { source: "ai_conversation", question_kind: "asking_price" } });
  assert.equal(d.metadata.question_kind, "asking_price");
  assert.equal(d.metadata.question_kind_source, "caller");
});

test("canonical writer: scheduled S3 no-response follow-up (copy resolved at dispatch) is stamped by its use case", async () => {
  const p = await canonicalInsert({ ...BASE, queue_key: "nr:t4", queue_status: "scheduled", use_case_template: "s3_no_response_fu1", message_body: "[deferred: resolved at dispatch]", metadata: { no_response_followup: { kind: "s3_asking_price", step: 0 } } });
  assert.equal(p.metadata.question_kind, "asking_price");
  assert.equal(p.metadata.question_kind_source, "use_case");
});

test("canonical writer: a nurture row whose copy re-asks the price is stamped; a non-ask is left alone", async () => {
  const n = await canonicalInsert({ ...BASE, queue_key: "nur:t5", queue_status: "scheduled", use_case_template: "nurture_not_interested", message_body: "Hi again — if you ever think about selling, do you have a number in mind?" });
  assert.equal(n.metadata.question_kind, "asking_price");
  const q = await canonicalInsert({ ...BASE, queue_key: "m:t6", use_case_template: "manual_reply", message_body: "How is the roof?" });
  assert.equal(q.metadata.question_kind, undefined);
  // a caller can never LOOSEN: an ask the classifier recognises stays an ask
  const l = await canonicalInsert({ ...BASE, queue_key: "m:t7", use_case_template: "manual_reply", message_body: "Any asking price in mind?", metadata: { question_kind: "other" } });
  assert.equal(l.metadata.question_kind, "asking_price");
});

test("campaign batch insert and the Discord reply route stamp before their direct inserts", () => {
  const campaign = fs.readFileSync(path.join(API_SRC, "lib/domain/campaigns/campaign-automation-service.js"), "utf8");
  const stampAt = campaign.indexOf("queueRow.metadata = stampOutboundQuestionKind(queueRow)");
  const insertAt = campaign.indexOf(".from('send_queue')\n          .insert(rowChunk)");
  assert.ok(stampAt > 0 && insertAt > stampAt, "campaign batch: stamp precedes the send_queue insert");
  const discord = fs.readFileSync(path.join(API_SRC, "app/api/internal/discord/reply-sms/route.js"), "utf8");
  const dStamp = discord.indexOf("payload.metadata = stampOutboundQuestionKind(payload)");
  const dInsert = discord.indexOf(".insert(payload)");
  assert.ok(dStamp > 0 && dInsert > dStamp, "discord: stamp precedes the send_queue insert");
  // and the stamp is the canonical one
  const row = { message_body: "What price would you be looking for?", use_case_template: "campaign_follow_up", metadata: { campaign_id: "c1" } };
  assert.equal(stampOutboundQuestionKind(row).question_kind, "asking_price");
  assert.equal(row.metadata.question_kind, undefined, "never mutates the caller's metadata");
});

test("buildSendQueueInsertPayload (every canonical insert) carries the stamp", () => {
  const p = buildSendQueueInsertPayload({ ...BASE, queue_key: "b:1", message_body: "¿Cuánto pide por la propiedad?", use_case_template: "manual_reply", metadata: {} });
  assert.equal(p.metadata.question_kind, "asking_price");
  assert.equal(resolveOutboundQuestionKind({ message_body: "How is the roof?" }).question_kind, null);
});

// ── 3/4. override shape, stripping, and the send-now verdict ────────────────

const NOW = "2026-10-15T15:00:00.000Z";
const OVERRIDE = { scope: "repeat_asking_price", actor: "op-uuid-1", reason: "Seller asked what we meant by price", at: NOW };

test("override: only the full server-built shape is valid; it survives only on a manual operator send", () => {
  assert.equal(isValidRepeatAskOverride(OVERRIDE), true);
  assert.equal(isValidRepeatAskOverride({ ...OVERRIDE, actor: "" }), false);
  assert.equal(isValidRepeatAskOverride({ ...OVERRIDE, reason: "short" }), false);
  assert.equal(isValidRepeatAskOverride({ ...OVERRIDE, scope: "anything" }), false);
  assert.equal(isValidRepeatAskOverride({ ...OVERRIDE, at: "nope" }), false);
  const auto = stampOutboundQuestionKind({ message_body: "x", metadata: { source: "auto_reply", repeat_ask_override: OVERRIDE } });
  assert.equal(auto.repeat_ask_override, undefined, "an automated row can never carry an override");
  assert.equal(auto.repeat_ask_override_stripped, "not_a_manual_operator_send");
  const manual = stampOutboundQuestionKind({ message_body: "x", metadata: { manual_operator_send: true, repeat_ask_override: OVERRIDE } });
  assert.deepEqual(manual.repeat_ask_override, OVERRIDE);
  const malformed = stampOutboundQuestionKind({ message_body: "x", metadata: { manual_operator_send: true, repeat_ask_override: { ...OVERRIDE, reason: "" } } });
  assert.equal(malformed.repeat_ask_override, undefined);
});

test("buildRepeatAskOverride: needs the explicit request, a manual send-now, a verified actor and a reason", () => {
  assert.deepEqual(buildRepeatAskOverride({}), { requested: false });
  assert.equal(buildRepeatAskOverride({ repeat_ask_override: true, repeat_ask_override_actor: "op", override_reason: "Clarifying the price question" }, { manual_operator_send: false }).reason, "repeat_ask_override_not_allowed_for_path");
  assert.equal(buildRepeatAskOverride({ repeat_ask_override: true, override_reason: "Clarifying the price question" }, { manual_operator_send: true }).reason, "repeat_ask_override_actor_required");
  assert.equal(buildRepeatAskOverride({ repeat_ask_override: true, repeat_ask_override_actor: "op", override_reason: "why" }, { manual_operator_send: true }).reason, "repeat_ask_override_reason_required");
  const ok = buildRepeatAskOverride({ repeat_ask_override: true, repeat_ask_override_actor: "op", override_reason: "  Clarifying   the price question ", operator_email: "o@x" }, { manual_operator_send: true, now: NOW });
  assert.equal(ok.ok, true);
  assert.deepEqual({ ...ok.override, client_send_id: undefined }, { scope: "repeat_asking_price", actor: "op", operator_email: "o@x", reason: "Clarifying the price question", at: NOW, client_send_id: undefined });
  assert.equal(isValidRepeatAskOverride(ok.override), true);
});

test("repeatAskBlockOf reads the guard's verdict off the returned row", () => {
  assert.equal(repeatAskBlockOf({ queue_status: "queued" }), null);
  assert.deepEqual(repeatAskBlockOf({ queue_status: "cancelled", paused_reason: "blocked_repeat_asking_price" }), { paused_reason: "blocked_repeat_asking_price", seller_replied: false });
  assert.equal(repeatAskBlockOf({ queue_status: "cancelled", paused_reason: "blocked_repeat_asking_price_seller_replied" }).seller_replied, true);
  assert.equal(repeatAskBlockOf({ queue_status: "cancelled", paused_reason: "operator_cancelled" }), null);
});

const SELLER = "+16125550142";
const SENDER = "+16128060495";

function sendNowDeps({ inserted, insertRaw = null, compliance = { blocked: false }, canSend = { ok: true } } = {}) {
  return {
    getSystemValue: async () => null,
    env: {},
    loadOutboundNumberByPhone: async (phone) => ({ id: "n1", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 }),
    loadThreadSender: async () => null,
    routeThreadFallback: async () => null,
    resolveOperatorAction: async () => ({ ok: true, operator_action_id: "opa-1" }),
    hardComplianceCheckImpl: async () => compliance,
    canSendImpl: async () => canSend,
    checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
    recentDeliveryFailuresImpl: async () => ({ suppress: false }),
    insertImpl: async (row) => {
      inserted.push(row);
      const raw = insertRaw ? insertRaw(row) : { id: "row-1", queue_status: row.queue_status, metadata: row.metadata };
      return { ok: true, queue_row_id: "row-1", queue_item_id: "row-1", raw };
    },
  };
}

const ask = (extra = {}) => ({
  thread_key: SELLER,
  to_phone_number: SELLER,
  from_phone_number: SENDER,
  message_body: "Do you have an asking price in mind?",
  action: "send_now",
  source: "manual_inbox",
  ...extra,
});

test("send-now: a repeat ask the guard cancelled is reported as blocked (409), never as queued", async () => {
  const inserted = [];
  const out = await createInboxSendNowQueueRow(ask(), sendNowDeps({ inserted, insertRaw: (row) => ({ id: "row-1", queue_status: "cancelled", paused_reason: "blocked_repeat_asking_price", metadata: row.metadata }) }));
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.reason, "repeat_asking_price_blocked");
  assert.equal(out.queue_status, "cancelled");
  assert.equal(out.repeat_ask_override_allowed, true);
  assert.equal(inserted[0].metadata.manual_operator_send, true);
  assert.equal(inserted[0].metadata.repeat_ask_override, undefined);
});

test("send-now: the audited override is recorded (actor, reason, at) and is NOT operator_override", async () => {
  const inserted = [];
  const out = await createInboxSendNowQueueRow(ask({ repeat_ask_override: true, override_reason: "Seller asked what we meant by price", repeat_ask_override_actor: "op-uuid-1", operator_email: "owner@example.com" }), sendNowDeps({ inserted }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const meta = inserted[0].metadata;
  assert.equal(meta.repeat_ask_override.scope, "repeat_asking_price");
  assert.equal(meta.repeat_ask_override.actor, "op-uuid-1");
  assert.equal(meta.repeat_ask_override.reason, "Seller asked what we meant by price");
  assert.ok(Date.parse(meta.repeat_ask_override.at));
  assert.equal(meta.operator_override, false, "the asking-price override never relaxes other guards");
  assert.equal(meta.manual_operator_send, true);
});

test("send-now: an override smuggled inside metadata is discarded; only the explicit, verified request counts", async () => {
  const inserted = [];
  await createInboxSendNowQueueRow(ask({ metadata: { repeat_ask_override: OVERRIDE } }), sendNowDeps({ inserted }));
  assert.equal(inserted[0].metadata.repeat_ask_override, undefined);
});

test("send-now: override without a verified actor (403) or reason (400) is refused before any row exists", async () => {
  for (const [extra, status, reason] of [
    [{ repeat_ask_override: true, override_reason: "Seller asked what we meant by price" }, 403, "repeat_ask_override_actor_required"],
    [{ repeat_ask_override: true, repeat_ask_override_actor: "op-uuid-1", override_reason: "" }, 400, "repeat_ask_override_reason_required"],
  ]) {
    const inserted = [];
    const out = await createInboxSendNowQueueRow(ask(extra), sendNowDeps({ inserted }));
    assert.equal(out.ok, false);
    assert.equal(out.status, status);
    assert.equal(out.reason, reason);
    assert.equal(inserted.length, 0);
  }
});

test("send-now: the override exists for send-now only (queue / schedule paths refuse it)", async () => {
  const inserted = [];
  const out = await createInboxSendNowQueueRow(ask({ action: "queue_reply", source: "inbox", repeat_ask_override: true, repeat_ask_override_actor: "op-uuid-1", override_reason: "Seller asked what we meant by price" }), sendNowDeps({ inserted }));
  assert.equal(out.reason, "repeat_ask_override_not_allowed_for_path");
  assert.equal(inserted.length, 0);
});

test("SUPPRESSION STILL BLOCKS AN OVERRIDDEN SEND: compliance (STOP / DNC / legal) and phone suppression refuse it, no row", async () => {
  const overridden = ask({ repeat_ask_override: true, repeat_ask_override_actor: "op-uuid-1", override_reason: "Seller asked what we meant by price" });
  const a = [];
  const blocked = await createInboxSendNowQueueRow(overridden, sendNowDeps({ inserted: a, compliance: { blocked: true, reason: "compliance_suppression_list" } }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 423);
  assert.equal(blocked.reason, "compliance_blocked");
  assert.equal(a.length, 0);
  const b = [];
  const suppressed = await createInboxSendNowQueueRow(overridden, sendNowDeps({ inserted: b, canSend: { ok: false, reason: "phone_suppressed" } }));
  assert.equal(suppressed.ok, false);
  assert.equal(suppressed.status, 423);
  assert.equal(suppressed.reason, "phone_suppressed");
  assert.equal(b.length, 0);
});

test("send-now: a seller-replied S3 cancellation never offers the override", async () => {
  const inserted = [];
  const out = await createInboxSendNowQueueRow(ask(), sendNowDeps({ inserted, insertRaw: () => ({ id: "row-1", queue_status: "cancelled", paused_reason: "blocked_repeat_asking_price_seller_replied" }) }));
  assert.equal(out.reason, "repeat_asking_price_blocked");
  assert.equal(out.repeat_ask_override_allowed, false);
});

test("cockpit + internal routes take the actor from x-ops-user-id, never from the body", () => {
  const cockpitRoute = fs.readFileSync(path.join(API_SRC, "app/api/cockpit/inbox/send-now/route.js"), "utf8");
  assert.match(cockpitRoute, /request\.headers\.get\('x-ops-user-id'\)/);
  assert.match(cockpitRoute, /runInboxAction\(\{ action: 'send-now', payload: \{ \.\.\.payload, dry_run: false \}, actor \}\)/);
  const svc = fs.readFileSync(path.join(API_SRC, "lib/cockpit/cockpit-service.js"), "utf8");
  assert.match(svc, /repeat_ask_override_actor: clean\(actor\) \|\| null,/);
  assert.match(svc, /repeat_ask_override: false,\n\s+repeat_ask_override_actor: null,/);
  const internal = fs.readFileSync(path.join(API_SRC, "app/api/internal/inbox/send-now/route.js"), "utf8");
  assert.match(internal, /repeat_ask_override_actor: clean\(request\.headers\.get\("x-ops-user-id"\)\) \|\| null/);
});
