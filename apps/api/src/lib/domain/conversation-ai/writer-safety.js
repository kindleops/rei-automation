// WRITER SAFETY VALIDATORS (blind safety evaluation v1 remediation). PURE, DETERMINISTIC, NO I/O.
//
// LeadCommand no longer writes seller-facing text: an external agent composes every SMS and LeadCommand only
// validates and transports it. These rules judge a text composed by ANYONE against the thread it would be sent
// on. Each returns reason codes (empty = passes); a non-empty list means the text is refused, never repaired.
//
//   1. NON-OWNER CONTACT        the person on this thread said they are not the owner in a way that is not literally
//                               "wrong number" (tenant / renter, relative, neighbour, property manager, "the owner is
//                               my landlord", "my mom owns it", sold it …) ⇒ NO text at all on the thread (a person
//                               decides; ownership is denied-or-unconfirmed for this contact). Independently, a text
//                               never asks anyone about a third-party owner's intentions ("would the owner sell?").
//                               Opt-outs are decided elsewhere and always win; these rules only ever ADD a refusal.
//   2. INVENTED ACKNOWLEDGEMENT  a text may thank / acknowledge a reply, answer, update or message only when the seller
//                               has written since our last message; "as you mentioned" needs a seller message at all;
//                               a time the seller gave ("in the spring") is never referred to once it has passed.
//   3. UNSUPPORTED IDENTITY      "a person on the team reads every message / can take over" only when the configured
//                               company identity says human_review === true; a persona descriptor ("a local buyer",
//                               "local investor", "we buy houses") only when it matches the configured
//                               persona_descriptor. The honest "AI assistant writing for <persona> with <company>"
//                               disclosure itself is never refused here.
//
// Thread rows: { direction: 'inbound'|'outbound', body: string, at?: ISO string } (any order; sorted by `at` when every
// row has one, else taken in the given order).
import { NO_COMPANY_IDENTITY } from './company-identity.js'
import { timeReferencesIn, timeReferenceEnd } from './time-references.js'

export const WRITER_SAFETY_VERSION = 'conv-ai.writer-safety.v1'

const isIn = (m) => String(m?.direction || '').toLowerCase().startsWith('in')
const isOut = (m) => String(m?.direction || '').toLowerCase().startsWith('out')
const bodyOf = (m) => String(m?.body ?? m?.message_body ?? m?.text ?? '')
const norm = (t) => String(t || '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim()

/** Chronological thread (stable). */
export function orderedThread(thread = []) {
  const rows = (Array.isArray(thread) ? thread : []).map((m, i) => ({ m, i, t: Date.parse(m?.at || '') }))
  if (rows.length && rows.every((r) => Number.isFinite(r.t))) rows.sort((a, b) => a.t - b.t || a.i - b.i)
  return rows.map((r) => r.m)
}

// ── 1. NON-OWNER CONTACT ─────────────────────────────────────────────────────────────────────────────────────────
const REL = String.raw`(?:mom|mother|mommy|mama|ma|dad|father|daddy|papa|pops|parents?|grand(?:ma|mother|pa|father|parents?|son|daughter)|granny|nana|son|daughter|kids?|children|brother|sister|siblings?|aunt|auntie|uncle|husband|wife|hubby|spouse|ex(?:-(?:wife|husband))?|cousin|niece|nephew|(?:mother|father|son|daughter|brother|sister)[- ]in[- ]law|in-?laws|family|boyfriend|girlfriend|fianc[eé]e?|step-?(?:mom|dad|mother|father|son|daughter|brother|sister)|relatives?|friend|roommate|boss|employer)`
const NOT_OUT = String.raw`(?!\s+(?:(?:it|this|that|them|the\s+\w+|units?|rooms?)\s+)?(?:out|to)\b)`
const NON_OWNER_PATTERNS = [
  // explicit: not the owner
  ['not_owner', /\b(?:i|we)\s+(?:do\s+not|don'?t|dont|never|no\s+longer|didn'?t\s+ever)\s+(?:own|owned)\b/i],
  ['not_owner', /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+not\s+(?:the|an?)\s+(?:home|property\s+)?owners?\b/i],
  ['not_owner', /\bnot\s+(?:my|our)\s+(?:house|home|property|place|building)\b|\b(?:it'?s|its|it\s+is)\s+not\s+(?:mine|ours)\b/i],
  ['former_owner', /\b(?:i|we)\s+(?:already\s+|actually\s+)?sold\s+(?:it|that|this|the\s+(?:house|home|property|place))\b/i],
  // tenant / renter / occupant
  ['tenant', new RegExp(String.raw`\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:just\s+|only\s+|currently\s+|still\s+)?(?:a\s+|the\s+)?(?:tenants?|renters?|renting|leasing|occupants?)\b${NOT_OUT}`, 'i')],
  ['tenant', new RegExp(String.raw`\b(?:i|we)\s+(?:just\s+|only\s+|currently\s+|still\s+)?(?:rent|lease)\b${NOT_OUT}`, 'i')],
  ['tenant', new RegExp(String.raw`(?:^|[.!?,]\s*|\b(?:currently|just|only|still)\s+)renting\b${NOT_OUT}`, 'i')],
  ['tenant', /\b(?:i|we)\s+(?:just|only)\s+live\s+(?:here|there|in\s+(?:it|the\s+(?:house|home|unit|apartment)))\b/i],
  ['tenant', /\b(?:i|we)\s+live\s+(?:here|there)\b[^.?!]{0,40}\b(?:not|don'?t|do\s+not)\s+(?:own|the\s+owner)/i],
  ['tenant', /\b(?:my|our)\s+(?:landlord|landlady|lease)\b|\bthe\s+(?:landlord|landlady)\s+(?:is|owns|lives|has|will|would|isn'?t|doesn'?t|said|might|may)\b/i],
  ['tenant', /\b(?:i'?m|i\s+am)\s+(?:just\s+)?(?:the|a)\s+(?:caretaker|house-?sitter|roommate|live-?in)\b/i],
  // relative / someone else owns it
  ['relative', new RegExp(String.raw`\b(?:my|our)\s+${REL}(?:'s|s')?\s+(?:owns?|owned|is\s+the\s+(?:owner|one\s+who\s+owns)|has\s+(?:the\s+)?(?:title|deed)|(?:name\s+is\s+)?on\s+the\s+(?:title|deed))\b`, 'i')],
  ['relative', new RegExp(String.raw`\b(?:it'?s|its|it\s+is|this\s+is|that'?s|that\s+is|the\s+(?:house|home|property|place)\s+(?:is|was|belongs\s+to))\s+(?:actually\s+|really\s+|still\s+)?(?:my|our)\s+${REL}(?:'s|s')`, 'i')],
  ['relative', new RegExp(String.raw`\bbelongs?\s+to\s+(?:my|our)\s+${REL}\b|\bin\s+(?:my|our)\s+${REL}(?:'s|s')\s+name\b|\bthe\s+owner\s+is\s+(?:my|our)\b`, 'i')],
  ['relative', new RegExp(String.raw`\b(?:i'?m|i\s+am)\s+(?:his|her|their|the\s+owners?'?s?)\s+${REL}\b`, 'i')],
  // a relative answering for the owner: "this is his son", "my dad handles that", "my mom takes care of the house"
  ['relative', new RegExp(String.raw`\b(?:this\s+is|it'?s|its|you'?(?:ve|re)\s+(?:got|reached|texting))\s+(?:his|her|their|the\s+owners?'?s?)\s+${REL}\b`, 'i')],
  ['relative', new RegExp(String.raw`\b(?:my|our)\s+${REL}\s+(?:handles?|deals?\s+with|takes?\s+care\s+of|manages?|decides?|is\s+in\s+charge\s+of|makes?\s+(?:the\s+)?decisions?\s+(?:on|about))\s+(?:that|it|this|those|everything|all\s+(?:of\s+)?that|the\s+(?:house|home|property|place|stuff|paperwork|business))\b`, 'i')],
  // neighbour
  ['neighbour', /\b(?:i'?m|i\s+am|this\s+is|we'?re|we\s+are)\s+(?:just\s+)?(?:the|a|your|their|his|her)\s+neighbou?rs?\b|\b(?:i|we)\s+live\s+(?:next\s+door|across\s+the\s+street|down\s+the\s+(?:street|road|block))\b/i],
  // property manager
  ['property_manager', /\bproperty\s+manage(?:r|ment)\b|\bmanagement\s+company\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:with\s+)?the\s+manag(?:er|ement)\b|\b(?:i|we)\s+manage\s+(?:it|this|that|the\s+(?:property|house|home|building|unit|place))\b/i],
  // the owner is a third party
  ['third_party_owner', /\bthe\s+(?:owners?|homeowners?|property\s+owners?)\s+(?:is|are|lives?|isn'?t|aren'?t|doesn'?t|don'?t|passed|died|has|have|will|would|wants?|might|may|moved|said|told|left)\b/i],
  ['third_party_owner', /\b(?:talk|speak|reach\s+out)\s+(?:to|with)\s+(?:my|our|the)\s+(?:landlord|landlady|owners?)\b|\b(?:contact|call|ask)\s+(?:my|our|the)\s+(?:landlord|landlady|owners?)\b/i],
  // Spanish
  ['tenant', /(?<![\p{L}])(?:soy|somos)\s+(?:el\s+|la\s+|un[ao]?\s+)?(?:inquilin[oa]s?|arrendatari[oa]s?)(?![\p{L}])|(?<![\p{L}])(?:solo\s+)?(?:rento|rentamos|alquilo|alquilamos)\s+(?:aqu[ií]|la\s+casa|el\s+apartamento)(?![\p{L}])|(?<![\p{L}])mi\s+(?:casero|casera|arrendador|arrendadora)(?![\p{L}])/iu],
  ['not_owner', /(?<![\p{L}])no\s+(?:soy|somos)\s+(?:el\s+|la\s+|los\s+)?(?:due[nñ][oa]s?|propietari[oa]s?)(?![\p{L}])/iu],
  ['relative', /(?<![\p{L}])(?:es|la\s+casa\s+es)\s+de\s+mi\s+(?:mam[aá]|pap[aá]|madre|padre|herman[oa]|espos[oa]|hij[oa]|abuel[oa]|t[ií][oa]|suegr[oa])(?![\p{L}])|(?<![\p{L}])(?:el|la)\s+due[nñ][oa]\s+es\s+mi(?![\p{L}])|(?<![\p{L}])mi\s+(?:mam[aá]|pap[aá]|madre|padre|herman[oa]|espos[oa]|hij[oa]|abuel[oa]|t[ií][oa])\s+es\s+(?:el|la)\s+due[nñ][oa](?![\p{L}])/iu],
  ['neighbour', /(?<![\p{L}])soy\s+(?:el\s+|la\s+|un[ao]?\s+)?vecin[oa](?![\p{L}])/iu],
]
// a first-person ownership claim in the SAME message ("my wife and I own it", "I own it, my tenant lives there")
const OWNER_CLAIM_RE = /\b(?:i|we)\s+(?:still\s+|do\s+|both\s+|also\s+|jointly\s+|co-?)?own\s+(?:it|this|that|the|half|both)\b|\band\s+i\s+(?:both\s+)?own\b|\bco-?owners?\b|\bowns?\s+it\s+with\s+me\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:the|an?|one\s+of\s+the)\s+(?:co-?)?owners?\b(?!')|\bthe\s+owner\s+is\s+me\b|\b(?:it'?s|its|it\s+is)\s+(?:still\s+)?(?:mine|ours)\b|(?<![\p{L}])(?:soy\s+(?:el|la)\s+(?:due[nñ][oa]|propietari[oa])|es\s+m[ií]a)(?![\p{L}])/iu
const EXPLICIT_DENIAL = new Set(['not_owner'])

/**
 * Does ONE seller message say the writer is not the owner (in any way other than a bare "wrong number")?
 * @param {string} text
 * @returns {{ non_owner: boolean, kinds: string[], owner_claim: boolean }}
 */
export function detectNonOwnerStatement(text) {
  const t = norm(text)
  const kinds = [...new Set(NON_OWNER_PATTERNS.filter(([, re]) => re.test(t)).map(([k]) => k))]
  const ownerClaim = OWNER_CLAIM_RE.test(t)
  // an explicit denial always counts (a contradiction is a person's call); otherwise a co-ownership / ownership claim
  // in the same message outranks a mention of a relative, a tenant or a manager
  const nonOwner = kinds.some((k) => EXPLICIT_DENIAL.has(k)) || (kinds.length > 0 && !ownerClaim)
  return { non_owner: nonOwner, kinds: nonOwner ? kinds : [], owner_claim: ownerClaim }
}

// a text that asks anyone about a third-party owner ("would the owner sell?", "could you pass this to your landlord")
const THIRD_PARTY_OWNER_ASK_RE = new RegExp([
  String.raw`\b(?:would|will|could|might|does|do|is|are|has|have)\s+(?:the|your)\s+(?:owners?|landlord|landlady|homeowners?|property\s+owners?|property\s+manager)\b`,
  String.raw`\b(?:would|will|could|might|does|do|is|are)\s+(?:your|the)\s+${REL}\s+(?:be\s+)?(?:sell|consider|interested|open|want|willing|thinking)`,
  String.raw`\b(?:pass|forward|give|send|share|relay|hand|show)\s+(?:this|my\s+(?:number|info|message|text)|our\s+(?:number|info|message|text)|it|the\s+(?:message|text))\s+(?:on\s+|along\s+|over\s+)?(?:to|with)\s+(?:the|your)\s+(?:owners?|landlord|landlady|property\s+manager|${REL})\b`,
  String.raw`\b(?:ask|check\s+with|let|tell)\s+(?:the|your)\s+(?:owners?|landlord|landlady|property\s+manager)\b`,
  String.raw`\b(?:who|whoever)\s+(?:owns|is\s+the\s+owner|the\s+owner\s+is)\b`,
  String.raw`\b(?:contact|reach|get\s+in\s+touch\s+with|number\s+for|info(?:rmation)?\s+for|connect\s+(?:me|us)\s+with)\s+(?:the|your)\s+(?:owners?|landlord|landlady|property\s+manager)\b`,
  String.raw`\bthe\s+owner(?:'s|s')?\s+(?:number|contact|info|plans|intentions|name)\b`,
  // how or when to reach someone other than the person texting (a relative, "him", "her", "them")
  String.raw`\b(?:reach|contact|get\s+(?:a\s+)?hold\s+of|talk\s+to|speak\s+(?:to|with)|call|text|connect\s+with)\s+(?:your|the|his|her|their)\s+${REL}\b`,
  String.raw`\b(?:better|best|good)\s+(?:way|time|number)\s+(?:or\s+(?:time|way)\s+)?to\s+(?:reach|contact|call|text|get\s+(?:a\s+)?hold\s+of)\s+(?:him|her|them|your\s+\w+)\b`,
  String.raw`\b(?:could|can|would)\s+you\s+(?:ask|tell|have)\s+(?:him|her|them|your\s+${REL})\b`,
].join('|'), 'i')
export function thirdPartyOwnerAskReasons(text) {
  return THIRD_PARTY_OWNER_ASK_RE.test(norm(text)) ? ['non_owner:asks_about_third_party_owner'] : []
}

/**
 * Class 1. Any seller message on the thread (or the inbound being answered) that says the person is not the owner ⇒
 * the text is refused, whatever it says; a person decides (ownershipConfirmedByPerson: an operator's recorded decision
 * after reviewing the thread). A question about a third-party owner is refused on every thread.
 * @param {string} text
 * @param {{ thread?: Array, inboundText?: string|null, ownershipConfirmedByPerson?: boolean }} [o]
 * @returns {string[]}
 */
export function nonOwnerContactReasons(text, { thread = [], inboundText = null, ownershipConfirmedByPerson = false } = {}) {
  const r = [...thirdPartyOwnerAskReasons(text)]
  if (ownershipConfirmedByPerson !== true) {
    const said = [...(Array.isArray(thread) ? thread : []).filter(isIn).map(bodyOf), ...(inboundText ? [String(inboundText)] : [])]
    if (said.some((b) => detectNonOwnerStatement(b).non_owner)) r.push('non_owner:reply_to_non_owner_contact')
  }
  return [...new Set(r)]
}

/** The non-owner reading of a whole thread (what the gateway records: ownership denied-or-unconfirmed for this contact). */
export function threadNonOwnerReading({ thread = [], inboundText = null } = {}) {
  const said = [...orderedThread(thread).filter(isIn).map(bodyOf), ...(inboundText ? [String(inboundText)] : [])]
  const kinds = new Set()
  for (const b of said) for (const k of detectNonOwnerStatement(b).kinds) kinds.add(k)
  return { non_owner: kinds.size > 0, kinds: [...kinds], ownership: kinds.size ? (kinds.has('not_owner') || kinds.has('former_owner') ? 'denied' : 'unconfirmed') : null }
}

// ── 2. INVENTED ACKNOWLEDGEMENT / UNSUPPORTED THREAD CLAIMS ───────────────────────────────────────────────────────────
const ACK_OBJECT = String.raw`(?:(?:the|your|ur)\s+(?:quick\s+|fast\s+|prompt\s+|kind\s+|speedy\s+|honest\s+|recent\s+|last\s+)?(?:reply|response|answer|update|message|msg|text|note|info(?:rmation)?|feedback|input|heads[\s-]up)|(?:getting|writing|texting|circling|coming)\s+back|replying|responding|answering|following\s+up|reaching\s+out|letting\s+(?:me|us)\s+know|keeping\s+(?:me|us)\s+(?:posted|updated|in\s+the\s+loop)|telling\s+(?:me|us)|sharing|clarifying|confirming|explaining|filling\s+(?:me|us)\s+in|checking\s+in|that(?=\s*(?:[.!,;]|$)))`
const REPLY_ACK_PATTERNS = [
  new RegExp(String.raw`\b(?:thanks?|thank\s+you|thx|ty|appreciate(?:\s+(?:it|you|that))?|grateful)\s+(?:(?:again|so\s+much|very\s+much|a\s+lot|a\s+ton|kindly)\s+)?(?:for\s+)?${ACK_OBJECT}`, 'i'),
  /\b(?:good|great|nice|glad|happy|lovely)\s+to\s+(?:hear|get\s+a\s+(?:reply|response))\s+(?:from|back\s+from)\s+you\b|\b(?:good|great|nice)\s+(?:to\s+)?hear(?:ing)?\s+back\b/i,
  /\bglad\s+(?:you|to\s+hear\s+you)\s+(?:got|wrote|texted|replied|responded|reached|came)\s+back\b|\bglad\s+(?:you|that\s+you)\s+(?:replied|responded|answered|wrote|texted)\b/i,
  /\b(?:got|received|saw|read|appreciated)\s+(?:your|ur)\s+(?:message|msg|text|reply|response|note|answer|update)\b|\bper\s+your\s+(?:last\s+|recent\s+)?(?:message|text|reply|note|response)\b|\bin\s+(?:response|reply)\s+to\s+your\b/i,
  // an opening acknowledgement of something they said ("Got it.", "Makes sense,", "Thanks!")
  /^(?:(?:hi|hey|hello|good\s+(?:morning|afternoon|evening))\b[^.?!,]{0,20}[,.!]\s*)?(?:noted|understood|got\s+it|gotcha|makes\s+sense|sounds\s+good|fair\s+enough|that\s+helps|good\s+to\s+know|ok(?:ay)?,?\s+(?:great|thanks?|got\s+it)|(?:thanks?|thank\s+you|appreciate\s+it)(?:\s+(?:so\s+much|again))?\s*[.!,])/i,
]
const ATTRIBUTION_ACK_RE = /\b(?:as\s+you\s+(?:mentioned|said|noted|told\s+(?:me|us)|indicated|explained|shared|put\s+it)|like\s+you\s+(?:said|mentioned)|you(?:'d|\s+had|\s+have|'ve)?\s+(?:mentioned|said|told\s+(?:me|us)|noted|indicated|shared|explained)|since\s+you\s+(?:said|mentioned)|following\s+up\s+on\s+(?:what\s+you|your)\b)/i

/**
 * Is there a seller message newer than our last ANSWER? (the only thing a text may acknowledge as a reply). An outbound
 * marked non_answer (our own initiated touch, e.g. a follow-up that crossed with the reply: blind v15 Q11) does not
 * answer the seller; every other outbound does.
 */
export function sellerWroteSinceOurLast(thread = []) {
  const rows = orderedThread(thread)
  let lastOut = -1
  rows.forEach((m, i) => { if (isOut(m) && m.non_answer !== true) lastOut = i })
  return rows.some((m, i) => i > lastOut && isIn(m))
}

/**
 * Class 2. No seller message since our last one (the last message is ours, or the seller never wrote) ⇒ a text that
 * thanks / acknowledges a reply, answer, update or message is refused; "as you mentioned" is refused when the seller
 * never wrote at all.
 * @param {string} text
 * @param {{ thread?: Array }} [o]
 * @returns {string[]}
 */
export function inventedAcknowledgementReasons(text, { thread = [] } = {}) {
  const t = norm(text)
  const r = []
  const sellerEver = (Array.isArray(thread) ? thread : []).some(isIn)
  if (!sellerWroteSinceOurLast(thread) && REPLY_ACK_PATTERNS.some((re) => re.test(t))) r.push(sellerEver ? 'thread:acknowledges_reply_not_received_since_last_message' : 'thread:acknowledges_reply_seller_never_sent')
  if (!sellerEver && ATTRIBUTION_ACK_RE.test(t)) r.push('thread:attributes_statement_seller_never_made')
  return r
}

// relative times a seller gives: time-references.js (shared with the fact ledger)

/**
 * Class 2 (timing). A time the SELLER gave ("in the spring", "next month", "after the holidays") is never referred to
 * in our text once it has passed relative to `now` (the text phrases timing neutrally instead).
 * @param {string} text
 * @param {{ thread?: Array, now?: string|number|Date|null }} [o]
 * @returns {string[]}
 */
// "You mentioned checking back after the holidays": OUR re-engagement recalling WHEN the seller asked to be contacted
// is the request honoured, not a claim that the time is still ahead (blind v8 Z53). Only that recollection is exempt;
// any other use of a passed time ("still planning on the spring?") is checked as before.
const CONTACT_REQUEST_RECALL_RE = /\byou\s+(?:said|mentioned|asked(?:\s+me)?|told\s+me)\s+(?:to\s+)?(?:check(?:ing)?\s+back|reach(?:ing)?\s+(?:back\s+)?out|follow(?:ing)?\s+up|circl(?:e|ing)\s+back|touch(?:ing)?\s+base|get(?:ting)?\s+back\s+(?:to\s+you|in\s+touch)|hit(?:ting)?\s+you\s+up|text(?:ing)?\s+(?:you\s+)?(?:back|again))\b[^.?!]{0,40}/gi

export function staleSellerTimeReasons(text, { thread = [], now = null } = {}) {
  const nowMs = now == null ? Date.now() : new Date(now).getTime()
  if (!Number.isFinite(nowMs)) return []
  const ours = new Set(timeReferencesIn(String(text || '').replace(CONTACT_REQUEST_RECALL_RE, ' ')).map((x) => x.key))
  if (!ours.size) return []
  const latestEnd = new Map()
  for (const m of orderedThread(thread).filter(isIn)) {
    const said = Date.parse(m?.at || '')
    for (const ref of timeReferencesIn(bodyOf(m))) {
      if (!ours.has(ref.key)) continue
      const end = timeReferenceEnd(ref, said)
      if (end != null) latestEnd.set(ref.key, end)
    }
  }
  return [...latestEnd.values()].some((end) => nowMs > end) ? ['timing:seller_time_reference_passed'] : []
}

// ── 3. UNSUPPORTED IDENTITY / REVIEW CLAIMS ──────────────────────────────────────────────────────────────────────────
const HUMAN_SUBJECT = String.raw`(?:a\s+(?:real\s+|live\s+|actual\s+)?(?:person|human)|(?:real|actual|live)\s+(?:people|humans|persons?)|humans?|someone|somebody|(?:our|my|the)\s+(?:team|staff|office)|(?:a|one)\s+(?:team\s+member|member\s+of\s+(?:the|our|my)\s+team|staff\s+member|teammate)|(?:a\s+)?person\s+(?:on|from)\s+(?:the|our|my)\s+team)`
const HUMAN_REVIEW_PATTERNS = [
  new RegExp(String.raw`\b${HUMAN_SUBJECT}\b[^.?!]{0,40}?\b(?:reads?|reading|reviews?|reviewing|monitors?|monitoring|oversees?|approves?|goes\s+over|looks?\s+over|(?:sees?|checks?)\s+(?:every|each|all|these|your|the)|is\s+(?:reading|watching|copied|cc'?d|looped\s+in)|takes?\s+over|take\s+over|step\s+in|jump\s+in|will\s+follow\s+up|personally)\b`, 'i'),
  /\b(?:reads?|reading)\s+along\b|\b(?:can|will|could|may|is\s+able\s+to)\s+(?:also\s+)?(?:take\s+over|step\s+in|jump\s+in)\b/i,
  /\b(?:human|manual|personal|staff)\s+(?:review|oversight|eyes|follow[\s-]?up|supervision)\b|\b(?:person|human)\s+in\s+the\s+loop\b/i,
  /\b(?:reviewed|read|checked|approved|monitored|seen|supervised|overseen)\s+by\s+(?:a\s+)?(?:real\s+)?(?:person|human|people|someone|our\s+team|the\s+team|my\s+team|staff)\b/i,
  /\b(?:ask\s+(?:for|to\s+(?:speak|talk)\s+(?:to|with))|talk\s+(?:to|with)|speak\s+(?:to|with)|reach|get)\s+(?:a\s+)?(?:real\s+|live\s+)?(?:person|human|someone\s+on\s+(?:the|our)\s+team)\b/i,
]
const DESCRIPTOR_PATTERNS = [
  /\b(?:local|area|nearby|neighbou?rhood|hometown|independent|private|small|family|real\s+estate|cash|property|investment|individual)\s+(?:home\s*|house\s*|real\s+estate\s+|property\s+)?(?:buyers?|investors?|homebuyers?|purchasers?|landlords?|developers?|flippers?|rehabbers?|famil(?:y|ies)|business(?:es)?|compan(?:y|ies))\b/gi,
  /\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:an?\s+)?(?:(?:home|house|property|real\s+estate)\s+)?(?:buyers?|investors?|homebuyers?|purchasers?)\b/gi,
  /\b(?:an?)\s+(?:home\s*|house\s*)?(?:buyer|investor|homebuyer|purchaser)\b/gi,
  /\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:based\s+)?(?:local|nearby|from\s+(?:the\s+area|around\s+here|here|your\s+area|the\s+neighbou?rhood))\b|\b(?:local(?:ly)?[\s-]based|based\s+(?:locally|nearby|in\s+(?:the|your)\s+area))\b/gi,
  /\b(?:i|we)\s+(?:buy|purchase|invest\s+in)\s+(?:homes|houses|properties|real\s+estate)\b/gi,
]
const DESCRIPTOR_STOP = new Set(['i', 'm', 'we', 're', 'am', 'are', 'a', 'an', 'the', 'based', 'from', 's'])
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((w) => w && !DESCRIPTOR_STOP.has(w)).map((w) => w.replace(/s$/, ''))
function descriptorAllowed(match, configured) {
  if (!configured) return false
  const want = new Set(words(configured))
  const got = words(match)
  return got.length > 0 && got.every((w) => want.has(w))
}

/**
 * Class 3. Human-review claims need companyIdentity.human_review === true; persona descriptors need a configured
 * companyIdentity.persona_descriptor they match (the company's own name is never read as a descriptor).
 * @param {string} text
 * @param {object} [companyIdentity]  normalizeCompanyIdentity() result
 * @returns {string[]}
 */
export function unsupportedIdentityClaimReasons(text, companyIdentity = NO_COMPANY_IDENTITY) {
  let t = norm(text)
  if (companyIdentity?.configured && companyIdentity.name) t = t.replace(new RegExp(companyIdentity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
  const r = []
  if (companyIdentity?.human_review !== true && HUMAN_REVIEW_PATTERNS.some((re) => re.test(t))) r.push('identity:human_review_claim_not_configured')
  const configured = companyIdentity?.configured ? companyIdentity.persona_descriptor || null : null
  for (const re of DESCRIPTOR_PATTERNS) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags))) {
      if (!descriptorAllowed(m[0], configured)) r.push(configured ? 'identity:persona_descriptor_mismatch' : 'identity:persona_descriptor_not_configured')
    }
  }
  return [...new Set(r)]
}

// ── ALL OF IT ────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Every writer-safety rule for ONE text about to be sent on a thread (composed by anyone).
 * @param {string} text
 * @param {{ thread?: Array, inboundText?: string|null, companyIdentity?: object, now?: string|number|Date|null, ownershipConfirmedByPerson?: boolean }} [o]
 * @returns {{ ok: boolean, reasons: string[], non_owner: { non_owner: boolean, kinds: string[], ownership: string|null }, version: string }}
 */
export function validateWriterSafety(text, { thread = [], inboundText = null, companyIdentity = NO_COMPANY_IDENTITY, now = null, ownershipConfirmedByPerson = false } = {}) {
  const reasons = [...new Set([
    ...(norm(text) ? [] : ['empty_text']),
    ...nonOwnerContactReasons(text, { thread, inboundText, ownershipConfirmedByPerson }),
    ...inventedAcknowledgementReasons(text, { thread: inboundText ? [...(thread || []), { direction: 'inbound', body: inboundText }] : thread }),
    ...staleSellerTimeReasons(text, { thread, now }),
    ...unsupportedIdentityClaimReasons(text, companyIdentity),
  ])]
  return { ok: reasons.length === 0, reasons, non_owner: threadNonOwnerReading({ thread, inboundText }), version: WRITER_SAFETY_VERSION }
}

export { timeReferencesIn, timeReferenceEnd }
