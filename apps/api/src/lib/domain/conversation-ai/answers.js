// SHARED SHORT-ANSWER MATCHERS (rc-8.5.20 review item b).
//
// Before 8.5.20 the conversation engine read a bare "No" two ways:
//   - the 8.5.15 deterministic pre-check used seller-reply-families matchBareNegative()
//     ("No", "Nope", "No!!!!", "Not really", "No gracias Carlos!", "absolutely not" …);
//   - the 8.5.16 fact ledger used its own /^(no|nope|nah)$/ — so "Not really" after our
//     ownership question was an ownership denial in the pre-check but NOTHING in the ledger.
// Both now call the ONE matcher below. It wraps matchBareNegative (the production family
// matcher, which never matches a stop / opt-out word) and adds the two qualifiers the
// pre-check applied on top of it:
//   polite   the refusal carries a polite tail ("No thanks", "no gracias"): a polite
//            close reads as NOT INTERESTED, never as an ownership denial
//   emoji    the message carries an emoji / pictograph: tone the regex cannot read, so it
//            is never an ownership denial either (the model / a human decides)
//
// rc-8.5.21 (owner P0 2026-10-16): polite and emoji negatives answering OUR ownership question
// are ownership denials too (103 of 205 "dead" deals were a bare "No" to S1 stored as
// not_interested). `polite` / `emoji` are still reported; only the S2+ reading uses them.
// What each caller does with a match is policy, applied against OUR last question:
//   after the ownership question: ownership_denial (any bare negative)   → ownership denied
//                                 (property-scoped; no nurture, no further ownership ask)
//   after the interest question:  any bare negative → not interested (30-day follow-up)
import { matchBareNegative } from '../classification/seller-reply-families.js'

export const ANSWERS_VERSION = 'conv-ai.answers.v2'

const POLITE_TAIL_RE = /(?:^|\s)(?:thanks|thank\s+you|thank\s+u|thx|ty|gracias)$/u
const PICTOGRAPH_RE = /\p{Extended_Pictographic}/u

/**
 * @param {string} text the seller's whole message
 * @param {{ names?: string[] }} [opts] our persona / the addressee (sign-off stripping)
 * @returns {{ matched: boolean, canonical: string|null, polite: boolean, emoji: boolean, ownership_denial: boolean }}
 */
export function bareNoAnswer(text, { names = [] } = {}) {
  const body = String(text ?? '')
  const m = matchBareNegative(body, { names })
  if (!m) return { matched: false, canonical: null, polite: false, emoji: false, ownership_denial: false }
  const polite = POLITE_TAIL_RE.test(m.canonical)
  const emoji = PICTOGRAPH_RE.test(body)
  return { matched: true, canonical: m.canonical, polite, emoji, ownership_denial: true }
}

/** A bare negative of any kind ("No", "Not really", "No thanks"). */
export function isBareNo(text, opts) {
  return bareNoAnswer(text, opts).matched
}

/** A bare negative that, read against our ownership question, denies ownership. */
export function isBareOwnershipDenial(text, opts) {
  return bareNoAnswer(text, opts).ownership_denial
}
