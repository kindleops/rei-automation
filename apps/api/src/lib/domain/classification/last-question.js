/**
 * What OUR last outbound asked, as far as a number in the seller's reply is
 * concerned (7.2). A leaf module (no imports) so the conversation-context
 * builder, the factual-commitment layer and the canonical money path can all
 * read the same answer without an import cycle.
 *
 *   non_price_quantity         "How many square feet is it?" -> a bare "250"
 *                              is a size, never a price
 *   offer_amount_in_thousands  "Would you take $240k?" -> a bare "250" is in
 *                              OUR thousands: $250,000
 *   other / unknown            nothing about the scale of a bare number
 */

const clean = (v) => String(v ?? "").trim();

// A question about a non-price QUANTITY: the answer is a size / count / year.
const NON_PRICE_QUANTITY_QUESTION_RE =
  /\b(?:square\s*f(?:ee|oo)t(?:age)?|sq\.?\s*ft|sqft|how\s+big|how\s+many\s+(?:units|bed(?:room)?s|bath(?:room)?s|doors|floors|stories|acres)|how\s+old|year\s+(?:built|was\s+it\s+built)|what\s+year|lot\s+size|acre(?:s|age)?)\b/i;
// A question that names a price in thousands shorthand ("$240k", "240K").
const OUR_K_AMOUNT_RE = /\$?\s*(\d{2,4}(?:\.\d+)?)\s*k\b/i;

export const LAST_QUESTION_KIND = Object.freeze({
  UNKNOWN: "unknown",
  NON_PRICE_QUANTITY: "non_price_quantity",
  OFFER_AMOUNT_IN_THOUSANDS: "offer_amount_in_thousands",
  OTHER: "other",
});

/** @returns {{ kind: string, k_amount: number|null }} */
export function describeLastQuestion(outboundBody) {
  const body = clean(outboundBody);
  if (!body) return { kind: LAST_QUESTION_KIND.UNKNOWN, k_amount: null };
  if (NON_PRICE_QUANTITY_QUESTION_RE.test(body) && /\?/.test(body)) {
    return { kind: LAST_QUESTION_KIND.NON_PRICE_QUANTITY, k_amount: null };
  }
  const k = OUR_K_AMOUNT_RE.exec(body);
  if (k && /\?/.test(body)) {
    return { kind: LAST_QUESTION_KIND.OFFER_AMOUNT_IN_THOUSANDS, k_amount: Number(k[1]) * 1000 };
  }
  return { kind: LAST_QUESTION_KIND.OTHER, k_amount: null };
}

/**
 * Accepts either our outbound text or an already-described question (the
 * conversation context carries the description, not the text).
 */
export function resolveLastQuestion({ lastOutboundBody = null, lastQuestion = null } = {}) {
  if (lastQuestion && typeof lastQuestion === "object" && clean(lastQuestion.kind)) {
    return { kind: clean(lastQuestion.kind), k_amount: lastQuestion.k_amount ?? null };
  }
  return describeLastQuestion(lastOutboundBody);
}

/**
 * True when OUR last question stated a price in thousands shorthand, which
 * makes a bare 2-4 digit answer thousands too ("Would you take $240k?" ->
 * "250"). The seller-established convention (RC 7.1) is unchanged; this only
 * adds the one we established ourselves in the same exchange.
 */
export function questionEstablishesThousandsShorthand(outboundBodyOrQuestion) {
  const question =
    outboundBodyOrQuestion && typeof outboundBodyOrQuestion === "object"
      ? resolveLastQuestion({ lastQuestion: outboundBodyOrQuestion })
      : describeLastQuestion(outboundBodyOrQuestion);
  return question.kind === LAST_QUESTION_KIND.OFFER_AMOUNT_IN_THOUSANDS;
}

export default describeLastQuestion;
