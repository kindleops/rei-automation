// ─── detect-sale-decline.js ──────────────────────────────────────────────────
// ONE detector for "this seller has told us they are not selling."
//
// SEPARATE FROM OPT-OUT, ON PURPOSE
//   A decline is a TEMPORARY commercial answer. The lead stays legally
//   contactable and may re-engage later. STOP / unsubscribe is a legal
//   prohibition. The ontology already states this ("not_interested is a
//   TEMPORARY rejection, never a legal opt-out") and this module never returns
//   anything that could be mistaken for suppression.
//
// WHY TEXT AND NOT ONLY INTENT
//   A real message -- "Si, pero no esta de venta!" -- was classified
//   ownership_confirmed. The leading "Si" answered the ownership question and
//   the refusal that followed was dropped, so the seller read as a live lead.
//   A compound sentence carries more than one fact, and the positive token
//   arriving first must not outrank the meaning of the sentence.

function clean(value) {
  return String(value ?? "").trim();
}

/** Accent- and case-insensitive, so "está"/"esta" and "Sí"/"si" both match. */
function fold(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Explicit refusals to sell. Deliberately phrase-level: single tokens like
 * "no" are far too ambiguous in a conversation that asks yes/no questions.
 */
const DECLINE_PHRASES = Object.freeze([
  // English
  "not selling", "not looking to sell", "not for sale", "not interested in selling",
  "no longer selling", "wont be selling", "won't be selling", "will not be selling",
  "not on the market", "not planning to sell", "no plans to sell", "dont want to sell",
  "don't want to sell", "do not want to sell", "not gonna sell", "not going to sell",
  "have great long-term tenants", "have long term tenants",
  // Spanish (folded, so accents are already stripped)
  "no esta de venta", "no esta en venta", "no estan de venta", "no esta para la venta",
  "no la vendo", "no lo vendo", "no las vendo", "no los vendo",
  "no la quiero vender", "no lo quiero vender", "no quiero vender", "no queremos vender",
  "no estoy vendiendo", "no estamos vendiendo", "no me interesa vender",
  "no esta a la venta", "no se vende", "no la voy a vender", "no lo voy a vender",
]);

/**
 * Affirmative openings that answer an OWNERSHIP question. Recorded, never
 * allowed to cancel a refusal appearing later in the same message.
 */
const OWNERSHIP_AFFIRMATIONS = Object.freeze([
  "si es mia", "si es mio", "si, es mia", "si, es mio", "si soy", "si, soy",
  "yes i do", "yes, i do", "yes it is", "yes, it is", "yes i own", "that's me", "thats me",
  "si", "yes", "yep", "yeah", "correct",
]);

/**
 * @returns {{
 *   declined: boolean,
 *   matched: string|null,
 *   ownership_affirmed: boolean,
 *   compound: boolean,
 * }}
 */
export function detectSaleDecline(body) {
  const text = fold(body);
  if (!text) {
    return { declined: false, matched: null, ownership_affirmed: false, compound: false };
  }

  const matched = DECLINE_PHRASES.find((phrase) => text.includes(phrase)) || null;

  // Ownership is only read as affirmed when the message OPENS with it, which
  // is how a reply to "do you own X?" actually looks. Scanning anywhere would
  // let the "no" in "no la vendo" flip the reading.
  const ownership_affirmed = OWNERSHIP_AFFIRMATIONS.some(
    (aff) => text === aff || text.startsWith(`${aff} `) || text.startsWith(`${aff},`) || text.startsWith(`${aff}.`),
  );

  return {
    declined: Boolean(matched),
    matched,
    ownership_affirmed,
    // Both facts in one sentence: "Si, pero no esta de venta!" This is the case
    // the classifier collapsed into ownership_confirmed alone.
    compound: Boolean(matched) && ownership_affirmed,
  };
}

export default { detectSaleDecline };
