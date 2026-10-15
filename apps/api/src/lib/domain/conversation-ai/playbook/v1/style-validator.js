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
const FLATTERY_RE = /\b(?:great\s+question|good\s+question|love\s+that|what\s+a\s+(?:great|beautiful|lovely)|you(?:'re|\s+are)\s+(?:so\s+)?(?:kind|awesome|amazing|great)|i\s+(?:really\s+)?appreciate\s+you(?!\s+(?:letting|taking|getting|replying|responding|reaching|telling|confirming|being|clarifying|explaining|sharing))|thank\s+you\s+so\s+much|so\s+(?:excited|thrilled)|wonderful|amazing|fantastic|awesome|beautiful\s+(?:home|house|property))\b/i
const FILLER_RE = /\b(?:hope\s+(?:you(?:'re|\s+are)\s+(?:well|doing\s+well)|this\s+finds|all\s+is\s+well|you(?:'re|\s+are)\s+having)|just\s+(?:checking|following)\s+(?:in|up)|touching\s+base|circling\s+back|reaching\s+out\s+to\s+see|i\s+wanted\s+to\s+(?:reach\s+out|let\s+you\s+know)|feel\s+free\s+to|don'?t\s+hesitate)\b/i
const ROBOTIC_RE = /\b(?:additionally|furthermore|moreover|in\s+conclusion|rest\s+assured|certainly!?|absolutely!|i'?d\s+be\s+(?:happy|glad|delighted)\s+to|i\s+understand\s+(?:that\s+)?(?:your|you)|as\s+an\s+ai|language\s+model|please\s+note\s+that|kindly)\b/i
const SLANG_RE = /\b(?:lol|lmao|rofl|bro|bruh|dude|fam|yo|gonna|wanna|gotta|kinda|sorta|ya'?ll|y'?all|ain'?t|u|ur|r|thx|pls|plz|btw|imo|tbh|omg)\b/i
const INVENTED_RE = /\b(?:i'?ve\s+(?:bought|purchased|closed|helped|worked\s+with)|we'?ve\s+(?:bought|purchased|closed|helped)|(?:years?|decades?)\s+of\s+experience|hundreds\s+of|thousands\s+of|(?:my|our)\s+(?:team|company|investors?|partners?)\s+(?:has|have|will|can)|we\s+(?:buy|purchase)\s+(?:houses?|homes?)\s+all\s+over|top[\s-]rated|award|licensed|bbb|a\+\s+rating|we\s+can\s+close\s+(?:in|within|by)|close\s+in\s+[0-9]+\s+days|cash\s+(?:in\s+hand|ready|on\s+hand)|proof\s+of\s+funds|we\s+have\s+(?:the\s+)?(?:funds|cash)|guarantee\w*|promise|no\s+(?:fees|commissions?|closing\s+costs|obligation)|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|end\s+of\s+(?:day|week|month))|(?:ends?|ending|expir\w*|good\s+until|valid\s+(?:until|through))\s+(?:on\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|soon|today|the\s+end)|this\s+week\s+only|limited\s+time|expires?|deadline|only\s+(?:buying|have\s+room)|spots?\s+left)\b/i
// "you were picked" / "not a mass text": targeting claims we cannot make about a campaign send
// claims about our inventory / other deals / buyers (we cannot know or promise them)
// steps nobody agreed to (a viewing, a visit) are invented next steps
const INVENTED_STEP_RE = /\b(?:set\s+up\s+a\s+time\s+to\s+(?:view|see|walk|come|tour)|before\s+we\s+(?:come|stop|head)\s+(?:out|by|over)|schedule\s+a\s+(?:visit|walk[\s-]?through|viewing|showing|tour)|come\s+(?:out|by)\s+(?:and|to)\s+(?:see|look|take\s+a\s+look)|when\s+we\s+(?:come|stop)\s+(?:out|by))\b/i
// two questions joined inside one question mark ("what's the condition, and are there repairs?")
const COMPOUND_Q_RE = /[^.?!]*,\s*and\s+(?:are|is|have|has|do|does|did|what|how|any|were|was|will|would|could|can)\b[^.?!]*\?/i
const INVENTORY_RE = /\b(?:we|i)\s+(?:don'?t|do\s+not|have|currently\s+have|got)\s+(?:any\s+|no\s+)?(?:\w+\s+){0,3}(?:fixer[\s-]?uppers?|properties|homes|houses|listings|deals|inventory|buyers)\b(?:\s+\w+){0,4}\s+(?:right\s+now|at\s+the\s+moment|on\s+hand|available|to\s+(?:share|send|offer))/i
const TARGETING_RE = /\b(?:not\s+(?:just\s+)?(?:casting\s+a\s+wide\s+net|a\s+mass\s+(?:text|message)|(?:sending|texting|blasting)\s+everyone|a\s+(?:general|random)\s+(?:text|blast|message))|casting\s+a\s+wide\s+net|(?:specifically|personally|carefully)\s+(?:chose|chosen|selected|picked|reached\s+out|targeted|sought)|hand[\s-]?picked|you\s+were\s+(?:specifically\s+|personally\s+)?(?:chosen|selected|picked|singled\s+out)|(?:looking\s+at|interested\s+in|reaching\s+out\s+about)\s+(?:your\s+)?\S+(?:\s+\S+){0,5}\s+specifically|only\s+(?:texting|contacting|reaching\s+out\s+to)\s+(?:a\s+(?:few|handful)|select|certain)|\babout\s+(?:\S+\s+){0,6}specifically\b)\b/i
// stock openers the eval found on most replies; a draft must not lean on them
const STOCK_OPENER_RE = /^\s*(?:fair\s+question|quick\s+question|good\s+point|before\s+we\s+go\s+further|(?:understood|got\s+it|makes\s+sense|no\s+problem|okay|ok)[,.!]?\s+(?:thanks|thank\s+you|appreciate\s+(?:it|you))\s+for\s+letting\s+me\s+know)\b/i
const HUMAN_CLAIM_RE = /(?:\b[Mm]y\s+name\s+is\s+([A-Z][a-z]+)|\b[Tt]his\s+is\s+([A-Z][a-z]+)\b(?!\s+(?:about|regarding|for))|\b[Ii]'?m\s+([A-Z][a-z]+)(?=[\s,.!]|$)|\b[Ii]\s+am\s+([A-Z][a-z]+)(?=[\s,.!]|$)|\b[Ii]\s+am\s+a\s+(?:real\s+)?(?:person|human)|\b[Ii]'?m\s+a\s+(?:real\s+)?(?:person|human)|\bnot\s+a\s+(?:bot|robot|computer))/
const NON_NAME_WORDS = new Set(['Just', 'Not', 'Sorry', 'Happy', 'Glad', 'Still', 'Here', 'Interested', 'Looking', 'Local', 'Reaching', 'Following', 'Asking', 'Curious', 'With', 'Only', 'Also', 'A'])
const BRITISH_RE = /\b(?:colour|favour|neighbour|realise|organise|apologise|cheque|whilst|flat\b|lorry|estate\s+agent)\w*/i

// abbreviations (street suffixes, titles, compass points, initials) never end a sentence
const ABBREV_RE = /\b(?:st|ave|rd|dr|blvd|ln|ct|cir|pl|hwy|pkwy|ter|trl|mt|ft|apt|ste|no|mr|mrs|ms|jr|sr|vs|etc|approx|n|s|e|w|ne|nw|se|sw|[a-z])\.(?=\s)/gi
export function sentenceCount(t) {
  return String(t).replace(ABBREV_RE, (m) => m.slice(0, -1)).split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length
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
  if (/[\u00C0-\u024F]/.test(t)) r.push('style:non_english_characters')
  if (/\b(?:gracias|entendido|usted|propiedad|vender|casa|por\s+favor|hola|disculpe|claro|bueno|cuando|quiere|tiene|estamos|somos|para|pero|que)\b/i.test(t)) r.push('style:non_english')
  if (INVENTED_RE.test(t)) r.push('style:invented_claim_offer_deadline_or_capacity')
  if (TARGETING_RE.test(t)) r.push('style:targeting_claim')
  if (INVENTORY_RE.test(t)) r.push('style:inventory_or_capacity_claim')
  if (INVENTED_STEP_RE.test(t)) r.push('style:invented_next_step')
  if (COMPOUND_Q_RE.test(t)) r.push('style:compound_question')
  if (STOCK_OPENER_RE.test(t)) r.push('style:stock_opener')
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
