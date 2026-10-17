// CONFIGURED COMPANY IDENTITY (rc-8.5.21, Phase 4). The ONLY source of company facts an AI reply
// may state. Truthful identity from configured, approved information only.
//
// system_control[ai_conversation_company_identity] — PROPOSED key, ABSENT in production. Absent,
// empty or malformed ⇒ { configured: false }: the AI names no company, gives no website and never
// says it is or is not with a company; a seller who asks which company this is goes to a person.
// JSON shape (owner-approved values only):
//   { "name": "Example Home Buyers LLC", "website": "https://example.com", "website_verified": true }
// A website is used only when website_verified === true and it is a plain https URL.
export const COMPANY_IDENTITY_KEY = 'ai_conversation_company_identity'
export const COMPANY_IDENTITY_VERSION = 'conv-ai.company-identity.v1'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 &.,'-]{1,79}$/
const WEBSITE_RE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[A-Za-z0-9._~/-]*)?$/i

export const NO_COMPANY_IDENTITY = Object.freeze({ configured: false, name: null, website: null, website_host: null, version: COMPANY_IDENTITY_VERSION })

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
  return Object.freeze({ configured: true, name, website, website_host: website ? new URL(website).hostname.replace(/^www\./, '').toLowerCase() : null, version: COMPANY_IDENTITY_VERSION })
}

/** Read it fresh (any failure ⇒ not configured: fail closed to "say nothing about the company"). */
export async function loadCompanyIdentity({ readSwitch = null } = {}) {
  if (typeof readSwitch !== 'function') return NO_COMPANY_IDENTITY
  try { return normalizeCompanyIdentity(await readSwitch(COMPANY_IDENTITY_KEY)) } catch { return NO_COMPANY_IDENTITY }
}
