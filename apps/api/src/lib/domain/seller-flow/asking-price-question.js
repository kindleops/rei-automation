// ─── asking-price-question.js ────────────────────────────────────────────────
// THE ONE "is this outbound an asking-price question?" classifier (rc-8.5.15.1).
//
// Owner directive 2026-10-13: never ask a seller for their asking price twice.
// The live send_queue guard (block_repeat_asking_price) only recognised rows
// whose use_case_template contained "asking_price", so an operator-typed
// "Do you have an asking price in mind?" (stored as manual_reply — 24 of them
// in the 30 days to 2026-10-14) was neither blocked nor counted as a prior ask.
// Every send-queue writer now stamps metadata.question_kind = 'asking_price'
// from THIS function (outbound-question-kind.js), and the guard keys on it.
//
// Pure and conservative (EN + ES):
//   - only a QUESTION counts: the matching sentence ends in "?", opens with
//     "¿", or opens with an interrogative ("do you", "what", "cuánto", …);
//   - a message that quotes a price ($120k, 120,000, 222K) is an OFFER or a
//     clarifier, never an asking-price question;
//   - "open to discussing numbers?" / "does that price work?" are interest /
//     offer questions, and "what's your BEST / LOWEST price?" is negotiation —
//     none of them is a second asking-price ask.
// A false negative lets one repeat ask through; a false positive blocks an
// operator send (who can then override, audited). Both are kept rare by
// matching only phrasings that name the seller's own number.

export const ASKING_PRICE_CLASSIFIER_VERSION = "asking_price_question_v1_2026_10_15";

// A price-shaped token anywhere in the message ⇒ it is an offer / clarifier.
const QUOTED_PRICE = /\$\s?\d|\b\d{2,3}(?:\.\d)?\s?k\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{2,3}\s?mil\b/i;

const EN_RULES = Object.freeze([
  ["en_asking_price", /\basking\s+price\b/i],
  ["en_in_mind", /\b(?:price|number|figure|amount|range|ballpark)\s+(?:\w+\s+){0,2}in\s+mind\b/i],
  // "what price / what number / what's your asking …" — NOT "what's your BEST / LOWEST price": that
  // is a negotiation lever after the seller already named a number, not a second asking-price ask.
  ["en_what_price", /\bwhat(?:'s|’s|\s+is|\s+are|\s+was|\s+would\s+be)?\s+(?:the\s+|your\s+)?(?:ideal\s+|target\s+)?(?:sale\s+|sales\s+|selling\s+)?(?:price|number|figure|asking)\b(?!\s+(?:did|do|does|of|on)\s+(?:the\s+)?(?:neighbou?rs?|comps?|houses|homes|others))/i],
  ["en_what_would_you_take", /\bwhat\s+(?:would|will|do|did)\s+you\s+(?:take|want|need|accept|ask|be\s+(?:asking|looking\s+(?:for|to\s+get)|hoping\s+(?:for|to\s+get)|willing\s+to\s+(?:take|accept)|comfortable\s+(?:taking|accepting|with)))\b/i],
  ["en_sell_for", /\bwhat\s+would\s+you\s+(?:sell|let)\s+(?:it|the\s+(?:house|home|property|place|land|lot)|them)\s+(?:go\s+)?for\b/i],
  ["en_how_much", /\bhow\s+much\s+(?:would|do|did|could|will|are|were)\s+you\s+(?:want|need|take|ask|accept|expect|like|be\s+(?:asking|looking|wanting|hoping)|asking|looking|hoping|wanting)\b/i],
  ["en_what_are_you_asking", /\bwhat\s+are\s+you\s+(?:asking|hoping\s+to\s+get|looking\s+to\s+get|wanting\s+(?:for|to\s+get))\b/i],
  ["en_price_work", /\b(?:is\s+there\s+a|any)\s+(?:price|number)\s+(?:that\s+)?(?:would|could|might)\s+work\b/i],
  ["en_have_a_number", /\b(?:have|got)\s+a\s+(?:number|price|figure)\s+(?:you(?:'d|’d|\s+would)\s+(?:take|accept|want)|for\s+(?:it|the\s+(?:house|home|property)))\b/i],
])

const ES_RULES = Object.freeze([
  ["es_precio_en_mente", /\bprecio\b[^?¿.!]{0,40}\ben\s+mente\b/i],
  ["es_numero_en_mente", /\b(?:n[uú]mero|cifra|cantidad|monto)\b[^?¿.!]{0,30}\ben\s+mente\b/i],
  ["es_cuanto", /\bcu[aá]nto\s+(?:me\s+|nos\s+|le\s+|te\s+)?(?:pide|pides|piden|quiere|quieres|quieren|pedir[ií]a|pedir[ií]as|est[aá]s?\s+pidiendo|busca|buscas|aceptar[ií]a|aceptar[ií]as|necesita|necesitas|quisiera|quisieras|le\s+gustar[ií]a|te\s+gustar[ií]a|espera|esperas|vende|vendes|vender[ií]a|vender[ií]as)\b/i],
  ["es_que_precio", /\bqu[eé]\s+precio\b/i],
  ["es_cual_precio", /\bcu[aá]l\s+(?:es|ser[ií]a)\s+(?:su|tu|el)\s+(?:mejor\s+)?(?:precio|n[uú]mero|cifra)\b/i],
  ["es_en_cuanto", /\ben\s+cu[aá]nto\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:vender[ií]as?|dejar[ií]as?|vende|vendes|deja|dejas)\b/i],
  ["es_precio_de_venta", /\bprecio\s+de\s+venta\b/i],
])

const EN_INTERROGATIVE_OPENER = /^(?:(?:hi|hey|hello|ok(?:ay)?|got\s+it|thanks|sounds\s+good|great|perfect|understood|yes|yeah|right|cool)[,!.\s]+)*(?:do|did|does|would|could|can|will|is|are|any|what(?:'s|’s)?|how|have|got)\b/i;
const ES_INTERROGATIVE_OPENER = /^(?:(?:hola|ok|entendido|gracias|perfecto|claro|s[ií]|bueno)[,!.\s]+)*(?:tiene|tienes|tendr[ií]a|tendr[ií]as|cu[aá]nto|cu[aá]l|qu[eé]|en\s+cu[aá]nto|hay|ha\s+pensado|has\s+pensado)\b/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Split into sentences, keeping each one's terminal punctuation. */
function sentences(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const s = clean(m[0]);
    if (s) out.push(s);
  }
  return out;
}

function isQuestionSentence(s, lang) {
  if (/\?\s*$/.test(s) || /^¿/.test(s)) return true;
  const body = s.replace(/^[¿¡"'“‘(\s]+/, "");
  return lang === "es" ? ES_INTERROGATIVE_OPENER.test(body) : EN_INTERROGATIVE_OPENER.test(body);
}

/**
 * Classify one outbound message. Pure.
 * @param {string} text
 * @returns {{ asking_price: boolean, language: 'en'|'es'|null, rule: string|null, version: string }}
 */
export function classifyAskingPriceQuestion(text) {
  const body = clean(text);
  const none = { asking_price: false, language: null, rule: null, version: ASKING_PRICE_CLASSIFIER_VERSION };
  if (!body || body.length > 1600) return none;
  if (QUOTED_PRICE.test(body)) return none;
  for (const s of sentences(String(text ?? ""))) {
    for (const [rule, re] of ES_RULES) {
      if (re.test(s) && isQuestionSentence(s, "es")) return { asking_price: true, language: "es", rule, version: ASKING_PRICE_CLASSIFIER_VERSION };
    }
    for (const [rule, re] of EN_RULES) {
      if (re.test(s) && isQuestionSentence(s, "en")) return { asking_price: true, language: "en", rule, version: ASKING_PRICE_CLASSIFIER_VERSION };
    }
  }
  return none;
}

/** Convenience boolean form. Pure. */
export function isAskingPriceQuestionText(text) {
  return classifyAskingPriceQuestion(text).asking_price;
}

/** use_case_template values that ARE an asking-price ask (the guard's own rule). Pure. */
export function isAskingPriceUseCase(use_case) {
  const u = clean(use_case).toLowerCase();
  return /asking_price/.test(u) || /^s3_no_response_/.test(u);
}
