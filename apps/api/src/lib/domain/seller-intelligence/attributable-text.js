/**
 * attributable-text.js
 *
 * WHICH WORDS DID THE SELLER WRITE *THIS TIME*?
 *
 * Everything downstream assumes the text it is reading is the seller speaking
 * now. That assumption is wrong by default, because a reply routinely contains:
 *
 *   our own outbound copy, quoted back
 *   the seller's previous message, quoted back
 *   a third party's words, forwarded
 *   a signature
 *   a disclaimer their employer appends
 *
 * The failure this exists to prevent is specific and expensive:
 *
 *   Seller: That's too low. You wrote "we can offer $170,000."
 *
 * A naive extractor reads $170,000 and records SELLER ASKING PRICE = 170000.
 * The seller just said the opposite. Everything downstream -- the negotiation
 * floor, the operator's summary, EMAIL-6's authority -- is then built on a
 * number we made up out of our own sentence.
 *
 * ── CONSERVATIVE ON PURPOSE ────────────────────────────────────────────────
 *
 * The cost of removing too much is a missed fact, which shows up as an
 * unanswered question. The cost of removing too little is a fabricated fact,
 * which shows up as a wrong offer weeks later. Those are not symmetric, so the
 * rules below only remove text that is POSITIVELY identified as somebody else's
 * -- never text that merely looks quotable.
 *
 * ── IT BUILDS ON EMAIL-3, IT DOES NOT REDO IT ──────────────────────────────
 *
 * EMAIL-3's body normalization already separates the newest reply from the
 * quoted history below it, keeping all three views so a stripping mistake is
 * recoverable. This handles what survives INSIDE that newest reply: inline
 * attribution, stray quote markers, signatures.
 *
 * ── AMBIGUITY IS AN ANSWER ─────────────────────────────────────────────────
 *
 * When authorship cannot be determined the span is marked ambiguous rather than
 * guessed either way. An ambiguous span produces no explicit assertion; it can
 * still support a reviewed one.
 */

import { asObject } from "@/lib/hostile-input.js";

export const ATTRIBUTABLE_TEXT_POLICY_VERSION = "attributable_text_v1";

export const EXCLUSION_REASON = Object.freeze({
  QUOTED_MARKER: "quoted_line_marker",
  ATTRIBUTED_TO_US: "attributed_to_sender_of_record",
  ATTRIBUTED_TO_THIRD_PARTY: "attributed_to_third_party",
  QUOTE_HEADER: "quote_header",
  SIGNATURE: "signature",
  DISCLAIMER: "disclaimer",
  FORWARDED: "forwarded_banner",
});

function clean(value) {
  return String(value ?? "");
}

/**
 * Attribution to US. The pronoun is the load-bearing part: "you said X" means
 * X is ours, and "I said X" means X is theirs and still counts.
 *
 * Matches the verb plus a quoted span, because an unquoted "you said the price
 * was too high" is the seller CHARACTERISING us, which is their own sentence
 * and must survive.
 */
const ATTRIBUTED_QUOTE = [
  // you said / you wrote / you offered / your email said "..."
  /\b(?:you|your\s+(?:email|message|text|offer|letter))\s+(?:said|wrote|says|stated|offered|quoted|mentioned)\b[^"'“‘]{0,40}["'“‘]([^"'”’]{1,400})["'”’]/gi,
  // "..." is what you said
  /["'“‘]([^"'”’]{1,400})["'”’][^.!?]{0,30}\b(?:you|your)\s+(?:said|wrote|offered|quoted)\b/gi,
];

/** Attribution to somebody who is not the seller and not us. */
const THIRD_PARTY_QUOTE = [
  /\b(?:he|she|they|my\s+(?:wife|husband|sister|brother|son|daughter|lawyer|attorney|agent|realtor|partner)|the\s+(?:agent|realtor|lawyer|attorney|buyer|bank))\s+(?:said|wrote|says|told\s+me|offered)\b[^"'“‘]{0,40}["'“‘]([^"'”’]{1,400})["'”’]/gi,
];

/** Lines that are structurally not the seller writing now. */
const LINE_RULES = [
  [/^\s*>+/, EXCLUSION_REASON.QUOTED_MARKER],
  [/^\s*On\s.{4,160}\bwrote:\s*$/i, EXCLUSION_REASON.QUOTE_HEADER],
  [/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i, EXCLUSION_REASON.QUOTE_HEADER],
  [/^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i, EXCLUSION_REASON.FORWARDED],
  [/^\s*Begin forwarded message:\s*$/i, EXCLUSION_REASON.FORWARDED],
  [/^\s*(?:From|Sent|To|Subject|Date|Cc):\s*.+$/i, EXCLUSION_REASON.QUOTE_HEADER],
  [/^\s*Sent from my \w+/i, EXCLUSION_REASON.SIGNATURE],
  [/^\s*Get Outlook for (?:iOS|Android)/i, EXCLUSION_REASON.SIGNATURE],
  [
    /confidential|privileged|intended (?:solely )?(?:only )?for the|unsubscribe|do not reply to this/i,
    EXCLUSION_REASON.DISCLAIMER,
  ],
];

/** Everything after an RFC 3676 signature divider is a signature. */
const SIGNATURE_DIVIDER = /^-{2}\s*$/;

/**
 * Split a reply into what the seller wrote now and what they merely carried
 * along with it.
 *
 * @param {object|string} input  an EMAIL-3 body object, or raw text
 * @returns {{
 *   ok: boolean,
 *   attributable: string,
 *   excluded: Array<{text:string, reason:string}>,
 *   ambiguous: boolean,
 *   source: string,
 *   policy_version: string,
 * }}
 */
export function resolveAttributableText(raw_input) {
  const input = typeof raw_input === "string" ? { newest_reply: raw_input } : asObject(raw_input);

  // EMAIL-3 already did the hard half. Prefer its newest_reply; fall back to
  // the normalized whole only when there is no newest reply to prefer.
  const source = input.newest_reply ? "newest_reply" : input.normalized_text ? "normalized_text" : "raw";
  const text = clean(input.newest_reply || input.normalized_text || input.text || input.raw_text);

  if (!text.trim()) {
    return {
      ok: true, attributable: "", excluded: [], ambiguous: false,
      source, policy_version: ATTRIBUTABLE_TEXT_POLICY_VERSION,
    };
  }

  const excluded = [];
  let working = text;

  // ── inline attributed quotes, before line rules ──────────────────────────
  // Done first because an attributed quote can sit mid-line, where a
  // line-oriented rule would either miss it or take the seller's own sentence
  // with it.
  for (const [patterns, reason] of [
    [ATTRIBUTED_QUOTE, EXCLUSION_REASON.ATTRIBUTED_TO_US],
    [THIRD_PARTY_QUOTE, EXCLUSION_REASON.ATTRIBUTED_TO_THIRD_PARTY],
  ]) {
    for (const pattern of patterns) {
      working = working.replace(pattern, (whole, quoted) => {
        excluded.push({ text: clean(quoted).trim(), reason });
        // The seller's framing survives; only the quoted span goes. "That's too
        // low. You wrote ___." still reads as a rejection, which it is.
        return whole.replace(quoted, " ");
      });
    }
  }

  // ── line rules ───────────────────────────────────────────────────────────
  const kept = [];
  let in_signature = false;
  for (const line of working.split("\n")) {
    if (in_signature) {
      excluded.push({ text: line.trim(), reason: EXCLUSION_REASON.SIGNATURE });
      continue;
    }
    if (SIGNATURE_DIVIDER.test(line)) {
      in_signature = true;
      continue;
    }

    const rule = LINE_RULES.find(([pattern]) => pattern.test(line));
    if (rule && line.trim()) {
      excluded.push({ text: line.trim(), reason: rule[1] });
      continue;
    }
    kept.push(line);
  }

  const attributable = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Everything was somebody else's, yet a message arrived. We cannot say what
  // the seller meant by sending it, so nothing is attributable and the caller
  // is told the difference between "they said nothing" and "we could not tell".
  const ambiguous = Boolean(!attributable && excluded.length > 0);

  return {
    ok: true,
    attributable,
    excluded,
    ambiguous,
    source,
    policy_version: ATTRIBUTABLE_TEXT_POLICY_VERSION,
  };
}

/**
 * Is this exact substring the seller's own fresh words?
 *
 * The question an extractor must ask before turning a span into an assertion.
 * A value that appears ONLY inside excluded text may not become an explicit
 * seller fact, however confident the extractor is about having seen it.
 */
export function isAttributable(resolved, needle) {
  const result = asObject(resolved);
  const value = clean(needle).trim();
  if (!value) return false;
  return clean(result.attributable).includes(value);
}

/**
 * Did a value appear only in text somebody else wrote?
 *
 * Named as its own question because the answer drives a refusal, and a refusal
 * needs a reason an operator can read: "that 170,000 was our number, quoted
 * back at us" is a different thing from "no price was mentioned".
 */
export function appearsOnlyInExcluded(resolved, needle) {
  const result = asObject(resolved);
  const value = clean(needle).trim();
  if (!value) return false;
  if (clean(result.attributable).includes(value)) return false;
  return (Array.isArray(result.excluded) ? result.excluded : [])
    .some((entry) => clean(entry?.text).includes(value));
}

export default resolveAttributableText;
