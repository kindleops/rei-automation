// rc-8.5.21 v3 (conversation quality, no safety loosening): ACCEPTANCE of OUR proposal, read from context.
// "No, I'm good with the amount you proposed" is an ACCEPTANCE of our number — its leading "No" answers
// something else (e.g. "any questions?"); "I'm good" alone is a decline. The phrase must reference OUR
// proposal (the amount / price / offer / number you proposed, offered, mentioned, sent) or be an explicit
// acceptance ("I accept", "we have a deal", "I'll take it") — and, for the native path, follow an outbound
// that actually carried our offer. Recognition only: an acceptance is NEVER acted on automatically — a
// person verifies the actual offer, the property and the authority (no automatic contract).
// Pure.
export const ACCEPTANCE_VERSION = 'conv-ai.acceptance.v1'
const OUR_PROPOSAL = String.raw`(?:the|that|your|this)\s+(?:amount|price|offer|number|figure|proposal|deal)(?:\s+(?:you|u)\s+(?:proposed|offered|mentioned|sent|gave|quoted|said))?`
const ACCEPT_RE = new RegExp(String.raw`\b(?:(?:i'?m|im|i\s+am|we'?re|we\s+are|i'?d\s+be|that'?s|it'?s)\s+(?:good|ok(?:ay)?|fine|happy|cool|alright|all\s+right)\s+with\s+${OUR_PROPOSAL}|${OUR_PROPOSAL}\s+(?:works(?:\s+for\s+(?:me|us))?|is\s+(?:fine|good|ok(?:ay)?|acceptable|fair)|sounds\s+(?:good|fair|fine|great))|i\s+(?:accept|agree\s+to)(?:\s+${OUR_PROPOSAL})?|(?:we\s+have|we'?ve\s+got|you\s+have|you'?ve\s+got|it'?s)\s+a\s+deal|(?:i'?ll|i\s+will|we'?ll|we\s+will)\s+take\s+(?:it|that|the\s+offer|your\s+offer)|let'?s\s+do\s+(?:it|this|the\s+deal))\b`, 'i')
const NEGATED_RE = new RegExp(String.raw`\b(?:not|n't|never|no\s+longer|wouldn'?t\s+be)\s+(?:(?:really|so|that)\s+)?(?:good|ok(?:ay)?|fine|happy|cool)\s+with\b|\b(?:don'?t|do\s+not|won'?t|will\s+not|can'?t|cannot)\s+(?:accept|take|agree)\b|\b(?:doesn'?t|does\s+not|won'?t)\s+work\b|\b(?:too\s+low|not\s+enough|no\s+deal|not\s+a\s+deal)\b|\?\s*$`, 'i')

/** Does this text accept OUR proposal? `weProposed` = an outbound of ours carried an offer / amount. */
export function acceptsOurProposal(text = '', { weProposed = true } = {}) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 240 || !weProposed) return false
  if (NEGATED_RE.test(t)) return false
  return ACCEPT_RE.test(t)
}
