// Shared fixtures for the Acquisition OS v1 matrices:
//   §73 intent × stage (S1–S4) — 21 canonical intents, English seller wording
//   §74 multilingual — 12 canonical turns × every registry language, native script
// Used by tests/critical/seller-conversation-v3-matrix.test.mjs and by
// scripts/ops/seller-conversation-v3-language-coverage.mjs. Pure.
import { replayV3 } from "./seller-conversation-v3-harness.mjs";
import { catalogFor, ALL_LANGUAGES_SWITCH } from "./seller-conversation-v3-catalog.mjs";

/** The question each stage was asked (prior outbound use case + English text). */
export const MATRIX_STAGES = Object.freeze({
  S1: { use_case: "ownership_check", text: "Hey Pat, this is Alex. Are you still the owner of 1 Main St?" },
  S2: { use_case: "consider_selling", text: "Thanks for confirming. Would you consider a proposal for the property?" },
  S3: { use_case: "seller_asking_price", text: "Got it. Do you have an asking price in mind for the property?" },
  S4: { use_case: "ask_condition_clarifier", text: "Thanks, could you tell me a little more about the condition? Anything major like roof, HVAC, or foundation?" },
});

/** §73 intents, in the seller's (English) words. */
export const INTENT_MESSAGES = Object.freeze({
  YES: "Yes",
  NO: "No",
  MAYBE: "Maybe",
  WHO: "Who is this?",
  WHY: "Why are you asking?",
  HOW_NUMBER: "How did you get my number?",
  MAKE_ME_OFFER: "Make me an offer",
  WHATS_YOUR_OFFER: "What's your offer?",
  ASKING_PRICE: "$250,000",
  RENT_AMOUNT: "Rent is 1,500",
  YEAR: "2020",
  CONDITION: "It needs a new roof",
  REPAIRS: "Foundation issues and the HVAC is out",
  OCCUPANCY: "Tenant lives there",
  CAPITAL_GAINS: "I'd get killed on capital gains if I sold",
  WRONG_NUMBER: "Wrong number",
  REFERRAL: "Talk to my brother, his number is 555-010-0199",
  OPT_OUT: "Stop",
  HOSTILE: "Go to hell",
  EMOJI: "👍",
  SARCASTIC: "Sure, for 10 million lol",
});

/** §74 canonical turns: [stage, key]. */
export const MULTILINGUAL_TURNS = Object.freeze([
  ["S1", "ownership_yes"], ["S1", "ownership_no"], ["S2", "interest_yes"], ["S2", "interest_no"],
  ["S3", "make_me_an_offer"], ["S3", "price"], ["S4", "condition"], ["S1", "why"], ["S1", "who"],
  ["S1", "wrong_number"], ["S1", "opt_out"], ["S3", "unrealistic_price"],
]);

/** §74 phrasebook (native script; numerals as sellers type them). */
export const PHRASEBOOK = Object.freeze({
  English: ["Yes", "No", "Yes", "No, not interested", "Make me an offer", "$250,000", "It needs a new roof", "Why are you asking?", "Who is this?", "Wrong number", "Stop texting me", "$5,000,000"],
  Spanish: ["Sí", "No", "Sí", "No, no me interesa", "Hágame una oferta", "$250,000", "Necesita un techo nuevo", "¿Por qué pregunta?", "¿Quién es?", "Número equivocado", "No me mande más mensajes", "$5,000,000"],
  Portuguese: ["Sim", "Não", "Sim", "Não, não tenho interesse", "Me faça uma oferta", "$250,000", "Precisa de um telhado novo", "Por que está perguntando?", "Quem é?", "Número errado", "Pare de me mandar mensagens", "$5,000,000"],
  French: ["Oui", "Non", "Oui", "Non, pas intéressé", "Faites-moi une offre", "$250,000", "Il faut refaire le toit", "Pourquoi vous demandez ?", "Qui est-ce ?", "Mauvais numéro", "Arrêtez de m'écrire", "$5,000,000"],
  German: ["Ja", "Nein", "Ja", "Nein, kein Interesse", "Machen Sie mir ein Angebot", "$250,000", "Das Dach muss neu gemacht werden", "Warum fragen Sie?", "Wer ist da?", "Falsche Nummer", "Hören Sie auf, mir zu schreiben", "$5,000,000"],
  Italian: ["Sì", "No", "Sì", "No, non mi interessa", "Mi faccia un'offerta", "$250,000", "Il tetto va rifatto", "Perché me lo chiede?", "Chi è?", "Numero sbagliato", "Smetta di scrivermi", "$5,000,000"],
  Polish: ["Tak", "Nie", "Tak", "Nie, nie jestem zainteresowany", "Proszę złożyć ofertę", "$250,000", "Trzeba wymienić dach", "Dlaczego Pan pyta?", "Kto mówi?", "Zły numer", "Proszę przestać do mnie pisać", "$5,000,000"],
  Vietnamese: ["Vâng", "Không", "Có", "Không, tôi không quan tâm", "Anh cứ đưa ra giá đi", "$250,000", "Mái nhà cần làm lại", "Sao anh hỏi vậy?", "Ai vậy?", "Nhầm số rồi", "Đừng nhắn tin cho tôi nữa", "$5,000,000"],
  Mandarin: ["是", "不是", "是的", "不，我没兴趣", "你出个价吧", "$250,000", "屋顶需要换新的", "你为什么问这个？", "你是谁？", "打错了", "别再给我发短信了", "$5,000,000"],
  Korean: ["네", "아니요", "네", "아니요, 관심 없어요", "제안해 주세요", "$250,000", "지붕을 새로 해야 해요", "왜 물어보세요?", "누구세요?", "번호 잘못 아셨어요", "문자 그만 보내세요", "$5,000,000"],
  Japanese: ["はい", "いいえ", "はい", "いいえ、興味ありません", "オファーをください", "$250,000", "屋根の交換が必要です", "なぜ聞くんですか？", "どなたですか？", "番号違いです", "もう連絡しないでください", "$5,000,000"],
  Hebrew: ["כן", "לא", "כן", "לא, לא מעוניין", "תציע לי הצעה", "$250,000", "צריך גג חדש", "למה אתה שואל?", "מי זה?", "טעות במספר", "תפסיק לשלוח לי הודעות", "$5,000,000"],
  Arabic: ["نعم", "لا", "نعم", "لا، لست مهتماً", "قدم لي عرضاً", "$250,000", "يحتاج إلى سقف جديد", "لماذا تسأل؟", "من أنت؟", "رقم خاطئ", "توقف عن مراسلتي", "$5,000,000"],
  Russian: ["Да", "Нет", "Да", "Нет, не интересно", "Сделайте мне предложение", "$250,000", "Нужна новая крыша", "Почему вы спрашиваете?", "Кто это?", "Не тот номер", "Перестаньте мне писать", "$5,000,000"],
  Greek: ["Ναι", "Όχι", "Ναι", "Όχι, δεν ενδιαφέρομαι", "Κάντε μου μια προσφορά", "$250,000", "Χρειάζεται καινούργια στέγη", "Γιατί ρωτάτε;", "Ποιος είναι;", "Λάθος αριθμός", "Σταματήστε να μου στέλνετε μηνύματα", "$5,000,000"],
  "Indian (Hindi or Other)": ["हाँ", "नहीं", "हाँ", "नहीं, मुझे दिलचस्पी नहीं है", "आप ऑफ़र दीजिए", "$250,000", "छत नई लगवानी पड़ेगी", "आप क्यों पूछ रहे हैं?", "आप कौन हैं?", "गलत नंबर", "मुझे मैसेज करना बंद करो", "$5,000,000"],
});

/** A trusted engine snapshot (value $200K) so the price branches are exercised. */
export function trustedSnapshot(value = 200_000) {
  return {
    property_id: "prop-1",
    computed_at: "2026-10-05T12:00:00Z",
    decision_tier: "AUTO_HARD_OFFER",
    valuation_mid: value,
    recommended_cash_offer: Math.round(value * 0.6),
    estimated_repairs: 20_000,
    evidence: {
      offer_calculation: { effective_authorized_ceiling: Math.round(value * 0.7) },
      subject: { asset_type: "single_family", normalized_features: { estimated_value: value } },
      selected_comps: [],
    },
  };
}

let ALL_CATALOG = null;
export function allCatalog() {
  if (!ALL_CATALOG) ALL_CATALOG = catalogFor("all");
  return ALL_CATALOG;
}

/** Prior-question text in the thread's language (the draft row for the stage question), else English. */
export function priorQuestionFor(stage, language = "English", catalog = allCatalog()) {
  const base = MATRIX_STAGES[stage];
  if (language === "English") return { template_id: `matrix-${base.use_case}-en`, template_use_case: base.use_case, text: base.text };
  // The stage question in that language: the campaign/reply row, else the v3 re-ask of the same question.
  const FALLBACK = { S1: "v3_reask_ownership", S2: "v3_reask_interest", S3: "v3_conditional_ask_price", S4: "ask_condition_clarifier" };
  const row =
    catalog.find((r) => r.use_case === base.use_case && r.language === language) ||
    catalog.find((r) => r.use_case === FALLBACK[stage] && r.language === language);
  return row
    ? { template_id: row.template_id, template_use_case: row.use_case, text: row.template_body }
    : { template_id: `matrix-${base.use_case}-en`, template_use_case: base.use_case, text: base.text };
}

/** One matrix cell through the full v3 chain. */
export async function runCell({ stage, message, language = "English", catalog = allCatalog(), languages = ALL_LANGUAGES_SWITCH, ade_snapshot = null, known_facts = {} }) {
  const prior = priorQuestionFor(stage, language, catalog);
  const fixture = {
    fixture_id: `matrix-${stage}`,
    received_at: "2026-10-06T15:00:00Z",
    seller_message: message,
    prior_question: { message_type: null, ...prior, sent_at: "2026-10-06T14:00:00Z", delivered_at: "2026-10-06T14:00:05Z" },
  };
  return replayV3(fixture, { catalog, languages, ade_snapshot, known_facts });
}
