// Conversational fast path (Intelligence 2.0, increment A).
//
// "What's good bro?" is not a research question. It gets ONE default-route model
// call with no tools, a short system prompt and a small max_tokens — no capability
// monologue, no read-only disclaimer (the permission truth is stated only when the
// operator asks for an action). Every gate still applies: kill switches, identity,
// budget, the DB reserve, settle from usage and the audit row.
//
// Classification is deterministic and conservative: only short messages that are
// greetings / thanks / small talk, with NO context attached and NO research cue,
// take the fast path. Anything else goes to the research loop.

export const CONVERSATION_LIMITS = Object.freeze({ max_chars: 80, max_words: 10, max_tokens: 160 })

const SMALL_TALK = [
  /^(hey|hi|hello|yo|sup|howdy|hiya|good (morning|afternoon|evening))\b/i,
  /^(what'?s|whats|wats|what is) (good|up|new|happening|poppin'?|crackin'?)\b/i,
  /^how('?s| is| are)? (it going|things|you|u|ya|your day|everything)\b/i,
  /^(thanks|thank you|thx|ty|appreciate (it|you)|cheers|nice|cool|great|awesome|perfect|got it|ok(ay)?|sounds good)\b/i,
  /^(good night|gn|bye|later|see (ya|you))\b/i,
]

// a cue that the operator wants records, numbers or a task — never the fast path
const RESEARCH_CUE = /\b(property|properties|owner|seller|campaign|lead|leads|deal|offer|comp|comps|price|value|equity|tax|lien|probate|foreclos\w*|market|zip|address|street|ave|road|inbox|pipeline|count|how many|show|list|find|search|look up|lookup|research|check|compare|explain|why|status|listing|listed|zillow|redfin|mls|send|text|sms|call|email)\b|[0-9]{3,}|@|\//i

/**
 * @param {string} question
 * @param {{ campaign_id?: string|null, property_ids?: string[] }} [context]
 * @returns {boolean}
 */
export function isConversational(question, context = {}) {
  const q = String(question ?? '').trim()
  if (!q || q.length > CONVERSATION_LIMITS.max_chars) return false
  if (context?.campaign_id || (Array.isArray(context?.property_ids) && context.property_ids.length)) return false
  if (q.split(/\s+/).length > CONVERSATION_LIMITS.max_words) return false
  if (RESEARCH_CUE.test(q)) return false
  const norm = q.replace(/[!?.,…~]+/g, ' ').replace(/\s+/g, ' ').trim()
  return SMALL_TALK.some((re) => re.test(norm))
}

export const CONVERSATION_PROMPT = [
  'You are LeadCommand Intelligence, the assistant inside LeadCommand, a real-estate acquisitions command center.',
  'The operator just sent a short conversational message. Reply like a sharp colleague: one or two short, natural sentences, matching their tone.',
  'Do not list your capabilities, rules or limitations, and do not add disclaimers. Do not invent facts, numbers or activity.',
  'If it fits, end with a brief offer to dig into something (a property, campaign or market).',
].join('\n')
