// JS twin of the S3 payload CHECKs (agent.payload_violation / agent.payload_string_violation, as
// amended by PROPOSED_20261019120000_payload_clean_opaque_ids.sql). The memory store applies it to
// exactly the columns the SQL CHECKs guard, so the memory twin refuses what Postgres refuses.
// The SQL remains the authority; this port exists so the engine's unit tests see the same refusals.
//
// Rules (see the S3 migration for the rationale): key names (message body, contact value,
// credential-like `*_key` except an allowlist, model thinking, a key that itself carries a phone or
// email), contact keys holding a value, raw property ids, phones (10-15 digit runs with separators,
// non-ASCII digits, base64-encoded), emails, JWTs, credentials, bare 10-15 digit numbers. Opaque UUID
// / hex id tokens and ISO timestamps are exempt from the phone-run check only.

const PHONE_RUN = /[0-9](?:[ \t\n\v\f\r().,:/_+·–—-]{0,4}[0-9]){9,14}/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const JWT_RE = /(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
const CRED_I_RE = /(^|[^A-Za-z0-9])((sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{16,}|sb_(secret|publishable)_[A-Za-z0-9_-]{8,}|bearer[ \t\n\v\f\r]+[A-Za-z0-9._~+/-]{8,}|github_pat_[A-Za-z0-9_]{20,})/i
const CRED_GH_RE = /(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/
const CRED_AWS_RE = /(^|[^A-Z0-9])(AKIA|ASIA)[A-Z0-9]{16}([^A-Z0-9]|$)/
const ZERO_WIDTH = /[­​-‍⁠﻿]/g
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u
const ISO_TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?)?$/
const UUID_TOKEN = /(^|[^0-9A-Za-z])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}(?![0-9A-Za-z])/g
const HEX_TOKEN = /(^|[^0-9A-Za-z])(?=[0-9]*[A-Fa-f])[0-9A-Fa-f]{20,128}(?![0-9A-Za-z])/g
const KEY_ALLOW = new Set(['key', 'idempotency_key', 'section_key', 'sort_key', 'lock_key', 'name_key', 'finding_key', 'cache_key', 'dedupe_key', 'scope_key'])

const digitCount = (s) => (s.match(/[0-9]/g) || []).length

export function normKey(k) {
  return String(k ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
}

function b64Decode(s) {
  if (s == null || s.length < 12 || s.length > 8192 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null
  let t = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  if (t.length % 4 === 1) return null
  t += '='.repeat((4 - (t.length % 4)) % 4)
  try {
    const bytes = Buffer.from(t, 'base64')
    const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return out.includes('\u0000') ? null : out
  } catch {
    return null
  }
}

/** NULL when clean, else a reason code (mirror of agent.payload_string_violation(s, nk, depth)). */
export function stringViolation(sIn, nk = '', depth = 0) {
  if (sIn == null) return null
  let s = String(sIn).replace(ZERO_WIDTH, '')
  if (NON_ASCII_DIGIT.test(s)) return 'non_ascii_digits'
  if (digitCount(s.normalize('NFKC')) !== digitCount(s)) return 'non_ascii_digits'
  s = s.normalize('NFKC')
  if (EMAIL_RE.test(s)) return 'email'
  if (JWT_RE.test(s)) return 'jwt'
  if (CRED_I_RE.test(s) || CRED_GH_RE.test(s) || CRED_AWS_RE.test(s)) return 'credential'
  const exempt = ISO_TS.test(s)
    || (/(^id$|_id$|_ids$|^requested_by$|^operator$)/.test(nk) && /^([a-z]{1,12}_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
    || (/(^|_)(hash|idempotency_key)$/.test(nk) && /^[0-9a-f]{32,128}$/.test(s))
    || (nk === 'case_number' && /^[0-9]{2,4}-[0-9]{3,8}-[A-Z]{1,4}(-[0-9]{1,4})?$/.test(s))
  const sIds = s.replace(UUID_TOKEN, '$1U').replace(HEX_TOKEN, '$1H')
  if (!exempt && PHONE_RUN.test(sIds)) return 'phone'
  if (depth < 2 && !/^[0-9a-f]+$/.test(s)) {
    const decoded = b64Decode(s)
    if (decoded != null && decoded !== s && stringViolation(decoded, '', depth + 1) != null) return 'base64_contact'
  }
  return null
}

const BODY_KEY = /^(body|text|content|contents|message|messages|msg|message_body|message_text|latest_message_body|sms|sms_body|sms_text|preview|snippet|transcript|raw|raw_text|raw_html|html|email_body|note_text|reply|reply_text)$/
const BODY_PART = /(^|_)(body|transcript)($|_)/
const CONTACT_KEY = /^(phones_json|emails_json|canonical_e164|e164|seller_phone|best_phone|best_email|phone_raw|mobile|cell|cell_phone|mobile_phone|landline)$/
const E164_PART = /(^|_)e164($|_)/
const THINK_KEY = /^(thinking|thinking_text|reasoning|chain_of_thought)$/
const CRED_KEY = /(^|_)(token|secret|secrets|password|passwd|pwd|passphrase|authorization|auth|cookie|cookies|session|jwt|bearer|credential|credentials|apikey|signature)($|_)/
const CONTACT_SCALAR_KEY = /^(phone|phone_number|phones|email|email_address|emails)$/

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'null')

function numberText(n) {
  if (!Number.isFinite(n)) return ''
  const t = Math.abs(n) >= 1e21 ? '' : String(n)
  return t.includes('e') ? '' : t
}

/** NULL when clean, else a reason code (mirror of agent.payload_violation(j, parent_key)). */
export function payloadViolation(j, parentKey = null) {
  if (j === undefined || j === null) return null
  const pk = normKey(parentKey)
  switch (typeOf(j)) {
    case 'object': {
      for (const [k, v] of Object.entries(j)) {
        if (/[^\x01-\x7f]/.test(k)) return 'key_non_ascii'
        const nk = normKey(k.normalize('NFKC'))
        const r0 = stringViolation(k, '')
        if (r0) return `key_${r0}`
        if ((BODY_KEY.test(nk) || BODY_PART.test(nk)) && !(nk === 'text' && pk === 'claims')) return 'key_message_body'
        if (CONTACT_KEY.test(nk) || E164_PART.test(nk)) return 'key_contact_value'
        if (THINK_KEY.test(nk)) return 'key_thinking'
        if (CRED_KEY.test(nk) || (/_key$/.test(nk) && !KEY_ALLOW.has(nk)) || nk === 'api_key') return 'key_credential'
        if (CONTACT_SCALAR_KEY.test(nk) && !['number', 'boolean', 'null'].includes(typeOf(v))) return 'key_contact_value'
        const r = payloadViolation(v, k)
        if (r) return r
      }
      return null
    }
    case 'array':
      for (const v of j) {
        const r = payloadViolation(v, parentKey)
        if (r) return r
      }
      return null
    case 'string':
      if (/(^|_)property_ids?$/.test(pk) && !/^pid_[g-p]{1,20}$/.test(j)) return 'property_id_not_encoded'
      if (/_refs$/.test(pk) && /^property:/.test(j) && !/^property:pid_[g-p]{1,20}$/.test(j)) return 'property_ref_not_encoded'
      return stringViolation(j, pk)
    case 'number':
      if (/^-?[0-9]{10,15}(\.[0-9]+)?$/.test(numberText(j))) return 'phone_number_value'
      return null
    default:
      return null
  }
}

/** The jsonb value Postgres would store (undefined dropped, Dates → strings). */
export const asJsonb = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
export const isClean = (v) => payloadViolation(asJsonb(v), null) == null
/** the human-text column CHECK: agent.payload_string_violation(s, 'text', 0) IS NULL */
export const textClean = (s) => stringViolation(s, 'text', 0) == null
/** jsonb::text byte length (approximation of octet_length(col::text); used for the size caps) */
export const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8')
