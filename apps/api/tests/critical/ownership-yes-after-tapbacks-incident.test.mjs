/**
 * Production incident 2026-10-05, thread +18177347618 (Fort Worth, Dallas market).
 *
 * 13:38 outbound (send_queue 03a10e4e, message_type NULL, Spanish):
 *   "Hola Jose, Alex aqui. Sigues siendo el dueno de 2832 Milam St?"
 * 14:00–14:08 inbound tapbacks: "👍 to “…”" / "Removed 👍 from “…”" (with
 *   zero-width joiners around the emoji) and a stray "Vues", all `unclear`.
 * 14:08 inbound "Yes" → ownership_confirmed but
 *   ambiguity_flags ["short_reply_without_validated_context"], context_use_case
 *   null, auto_reply_allowed false. No reply was ever queued.
 *
 * Root cause: buildConversationContext counted EVERY intervening inbound as an
 * answer to the question, so the reactions marked it "already answered", the
 * context went stale and the bare "Yes" lost its question.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationContext,
  isInterveningAnswer,
} from "@/lib/domain/classification/build-conversation-context.js";
import { parsePlatformReaction } from "@/lib/domain/classification/emoji-interpretation.js";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  identifyReplyLanguage,
  resolveSellerReplyLanguage,
} from "@/lib/domain/classification/seller-reply-language.js";
import {
  applyInboundAutomationDecision,
  selectSafeAutoReplyTemplate,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const THREAD = "+18177347618";
const OPENER = "Hola Jose, Alex aqui. Sigues siendo el dueno de 2832 Milam St?";
const ZW = "​";
const ZWNJ = "‌";
const LIKE = `${ZW}👍${ZW} to “ ${OPENER} ”`;
const REMOVED = `Removed ${ZWNJ}👍${ZWNJ} from “ ${OPENER} ”`;

const OUTBOUND = {
  id: "03a10e4e-29fa-4ec9-83fe-ee2957555be3",
  message_type: null,
  message_body: OPENER,
  provider_message_id: null,
  sent_at: "2026-10-05T13:38:37.514Z",
  delivered_at: "2026-10-05T13:38:58.718Z",
  queue_status: "delivered",
};

// Exactly the production sequence, with the classification each row carried.
const INTERVENING = [
  { id: "0082d0ea", created_at: "2026-10-05T14:00:53.640Z", direction: "inbound", message_body: REMOVED, detected_intent: "unclear" },
  { id: "52b79ba3", created_at: "2026-10-05T14:00:58.668Z", direction: "inbound", message_body: LIKE, detected_intent: "unclear" },
  { id: "a20222eb", created_at: "2026-10-05T14:01:08.163Z", direction: "inbound", message_body: "Vues", detected_intent: "unclear" },
  { id: "2ab6aaca", created_at: "2026-10-05T14:01:25.272Z", direction: "inbound", message_body: REMOVED, detected_intent: "unclear" },
  { id: "d4f78f7a", created_at: "2026-10-05T14:01:25.338Z", direction: "inbound", message_body: LIKE, detected_intent: "unclear" },
  { id: "b8290f14", created_at: "2026-10-05T14:07:59.872Z", direction: "inbound", message_body: LIKE, detected_intent: "unclear" },
];
const YES_AT = "2026-10-05T14:08:55.173Z";

function supabaseWith({ outbound = [], intervening = [], templates = [] } = {}) {
  const make = (rows) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b,
      gt: () => b, lt: () => b, order: () => b,
      limit: async () => ({ data: rows, error: null }),
    };
    return b;
  };
  return {
    from: (table) =>
      make(table === "message_events" ? intervening : table === "sms_templates" ? templates : outbound),
  };
}

async function contextFor(intervening, outbound = [OUTBOUND], { at = YES_AT, templates = [] } = {}) {
  return buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: at,
    supabase: supabaseWith({ outbound, intervening, templates }),
  });
}

// The live executor with a fully identified thread (Jose's real ids), so the
// only variable is the classification.
function decide(classification) {
  return applyInboundAutomationDecision({
    classification,
    message: "Yes",
    threadKey: THREAD,
    phoneId: "phone",
    ownerId: "owner",
    prospectId: "prospect",
    propertyId: "2135720821",
    latestThreadContext: {
      summary: { conversation_stage: "Ownership Confirmation" },
      ids: { property_id: "2135720821", master_owner_id: "owner", prospect_id: "prospect" },
    },
  });
}

test("Spanish opener → tapbacks → 'Yes' binds ownership_confirmed WITH context, auto-reply allowed, ENGLISH (owner rule)", async () => {
  const ctx = await contextFor(INTERVENING);
  assert.equal(ctx.last_outbound_use_case, "ownership_check");
  assert.equal(ctx.question_status, "unanswered");
  assert.equal(ctx.intervening_inbound_count, 0);
  assert.equal(ctx.last_outbound_language, "Spanish");

  const r = await classify("Yes", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(r.primary_intent, "ownership_confirmed");
  assert.equal(r.context_status, "valid");
  assert.equal(r.context_use_case, "ownership_check");
  assert.ok(!(r.ambiguity_flags || []).includes("short_reply_without_validated_context"));
  assert.ok(r.confidence >= 0.82);
  assert.equal(r.automation_decision.auto_reply_allowed, true);
  assert.equal(r.automation_decision.queue_action, "queue_auto_reply");
  assert.equal(r.automation_decision.human_review_required, false);
  // OWNER RULE 2026-10-05: reply in the language the seller replied in.
  assert.equal(r.language, "English");
  assert.equal(r.reply_language_source, "seller_reply");
});

test("other short affirmatives after the same sequence bind too, each in the seller's own language", async () => {
  const ctx = await contextFor(INTERVENING);
  for (const [msg, language] of [["Si", "Spanish"], ["Sí", "Spanish"], ["Claro", "Spanish"], ["Yeah", "English"], ["Correct", "English"]]) {
    const r = await classify(msg, null, { heuristicOnly: true, conversation_context: ctx });
    assert.equal(r.primary_intent, "ownership_confirmed", msg);
    assert.equal(r.context_status, "valid", msg);
    assert.equal(r.automation_decision.auto_reply_allowed, true, msg);
    assert.equal(r.language, language, msg);
  }
});

test("seller reply language: substantive reply decides; ambiguous falls back to history, then thread", () => {
  assert.equal(identifyReplyLanguage("Yes"), "English");
  assert.equal(identifyReplyLanguage("Sí"), "Spanish");
  assert.equal(identifyReplyLanguage("Estoy interesado en vender la casa", { detected_language: "Spanish", explicit: true }), "Spanish");
  for (const ambiguous of ["ok", "Ok", "no", "👍", "250k", "350000", LIKE, REMOVED]) {
    assert.equal(identifyReplyLanguage(ambiguous), null, ambiguous);
  }
  assert.deepEqual(
    resolveSellerReplyLanguage({ message: "ok", detected_language: "English", seller_history_language: "Spanish", thread_language: "English" }),
    { language: "Spanish", source: "seller_history" }
  );
  assert.deepEqual(
    resolveSellerReplyLanguage({ message: "👍", detected_language: "English", thread_language: "Spanish" }),
    { language: "Spanish", source: "thread" }
  );
  assert.deepEqual(
    resolveSellerReplyLanguage({ message: "Yes", detected_language: "Spanish", thread_language: "Spanish" }),
    { language: "English", source: "seller_reply" }
  );
});

test("an ambiguous 'ok' after an earlier Spanish seller reply stays Spanish (history, not the English operator text)", async () => {
  const history = [
    { id: "h1", created_at: "2026-10-05T14:30:00Z", direction: "inbound", message_body: "Sí, todavía soy el dueño", language: "Spanish", detected_intent: "ownership_confirmed" },
  ];
  const englishQ = { ...OUTBOUND, message_body: "Thanks. Would you be open to a sale?", sent_at: "2026-10-05T14:20:00Z", delivered_at: "2026-10-05T14:20:05Z" };
  const ctx = await contextFor(history, [englishQ], { at: "2026-10-05T14:31:00Z" });
  assert.equal(ctx.seller_reply_language, "Spanish");
  const r = await classify("ok", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(r.language, "Spanish");
  assert.equal(r.reply_language_source, "seller_history");
});

test("the pre-fix behaviour: counting the tapbacks as answers left 'Yes' contextless", async () => {
  // Same rows without a body / stored intent: we cannot prove they said nothing.
  const blind = INTERVENING.map(({ id, created_at, direction }) => ({ id, created_at, direction }));
  const ctx = await contextFor(blind);
  assert.equal(ctx.question_status, "answered");
  const r = await classify("Yes", null, { heuristicOnly: true, conversation_context: ctx });
  assert.ok(r.ambiguity_flags.includes("short_reply_without_validated_context"));
  assert.equal(r.automation_decision.auto_reply_allowed, false);
});

test("a genuinely contextless 'Yes' (no prior opener) still goes to review", async () => {
  const ctx = await contextFor([], []);
  assert.equal(ctx, null);
  const r = await classify("Yes", null, { heuristicOnly: true, conversation_context: ctx });
  assert.ok(r.ambiguity_flags.includes("short_reply_without_validated_context"));
  assert.equal(r.automation_decision.auto_reply_allowed, false);
  assert.equal(r.automation_decision.human_review_required, true);
});

test("real answers in between still settle the question", async () => {
  for (const row of [
    { message_body: "No", detected_intent: "not_interested" },
    { message_body: "Stop", detected_intent: "opt_out" },
    { message_body: "Quien es", detected_intent: "who_is_this" },
    { message_body: "its a 3br", detected_intent: "unclear" },
    { message_body: "Vues", detected_intent: null },
    { message_body: `👎 to “ ${OPENER} ”`, detected_intent: "unclear" },
    { message_body: `Laughed at “${OPENER}”`, detected_intent: "unclear" },
  ]) {
    assert.equal(isInterveningAnswer(row), true, row.message_body);
  }
  const ctx = await contextFor([
    ...INTERVENING,
    { id: "x", created_at: "2026-10-05T14:08:00Z", direction: "inbound", message_body: "No", detected_intent: "not_interested" },
  ]);
  assert.equal(ctx.question_status, "answered");
});

test("tapback variants parse as reactions to OUR message", () => {
  const cases = [
    [LIKE, "affirmative", null],
    [`Liked “${OPENER}”`, "affirmative", "liked"],
    [`Loved “${OPENER}”`, "heart", "loved"],
    [`Emphasized “${OPENER}”`, "emphasis", "emphasized"],
    [`Questioned “${OPENER}”`, "confusion", "questioned"],
    [`Disliked “${OPENER}”`, "negative", "disliked"],
    [`Reacted 👍 to “${OPENER}”`, "affirmative", "reacted"],
    [`Reacted with ❤️ to "${OPENER}"`, "heart", "reacted"],
    [`Le gustó “${OPENER}”`, "affirmative", "le gusto"],
    [REMOVED, "removed", "removed"],
    [`Removed a like from “${OPENER}”`, "removed", "removed"],
    [`Removed a question mark from “${OPENER}”`, "removed", "removed"],
  ];
  for (const [body, family, verb] of cases) {
    const r = parsePlatformReaction(body);
    assert.ok(r, body);
    assert.equal(r.family, family, body);
    assert.equal(r.verb, verb, body);
    assert.equal(r.target_text, OPENER, body);
  }
  assert.equal(parsePlatformReaction("Yes"), null);
  assert.equal(parsePlatformReaction("Vues"), null);
});

test("'Removed 👍' is ignored: no reply, no review, nothing suppressed", async () => {
  const ctx = await contextFor([]);
  const r = await classify(REMOVED, null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(r.primary_intent, "acknowledgement");
  assert.deepEqual(
    { ...r.automation_decision },
    { auto_reply_allowed: false, queue_action: "none", suppression_action: "none", human_review_required: false, risk_level: "low", reply_kind: "reaction_removed" }
  );
  assert.equal(isInterveningAnswer({ message_body: REMOVED, detected_intent: "unclear" }), false);
});

test("a lone 👍 tapback ON our ownership question answers it like 'Yes' (owner rule 2026-10-06, round 8)", async () => {
  const ctx = await contextFor([]);
  const r = await classify(LIKE, null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(r.primary_intent, "ownership_confirmed");
  assert.equal(r.automation_decision.auto_reply_allowed, true);
  // No seller text: the opener's language.
  assert.equal(r.language, "Spanish");
});

test("compliance is untouched: STOP and wrong number after the tapbacks", async () => {
  const ctx = await contextFor(INTERVENING);
  const stop = await classify("STOP", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(stop.automation_decision.suppression_action, "opt_out");
  assert.equal(stop.automation_decision.auto_reply_allowed, false);
  const wrong = await classify("Wrong number", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(wrong.primary_intent, "wrong_number");
  assert.equal(wrong.automation_decision.auto_reply_allowed, false);
});

test("the live executor routes the bound 'Yes' to the S2 auto-reply (consider_selling)", async () => {
  const ctx = await contextFor(INTERVENING);
  const r = await classify("Yes", null, { heuristicOnly: true, conversation_context: ctx });
  const d = decide(r);
  assert.equal(d.should_queue_reply, true);
  assert.equal(d.should_mark_human_review, false);
  assert.equal(d.route_hint, "consider_selling");
});

test("the campaign row's template_id names the question when message_type is NULL", async () => {
  const row = { ...OUTBOUND, template_id: "201266", message_body: "Hola Jose, Alex aqui." };
  const ctx = await contextFor([], [row], { templates: [{ use_case: "ownership_check" }] });
  assert.equal(ctx.last_outbound_use_case, "ownership_check");
  assert.equal(ctx.last_outbound_use_case_source, "template_use_case");
});

// ── second turn on the same thread ──────────────────────────────────────────
// 14:17:28 the OPERATOR typed (send_queue 772d8529, message_type manual_reply,
//   no template): "Thanks. Just curious, would you be open to a sale?"
// 14:18:11 inbound "👍 to “ Yes ”" (acknowledgement)
// 14:18:18 inbound "Yes" → was ownership_confirmed + short_reply_without_
//   validated_context: "open to a sale" matched no body pattern, so the
//   operator's question was invisible and a bare yes fell to the
//   context-free ownership default.
const OPERATOR_Q = {
  id: "772d8529-ac2f-4e82-8fca-fa61134d0aca",
  message_type: "manual_reply",
  message_body: "Thanks. Just curious, would you be open to a sale?",
  template_id: null,
  provider_message_id: null,
  sent_at: "2026-10-05T14:17:28.360Z",
  delivered_at: "2026-10-05T14:17:46.754Z",
  queue_status: "delivered",
};
const SECOND_YES_AT = "2026-10-05T14:18:17.924Z";
const SECOND_INTERVENING = [
  { id: "17cd0d7c", created_at: "2026-10-05T14:18:11.129Z", direction: "inbound", message_body: `${ZW}👍${ZW} to “ Yes ”`, detected_intent: "acknowledgement" },
];

test("operator 'open to a sale?' → 👍 → 'Yes' is sale interest, not ownership; next reply is the S3 price ask", async () => {
  const ctx = await contextFor(SECOND_INTERVENING, [OPERATOR_Q], { at: SECOND_YES_AT });
  assert.equal(ctx.last_outbound_use_case, "proposal_interest");
  assert.equal(ctx.last_outbound_use_case_source, "derived_from_body");
  assert.equal(ctx.question_status, "unanswered");

  const r = await classify("Yes", null, { heuristicOnly: true, conversation_context: ctx });
  assert.notEqual(r.primary_intent, "ownership_confirmed");
  assert.equal(r.primary_intent, "seller_interested");
  assert.equal(r.context_status, "valid");
  assert.equal(r.context_use_case, "proposal_interest");
  assert.ok(!(r.ambiguity_flags || []).includes("short_reply_without_validated_context"));
  assert.equal(r.automation_decision.auto_reply_allowed, true);
  // The operator switched the conversation to English; a one-word reply keeps it there.
  assert.equal(r.language, "English");

  const d = decide(r);
  assert.equal(d.should_queue_reply, true);
  assert.equal(d.route_hint, "seller_asking_price");
  assert.ok(d.allowed_template_stages.includes("seller_asking_price"));
});

test("operator sale-interest questions in other phrasings and Spanish are recognised", async () => {
  const { deriveUseCaseFromBody } = await import("@/lib/domain/classification/build-conversation-context.js");
  for (const body of [
    "Would you be open to a sale?",
    "Would you consider selling it?",
    "Would you be willing to sell?",
    "Are you interested in selling?",
    "Have you thought about selling?",
    "¿Le interesaría vender la casa?",
    "¿Estaría abierto a vender?",
  ]) {
    assert.equal(deriveUseCaseFromBody(body), "proposal_interest", body);
  }
  // Ownership still wins when both are asked (identity first).
  assert.equal(deriveUseCaseFromBody("Do you still own 123 Main? Open to an offer?"), "ownership_check");
  // "Not for sale" style statements are not our question.
  assert.equal(deriveUseCaseFromBody("Thanks, I'll follow up next month."), null);
});

// ── auto-reply template language (owner rule) ───────────────────────────────

const tpl = (template_id, use_case, stage_code, language, template_body) => ({
  template_id, id: `uuid-${template_id}`, use_case, stage_code, stage_label: null,
  template_name: `${use_case}_${stage_code}_${language}_${template_id}`, language,
  reply_mode: "auto_reply", property_type_scope: null, allowed_property_groups: null,
  prohibited_property_groups: null, usage_count: 0, success_rate: null,
  updated_at: "2026-09-25T07:02:27.703827+00:00", is_active: true, safe_for_auto_reply: true, template_body,
});
const CATALOG = [
  tpl("cs_en", "consider_selling", "S2", "English", "Thanks for confirming. Would you consider a proposal for the property?"),
  tpl("cs_es", "consider_selling", "S2", "Spanish", "Gracias por confirmar. ¿Consideraría una propuesta por la propiedad?"),
  tpl("ap_en", "seller_asking_price", "S3", "English", "Got it. What price would you have in mind for the property?"),
  tpl("ap_es", "seller_asking_price", "S3", "Spanish", "Entendido. ¿Qué precio tendría en mente para la propiedad?"),
];
function templatesDb(rows = CATALOG) {
  const query = () => {
    const filters = [];
    let limit = null;
    const b = {
      select: () => b,
      eq: (c, v) => (filters.push((r) => r[c] === v), b),
      in: (c, vs) => (filters.push((r) => (vs || []).includes(r[c])), b),
      neq: () => b, is: () => b, not: () => b, lt: () => b, lte: () => b, gt: () => b, gte: () => b,
      or: () => b, ilike: () => b, like: () => b, contains: () => b, filter: () => b, match: () => b, range: () => b,
      order: () => b,
      limit: (n) => ((limit = n), b),
      maybeSingle: () => b,
      single: () => b,
      then(resolve, reject) {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (limit != null) out = out.slice(0, limit);
        return Promise.resolve({ data: out, error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { from: () => ({ select: query }), rpc: async () => ({ data: null, error: null }) };
}
// The thread was established in Spanish (the opener and every stored row).
const SPANISH_THREAD = { summary: { language: "Spanish", language_preference: "Spanish" }, automation_decision: { classification: { language: "Spanish" } } };
const ENGLISH_THREAD = { summary: { language: "English", language_preference: "English" }, automation_decision: { classification: { language: "English" } } };

async function replyTemplateFor(message, ctx, thread) {
  const classification = await classify(message, null, { heuristicOnly: true, conversation_context: ctx });
  const decision = decide(classification);
  const result = await selectSafeAutoReplyTemplate({ supabaseClient: templatesDb(), classification, decision, context: thread });
  return { classification, decision, result };
}

test("Spanish opener → English 'Yes' → the S2 reply is the ENGLISH template", async () => {
  const ctx = await contextFor(INTERVENING);
  const { decision, result } = await replyTemplateFor("Yes", ctx, SPANISH_THREAD);
  assert.equal(decision.route_hint, "consider_selling");
  assert.equal(result.ok, true);
  assert.equal(result.template.use_case, "consider_selling");
  assert.equal(result.template.language, "English");
});

test("Spanish opener → 'Sí' → the S2 reply is the SPANISH template", async () => {
  const ctx = await contextFor(INTERVENING);
  const { result } = await replyTemplateFor("Sí", ctx, SPANISH_THREAD);
  assert.equal(result.ok, true);
  assert.equal(result.template.use_case, "consider_selling");
  assert.equal(result.template.language, "Spanish");
});

test("English opener → a Spanish sentence → the reply is the SPANISH template", async () => {
  const englishOpener = { ...OUTBOUND, message_body: "Hi Jose, this is Alex. Are you still the owner of 2832 Milam St?" };
  const ctx = await contextFor([], [englishOpener]);
  assert.equal(ctx.last_outbound_language, "English");
  const { classification, result } = await replyTemplateFor("Sí, todavía soy el dueño de la casa", ctx, ENGLISH_THREAD);
  assert.equal(classification.primary_intent, "ownership_confirmed");
  assert.equal(classification.language, "Spanish");
  assert.equal(result.ok, true);
  assert.equal(result.template.language, "Spanish");
});

test("a bare 👍 / 'ok' never flips an established thread: the stored thread language still decides", async () => {
  for (const message of ["ok", "👍"]) {
    const classification = await classify(message, null, { heuristicOnly: true });
    // No context, no seller history: the language is not seller-derived, so
    // the established Spanish thread wins exactly as before.
    assert.notEqual(classification.reply_language_source, "seller_reply", message);
    const result = await selectSafeAutoReplyTemplate({
      supabaseClient: templatesDb(),
      classification,
      decision: { route_hint: "consider_selling", allowed_template_stages: ["consider_selling"] },
      context: SPANISH_THREAD,
    });
    assert.equal(result.ok, true, message);
    assert.equal(result.template.language, "Spanish", message);
  }
});

test("operator sale-interest 'Yes' → S3 price ask in the seller's language (English)", async () => {
  const ctx = await contextFor(SECOND_INTERVENING, [OPERATOR_Q], { at: SECOND_YES_AT });
  const { decision, result } = await replyTemplateFor("Yes", ctx, SPANISH_THREAD);
  assert.equal(decision.route_hint, "seller_asking_price");
  assert.equal(result.ok, true);
  assert.equal(result.template.use_case, "seller_asking_price");
  assert.equal(result.template.language, "English");
});
