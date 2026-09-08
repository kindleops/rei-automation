/**
 * hostile-input.js
 *
 * THE `= {}` TRAP, AND WHY IT HAS ITS OWN MODULE.
 *
 * `function f(input = {})` defaults an UNDEFINED argument and does nothing at
 * all for a NULL one. Reading a property off that null throws a TypeError three
 * lines later, far from the caller that produced it.
 *
 * That single omission has been a live defect six times in this codebase: the
 * SMS queue identity resolver (which threw in production), the email queue
 * identity resolver, the inbound thread resolver, the reply-alias store, the
 * inbound body normalizer, and the message classifier. Every one was written by
 * someone who knew about the trap, in a file that already worked around it
 * elsewhere. Knowing is evidently not enough; the fix has to be a thing you
 * reach for rather than a thing you remember.
 *
 * WHY THROWING IS THE WRONG FAILURE ON THESE PATHS.
 *   These functions decide whether a seller gets contacted and where their reply
 *   is filed. A TypeError escaping one can be caught by a caller and mistaken
 *   for a transport error -- which is precisely the reading that justifies a
 *   RETRY. So a null argument that throws does not merely fail: it can become a
 *   duplicate send, or a seller reply that vanishes into a catch block.
 *
 *   The correct answer is a refusal the caller can read, which is what these
 *   functions already return for every other kind of bad input.
 *
 * WHY NOT COERCE MORE THAN THIS.
 *   asObject is deliberately not a parser. It answers one question -- "can I
 *   safely read properties off this?" -- and an array answers no, because a
 *   caller who passed an array meant something the callee is not equipped to
 *   handle and should refuse rather than silently see zero properties.
 */

/**
 * Anything that is not a plain property bag becomes an empty one, so the callee
 * reaches its own validation and returns its own refusal.
 *
 * Arrays are excluded on purpose: `[].anything` is undefined rather than a
 * throw, so an array would slide through as "an object with no fields" and be
 * reported as missing-data when the real fault is a caller passing a list.
 */
export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export default asObject;
