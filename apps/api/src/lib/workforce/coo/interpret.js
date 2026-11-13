// The COO's directive interpreter (docs/WORKFORCE.md §5). Deterministic first, over a CLOSED intent set:
//   opportunity_triage | market_diagnosis | conversation_revival | offer_activity | status_review | unknown
// unknown → ONE clarifying question; never a guess. Two intents at once → unknown (ask which).
//
// A directive that asks for anything Workforce cannot do in Phase A — contact a seller, send or make an
// offer, launch a campaign, write a stage, override STOP / suppression / a hold — is REFUSED as a whole
// (intent unknown + refusal): it never becomes a plan, so it can never produce a send-like step. The
// COO answers with a refusal and an escalation note to the CEO.
//
// The optional model path (WORKFORCE_MODEL_INTERPRET=1, deterministic result unknown, not refused) can
// only CHOOSE among the closed intents: its output is schema-validated and anything else is dropped.

export const INTENTS = Object.freeze(['opportunity_triage', 'market_diagnosis', 'conversation_revival', 'offer_activity', 'status_review'])
export const ACTIONABLE_INTENTS = Object.freeze(['opportunity_triage', 'market_diagnosis', 'conversation_revival', 'offer_activity'])
export const INTERPRET_VERSION = 'coo-interpret.v1'
export const DEFAULT_KNOWN_MARKETS = Object.freeze(['Dallas', 'Fort Worth', 'Houston', 'San Antonio', 'Austin', 'Minneapolis', 'Saint Paul', 'Atlanta', 'Memphis', 'Detroit', 'Cleveland', 'Philadelphia', 'Baltimore', 'Chicago', 'Indianapolis', 'Kansas City', 'St. Louis', 'Birmingham', 'Jacksonville', 'Tampa', 'Orlando', 'Charlotte', 'Columbus', 'Milwaukee', 'Hartford'])

export const CLARIFYING_QUESTION = 'Which do you want me to run: find and move the most promising opportunities, diagnose a market, revive stalled seller conversations, increase offer activity, or a status review?'

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty five': 25, dozen: 12 }

// ── refusals: what Phase A Workforce can never do ───────────────────────────
const CONTACT_VERB = String.raw`(?:text|txt|sms|message|msg|call|phone|ring|email|e-mail|contact|reach out to|hit up|ping|blast|send (?:a |an )?(?:text|sms|message|email)s?(?: to)?)`
const CONTACT_TARGET = String.raw`(?:every|all|each|the|those|these|them|our|my|\d+)?\s*(?:\w+\s){0,3}?(?:sellers?|owners?|leads?|prospects?|contacts?|homeowners?|people|everyone|everybody|them|list|numbers?|threads?|conversations?)`
const REFUSALS = Object.freeze([
  { code: 'CONTACT_SELLERS', re: new RegExp(String.raw`\b${CONTACT_VERB}\b[^.?!]{0,60}?\b${CONTACT_TARGET}\b`, 'i') },
  { code: 'CONTACT_SELLERS', re: /\b(?:text|sms|message|call|email)\s+(?:them|everyone|everybody|all of them)\b/i },
  { code: 'CONTACT_SELLERS', re: /\b(?:follow[- ]?up with|send (?:a )?follow[- ]?ups?(?: to)?|send (?:out )?(?:the )?(?:texts?|messages?|sms))\b/i },
  { code: 'SEND_OFFERS', re: /\b(?:send|make|submit|issue|fire off|blast|extend|present|deliver)\b[^.?!]{0,40}?\boffers?\b/i },
  { code: 'SEND_OFFERS', re: /\boffers?\b[^.?!]{0,20}?\b(?:to (?:all|every|each|them|the sellers?|everyone)|out)\b/i },
  { code: 'ACCEPT_OR_CONTRACT', re: /\b(?:accept|counter|sign|execute)\b[^.?!]{0,30}?\b(?:offers?|contracts?|counteroffers?|deals?)\b/i },
  { code: 'LAUNCH_CAMPAIGN', re: /\b(?:launch|start|kick off|resume|activate|turn on|run|unpause)\b[^.?!]{0,30}?\bcampaigns?\b/i },
  { code: 'WRITE_STAGE', re: /\b(?:move|advance|set|change|push|update|mark)\b[^.?!]{0,30}?\b(?:stage|pipeline stage|to (?:offer|contract|closed|dead))\b/i },
  { code: 'OVERRIDE_COMPLIANCE', re: /\b(?:ignore|bypass|override|skip|disregard|remove|clear|lift|release)\b[^.?!]{0,30}?\b(?:stop|opt[- ]?outs?|unsubscribes?|dnc|do not contact|suppressions?|suppressed|holds?|exclusions?|quiet hours|compliance|guards?|consent)\b/i },
  { code: 'OVERRIDE_COMPLIANCE', re: /\b(?:even if|regardless of|despite)\b[^.?!]{0,30}?\b(?:stop|opt[- ]?out|suppress|hold|dnc)\w*\b/i },
  { code: 'REVIVE_EXCLUDED', re: /\b(?:maxwell|3746 baltimore)\b/i },
  { code: 'REVIVE_EXCLUDED', re: /\bhartford\b[^.?!]{0,40}?\b(?:revive|reopen|re-?open|contact|text|offer|follow)\b|\b(?:revive|reopen|contact|text|offer|follow)\b[^.?!]{0,40}?\bhartford\b/i },
])

// ── intents ─────────────────────────────────────────────────────────────────
const INTENT_RULES = Object.freeze({
  opportunity_triage: [
    /\b(?:most promising|best|top|highest[- ]potential|hottest|strongest|juiciest|most likely)\b[^.?!]{0,50}?\b(?:opportunit(?:y|ies)|deals?|leads?|propert(?:y|ies)|sellers?|prospects?)\b/i,
    /\btriage\b/i,
    /\b(?:find|surface|pick|identify|rank)\b[^.?!]{0,30}?\b\d+\b[^.?!]{0,30}?\b(?:opportunit(?:y|ies)|deals?|leads?|propert(?:y|ies))\b/i,
    /\bget (?:them|these|those|the (?:best|top) \w+) moving\b/i,
  ],
  market_diagnosis: [
    /\bwhy\b[^.?!]{0,40}?\b(?:aren'?t|are not|isn'?t|is not|not|no|so few|so little|low|slow|down|dry|zero|stopped)\b/i,
    /\b(?:diagnos[ei]s?|diagnose|what'?s wrong with|what is wrong with|underperform\w*|post[- ]mortem)\b/i,
  ],
  conversation_revival: [
    /\b(?:revive|re-?engage|re-?activate|unstick|wake up|rescue)\b[^.?!]{0,40}?\b(?:conversations?|threads?|sellers?|leads?)\b/i,
    /\b(?:stalled|stuck|dormant|dead|cold|silent|lost)\s+(?:seller\s+)?(?:conversations?|threads?)\b/i,
    /\bget\b[^.?!]{0,40}?\b(?:conversations?|threads?)\b[^.?!]{0,20}?\bmoving\b/i,
  ],
  offer_activity: [
    /\b(?:increase|more|grow|boost|raise|improve|lift)\b[^.?!]{0,30}?\b(?:profitable\s+)?offer (?:activity|volume|flow|rate|count)\b/i,
    /\b(?:increase|more|grow|boost|raise|improve)\b[^.?!]{0,20}?\b(?:profitable\s+)?offers\b/i,
    /\boffer[- ]ready\b/i,
  ],
  status_review: [
    /\b(?:status|where (?:are|do) we stand|where are we|what'?s (?:happening|going on|the latest)|what is (?:happening|going on)|update me|give me an update|progress|briefing|brief me|morning brief|how (?:are|is) (?:we|things|it|the \w+) (?:doing|going))\b/i,
    /^\s*(?:report|summary|status)\s*[.?!]?\s*$/i,
  ],
})

function extractCount(text) {
  const m = /\b(?:top|best|the|find|pick|surface|rank|identify|most promising)?\s*(\d{1,3})\b(?!\s*(?:days?|weeks?|hours?|%|k\b|percent))/i.exec(text)
  if (m) return Number(m[1])
  const w = new RegExp(String.raw`\b(${Object.keys(WORDS).join('|')})\b`, 'i').exec(text)
  return w ? WORDS[w[1].toLowerCase()] : null
}
function extractHorizon(text) {
  if (/\btoday\b|\btonight\b/i.test(text)) return 'today'
  if (/\bthis week\b/i.test(text)) return 'this_week'
  const m = /\b(\d{1,3})\s*days?\b/i.exec(text)
  if (m) return `${Math.min(Number(m[1]), 365)}d`
  if (/\bthis month\b/i.test(text)) return 'this_month'
  return null
}
function extractFocus(text) {
  const f = []
  if (/\bprobate|inherit|estate\b/i.test(text)) f.push('probate')
  if (/\bmulti-?family|duplex|triplex|fourplex|apartments?\b/i.test(text)) f.push('multifamily')
  if (/\bsingle[- ]family|sfr\b/i.test(text)) f.push('sfr')
  if (/\bvacant|land|lots?\b/i.test(text)) f.push('land')
  if (/\bhot\b/i.test(text)) f.push('hot')
  return f
}
function extractMarkets(text, known) {
  const out = []
  for (const m of known) {
    const re = new RegExp(String.raw`\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'i')
    if (re.test(text) && !out.includes(m)) out.push(m)
  }
  return out
}

/**
 * @param {string} directive
 * @param {{ markets?: string[] }} [o]
 * @returns {{ version, intent, actionable, markets, count, horizon, focus, refusal: null|{codes,message}, clarifying_question: string|null, matched: string[], source: 'deterministic' }}
 */
export function interpretDirective(directive, { markets: known = DEFAULT_KNOWN_MARKETS } = {}) {
  const text = String(directive ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
  const base = { version: INTERPRET_VERSION, source: 'deterministic', markets: [], count: null, horizon: null, focus: [], matched: [] }
  if (!text) return { ...base, intent: 'unknown', actionable: false, refusal: null, clarifying_question: CLARIFYING_QUESTION }
  const codes = [...new Set(REFUSALS.filter((r) => r.re.test(text)).map((r) => r.code))]
  if (codes.length) {
    return { ...base, intent: 'unknown', actionable: false, clarifying_question: null, refusal: { codes, message: refusalMessage(codes) } }
  }
  const matched = INTENTS.filter((i) => INTENT_RULES[i].some((re) => re.test(text)))
  // a status question that also names work is the work (e.g. "status: get the stalled conversations moving")
  const work = matched.filter((i) => i !== 'status_review')
  const chosen = work.length === 1 ? work[0] : work.length === 0 && matched.includes('status_review') ? 'status_review' : null
  const out = { ...base, markets: extractMarkets(text, known), count: extractCount(text), horizon: extractHorizon(text), focus: extractFocus(text), matched }
  if (!chosen) return { ...out, intent: 'unknown', actionable: false, refusal: null, clarifying_question: work.length > 1 ? `Do you want me to ${work.map(label).join(' or ')}? I will run one at a time.` : CLARIFYING_QUESTION }
  if (chosen === 'opportunity_triage' && out.count == null) out.count = null // the playbook applies its default N
  return { ...out, intent: chosen, actionable: ACTIONABLE_INTENTS.includes(chosen), refusal: null, clarifying_question: null }
}

export function label(intent) {
  return ({ opportunity_triage: 'find and move the most promising opportunities', market_diagnosis: 'diagnose the market', conversation_revival: 'revive stalled seller conversations', offer_activity: 'increase profitable offer activity', status_review: 'give a status review' })[intent] || intent
}

export function refusalMessage(codes = []) {
  const what = codes.map((c) => ({
    CONTACT_SELLERS: 'contact sellers', SEND_OFFERS: 'send or make offers', ACCEPT_OR_CONTRACT: 'accept, counter or sign anything', LAUNCH_CAMPAIGN: 'launch or resume campaigns',
    WRITE_STAGE: 'change pipeline stages', OVERRIDE_COMPLIANCE: 'override STOP, opt-outs, suppression or holds', REVIVE_EXCLUDED: 'touch an excluded or closed-lost property (Maxwell, Hartford)',
  })[c] || 'do that').filter((v, i, a) => a.indexOf(v) === i)
  return `I can't ${what.join(', ')}. The workforce has no path to do that in this phase, and STOP, suppression and holds are never overridden. I've flagged this for you: those actions stay with you in Inbox, Pipeline and Campaigns. I can find and rank the opportunities, check their conversations and economics, and queue the follow-up work for you instead.`
}

/**
 * The optional model choice (validated). Returns a deterministic-shaped result or null.
 * @param {{ text: string, deterministic: object, modelCall: (o: { system: string, messages: object[], max_tokens: number, purpose: string }) => Promise<{ text: string }>, parseJson: (t: string) => object|null }} o
 */
export async function modelChooseIntent({ text, deterministic, modelCall, parseJson }) {
  if (typeof modelCall !== 'function' || deterministic?.refusal || deterministic?.intent !== 'unknown') return null
  const system = `You classify a CEO directive for a real-estate acquisitions company into exactly one intent from this closed set: ${INTENTS.join(', ')}, or "unknown". Reply with JSON only: {"intent": "<one of the set or unknown>"}. Never invent an intent, never add steps.`
  const r = await modelCall({ system, messages: [{ role: 'user', content: String(text).slice(0, 1500) }], max_tokens: 60, purpose: 'default' })
  const v = parseJson(r?.text || '')
  const intent = v && typeof v.intent === 'string' ? v.intent.trim() : null
  if (!intent || !INTENTS.includes(intent)) return null
  return { ...deterministic, intent, actionable: ACTIONABLE_INTENTS.includes(intent), clarifying_question: null, source: 'model_choice' }
}
