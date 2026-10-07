/**
 * THE ONE MONEY PATH (RC 7.2 release blocker B, 2026-10-01).
 *
 * Every component that decides "did the seller state an asking price, and
 * what is it?" calls this, or delegates to something that does:
 *
 *   orchestrator slot      process-seller-inbound-message.js (single + burst)
 *   burst reduction        seller-inbound-burst-policy.js (per fragment)
 *   classifier             classify.js -> asking_price_provided / price_parse
 *   stage engines          stage2 extractAskingPrice (stage 3, stage 5 reuse it)
 *   underwriting signals   extract-underwriting-signals.js (legacy Podio sink)
 *   deal intelligence      conversation-signal.js extractPrices (read model)
 *
 * Two layers, composed once, here:
 *   1. WHAT number: seller-flow/monetary-understanding.js resolveAskingPriceSignal
 *      (tokenizer, phone / ZIP / year / address guards, RC 7.1 scale rules:
 *      a bare "65" is ambiguous, "65k" / "sixty five thousand" are $65,000).
 *   2. HOW COMMITTED: classification/factual-commitment.js (7.2): laughter is
 *      NON_LITERAL, a bare number after a size question is not a price, and the
 *      question WE asked can establish the thousands scale ("$240k?" -> "250").
 *
 * A price is decided only when it is COMMITTED (CONFIRMED or LIKELY). Anything
 * else is no price: AMBIGUOUS asks for clarification, NON_LITERAL / UNKNOWN
 * do not. Nobody re-parses, scales or "assumes thousands" downstream.
 * Pure, synchronous, no I/O.
 */

import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveBurstAskingPriceSignal } from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  applyFactualCommitmentToPriceSignal,
  FACTUAL_COMMITMENT,
} from "@/lib/domain/classification/factual-commitment.js";
import {
  resolveLastQuestion,
  questionEstablishesThousandsShorthand,
} from "@/lib/domain/classification/last-question.js";

export const CANONICAL_ASKING_PRICE_VERSION = "canonical_asking_price_v1";

/** The commitment levels that may become a price. */
export const COMMITTED_PRICE_LEVELS = Object.freeze([FACTUAL_COMMITMENT.CONFIRMED, FACTUAL_COMMITMENT.LIKELY]);

const clean = (v) => String(v ?? "").trim();

function questionReference(question) {
  const amount = Number(question?.k_amount);
  return questionEstablishesThousandsShorthand(question) && Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * One message (or one burst fragment).
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {number|null}  [opts.reference]           current ask / recommended offer / valuation
 * @param {boolean}      [opts.negotiationActive]   an offer was revealed (counter vs ask)
 * @param {boolean}      [opts.shorthandConvention] the seller already wrote "110k"
 * @param {string|null}  [opts.lastOutboundBody]    the question we asked last ...
 * @param {object|null}  [opts.lastQuestion]        ... or its description (conversation context)
 * @param {object|null}  [opts.classification]      laughter / non-literal markers
 * @param {string|null}  [opts.sourceMessageId]
 * @param {string|null}  [opts.now]
 */
export function resolveCanonicalAskingPrice(message, {
  reference = null,
  negotiationActive = false,
  shorthandConvention = false,
  numberRules = null,
  lastOutboundBody = null,
  lastQuestion = null,
  classification = null,
  sourceMessageId = null,
  now = null,
} = {}) {
  const question = resolveLastQuestion({ lastOutboundBody, lastQuestion });
  const signal = resolveAskingPriceSignal(message, {
    // Our own "Would you take $240k?" names the amount being answered: with no
    // deal reference loaded (classifier, read model), it is the reference.
    reference: reference ?? questionReference(question),
    negotiationActive,
    shorthandConvention: shorthandConvention === true || questionEstablishesThousandsShorthand(question),
    // null = the SELLER_CONVERSATION_V3 flag decides (monetary-understanding.js).
    numberRules,
    sourceMessageId,
    now,
  });
  return {
    ...applyFactualCommitmentToPriceSignal(signal, { message, classification, lastQuestion: question }),
    canonical_version: CANONICAL_ASKING_PRICE_VERSION,
  };
}

/**
 * A finalized burst: every fragment goes through the SAME single-message path
 * (so a joke fragment is demoted before the latest-explicit-value fold), then
 * the burst reduction picks the effective price.
 */
export function resolveCanonicalBurstAskingPrice(constituents = [], opts = {}) {
  const { lastOutboundBody = null, lastQuestion = null, classification = null } = opts;
  const question = resolveLastQuestion({ lastOutboundBody, lastQuestion });
  const reduced = resolveBurstAskingPriceSignal(constituents, {
    ...opts,
    reference: opts.reference ?? questionReference(question),
    shorthandConvention: opts.shorthandConvention === true || questionEstablishesThousandsShorthand(question),
    resolveFragment: (body, fragmentOpts) =>
      applyFactualCommitmentToPriceSignal(resolveAskingPriceSignal(body, fragmentOpts), {
        message: body,
        classification,
        lastQuestion: question,
      }),
  });
  const commitment =
    reduced.commitment ||
    (reduced.asking_price
      ? FACTUAL_COMMITMENT.LIKELY
      : reduced.needs_clarification
        ? FACTUAL_COMMITMENT.AMBIGUOUS
        : FACTUAL_COMMITMENT.UNKNOWN);
  return { ...reduced, commitment, canonical_version: CANONICAL_ASKING_PRICE_VERSION };
}

/** True only for a price the policy admits (CONFIRMED / LIKELY with a value). */
export function isCommittedAskingPrice(signal) {
  return Boolean(signal?.asking_price) && COMMITTED_PRICE_LEVELS.includes(signal?.commitment);
}

/**
 * The compact answer most callers need: { value, raw, commitment, ... } or a
 * null value. `raw` is the seller's own text for the amount.
 */
export function canonicalAskingPriceDecision(message, opts = {}) {
  const signal = resolveCanonicalAskingPrice(message, opts);
  const committed = isCommittedAskingPrice(signal);
  const ask = committed ? signal.asking_price : null;
  return {
    value: ask && Number.isFinite(Number(ask.value)) ? Math.round(Number(ask.value)) : null,
    raw: ask ? clean(ask.extracted_text ?? ask.raw ?? "") || null : null,
    confidence: ask ? Number(ask.confidence) || null : null,
    is_counter: committed ? signal.is_counter === true : false,
    commitment: signal.commitment,
    needs_clarification: signal.needs_clarification === true,
    clarification_reason: signal.clarification_reason ?? null,
    canonical_version: CANONICAL_ASKING_PRICE_VERSION,
    signal,
  };
}

export default resolveCanonicalAskingPrice;
