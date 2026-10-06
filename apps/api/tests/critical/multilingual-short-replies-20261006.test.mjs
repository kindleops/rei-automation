/**
 * MULTILINGUAL (2026-10-06). We send in 16 languages; the classifier only
 * understood English and Spanish. Live: "是" (Mandarin "yes") to an English
 * ownership opener, Minneapolis 00:25:49 UTC -> unclear@0.6, no reply.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  canonicalizeMultilingualReply,
  parseLocalAmount,
  MULTILINGUAL_LANGUAGES,
} from "@/lib/domain/classification/multilingual-short-replies.js";
import {
  applyInboundAutomationDecision,
  selectSafeAutoReplyTemplate,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const EN_OPENER = "Hi Pat, this is Alex. Are you still the owner of 992 Main St?";

function supabaseFor({ body = EN_OPENER, intervening = [], templates = [] } = {}) {
  const outbound = {
    id: "out-1", message_type: null, message_body: body, template_id: null, provider_message_id: null,
    sent_at: "2026-10-06T00:20:00.000Z", delivered_at: "2026-10-06T00:20:10.000Z", queue_status: "delivered",
  };
  const make = (rows) => {
    const filters = [];
    const b = {
      select: () => b, eq: (c, v) => (filters.push((r) => r[c] === v), b),
      in: (c, vs) => (filters.push((r) => !(c in r) || (vs || []).includes(r[c])), b),
      not: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b, neq: () => b, is: () => b, gte: () => b,
      limit: async () => ({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve, reject),
    };
    return b;
  };
  return {
    from: (t) => make(t === "message_events" ? intervening : t === "sms_templates" ? templates : [outbound]),
    rpc: async () => ({ data: null, error: null }),
  };
}

const ctxAfter = (body = EN_OPENER) =>
  buildConversationContext({ thread_key: "+16125550100", inbound_received_at: "2026-10-06T00:25:49.000Z", supabase: supabaseFor({ body }) });
const run = (m, ctx) => classify(m, null, { heuristicOnly: true, conversation_context: ctx });

// language -> [yes, no, stop, who, price, thanks, catalog label]
const CASES = {
  Mandarin: ["是", "不卖", "别再发了", "你是谁？", "50万", "谢谢"],
  Japanese: ["はい", "売りません", "やめてください", "どなたですか", "3000万", "ありがとうございます"],
  Korean: ["네", "안 팔아요", "그만 보내세요", "누구세요?", "5억", "감사합니다"],
  Vietnamese: ["Vâng", "Không bán", "Dừng lại", "Bạn là ai?", "500 triệu", "Cảm ơn"],
  Polish: ["Tak", "Nie sprzedaję", "Przestań pisać", "Kto to?", "300 tys", "Dziękuję"],
  Hebrew: ["כן", "לא למכירה", "תפסיק לשלוח", "מי זה?", "2 מיליון", "תודה"],
  Italian: ["Sì", "Non vendo", "Non scrivermi più", "Chi è?", "300 mila", "Grazie"],
  Arabic: ["نعم", "ليس للبيع", "توقف عن الرسائل", "من أنت؟", "500 ألف", "شكرا"],
  Russian: ["Да", "Не продаю", "Хватит писать", "Кто это?", "300 тысяч", "Спасибо"],
  French: ["Oui", "Pas à vendre", "Arrêtez de m'écrire", "C'est qui?", "300 mille", "Merci"],
  German: ["Ja", "Nicht zu verkaufen", "Hören Sie auf", "Wer ist das?", "2 Millionen", "Danke"],
  Hindi: ["हाँ", "नहीं बेचना", "मैसेज बंद करो", "आप कौन हैं?", "50 लाख", "धन्यवाद"],
  Greek: ["Ναι", "Δεν πουλάω", "Σταματήστε", "Ποιος είναι;", "300 χιλιάδες", "Ευχαριστώ"],
  Portuguese: ["Sim", "Não vendo", "Pare de mandar mensagem", "Quem é?", "500 mil", "Obrigado"],
};
const EXPECTED_AMOUNT = {
  Mandarin: 500000, Japanese: 30000000, Korean: 500000000, Vietnamese: 500000000, Polish: 300000,
  Hebrew: 2000000, Italian: 300000, Arabic: 500000, Russian: 300000, French: 300000, German: 2000000,
  Hindi: 5000000, Greek: 300000,
};

test("every templated non-EN/ES language has a lexicon", () => {
  for (const language of ["Mandarin", "Portuguese", "Vietnamese", "Korean", "Polish", "Hebrew", "Italian", "Arabic", "Russian", "Japanese", "French", "German", "Hindi", "Greek"]) {
    assert.ok(MULTILINGUAL_LANGUAGES.includes(language), language);
  }
  // Owner decision: Farsi / Thai stay inactive until native review.
  assert.ok(!MULTILINGUAL_LANGUAGES.includes("Farsi"));
  assert.ok(!MULTILINGUAL_LANGUAGES.includes("Thai"));
});

for (const [language, [yes, no, stop, who, price, thanks]] of Object.entries(CASES)) {
  test(`${language}: yes / not-for-sale / STOP / who-is-this / price / thanks after the ownership question`, async () => {
    const ctx = await ctxAfter();
    const y = await run(yes, ctx);
    assert.equal(y.primary_intent, "ownership_confirmed", `${language} yes "${yes}"`);
    assert.equal(y.automation_decision.auto_reply_allowed, true, `${language} yes`);
    assert.equal(y.language, language, `${language} yes language`);

    const n = await run(no, ctx);
    assert.equal(n.primary_intent, "not_interested", `${language} no "${no}"`);
    assert.equal(n.automation_decision.suppression_action, "none");

    const s = await run(stop, ctx);
    assert.equal(s.primary_intent, "opt_out", `${language} stop "${stop}"`);
    assert.equal(s.compliance_flag, "stop_texting");
    assert.equal(s.automation_decision.suppression_action, "opt_out");
    // Opt-out beats an affirmative in the same message.
    const ys = await run(`${yes} ${stop}`, ctx);
    assert.equal(ys.primary_intent, "opt_out", `${language} yes+stop`);

    const w = await run(who, ctx);
    assert.equal(w.primary_intent, "who_is_this", `${language} who "${who}"`);

    const p = await run(price, ctx);
    assert.equal(p.primary_intent, "asking_price_provided", `${language} price "${price}"`);
    if (EXPECTED_AMOUNT[language]) assert.equal(parseLocalAmount(price), EXPECTED_AMOUNT[language], `${language} amount`);

    const t = await run(thanks, null);
    assert.equal(t.primary_intent, "acknowledgement", `${language} thanks "${thanks}"`);
    assert.equal(t.automation_decision.human_review_required, false);
  });
}

test("the live case: '是' after an English ownership opener -> ownership_confirmed, Mandarin, and a Mandarin S2 template is chosen", async () => {
  const ctx = await ctxAfter();
  const r = await run("是", ctx);
  assert.equal(r.primary_intent, "ownership_confirmed");
  assert.equal(r.context_status, "valid");
  assert.equal(r.language, "Mandarin");
  assert.equal(r.automation_decision.auto_reply_allowed, true);
  assert.equal(r.multilingual_canonicalization.category, "affirmative");

  const decision = applyInboundAutomationDecision({
    classification: r, message: "是", threadKey: "+16125550100", phoneId: "ph", ownerId: "mo", prospectId: "pr", propertyId: "992",
    latestThreadContext: { summary: { conversation_stage: "Ownership Confirmation" }, ids: { property_id: "992", master_owner_id: "mo", prospect_id: "pr" } },
  });
  assert.equal(decision.route_hint, "consider_selling");
  const tpl = (language, body) => ({
    id: `cs-${language}`, template_id: `cs-${language}`, use_case: "consider_selling", stage_code: "S2", language,
    is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: null, template_body: body,
    updated_at: "2026-09-25T00:00:00Z", usage_count: 0,
  });
  const supabase = supabaseFor({ templates: [tpl("English", "Thanks for confirming. Would you consider a proposal?"), tpl("Mandarin", "谢谢确认。您愿意考虑一个报价吗？")] });
  const selected = await selectSafeAutoReplyTemplate({ supabaseClient: supabase, classification: r, decision, context: { summary: { language: "English" } } });
  assert.equal(selected.ok, true);
  assert.equal(selected.template.language, "Mandarin");
});

test("no safe template in the seller's language -> review with a clear reason; never English, never the English local registry", async () => {
  const r = await run("是", await ctxAfter());
  const decision = { route_hint: "consider_selling", allowed_template_stages: ["consider_selling"] };
  const englishOnly = supabaseFor({ templates: [{ id: "cs-en", template_id: "cs-en", use_case: "consider_selling", stage_code: "S2", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Thanks. Open to a proposal?" }] });
  const res = await selectSafeAutoReplyTemplate({ supabaseClient: englishOnly, classification: r, decision, context: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "language_template_missing");
  assert.equal(res.detail, "no active Mandarin template for consider_selling");
  const none = await selectSafeAutoReplyTemplate({ supabaseClient: supabaseFor({ templates: [] }), classification: r, decision: { route_hint: "condition_probe", allowed_template_stages: ["condition_probe"] }, context: {} });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "language_template_missing");
});

test("Hindi resolves to the catalog label 'Indian (Hindi or Other)'", async () => {
  const r = await run("हाँ", await ctxAfter());
  assert.equal(r.language, "Hindi");
  const t = { id: "cs-hi", template_id: "cs-hi", use_case: "consider_selling", stage_code: "S2", language: "Indian (Hindi or Other)", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Dhanyavaad. Kya aap proposal par vichar karenge?" };
  const res = await selectSafeAutoReplyTemplate({ supabaseClient: supabaseFor({ templates: [t] }), classification: r, decision: { route_hint: "consider_selling", allowed_template_stages: ["consider_selling"] }, context: {} });
  assert.equal(res.ok, true);
  assert.equal(res.template.language, "Indian (Hindi or Other)");
});

test("romanised answers only count when OUR last outbound was in that language", async () => {
  const mandarinOpener = "Ni hao Pat, Wei zai zheli. Nin hai yongyou 992 Main St ma?";
  const zh = await run("Shi de", await ctxAfter(mandarinOpener));
  assert.equal(zh.primary_intent, "ownership_confirmed");
  assert.equal(zh.language, "Mandarin");
  const ru = await run("Da", await ctxAfter("Privet Pat, eto Alex. Vy vse eshche vladeete 992 Main St?"));
  assert.equal(ru.primary_intent, "ownership_confirmed");
  // After an English opener "Da" / "Hai" / "Ne" mean nothing.
  for (const m of ["Da", "Hai", "Ne"]) {
    assert.notEqual(canonicalizeMultilingualReply(m, { thread_language: "English" })?.category, "affirmative", m);
  }
});

test("full-width punctuation and digits are normalised (NFKC)", async () => {
  assert.equal(canonicalizeMultilingualReply("是！")?.category, "affirmative");
  assert.equal(canonicalizeMultilingualReply("５０万")?.amount, 500000);
  assert.equal(canonicalizeMultilingualReply("５０万")?.category, "price");
});

test("script detection: single CJK / Hangul / Hebrew / Arabic / Devanagari / Greek / Cyrillic", async () => {
  for (const [m, language] of [["是", "Mandarin"], ["네", "Korean"], ["はい", "Japanese"], ["売りません", "Japanese"], ["כן", "Hebrew"], ["نعم", "Arabic"], ["हाँ", "Hindi"], ["Ναι", "Greek"], ["Да", "Russian"]]) {
    assert.equal((await run(m, null)).language, language, m);
  }
});

test("English and Spanish replies are untouched by the multilingual layer", async () => {
  for (const m of ["Yes", "No", "Si", "Sí", "Claro", "Stop", "Gracias", "Not for sale", "No vendo", "Who is this?"]) {
    assert.equal(canonicalizeMultilingualReply(m), null, m);
  }
});

test("wrong number / not owner and offer requests in every language", async () => {
  const WRONG = {
    Mandarin: "打错了", Japanese: "番号違いです", Korean: "번호 잘못 보내셨어요", Vietnamese: "Nhầm số rồi", Polish: "Zły numer",
    Hebrew: "מספר שגוי", Italian: "Numero sbagliato", Arabic: "رقم خطأ", Russian: "Не тот номер", French: "Mauvais numéro",
    German: "Falsche Nummer", Hindi: "गलत नंबर", Greek: "Λάθος αριθμός", Portuguese: "Número errado",
  };
  const OFFER = {
    Mandarin: "你出多少？", Japanese: "いくらですか", Korean: "얼마 주실 거예요?", Vietnamese: "Giá bao nhiêu?", Polish: "Ile oferujesz?",
    Hebrew: "מה המחיר?", Italian: "Quanto offri?", Arabic: "كم السعر؟", Russian: "Какая цена?", French: "Quel prix?",
    German: "Was bieten Sie?", Hindi: "कितना दोगे?", Greek: "Τι προσφέρετε;", Portuguese: "Quanto você oferece?",
  };
  const ctx = await ctxAfter();
  for (const [language, m] of Object.entries(WRONG)) {
    const r = await run(m, ctx);
    assert.equal(r.primary_intent, "wrong_number", `${language} "${m}"`);
    assert.equal(r.automation_decision.auto_reply_allowed, false);
  }
  for (const [language, m] of Object.entries(OFFER)) {
    const r = await run(m, ctx);
    assert.equal(r.primary_intent, "asks_offer", `${language} "${m}"`);
    assert.equal(r.language, language, `${language} language`);
  }
});
