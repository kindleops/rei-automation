/**
 * COMPLIANCE (owner 2026-10-07): a confident opt-out in every registry language
 * is an opt-out in the LIVE classifier, independent of any conversation flag.
 * Per language: positives (whole-message STOP keyword + revocation phrases),
 * negatives (plain no / not interested = nurture, insults without revocation)
 * and near-misses. No network.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { matchMultilingualOptOut } from "@/lib/domain/classification/multilingual-opt-out.js";
import { classifyStopScope, STOP_SCOPE } from "@/lib/domain/classification/stop-scope.js";

// [language, positives[], negatives[] (plain no / not interested / hostile / near-miss)]
const CASES = [
  ["Spanish", ["Déjame de escribir", "Ya no me escribas", "No me mandes más mensajes", "Bórrame de tu lista", "BAJA"],
    ["No gracias", "No me interesa", "No quiero vender", "Déjame pensarlo", "Pare de llorar"]],
  ["Portuguese", ["Pare de me mandar mensagens", "Não me mande mais mensagens", "Remova meu número", "SAIR"],
    ["Não", "Não tenho interesse", "Não quero vender agora", "Pare de brincadeira"]],
  ["French", ["Arrêtez de m'écrire", "Ne m'écrivez plus", "Supprimez mon numéro", "Arrêtez !"],
    ["Non", "Pas intéressé", "Je ne veux pas vendre", "Arrêtez de rêver, c'est trop bas"]],
  ["German", ["Hören Sie auf, mir zu schreiben", "Schreiben Sie mir nicht mehr", "Keine Nachrichten mehr", "Stopp"],
    ["Nein", "Kein Interesse", "Ich will nicht verkaufen", "Hören Sie auf zu träumen"]],
  ["Italian", ["Smetta di scrivermi", "Non contattarmi", "Non mi scriva più", "Cancellami"],
    ["No", "Non mi interessa", "Non voglio vendere", "Non mi mandi un'offerta bassa"]],
  ["Polish", ["Proszę przestać do mnie pisać", "Nie piszcie do mnie więcej", "Usuń mój numer", "Wypisz mnie"],
    ["Nie", "Nie jestem zainteresowany", "Nie sprzedaję", "Przestań żartować"]],
  ["Vietnamese", ["Đừng nhắn tin cho tôi nữa", "Ngừng nhắn tin", "Xóa số của tôi", "Dừng lại"],
    ["Không", "Không quan tâm", "Tôi không muốn bán", "Dừng lại một chút để tôi nghĩ"]],
  ["Mandarin", ["停止", "不要再联系我", "别再给我发短信了", "把我的号码删掉", "退订"],
    ["不", "不是", "没兴趣", "我不想卖", "你是骗子"]],
  ["Korean", ["문자 그만 보내세요", "연락하지 마세요", "수신거부", "중지"],
    ["아니요", "관심 없어요", "안 팔아요", "그만 좀 웃기세요 가격이 너무 낮아요"]],
  ["Japanese", ["もう連絡しないでください", "メッセージを送らないで", "配信停止", "停止"],
    ["いいえ", "興味ありません", "売りません", "その価格はやめてください"]],
  ["Hebrew", ["תפסיק לשלוח לי הודעות", "אל תשלח לי יותר הודעות", "תמחק את המספר שלי", "הסר"],
    ["לא", "לא מעוניין", "לא מוכר", "די עם השטויות"]],
  ["Arabic", ["توقف عن مراسلتي", "لا ترسل لي مرة أخرى", "احذف رقمي", "إلغاء"],
    ["لا", "لست مهتماً", "لا أريد البيع", "أنت محتال"]],
  ["Russian", ["Перестаньте мне писать", "Не пишите мне", "Удалите мой номер", "Стоп"],
    ["Нет", "Не интересно", "Не продаю", "Хватит"]],
  ["Greek", ["Σταματήστε να μου στέλνετε μηνύματα", "Μην μου στέλνετε", "Διαγράψτε τον αριθμό μου", "Στοπ"],
    ["Όχι", "Δεν ενδιαφέρομαι", "Δεν πουλάω", "Σταματήστε να ονειρεύεστε"]],
  ["Indian (Hindi or Other)", ["मुझे मैसेज करना बंद करो", "मैसेज मत भेजो", "मुझसे संपर्क मत करो", "बंद करो"],
    ["नहीं", "मुझे दिलचस्पी नहीं है", "नहीं बेचना", "रुको"]],
];

test("module: every registry language — positives match, negatives and near-misses do not", () => {
  for (const [language, positives, negatives] of CASES) {
    for (const p of positives) {
      const hit = matchMultilingualOptOut(p);
      assert.ok(hit, `${language} positive missed: ${p}`);
    }
    for (const n of negatives) assert.equal(matchMultilingualOptOut(n), null, `${language} false positive: ${n}`);
  }
});

test("live classifier: a multilingual opt-out is opt_out + stop_texting + suppression_action opt_out (no flags)", async () => {
  const keep = { v2: process.env.SELLER_AUTOPILOT_V2, v3: process.env.SELLER_CONVERSATION_V3 };
  delete process.env.SELLER_AUTOPILOT_V2;
  delete process.env.SELLER_CONVERSATION_V3;
  try {
    for (const [language, positives] of CASES) {
      for (const p of positives) {
        const c = await classify(p, null, { heuristicOnly: true });
        assert.equal(c.primary_intent, "opt_out", `${language}: ${p} → ${c.primary_intent}`);
        assert.equal(c.compliance_flag, "stop_texting", `${language}: ${p}`);
        assert.equal(c.automation_decision?.suppression_action, "opt_out", `${language}: ${p}`);
      }
    }
  } finally {
    if (keep.v2 !== undefined) process.env.SELLER_AUTOPILOT_V2 = keep.v2;
    if (keep.v3 !== undefined) process.env.SELLER_CONVERSATION_V3 = keep.v3;
  }
});

test("live classifier: plain negatives stay not-opt-out (nurture), insults are not opt-outs", async () => {
  for (const [language, , negatives] of CASES) {
    for (const n of negatives) {
      const c = await classify(n, null, { heuristicOnly: true });
      assert.notEqual(c.compliance_flag, "stop_texting", `${language}: ${n}`);
      assert.notEqual(c.primary_intent, "opt_out", `${language}: ${n} → opt_out`);
    }
  }
});

// ── CONTEXTUAL STOP (owner 2026-10-07): STOP_COMMUNICATION vs STOP_OTHER_ACTION ──
const STOP_OTHER = ["Pare de llorar", "Pare de brincadeira", "Arrêtez de rêver, c'est trop bas", "Hören Sie auf zu träumen", "Przestań żartować",
  "Dừng lại một chút để tôi nghĩ", "그만 좀 웃기세요 가격이 너무 낮아요", "その価格はやめてください", "Хватит", "Σταματήστε να ονειρεύεστε", "रुको",
  "stop crying", "stop asking that", "enough with the lowballs", "Basta de ofertas bajas", "Stop with the lowball offers"];
const STOP_COMM = ["STOP", "Stop", "stop.", "Please stop", "停止", "Стоп", "중지", "STOP!!!", "Stop texting me", "Stop calling me", "Stop bugging me", "Stop asking",
  "Remove my number", "Unsubscribe", "Pare de me mandar mensagens", "Deja de escribirme", "Arrêtez de m'écrire", "Hören Sie auf, mir zu schreiben",
  "Smetta di scrivermi", "Przestań do mnie pisać", "Đừng nhắn tin cho tôi nữa", "别再给我发短信了", "문자 그만 보내세요", "もう連絡しないでください",
  "Перестаньте мне писать", "Хватит писать", "Σταματήστε να μου στέλνετε μηνύματα", "मुझे मैसेज करना बंद करो"];

test("stop scope: other actions are never communication; communication phrases never other actions", () => {
  for (const m of STOP_OTHER) assert.equal(classifyStopScope(m), STOP_SCOPE.OTHER_ACTION, m);
  for (const m of STOP_COMM) assert.notEqual(classifyStopScope(m), STOP_SCOPE.OTHER_ACTION, m);
});

test("live classifier: STOP_OTHER_ACTION is not an opt-out (no suppression); STOP_COMMUNICATION and bare keywords stay opt-out", async () => {
  for (const m of STOP_OTHER) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "opt_out", `${m} → opt_out`);
    assert.notEqual(c.compliance_flag, "stop_texting", m);
    assert.notEqual(c.automation_decision?.suppression_action, "opt_out", m);
  }
  for (const m of STOP_COMM) {
    const c = await classify(m, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "opt_out", `${m} → ${c.primary_intent}`);
  }
});
