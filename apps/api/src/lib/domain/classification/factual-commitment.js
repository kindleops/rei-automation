/**
 * FACTUAL COMMITMENT for seller price facts (7.2, 2026-10-01).
 *
 * The canonical monetary parser (seller-flow/monetary-understanding.js)
 * decides WHAT number a message carries. This decides how strongly the seller
 * COMMITTED to it, and therefore whether it may become a fact:
 *
 *   CONFIRMED / LIKELY   the parser's verdict stands (RC 7.1 rules unchanged:
 *                        "65" alone is ambiguous, "65k" / "sixty five
 *                        thousand" are $65,000)
 *   NON_LITERAL          laughter beside the number ("Sure, I'll take a
 *                        million dollars 😂", "$1,000,000 haha") -- ridicule or
 *                        disbelief, NEVER an asking price
 *   AMBIGUOUS            clarify; nothing persists, the stage does not move
 *
 * It also reads the question WE asked last, which the parser never saw:
 *   - "Would you take $240k?" -> a bare "250" answers in OUR thousands, so it
 *     is the counter $250,000 (the k-shorthand convention was established by
 *     our own message);
 *   - "How many square feet is it?" -> a bare "250" is a size, never a price.
 *
 * ONE SLOT: process-seller-inbound-message.js applies this to price_signal
 * immediately after it is computed. price_signal is the only input to the
 * fact extraction, temperature, canonical promotion, negotiation preview and
 * persistence, so a NON_LITERAL / AMBIGUOUS price can neither persist nor
 * advance the stage. Pure; no I/O.
 */

import { carriesLaughter, FACTUAL_COMMITMENT } from "./emoji-interpretation.js";

import {
  describeLastQuestion,
  resolveLastQuestion,
  questionEstablishesThousandsShorthand,
  LAST_QUESTION_KIND,
} from "./last-question.js";

export { FACTUAL_COMMITMENT, describeLastQuestion, questionEstablishesThousandsShorthand, LAST_QUESTION_KIND };

const clean = (v) => String(v ?? "").trim();

// A bare number reply: digits only (optionally $ / commas / a trailing period).
const BARE_NUMBER_REPLY_RE = /^\$?\s*\d{1,3}(?:[.,]\d+)?\s*[.!?]*$/;

function demote(price_signal, { commitment, reason, candidate }) {
  return {
    ...price_signal,
    asking_price: null,
    is_counter: false,
    needs_clarification: commitment !== FACTUAL_COMMITMENT.UNKNOWN,
    clarification_reason: commitment === FACTUAL_COMMITMENT.UNKNOWN ? null : reason,
    commitment,
    commitment_reason: reason,
    demoted_candidate: candidate
      ? {
          value: candidate.value ?? null,
          extracted_text: candidate.extracted_text ?? null,
          confidence: candidate.confidence ?? null,
        }
      : null,
  };
}

/**
 * @param {object} price_signal  resolveAskingPriceSignal / resolveBurstAskingPriceSignal output
 * @param {object} opts          { message, classification, lastOutboundBody | lastQuestion }
 * @returns {object} the same shape, plus `commitment` (+ demotion details)
 */
export function applyFactualCommitmentToPriceSignal(price_signal, { message = "", classification = null, lastOutboundBody = null, lastQuestion = null } = {}) {
  if (!price_signal || typeof price_signal !== "object") return price_signal;
  const ask = price_signal.asking_price || null;
  const text = clean(message);

  // 1. Laughter / declared non-literal: never an asking price.
  const nonLiteral =
    carriesLaughter(text) ||
    classification?.factual_commitment === FACTUAL_COMMITMENT.NON_LITERAL ||
    (Array.isArray(classification?.matched_rule_ids) && classification.matched_rule_ids.includes("non_literal_laughter"));
  if (ask && nonLiteral) {
    return demote(price_signal, { commitment: FACTUAL_COMMITMENT.NON_LITERAL, reason: "non_literal_price", candidate: ask });
  }

  // 1b. A price far above any realistic value ("1 million" on a $182K house,
  // price-plausibility.js) is not an asking price either: it never persists
  // and never moves the stage (2026-10-06, +17276319579).
  const implausible =
    classification?.primary_intent === "asking_price_implausible" ||
    classification?.price_parse?.implausibility?.implausible === true;
  if (ask && implausible) {
    return demote(price_signal, { commitment: FACTUAL_COMMITMENT.NON_LITERAL, reason: "implausible_price", candidate: ask });
  }

  // 2. A bare number answering a size / count / year question is not a price.
  const question = resolveLastQuestion({ lastOutboundBody, lastQuestion });
  if (question.kind === LAST_QUESTION_KIND.NON_PRICE_QUANTITY && BARE_NUMBER_REPLY_RE.test(text)) {
    return demote(price_signal, { commitment: FACTUAL_COMMITMENT.UNKNOWN, reason: "number_answers_a_quantity_question", candidate: ask });
  }

  if (ask) {
    // scaled_from_reference: the magnitude was inferred ("400" against a
    // $200,000 anchor), a reading rather than a quotation.
    const inferred = ask.scaled_from_reference === true;
    const confidence = Number(ask.confidence) || 0;
    return {
      ...price_signal,
      commitment: !inferred && confidence >= 0.75 ? FACTUAL_COMMITMENT.CONFIRMED : FACTUAL_COMMITMENT.LIKELY,
    };
  }
  return {
    ...price_signal,
    commitment: price_signal.needs_clarification ? FACTUAL_COMMITMENT.AMBIGUOUS : FACTUAL_COMMITMENT.UNKNOWN,
  };
}

export default applyFactualCommitmentToPriceSignal;
