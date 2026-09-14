/**
 * deterministic-extraction.js
 *
 * WHAT WE CAN KNOW WITHOUT ASKING A MODEL.
 *
 * A great deal, as it turns out. Money is already parsed deterministically by
 * monetary-understanding.js. Mood is grammar. Conditions are phrases.
 * Attribution is structure. None of that needs a language model, and asking one
 * to rediscover it every time costs money, adds variance, and hands a
 * prompt-injected message a place to argue.
 *
 * So this runs FIRST and produces real assertions. The model's job is the part
 * that is genuinely semantic -- motivation, objection, the reading of "I'm sick
 * of dealing with those tenants" -- and it arrives as an ENRICHMENT on top of
 * facts that are already established.
 *
 * ── WHY THIS MATTERS BEYOND COST ──────────────────────────────────────────
 *
 * It means the system has a floor. With no model configured, an outage, a
 * timeout, or a response that fails validation, the seller's price, their
 * closing condition and their channel preference are still extracted. The
 * degradation is that we do not learn WHY they are selling -- which is exactly
 * the right thing to lose first.
 *
 * It also makes the eval corpus meaningful: these cases have deterministic
 * expected outputs, so they can be asserted byte-for-byte rather than
 * approximately.
 *
 * ── NOTHING HERE INFERS ───────────────────────────────────────────────────
 *
 * Every assertion this module produces is `explicit`. If it cannot be read off
 * the seller's own words by rule, this module does not produce it.
 */

import { asObject } from "@/lib/hostile-input.js";
import { extractMonetaryMentions, MONETARY_KINDS } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { buildAssertion, ASSERTION_BASIS } from "@/lib/domain/seller-intelligence/assertion-contract.js";
import { resolveAttributableText, isAttributable } from "@/lib/domain/seller-intelligence/attributable-text.js";
import { classifyStatementMood, splitSentences } from "@/lib/domain/seller-intelligence/statement-mood.js";
import { extractConditions } from "@/lib/domain/seller-intelligence/term-conditions.js";

export const DETERMINISTIC_EXTRACTOR_VERSION = "seller_deterministic_v1";

/**
 * The existing money taxonomy, mapped onto assertion types.
 *
 * monetary-understanding.js already decides WHAT a number means -- asking
 * price, payoff, repair, tax. That decision is not re-made here; it is
 * translated. Anything it could not name stays unnamed rather than becoming a
 * price by default.
 */
const MONEY_KIND_TO_ASSERTION = Object.freeze({
  [MONETARY_KINDS.ASKING_PRICE]: "seller_price_expectation",
  [MONETARY_KINDS.COUNTER_OFFER]: "seller_counter_price",
  [MONETARY_KINDS.MINIMUM_PRICE]: "seller_minimum_price",
  [MONETARY_KINDS.NET_REQUIREMENT]: "seller_desired_net_proceeds",
  [MONETARY_KINDS.MORTGAGE_PAYOFF]: "mortgage_balance_claim",
  [MONETARY_KINDS.TAX_AMOUNT]: "tax_amount_claim",
});

/** Channel instructions, which are unambiguous enough to read by rule. */
const CHANNEL_RULES = [
  [/\bdon'?t\s+call\b|\bno\s+calls?\b|\bstop\s+calling\b/i, "channel_restriction", "do_not_call"],
  [/\bdon'?t\s+text\b|\bno\s+texts?\b|\bstop\s+texting\b/i, "channel_restriction", "do_not_text"],
  [/\bemail\s+(?:me\s+)?(?:is\s+)?(?:fine|better|best|only|instead)\b|\bemail\s+me\b/i, "channel_preference", "email"],
  [/\btext\s+me\b|\btexting\s+is\s+(?:fine|better|best)\b/i, "channel_preference", "sms"],
  [/\bcall\s+me\b/i, "channel_preference", "call"],
];

/** Occupancy, which sellers state plainly and which changes what a deal is. */
const OCCUPANCY_RULES = [
  [/\b(?:it'?s|is|currently)\s+vacant\b|\bvacant\s+now\b|\bnobody\s+(?:lives|is living)\s+there\b/i, "vacant"],
  [/\btenant\s+(?:is\s+)?(?:still\s+)?(?:there|in\s+it|living)\b|\btenant[- ]occupied\b/i, "tenant_occupied"],
  [/\bi\s+live\s+there\b|\bowner[- ]occupied\b|\bwe\s+live\s+(?:there|in\s+it)\b/i, "owner_occupied"],
];

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Extract everything that can be read by rule.
 *
 * @param {object} input
 * @param {object} input.body        an EMAIL-3 body object, or { text }
 * @param {string} input.received_at the moment the seller wrote it
 * @returns {{assertions:Array, attribution:object, rejected:Array, extractor, extractor_version}}
 */
export function extractDeterministicAssertions(raw_input) {
  const input = asObject(raw_input);
  const received_at = clean(input.received_at);

  // Whose words are these? Everything below reads ONLY what survives here, so a
  // number quoted back at us cannot become a seller fact no matter which rule
  // would otherwise have matched it.
  const attribution = resolveAttributableText(input.body ?? input.text ?? "");
  const text = attribution.attributable;

  const assertions = [];
  const rejected = [];
  const add = (candidate) => {
    const built = buildAssertion(candidate);
    if (built.ok) assertions.push(built.assertion);
    else rejected.push({ reason: built.reason, detail: built.detail ?? candidate.type });
  };

  if (!text) {
    return {
      assertions, rejected, attribution,
      extractor: "deterministic", extractor_version: DETERMINISTIC_EXTRACTOR_VERSION,
    };
  }

  // Conditions are found over the WHOLE attributable text, because a condition
  // routinely sits in a different sentence from the number it qualifies:
  // "I'd take 185. That's if you close Friday."
  const conditions = extractConditions(text, { reference_iso: received_at });

  // A CORRECTION ANYWHERE CONTAMINATES EVERY NUMBER IN THE MESSAGE.
  //
  // Sentence-level resolution handles "I meant 190, not 290". It cannot handle
  // "Correction: 190k. 290k. 215k." -- once the numbers are split across
  // sentences the pair never forms, and each bare number then looks like a
  // plain assertion. Asserting them would record values the seller may have
  // been retracting.
  //
  // So the message-level flag is computed first, and any number that does not
  // resolve as an explicit pair is rejected rather than assumed.
  const message_is_correction = splitSentences(text)
    .some((sentence) => classifyStatementMood(sentence).mood === "correction");

  // ── money, per sentence, gated on mood ──────────────────────────────────
  for (const sentence of splitSentences(text)) {
    const mood = classifyStatementMood(sentence);
    const mentions = extractMonetaryMentions(sentence);

    // A CORRECTION carries two numbers with opposite meanings: the one the
    // seller meant and the one they are retracting. "Sorry, I meant 190, not
    // 290" asserts 190 and RETIRES 290 -- and a naive pass records 290, which
    // is the exact value the seller just told us was wrong.
    //
    // Mood alone cannot save this, because a correction IS assertive: the
    // seller is stating something. So the pair has to be resolved here.
    if (mood.mood === "correction" || (message_is_correction && mentions.length)) {
      const resolved = resolveCorrectionPair(sentence, mentions);
      if (!resolved.ok) {
        // An unresolvable correction yields nothing rather than a coin flip.
        // Half of these numbers is wrong and we cannot tell which.
        for (const mention of mentions) {
          rejected.push({ reason: "money_in_unresolved_correction", detail: clean(mention.raw ?? mention.text) });
        }
        continue;
      }
      rejected.push({ reason: "money_retracted_by_correction", detail: clean(resolved.retracted?.raw ?? "") });
      const assertion_type = MONEY_KIND_TO_ASSERTION[resolved.intended.kind] || "seller_price_expectation";
      add({
        type: assertion_type,
        basis: ASSERTION_BASIS.EXPLICIT,
        confidence: typeof resolved.intended.confidence === "number" ? resolved.intended.confidence : 0.5,
        value: { currency: "USD", amount: resolved.intended.value },
        raw_value: clean(resolved.intended.raw ?? resolved.intended.text),
        evidence: sentence,
        conditions,
        corrected: true,
      });
      continue;
    }

    for (const mention of mentions) {
      const assertion_type = MONEY_KIND_TO_ASSERTION[mention.kind];
      // A number monetary-understanding could not name does not become a price
      // by default. "unknown" means unknown.
      if (!assertion_type) {
        rejected.push({ reason: "unnamed_monetary_kind", detail: clean(mention.kind) });
        continue;
      }

      // A question, a request, a hypothetical or a past-state sentence never
      // yields an EXPLICIT fact. "Is your offer 175?" is not a seller price.
      if (!mood.assertive) {
        rejected.push({ reason: `money_in_${mood.mood}`, detail: clean(mention.raw ?? mention.text) });
        continue;
      }

      const raw_value = clean(mention.raw ?? mention.text);
      // Belt and braces on attribution: the sentence came from attributable
      // text, and this re-checks the exact token.
      if (raw_value && !isAttributable(attribution, raw_value)) {
        rejected.push({ reason: "money_not_attributable_to_seller", detail: raw_value });
        continue;
      }

      add({
        type: assertion_type,
        basis: ASSERTION_BASIS.EXPLICIT,
        confidence: typeof mention.confidence === "number" ? mention.confidence : 0.5,
        value: { currency: "USD", amount: mention.value },
        raw_value,
        evidence: sentence,
        conditions,
      });
    }
  }

  // ── channel instructions ────────────────────────────────────────────────
  for (const [pattern, type, value] of CHANNEL_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const mood = classifyStatementMood(sentenceContaining(text, match[0]));
    if (!mood.assertive) continue;
    add({
      type,
      basis: ASSERTION_BASIS.EXPLICIT,
      confidence: 0.95,
      value,
      raw_value: match[0],
      evidence: sentenceContaining(text, match[0]),
      conditions: [],
    });
  }

  // ── occupancy ───────────────────────────────────────────────────────────
  for (const [pattern, value] of OCCUPANCY_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const sentence = sentenceContaining(text, match[0]);
    const mood = classifyStatementMood(sentence);
    // "It is NOT vacant" and "the tenant USED TO live there" must not become
    // assertions of the thing being denied.
    if (!mood.assertive) {
      rejected.push({ reason: `occupancy_in_${mood.mood}`, detail: match[0] });
      continue;
    }
    add({
      type: "occupancy_status",
      basis: ASSERTION_BASIS.EXPLICIT,
      confidence: 0.9,
      value,
      raw_value: match[0],
      evidence: sentence,
      conditions: [],
    });
  }

  return {
    assertions,
    rejected,
    attribution,
    conditions,
    extractor: "deterministic",
    extractor_version: DETERMINISTIC_EXTRACTOR_VERSION,
  };
}

/**
 * Which number did the seller MEAN, and which are they retracting?
 *
 * Only the unambiguous shapes are resolved: the intended value is introduced by
 * a correction verb, and the retracted one by a negation. Anything else yields
 * nothing, because guessing here has a fifty percent chance of recording the
 * number the seller just told us was wrong.
 */
function resolveCorrectionPair(sentence, mentions) {
  if (!Array.isArray(mentions) || mentions.length !== 2) return { ok: false };

  const text = clean(sentence);
  const positions = mentions.map((mention) => {
    const raw = clean(mention.raw ?? mention.text);
    return { mention, index: raw ? text.indexOf(raw) : -1, raw };
  });
  if (positions.some((entry) => entry.index < 0)) return { ok: false };

  positions.sort((a, b) => a.index - b.index);
  const [first, second] = positions;

  // "I meant 190, not 290" -- the retraction marker sits BETWEEN them.
  const between = text.slice(first.index + first.raw.length, second.index);
  if (/\bnot\b|\brather than\b|\binstead of\b/i.test(between)) {
    return { ok: true, intended: first.mention, retracted: second.mention };
  }

  // "Not 290, I meant 190" -- the retraction marker precedes the FIRST.
  const before_first = text.slice(0, first.index);
  if (/\bnot\b/i.test(before_first) && /\bmeant\b|\bmake that\b/i.test(between)) {
    return { ok: true, intended: second.mention, retracted: first.mention };
  }

  return { ok: false };
}

/** The sentence a match sits in, so evidence is a readable unit. */
function sentenceContaining(text, fragment) {
  const sentences = splitSentences(text);
  return sentences.find((sentence) => sentence.includes(fragment)) || clean(text).slice(0, 300);
}

export default extractDeterministicAssertions;
