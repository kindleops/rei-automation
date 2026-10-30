// CANONICAL FACT + QUESTION LEDGER (8.5.16) — pure, derived, no writes.
//
// One read model per thread, built only from real events:
//   messages      message_events rows (inbound + outbound), chronological, each with
//                 its id; an outbound may carry its send_queue use case
//   queueRows     send_queue rows for the thread (use_case_template + status): a
//                 question that is queued / processing / sent is ASKED even before
//                 a message_events row exists for it
//   offers        authoritative offer rows (seller_offers …) — never inferred
//   modelFacts    VALIDATED conv-ai facts_extracted (each cites a seller message id)
//   recordFacts   LeadCommand record facts (property identity, units …)
//
// It tracks, each with its source message ids: ownership / representative status,
// property identity, interest, asking price, condition, offer requests, existing
// offers, requests (identity, callback, property identity) and objections; per
// question kind: asked (count + ids, incl. queued rows), answered (+ by which
// message), deflected; follow-up eligibility; and an evidence-based stage.
//
// Rules the owner fixed (stage flow S1 ownership → S2 interest → S3 asking price
// → S4 condition → S5 offer):
//   - one seller message can answer several facts ("I'd sell for $175K but the
//     roof needs work" = interest + asking price + condition; none is re-asked)
//   - "What's your offer?" is an OFFER REQUEST: interest is shown, NO asking price
//     is inferred and no amount is ever produced here
//   - an asking-price question is never repeated (asked once ⇒ blocked), and a
//     seller deflection of it is never answered with the same question
//
// validateProposedMessage() is the validation API: given a proposed message (or a
// question kind) it rejects a question about a fact already answered or already
// asked, a backwards question, a skipped stage, and any offer/money question.
import { buildFactLedger, mergeModelFacts } from './facts.js'
import { isDeflectionToOffer, isPriceNonAnswer, questionKindOf } from './questions.js'
import { isStopRequest } from './stop-request.js'
import { bareNoAnswer } from './answers.js'
import { sellerTimelineMentions, resolveTimeReference } from './time-references.js'

export const FACT_LEDGER_VERSION = 'conv-ai.fact-ledger.v1'

export const STAGE_KINDS = Object.freeze(['ownership', 'interest', 'asking_price', 'condition'])
const STAGE_NAME = Object.freeze({ ownership: 'S1_ownership', interest: 'S2_interest', asking_price: 'S3_asking_price', condition: 'S4_condition' })
const LEDGER_QUESTION_KINDS = Object.freeze(['ownership', 'interest', 'asking_price', 'condition', 'occupancy', 'timeline', 'identity', 'offer'])

// a queued / in-flight / sent question has been asked; a cancelled / failed / held one has not
const ASKED_QUEUE_STATUSES = new Set(['queued', 'scheduled', 'pending', 'approval', 'processing', 'sending', 'sent', 'delivered'])

// AI rows carry an "ai_" prefixed use case (ai_seller_asking_price …); the kind is the template's
function useCaseForKind(useCase) {
  const uc = String(useCase || '').trim().toLowerCase()
  return uc.startsWith('ai_') ? uc.slice(3) : uc
}

// ── seller-text evidence (deterministic; each rule names what it proves) ─────
export const OWN_CONFIRM_RE = /\b(?:i\s+(?:still\s+)?own\s+(?:it|the|that|this)|(?:yes|yeah|yep),?\s+(?:i|we)\s+(?:still\s+)?(?:own|do)|(?:i'?m|i\s+am)\s+the\s+(?:owner|homeowner)|we\s+(?:still\s+)?own\s+(?:it|the|that)|that'?s\s+(?:me|mine|my\s+(?:house|property|home))|(?:that|this)\s+one(?:'?s|\s+is)\s+mine|(?:it|that)\s+is\s+mine|it'?s\s+mine|(?:yes|yeah|yep),?\s+(?:it'?s|that'?s|is)\s+(?:mine|ours)|(?:todav[ií]a\s+|a[uú]n\s+)?es\s+m[ií]a|sigue\s+siendo\s+m[ií]a|soy\s+(?:el|la)\s+(?:due[nñ][oa]|propietari[oa]))(?![\p{L}])/iu
// rc-8.5.21 v4 (coverage): ANSWER forms to OUR ownership question that confirm ownership without the
// words "I own" — co-ownership ("me and my brother", "my wife and I"), an entity ("it's in my LLC but
// yeah", "under my trust"), "we do", Spanish "sí, todavía la tengo" — and the bare former-owner answer
// ("used to", "not anymore"). Read ONLY against our ownership question (never a free-standing claim).
const ANS_YES = "(?:(?:yes|yeah|yep|yup|ya|sure|correct|s[ií])[\\s,.!]*)?"
export const OWN_ANSWER_CONFIRM_RE = new RegExp([
  `^\\s*${ANS_YES}(?:it'?s|its|it\\s+is|that'?s|the\\s+(?:title|deed|house|property)\\s+is|title'?s)?\\s*(?:in|under|through|owned\\s+by|held\\s+by|held\\s+in)\\s+(?:my|our|the\\s+family|a|the)\\s+(?:\\p{L}+\\s+)?(?:llc|l\\.l\\.c\\.?|trust|company|corporation|corp|inc|business|entity|name|names|family\\s+trust)(?:\\s+(?:but\\s+)?(?:yeah|yes|yep|i\\s+do|we\\s+do|it'?s\\s+mine))?\\s*[.!]*\\s*$`,
  `^\\s*${ANS_YES}(?:me|myself)\\s+(?:and|&|n)\\s+(?:my|our)\\s+\\p{L}+(?:\\s+\\p{L}+)?(?:\\s+(?:do|own\\s+it|both))?\\s*[.!]*\\s*$`,
  `^\\s*${ANS_YES}(?:my|our)\\s+\\p{L}+(?:\\s+\\p{L}+)?\\s+(?:and|&|n)\\s+(?:i|me|myself)(?:\\s+(?:do|own\\s+it|both\\s+do|still\\s+do))?\\s*[.!]*\\s*$`,
  `^\\s*${ANS_YES}(?:we|we\\s+both|both\\s+of\\s+us|i|i\\s+still|we\\s+still)\\s+(?:still\\s+)?do(?:\\s+(?:own\\s+it|lol|yes))?\\s*[.!]*\\s*$`,
  `^\\s*${ANS_YES}(?:todav[ií]a\\s+|a[uú]n\\s+)?(?:la|lo)\\s+tengo(?:\\s+todav[ií]a)?(?![\\p{L}])`,
  `^\\s*${ANS_YES}(?:es\\s+(?:de|a\\s+nombre\\s+de)\\s+(?:mi|nuestra|nuestro)\\s+(?:familia|compa[nñ][ií]a|empresa|llc|fideicomiso)|mi\\s+\\p{L}+\\s+y\\s+yo|yo\\s+y\\s+mi\\s+\\p{L}+)(?![\\p{L}])`,
].join('|'), 'iu')
// Owner 2026-10-30 (blind v8 Z15, Z30): the casual "still" answers to OUR ownership question ("Yes still mine",
// "Still own it. Got renters in there", "yep still ours", "still have it") as the message's OPENING clause. Read ONLY
// against our ownership question, and recorded as the seller's CLAIM (origin seller_claim_*), never as verified
// ownership: verification stays with the owner-of-record match. A question back ("still mine?") is not an answer.
export const OWN_ANSWER_STILL_RE = /^\s*(?:(?:yes|yeah|yep|yup|ya|yea|yess|sure|correct|uh\s+huh)[\s,.!]*)?(?:(?:it'?s|its|it\s+is|that'?s|thats|i|we|i'?ve|we'?ve)\s+)?still\s+(?:mine|ours|my\s+(?:house|home|place|property)|our\s+(?:house|home|place|property)|own\s+(?:it|that|this|the\s+(?:house|home|place|property))|have\s+it|got\s+it|owns?\s+it)\b(?!\s*\?)(?=\s*(?:$|[.,!;:)\-]|\s(?:but|and|though|tho|why|lol|haha|yes|yeah)\b))|^\s*(?:(?:yes|yeah|yep|yup|ya|yea)[\s,.!]*)?(?:that'?s|thats)\s+(?:us|me)\b(?!\s*\?)|^\s*(?:(?:yes|yeah|yep|yup|ya|yea)[\s,.!]*)?(?:it'?s|its|it\s+is)\s+ours\b(?!\s*\?)/i
export const OWN_ANSWER_FORMER_RE = /^\s*(?:i\s+|we\s+)?used\s+to(?:\s+(?:own\s+it|but\s+not\s+any\s*more|lol))?\s*[.!]*\s*$|^\s*(?:not\s+any\s*more|no\s+longer|not\s+no\s+more|ya\s+no)\s*[.!]*\s*$/i
export const OWN_DENY_RE = /\b(?:wrong\s+(?:number|person)|(?:not|never)\s+(?:the|my)\s+(?:owner|house|home|property)|(?:i|we)\s+(?:don'?t|dont|do\s+not|never)\s+own(?:ed)?|you\s+have\s+the\s+wrong|(?:that'?s\s+|it'?s\s+|that\s+is\s+|it\s+is\s+)?(?:not|isn'?t|aint|ain'?t)\s+(?:mine|ours)\b(?!\s+any\s*more))\b/i
export const OWN_FORMER_RE = /\b(?:(?:i|we)\s+(?:already\s+|just\s+)?sold\s+(?:it|that|the|this)|^\s*(?:already\s+)?sold\b|\b(?:it|house|home|property)\s+(?:was|has\s+been|got)\s+sold|no\s+longer\s+(?:own|have)\s+(?:it|that|the)|not\s+(?:mine|ours)\s+anymore|gave\s+(?:the|my|that|this)\s+(?:house|home|property|place)\s+to|(?:it|the\s+house|the\s+home|the\s+property)\s+(?:is|belongs\s+to)\s+my\s+(?:son|daughter|kids?|children|brother|sister|mom|dad|mother|father)(?:'s)?\b|(?:signed|deeded|transferred)\s+(?:it|the\s+(?:house|home|property))\s+(?:over\s+)?to|ya\s+la\s+vend\w*|ya\s+no\s+es\s+m[ií]a)/im
const REPRESENTATIVE_RE = /\b(?:i'?m\s+(?:his|her|their|the)\s+(?:son|daughter|wife|husband|spouse|executor|executrix|agent|realtor|attorney|brother|sister|grandson|granddaughter|niece|nephew|caretaker|property\s+manager)|power\s+of\s+attorney|\bpoa\b|on\s+behalf\s+of|executor\s+of|my\s+(?:mom|dad|mother|father|parents|grandma|grandmother|grandpa|grandfather)'?s?\s+(?:house|home|property|place))\b/i
export const NOT_INTERESTED_RE = /\b(?:not\s+interested|no\s+thanks?|no\s+thank\s+you|not\s+(?:selling|for\s+sale)|(?:don'?t|do\s+not)\s+want\s+to\s+sell|not\s+looking\s+to\s+sell|never\s+selling)\b/i
export const BARE_YES_RE = /^\s*(?:yes|yeah|yep|yup|sure|correct|i\s+do|ok(?:ay)?|si|sí)\s*[.!]*\s*$/i
const BARE_MAYBE_RE = /^\s*(?:maybe|possibly|perhaps|depends|it\s+depends|could\s+be|might\s+be|not\s+sure)\s*[.!?]*\s*$/i
const CONDITION_RE = /\b(?:roof|hvac|a\/?c\b|furnace|foundation|plumbing|electrical|needs?\s+(?:some\s+|a\s+lot\s+of\s+)?(?:work|repairs?|updating|tlc)|repairs?|fixer(?:[\s-]upper)?|(?:good|great|fair|rough|bad|poor|decent|excellent)\s+(?:shape|condition)|move[\s-]?in\s+ready|(?:fully\s+)?(?:updated|remodeled|renovated)|as[\s-]is|turnkey)\b/i
const TIMELINE_RE = /\b(?:close|closing|sell|selling|move|moving|be\s+out|out|done|wrap\s+(?:it\s+)?up)\s+(?:by|before|in|within|after|around|at)\s+(?:the\s+)?(?:end\s+of\s+|beginning\s+of\s+|mid[\s-]?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter|christmas|thanksgiving|the\s+holidays|(?:this|next)\s+(?:week|month|year|spring|summer|fall|winter)|[0-9]+\s+(?:days?|weeks?|months?)|a\s+(?:week|month|few\s+(?:weeks|months)))\b|\b(?:asap|as\s+soon\s+as\s+possible|no\s+rush|whenever)\b/i
const WHO_IS_THIS_RE = /\b(?:who\s+(?:is|'?s)\s+(?:this|it)|who\s+are\s+(?:you|u)|whos\s+this|who\s+(?:is|are)\s+(?:you|this)\s+with|how\s+did\s+you\s+get\s+my\s+(?:number|info|information)|what\s+company|why\s+do\s+you\s+(?:ask|want|need|care)|why\s+(?:are\s+you|r\s+u)\s+(?:asking|texting|contacting)|what\s+(?:can\s+i\s+do\s+for\s+you|do\s+you\s+want|is\s+this\s+(?:about|regarding|for)|'?s\s+this\s+(?:about|regarding|for))|whats\s+this\s+about)\b|^\s*(?:why|why\s+\?|why\s+do\s+you\s+ask|wym|what\s+for)\s*[?!.]*\s*$/i
const CALLBACK_RE = /\b(?:call\s+me|give\s+me\s+a\s+call|can\s+(?:you|u)\s+call|rather\s+talk\s+on\s+the\s+phone)\b/i
// rc-8.5.21 v4 (coverage): identity / callback / visit requests composed from their parts (who + is/are +
// this/you, how + did/do + you + get/find + my + number/info, what's + your + name, did/have + we + met,
// do I know you; the Spanish forms) — unicode word edges, so "¿Quién habla?" is read too. Each is a
// request a person-safe template answers (identity) or an OPERATOR TASK (callback / visit).
const UB = '(?<![\\p{L}\\p{N}])'; const UE = '(?![\\p{L}\\p{N}])'
const YOU = "(?:you|u|ya|y'?all|you\\s+guys|ur\\s+company|they)"
export const IDENTITY_REQUEST_RE = new RegExp([
  `${UB}who\\s+(?:is|'?s|r|are)\\s+(?:this|it|that|you|u)(?:\\s+(?:texting|messaging|writing|again|exactly|with))?${UE}`,
  `${UB}who\\s+(?:wants|needs)\\s+to\\s+know${UE}`, `${UB}who\\s+(?:am\\s+i|is\\s+this)\\s+(?:talking|speaking|texting|chatting)\\s+(?:to|with)${UE}`, `${UB}who\\s+sent\\s+(?:this|that|me\\s+this)${UE}`,
  `${UB}(?:what'?s|whats|what\\s+is|wat'?s|and)\\s+(?:your|ur|yo)\\s+name${UE}`, `${UB}(?:may|can|could)\\s+i\\s+(?:ask|get|have|know)\\s+(?:your|ur|who)\\b`, `${UB}(?:your|ur)\\s+name\\s*\\?`, `${UB}and\\s+you\\s+are\\s*\\?`,
  `${UB}(?:how|where)\\s+(?:did|do|'?d|would|could|does)\\s+${YOU}\\s+(?:even\\s+|ever\\s+|actually\\s+|guys\\s+)?(?:get|got|find|found|obtain|pull|come\\s+across|have)\\s+(?:my|this|me|our)\\s*(?:number|#|info|information|contact|cell|phone|name|details|address)?`,
  `${UB}where\\s+(?:did|do)\\s+${YOU}\\s+get\\s+(?:my|this|that)${UE}`,
  `${UB}(?:did|have|do)\\s+(?:we|i)\\s+(?:ever\\s+|already\\s+)?(?:meet|met|talk(?:ed)?|speak|spoke(?:n)?|know\\s+(?:you|u|each\\s+other))${UE}`, `${UB}do\\s+i\\s+know\\s+(?:you|u)${UE}`, `${UB}have\\s+we\\s+met${UE}`,
  `${UB}qui[eé]n\\s+(?:habla|es|eres|me\\s+escribe|me\\s+est[aá]\\s+escribiendo|es\\s+usted|son\\s+ustedes)${UE}`, `${UB}con\\s+qui[eé]n\\s+(?:hablo|tengo\\s+el\\s+gusto)${UE}`,
  `${UB}c[oó]mo\\s+(?:consigui[oó]|consiguieron|obtuvo|obtuvieron|tiene|tienen|sac[oó]|sacaron)\\s+(?:mi|este)\\s+(?:n[uú]mero|tel[eé]fono|cel)`, `${UB}de\\s+d[oó]nde\\s+(?:sac[oó]|sacaron|tiene|tienen)\\s+mi\\s+(?:n[uú]mero|tel[eé]fono|informaci[oó]n)`,
  `${UB}por\\s+qu[eé]\\s+(?:pregunta|preguntas|preguntan|quiere\\s+saber|quieren\\s+saber)${UE}`, `${UB}(?:cu[aá]l\\s+es\\s+su\\s+nombre|c[oó]mo\\s+se\\s+llama(?:\\s+usted)?|nos\\s+conocemos)${UE}`,
].join('|'), 'iu')
const NEG_BEFORE = "(?<!(?:don'?t|dont|do\\s+not|never|no|not|stop|quit|wag|huwag|'wag)\\s+(?:\\p{L}+\\s+){0,2})"
export const CALLBACK_REQUEST_RE = new RegExp([
  `${UB}${NEG_BEFORE}(?:call|phone|ring)\\s+(?:me|us)(?:\\s+(?:back|instead|please|plz|later|tomorrow|tonight|asap|at|on|when))?${UE}`,
  `${UB}(?:give|gimme)\\s+(?:me|us)\\s+a\\s+(?:call|ring|buzz)${UE}`,
  `${UB}(?:can|could|would|will|pls|please)\\s+(?:you|u|someone|somebody|anyone|one\\s+of\\s+you)\\s+(?:please\\s+)?(?:just\\s+)?(?:call|phone|ring)${UE}`,
  `${UB}(?:rather|prefer\\s+to|better\\s+to|easier\\s+to|want\\s+to|like\\s+to)\\s+(?:talk|speak|chat)\\s+(?:on|by|over)\\s+the\\s+phone${UE}`, `${UB}(?:prefer|want|need)\\s+a\\s+(?:phone\\s+)?call${UE}`, `${UB}can\\s+we\\s+(?:talk|speak)\\s+(?:on\\s+the\\s+phone|by\\s+phone)${UE}`,
  `${UB}(?:ll[aá]m(?:a|e|en)me|ll[aá]m(?:e|en)nos|m[aá]rqu(?:e|en)me|m[aá]rcame)${UE}`, `${UB}(?:me|nos)\\s+(?:puede|pueden|podr[ií]a|podr[ií]an)\\s+(?:llamar|marcar)${UE}`, `${UB}prefiero\\s+(?:hablar\\s+por\\s+tel[eé]fono|una\\s+llamada|que\\s+me\\s+llamen)${UE}`,
  `${UB}${NEG_BEFORE}(?:tawag(?:an|in)|i-?call|call)\\s+(?:mo|nyo|niyo|ninyo|na\\s+lang|nalang|lang|po|na)?\\s*(?:(?:mo|nyo|niyo|ninyo|na\\s+lang|nalang|lang|po|na)\\s+)*(?:ako|ko|kami)${UE}`, `${UB}pa-?(?:call|tawag)${UE}`,
  `${UB}(?:me\\s+lig(?:a|ue|uem)|pode(?:m)?\\s+me\\s+ligar|appel(?:ez|le)[- ]moi|pouvez[- ]vous\\s+m'appeler|chiamami|mi\\s+chiami|zadzwo[nń]\\s+do\\s+mnie|rele\\s+(?:m|mwen)(?:\\s+(?:tanpri|souple))?)${UE}`,
  `(?:gọi\\s+(?:cho|điện\\s+cho)\\s+(?:tôi|em|anh|chị)|전화\\s*(?:해\\s*)?주세요|打(?:电话|電話)?(?:给|給|俾)我|اتصل\\s+بي|позвоните\\s+мне)`,
].join('|'), 'iu')
export const VISIT_REQUEST_EXT_RE = new RegExp([
  `${UB}(?:come|stop|swing|drop|pop)\\s+(?:by|over|out)\\s+(?:on\\s+)?(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|tomorrow|today|tonight|this\\s+\\p{L}+|next\\s+\\p{L}+|any\\s*time|whenever)`,
  `${UB}(?:come|stop|swing|drop)\\s+(?:by\\s+|over\\s+)?(?:and\\s+)?(?:take\\s+a\\s+look|see\\s+(?:it|the\\s+(?:house|place|property))|look\\s+at\\s+it|check\\s+it\\s+out)${UE}`,
  `${UB}(?:you\\s+can|feel\\s+free\\s+to|welcome\\s+to)\\s+(?:come|stop|swing)\\s+(?:by|over|see|look)${UE}`,
  `${UB}(?:venga|vengan|pase|pasen|puede\\s+venir|pueden\\s+venir)\\s+(?:a\\s+ver(?:la|lo)?|el\\s+\\p{L}+|cuando\\s+quiera)`,
].join('|'), 'iu')
const WANTS_TO_SELL_RE = /\b(?:(?:want|need|ready|looking|trying|wanna|gotta|have|got)\s+(?:to\s+)?(?:sell|get\s+rid\s+of|unload|offload|be\s+done\s+with|move\s+on\s+from)|want\s+(?:it|this|the\s+(?:house|place|property))\s+(?:gone|sold|off\s+my\s+hands)|(?:i'?d|i\s+would|i\s+might|we'?d|we\s+would)\s+(?:sell|consider\s+selling|be\s+open\s+to\s+selling)|open\s+to\s+(?:selling|an?\s+offer|offers))\b|(?<![\p{L}])(?:quiero\s+vender(?:la|lo)?|(?:la|lo)\s+quiero\s+vender|s[ií]\s+(?:la|lo)\s+vendo|me\s+interesa\s+vender(?:la|lo)?|quiero\s+salir\s+de\s+(?:esa|la|esta|mi)\s+(?:casa|propiedad))(?![\p{L}])/iu
const WHICH_PROPERTY_RE = /\b(?:which\s+(?:property|house|one|address)|what\s+(?:property|address|house))\b/i
const OBJECTION_RE = /\b(?:too\s+low|lowball|low\s*ball|scam|worth\s+(?:a\s+lot\s+)?more|not\s+(?:that|so)\s+cheap|insult(?:ing)?)\b/i
const NEED_TIME_RE = /\b(?:let\s+me\s+think|need\s+(?:some\s+)?time|not\s+right\s+now|maybe\s+later|in\s+a\s+few\s+(?:months|weeks)|next\s+year|not\s+ready)\b/i

// rc-8.5.21 (Phase 3A) mixed intent: a denial / "sold" claim the SAME message takes back
// ("Sold.. just joking", "lol no I still own it") is a retraction, never a terminal ownership fact
export const RETRACTION_RE = /\b(?:j\/?k|jk|just\s+(?:joking|kidding|playing|messing)|(?:i'?m\s+)?(?:only\s+)?kidding|not\s+really|no\s+i\s+(?:still\s+)?(?:own|have)\s+it|psych)\b/i
// rc-8.5.21 (Phase 3C): "Not if it involves creative financing" is CONDITIONAL interest with a
// terms objection (cash / conventional purchase only), never "not interested"
export const FINANCING_OBJECTION_RE = /\b(?:not\s+if|(?:only\s+)?if\s+it\s+(?:does\s*n[o']?t|doesn'?t|won'?t|will\s+not|isn'?t|is\s+not)\s+(?:involve|include|require|mean|use)|(?:only\s+)?(?:if|when)\s+(?:it'?s|it\s+is|there'?s|there\s+is)\s+(?:not|no)|no\s+(?:to\s+)?|without|unless\s+(?:it'?s\s+)?(?:not\s+)?|as\s+long\s+as\s+(?:it'?s\s+|it\s+is\s+|there'?s\s+|there\s+is\s+)?(?:no|not)|(?:don'?t|do\s+not|won'?t|will\s+not)\s+(?:want|do|accept|take|consider)|not\s+(?:interested\s+in|doing|open\s+to))\b[^.?!]{0,40}?\b(?:creative\s+financ\w*|owner\s+financ\w*|seller\s+financ\w*|subject[\s-]?to|lease\s+option|rent[\s-]to[\s-]own|land\s+contract|payments?\s+over\s+time|(?:monthly|installment)\s+payments|terms\b|wrap(?:around)?)/i
// "U could email me … your business card" — a request only a person can fulfil
export const EMAIL_OR_CARD_REQUEST_RE = /\b(?:e-?mail\s+me|send\s+(?:me\s+)?(?:an?\s+|your\s+|ur\s+)?(?:e-?mail|card|business\s+card|info(?:rmation)?|details|website|link|paperwork)|(?:your|ur)\s+business\s+card|cc\s+of\s+(?:your|ur)|what'?s\s+(?:your|ur)\s+(?:e-?mail|website)|do\s+(?:you|u)\s+have\s+a\s+(?:website|card))\b/i
// "I will contact you when I want to sell" — not now: the 30-day follow-up (owner rule)
export const DEFERS_CONTACT_RE = /\b(?:i'?ll|i\s+will|we'?ll|we\s+will)\s+(?:contact|call|text|reach\s+out\s+to|get\s+(?:back\s+)?(?:to|with)|let)\s+(?:you|u)(?:\s+know)?\s+(?:when|if|once|whenever)\b/i
// "Which company are you with?" — answered only from the configured identity, else a person
export const COMPANY_QUESTION_RE = /\b(?:(?:what|which)\s+(?:company|outfit|firm|organi[sz]ation|business)|who\s+(?:are\s+(?:you|u)|r\s+u)\s+with|(?<!(?:my|our|his|her|their|family)\s+)company\s+(?:name|are\s+(?:you|u)|r\s+u)|(?:who|what)\s+do\s+(?:you|u)\s+(?:work\s+for|represent)|(?:your|ur)\s+(?:company|website|business\s+name)|(?:are|r)\s+(?:you|u)\s+(?:with\s+)?a\s+company|what'?s\s+the\s+(?:company|website))\b/i
export const VISIT_REQUEST_RE = /\b(?:(?:can|could|would|will)\s+(?:you|u|someone|somebody)\s+(?:stop|come|swing|drop)\s+(?:by|over|out)|(?:stop|come|swing|drop)\s+by\s+(?:on|at|this|next|tomorrow|today|mon|tue|wed|thu|fri|sat|sun)|come\s+(?:see|look\s+at|take\s+a\s+look\s+at)\s+(?:it|the\s+(?:house|place|property))|walk[\s-]?through|(?:schedule|set\s+up)\s+(?:a\s+)?(?:visit|showing|walkthrough|time\s+to\s+(?:see|look))|meet\s+(?:me|us)\s+(?:at|there))\b/i
export const AUTOMATION_QUESTION_RE = /\b(?:(?:are|r)\s+(?:you|u|this)\s+(?:a\s+)?(?:bot|robot|real\s+(?:person|human)|real(?!\s+estate)|human|person|automated|ai\b|machine|computer)|is\s+(?:this|it|that)\s+(?:a\s+|an\s+)?(?:bot|robot|automated|real\s+person|human|ai\b|computer|machine|recording|auto(?:mated)?\s*(?:text|message|reply))|am\s+i\s+(?:talking|texting|chatting)\s+(?:to|with)\s+(?:a\s+|an\s+)?(?:bot|robot|real\s+person|human|person|ai\b|machine|computer)|(?:bot|robot|automated|ai)\s*\?|(?:eres|es\s+(?:esto|usted|este|un)|hablo\s+con|estoy\s+hablando\s+con)\s+(?:un\s+|una\s+)?(?:robot|bot|m[áa]quina|persona\s+real|humano|ia\b|inteligencia\s+artificial|autom[áa]tic[oa]|contestador))/i
// an amount WE quoted in an outbound (a live negotiation even without an offer record)
const OUR_AMOUNT_RE = /\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:k|m)?\b|\b[0-9]{2,3}(?:,[0-9]{3})+\b|\b[0-9]{2,3}\s?k\b/i

const OWNERSHIP_INTENTS = Object.freeze({
  ownership_confirmed: 'confirmed', wrong_number: 'denied', not_owner: 'denied', ownership_denied: 'denied',
  property_specific_non_owner: 'denied', former_owner_respondent: 'former_owner', ownership_declined_unverified: 'declined_unverified',
})
const REPRESENTATIVE_INTENTS = new Set(['executor_heir_respondent', 'family_member_respondent', 'agent_representative_respondent', 'non_owner_referral'])
const INTEREST_INTENTS = Object.freeze({ not_interested: 'not_interested', seller_interested: 'interested', interested: 'interested', latent_interest: 'conditional', conditional_interest: 'conditional' })

// stated = the seller said it; inferred = we concluded it (a price implies interest).
// Inferred is never treated as confirmed by a reply ("you said you're interested").
export function factBasis(origin) {
  return /implies|inferred/.test(String(origin || '')) ? 'inferred' : 'stated'
}

function addFact(facts, key, value, msg, origin = 'seller_stated', confidence = null) {
  const slot = (facts[key] ||= { value: null, source_message_ids: [], history: [], origin: null, basis: null, confidence: null })
  const basis = factBasis(origin)
  slot.history.push({ value, source_message_id: msg.id, at: msg.at || null, origin, basis, confidence: confidence ?? (basis === 'inferred' ? 0.6 : 0.8) })
  // latest seller statement wins (a correction supersedes; history keeps provenance)
  slot.value = value
  slot.origin = origin
  if (!slot.source_message_ids.includes(msg.id)) slot.source_message_ids.push(msg.id)
}

function pushUnique(arr, item) { if (!arr.includes(item)) arr.push(item) }

/**
 * @param {object} a
 * @param {Array<{ id: string, direction: 'inbound'|'outbound', body: string, at: string, use_case?: string|null, intent?: string|null, queue_id?: string|null }>} a.messages chronological
 * @param {Array<{ id: string, use_case_template?: string|null, queue_status?: string|null, created_at?: string|null }>} [a.queueRows]
 * @param {Array<{ id: string, amount: number|null, status?: string|null, created_at?: string|null, source_table?: string }>} [a.offers]
 * @param {Array<{ fact: string, value: any, source_message_id: string, confidence: number }>} [a.modelFacts] validated only
 * @param {Record<string, any>} [a.recordFacts]
 * @param {string} [a.now]
 * @param {string|null} [a.timeZone] the recipient's IANA time zone, when known (resolves a stated month at month edges)
 */
export function buildCanonicalLedger({ messages = [], queueRows = [], offers = [], modelFacts = [], recordFacts = {}, now = new Date().toISOString(), timeZone = null } = {}) {
  const t = (m) => Date.parse(m?.at || 0) || 0
  const ordered = [...messages].filter((m) => m && m.id).sort((a, b) => t(a) - t(b))
  const inbound = ordered.filter((m) => m.direction === 'inbound')

  // 1. the EXISTING deterministic extractor (asking price, condition / repairs, occupancy,
  //    timeline, interest, intents) + validated model facts
  // rc-8.5.21 v3: which inbounds answer OUR asking-price question (the latest outbound before them asked it)
  const answersPrice = new Set()
  { let lastKind = null
    for (const m of ordered) {
      if (m.direction === 'outbound') lastKind = questionKindOf({ use_case: useCaseForKind(m.use_case), body: m.body || '' })
      else if (m.direction === 'inbound') { if (lastKind === 'asking_price') answersPrice.add(m.id); lastKind = null }
    } }
  let base = buildFactLedger({ inbound: inbound.map((m) => ({ id: m.id, body: m.body, at: m.at, intent: m.intent, answers_price_question: answersPrice.has(m.id) })), recordFacts, now })
  if (modelFacts.length) base = mergeModelFacts(base, modelFacts, { inboundIds: new Set(inbound.map((m) => m.id)), atById: Object.fromEntries(inbound.map((m) => [m.id, m.at])) })

  const facts = {}
  const requests = []
  const objections = []
  const offerRequests = []
  const retractions = []
  const outboundQuotes = []
  const questions = {}
  for (const k of LEDGER_QUESTION_KINDS) questions[k] = { kind: k, asked_count: 0, asked_message_ids: [], last_asked_at: null, answered: false, answered_by: [], deflected: false, deflected_by: [] }

  // seed seller-stated facts from the deterministic ledger (only seller-stated / model; record facts stay separate)
  const seed = (key, mapValue = (v) => v) => {
    for (const h of base[key]?.history || []) {
      if (h.origin === 'record_derived' || !h.source_message_id) continue
      const v = mapValue(h.value)
      if (v == null) continue
      addFact(facts, key, v, { id: h.source_message_id, at: h.at }, h.origin, Number.isFinite(h.confidence) ? h.confidence : null)
    }
  }
  seed('asking_price')
  seed('condition')
  seed('occupancy')
  seed('timeline')
  seed('seller_interest', (v) => (v && typeof v === 'object' ? v.interest ?? null : v))
  seed('ownership', (v) => {
    const c = v && typeof v === 'object' ? v.ownership_claim ?? null : v
    return c === 'contradictory' ? null : c
  })
  seed('listing_status')

  // 2. walk the conversation: what did we ask (and what is queued), what did each seller message answer
  let lastAsked = null
  const askedFromEvents = new Set()
  const ask = (kind, id, at) => {
    const q = questions[kind]
    if (!q) return
    q.asked_count += 1
    q.asked_message_ids.push(id)
    q.last_asked_at = at || q.last_asked_at
  }
  for (const m of ordered) {
    if (m.direction === 'outbound') {
      if (OUR_AMOUNT_RE.test(String(m.body || ''))) outboundQuotes.push({ message_id: m.id, at: m.at || null })
      const kind = questionKindOf({ use_case: useCaseForKind(m.use_case), body: m.body })
      if (m.queue_id) askedFromEvents.add(String(m.queue_id))
      if (questions[kind]) { ask(kind, m.id, m.at); lastAsked = kind } else if (kind !== 'none') lastAsked = kind
      continue
    }
    if (m.direction !== 'inbound') continue
    const body = String(m.body || '')
    const intent = String(m.intent || '')
    // OWNER 2026-10-14: explicit STOP or any request to stop messaging = suppression
    if (isStopRequest(body) || intent === 'opt_out' || intent === 'stop_texting') addFact(facts, 'opt_out', 'stop_requested', m)
    // ownership / representative
    const denyMatch = OWN_DENY_RE.exec(body) || OWN_FORMER_RE.exec(body)
    const retracted = denyMatch && RETRACTION_RE.test(body.slice(denyMatch.index + denyMatch[0].length))
    if (retracted) {
      // "Sold.. just joking": the claim is taken back in the same breath — never a terminal fact
      retractions.push({ kind: 'ownership_claim_retracted', source_message_id: m.id })
      if (!facts.ownership || ['denied', 'former_owner'].includes(facts.ownership.value)) addFact(facts, 'ownership', 'confirmed', m, 'retracted_denial_implies_ownership', 0.6)
    } else if (OWNERSHIP_INTENTS[intent]) addFact(facts, 'ownership', OWNERSHIP_INTENTS[intent], m)
    else if (OWN_DENY_RE.test(body)) addFact(facts, 'ownership', 'denied', m)
    // a regex "sold" reading is weak evidence (0.6): mixed-intent rules may outrank it
    else if (OWN_FORMER_RE.test(body)) addFact(facts, 'ownership', 'former_owner', m, 'seller_stated', 0.6)
    else if (lastAsked === 'ownership' && OWN_ANSWER_FORMER_RE.test(body)) addFact(facts, 'ownership', 'former_owner', m)
    else if (OWN_CONFIRM_RE.test(body) || (lastAsked === 'ownership' && (BARE_YES_RE.test(body) || OWN_ANSWER_CONFIRM_RE.test(body)))) addFact(facts, 'ownership', 'confirmed', m)
    else if (lastAsked === 'ownership' && OWN_ANSWER_STILL_RE.test(body)) addFact(facts, 'ownership', 'confirmed', m, 'seller_claim_answer_to_ownership_question')
    // rc-8.5.20: the shared matcher ("Not really", "No!!!", "Nope"); a polite "No thanks" or an emoji reply is not a denial
    else if (lastAsked === 'ownership' && bareNoAnswer(body).ownership_denial) addFact(facts, 'ownership', 'denied', m)
    // OWNER DECISION 2026-10-17 (supersedes 831df6cd): a polite "No thanks" to the ownership question is
    // declined engagement, ownership UNVERIFIED — its own value, never 'denied', never a selling decline
    else if (lastAsked === 'ownership' && bareNoAnswer(body).ownership_declined) addFact(facts, 'ownership', 'declined_unverified', m)
    if (REPRESENTATIVE_INTENTS.has(intent) || REPRESENTATIVE_RE.test(body)) {
      addFact(facts, 'representative', intent || 'representative', m)
      // a representative answers the ownership question for the owner (never "denied")
      if (!facts.ownership || facts.ownership.value !== 'denied') addFact(facts, 'ownership', 'representative', m)
    }
    // interest
    if (INTEREST_INTENTS[intent]) addFact(facts, 'seller_interest', INTEREST_INTENTS[intent], m)
    else if (NOT_INTERESTED_RE.test(body)) addFact(facts, 'seller_interest', 'not_interested', m)
    else if (lastAsked === 'interest' && BARE_YES_RE.test(body)) addFact(facts, 'seller_interest', 'interested', m)
    else if (lastAsked === 'interest' && bareNoAnswer(body).matched) addFact(facts, 'seller_interest', 'not_interested', m)
    else if (lastAsked === 'interest' && BARE_MAYBE_RE.test(body)) addFact(facts, 'seller_interest', 'conditional', m)
    // rc-8.5.21 v4 (coverage): a stated wish to sell ("just want it gone before winter", "I'd sell", "la quiero
    // vender") is interest — never when the same message negates it
    else if (!facts.seller_interest?.source_message_ids?.includes(m.id) && WANTS_TO_SELL_RE.test(body) && !NOT_INTERESTED_RE.test(body) && !/\b(?:don'?t|dont|do\s+not|never|not|no)\s+(?:\w+\s+){0,2}(?:want|need|ready|sell|selling)\b|(?<![\p{L}])no\s+(?:la|lo)?\s*(?:quiero|voy\s+a)\s+vender/iu.test(body)) addFact(facts, 'seller_interest', 'interested', m, 'stated_wish_to_sell')
    // rc-8.5.21: a financing-terms objection is conditional interest (latest statement wins)
    if (FINANCING_OBJECTION_RE.test(body)) {
      objections.push({ kind: 'financing_terms_objection', source_message_id: m.id })
      addFact(facts, 'seller_interest', 'conditional', m, 'financing_objection_conditional')
    } else if (DEFERS_CONTACT_RE.test(body)) {
      // "I'll reach out when I want to sell" is NOT interest now (the extractor may read "want to sell")
      addFact(facts, 'seller_interest', 'not_interested', m, 'defers_contact_until_ready')
    }
    if (EMAIL_OR_CARD_REQUEST_RE.test(body)) requests.push({ kind: 'email_or_card', source_message_id: m.id })
    // blind-eval v2 STP-09: an in-person visit request ("can you stop by Thursday at 3") is an operator task
    if (VISIT_REQUEST_RE.test(body) || VISIT_REQUEST_EXT_RE.test(body)) requests.push({ kind: 'visit_request', source_message_id: m.id })
    if (COMPANY_QUESTION_RE.test(body)) requests.push({ kind: 'company_identity', source_message_id: m.id })
    // blind-eval S2: a DIRECT question about automation (the only case a text may speak about it)
    if (AUTOMATION_QUESTION_RE.test(body)) requests.push({ kind: 'automation_question', source_message_id: m.id })
    // timeline (beyond the extractor): "close before November", "move in 30 days", "asap"
    const tl = TIMELINE_RE.exec(body)
    if (tl && !(facts.timeline?.source_message_ids || []).includes(m.id)) addFact(facts, 'timeline', { stated: tl[0].trim().toLowerCase() }, m, 'seller_stated', 0.75)
    // Owner 2026-10-30 (e2e-9 "I might sell this winter"): a dated or seasonal timeline with no verb before it ("this
    // winter", "by December", "in the spring", "after school's out"). The seller's words are kept; a period is resolved
    // only from this message's timestamp (to a month or season, never a day); ambiguity is kept; urgency is never set.
    else if (!tl && !(facts.timeline?.source_message_ids || []).includes(m.id)) {
      const refs = sellerTimelineMentions(body).map((r) => ({ ...r, ...resolveTimeReference(r, { saidAt: m.at || null, timeZone }) })).filter((r) => !r.past)
      if (refs.length) addFact(facts, 'timeline', { stated: refs.map((r) => r.stated).join('; '), urgency: null, references: refs }, m, 'seller_stated', 0.7)
    }
    // condition (beyond the extractor)
    if (CONDITION_RE.test(body) && !(facts.condition?.source_message_ids || []).includes(m.id)) addFact(facts, 'condition', { disclosed: true }, m)
    // offer request: interest shown, NO asking price inferred, no amount
    if (isDeflectionToOffer(body) || intent === 'asks_offer') {
      offerRequests.push(m.id)
      if (!facts.seller_interest || facts.seller_interest.value === 'unknown') addFact(facts, 'seller_interest', 'interested', m, 'offer_request_implies_interest')
      if (lastAsked === 'asking_price') { questions.asking_price.deflected = true; pushUnique(questions.asking_price.deflected_by, m.id) }
    } else if (lastAsked === 'asking_price' && isPriceNonAnswer(body)) {
      questions.asking_price.deflected = true
      pushUnique(questions.asking_price.deflected_by, m.id)
    }
    // a stated price shows interest too (never the other way round)
    if ((facts.asking_price?.source_message_ids || []).includes(m.id) && !facts.seller_interest) addFact(facts, 'seller_interest', 'interested', m, 'asking_price_implies_interest')
    // requests / objections
    if (WHO_IS_THIS_RE.test(body) || IDENTITY_REQUEST_RE.test(body) || intent === 'who_is_this') {
      requests.push({ kind: 'identity', source_message_id: m.id })
      // the seller answered our open question with a question about us: that question was
      // DEFLECTED, and may be re-asked ONCE inside the identity answer (never the price)
      if (lastAsked && questions[lastAsked] && lastAsked !== 'asking_price') pushUnique((questions[lastAsked].identity_deflected_by ||= []), m.id)
    }
    if ((CALLBACK_RE.test(body) && !/\b(?:don'?t|dont|do\s+not|never|no|stop|quit)\s+(?:\w+\s+){0,2}call/i.test(body)) || CALLBACK_REQUEST_RE.test(body) || intent === 'callback_requested') requests.push({ kind: 'callback', source_message_id: m.id })
    if (WHICH_PROPERTY_RE.test(body) || intent === 'multi_property') requests.push({ kind: 'property_identity', source_message_id: m.id })
    if (OBJECTION_RE.test(body) || intent === 'counter_or_negotiation') objections.push({ kind: 'price_objection', source_message_id: m.id })
    if (NEED_TIME_RE.test(body) || intent === 'need_time') objections.push({ kind: 'need_time', source_message_id: m.id })
  }

  // latest seller statement wins BY TIME (seeded extractor facts and walked facts interleave)
  for (const slot of Object.values(facts)) {
    const hist = slot.history.map((h, i) => ({ h, i })).sort((a, b) => ((Date.parse(a.h.at || 0) || 0) - (Date.parse(b.h.at || 0) || 0)) || a.i - b.i).map((x) => x.h)
    slot.history = hist
    slot.value = hist[hist.length - 1].value
    slot.origin = hist[hist.length - 1].origin
    slot.basis = hist[hist.length - 1].basis
    slot.confidence = hist[hist.length - 1].confidence
  }

  // 3. queued / in-flight / sent questions that have no message_events row yet are ASKED
  for (const r of queueRows) {
    if (!r?.id || askedFromEvents.has(String(r.id))) continue
    const status = String(r.queue_status || '').toLowerCase()
    if (!ASKED_QUEUE_STATUSES.has(status)) continue
    if (status === 'sent' || status === 'delivered') continue // a sent row is represented by its message_events row
    const kind = questionKindOf({ use_case: useCaseForKind(r.use_case_template), body: r.message_body || '' })
    if (questions[kind]) ask(kind, `queue:${r.id}`, r.created_at || null)
  }

  // 4. answered: a seller fact of that kind exists (with its message ids)
  const ANSWER_FACT = { ownership: 'ownership', interest: 'seller_interest', asking_price: 'asking_price', condition: 'condition', occupancy: 'occupancy', timeline: 'timeline' }
  for (const [kind, key] of Object.entries(ANSWER_FACT)) {
    if (facts[key]?.value != null) { questions[kind].answered = true; questions[kind].answered_by = [...facts[key].source_message_ids] }
  }

  const existingOffers = (offers || []).filter((o) => Number(o?.amount) > 0).map((o) => ({ id: o.id, amount: Number(o.amount), status: o.status || null, at: o.created_at || null, source_table: o.source_table || 'seller_offers' }))
  const property = {
    property_ids: [...new Set([recordFacts?.property_id, ...(recordFacts?.property_ids || [])].filter(Boolean).map(String))],
    identity_requested: requests.some((r) => r.kind === 'property_identity'),
  }

  const ledger = {
    version: FACT_LEDGER_VERSION,
    facts,
    questions,
    offer_requests: offerRequests,
    existing_offers: existingOffers,
    retractions,
    outbound_quotes: outboundQuotes,
    requests,
    objections,
    property,
    last_message: ordered.length ? { id: ordered[ordered.length - 1].id, direction: ordered[ordered.length - 1].direction, at: ordered[ordered.length - 1].at } : null,
    // rc-8.5.21 v3 (RT-11 / RT-05): the seller's messages since our last outbound (a burst) — what the
    // seller "asked" is read across all of them, never only the latest fragment
    open_inbound_ids: (() => { const out = []; for (let i = ordered.length - 1; i >= 0 && ordered[i].direction === 'inbound'; i -= 1) out.unshift(ordered[i].id); return out })(),
  }
  ledger.stage = deriveLedgerStage(ledger)
  ledger.next_missing = nextMissingFact(ledger)
  ledger.follow_up = followUpEligibility(ledger)
  // rc-8.5.20 (review a): the SAME facts in the facts.js { key: { current, history } } shape,
  // for the 8.5.19 negotiation / economics consumers (ledger.js factLedgerOf). Non-enumerable:
  // the canonical object's own shape is unchanged.
  Object.defineProperty(ledger, 'fact_ledger', { value: legacyFactLedgerView(base, facts), enumerable: false })
  return ledger
}

// coarse walked values ({ disclosed: true }, { stated: … }) never hide the extractor's richer
// value from the SAME seller message (condition / repairs detail, the timeline parse)
const isCoarse = (v) => v && typeof v === 'object' && (('disclosed' in v && Object.keys(v).length === 1) || ('stated' in v && Object.keys(v).length === 1))

/**
 * The canonical facts in the facts.js shape. Base = the extractor ledger the canonical ledger was
 * seeded from (record-derived facts included); every canonical fact is overlaid as the CURRENT
 * value (latest seller statement by time, the same value the pipeline reads), its walked entries
 * appended to history with their source message ids.
 */
export function legacyFactLedgerView(base = {}, facts = {}) {
  const out = structuredClone(base || {})
  for (const [key, slot] of Object.entries(facts || {})) {
    const hist = slot.history || []
    if (!hist.length) continue
    const last = hist[hist.length - 1]
    const s = (out[key] ||= { current: null, history: [] })
    const baseCur = s.current
    const value = baseCur && baseCur.origin !== 'record_derived' && baseCur.source_message_id === last.source_message_id && isCoarse(slot.value) ? baseCur.value : slot.value
    for (const h of hist) {
      if (!s.history.some((x) => x.source_message_id === h.source_message_id && JSON.stringify(x.value) === JSON.stringify(h.value))) {
        s.history.push({ value: h.value, origin: h.origin, source_message_id: h.source_message_id, at: h.at, confidence: h.confidence })
      }
    }
    s.history.sort((a, b) => (Date.parse(a.at || 0) || 0) - (Date.parse(b.at || 0) || 0))
    s.current = { value, origin: last.origin, source_message_id: last.source_message_id, at: last.at, confidence: last.confidence, basis: last.basis }
    if (baseCur?.corrects && baseCur.source_message_id === last.source_message_id) s.current.corrects = baseCur.corrects
  }
  return out
}

const factValue = (ledger, key) => ledger?.facts?.[key]?.value ?? null
const ids = (ledger, key) => ledger?.facts?.[key]?.source_message_ids || []

/** Evidence-based stage: every step names the seller messages / records that prove it. */
export function deriveLedgerStage(ledger) {
  if (factValue(ledger, 'opt_out')) return { stage: 'closed', evidence_message_ids: ids(ledger, 'opt_out'), rationale: 'stop requested (suppression)' }
  const own = factValue(ledger, 'ownership')
  if (own === 'denied' || own === 'former_owner') return { stage: 'closed', evidence_message_ids: ids(ledger, 'ownership'), rationale: `ownership ${own}` }
  const interest = factValue(ledger, 'seller_interest')
  if (interest === 'not_interested') return { stage: 'nurture', evidence_message_ids: ids(ledger, 'seller_interest'), rationale: 'not interested (30-day nurture, never suppressed)' }
  if (ledger.existing_offers.length) return { stage: 'S5_offer', evidence_message_ids: [], rationale: `authoritative offer record(s): ${ledger.existing_offers.length}` }
  const price = factValue(ledger, 'asking_price') != null
  const cond = factValue(ledger, 'condition') != null
  // rc-8.5.21 v3 (S1–S5 BINDING + owner rule 10-18 "offer before price"): condition is S4 and comes AFTER the
  // price. A seller who asks for OUR offer before giving a number is asked for it ONCE; if the number is
  // still withheld (deflected, or another offer request after our price ask) the next step is research →
  // a GATED offer recommendation (S5, a human step) — never a condition question the seller did not raise.
  const priceWithheld = !price && (ledger.questions.asking_price.deflected || (ledger.questions.asking_price.asked_count > 0 && ledger.offer_requests.length > 0))
  if (priceWithheld) return { stage: 'S5_offer', evidence_message_ids: [...ledger.questions.asking_price.deflected_by, ...ids(ledger, 'condition')].slice(0, 12), rationale: 'offer requested and the asking price withheld after one ask: research → gated offer recommendation (human), never a condition question first' }
  if (price && cond) return { stage: 'S5_offer', evidence_message_ids: [...ids(ledger, 'asking_price'), ...ids(ledger, 'condition')].slice(0, 12), rationale: 'asking price and condition on record; the offer is a human step' }
  if (price) return { stage: 'S4_condition', evidence_message_ids: ids(ledger, 'asking_price').slice(0, 12), rationale: 'asking price stated' }
  if (interest === 'interested' || interest === 'conditional') return { stage: 'S3_asking_price', evidence_message_ids: ids(ledger, 'seller_interest'), rationale: 'interest shown' }
  if (own === 'confirmed' || own === 'representative') return { stage: 'S2_interest', evidence_message_ids: ids(ledger, 'ownership'), rationale: `ownership ${own}` }
  return { stage: 'S1_ownership', evidence_message_ids: [], rationale: 'no ownership evidence yet' }
}

/** The next fact the S1–S4 flow still needs; null when the flow is past S4 or closed. */
export function nextMissingFact(ledger) {
  const st = ledger.stage?.stage
  if (['closed', 'nurture', 'S5_offer'].includes(st)) return null
  const done = {
    ownership: ledger.questions.ownership.answered,
    interest: ledger.questions.interest.answered,
    // rc-8.5.21 v3: ASKED is not ANSWERED — an unanswered price ask keeps the price as the next missing fact
    // (the validator never lets it be re-asked), so the flow can never jump to condition before the price
    asking_price: ledger.questions.asking_price.answered || ledger.questions.asking_price.deflected,
    condition: ledger.questions.condition.answered,
  }
  // a later stage's evidence implies the earlier ones (a stated price implies ownership + interest)
  const stageIdx = ['S1_ownership', 'S2_interest', 'S3_asking_price', 'S4_condition'].indexOf(st)
  for (let i = 0; i < STAGE_KINDS.length; i += 1) {
    const kind = STAGE_KINDS[i]
    if (i < stageIdx) continue
    if (!done[kind]) return kind
  }
  return null
}

/** Is a no-reply follow-up (template engine) appropriate? Facts only; scheduling stays with the engine. */
export function followUpEligibility(ledger) {
  const st = ledger.stage?.stage
  if (factValue(ledger, 'opt_out')) return { eligible: false, reason: 'stop_requested_suppression' }
  // "No" to ownership = property-scoped stop: no follow-up, no nurture (owner 2026-10-14)
  if (st === 'closed') return { eligible: false, reason: 'ownership_denied_or_former_no_nurture' }
  if (ledger.offer_requests.length && !ledger.existing_offers.length) return { eligible: false, reason: 'offer_requested_needs_human' }
  if (ledger.last_message?.direction === 'inbound') return { eligible: false, reason: 'seller_spoke_last_reply_due' }
  if (st === 'nurture') return { eligible: true, reason: 'nurture_30_day' }
  const pending = STAGE_KINDS.find((k) => ledger.questions[k].asked_count > 0 && !ledger.questions[k].answered && !(k === 'asking_price' && ledger.questions.asking_price.deflected))
  return pending ? { eligible: true, reason: `awaiting_answer:${pending}`, awaiting_kind: pending } : { eligible: false, reason: 'no_open_question' }
}

/**
 * VALIDATION API. Reject a proposed message that asks an answered or already-asked
 * fact, goes backwards, skips a stage, or asks about an offer / money.
 * @param {object} ledger buildCanonicalLedger()
 * @param {{ kind?: string|null, text?: string|null, inboundIntent?: string|null }} proposal
 * @returns {{ ok: boolean, reasons: string[], kind: string, next_missing: string|null }}
 */
export function validateProposedMessage(ledger, { kind = null, text = null, inboundIntent = null } = {}) {
  const k = kind || questionKindOf({ body: text || '' })
  const reasons = []
  if (factValue(ledger, 'opt_out')) reasons.push('stop_requested_no_message')
  const q = ledger?.questions?.[k]
  if (k === 'offer') reasons.push('offer_question_is_human')
  if (q && q.answered) reasons.push(`already_answered:${k}`)
  if (q && !q.answered && q.asked_count > 0) {
    // the single allowed repeat: the seller asked who we are instead of answering, and
    // we answer that AND re-ask once; never for the asking price (owner 2026-10-13)
    const deflectedByIdentity = (q.identity_deflected_by || []).includes(ledger?.last_message?.id)
    // the re-ask is allowed only INSIDE an identity answer ("I'm a local buyer … do you still own it?")
    // rc-8.5.21 v4 (coverage): the identity answer in Spanish, and a plain name answer ("It's Helen") to "what's your name?"
    const answersIdentity = /\b(?:buyer|investor|local|we\s+buy|real\s+estate|i'?m\s+(?:a|with|from)|we'?re\s+(?:a|local)|public\s+(?:property\s+)?records)\b/i.test(String(text || '')) ||
      /(?<![\p{L}])(?:compr(?:o|amos|ador|adora|adores)|inversionista|inversionistas|registros\s+p[uú]blicos|soy\s+\p{Lu}\p{Ll}+|me\s+llamo|mi\s+nombre\s+es|(?:it'?s|this\s+is|my\s+name\s+is|name'?s)\s+\p{Lu}\p{Ll}+)(?![\p{L}])/u.test(String(text || ''))
    const identityRepeat = (inboundIntent === 'who_is_this' || (deflectedByIdentity && answersIdentity)) && k !== 'asking_price' && q.asked_count < 2
    if (!identityRepeat) reasons.push(`already_asked:${k}`)
  }
  if (k === 'asking_price' && ledger?.questions?.asking_price?.deflected) reasons.push('asking_price_deflected_never_reask')
  if (k === 'asking_price' && ledger?.offer_requests?.length && ledger.questions.asking_price.asked_count > 0) reasons.push('offer_requested_after_price_ask')
  const idx = STAGE_KINDS.indexOf(k)
  const stage = ledger?.stage?.stage
  const stageIdx = ['S1_ownership', 'S2_interest', 'S3_asking_price', 'S4_condition'].indexOf(stage)
  if (idx >= 0 && ['closed', 'nurture', 'S5_offer'].includes(stage)) reasons.push(`stage_${stage}_no_stage_question`)
  else if (idx >= 0 && stageIdx >= 0 && idx < stageIdx) reasons.push(`backwards_question:${k}`)
  else if (idx >= 0 && ledger?.next_missing && idx > STAGE_KINDS.indexOf(ledger.next_missing)) reasons.push(`skips_stage:${k}`)
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], kind: k, next_missing: ledger?.next_missing ?? null }
}

/** Compact view for logs / the review UI (no message text). */
export function ledgerSummary(ledger) {
  return {
    version: ledger.version,
    stage: ledger.stage,
    next_missing: ledger.next_missing,
    facts: Object.fromEntries(Object.entries(ledger.facts).map(([k, v]) => [k, { value: k === 'asking_price' ? (v.value?.amount != null ? 'stated' : v.value) : v.value, basis: v.basis, confidence: v.confidence, source_message_ids: v.source_message_ids }])),
    questions: Object.fromEntries(Object.entries(ledger.questions).filter(([, q]) => q.asked_count || q.answered || q.deflected).map(([k, q]) => [k, { asked: q.asked_count, answered: q.answered, deflected: q.deflected }])),
    offer_requests: ledger.offer_requests.length,
    existing_offers: ledger.existing_offers.length,
    requests: ledger.requests.map((r) => r.kind),
    objections: ledger.objections.map((o) => o.kind),
    follow_up: ledger.follow_up,
  }
}

export { STAGE_NAME }

/**
 * The ledger as of ONE inbound, from buildConversationContext() input rows (the
 * shadow engine and the R3 executor share this): only messages at or before the
 * inbound, plus the inbound itself.
 */
export function ledgerFromContextInput(input = {}, { modelFacts = [], queueRows = [], now = null } = {}) {
  const inbound = input.inbound || {}
  const at = Date.parse(inbound.at || 0) || 0
  const rows = [...(input.thread || [])]
  if (inbound.id && !rows.some((m) => m.id === inbound.id)) rows.push({ ...inbound, direction: 'inbound' })
  const messages = rows.filter((m) => m.id === inbound.id || (Date.parse(m.at || 0) || 0) <= at).map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.at, use_case: m.use_case || null, intent: m.intent || null, queue_id: m.queue_id || null }))
  const propertyIds = [...new Set((input.properties || []).map((p) => p.property_id).filter(Boolean).map(String))]
  return buildCanonicalLedger({ messages, queueRows, offers: input.offers || [], modelFacts, recordFacts: { property_ids: propertyIds }, now: now || input.now || new Date().toISOString() })
}
