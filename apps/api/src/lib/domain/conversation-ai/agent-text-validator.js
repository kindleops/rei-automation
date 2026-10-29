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
import { replyLanguageOf } from './send-policy.js'
import { NO_COMPANY_IDENTITY } from './company-identity.js'
import { transportContentReasons } from '@/lib/domain/messaging/transport-content-rules.js'
import { isTemplateCompatibleWithProperty, canonicalPropertyGroupOf } from '@/lib/domain/templates/template-asset-compatibility.js'

export const AGENT_TEXT_VALIDATOR_VERSION = 'agent-text-validator.v1'
export const AGENT_TEXT_MAX_CHARS = 320
const NOT_A_MESSAGE_RE = /^(test(ing)?|placeholder|sample|lorem ipsum.*|ignore( this| me)?|n\/?a|tbd|todo|draft|x+|null|undefined)[.!]?$/i
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
 * @param {string} o.now
 * @returns {{ ok: boolean, code: string|null, reasons: string[], money: { amounts: number[], amount: number|null }, non_owner: object, seller_language: string|null, version: string }}
 */
export function validateAgentText(body, { purpose = null, messages = [], policy = {}, companyIdentity = NO_COMPANY_IDENTITY, authorEmployee = null, establishedPersona = null, moneyAuthority = null, property = null, firstName = null, ownershipConfirmedByPerson = false, now = new Date().toISOString() } = {}) {
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
  const knownNumbers = [...new Set([...thread.map((m) => m.body), clean(property?.property_address)].flatMap((b) => String(b || '').match(/[0-9]{3,}/g) || []))]
  const author = cap(authorEmployee)
  const v = validateOutbound(t, { ledger, category: purpose, establishedPersona: author || establishedPersona || null, companyIdentity, previousOutbound, knownNumbers, firstName, replyLanguage })
  const allowedNames = new Set([author, cap(establishedPersona)].filter(Boolean).map((n) => n.toLowerCase()))
  const namesOk = claimedNames(t).every((n) => allowedNames.has(n.toLowerCase()))
  const companyNamed = companyIdentity?.configured && companyIdentity.name && t.toLowerCase().includes(companyIdentity.name.toLowerCase())
  for (const r of v.reasons) {
    if (STYLE_ONLY.has(r)) continue
    // the conversation's ORDER (LeadCommand's S1–S5 playbook stages) is the agent's strategy, not a compliance rule
    if (/^ledger:skips_stage:/.test(r)) continue
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
  const ws = validateWriterSafety(t, { thread: thread.map((m) => ({ direction: m.direction, body: m.body, at: m.at })), companyIdentity, now, ownershipConfirmedByPerson })
  for (const r of ws.reasons) add(r)

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
