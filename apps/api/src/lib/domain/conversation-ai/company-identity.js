// CONFIGURED COMPANY IDENTITY (rc-8.5.21, Phase 4). The ONLY source of company facts an AI reply
// may state. Truthful identity from configured, approved information only.
//
// system_control[ai_conversation_company_identity] — PROPOSED key, ABSENT in production. Absent,
// empty or malformed ⇒ { configured: false }: the AI names no company, gives no website and never
// says it is or is not with a company; a seller who asks which company this is goes to a person.
// JSON shape (owner-approved values only):
//   { "name": "Example Home Buyers LLC", "website": "https://example.com", "website_verified": true,
//     "human_review": false, "persona_descriptor": null }
// A website is used only when website_verified === true and it is a plain https URL.
// Writer-safety remediation (blind safety eval v1, class 3): two more CONFIGURED facts, default NOT asserted:
//   human_review        true ONLY when the owner configures it: a text may then say a person on the team reads
//                       the messages / can take over. Anything but the boolean true ⇒ false (never claimed).
//   persona_descriptor  the approved descriptor of the persona ("a local buyer"); null ⇒ a text may describe the
//                       persona with NO descriptor ("local buyer", "local investor" … are refused).
export const COMPANY_IDENTITY_KEY = 'ai_conversation_company_identity'
export const COMPANY_IDENTITY_VERSION = 'conv-ai.company-identity.v1'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 &.,'-]{1,79}$/
const DESCRIPTOR_RE = /^[A-Za-z][A-Za-z '-]{1,59}$/
const WEBSITE_RE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[A-Za-z0-9._~/-]*)?$/i

/** Buying practices a text may state only when the owner configured them as true (company_identity.practices). */
export const COMPANY_PRACTICES = Object.freeze(['as_is', 'no_fees', 'cash', 'fast_close', 'flexible_close'])
export const NO_COMPANY_IDENTITY = Object.freeze({ configured: false, name: null, website: null, website_host: null, human_review: false, persona_descriptor: null, practices: Object.freeze([]), version: COMPANY_IDENTITY_VERSION })

export function normalizeCompanyIdentity(raw = null) {
  let v = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return NO_COMPANY_IDENTITY
    try { v = JSON.parse(raw) } catch { return NO_COMPANY_IDENTITY }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return NO_COMPANY_IDENTITY
  const name = String(v.name ?? '').trim()
  if (!NAME_RE.test(name)) return NO_COMPANY_IDENTITY
  const site = String(v.website ?? '').trim()
  const website = v.website_verified === true && WEBSITE_RE.test(site) ? site : null
  const descriptor = typeof v.persona_descriptor === 'string' ? v.persona_descriptor.replace(/\s+/g, ' ').trim() : ''
  return Object.freeze({ configured: true, name, website, website_host: website ? new URL(website).hostname.replace(/^www\./, '').toLowerCase() : null,
    human_review: v.human_review === true, persona_descriptor: DESCRIPTOR_RE.test(descriptor) ? descriptor : null,
    practices: Object.freeze([...new Set((Array.isArray(v.practices) ? v.practices : []).map(String).filter((x) => COMPANY_PRACTICES.includes(x)))]), version: COMPANY_IDENTITY_VERSION })
}

/** Read it fresh (any failure ⇒ not configured: fail closed to "say nothing about the company"). */
export async function loadCompanyIdentity({ readSwitch = null } = {}) {
  if (typeof readSwitch !== 'function') return NO_COMPANY_IDENTITY
  try { return normalizeCompanyIdentity(await readSwitch(COMPANY_IDENTITY_KEY)) } catch { return NO_COMPANY_IDENTITY }
}
