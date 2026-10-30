// THE AGENT-TEXT VALIDATOR (Action Gateway queue_agent_text, link #32). Deterministic, pure, NO model: LeadCommand
// judges the EXACT text an Agntei AI employee composed — it never rewrites, repairs or regenerates it. The gateway runs
// it at request time and LeadCommand's worker again at execution, on fresh reads; any reason refuses the text, and every
// refusal names its rules.
//
// What it applies (the compliance and safety rules; LeadCommand's own playbook STYLE preferences — sentence count,
// filler, flattery, emoji, stock openers — are the writer's business and are not imposed on the agent's voice):
//   length          1–320 characters (the ledger's bound)
//   transport       THE transport's content rules (domain/messaging/transport-content-rules.js, profile 'agent_text'):
//                   no unresolved placeholder, never empty — the same rules the queue runner and the TextGrid client
//                   apply to a verified agent text, so a text that passes here is never refused at transport
//   dashes          no em / en dash (the ledger's CHECK)
//   the shared outbound validator (outbound-validator.js#validateOutbound) over the thread's canonical fact ledger:
//                   no human claim / automation denial, no invented backstory, credentials, inspections, funds, sent
//                   email; no no-contact promise; no call / visit promise; at most ONE question; no question already
//                   answered / asked again the same way; no link / website unless the policy allows links; no
//                   unsupported "you said" / "thanks for confirming"; no price approval; no company claim that is not
//                   the configured company; names only the author's own name or the thread's established persona
//   writer safety   (writer-safety.js#validateWriterSafety): no text to a non-owner contact; no question about a
//                   third-party owner; no acknowledgement of a reply the seller never sent; no stale seller time; no
//                   human-review claim / persona descriptor the company identity does not configure
//   identity        the seller asked whether this is a bot / a person (in the messages since our last text): the text
//                   MUST disclose the AI assistant (an honest disclosure is never refused)
//   money           no amount / price / offer figure unless a LIVE negotiation send authorization of this lead's
//                   thread + property permits exactly that ONE amount (≤ its ceiling): else MONEY_NOT_AUTHORIZED
//   the inbound     the latest seller message is a STOP in any language ⇒ STOP_REQUESTED; the thread's seller said wrong
//                   number / not the owner ⇒ CONTACT_NOT_PERMITTED
//   language        the seller's language (from their own words) and the text's must be enabled languages
//   asset words     the words must fit the property's canonical asset group (the transport's final asset guard)
import { validateOutbound, askedInOpenBurst, AUTOMATION_DISCLOSURE_RE, validateWriterSafety } from './outbound-validator.js'
import { buildCanonicalLedger } from './fact-ledger.js'
import { moneyMentions } from './validator.js'
import { claimedNames } from './playbook/v3/style-validator.js'
import { isStopRequest } from './stop-request.js'
import { conditionGroundingReasons, conditionEvidenceOf, conditionFamiliesIn } from './condition-grounding.js'
import { replyLanguageOf } from './send-policy.js'
import { NO_COMPANY_IDENTITY } from './company-identity.js'
import { transportContentReasons } from '@/lib/domain/messaging/transport-content-rules.js'
import { isTemplateCompatibleWithProperty, canonicalPropertyGroupOf } from '@/lib/domain/templates/template-asset-compatibility.js'

export const AGENT_TEXT_VALIDATOR_VERSION = 'agent-text-validator.v1'
export const AGENT_TEXT_MAX_CHARS = 320
const NOT_A_MESSAGE_RE = /^(test(ing)?|placeholder|sample|lorem ipsum.*|ignore( this| me)?|n\/?a|tbd|todo|draft|x+|null|undefined)[.!]?$/i
const IMPLIED_COMMITMENT_RE = /\b(?:once|when|after|if)\s+(?:there'?s|there\s+is|we\s+(?:have|make|send|put\s+together)|you\s+(?:get|receive|have))\s+(?:an?\s+|our\s+)?offer\b|\b(?:our|the)\s+team\s+(?:would|will|has\s+to|needs\s+to|can|could|is\s+going\s+to|must)\s+(?:review|go\s+over|look\s+(?:at|over)|check|assess|evaluate|call|reach\s+out|follow\s+up|put\s+together|make)\b|\b(?:someone|a\s+person|one\s+of\s+us)\s+(?:from|on|at)\s+(?:our|the)\s+team\s+(?:will|can|could|would)\b|\bI'?ll\s+have\s+someone\s+(?:call|reach|contact|text)\b|\b(?:we'?ll|we\s+will|I'?ll|I\s+will)\s+(?:send|make|put\s+together|get\s+you)\s+(?:you\s+)?an?\s+offer\b/i
// handing the seller to a person ("passing your request to a person on the team", "I'll let the team know"): a follow-up
// by someone else is implied, which no agent may promise
const HANDOFF_RE = /\b(?:pass(?:ing)?|forward(?:ing)?|hand(?:ing)?|send(?:ing)?|flag(?:ging)?|relay(?:ing)?|escalat(?:e|ing)|refer(?:ring)?|bring(?:ing)?|loop(?:ing)?)\b[^.?!]{0,50}?\b(?:to|in|with)\s+(?:a\s+(?:real\s+|live\s+)?(?:person|human|colleague|manager|teammate|team\s+member|specialist|rep(?:resentative)?)|someone|somebody|(?:our|my|the)\s+(?:team|office|staff|manager|colleagues?|acquisitions\s+team))\b|\b(?:let|tell|inform|notify)\s+(?:(?:our|my|the)\s+(?:team|office|staff|manager)|someone|a\s+(?:person|colleague|manager))\s+know\b/i
// an offer, a number or a date that is "not ready yet / right now": one is implied to follow
const FORTHCOMING_RE = /\b(?:can'?t|cannot|can\s+not|don'?t|do\s+not|won'?t|not\s+able\s+to|unable\s+to|not\s+ready\s+to|no|not)\b[^.?!]{0,40}?\b(?:offers?|numbers?|price|figures?|quotes?|estimates?|valuations?|closing\s+dates?|dates?)\b[^.?!]{0,30}?\b(?:yet|right\s+now|at\s+the\s+moment|at\s+this\s+(?:point|time|stage)|for\s+now|just\s+now|until)\b|\b(?:offers?|numbers?|price|quotes?)\s+(?:is|are|will\s+be|should\s+be)\s+(?:coming|on\s+(?:its|the)\s+way|in\s+the\s+works|being\s+(?:prepared|worked\s+on))\b/i
// the company's offer, price, numbers, terms or dates, discussed at all (even "I can't give you a number", "not in this
// chat", "not myself"): without negotiation authority every such sentence implies one may come, so none is written.
// A QUESTION about the seller's own price or other offers stays allowed ("Do you have a price in mind?").
const OFFER_TERMS_RE = /\b(?:offers?|(?<!\b(?:phone|this|that|best|right|wrong|your|cell|text|contact|good)\s)numbers?|price|pricing|ballpark|figures?|quotes?|estimates?|valuations?|apprais\w+|closing\s+(?:dates?|costs?|timeline)|close\s+(?:date|by|on|before|in|within|quickly|fast)|terms|fees?|commissions?|moving\s+costs?|earnest|contracts?|in\s+writing)\b/i
const FIRST_PERSON_RE = /\b(?:I|I'?m|I'?d|I'?ll|me|my|we|we'?re|we'?d|we'?ll|us|our)\b/i
function offerTermsSentences(t) {
  return t.split(/(?<=[.?!])\s+/).filter((sentence) => OFFER_TERMS_RE.test(sentence) && (!/\?\s*$/.test(sentence) || FIRST_PERSON_RE.test(sentence)))
}
// where the seller's number or details came from ("your number is linked to … in public property records", "we found
// you on a list"): an account of the company's data the record does not back; a person answers that question
const DATA_SOURCE_RE = /\b(?:your|this)\s+(?:number|phone|contact|info(?:rmation)?|details|name)\b[^.?!]{0,60}?\b(?:came|comes|is|was|were|are)\s+(?:from|linked|listed|tied|attached|associated|found|pulled|in|on)\b|\b(?:we|I)\s+(?:got|get|found|find|pulled|obtained|bought|purchased|sourced)\s+(?:your|this)\s+(?:number|phone|contact|info(?:rmation)?|details|name)\b|\b(?:public|property|county|tax|court|probate)\s+records?\b|\bskip[\s-]?trac\w*|\b(?:mailing|marketing|lead|data)\s+(?:list|provider|vendor|broker)s?\b/i
const CORRECTION_RE = /\b(sent (by|in) (mistake|error)|ignore (that|the|my) (last|previous|earlier) (text|message)|(last|previous) (text|message) was (a )?(mistake|wrong|an error)|sorry,? (wrong|that) (text|message))\b/i
const PRACTICE_CLAIMS = [
  ['as_is', /\b(as[- ]is|any condition|no repairs? (needed|required|on your (end|side))|(roof|repairs?|basement)[^.?!]{0,40}(wouldn'?t|won'?t|don'?t) need (fixing|to be fixed))\b/i],
  ['no_fees', /\bno (fees|commissions?|closing costs|realtor fees)\b/i],
  ['cash', /\b(all[- ]cash|cash (offer|buyer|purchase)|pay (in )?cash)\b/i],
  ['fast_close', /\bclose (in|within) (a few|\d+|one|two|three|seven|ten|fourteen) (days?|weeks?)\b|\b(fast|quick) clos(e|ing)\b/i],
  ['flexible_close', /\b(close|closing) on your (timeline|schedule)\b|\bwhenever (you'?re|you are) ready to close\b/i],
]

// LeadCommand's writer-playbook STYLE preferences (not compliance): never imposed on an agent's own voice
const STYLE_ONLY = new Set(['style:too_long', 'style:too_many_sentences', 'style:emoji', 'style:over_punctuation', 'style:shouting', 'style:flattery', 'style:filler', 'style:robotic_transition',
  'style:slang_or_textspeak', 'style:not_american_english', 'style:compound_question', 'style:stock_opener', 'style:repeated_opening', 'style:non_english_characters', 'style:non_english',
  'content:filler', 'content:over_length',
  // money is judged below against the negotiation authority (one amount, ≤ the live send authorization's ceiling)
  'style:dollar_amount', 'content:unsupported_monetary_amount'])
const NOT_OWNER_VALUES = new Set(['denied', 'former_owner'])
const clean = (v) => String(v ?? '').trim()
const cap = (s) => clean(s).split(/[\s._-]+/)[0].replace(/^./, (c) => c.toUpperCase())

/**
 * @param {string} body the agent's exact text
 * @param {object} o
 * @param {string} o.purpose
 * @param {Array<{id, direction, body, at, intent?}>} o.messages the thread, chronological (canonical shape)
 * @param {object} [o.policy] the normalized agent-text policy (allow_links, languages)
 * @param {object} [o.companyIdentity] normalizeCompanyIdentity()
 * @param {string|null} [o.authorEmployee] the attribution's employee (its first name may sign the text)
 * @param {string|null} [o.establishedPersona] the thread's established persona name
 * @param {object|null} [o.moneyAuthority] { ceiling, send_permit_id } of a LIVE negotiation send authorization of this lead, or null
 * @param {object|null} [o.property] the property row (canonical asset group)
 * @param {string|null} [o.firstName] the seller's first name (a name the text may use)
 * @param {boolean} [o.ownershipConfirmedByPerson]
 * @param {Array<{family:string, source:'seller_reported'|'verified_finding'|'underwriting_estimate'}>} [o.conditionEvidence] authorized condition evidence beyond the seller's own words (condition-grounding.js)
 * @param {string} o.now
 * @returns {{ ok: boolean, code: string|null, reasons: string[], money: { amounts: number[], amount: number|null }, non_owner: object, seller_language: string|null, version: string }}
 */
// blind v13 S10, S21, S38: an attribution to the seller ("You mentioned the basement takes water…") whose topic is none of
// the ledger's five is accepted only when it is grounded in the seller's OWN words: one seller clause holds at least 60% of
// its content words (at least two), with the same polarity (a negation on one side and not the other is never grounded)
const ATTRIBUTED_CLAUSE_RE = /\byou(?:'d|\s+had|\s+have|'ve)?\s+(?:mentioned|said|told\s+(?:me|us)|noted|shared|explained|indicated)\b(?:\s+that)?([^.?!;]{3,160})/i
const STOP_WORDS = new Set('the a an and or but of to in on at for with it its it\'s this that these those is are was were be been being you your you\'d you\'ll i i\'d i\'ll me my we our us they them their he she his her if so as by from up out about just really very some any all would could should might may will can do does did have has had get got there here when what which who how than then too also not no never'.split(' '))
const NEGATION_RE = /\b(?:not|never|no|n't|dont|wont|cant|isnt|arent|wasnt|didnt|doesnt)\b|n't\b/i
const stem = (w) => w.replace(/'(?:d|ll|s|re|ve|m)$/, '').replace(/(?:ing|ed|es|s)$/, '')
const contentWords = (text) => [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)).map(stem).filter((w) => w.length > 2))]
export function attributionGroundedInSellerWords(text, thread = []) {
  const m = ATTRIBUTED_CLAUSE_RE.exec(String(text || ''))
  if (!m) return false
  const clause = m[1]
  const words = contentWords(clause)
  if (words.length < 2) return false
  const sellerClauses = thread.filter((x) => x?.direction === 'inbound').flatMap((x) => String(x.body || '').split(/[.!?;]+|\bbut\b/i)).filter((c) => c.trim())
  let best = null; let bestHit = 0
  for (const c of sellerClauses) { const cw = new Set(contentWords(c)); const hit = words.filter((w) => cw.has(w)).length; if (hit > bestHit) { bestHit = hit; best = c } }
  if (!best || bestHit / words.length < 0.6) return false
  return NEGATION_RE.test(clause) === NEGATION_RE.test(best)
}

// blind v13 S14: after the seller described ONE part of the property ("Furnace is on its last legs"), a question about
// OTHER parts ("how are the roof, plumbing and foundation?") is a new question, not a re-ask of an answered one
function asksAboutUnreportedCondition(text, thread) {
  if (!/\?/.test(String(text || ''))) return false
  const named = conditionFamiliesIn(String(text || '').split(/(?<=[.!])\s+/).filter((s) => /\?/.test(s)).join(' '))
  if (!named.length) return false
  const by = conditionEvidenceOf({ thread })
  return named.some((f) => !by[f]?.has('seller_reported'))
}

function unansweredFollowUpRepeat(kind, { purpose, ledger, thread }) {
  if (purpose !== 'followup' || kind === 'asking_price') return false
  const q = ledger?.questions?.[kind]
  if (!q || q.answered || q.deflected || !q.asked_count || q.asked_count >= 3) return false
  const firstAsk = thread.findIndex((m) => m.id === q.asked_message_ids[0])
  return firstAsk >= 0 && !thread.slice(firstAsk + 1).some((m) => m.direction === 'inbound')
}

export function validateAgentText(body, { purpose = null, messages = [], policy = {}, companyIdentity = NO_COMPANY_IDENTITY, authorEmployee = null, establishedPersona = null, moneyAuthority = null, property = null, firstName = null, ownershipConfirmedByPerson = false, conditionEvidence = [], now = new Date().toISOString() } = {}) {
  const text = String(body ?? '')
  const t = text.replace(/\s+/g, ' ').trim()
  const reasons = []
  const add = (r) => { if (r && !reasons.includes(r)) reasons.push(r) }
  if (!t) add('length:empty')
  if (text.length > AGENT_TEXT_MAX_CHARS) add('length:over_320_characters')
  for (const r of transportContentReasons(text, { profile: 'agent_text' })) add(r)
  if (/[–—]/.test(text)) add('style:em_or_en_dash')
  // not a message to a person: a test, a placeholder, a fragment, or a "correction" of an earlier text
  if (t && (NOT_A_MESSAGE_RE.test(t) || t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length < 3)) add('content:not_a_message')
  if (CORRECTION_RE.test(t)) add('content:correction_of_earlier_text')
  // an implied commitment: an offer, a team's review or a call that will follow (none is the agent's to promise)
  if (IMPLIED_COMMITMENT_RE.test(t)) add('commitment:implied_offer_review_or_call')
  if (HANDOFF_RE.test(t)) add('commitment:implied_handoff_to_person')
  if (FORTHCOMING_RE.test(t)) add('commitment:implied_forthcoming_offer_or_date')
  if (!moneyAuthority && offerTermsSentences(t).length) add('commitment:offer_price_or_terms_without_authority')
  if (DATA_SOURCE_RE.test(t)) add('claim:data_source_not_backed')
  // the company's buying practices: stated only when the owner configured them as true
  for (const [key, re] of PRACTICE_CLAIMS) if (re.test(t) && !(companyIdentity?.practices || []).includes(key)) add(`identity:company_practice_not_configured:${key}`)

  // the thread: its canonical fact ledger (deterministic; no model) and its latest seller message
  const thread = (messages || []).filter((m) => m && m.id)
  const ledger = buildCanonicalLedger({ messages: thread, now })
  const inbound = thread.filter((m) => m.direction === 'inbound')
  const latestIn = inbound[inbound.length - 1] || null
  const latest = thread[thread.length - 1] || null
  let code = null
  // the inbound: a STOP (any language) in the seller's latest message is an opt-out; wrong number / not the owner
  if ((latest?.direction === 'inbound' && isStopRequest(latest.body)) || ledger.facts?.opt_out) { add('inbound:opt_out'); code = 'STOP_REQUESTED' }
  const own = ledger.facts?.ownership?.value
  if (!code && (NOT_OWNER_VALUES.has(own) || inbound.some((m) => ['wrong_number', 'ownership_denied'].includes(clean(m.intent))))) { add('inbound:wrong_number_or_not_owner'); code = 'CONTACT_NOT_PERMITTED' }

  // the seller's language (their own words) and the text's
  const languages = Array.isArray(policy?.languages) && policy.languages.length ? policy.languages.map((l) => clean(l).toLowerCase()) : ['en']
  const sellerLanguage = latestIn ? replyLanguageOf({ inboundText: latestIn.body || '' }) : null
  const replyLanguage = sellerLanguage === 'es' ? 'es' : 'en'
  if (sellerLanguage && !['en', 'unknown'].includes(sellerLanguage) && !languages.includes(sellerLanguage)) add('language:seller_language_not_enabled')
  const textLanguage = t ? replyLanguageOf({ inboundText: t }) : null
  if (textLanguage && textLanguage !== 'unknown' && !languages.includes(textLanguage)) add('language:text_language_not_enabled')

  // the shared outbound validator over the ledger (its writer-playbook style preferences are filtered out)
  const previousOutbound = [...thread].reverse().find((m) => m.direction === 'outbound')?.body || null
  const knownNumbers = [...new Set([...thread.map((m) => m.body), clean(property?.property_address), clean(property?.property_address_full), clean(property?.property_address_zip)].flatMap((b) => String(b || '').match(/[0-9]{3,}/g) || []))]
  const author = cap(authorEmployee)
  const v = validateOutbound(t, { ledger, category: purpose, establishedPersona: author || establishedPersona || null, companyIdentity, previousOutbound, knownNumbers, firstName, replyLanguage })
  const allowedNames = new Set([author, cap(establishedPersona)].filter(Boolean).map((n) => n.toLowerCase()))
  const namesOk = claimedNames(t).every((n) => allowedNames.has(n.toLowerCase()))
  const companyNamed = companyIdentity?.configured && companyIdentity.name && t.toLowerCase().includes(companyIdentity.name.toLowerCase())
  for (const r of v.reasons) {
    if (STYLE_ONLY.has(r)) continue
    // the conversation's ORDER (LeadCommand's S1–S5 playbook stages) is the agent's strategy, not a compliance rule
    if (/^ledger:skips_stage:/.test(r)) continue
    // blind v10 W39, W40: a no-reply follow-up may repeat the question the seller never answered (LeadCommand's own
    // follow-up templates do: "Following up on …. Are you still the owner?"); only while the seller has sent NOTHING
    // since it was first asked, at most twice more, and never the asking price
    if (r === 'ledger:unsupported_attribution' && attributionGroundedInSellerWords(t, thread)) continue
    if (r === 'ledger:already_answered:condition' && asksAboutUnreportedCondition(t, thread)) continue
    if (/^ledger:already_asked:/.test(r) && unansweredFollowUpRepeat(r.slice('ledger:already_asked:'.length), { purpose, ledger, thread })) continue
    if ((r === 'content:contains_link' || r === 'identity:unverified_website') && policy?.allow_links === true) continue
    if (r === 'persona:name_not_established' && namesOk) continue
    // an honest disclosure ("an AI assistant with …") is never refused; a denial is (persona:denies_automation stays)
    if (r === 'identity:automation_statement_not_asked' && AUTOMATION_DISCLOSURE_RE.test(t) && !v.reasons.includes('persona:denies_automation')) continue
    // the configured company, named truthfully, is not an unasked company claim
    if (r === 'identity:company_statement_not_asked' && companyNamed) continue
    add(r)
  }
  // the seller asked whether this is a bot / a real person (since our last text): the answer MUST disclose it
  if (askedInOpenBurst(ledger, ['automation_question']) && !AUTOMATION_DISCLOSURE_RE.test(t)) add('identity:automation_question_unanswered')

  // writer safety (non-owner contact, invented acknowledgement, stale seller time, unsupported identity claims)
  const ws = validateWriterSafety(t, { thread: thread.map((m) => ({ direction: m.direction, body: m.body, at: m.at, ...(m.non_answer === true ? { non_answer: true } : {}) })), companyIdentity, now, ownershipConfirmedByPerson })
  for (const r of ws.reasons) add(r)

  // property condition: a material condition statement about THIS property must be backed by the seller's own words or
  // authorized evidence (a verified finding may be stated as found; an underwriting estimate is never a seller-facing
  // fact). Questions, conditionals and statements about houses in general are untouched.
  for (const r of conditionGroundingReasons(t, { thread, evidence: conditionEvidence, moneyAuthority })) add(r)

  // money: one amount, permitted by a live negotiation send authorization of this lead (≤ its ceiling)
  const amounts = [...new Set(moneyMentions(t).map((m) => Math.round(Number(m.amount) || 0)).filter((n) => n > 0))]
  const priced = amounts.length > 0 || /\$\s?[0-9]|\b[0-9]{2,3}\s?k\b|\b[0-9]{1,3}(?:,[0-9]{3})+\b/i.test(t)
  let moneyRefused = false
  if (priced) {
    if (!moneyAuthority) { add('money:no_negotiation_authority_for_this_lead'); moneyRefused = true }
    else if (amounts.length !== 1) { add('money:exactly_one_amount_required'); moneyRefused = true }
    else if (Number(moneyAuthority.ceiling) > 0 && amounts[0] > Number(moneyAuthority.ceiling)) { add('money:amount_above_authorized_ceiling'); moneyRefused = true }
  }

  // asset words: the transport's final asset guard (the words must fit the property's canonical group)
  if (property && t) {
    try {
      const a = isTemplateCompatibleWithProperty({ template: { template_body: t }, propertyGroup: canonicalPropertyGroupOf(property), wordsOnly: true })
      if (a && a.compatible === false) add(`asset:${clean(a.reason) || 'words_do_not_fit_property'}`)
    } catch { /* the asset reading is best effort here; the transport guard is authoritative */ }
  }

  if (!code && reasons.length) code = moneyRefused ? 'MONEY_NOT_AUTHORIZED' : 'CONTENT_REJECTED'
  return { ok: reasons.length === 0, code: reasons.length ? code : null, reasons, money: { amounts, amount: amounts.length === 1 ? amounts[0] : null }, non_owner: ws.non_owner, seller_language: sellerLanguage, question_kind: v.question_kind || null, version: AGENT_TEXT_VALIDATOR_VERSION }
}
