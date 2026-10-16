// PLAYBOOK v3 STYLE VALIDATOR: every v2 rule unchanged, plus the identity / forbidden-claim rules
// (index.js). Pure. Used ONLY through the shared outbound validator (outbound-validator.js).
import { validatePlaybookStyle as validateV2, sentenceCount, claimedNames, deniesAutomation, inventsBackstory } from '../v2/style-validator.js'
import { NO_COMPANY_IDENTITY } from '../../company-identity.js'

export const STYLE_VALIDATOR_VERSION = 'playbook.v3.style'
export { sentenceCount, claimedNames, deniesAutomation, inventsBackstory }

// "I'm not with a company", "no company", "it's just me": a claim we cannot know to be true
export const DENIES_COMPANY_RE = /\b(?:(?:i'?m|i\s+am|we'?re|we\s+are|this\s+is)\s+not\s+(?:with|from|part\s+of|affiliated\s+with|representing)\s+(?:a|any)\s+(?:company|business|firm|agency|organization|group)|not\s+(?:a|any)\s+company|no\s+company\s+(?:involved|behind)|(?:it'?s|this\s+is)\s+(?:just|only)\s+me|(?:just|only)\s+(?:me|myself),?\s+(?:no|not)\b|(?:independent|on\s+my\s+own),?\s+not\s+(?:a|with)\s+(?:a\s+)?company)\b/i
// a company name claim ("I'm with Acme Homes", "our company is Acme", "Acme Properties LLC")
const COMPANY_CLAIM_RE = /\b(?:(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:with|from)|(?:our|my)\s+company(?:\s+is|'s)|company\s+(?:is\s+)?called|(?:i|we)\s+work\s+(?:for|with))\s+((?:[A-Z][\w&'.-]*)(?:\s+[A-Z][\w&'.-]*){0,4})/
const COMPANY_SUFFIX_RE = /\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\s+(?:LLC|L\.L\.C\.|Inc\.?|Homes|Properties|Investments|Investors|Realty|Group|Capital|Holdings|Ventures|Partners|Home\s+Buyers|Homebuyers|Acquisitions)\b/
const DOMAIN_RE = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|biz|info|homes|properties|realty|llc))\b/i
export const INSPECTED_RE = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:already\s+|just\s+)?(?:seen|inspected|walked|toured|visited|looked\s+(?:at|over)|drove\s+by|driven\s+by|been\s+(?:to|by|inside|in))\s+(?:the|your|this|that)\s+(?:house|home|property|place|unit|building)\b(?!\s+(?:records?|details|listing\s+records))|\b(?:after|from)\s+(?:seeing|inspecting|walking|touring|visiting)\s+(?:the|your)\s+(?:house|home|property|place)\b/i
export const FUNDS_RE = /\b(?:(?:we|i)\s+(?:have|got)\s+(?:the\s+)?(?:cash|funds|money|financing)(?:\s+(?:ready|available|on\s+hand|lined\s+up))?|cash\s+(?:ready|on\s+hand|in\s+hand|available)|(?:funds|money)\s+(?:are\s+|is\s+)?(?:ready|available|lined\s+up|in\s+place)|proof\s+of\s+funds|(?:all[\s-])?cash\s+buyers?|(?:we|i)\s+(?:pay|buy\s+with)\s+(?:all\s+)?cash|pay\s+(?:you\s+)?(?:in\s+)?cash)\b/i
export const SENT_OR_WILL_SEND_RE = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?(?:sent|emailed|e-mailed|mailed|forwarded)\b|\b(?:i|we)(?:'ll|\s+will|\s+can|\s+could|'m\s+going\s+to|\s+am\s+going\s+to|\s+are\s+going\s+to|'d\s+be\s+happy\s+to|\s+would\s+be\s+happy\s+to)\s+(?:send|email|e-mail|mail|forward|drop\s+off|text\s+you\s+(?:a|the|my|our)\s+(?:link|card|info))\b|\bsending\s+(?:you\s+|it\s+|that\s+)?(?:my|our|a|the|it|over)\b|\b(?:check|see|look\s+in)\s+your\s+(?:email|inbox|mail)\b|\bbusiness\s+card\b|\bcontact\s+(?:info|information|details)\s+(?:over|your\s+way|to\s+you)\b/i
// a promise of no further contact is false while a follow-up / nurture exists (always, for an
// engaged thread: STOP and ownership denial never get a reply at all)
export const NO_CONTACT_PROMISE_RE = /\b(?:(?:won'?t|wont|will\s+not|never|not\s+going\s+to)\s+(?:bother|contact|text|message|call|trouble|reach\s+out(?:\s+to)?|be\s+(?:bothering|contacting|texting|reaching\s+out))(?:\s+you)?(?:\s+(?:again|anymore|any\s+more|further))?|leave\s+you\s+(?:be|alone)|take\s+you\s+off\s+(?:our|my|the)\s+list|(?:remove|removing)\s+(?:you|your\s+number)|won'?t\s+hear\s+from\s+(?:us|me)\s+again|last\s+(?:time|message|text)\s+(?:you'?ll|we|i))\b/i

/**
 * @param {string} text
 * @param {{ personaPolicy?: object, establishedPersona?: string|null, companyIdentity?: object }} [opts]
 */
export function validatePlaybookStyle(text, { personaPolicy = { allow_established_persona: true }, establishedPersona = null, companyIdentity = NO_COMPANY_IDENTITY } = {}) {
  const t = String(text ?? '')
  const v2 = validateV2(t, { personaPolicy, establishedPersona })
  const r = [...v2.reasons]
  const company = companyIdentity?.configured ? companyIdentity : NO_COMPANY_IDENTITY
  if (DENIES_COMPANY_RE.test(t)) r.push('identity:denies_company')
  const claims = [COMPANY_CLAIM_RE.exec(t)?.[1], COMPANY_SUFFIX_RE.exec(t)?.[0]].filter(Boolean)
  for (const c of claims) {
    if (!company.configured) r.push('identity:company_not_configured')
    else if (!String(c).toLowerCase().includes(company.name.toLowerCase().split(/\s+/)[0]) && !t.toLowerCase().includes(company.name.toLowerCase())) r.push('identity:company_name_mismatch')
  }
  for (const m of t.matchAll(new RegExp(DOMAIN_RE.source, 'gi'))) {
    const host = String(m[1] || '').toLowerCase().replace(/^www\./, '')
    if (!company.website_host || host !== company.website_host) r.push('identity:unverified_website')
  }
  if (INSPECTED_RE.test(t)) r.push('claim:inspected_property')
  if (FUNDS_RE.test(t)) r.push('claim:funds_without_evidence')
  if (SENT_OR_WILL_SEND_RE.test(t)) r.push('claim:sent_or_will_send_email_or_card')
  if (NO_CONTACT_PROMISE_RE.test(t)) r.push('claim:no_further_contact_while_nurture_scheduled')
  return { ok: r.length === 0, reasons: [...new Set(r)], version: STYLE_VALIDATOR_VERSION, claimed_names: v2.claimed_names }
}
