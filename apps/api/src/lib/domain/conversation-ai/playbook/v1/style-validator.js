// PLAYBOOK v1 STYLE VALIDATOR: the rules are enforced here, not only in the prompt.
// Returns reasons (empty = passes). Pure.
import { PERSONA_POLICY_DEFAULT, STYLE_LIMITS } from './index.js'
import { PROFANITY_RE } from './tone.js'

export const STYLE_VALIDATOR_VERSION = 'playbook.v1.style'

const EM_DASH = '—'
const EN_DASH = '–'
const FIGURE_DASHES_RE = /[‒―⸺⸻﹘﹣－]/
const DOUBLE_HYPHEN_RE = /\s--?\s|--/ // "word -- word" / "word - word" used as a dash
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u
const FLATTERY_RE = /\b(?:great\s+question|good\s+question|love\s+that|what\s+a\s+(?:great|beautiful|lovely)|you(?:'re|\s+are)\s+(?:so\s+)?(?:kind|awesome|amazing|great)|i\s+(?:really\s+)?appreciate\s+you|thank\s+you\s+so\s+much|so\s+(?:excited|thrilled)|wonderful|amazing|fantastic|awesome|beautiful\s+(?:home|house|property))\b/i
const FILLER_RE = /\b(?:hope\s+(?:you(?:'re|\s+are)\s+(?:well|doing\s+well)|this\s+finds|all\s+is\s+well|you(?:'re|\s+are)\s+having)|just\s+(?:checking|following)\s+(?:in|up)|touching\s+base|circling\s+back|reaching\s+out\s+to\s+see|i\s+wanted\s+to\s+(?:reach\s+out|let\s+you\s+know)|feel\s+free\s+to|don'?t\s+hesitate)\b/i
const ROBOTIC_RE = /\b(?:additionally|furthermore|moreover|in\s+conclusion|rest\s+assured|certainly!?|absolutely!|i'?d\s+be\s+(?:happy|glad|delighted)\s+to|i\s+understand\s+(?:that\s+)?(?:your|you)|as\s+an\s+ai|language\s+model|please\s+note\s+that|kindly)\b/i
const SLANG_RE = /\b(?:lol|lmao|rofl|bro|bruh|dude|fam|yo|gonna|wanna|gotta|kinda|sorta|ya'?ll|y'?all|ain'?t|u|ur|r|thx|pls|plz|btw|imo|tbh|omg)\b/i
const INVENTED_RE = /\b(?:i'?ve\s+(?:bought|purchased|closed|helped|worked\s+with)|we'?ve\s+(?:bought|purchased|closed|helped)|(?:years?|decades?)\s+of\s+experience|hundreds\s+of|thousands\s+of|(?:my|our)\s+(?:team|company|investors?|partners?)\s+(?:has|have|will|can)|we\s+(?:buy|purchase)\s+(?:houses?|homes?)\s+all\s+over|top[\s-]rated|award|licensed|bbb|a\+\s+rating|we\s+can\s+close\s+(?:in|within|by)|close\s+in\s+[0-9]+\s+days|cash\s+(?:in\s+hand|ready|on\s+hand)|proof\s+of\s+funds|we\s+have\s+(?:the\s+)?(?:funds|cash)|guarantee\w*|promise|no\s+(?:fees|commissions?|closing\s+costs|obligation)|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|end\s+of\s+(?:day|week|month))|(?:ends?|ending|expir\w*|good\s+until|valid\s+(?:until|through))\s+(?:on\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|soon|today|the\s+end)|this\s+week\s+only|limited\s+time|expires?|deadline|only\s+(?:buying|have\s+room)|spots?\s+left)\b/i
const HUMAN_CLAIM_RE = /(?:\b[Mm]y\s+name\s+is\s+([A-Z][a-z]+)|\b[Tt]his\s+is\s+([A-Z][a-z]+)\b(?!\s+(?:about|regarding|for))|\b[Ii]'?m\s+([A-Z][a-z]+)(?=[\s,.!]|$)|\b[Ii]\s+am\s+([A-Z][a-z]+)(?=[\s,.!]|$)|\b[Ii]\s+am\s+a\s+(?:real\s+)?(?:person|human)|\b[Ii]'?m\s+a\s+(?:real\s+)?(?:person|human)|\bnot\s+a\s+(?:bot|robot|computer))/
const NON_NAME_WORDS = new Set(['Just', 'Not', 'Sorry', 'Happy', 'Glad', 'Still', 'Here', 'Interested', 'Looking', 'Local', 'Reaching', 'Following', 'Asking', 'Curious', 'With', 'Only', 'Also', 'A'])
const BRITISH_RE = /\b(?:colour|favour|neighbour|realise|organise|apologise|cheque|whilst|flat\b|lorry|estate\s+agent)\w*/i

function sentenceCount(t) {
  return t.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length
}

/**
 * @param {string} text
 * @param {{ personaPolicy?: { allow_established_persona: boolean }, establishedPersona?: string|null, sellerAbusive?: boolean }} [opts]
 * @returns {{ ok: boolean, reasons: string[], version: string }}
 */
export function validatePlaybookStyle(text, { personaPolicy = PERSONA_POLICY_DEFAULT, establishedPersona = null } = {}) {
  const t = String(text ?? '')
  const r = []
  if (t.includes(EM_DASH)) r.push('style:em_dash')
  // an en dash is accepted only inside a numeric range (3–4); anywhere else it is a dash
  if (t.includes(EN_DASH) && t.replace(/[0-9]–[0-9]/g, '').includes(EN_DASH)) r.push('style:en_dash_as_dash')
  if (FIGURE_DASHES_RE.test(t) || DOUBLE_HYPHEN_RE.test(t)) r.push('style:dash_substitute')
  if (!t.trim()) r.push('style:empty')
  if (t.length > STYLE_LIMITS.max_chars) r.push('style:too_long')
  if (sentenceCount(t) > STYLE_LIMITS.max_sentences) r.push('style:too_many_sentences')
  if ((t.match(/\?/g) || []).length > STYLE_LIMITS.max_questions) r.push('style:more_than_one_question')
  if (EMOJI_RE.test(t)) r.push('style:emoji')
  if (/!{2,}|\?{2,}/.test(t) || (t.match(/!/g) || []).length > 1) r.push('style:over_punctuation')
  if (/[A-Z]{4,}/.test(t.replace(/\b(?:USA|HVAC|ASAP|LLC|HOA)\b/g, ''))) r.push('style:shouting')
  if (FLATTERY_RE.test(t)) r.push('style:flattery')
  if (FILLER_RE.test(t)) r.push('style:filler')
  if (ROBOTIC_RE.test(t)) r.push('style:robotic_transition')
  if (SLANG_RE.test(t)) r.push('style:slang_or_textspeak')
  if (PROFANITY_RE.test(t)) r.push('style:profanity')
  if (BRITISH_RE.test(t)) r.push('style:not_american_english')
  if (/[À-ɏ]/.test(t)) r.push('style:non_english_characters')
  if (INVENTED_RE.test(t)) r.push('style:invented_claim_offer_deadline_or_capacity')
  if (/\$\s?[0-9]|\b[0-9]{2,3}\s?k\b|\b[0-9]{1,3}(?:,[0-9]{3})+\b/i.test(t)) r.push('style:dollar_amount')
  const human = HUMAN_CLAIM_RE.exec(t)
  if (human) {
    const name = human[1] || human[2] || human[3] || human[4] || null
    const isName = name && !NON_NAME_WORDS.has(name)
    const generic = !name // "I am a real person" / "not a bot"
    const allowed = isName && personaPolicy?.allow_established_persona === true && establishedPersona && name.toLowerCase() === String(establishedPersona).toLowerCase()
    if (generic || (isName && !allowed)) r.push('style:claims_to_be_a_specific_human')
  }
  return { ok: r.length === 0, reasons: [...new Set(r)], version: STYLE_VALIDATOR_VERSION }
}
