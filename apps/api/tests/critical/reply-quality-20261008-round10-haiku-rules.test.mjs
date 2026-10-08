/**
 * Round 10 (owner, 2026-10-08) — classifier rules from the offline Haiku 5.5
 * reply audit (2,053 inbound since 2026-04-01). Deterministic, rules-only.
 *
 *  1. An owner who confirms ownership while declining keeps an ownership fact;
 *     the intent stays not_interested (30-day nurture), never a positive lead.
 *  2. Ownership DENIAL (property-scoped: closes person x property, phone kept)
 *     vs WRONG NUMBER (phone blocked).
 *  3. Missed explicit revocations (incl. Spanish) are opt-outs that override.
 *  4. Legal threat + stop demand -> opt-out + human legal-review flag.
 *  5. Misspelled not-for-sale; "Si porque" / "Yes. Why"; "how did you get my
 *     number"; under contract / listed.
 *  +  Language: plain Spanish is detected; an unknown language is never English
 *     by default (last outbound language, else hold).
 *
 * Every string is the exact scrubbed seller text from the audit (surrogate
 * keys in comments), replayed through the live chain
 * (buildConversationContext -> classify -> executeInboundAutomationDecision).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  matchRound10OptOut,
  detectOwnershipAffirmation,
  matchesInfoSourceQuestion,
  matchesListedOrUnderContract,
} from "@/lib/domain/classification/round10-reply-rules.js";
import { identifyReplyLanguage } from "@/lib/domain/classification/seller-reply-language.js";
import {
  resolveInboxBucketFromClassification,
  resolveThreadFlagsFromClassification,
  resolveDispositionFromClassification,
  resolveOwnershipProbeDisinterestTransition,
} from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { resolveRound10ReplyLanguage } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { deriveChecklist, planSellerConversationV3 } from "@/lib/domain/seller-flow/seller-conversation-v3.js";
import { resolveDeferredQueueMessage } from "@/lib/domain/queue/resolve-deferred-queue-message.js";

const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;
const QUESTION = "Hey Pat, this is Alex. 🙂 Are you still the owner of 606 Winterbrooke Way?";
const QUESTION_ES = "Hola Pat, soy Alex. ¿Sigue siendo el dueño de 606 Winterbrooke Way?";
const EV = { direction: "inbound", received_at: "2026-10-08T18:00:00.000Z" };

function fixture(message, text = QUESTION) {
  return {
    fixture_id: "r10h",
    received_at: "2026-10-08T18:00:00.000Z",
    seller_message: message,
    prior_question: { message_type: null, template_id: "t-r10h", template_use_case: "ownership_check", text, sent_at: "2026-10-08T17:00:00.000Z", delivered_at: "2026-10-08T17:00:05.000Z" },
    intervening_inbound: [],
    r7_history: [],
    valuation: null,
  };
}
const replay = (message, text) => replayReply(fixture(message, text), { catalog: CATALOG });

// ── 1. ownership confirmed while declining ──────────────────────────────────
for (const [key, message] of [
  ["R0009", "Yes,but not for sale!"],
  ["R0131", "Yes but not for sale."],
  ["R1352", "Yes I am    Not interested Ty"],
  ["R0225", "We do. Keeping that one"],
  ["R0194", "It is mine. I am not selling it."],
  ["R0600", "I am the owner but not interested in selling."],
  ["R0581", "I do and I don't want to sell"],
  ["R0121", "Si pero No está en venta"],
  ["R0825", "Si soy el dueño pero gracias no estoy interesado en vender"],
  ["R1912", "Hola si y no estoy interesada en vender gracias"],
]) {
  test(`${key} ownership kept, decline nurtured: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message, /^(Si|Hola)/.test(message) ? QUESTION_ES : QUESTION);
    const c = r.classification;
    assert.equal(c.primary_intent, "not_interested", message);
    assert.ok(c.secondary_intents.includes("ownership_confirmed"), JSON.stringify(c.secondary_intents));
    assert.equal(c.ownership_fact?.ownership_confirmed, true);
    assert.equal(r.text, null, "no positive reply");
    assert.equal(r.decision.should_queue_reply, false);
    assert.notEqual(c.compliance_flag, "stop_texting");
    // Never New Replies / Priority.
    const bucket = resolveInboxBucketFromClassification(c, EV, {});
    assert.ok(!["new_replies", "priority"].includes(bucket), `bucket ${bucket}`);
    // The thread keeps the ownership fact (ownership probe -> nurture).
    const probe = resolveOwnershipProbeDisinterestTransition({ classification: c, messageEvent: { message_body: message, direction: "inbound" }, existingState: { conversation_stage: "ownership_confirmation" } });
    assert.equal(probe?.ownership_status, "confirmed");
    assert.equal(probe?.ownership_inference_reason, "owner_confirmed_declined_sale");
    assert.equal(probe?.inbox_bucket, "follow_up");
    // The v3 checklist collects ownership from this turn.
    const cl = deriveChecklist({ classification: c, message, stage: "S1" });
    assert.equal(cl.ownership.collected, true);
    assert.equal(cl.ownership.source, "this_turn");
  });
}

test("ownership affirmation precision", () => {
  for (const m of ["I am not interested", "My son is the owner", "Si no me molestas", "Ya te dije que no", "Yes I used to own it", "Yes, not mine"]) {
    assert.equal(detectOwnershipAffirmation(m, { ownership_question: true }).matched, false, m);
  }
  // A bare "Yes" only counts as the answer to OUR ownership question.
  assert.equal(detectOwnershipAffirmation("Yes, but not for sale", { ownership_question: false }).matched, false);
  assert.equal(detectOwnershipAffirmation("Yes I own it but not selling", { ownership_question: false }).matched, true);
});

// ── 2. ownership denial (property-scoped) vs wrong number (phone) ──────────
for (const [key, message] of [
  ["R0074", "Never was"],
  ["R0102", "Never did"],
  ["R0136", "No I never owned anything up here"],
  ["R0222", "Hello. I do not own any property thanks."],
  ["R0516", "No, I'm not the owner of the house."],
  ["R0722", "Never owned it"],
  ["R0772", "Don't own the property"],
  ["R0803", "No I do not own that"],
  ["R0830", "i've never owned that property"],
  ["R1227", "That's not my house"],
  ["R1405", "No, not mine"],
  ["R1566", "Not the owner"],
  ["R1587", "Nunca tuve esa propiedad"],
  ["R1618", "Yo no tengo ninguna propiedad en esa dirección"],
  ["R0674", "Not me"],
  ["R1467", "No.  I am not on Vincent Ave."],
  ["R0073", "No it isn't"],
  ["R0418", "No it is not"],
  ["R0425", "No, and I never have been"],
  ["R0178", "Keep looking"],
  ["R0154", "Sorry but I don't think I'm old enough to own a house yet so no."],
  ["R0682", "I'm sorry, but I have nothing to do with this property—I don't know anything about it."],
  ["R0644", "No es mi propiedada pero si tu tiene casa yo te la puedo conprara"],
]) {
  test(`${key} ownership denial is property-scoped: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message, /^(Nunca|Yo|No es)/.test(message) ? QUESTION_ES : QUESTION);
    const c = r.classification;
    assert.equal(c.primary_intent, "property_specific_non_owner", `${message} -> ${c.primary_intent} ${c.matched_rule_ids}`);
    assert.equal(c.automation_decision.suppression_action, "close_property_not_owner");
    assert.equal(c.disposition_hint, "not_owner");
    // The phone is NOT blocked: no suppression, no wrong-number mark.
    assert.equal(r.decision.should_suppress_contact, false);
    assert.notEqual(r.decision.suppression_reason, "wrong_number");
    assert.equal(r.decision.next_action, "disposition_property_not_owner");
    assert.equal(r.text, null);
    assert.equal(resolveThreadFlagsFromClassification(c).wrong_number, false);
    assert.equal(resolveInboxBucketFromClassification(c, EV, {}), "dead");
    assert.equal(resolveDispositionFromClassification(c, EV, {}, "dead"), "unqualified");
  });
}

for (const [key, message] of [
  ["wn-1", "wrong number"],
  ["wn-2", "you have the wrong person"],
  ["R0265", "WRONG PERSON"],
  ["R0338", "I do Not own any property you have the wrong person"],
  ["R0854", "Disculpa no soy Dan"],
  ["R0853", "Not Shirley"],
]) {
  test(`${key} wrong-number claim still blocks the phone: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message);
    const c = r.classification;
    assert.equal(c.primary_intent, "wrong_number", `${message} -> ${c.primary_intent}`);
    assert.equal(c.automation_decision.suppression_action, "archive_wrong_number");
    assert.equal(r.decision.should_suppress_contact, true);
    assert.equal(r.decision.suppression_reason, "wrong_number");
    assert.equal(resolveThreadFlagsFromClassification(c).wrong_number, true);
  });
}

test("v3: an ownership denial archives the property (no reply); a number in it is a referral capture", () => {
  const base = { stage_before: "ownership_confirmation", conversation_context: { last_outbound_use_case: "ownership_check" }, known_facts: {}, now: Date.parse("2026-10-08T18:00:00Z") };
  const denial = { primary_intent: "property_specific_non_owner", matched_rule_ids: ["r10_ownership_denial_not_owner"], automation_decision: {} };
  const p1 = planSellerConversationV3({ ...base, classification: denial, message: "Never owned it" });
  assert.equal(p1.action, "terminal");
  assert.equal(p1.reasoning_code, "v3_not_owner_denial_archived_property");
  const p2 = planSellerConversationV3({ ...base, classification: denial, message: "Never been the owner His name is <NAME> 555-555-0142" });
  assert.equal(p2.reasoning_code, "v3_not_owner_referral_number_captured");
});

// ── 3. the 13 compliance misses (compliance_optout_misses.csv) ─────────────
for (const [key, message, text] of [
  ["R0090", "I don't care who you are.You have the wrong #.Stop sending text to this #.go to a real estate,there are plany of houses for sale."],
  ["R0140", "Not for sale. Please do not bother us thanks!"],
  ["R0169", "Yes I'm not interested in selling  Please take off any list it may be on"],
  ["R0235", "Y si no me irás planta borra mi pinche número", QUESTION_ES],
  ["R0287", "No está a la venta ... quite este número de la lista. Gracias", QUESTION_ES],
  ["R0590", "Yes I am. Not interested in selling. Cease and desist immediately from calling me."],
  ["R0704", "Frankly, I don't give a damn who you are or where you are, but I would like to know what damn business it of yours as to what I own, or where it is located! Now, please do not bother me again with these stupid inquiries! Audios"],
  ["R0812", "puedes degar de molestar", QUESTION_ES],
  ["R0933", "No that house is not mine No more"],
  ["R1296", "I'll sue you if you text me again"],
  ["R1331", "rwmove me from all you lists"],
  ["R1489", "Yes please don't call about my house"],
  ["extra", "please do not bother us"],
  ["R0770", "No yo vibo en apartamento  no  tengo casa no molestes", QUESTION_ES],
]) {
  test(`${key} explicit revocation -> opt-out (canonical suppression): ${JSON.stringify(message).slice(0, 70)}`, async () => {
    const r = await replay(message, text);
    const c = r.classification;
    assert.equal(c.compliance_flag, "stop_texting", `${message} -> ${c.primary_intent} ${c.matched_rule_ids}`);
    assert.equal(c.automation_decision.suppression_action, "opt_out");
    assert.equal(r.decision.should_suppress_contact, true);
    assert.equal(r.decision.suppression_reason, "opt_out");
    assert.equal(r.outcome, "suppressed");
    assert.equal(r.text, null);
    // Never quietly archived.
    assert.notEqual(c.automation_decision.quiet_archive, true);
  });
}

// ── 4. legal threat + stop demand -> opt-out + legal review ────────────────
for (const message of ["I'll sue you if you text me again", "Yes I am. Not interested in selling. Cease and desist immediately from calling me.", "If you text me again my lawyer will be in touch", "Stop texting me or I will sue"]) {
  test(`legal threat with a stop demand -> opt-out + human legal review: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message);
    const c = r.classification;
    assert.equal(c.compliance_flag, "stop_texting");
    assert.equal(c.legal_review_required, true);
    assert.equal(c.automation_decision.legal_review_required, true);
    assert.equal(r.decision.should_suppress_contact, true);
    assert.equal(r.decision.legal_review_required, true);
    assert.equal(r.decision.should_mark_human_review, true);
    assert.equal(r.decision.human_review_reason, "legal_threat_opt_out");
  });
}

test("a legal threat WITHOUT a stop demand keeps the human (never a quiet archive)", async () => {
  const r = await replay("I'm calling my lawyer");
  assert.notEqual(r.classification.automation_decision.quiet_archive, true);
  assert.equal(r.decision.should_mark_human_review, true);
});

test("hostile wording carrying a stop request is suppressed, not quietly archived", async () => {
  const r = await replay("Y si no me irás planta borra mi pinche número", QUESTION_ES);
  assert.equal(r.classification.primary_intent, "opt_out");
  assert.notEqual(r.decision.next_action, "close_quietly");
});

// Precision: nothing new turns ordinary sentences into opt-outs.
for (const message of [
  "Why don't you call me tomorrow",
  "do not email me, text is fine. what is your offer?",
  "Don't call me, text me instead",
  "it doesn't bother me",
  "Did you get my number from a list?",
  "I don't own it no more",
  "Remove the old carpet and it's fine",
  "I will get it off the market soon",
  "It is listed as a duplex but it's a single family",
  "No more than 250k",
]) {
  test(`not an opt-out: ${JSON.stringify(message)}`, async () => {
    assert.equal(matchRound10OptOut(message).matched, false, message);
    const c = await classify(message, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "opt_out", message);
  });
}

// ── 5. misspellings, who/why, info source, listed ──────────────────────────
for (const message of ["No esta de bents", "No esta d vents", "No esta en banta", "No. No la vend", "NFS"]) {
  test(`misspelled not-for-sale -> not_interested: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message, QUESTION_ES);
    assert.equal(r.classification.primary_intent, "not_interested", message);
    assert.equal(r.text, null);
  });
}

for (const [key, message, text] of [
  ["R0445", "Si porque", QUESTION_ES],
  ["R0800", "Yes. Why"],
  ["R0647", "Yes. Why?"],
  ["R1685", "It is.  Why do you ask"],
]) {
  test(`${key} yes + why at the ownership question -> who/why reply, ownership kept: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message, text);
    const c = r.classification;
    assert.equal(c.primary_intent, "who_is_this");
    assert.equal(c.ownership_fact?.ownership_confirmed, true);
    assert.ok(c.secondary_intents.includes("ownership_confirmed"));
    assert.equal(r.template?.use_case, "who_is_this");
    assert.ok(r.text && /investor/i.test(r.text) || /inversionista/i.test(r.text || ""), r.text);
  });
}

for (const [key, message, lang] of [
  ["R1703", "How did you get my number?", "English"],
  ["R1692", "How did you get my nbr?", "English"],
  ["R1615", "Howd you get my number?", "English"],
  ["R0436", "Where did you get my number from. What app did u download", "English"],
  ["R0709", "How do you know my name?", "English"],
  ["R0172", "Hola buenas como encontraste mi información??", "Spanish"],
]) {
  test(`${key} info-source question -> info_source_explanation: ${JSON.stringify(message)}`, async () => {
    assert.equal(matchesInfoSourceQuestion(message), true);
    const r = await replay(message, lang === "Spanish" ? QUESTION_ES : QUESTION);
    assert.equal(r.classification.primary_intent, "who_is_this");
    assert.ok(r.classification.secondary_intents.includes("how_got_number"));
    assert.equal(r.template?.use_case, "info_source_explanation");
    assert.match(r.text || "", lang === "Spanish" ? /registros publicos/ : /public county records/);
  });
}

for (const [key, message] of [
  ["R0967", "Under contract"],
  ["R1291", "It's under contract already"],
  ["R1781", "It’s listed with a realtor"],
]) {
  test(`${key} listed / under contract -> listed disposition, nurture lane kept: ${JSON.stringify(message)}`, async () => {
    const r = await replay(message);
    const c = r.classification;
    assert.equal(c.disposition_hint, "already_listed");
    assert.ok(c.secondary_intents.includes("already_listed"));
    assert.equal(c.primary_intent, "not_interested");
    assert.equal(r.text, null);
    assert.notEqual(r.decision.should_suppress_contact, true);
  });
}

test("listed precision", () => {
  assert.equal(matchesListedOrUnderContract("YES, IT IS UNDER CONTRACT WITH RENTAL. NOT FOR SALE."), false);
  assert.equal(matchesListedOrUnderContract("Yes not listed not for sale"), false);
  assert.equal(matchesListedOrUnderContract("How long until we're under contract?"), false);
  assert.equal(matchesListedOrUnderContract("It is listed as a duplex"), false);
  assert.equal(matchesListedOrUnderContract("Im still the owner and the property is listed at 15k"), false);
  assert.equal(matchRound10OptOut("no molesta para nada, pero no vendo").matched, false);
});

// ── language: plain Spanish is detected; unknown never defaults to English ──
for (const message of ["No estoy vendiendo la casa", "Estoy vendiendo", "La casa no se vende", "No vendo", "No me interesa", "Ya la vendí", "no gracias", "Soy la dueña"]) {
  test(`plain Spanish is identified: ${JSON.stringify(message)}`, async () => {
    assert.equal(identifyReplyLanguage(message), "Spanish", message);
    assert.equal((await classify(message, null, { heuristicOnly: true })).language, "Spanish", message);
  });
}

test("reply language = the SELLER's inbound evidence only; our outbound never decides; none -> HOLD", () => {
  const unknown = { language: "unknown", source: "unknown", is_unknown: true };
  // Seller-derived (this reply / seller history / switch request) decides.
  assert.equal(resolveRound10ReplyLanguage(unknown, { classification: { language: "Spanish", reply_language_source: "seller_reply" } }).language, "Spanish");
  assert.equal(resolveRound10ReplyLanguage(unknown, { classification: { language: "Spanish", reply_language_source: "seller_history" } }).language, "Spanish");
  // Our last outbound's language is context only -> HOLD.
  const outboundOnly = resolveRound10ReplyLanguage(unknown, { classification: { language: "Spanish", reply_language_source: "thread" } });
  assert.equal(outboundOnly.is_unknown, true);
  assert.equal(outboundOnly.source, "hold_language");
  assert.equal(outboundOnly.context_languages.last_outbound, "Spanish");
  assert.equal(resolveRound10ReplyLanguage(unknown, { context: { summary: { last_outbound_language: "Vietnamese", language: "Vietnamese" } } }).is_unknown, true);
  // classify.js's "detected" English default is not evidence.
  assert.equal(resolveRound10ReplyLanguage({ language: "English", source: "high_confidence_detection", is_unknown: false }, { classification: { language: "English", reply_language_source: "detected" }, messageText: "mmm vale ok ok" }).is_unknown, true);
  // Evidence in the reply text itself decides.
  assert.equal(resolveRound10ReplyLanguage(unknown, { classification: { language: "English", reply_language_source: "detected" }, messageText: "No estoy vendiendo la casa" }).language, "Spanish");
  assert.equal(resolveRound10ReplyLanguage(unknown, { messageText: "Not interested in selling" }).language, "English");
  // A thread language with no seller evidence no longer decides.
  assert.equal(resolveRound10ReplyLanguage({ language: "Spanish", source: "thread_language", is_unknown: false }, { classification: { language: "Spanish", reply_language_source: "thread" }, messageText: "👍" }).is_unknown, true);
  // A caller-built classification (not classify.js output) that states a language.
  assert.equal(resolveRound10ReplyLanguage(unknown, { classification: { language: "English" } }).source, "stated_classification_language");
  assert.equal(resolveRound10ReplyLanguage(unknown, {}).is_unknown, true);
});

test("auto-reply: an unidentifiable reply with only our outbound language HOLDS (no send, no English default)", async () => {
  const r = await replay("👍👍", QUESTION_ES);
  assert.equal(r.text, null);
  assert.equal(r.result.queued, false);
});

function templatesSupabase(templates) {
  return {
    from(table) {
      const f = {};
      const c = {
        select: () => c,
        eq: (k, v) => { f[k] = v; return c; },
        in: (k, v) => { f[k] = v; return c; },
        maybeSingle: async () => ({ data: null, error: null }),
        limit: async () => ({
          data: table === "sms_templates" ? templates.filter((t) => (f.language || []).includes(t.language) && (f.use_case || []).includes(t.use_case)) : [],
          error: null,
        }),
      };
      return c;
    },
  };
}
const NURTURE_TEMPLATES = [
  { template_id: "521105", use_case: "consider_selling_follow_up", language: "English", is_active: true, safe_for_auto_reply: true, template_body: "{{seller_first_name}}, just checking back on {{property_address}}. Would you be open to a proposal?" },
];
const nurtureRow = (extra = {}) => ({
  id: "q-r10", to_phone_number: "+13125550100", property_id: "p1", use_case_template: "nurture_not_interested", message_body: "",
  seller_first_name: "Maria", property_address: "412 W Oak St", agent_name: "Alex", from_phone_number: "+16125550199",
  metadata: { deferred_message_resolution: true, intent: "not_interested", inbound_message_event_id: "me-1" },
  ...extra,
});

test("nurture at send time: unknown language HOLDS (no English default); a Spanish row never renders English copy", async () => {
  const unknown = await resolveDeferredQueueMessage(nurtureRow(), {
    supabase: templatesSupabase(NURTURE_TEMPLATES),
    loadNurtureRenderContext: async () => ({ language: null }),
  });
  assert.equal(unknown.resolved, false);
  assert.equal(unknown.reason, "hold_language");
  const spanish = await resolveDeferredQueueMessage(nurtureRow({ language: "Spanish" }), {
    supabase: templatesSupabase(NURTURE_TEMPLATES),
    loadNurtureRenderContext: async () => { throw new Error("not needed"); },
  });
  assert.equal(spanish.resolved, false, "only English copy exists: no English send to a Spanish thread");
  const english = await resolveDeferredQueueMessage(nurtureRow({ language: "English" }), {
    supabase: templatesSupabase(NURTURE_TEMPLATES),
    loadNurtureRenderContext: async () => { throw new Error("not needed"); },
  });
  assert.equal(english.resolved, true);
  assert.equal(english.template_id, "521105");
});

test("nurture render context: seller inbound evidence only; our outbound language is logged, never used", async () => {
  const { buildNurtureRenderContext } = await import("@/lib/domain/seller-flow/nurture-render-context.js");
  const outboundOnly = buildNurtureRenderContext({ known: {}, sent_rows_newest_first: [{ language: "Spanish", seller_first_name: "Maria" }], reply_text: "👍", intent: "not_interested" });
  assert.equal(outboundOnly.language, null);
  assert.equal(outboundOnly.nurture_render_context.language_source, "unknown");
  assert.equal(outboundOnly.nurture_render_context.outbound_language_context, "Spanish");
  const reply = buildNurtureRenderContext({ known: {}, sent_rows_newest_first: [{ language: "English" }], reply_text: "No me interesa", intent: "not_interested" });
  assert.equal(reply.language, "Spanish");
  assert.equal(reply.nurture_render_context.language_source, "seller_reply");
  const history = buildNurtureRenderContext({ known: {}, sent_rows_newest_first: [{ language: "English" }], reply_text: "ok", inbound_rows_newest_first: [{ message_body: "No estoy vendiendo la casa" }], intent: "not_interested" });
  assert.equal(history.language, "Spanish");
  assert.equal(history.nurture_render_context.language_source, "seller_history");
  // A caller language that itself came from our outbound is ignored.
  const stale = buildNurtureRenderContext({ known: { language: "English", language_source: "last_outbound" }, reply_text: "👍", intent: "not_interested" });
  assert.equal(stale.language, null);
});

test("nurture at send time: a row whose language came only from our outbound re-resolves from the seller, else HOLD", async () => {
  const row = nurtureRow({ language: "English" });
  row.metadata = { ...row.metadata, language: "English", nurture_render_context: { language_source: "last_outbound" } };
  const held = await resolveDeferredQueueMessage(row, {
    supabase: templatesSupabase(NURTURE_TEMPLATES),
    loadNurtureRenderContext: async () => ({ language: null }),
  });
  assert.equal(held.resolved, false);
  assert.equal(held.reason, "hold_language");
  const seller = await resolveDeferredQueueMessage(row, {
    supabase: templatesSupabase(NURTURE_TEMPLATES),
    loadNurtureRenderContext: async () => ({ language: "English" }),
  });
  assert.equal(seller.resolved, true);
});

for (const message of ["No me interesa", "No estoy interesado", "No gracias, no vendo", "No está en venta", "No quiero vender la casa"]) {
  test(`plain Spanish decline is identified as Spanish: ${JSON.stringify(message)}`, () => {
    assert.equal(identifyReplyLanguage(message), "Spanish", message);
  });
}

for (const [message, lang] of [["Chris who", "English"], ["Which Helen?", "English"], ["Yes $250k", "English"], ["It's occupied", "English"], ["Cuál Michael", "Spanish"], ["Y tu?", "Spanish"], ["Si porque", "Spanish"], ["Yes. Why", "English"], ["150k", null], ["👍", null], ["?", null], ["ok", null], ["No", null]]) {
  test(`short reply language evidence: ${JSON.stringify(message)} -> ${lang}`, () => {
    assert.equal(identifyReplyLanguage(message), lang, message);
  });
}
