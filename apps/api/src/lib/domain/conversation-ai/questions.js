// What did WE ask, and what has the SELLER already answered or deflected?
//
// Every prior outbound is mapped to a QUESTION KIND — first from its use case
// (send_queue.use_case_template / sms_templates.use_case: the authority), then,
// for manual / unknown sends, from its text. The kinds line up with the stage
// flow S1 ownership → S2 interest → S3 asking price → S4 condition → S5 offer.
//
// questionLedger() answers, per kind: asked_count, last_asked_at / message id,
// answered (a seller fact of that kind exists), deflected (the seller replied to
// that question without answering it — e.g. "What's your proposal?" after our
// asking-price question). A deflected asking-price question is NEVER re-asked.

export const QUESTION_KINDS = Object.freeze(['ownership', 'interest', 'asking_price', 'condition', 'occupancy', 'timeline', 'identity', 'offer', 'other', 'none'])

const USE_CASE_KIND = Object.freeze({
  ownership_check: 'ownership', late_reply_checkin: 'ownership', late_reply_confirm_ownership: 'ownership', late_reply_identity: 'ownership',
  consider_selling: 'interest', consider_selling_follow_up: 'interest', reengagement: 'interest', s2_no_response_fu1: 'interest', late_reply_owner_offer: 'interest',
  seller_asking_price: 'asking_price', asking_price_follow_up: 'asking_price', s3_no_response_fu1: 'asking_price',
  condition_probe: 'condition', ask_condition_clarifier: 'condition', price_high_condition_probe: 'condition', repair_clarification: 'condition',
  occupancy_probe: 'occupancy',
  who_is_this: 'identity', text_only_redirect: 'none', nurture_not_interested: 'none', future_nurture: 'none', expectation_reset: 'none',
})

const TEXT_RULES = [
  ['asking_price', /\b(?:what\s+(?:number|price|amount)|(?:a|any)\s+(?:number|price)\s+in\s+mind|how\s+much\s+(?:would|do|are)\s+you|asking\s+price|what\s+would\s+you\s+(?:take|want|need|accept)|cu[aá]nto\s+(?:pide|quiere)|precio)\b/i],
  ['condition', /\b(?:condition|repairs?|needs?\s+work|anything\s+that\s+needs|updates?|roof|hvac|how'?s\s+the\s+property|estado\s+de\s+la\s+propiedad|reparaciones)\b|(?<![\p{L}])(?:reparaci[oó]n(?:es)?|arreglos?|condici[oó]n|en\s+qu[eé]\s+estado|c[oó]mo\s+est[aá]\s+(?:la\s+casa|la\s+propiedad|el\s+techo|por\s+dentro)|necesita\s+(?:trabajo|arreglos|reparaciones|alguna\s+reparaci[oó]n))(?![\p{L}])/iu],
  ['occupancy', /\b(?:occupied|vacant|tenants?|rented|who\s+lives)\b/i],
  ['ownership', /\b(?:still\s+own|are\s+you\s+(?:still\s+)?the\s+owner|do\s+you\s+(?:also\s+)?own|owner\s+of|is\s+[^?]{1,60}?\s+(?:still\s+)?yours|correct\s+number\s+for\s+the\s+owner)\b|(?:todav[ií]a\s+es|es\s+usted|eres|sigue\s+siendo|sigues\s+siendo|usted\s+es)\s+(?:el\s+|la\s+)?(?:due[nñ][oa]|propietari[oa])|\bes\s+(?:tu|su)\s+propiedad|\b[eé]\s+(?:o|a)\s+propriet[aá]ri[oa]|\b(?:still\s+own|are\s+you\s+(?:currently\s+|still\s+)?the\s+(?:owner|homeowner|property\s+owner)|do\s+you\s+(?:currently\s+|still\s+|also\s+)?own|owner\s+of|is\s+(?:this|that|it|[0-9][^?]{0,60}?)\s+(?:still\s+)?(?:yours|your\s+(?:property|house|home))|did\s+i\s+reach\s+the\s+(?:owner|right\s+person)|is\s+this\s+the\s+right\s+(?:person|number)|are\s+you\s+the\s+right\s+person|todav[ií]a\s+es\s+(?:el|la)\s+due[nñ]o|es\s+usted\s+(?:el|la)\s+due[nñ]o)\b/i],
  // RC 8.5.15 (eval: "Would you ever consider selling…?" / "¿Estaría abierto a…?" read as 'other')
  // RC 8.5.20: ownership + interest are the union of the 8.5.15 and 8.5.16 eval patterns
  ['interest', /\b(?:would\s+you\s+(?:ever\s+|still\s+)?(?:consider|be\s+(?:open|interested|willing)|take\s+a\s+look|look\s+at|entertain|think\s+about)|(?:are|r)\s+you\s+(?:still\s+)?(?:open|interested|willing)\s+to|open\s+to\s+(?:an?\s+|any\s+|some\s+)?(?:(?:cash|as[-\s]is|fair|quick)\s+)?(?:offer|proposal|selling|sell|sale|discussing|talking)|interested\s+in\s+(?:selling|an?\s+(?:offer|proposal)|a\s+sale)|consider\s+(?:selling|an?\s+(?:(?:cash|fair)\s+)?(?:offer|proposal)|a\s+sale)|thought\s+(?:about|of)\s+selling|considerar[ií]a\s+(?:vender|una\s+(?:oferta|propuesta))|estar[ií]a\s+(?:abiert[oa]|dispuest[oa]|interesad[oa])|(?:le|te)\s+interesar[ií]a\s+(?:vender|una\s+(?:oferta|propuesta))|(?:quiere|quisiera|piensa|pensar[ií]a\s+en)\s+vender|abiert[oa]\s+a\s+(?:una\s+)?(?:oferta|propuesta|vender))|\b(?:would\s+you\s+(?:ever\s+|still\s+|maybe\s+)?(?:consider|be\s+open|be\s+interested|entertain|take\s+a\s+look|look\s+at|want\s+to\s+hear)|open\s+to\s+(?:selling|an?\s+(?:offer|proposal)|hearing)|interested\s+in\s+selling|(?:thinking|thought)\s+(?:about|of)\s+selling|ever\s+(?:thought|considered)\s+(?:about\s+)?selling|considerar[ií]a\s+vender|abierto\s+a\s+(?:considerar|recibir|vender))\b/i],
  ['timeline', /\b(?:timeline|how\s+soon|when\s+(?:would|are)\s+you\s+looking)\b/i],
  ['offer', /\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s?k?\b.*\?|\b(?:our|my)\s+offer\b/i],
]

// RC 8.5.20 review (c): audited against 30 days of real sent outbound (read-only, 2026-10-15:
// 6,924 ownership_check, 137 manual_reply, 110 consider_selling, 44 who_is_this, … rows).
// The broadened 8.5.15 + 8.5.16 interest union read three operator NEGOTIATION questions as
// an S2 interest ask: "Are you open to doing a JV?", "… would you be open to a lease
// option?", "If I can get close to a number that works for you, would you still consider
// it?". An interest ask is about SELLING (a sale, an offer / proposal, selling, the
// property); a question whose object is a deal structure or a price is not one, unless it
// also names selling / a sale / an offer / a proposal.
const NOT_A_SALE_INTEREST_RE = /\b(?:jv|joint\s+venture|partner(?:ship|ing)?|lease(?:\s+option)?|rent\s+to\s+own|owner\s+financ\w*|seller\s+financ\w*|financing|terms|package\s+deal|number|price|counter|meet\s+(?:me\s+)?in\s+the\s+middle|buy\s+more|wholesal\w*|assign\w*)\b|\$\s?[0-9]/i
const SALE_OBJECT_RE = /\b(?:sell(?:ing)?|sale|offer|proposal|propuesta|oferta|vender)\b/i
// Owner 2026-10-30 (blind v8 Z43, scripted run 17): "What has you thinking about selling?" asks the seller's REASON
// (motivation), not whether they would sell. Read as an interest ask, it was refused as "already answered" / backwards
// whenever the seller had already shown interest, which blocked the ordinary next question. A what/why question about
// the reason is not an S2 interest ask; "Have you thought about selling?" still is.
const MOTIVATION_QUESTION_RE = /^\s*(?:(?:so|and|ok(?:ay)?|got\s+it|thanks?)[\s,.!]+)?(?:what(?:'?s|\s+has|\s+have|\s+is|\s+made|\s+makes|\s+got)?|why(?:\s+are\s+you|\s+do\s+you|'?re\s+you)?)\b[^?]{0,40}?\b(?:thinking|thought|considering|wanting|want|looking|planning|ready)\s+(?:about|of|to|on)\s+sell/i
export function interestQuestionGuard(sentence) {
  const q = String(sentence || '')
  if (MOTIVATION_QUESTION_RE.test(q)) return false
  return !(NOT_A_SALE_INTEREST_RE.test(q) && !SALE_OBJECT_RE.test(q))
}

/** @returns {string} a QUESTION_KINDS member */
export function questionKindOf({ use_case = null, body = '' } = {}) {
  const uc = String(use_case || '').trim().toLowerCase()
  const byUseCase = uc ? USE_CASE_KIND[uc] : null
  const text = String(body || '')
  // a stage use case is the authority; an identity / no-question use case whose text
  // still asks something ("I'm a local investor… would you be open to an offer?") is
  // read from its text
  if (byUseCase && !(['identity', 'none'].includes(byUseCase) && /\?/.test(text))) return byUseCase
  if (!/\?/.test(text)) return 'none'
  // only the LAST question sentence counts ("Got it. How's the property?" → condition)
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.includes('?'))
  const q = sentences.length ? sentences[sentences.length - 1] : text
  for (const [kind, re] of TEXT_RULES) if (re.test(q) && (kind !== 'interest' || interestQuestionGuard(q))) return kind
  return 'other'
}

// a seller reply that turns the question back on us instead of answering it
const DEFLECT_TO_OFFER_RE = /\b(?:what(?:'?s|\s+is|\s+are|\s+would\s+be)?\s+(?:your|ur|the)\s+(?:offer|proposal|number|price|best)|make\s+(?:me\s+)?an?\s+offer|you\s+tell\s+me|send\s+(?:me\s+)?(?:your|an?|the)\s+(?:offer|proposal|number)|what\s+(?:would|will|can|could)\s+you\s+(?:offer|pay|give|do)|what\s+(?:are\s+you|r\s+u)\s+(?:thinking|offering)|how\s+much\s+(?:would|will|can|could|are)\s+you\s+(?:offer|pay|give|willing)|depends\s+on\s+(?:the|your)\s+(?:offer|price|number)|cu[aá]l\s+es\s+su\s+oferta|haga\s+una\s+oferta)\b/i
const DECLINE_PRICE_RE = /\b(?:not\s+sure\s+(?:yet|of\s+a\s+number)|no\s+idea|don'?t\s+(?:know|have\s+a\s+number)|market\s+value|fair\s+(?:market\s+)?(?:value|price)|whatever\s+it'?s\s+worth|what\s+it'?s\s+worth)\b/i

// rc-8.5.21 v4 (coverage): an offer request composed from its parts — a question word + YOU + a pay /
// offer verb ("what are you paying per door", "how much u offering", "whats the max u can do"), a
// request for OUR number ("ballpark?", "give me a number", "what's your best"), and the Spanish forms
// ("¿cuánto me ofrecen?", "¿qué ofrecen?", "hágame una oferta"). Never a question about anything else.
const OB = '(?<![\\p{L}\\p{N}])'; const OE = '(?![\\p{L}\\p{N}])'
const PAY = '(?:offer(?:ing)?|pay(?:ing)?|give|giving|thinking|willing\\s+to\\s+(?:pay|offer|give|go)|go(?:ing)?\\s+(?:for|to)|spend(?:ing)?)'
const OFFER_REQUEST_RE = new RegExp([
  `${OB}(?:what|wat|wht|how\\s+much|whats|what'?s|how\\s+much'?s)\\s+(?:\\p{L}+\\s+){0,3}?(?:would|will|can|could|are|r|do|did|ya|u'?d|you'?d)?\\s*(?:you|u|y'?all|ya|you\\s+guys|your\\s+(?:company|team))\\s+(?:\\p{L}+\\s+){0,2}?${PAY}${OE}`,
  `${OB}(?:what'?s|whats|what\\s+is|what\\s+would\\s+be)\\s+(?:the\\s+)?(?:max|most|highest|top|best|least)\\s+(?:(?:price|number|offer|amount|dollar)\\s+)?(?:you|u|y'?all)\\s+(?:can|could|would|will|'d)\\s+(?:do|pay|offer|give|go)`,
  `${OB}(?:max|most|best|highest|top)\\s+(?:you|u)\\s+(?:can|could|would|will)\\s+(?:do|pay|offer|give)`,
  `${OB}(?:give|send|throw|shoot|text)\\s+(?:me|us)\\s+(?:out\\s+)?(?:a|an|your|ur|the|some)\\s+(?:number|price|offer|ballpark|figure|quote)${OE}`,
  `${OB}(?:what'?s|whats|what\\s+is|got)\\s+(?:your|ur|a|the)\\s+(?:ballpark|best\\s+(?:offer|price|number)|cash\\s+(?:offer|price)|number|offer|figure|quote)${OE}`,
  `^\\s*(?:a\\s+|any\\s+|rough\\s+|ur\\s+|your\\s+)?(?:ballpark|ball\\s+park|number|offer|price|figure|quote)(?:\\s+(?:figure|number|offer|please|pls))?\\s*\\?+\\s*$`,
  `${OB}per\\s+(?:door|unit)\\s*\\?`,
  `${OB}(?:cu[aá]nto|qu[eé])\\s+(?:me\\s+|nos\\s+|le\\s+)?(?:ofrece|ofrecen|ofrecer[ií]a|ofrecer[ií]an|paga|pagan|pagar[ií]a|pagar[ií]an|da|dan|dar[ií]a|dar[ií]an|dan\\s+por)${OE}`,
  `${OB}(?:cu[aá]l\\s+(?:es|ser[ií]a)\\s+(?:su|tu)\\s+(?:oferta|precio|propuesta)|h[aá]g(?:a|an|ame|anme)\\s+(?:me\\s+)?una\\s+oferta|m[aá]nd(?:e|en|eme|enme)\\s+(?:me\\s+)?una\\s+oferta|en\\s+cu[aá]nto\\s+(?:la|lo)\\s+(?:compran|comprar[ií]an|comprar[ií]a))${OE}`,
].join('|'), 'iu')

export function isDeflectionToOffer(text) {
  const t = String(text || '')
  return DEFLECT_TO_OFFER_RE.test(t) || OFFER_REQUEST_RE.test(t)
}
export function isPriceNonAnswer(text) {
  return DECLINE_PRICE_RE.test(String(text || ''))
}

/**
 * @param {Array<{ id: string, direction: 'inbound'|'outbound', body: string, at: string, use_case?: string|null }>} messages chronological
 * @param {Record<string, { current: any, history: any[] }>} facts the fact ledger (facts.js)
 */
export function questionLedger(messages = [], facts = {}) {
  const out = {}
  for (const k of QUESTION_KINDS) out[k] = { kind: k, asked_count: 0, asked_message_ids: [], last_asked_at: null, answered: false, deflected: false, deflection_message_ids: [] }
  let lastQuestionKind = null
  for (const m of messages) {
    if (m.direction === 'outbound') {
      const kind = questionKindOf(m)
      if (kind !== 'none') {
        const q = out[kind]
        q.asked_count += 1
        q.asked_message_ids.push(m.id)
        q.last_asked_at = m.at
        lastQuestionKind = kind
      }
    } else if (m.direction === 'inbound' && lastQuestionKind === 'asking_price') {
      if (isDeflectionToOffer(m.body) || isPriceNonAnswer(m.body)) {
        out.asking_price.deflected = true
        out.asking_price.deflection_message_ids.push(m.id)
      }
    }
  }
  const FACT_FOR = { ownership: 'ownership', asking_price: 'asking_price', condition: 'condition', occupancy: 'occupancy', timeline: 'timeline', interest: 'seller_interest' }
  for (const [kind, factKey] of Object.entries(FACT_FOR)) if (facts[factKey]?.current != null) out[kind].answered = true
  return out
}

/** The kinds the next message must NOT ask about. */
export function blockedQuestionKinds(ledger) {
  const blocked = new Set()
  for (const q of Object.values(ledger)) {
    if (q.answered) blocked.add(q.kind)
    if (q.kind === 'asking_price' && (q.deflected || q.asked_count >= 2)) blocked.add('asking_price')
    if (q.asked_count >= 2 && !['other', 'none'].includes(q.kind)) blocked.add(q.kind)
  }
  return blocked
}
