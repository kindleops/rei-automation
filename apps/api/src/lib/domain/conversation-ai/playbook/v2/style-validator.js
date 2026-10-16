// PLAYBOOK v2 STYLE VALIDATOR. Every v1 rule (em dash, en dash, one question, no invented
// claims, …) is applied unchanged; ONLY the persona rule is replaced (see index.js). Pure.
import { validatePlaybookStyle as validateV1, sentenceCount } from '../v1/style-validator.js'

export const STYLE_VALIDATOR_VERSION = 'playbook.v2.style'
export { sentenceCount }

// a first-person NAME claim: "this is Helen", "I'm Helen", "my name is Helen", "Helen here"
const NAME_CLAIM_RE = /\b(?:[Mm]y\s+name\s+is|[Mm]y\s+name'?s|[Tt]his\s+is|[Ii]'?m|[Ii]\s+am|[Ii]t'?s)\s+([A-Z][a-z]+)\b(?!\s+(?:about|regarding|for|with|from|in|at))|\b([A-Z][a-z]+)\s+here\b/g
const NON_NAME_WORDS = new Set(['Just', 'Not', 'Sorry', 'Happy', 'Glad', 'Still', 'Here', 'Interested', 'Looking', 'Local', 'Reaching', 'Following', 'Asking', 'Curious', 'With', 'Only', 'Also', 'A', 'An', 'The', 'Totally', 'Definitely', 'Good', 'Fine', 'Okay', 'Ok', 'Great', 'Hoping', 'Checking', 'Thinking', 'Open', 'Ready', 'Buying', 'Texting', 'Writing', 'Hi', 'Hey', 'Hello', 'That', 'This', 'There', 'Yes', 'No', 'Thanks', 'Understood', 'Got', 'Fair', 'Absolutely', 'Sure', 'Real', 'Human', 'Automated', 'Partly', 'Part'])

// a false denial of automation (owner rule: never deny it when directly asked)
const DENIES_AUTOMATION_RE = /\b(?:i'?m|i\s+am|this\s+is|it'?s)\s+(?:a\s+)?(?:real\s+(?:person|human|guy|one)|human|live\s+person|actual\s+person|not\s+(?:a\s+)?(?:bot|robot|computer|machine|ai|automated|program|recording))\b|\bnot\s+(?:a\s+)?(?:bot|robot|computer|machine|an?\s+ai|automated|auto[\s-]?generated|a\s+recording)\b|\b(?:no\s+)?(?:bots?|ai|automation)\s+(?:here|involved)\b|\b(?:isn'?t|is\s+not|ain'?t)\s+(?:an?\s+)?(?:automated|auto[\s-]?(?:text|message|reply)|bot|robot|ai)\b|\bnot\s+automated\b|\b(?:typed|texting|writing)\s+(?:this\s+)?(?:myself|personally|by\s+hand)\b|\b100%\s+(?:real|human)\b|\breal\s+person\s+(?:here|texting)\b/i

// an invented persona backstory / credential (v1 already refuses "years of experience",
// "licensed", track records and capacity claims; these are the personal-history forms)
const BACKSTORY_RE = /\b(?:i\s+(?:grew\s+up|was\s+born|was\s+raised|went\s+to\s+(?:school|college)|used\s+to\s+(?:live|be\s+a|work)|live\s+(?:nearby|close\s+by|down\s+the\s+(?:street|road)|in\s+the\s+(?:area|neighborhood)|around\s+the\s+corner)|have\s+(?:lived|been\s+(?:investing|buying|in\s+(?:real\s+estate|the\s+business))\s+(?:for|since))|retired\s+from|own\s+(?:several|many|a\s+(?:few|lot\s+of)|[0-9]+)\s+(?:properties|houses|homes|rentals|units))|born\s+and\s+raised|my\s+(?:wife|husband|kids|family|dad|father|mom|mother|son|daughter|grandparents?|brother|sister)\b|(?:i'?m|i\s+am)\s+(?:a\s+)?(?:licensed|certified|registered|realtor|real\s+estate\s+agent|broker|contractor|attorney|lawyer|veteran|retired|former|local\s+(?:realtor|agent|broker|contractor))|been\s+(?:investing|buying|flipping|in\s+(?:real\s+estate|the\s+business))\s+(?:for\s+)?(?:[0-9]+|many|several|over|a\s+few|years|decades)|(?:[0-9]+|many|several)\s+years\s+(?:in\s+(?:the\s+)?(?:business|real\s+estate|the\s+area)|investing)|family[\s-](?:owned|run)|(?:our|my)\s+(?:office|headquarters|storefront)\s+(?:is|in)|(?:i|we)'?(?:ve|\s+have)\s+(?:done|closed|bought)\s+(?:[0-9]+|hundreds|dozens|many|a\s+lot\s+of)\s+(?:deals|houses|homes|properties))\b/i

/**
 * Names this message claims as the sender (first-person name claims only).
 * @returns {string[]}
 */
export function claimedNames(text) {
  const out = []
  const t = String(text ?? '')
  for (const m of t.matchAll(NAME_CLAIM_RE)) {
    const name = m[1] || m[2]
    if (name && !NON_NAME_WORDS.has(name)) out.push(name)
  }
  return [...new Set(out)]
}

export function deniesAutomation(text) {
  return DENIES_AUTOMATION_RE.test(String(text ?? ''))
}

export function inventsBackstory(text) {
  return BACKSTORY_RE.test(String(text ?? ''))
}

/**
 * @param {string} text
 * @param {{ personaPolicy?: { allow_established_persona: boolean }, establishedPersona?: string|null }} [opts]
 * @returns {{ ok: boolean, reasons: string[], version: string, claimed_names: string[] }}
 */
export function validatePlaybookStyle(text, { personaPolicy = { allow_established_persona: true }, establishedPersona = null } = {}) {
  const t = String(text ?? '')
  // v1, minus its persona rule (replaced below): v1 with a permissive persona policy flags only
  // a generic human claim / a non-matching name, both of which v2 re-judges itself
  const v1 = validateV1(t, { personaPolicy: { allow_established_persona: true }, establishedPersona: establishedPersona || '\u0000' })
  const r = v1.reasons.filter((x) => x !== 'style:claims_to_be_a_specific_human')
  const persona = String(establishedPersona || '').trim()
  const names = claimedNames(t)
  const allowed = personaPolicy?.allow_established_persona === true && persona
  for (const n of names) if (!allowed || n.toLowerCase() !== persona.toLowerCase()) r.push('persona:name_not_established')
  if (deniesAutomation(t)) r.push('persona:denies_automation')
  if (inventsBackstory(t)) r.push('persona:invented_backstory_or_credentials')
  return { ok: r.length === 0, reasons: [...new Set(r)], version: STYLE_VALIDATOR_VERSION, claimed_names: names }
}
