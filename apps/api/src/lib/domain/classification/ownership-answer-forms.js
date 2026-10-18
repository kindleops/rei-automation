// OWNERSHIP-QUESTION ANSWER FORMS (owner decisions LOCKED 2026-10-17). Pure; no imports.
// Read ONLY against OUR ownership question ("Do you own / are you still the owner of <property>?"):
//   DIRECT NO           "Answer is no", "The answer is no", "No it is not", "No it's not", "It is not"
//                       ⇒ the property-scoped ownership DENIAL (like a bare "No"); with no established
//                       question it answers nothing we know ⇒ contextual review (never certainty).
//   BARE NOT INTERESTED "Not interested", "I'm not interested", "No, not interested thanks" — no "yes",
//                       no sale words ⇒ declined engagement, ownership UNVERIFIED
//                       (ownership_declined_unverified): no nurture, a property × contact hold.
//                       ("Not interested in selling", "Yes, not interested" answer the SALE: unchanged.)
export const DIRECT_NO_RE = /^\s*(?:(?:the|my)\s+)?answer\s+(?:is|was)\s+no\b[\s.!]*$|^\s*no[,.!\s]+(?:it\s+is|it'?s|it\s+isn'?t|that'?s|that\s+is)\s*(?:not)?[\s.!]*$|^\s*(?:it\s+is|it'?s)\s+not[\s.!]*$/iu
export const BARE_NOT_INTERESTED_RE = /^\s*(?:no+[,.!\s]+)?(?:(?:i'?m|im|i\s+am|we'?re|we\s+are)\s+)?not\s+interested(?:[\s,.!]+(?:thanks?|thank\s+(?:you|u)|thx|ty|sorry|bye))*[\s.!]*$/iu

export function isDirectNo(text) {
  return DIRECT_NO_RE.test(String(text ?? ''))
}
export function isBareNotInterested(text) {
  return BARE_NOT_INTERESTED_RE.test(String(text ?? ''))
}
